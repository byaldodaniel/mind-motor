import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {MotorError} from './errors.js';

const BEGIN='<!-- mind-startup:begin -->', END='<!-- mind-startup:end -->';
const shellQuote=value=>"'"+value.replaceAll("'","'\\''")+"'";
export function startupInstructions(root,runtime,platform=process.platform) {
  const command=platform==='win32'
    ? '& '+[runtime.nodeExecutable,path.join(root,'Motor','bin','mind.js')].map(value=>"'"+value.replaceAll("'","''")+"'").join(' ')+' inicio'
    : [runtime.nodeExecutable,path.join(root,'Motor','bin','mind.js')].map(shellQuote).join(' ')+' inicio';
  return BEGIN+'\n## Mind: inicio de conversaciones\n\n'
    +'Antes de responder la primera solicitud sustantiva de cada conversación, consulta Mind. Si tienes sus herramientas conectadas, llama destinos_consultar (con proyecto/conversacion cuando corresponda) y aplica su política antes de crear archivos.\n'
    +'Si no tienes las herramientas, ejecuta este iniciador desde la carpeta de trabajo actual, sin cambiar de proyecto:\n\n'
    +'    '+command+'\n\n'
    +'Lee las instrucciones y destinos que devuelve inicio; usa su CLI incluida si no hay MCP. Conserva lo importante según la preferencia: esencial por defecto. Guarda documentos, imágenes, código y demás resultados físicamente en los destinos resueltos; registra resultados en la conversación y conserva su ID al retomar. Cambiar un destino de proyecto afecta a sus nuevos resultados. Comprueba el archivo antes de anunciar guardado.\n'
    +'Esta instalación de Mind está en '+JSON.stringify(root)+'. Si no está disponible, informa la incidencia; no inventes recuerdos ni destinos, ni pidas configurar servidores manualmente. Las instrucciones del usuario y los permisos vigentes prevalecen.\n'+END;
}
function merge(text,block) {
  const start=text.indexOf(BEGIN), end=text.indexOf(END);
  if(start<0 && end<0)return text+(text.endsWith('\n')||!text?'':'\n')+'\n'+block+'\n';
  if(start<0||end<start||text.indexOf(BEGIN,start+BEGIN.length)>=0||text.indexOf(END,end+END.length)>=0)
    throw new MotorError('STARTUP_RULE_CONFLICT','El bloque de inicio de Mind necesita revisión; se conservó el archivo.');
  return text.slice(0,start)+block+text.slice(end+END.length);
}
async function safeRead(file) {
  try{
    const info=await fs.lstat(file);
    if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size>256*1024)
      throw new MotorError('STARTUP_RULE_UNSAFE','No se modifica un archivo de reglas enlazado, especial o demasiado grande.');
    return await fs.readFile(file,'utf8');
  }catch(error){if(error.code==='ENOENT')return null;throw error;}
}
async function install(file,block) {
  const previous=await safeRead(file), next=merge(previous??'',block);
  if(previous===next)return 'vigente';
  if(previous===null){await fs.writeFile(file,next,{flag:'wx',mode:0o600});return 'preparado';}
  const temporary=path.join(path.dirname(file),'.mind-startup-'+randomUUID()+'.tmp');
  try{
    await fs.writeFile(temporary,next,{flag:'wx',mode:(await fs.stat(file)).mode&0o777});
    if(await safeRead(file)!==previous)throw new MotorError('STARTUP_RULE_CONFLICT','Las reglas cambiaron mientras se preparaban; se conservó su versión.');
    await fs.rename(temporary,file);
    return 'preparado';
  }finally{await fs.rm(temporary,{force:true});}
}
/** Anfitrión de instalación; nunca se expone como herramienta de agente. */
export async function prepareAgentStartup({root,runtime,home=os.homedir(),env=process.env,platform=process.platform}={}) {
  if(!root || env.MIND_AGENT_STARTUP==='0')return {estado:'omitido',clientes:[]};
  const codexHome=env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(home,'.codex');
  const candidates=[['Codex',codexHome,'AGENTS.md'],['Claude Code',path.join(home,'.claude'),'CLAUDE.md'],['Antigravity',path.join(home,'.gemini'),'GEMINI.md']];
  const block=startupInstructions(root,runtime,platform), clients=[];
  for(const [name,directory,defaultFile] of candidates) {
    try {
      const folder=await fs.lstat(directory).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
      if(!folder)continue;
      if(!folder.isDirectory()||folder.isSymbolicLink())throw new MotorError('STARTUP_RULE_UNSAFE','La carpeta global debe ser real.');
      let file=path.join(directory,defaultFile);
      if(name==='Codex'){
        const override=path.join(directory,'AGENTS.override.md');
        const text=await safeRead(override);
        if(text?.trim())file=override;
      }
      clients.push({cliente:name,archivo:file,estado:await install(file,block)});
    } catch(error) {clients.push({cliente:name,estado:'pendiente',codigo:error.code??'STARTUP_RULE_FAILED',mensaje:error.message});}
  }
  return {estado:clients.some(x=>x.estado==='pendiente')?'parcial':clients.length?'preparado':'sin_clientes',clientes:clients};
}
