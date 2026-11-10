import path from 'node:path';
import { readJson, writeJson } from './storage.js';
import { withIndexLock } from './index-lock.js';
import { MotorError } from './errors.js';
import { requestSignal } from './request-context.js';

export const OUTPUT_TYPES = ['documentos','imagenes','videos','audio','codigo','otros','memoria'];
const fail = message => { throw new MotorError('INVALID_DESTINATIONS',message); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const projectKey = value => value.normalize('NFD').replace(/\p{M}/gu,'').toLowerCase();
export function outputType(name) {
  const extension = path.extname(name).toLowerCase();
  if (['.png','.jpg','.jpeg','.gif','.webp','.svg','.avif','.tiff','.bmp'].includes(extension)) return 'imagenes';
  if (['.mp4','.mov','.webm','.avi','.mkv'].includes(extension)) return 'videos';
  if (['.mp3','.wav','.ogg','.m4a','.flac'].includes(extension)) return 'audio';
  if (['.js','.ts','.tsx','.jsx','.py','.html','.css','.json','.yaml','.yml','.sh','.ps1','.sql','.rs','.go','.java','.c','.cpp'].includes(extension)) return 'codigo';
  if (['.md','.txt','.pdf','.docx','.xlsx','.pptx','.odt','.ods','.odp','.csv','.tsv'].includes(extension)) return 'documentos';
  return 'otros';
}
export function outputName(value) {
  if (typeof value !== 'string' || !value || value.length > 4096 || !value.isWellFormed()
      || value.split('/').some(part => !part || part === '.' || part === '..'
        || /[\\:\x00-\x1f<>"|?*]/u.test(part) || /[. ]$/u.test(part)
        || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))) fail('Nombre relativo no válido.');
  return value;
}
export function outputDirectory(value) {
  if (typeof value !== 'string' || !value.isWellFormed() || !path.isAbsolute(value)
      || value.includes('\0') || value.length > 4096) fail('El destino debe ser una carpeta absoluta.');
  return path.normalize(value);
}
export function validateWorkDestinations(value) {
  if (!object(value) || Object.keys(value).some(key => !['carpeta','tipos'].includes(key))) fail('Política de destinos no válida.');
  const result = {};
  if (value.carpeta !== undefined) result.carpeta = outputDirectory(value.carpeta);
  if (value.tipos !== undefined) {
    if (!object(value.tipos) || Object.keys(value.tipos).some(key => !OUTPUT_TYPES.includes(key))) fail('Tipos de destino no válidos.');
    result.tipos = Object.fromEntries(Object.entries(value.tipos).map(([key,value]) => [key,outputDirectory(value)]));
  }
  return result;
}
function scope({ project, conversation } = {}) {
  if (project !== undefined && (typeof project !== 'string' || !project.trim() || project.length > 200)) fail('Proyecto no válido.');
  if (conversation !== undefined && (typeof conversation !== 'string' || !/^[a-f0-9-]{36}$/.test(conversation))) fail('ID de conversación no válido.');
  return conversation !== undefined ? ['conversaciones',conversation] : project !== undefined ? ['proyectos',projectKey(project)] : ['general'];
}
const policy = validateWorkDestinations;
export function createWorkDestinations(baseDirectory) {
  const filename = path.join(baseDirectory,'work-destinations.json');
  async function read() {
    const stored = await readJson(filename);
    if (!stored) return {revision:0,general:{},proyectos:{},conversaciones:{}};
    const value = stored.data;
    if (!object(value) || value.format !== 'mind-work-destinations' || value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 1
      || !object(value.proyectos) || !object(value.conversaciones)) fail('Configuración de destinos incompatible.');
    return {revision:value.revision,general:policy(value.general),
      proyectos:Object.fromEntries(Object.entries(value.proyectos).map(([key,value])=>[key,policy(value)])),
      conversaciones:Object.fromEntries(Object.entries(value.conversaciones).map(([key,value])=>[key,policy(value)]))};
  }
  async function configure({project,conversation,destinations,expectedRevision}) {
    const selection = scope({project,conversation});
    const normalized = destinations === null ? null : policy(destinations);
    return withIndexLock(baseDirectory,'all',async()=>{
      const current = await read();
      if (current.revision !== expectedRevision) throw new MotorError('DESTINATIONS_REVISION_CONFLICT','Los destinos cambiaron; vuelve a consultarlos.');
      if (selection.length === 1) current.general = normalized ?? {};
      else if (normalized === null) delete current[selection[0]][selection[1]];
      else current[selection[0]][selection[1]] = normalized;
      const next = {...current,revision:current.revision+1};
      if (Buffer.byteLength(JSON.stringify(next)) > 256*1024) fail('Demasiadas preferencias de destinos.');
      await writeJson(filename,{format:'mind-work-destinations',version:1,...next});
      return get({project,conversation});
    },'work-destinations',{signal:requestSignal()});
  }
  async function get({project,conversation}={}) {
    scope({project,conversation});
    const value = await read();
    const layers = [
      conversation === undefined ? null : value.conversaciones[conversation],
      project === undefined ? null : value.proyectos[projectKey(project)],
      value.general,
    ].filter(Boolean);
    const effective = {};
    for (const type of OUTPUT_TYPES) {
      for (const layer of layers) {
        const directory = layer.tipos?.[type] ?? layer.carpeta;
        if (directory) { effective[type] = directory; break; }
      }
    }
    return {revision:value.revision,general:value.general,
      proyecto:project === undefined ? null : value.proyectos[projectKey(project)] ?? null,
      conversacion:conversation === undefined ? null : value.conversaciones[conversation] ?? null,
      efectivos:effective};
  }
  async function directories() {
    const value=await read();
    const policies=[value.general,...Object.values(value.proyectos),...Object.values(value.conversaciones)];
    return [...new Set(policies.flatMap(item=>[item.carpeta,...Object.values(item.tipos??{})]).filter(Boolean))];
  }
  async function relocate(map) {
    return withIndexLock(baseDirectory,'all',async()=>{
      const value=await read(),before=JSON.stringify(value);
      for(const item of [value.general,...Object.values(value.proyectos),...Object.values(value.conversaciones)]) {
        if(item.carpeta!==undefined)item.carpeta=map(item.carpeta);
        if(item.tipos)for(const type of Object.keys(item.tipos))item.tipos[type]=map(item.tipos[type]);
      }
      if(JSON.stringify(value)!==before)await writeJson(filename,{format:'mind-work-destinations',version:1,...value,revision:value.revision+1});
    },'work-destinations',{signal:requestSignal()});
  }
  return {get,configure,directories,relocate};
}
