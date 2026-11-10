import fs from 'node:fs/promises';
import path from 'node:path';
import { MotorError } from './errors.js';
import { readJson, writeJson, removeJson } from './storage.js';
import { withIndexLock } from './index-lock.js';
import { requestSignal } from './request-context.js';
import { retention } from './conversation-preferences.js';
import { validateWorkDestinations, outputDirectory, OUTPUT_TYPES } from './work-destinations.js';
import { parseContinuityExport } from './continuity.js';

export const RELOCATION_FILE = 'conversation-relocation.json';
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export function relocateLocalPath(value,from,to) {
  if(typeof value!=='string'||!path.isAbsolute(value))return value;
  const relative=path.relative(from,value);
  if(path.isAbsolute(relative)||relative==='..'||relative.startsWith('..'+path.sep))return value;
  return relative?path.join(to,relative):to;
}
const pending=error=>new MotorError('CONVERSATION_RELOCATION_PENDING',
  'El archivo ya puede estar trasladado. Mind conserva la operación y debe completar sus rutas antes de guardar o continuar. '+(error.code??'METADATA_FAILED'),{cause:error});
async function identity(filename) {
  try {
    const value=await fs.lstat(filename,{bigint:true});
    if(value.isSymbolicLink())throw new MotorError('UNSAFE_PATH','El extremo del traslado no puede ser un enlace.');
    return {dev:String(value.dev),ino:String(value.ino)};
  } catch(error) {if(error.code==='ENOENT')return null;throw error;}
}
function validateResults(values) {
  if(!Array.isArray(values)||values.length>1000||Buffer.byteLength(JSON.stringify(values))>256*1024)throw new MotorError('INVALID_RESULT','Resultados no válidos.');
  for(const value of values) {
    outputDirectory(value.path);
    if(!OUTPUT_TYPES.includes(value.type)||!Number.isSafeInteger(value.bytes)||value.bytes<0
      ||value.sha256!==undefined&&!/^[a-f0-9]{64}$/.test(value.sha256))throw new MotorError('INVALID_RESULT','Resultado no válido.');
  }
  return structuredClone(values);
}
/**
 * Diario técnico pequeño: coordina los datos existentes; nunca abre ni borra originales.
 * Todas las operaciones públicas de estos datos pasan por la misma barrera.
 */
