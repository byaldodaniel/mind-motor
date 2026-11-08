import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { MotorError } from '../errors.js';
import { productInstallation, productPaths, productRuntime } from '../layout.js';
import { readManifestFile } from '../product-files.js';
import { verifyPackageDescriptor } from '../package-descriptor.js';
import { updateMind } from './actualizar.js';

/** Applies an authenticated new delivery to an existing installation without opening a work session. */
export async function correctInstallation({target,source,baseDirectory,verifyInstalled,testing,report=()=>{}}){
  target=await fs.realpath(path.resolve(target));source=await fs.realpath(path.resolve(source));
  if(target===source)throw new MotorError('UPDATE_SOURCE_INVALID','La entrega nueva debe estar fuera de la copia que se corrige.');
  const current=await readManifestFile(target);
  const manifest=await readManifestFile(source);
  if(!manifest)throw new MotorError('UPDATE_PACKAGE_INVALID','Falta el manifiesto de la entrega nueva.');
  let key;
  const channels=[
    path.join(target,'Sistema','Programa','Motor','src','update-channel.json'),
    path.join(target,'Motor','src','update-channel.json'),
    path.join(target,'Sistema','Actualizaciones','Trabajo','actual','recuperacion','Motor','src','update-channel.json'),
    path.join(target,'Sistema','Actualizaciones','Trabajo','actual','recuperacion','Sistema','Programa','Motor','src','update-channel.json'),
  ];
  for(const file of channels){try{key=JSON.parse(await fs.readFile(file,'utf8')).publicKey;if(key)break;}catch(e){if(e.code!=='ENOENT')throw e;}}
  if(!key)throw new MotorError('UPDATE_TRUST_MISSING','No se encontró la clave de confianza de la copia existente.');
  const checked=await verifyPackageDescriptor({root:source,publicKey:key,allowUserState:true});
  const sourceRuntime=productRuntime(source,manifest);
  const result=await updateMind({root:target,source,baseDirectory:baseDirectory??(current?productPaths(target,current).baseDirectory:undefined),
    pythonExecutable:sourceRuntime.pythonExecutable,expectedRelease:checked.release,expectedManifestSha256:checked.manifestSha256,
    confirm:()=>true,verifyInstalled,testing,report});
  if(result.status==='actualizada'||result.status==='al-dia'){
    const installed=await readManifestFile(target),paths=productPaths(target,installed),runtime=productRuntime(target,installed);
    result.configuration=await new Promise(resolve=>{
      const child=spawn(runtime.nodeExecutable,[paths.entrypoint,'preparar'],{cwd:target,windowsHide:true,env:{...process.env,MIND_UPDATE_RESTART:'1',MIND_AGENT_STARTUP:process.env.MIND_AGENT_STARTUP??'1',...(result.baseMigration?{MIND_BASE_MIGRATED_FROM:result.baseMigration.from,MIND_BASE_MIGRATED_TO:result.baseMigration.to}:{})},stdio:['ignore','pipe','pipe']});
      let stderr='';let stdout='';child.stderr.on('data',b=>{stderr=(stderr+b).slice(-4096);});child.stdout.on('data',b=>{stdout=(stdout+b).slice(-4096);});
      const timer=setTimeout(()=>child.kill(),30000);child.on('error',e=>{clearTimeout(timer);resolve({status:'pendiente',reason:e.message});});
      child.on('exit',code=>{clearTimeout(timer);resolve({status:code===0?'actualizada':'pendiente',details:code===0?stdout:stderr});});
    });
  }
  return result;
}
export async function run({parameters,options,print}){
  const target=parameters[0];let source;
  if(parameters.length>1){if(parameters[1]!=='--paquete'||!parameters[2]||parameters.length!==3)throw new MotorError('INVALID_ARGUMENTS','Uso: mind corregir <copia> [--paquete <carpeta extraída>]');source=parameters[2];}
  if(!target)throw new MotorError('INVALID_ARGUMENTS','Indica la copia existente que quieres actualizar.');
  source??=(await productInstallation()).root;
  if(!source)throw new MotorError('UPDATE_SOURCE_REQUIRED','Ejecuta esta orden desde la entrega corregida o indica --paquete.');
  try{const result=await correctInstallation({target,source,baseDirectory:options.base,report:m=>process.stderr.write(m+'\n')});print(result);return 0;}
  catch(e){if(e.prepared){print({status:'pendiente',reason:e.code,message:e.message,active:e.active,unknown:e.unknown});return 0;}throw e;}
}
