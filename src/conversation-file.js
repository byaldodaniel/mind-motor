import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { MotorError } from './errors.js';

export function conversationMarkdown(value) {
  return `<!-- mind-conversation:${value.id} revision:${value.revision} -->\n# ${value.title.replace(/[\r\n]/g,' ')}\n\n${value.important}\n`;
}
// El marcador puede quedar en una revisión anterior por cambios solo de metadatos.
export function matchesConversationMarkdown(text, value) {
  if (typeof text !== 'string') return false;
  const marker = /^<!-- mind-conversation:([a-f0-9-]{36}) revision:([1-9][0-9]*) -->\n/.exec(text);
  if (!marker || marker[1] !== value.id || !Number.isSafeInteger(Number(marker[2]))
      || Number(marker[2]) > value.revision) return false;
  return text.slice(marker[0].length) === conversationMarkdown(value).replace(/^[^\n]*\n/, '');
}
// Las únicas escrituras pasan por las herramientas seguras y sus permisos.
export async function prepareConversationFile({ motor, before, destination, directory, context }) {
  const folders = await motor.listAuthorizedFolders();
  let target = destination ?? before?.file;
  if (!target) {
    if (directory) target = path.join(directory, `conversacion-${randomUUID()}.md`);
    else {
      const opened = [];
      for (const folder of folders) {
        try { await context.requireAccess(folder,'leer','escribir'); opened.push(folder); } catch {}
      }
      if (opened.length !== 1) throw new MotorError('CONVERSATION_DESTINATION_REQUIRED', 'Indica destino o configura carpeta_destino: no hay una única carpeta de trabajo con lectura y escritura.');
      target = path.join(opened[0].path,'Conversaciones',`conversacion-${randomUUID()}.md`);
    }
  }
  if (typeof target !== 'string' || !path.isAbsolute(target) || path.extname(target).toLowerCase() !== '.md') {
    throw new MotorError('INVALID_CONVERSATION_DESTINATION','El destino debe ser una ruta absoluta a un archivo .md.');
  }
  target = path.normalize(target);
  const folder = folders.filter(folder => {
    const relative = path.relative(folder.path,target);
    return relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..'+path.sep);
  }).sort((a,b)=>b.path.length-a.path.length)[0];
  if (!folder) throw new MotorError('FOLDER_NOT_AUTHORIZED','El destino no está dentro de una carpeta autorizada. Abre esa ubicación en el agente.');
  await context.requireAccess(folder,'leer','escribir');
  const relative = path.relative(folder.path,target).split(path.sep).join('/');
  let previous;
  try { previous = await context.readFile(folder,relative); }
  catch(error) { if(error.code !== 'FILE_NOT_FOUND') throw error; }
  if (previous && (!before || before.file !== target || !matchesConversationMarkdown(previous.content, before))) {
    throw new MotorError('CONVERSATION_FILE_CONFLICT','El archivo existe o fue editado fuera de Mind. Se conserva intacto: elige otro destino o revisa su contenido antes de actualizar.');
  }
  const components = relative.split('/').slice(0,-1);
  for (let i=1;i<=components.length;i++) {
    const route = components.slice(0,i).join('/');
    try { await context.fileTool('crear_carpeta',{carpeta:folder.id,ruta:route}); }
    catch(error) { if (!['ENTRY_EXISTS','FILE_EXISTS','DIRECTORY_EXISTS','DESTINATION_EXISTS','TARGET_EXISTS'].includes(error.code)) throw error; }
  }
  return { target, confirmAccess: () => context.requireAccess(folder, 'leer', 'escribir'), async write(value) {
    const args = {carpeta:folder.id,ruta:relative,contenido:conversationMarkdown(value)};
    return previous
      ? context.fileTool('modificar',{...args,version:previous.version})
      : context.fileTool('crear',args);
  }};
}
