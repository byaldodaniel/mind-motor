import path from 'node:path';
import {MotorError} from './errors.js';
import {outputType,outputName,outputDirectory,OUTPUT_TYPES} from './work-destinations.js';

export async function destinationContext(motor,{conversation,project}) {
  if(conversation!==undefined) {
    const item=await motor.getConversation(conversation);
    return {conversation,project:project??item.project??undefined};
  }
  return {project};
}
export async function resolveWorkOutput({motor,context,name,type,destination,folderReference,project,conversation,prepare=false}) {
  const selected=await destinationContext(motor,{project,conversation});
  const settings=await motor.getWorkDestinations(selected);
  const kind=type??outputType(name??destination??'');
  if(!OUTPUT_TYPES.includes(kind))throw new MotorError('INVALID_DESTINATIONS','Tipo de resultado no válido.');
  const folders=await motor.listAuthorizedFolders();
  let target,origin;
  if(destination!==undefined){target=outputDirectory(destination);origin='indicacion';}
  else {
    const relative=outputName(name);
    let directory=settings.efectivos[kind];
    origin=directory?'preferencia':'predeterminado';
    if(!directory && context.defaultDirectory) directory=context.defaultDirectory;
    if(!directory) {
      if(folderReference!==undefined)directory=(await context.resolveFolder(folderReference)).path;
      else {
        const writable=[];
        for(const folder of folders){try{await context.requireAccess(folder,'escribir');writable.push(folder);}catch{}}
        if(writable.length!==1)throw new MotorError('CONVERSATION_DESTINATION_REQUIRED','No hay un único destino. Consulta destinos_consultar o indica uno autorizado.');
        directory=writable[0].path;
      }
    }
    target=path.join(directory,...relative.split('/'));
  }
  const folder=folders.filter(folder=>{
    const relative=path.relative(folder.path,target);
    return relative&&!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith('..'+path.sep);
  }).sort((a,b)=>b.path.length-a.path.length)[0];
  if(!folder)throw new MotorError('FOLDER_NOT_AUTHORIZED','El almacén físico no está abierto/autorizado. Abre esa ubicación o solicita su acceso antes de crear archivos.');
  await context.requireAccess(folder,'escribir');
  const relative=outputName(path.relative(folder.path,target).split(path.sep).join('/'));
  if(prepare) {
    const parts=relative.split('/').slice(0,-1);
    for(let i=1;i<=parts.length;i++) {
      try{await context.fileTool('crear_carpeta',{carpeta:folder.id,ruta:parts.slice(0,i).join('/')});}
      catch(error){if(error.code!=='FILE_EXISTS')throw error;}
    }
  }
  return {folder,path:relative,absolute:target,type:kind,origin,settings,conversation:selected.conversation};
}
export async function rememberOutput(motor,conversation,{path,type,bytes,sha256}) {
  if(!conversation)return {estado:'sin_conversacion'};
  try {
    await motor.rememberConversationResult(conversation,{path,type,bytes,...sha256?{sha256}:{}});
    return {estado:'registrado'};
  } catch(error) {
    return {estado:'pendiente',codigo:error.code??'RESULT_REGISTER_FAILED',nota:'El archivo existe en el destino; falta registrar sus metadatos.'};
  }
}
