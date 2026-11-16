import fs from 'node:fs/promises';
import path from 'node:path';
import {MotorError} from '../errors.js';
import {isExcluded} from '../paths.js';
import {only,schema} from './helpers.js';
import {OUTPUT_TYPES,outputDirectory} from '../work-destinations.js';
import {destinationContext,resolveWorkOutput,rememberOutput} from '../work-routing.js';
const scope={proyecto:{type:'string'},conversacion:{type:'string',description:'ID de la memoria de conversación si ya existe. Mantenerlo al retomar.'}};
const destinations=schema({carpeta:{type:'string'},tipos:schema(Object.fromEntries(OUTPUT_TYPES.map(type=>[type,{type:'string'}])))});
export function createDestinationTools({session}) {
  const motor=session.motor;
  return [
    {
      definition:{name:'destinos_consultar',title:'Consultar destinos físicos de trabajo',
        description:'Usar al iniciar una conversación. Devuelve preferencias persistentes generales, de proyecto y conversación para documentos, imágenes, código y demás resultados. Las rutas son almacenes físicos; no enlaces. Devuelve también el predeterminado de Mind (Conversaciones junto a Base en una instalación) y el modo de memoria. Requiere continuidad leer.',
        inputSchema:schema(scope),annotations:{readOnlyHint:true,openWorldHint:false}},
      async handler(args,context) {
        only(args,['proyecto','conversacion']);await context.requireContinuity('leer');
        const selected=await destinationContext(motor,{project:args.proyecto,conversation:args.conversacion});
        const found=await motor.getWorkDestinations(selected);
        const writable=[];
        for(const folder of await motor.listAuthorizedFolders()){try{await context.requireAccess(folder,'escribir');writable.push(folder.path);}catch{}}
        const preferences=await motor.getConversationPreferences(args.conversacion);
        await context.requireContinuity('leer');
        return {...found,predeterminado:session.layout.userDataDirectory??(writable.length===1?writable[0]:null),
          memoria:{modo:preferences.effective.mode,reglas:preferences.effective.rules,archivo:args.conversacion?(await motor.getConversation(args.conversacion)).file??null:null},
          indicaciones:'Aplica estos destinos antes de cada creación. Para herramientas externas resuelve la ruta con destino_resolver; si imponen un temporal, copia el resultado con resultado_importar. Conserva y usa el ID de conversación.'};
      }
    },
    {
      definition:{name:'destinos_configurar',title:'Elegir almacenes físicos de trabajo',
        description:'Solo por indicación del usuario. Configura una carpeta general o por tipo, con excepción de proyecto o conversación. Sin ámbito cambia general. destinos:null restaura herencia del ámbito. No concede permisos ni mueve archivos existentes. Requiere continuidad leer y registrar.',
        inputSchema:schema({...scope,revision:{type:'integer',minimum:0},destinos:{anyOf:[destinations,{type:'null'}]}},['revision','destinos']),
        annotations:{readOnlyHint:false,destructiveHint:true,openWorldHint:false}},
      async handler(args,context) {
        only(args,['proyecto','conversacion','revision','destinos']);await context.requireContinuity('leer','registrar');
        const selected=await destinationContext(motor,{project:args.proyecto,conversation:args.conversacion});
        return motor.configureWorkDestinations({...selected,destinations:args.destinos,expectedRevision:args.revision});
      }
    },
    {
      definition:{name:'destino_resolver',title:'Resolver ubicación física de un resultado',
        description:'Resuelve la ubicación física antes de crear con cualquier herramienta. Prioridad: destino explícito, conversación, proyecto, general, Conversaciones de Mind (o carpeta abierta en desarrollo). destino es la ruta absoluta del archivo; nombre es relativo. Si preparar:true crea solo los directorios necesarios mediante permisos existentes. No crea el archivo ni registra un resultado inexistente.',
        inputSchema:schema({...scope,nombre:{type:'string'},tipo:{type:'string',enum:OUTPUT_TYPES},destino:{type:'string'},preparar:{type:'boolean'}}),
        annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false}},
      async handler(args,context) {
        only(args,['proyecto','conversacion','nombre','tipo','destino','preparar']);
        if(args.preparar!==undefined&&typeof args.preparar!=='boolean')throw new MotorError('INVALID_ARGUMENTS','preparar debe ser booleano.');
        const value=await resolveWorkOutput({motor,context,name:args.nombre,type:args.tipo,destination:args.destino,project:args.proyecto,conversation:args.conversacion,prepare:args.preparar===true});
        return {carpeta:value.folder.id,ruta:value.path,ruta_absoluta:value.absolute,tipo:value.type,origen:value.origin};
      }
    },
    {
      definition:{name:'resultado_importar',title:'Guardar físicamente un resultado generado',
        description:'Copia por flujo un archivo generado en una carpeta autorizada al destino físico preferido, incluso en otro disco. Admite imágenes, PDF, hojas de cálculo, audio y video hasta 4 GiB, sin leerlos completos en memoria. Nunca reemplaza archivos. Devuelve SHA-256 y conserva el origen; no crea enlaces. Con conversacion registra su ubicación para recuperar después.',
        inputSchema:schema({...scope,origen:{type:'string'},nombre:{type:'string'},tipo:{type:'string',enum:OUTPUT_TYPES},destino:{type:'string'}},['origen']),
        annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false}},
      async handler(args,context) {
        only(args,['proyecto','conversacion','origen','nombre','tipo','destino']);
        if(args.conversacion)await context.requireContinuity('leer','registrar');
        const origin=outputDirectory(args.origen);
        const sources=(await motor.listAuthorizedFolders()).filter(folder=>{const r=path.relative(folder.path,origin);return r&&!path.isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+path.sep);}).sort((a,b)=>b.path.length-a.path.length);
        if(!sources.length)throw new MotorError('FOLDER_NOT_AUTHORIZED','El archivo generado debe estar en una carpeta autorizada para lectura.');
        const source=sources[0];await context.requireAccess(source,'leer');
        const target=await resolveWorkOutput({motor,context,name:args.nombre??path.basename(origin),type:args.tipo,destination:args.destino,project:args.proyecto,conversation:args.conversacion,prepare:true});
        const authorization=await motor.grantResultCopy({requester:context.requester,sourceFolderId:source.id,sourcePath:path.relative(source.path,origin).split(path.sep).join('/'),targetFolderId:target.folder.id,targetPath:target.path});
        const value=await motor.copyResultFile({requester:context.requester,authorization,confirm:async()=>{await context.requireAccess(source,'leer');await context.requireAccess(target.folder,'escribir');}});
        const registration=await rememberOutput(motor,args.conversacion,{path:target.absolute,type:target.type,bytes:value.size,sha256:value.sha256});
        return {estado:'copiado',ruta_absoluta:target.absolute,bytes:value.size,sha256:value.sha256,origen_conservado:true,registro:registration};
      }
    },
    {
      definition:{name:'resultado_registrar',title:'Registrar un resultado ya creado en su destino',
        description:'Registra la ubicación de un archivo que otra herramienta creó directamente en el almacén físico resuelto. Verifica su existencia en el índice; no copia ni enlaza. Para colocar físicamente un temporal utiliza resultado_importar.',
        inputSchema:schema({conversacion:{type:'string'},ruta:{type:'string'},tipo:{type:'string',enum:OUTPUT_TYPES}},['conversacion','ruta']),
        annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false}},
      async handler(args,context) {
        only(args,['conversacion','ruta','tipo']);await context.requireContinuity('leer','registrar');
        await motor.getConversation(args.conversacion);
        const target=await resolveWorkOutput({motor,context,destination:args.ruta,type:args.tipo,conversation:args.conversacion});
        await context.requireAccess(target.folder,'encontrar');
        await session.ensureIndex(target.folder.id);
        let index=await motor.readFolderIndex(target.folder.id);
        let file=index?.entries.find(item=>item.path===target.path&&item.type==='file');
        if(!file && !isExcluded(target.folder.exclusions, target.path)){
          const disk=await fs.lstat(target.absolute).catch(()=>null);
          if(disk && !disk.isSymbolicLink() && disk.isFile()){
            await session.reindex(target.folder.id, { relativePath: target.path }).catch(()=>{});
            index=await motor.readFolderIndex(target.folder.id);
            file=index?.entries.find(item=>item.path===target.path&&item.type==='file');
          }
        }
        if(!file)throw new MotorError('FILE_NOT_FOUND','No hay un archivo creado en ese destino.');
        return {estado:'registrado',resultado:await motor.rememberConversationResult(args.conversacion,{path:target.absolute,type:target.type,bytes:file.size})};
      }
    }
  ];
}