export function createConversationRelocation({baseDirectory,continuity,conversations,results,destinations}) {
  const filename=path.join(baseDirectory,RELOCATION_FILE);
  const lock=task=>withIndexLock(baseDirectory,'all',task,'conversation-relocation',{signal:requestSignal(),timeoutMs:10000});
  async function journal(value) {await writeJson(filename,{format:'mind-conversation-relocation',version:1,...value});}
  async function prepareMove(from,to) {
    const map=location=>relocateLocalPath(location,from,to),ids=[];
    // Detectar errores existentes ANTES de mover. Recuperar no vuelve a recorrer
    // registros ajenos creados después: el diario conserva el conjunto afectado.
    for(const id of await continuity.listContinuityIds()) {
      const entry=await continuity.getContinuity(id);
      if(entry?.kind!=='conversacion'||entry.content?.format!=='mind-conversation')continue;
      await conversations.getConversation(id);
      const content={...entry.content},references=entry.references.map(ref=>ref.locator===undefined?ref:{...ref,locator:map(ref.locator)});
      if(content.file!==undefined)content.file=map(content.file);
      if(content.preferences?.directory!==undefined)content.preferences={...content.preferences,directory:map(content.preferences.directory)};
      const previous=await results.read(id),next=previous.results.map(item=>({...item,path:map(item.path)}));
      validateResults(next);
      const pack=await continuity.exportContinuity({ids:[id]});
      pack.entries[0].content=content;pack.entries[0].references=references;parseContinuityExport(pack);
      if(content.file!==undefined)outputDirectory(content.file);
      if(content.preferences?.directory!==undefined)outputDirectory(content.preferences.directory);
      if(!equal(content,entry.content)||!equal(references,entry.references)||!equal(next,previous.results))ids.push(id);
    }
    await destinations.get();
    for(const directory of await destinations.directories())outputDirectory(map(directory));
    const preference=await conversations.getConversationPreferences();
    if(preference.global.directory!==undefined)outputDirectory(map(preference.global.directory));
    return ids;
  }
  async function applyMove(value) {
    const map=location=>relocateLocalPath(location,value.from,value.to);
    for(const id of value.ids) {
      const entry=await continuity.getContinuity(id);
      if(entry?.kind!=='conversacion'||entry.content?.format!=='mind-conversation')continue;
      const content={...entry.content},references=entry.references.map(ref=>ref.locator===undefined?ref:{...ref,locator:map(ref.locator)});
      if(content.file!==undefined)content.file=map(content.file);
      if(content.preferences?.directory!==undefined)content.preferences={...content.preferences,directory:map(content.preferences.directory)};
      if(!equal(content,entry.content)||!equal(references,entry.references))
        await continuity.updateContinuity(id,{...equal(content,entry.content)?{}:{content},...equal(references,entry.references)?{}:{references}},{expectedRevision:entry.revision,preserveExistingReferences:true});
      const previous=await results.read(id);
      const next=previous.results.map(item=>({...item,path:map(item.path)}));
      if(!equal(next,previous.results))await results.replace(id,{expectedRevision:previous.revision,results:next});
    }
    await destinations.relocate(map);
    await conversations.relocateConversationPreferenceDirectories(map);
  }
  async function applyMetadata(value) {
    let entry=await continuity.getContinuity(value.id);
    if(!entry)throw new MotorError('CONVERSATION_NOT_FOUND','La conversación ya no existe.');
    const desired={...entry.content,file:value.file,...value.preferences===undefined?{}:{preferences:value.preferences}};
    if(!equal(entry.content,desired)||!equal(entry.references,value.references)) {
      if(entry.revision!==value.revision)throw new MotorError('CONTINUITY_REVISION_CONFLICT','La conversación cambió mientras se trasladaba.');
      await continuity.updateContinuity(value.id,{...equal(entry.content,desired)?{}:{content:desired},...equal(entry.references,value.references)?{}:{references:value.references}},{expectedRevision:value.revision,preserveExistingReferences:true});
    }
    const previous=await results.read(value.id);
    if(!equal(previous.results,value.results))
      await results.replace(value.id,{expectedRevision:value.resultsRevision,results:value.results});
    const settings=await destinations.get({conversation:value.id});
    if(!equal(settings.conversacion,value.destinations))
      await destinations.configure({conversation:value.id,destinations:value.destinations,expectedRevision:value.destinationsRevision});
  }
  async function recoverUnlocked() {
    const stored=await readJson(filename);if(!stored)return;
    const value=stored.data;
    if(value?.format!=='mind-conversation-relocation'||value.version!==1||!['move','metadata'].includes(value.kind))
      throw new MotorError('CONVERSATION_RELOCATION_CORRUPT','El diario de traslado no es compatible.');
    try {
      if(value.kind==='move') {
        if(!Array.isArray(value.ids)||value.ids.some(id=>typeof id!=='string'||!/^[a-f0-9-]{36}$/.test(id)))throw new MotorError('CONVERSATION_RELOCATION_CORRUPT','Faltan los registros afectados por el traslado.');
        if(value.phase==='prepared') {
          const source=await identity(value.from),target=await identity(value.to);
          if(equal(source,value.identity)&&path.relative(value.from,value.to)!==''){await removeJson(filename);return;}
          if(path.relative(value.from,value.to)===''&&equal(target,value.identity)){await applyMove(value);await removeJson(filename);return;}
          if(source||!equal(target,value.identity))throw new MotorError('MOVE_UNCONFIRMED','No se puede demostrar el resultado físico del traslado.');
        }
        await applyMove(value);
      } else await applyMetadata(value);
      await removeJson(filename);
    } catch(error) {throw pending(error);}
  }
  async function withState(task) {return lock(async()=>{await recoverUnlocked();return task();});}
  async function move({from,to},operation) {
    return withState(async()=>{
      from=outputDirectory(from);to=outputDirectory(to);
      const before=await identity(from);
      if(!before)throw new MotorError('FILE_NOT_FOUND','El origen ya no existe.');
      const ids=await prepareMove(from,to);
      const value={kind:'move',phase:'prepared',from,to,identity:before,ids};
      await journal(value);
      let result;
      try {result=await operation();}
      catch(error) {
        // La siguiente llamada verifica la identidad; no borra ni revierte archivos a ciegas.
        try {await recoverUnlocked();}catch{}
        throw error;
      }
      try {
        await journal({...value,phase:'moved'});
        await recoverUnlocked();
        return {...result,continuity:{estado:'actualizada'}};
      } catch(error) {
        return {...result,continuity:{estado:'pendiente',codigo:error.code??'METADATA_FAILED',
          nota:'El movimiento físico se completó; Mind reintentará completar las rutas antes de continuar.'}};
      }
    });
  }
  async function metadata(input) {
    return withState(async()=>{
      const {id,revision,file,references,results:nextResults,resultsRevision,destinations:nextDestinations,destinationsRevision,preferences}=input;
      const before=await conversations.getConversation(id),previous=await results.read(id),settings=await destinations.get({conversation:id});
      if(before.revision!==revision)throw new MotorError('CONTINUITY_REVISION_CONFLICT','La conversación cambió; vuelve a leerla.');
      if(previous.revision!==resultsRevision)throw new MotorError('RESULTS_REVISION_CONFLICT','Los resultados cambiaron; vuelve a leerlos.');
      if(settings.revision!==destinationsRevision)throw new MotorError('DESTINATIONS_REVISION_CONFLICT','Los destinos cambiaron; vuelve a consultarlos.');
      outputDirectory(file);
      if(path.extname(file).toLowerCase()!=='.md')throw new MotorError('INVALID_CONVERSATION_DESTINATION','El archivo debe ser Markdown.');
      const normalizedPreferences=preferences===undefined?undefined:retention(preferences);
      const pack=await continuity.exportContinuity({ids:[id]});
      pack.entries[0].content={...pack.entries[0].content,file,...normalizedPreferences===undefined?{}:{preferences:normalizedPreferences}};
      pack.entries[0].references=references;parseContinuityExport(pack);
      const value={kind:'metadata',id,revision,file,references:structuredClone(references),results:validateResults(nextResults),resultsRevision,
        destinations:validateWorkDestinations(nextDestinations),destinationsRevision,...normalizedPreferences===undefined?{}:{preferences:normalizedPreferences}};
      await journal(value);
      await recoverUnlocked();
      return conversations.getConversation(id);
    });
  }
  return {withState,move,metadata,recover:()=>withState(()=>undefined)};
}
