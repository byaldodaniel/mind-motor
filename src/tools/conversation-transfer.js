import path from 'node:path';
import {createHash} from 'node:crypto';
import {MotorError} from '../errors.js';
import {only,schema,text,integer} from './helpers.js';
import {outputDirectory,outputType,OUTPUT_TYPES} from '../work-destinations.js';
import {resolveWorkOutput} from '../work-routing.js';
import {matchesConversationMarkdown} from '../conversation-file.js';
import {readJson,writeJson,removeJson} from '../storage.js';
import {withIndexLock} from '../index-lock.js';
import {requestSignal} from '../request-context.js';

const key=value=>process.platform==='win32'?path.normalize(value).toLowerCase():path.normalize(value);
const inside=(root,file)=>{const relative=path.relative(root,file);return relative&&!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith('..'+path.sep);};

/** Transporte físico por conversación. El origen permanece como recuperación;
 * el elemento solo cambia de destino después de confirmar todas las copias. */
export function createConversationTransferTools({session}) {
  const motor=session.motor;
  return [{
    definition:{name:'conversacion_trasladar',title:'Trasladar una conversación y sus archivos',
      description:'Por indicación del usuario, reúne la memoria Markdown y sus archivos registrados o referenciados en una carpeta elegida, incluso en otro disco. Conserva el ID, las decisiones, las preferencias y los originales como recuperación. Verifica las copias antes de cambiar las rutas; no reemplaza archivos. Requiere acceso al origen y al destino. Usa mover para trasladar una carpeta completa ya organizada.',
      inputSchema:schema({id:{type:'string'},revision:{type:'integer',minimum:1},destino:{type:'string',description:'Carpeta absoluta elegida para esta conversación.'}},['id','revision','destino']),
      annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false}},
    async handler(args,context) {
      const id=text(args.id,'id',{max:64});
      return withIndexLock(motor.baseDirectory,id,()=>transfer(args,context),'conversation-transfer',{timeoutMs:10000,signal:requestSignal()});
    }
  }];
  async function transfer(args,context) {
      only(args,['id','revision','destino']);
      await context.requireContinuity('leer','registrar');
      const id=text(args.id,'id',{max:64});
      const revision=integer(args.revision,'revision',{optional:false,min:1});
      const directory=outputDirectory(args.destino);
      const before=await motor.getConversation(id);
      if(!before.file)throw new MotorError('CONVERSATION_FILE_REQUIRED','Guarda primero la memoria Markdown de esta conversación.');
      const registered=await motor.readConversationResults(id);
      const policy=await motor.getWorkDestinations({conversation:id,project:before.project??undefined});
      const journalFile=path.join(motor.baseDirectory,'conversation-transfer-'+id+'.json');
      const stored=(await readJson(journalFile))?.data;
      if(stored&&(stored.format!=='mind-conversation-transfer'||stored.version!==1||stored.id!==id||!Array.isArray(stored.files)))throw new MotorError('CONVERSATION_TRANSFER_CORRUPT','El registro de copias de la conversación necesita revisión.');
      if(before.revision!==revision)throw new MotorError('CONTINUITY_REVISION_CONFLICT','La conversación cambió; vuelve a leerla antes de trasladarla.');
      const completed=key(policy.conversacion?.carpeta??'')===key(directory)&&inside(directory,before.file);
      const retry=stored&&key(stored.destination)===key(directory)&&stored.revision===revision?stored:null;
      if(stored&&key(stored.destination)===key(directory)&&!retry&&!completed)throw new MotorError('CONVERSATION_TRANSFER_CONFLICT','La conversación cambió desde el intento anterior. Se conservan las copias.');
      if(retry&&(retry.revision!==revision||retry.resultsRevision!==registered.revision||retry.destinationsRevision!==policy.revision))throw new MotorError('CONVERSATION_TRANSFER_CONFLICT','La conversación cambió desde el intento anterior. Conserva las copias y elige otro destino para el estado nuevo.');
      const folders=await motor.listAuthorizedFolders();
      async function verify(folder,relativePath) {
        await context.requireAccess(folder,'leer');
        const authorization=await motor.grantResultVerification({requester:context.requester,folderId:folder.id,relativePath});
        return motor.verifyResultFile({requester:context.requester,authorization,confirm:()=>context.requireAccess(folder,'leer')});
      }
      const resources=new Map();
      resources.set(key(before.file),{source:before.file,type:'memoria'});
      for(const item of registered.results)if(!resources.has(key(item.path)))resources.set(key(item.path),{source:item.path,type:item.type});
      const externalReferences=[];
      for(const ref of before.references)if(ref.locator&&path.isAbsolute(ref.locator)&&!resources.has(key(ref.locator))) {
        const folder=folders.filter(folder=>inside(folder.path,ref.locator)||key(folder.path)===key(ref.locator)).sort((a,b)=>b.path.length-a.path.length)[0];
        if(!folder)throw new MotorError('FOLDER_NOT_AUTHORIZED','Una referencia local no está abierta/autorizada para comprobar el traslado.');
        if(key(folder.path)===key(ref.locator)){externalReferences.push(ref.locator);continue;}
        await context.requireAccess(folder,'encontrar');await session.ensureIndex(folder.id);
        const relative=path.relative(folder.path,ref.locator).split(path.sep).join('/');
        const entry=(await motor.readFolderIndex(folder.id))?.entries.find(item=>item.path===relative);
        if(!entry)throw new MotorError('FILE_NOT_FOUND','Una referencia local ya no existe; resuélvela antes de trasladar la conversación.');
        if(entry.type==='directory'){externalReferences.push(ref.locator);continue;}
        resources.set(key(ref.locator),{source:ref.locator,type:outputType(ref.locator)});
      }
      const names=new Set();const plan=[];
      for(const resource of resources.values()) {
        const source=folders.filter(folder=>inside(folder.path,resource.source)).sort((a,b)=>b.path.length-a.path.length)[0];
        if(!source)throw new MotorError('FOLDER_NOT_AUTHORIZED','Un archivo de la conversación no está abierto/autorizado para lectura.');
        await context.requireAccess(source,'leer');
        const basename=path.basename(resource.source);let name=basename,number=1;
        while(names.has(key(path.join(resource.type,name))))name=(++number)+'-'+basename;
        names.add(key(path.join(resource.type,name)));
        const absolute=path.join(directory,resource.type,name);
        const same=key(absolute)===key(resource.source);
        const target=await resolveWorkOutput({motor,context,destination:absolute,type:resource.type,conversation:id});
        await context.requireAccess(target.folder,'encontrar');
        await session.ensureIndex(target.folder.id);
        const exists=(await motor.readFolderIndex(target.folder.id))?.entries.some(item=>item.path===target.path);
        const prior=retry?.files.find(item=>key(item.source)===key(resource.source)&&key(item.target)===key(target.absolute));
        if(exists&&!prior&&!same)throw new MotorError('FILE_EXISTS','El destino contiene un archivo del mismo nombre; se conserva intacto.');
        const actual=await verify(source,path.relative(source.path,resource.source).split(path.sep).join('/'));
        if(prior&&(actual.sha256!==prior.sha256||actual.size!==prior.size))throw new MotorError('SOURCE_CHANGED','Un original cambió desde el intento anterior; se conserva la copia previa.');
        if(exists&&!same) {
          const copied=await verify(target.folder,target.path);
          if(copied.sha256!==actual.sha256||copied.size!==actual.size)throw new MotorError('CONVERSATION_TRANSFER_CONFLICT','Una copia del intento anterior cambió; se conserva intacta.');
        }
        plan.push({...resource,sourceFolder:source,target,size:actual.size,sha256:actual.sha256,reused:exists||same,same});
      }
      const memory=plan[0];
      const content=await context.readFile(memory.sourceFolder,path.relative(memory.sourceFolder.path,memory.source).split(path.sep).join('/'));
      if(!matchesConversationMarkdown(content.content,before))throw new MotorError('CONVERSATION_FILE_CONFLICT','La memoria fue editada fuera de Mind; revisa esa edición antes de trasladarla.');
      const memoryHash=createHash('sha256').update(content.content).digest('hex');
      if(memoryHash!==memory.sha256)throw new MotorError('SOURCE_CHANGED','La memoria cambió mientras se preparaba el traslado.');
      if(completed&&plan.every(item=>item.same)) {
        if(stored)await removeJson(journalFile);
        return {estado:'trasladada',id,revision:before.revision,archivo:before.file,destino:directory,archivos:plan.map(item=>({archivo:item.target.absolute,tipo:item.type,bytes:item.size,sha256:item.sha256})),referencias_externas:externalReferences,origenes_conservados:true,ya_trasladada:true};
      }
      await writeJson(journalFile,{format:'mind-conversation-transfer',version:1,id,revision,destination:directory,resultsRevision:registered.revision,destinationsRevision:policy.revision,
        files:plan.map(item=>({source:item.source,target:item.target.absolute,size:item.size,sha256:item.sha256}))});
      const copied=[];
      try {
        for(const item of plan) {
          if(item.reused){copied.push({origen:item.source,archivo:item.target.absolute,tipo:item.type,bytes:item.size,sha256:item.sha256});continue;}
          await resolveWorkOutput({motor,context,destination:item.target.absolute,type:item.type,conversation:id,prepare:true});
          const authorization=await motor.grantResultCopy({requester:context.requester,sourceFolderId:item.sourceFolder.id,sourcePath:path.relative(item.sourceFolder.path,item.source).split(path.sep).join('/'),targetFolderId:item.target.folder.id,targetPath:item.target.path});
          const result=await motor.copyResultFile({requester:context.requester,authorization,confirm:async()=>{await context.requireAccess(item.sourceFolder,'leer');await context.requireAccess(item.target.folder,'escribir');}});
          copied.push({origen:item.source,archivo:item.target.absolute,tipo:item.type,bytes:result.size,sha256:result.sha256});
          if(result.sha256!==item.sha256||result.size!==item.size)throw new MotorError('SOURCE_CHANGED','Un original cambió durante el traslado.');
        }
        await context.requireContinuity('leer','registrar');
        const locations=new Map(copied.map(item=>[key(item.origen),item.archivo]));
        const references=before.references.map(ref=>ref.locator&&locations.has(key(ref.locator))?{...ref,locator:locations.get(key(ref.locator))}:ref);
        const results=copied.slice(1).map(item=>({path:item.archivo,type:item.tipo,bytes:item.bytes,sha256:item.sha256,updatedAt:new Date().toISOString()}));
        const destinations={carpeta:directory,tipos:Object.fromEntries(OUTPUT_TYPES.map(type=>[type,path.join(directory,type)]))};
        const updated=await motor.relocateConversationMetadata({id,revision,file:copied[0].archivo,references,results,resultsRevision:registered.revision,destinations,destinationsRevision:policy.revision,
          ...(before.preferences?{preferences:{...before.preferences,...(before.preferences.directory===undefined?{}:{directory:path.join(directory,'memoria')})}}:{})});
        await removeJson(journalFile);
        return {estado:'trasladada',id,revision:updated.revision,archivo:updated.file,destino:directory,archivos:copied,referencias_externas:externalReferences,origenes_conservados:true};
      } catch(error) {
        return {estado:'pendiente',id,archivos_copiados:copied,origenes_conservados:true,codigo:error.code??'CONVERSATION_TRANSFER_FAILED',nota:'Las decisiones y archivos originales se conservan. El traslado no está confirmado; vuelve a leer la conversación antes de continuar.',mensaje:error.message};
      }
    }
}
