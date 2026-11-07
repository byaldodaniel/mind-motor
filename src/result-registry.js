import path from 'node:path';
import {readJson,writeJson} from './storage.js';
import {withIndexLock} from './index-lock.js';
import {MotorError} from './errors.js';
import {OUTPUT_TYPES,outputDirectory} from './work-destinations.js';
import {requestSignal} from './request-context.js';
const validId=id=>{if(typeof id!=='string'||!/^[a-f0-9]{8}-[a-f0-9-]{27}$/.test(id))throw new MotorError('INVALID_CONVERSATION_ID','ID de conversación no válido.');return id;};
export function createResultRegistry(baseDirectory) {
  const file=id=>path.join(baseDirectory,'conversation-results-'+validId(id)+'.json');
  async function read(id) {
    const stored=await readJson(file(id));
    if(!stored)return {revision:0,results:[]};
    if(stored.data?.format!=='mind-conversation-results'||stored.data.version!==1||!Number.isSafeInteger(stored.data.revision)||!Array.isArray(stored.data.results))throw new MotorError('RESULTS_CORRUPT','Registro de resultados no compatible.');
    return {revision:stored.data.revision,results:stored.data.results};
  }
  async function remember(id,value) {
    validId(id);
    const location=outputDirectory(value.path);
    if(!OUTPUT_TYPES.includes(value.type)||!Number.isSafeInteger(value.bytes)||value.bytes<0||value.sha256!==undefined&&!/^[a-f0-9]{64}$/.test(value.sha256))throw new MotorError('INVALID_RESULT','Resultado no válido.');
    const entry={path:location,type:value.type,bytes:value.bytes,...value.sha256?{sha256:value.sha256}:{},updatedAt:new Date().toISOString()};
    return withIndexLock(baseDirectory,id,async()=>{
      const previous=await read(id);
      const key=p=>process.platform==='win32'?p.toLowerCase():p;
      const results=previous.results.filter(item=>key(item.path)!==key(location));
      results.push(entry);
      if(results.length>1000||Buffer.byteLength(JSON.stringify(results))>256*1024)throw new MotorError('RESULTS_TOO_LARGE','Demasiados resultados en esta conversación.');
      await writeJson(file(id),{format:'mind-conversation-results',version:1,revision:previous.revision+1,results});
      return entry;
    },'conversation-results',{signal:requestSignal()});
  }
  return {read,remember};
}
