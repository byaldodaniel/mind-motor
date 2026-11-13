import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {execFile} from 'node:child_process';
import {generateKeyPairSync} from 'node:crypto';
import {correctInstallation} from '../src/commands/corregir.js';
import {createSignedPackageDescriptor} from '../src/package-descriptor.js';
import {scanTree,hashFile,readManifestFile,UNIVERSAL_TARGETS} from '../src/product-files.js';
import {productPaths,productRuntime} from '../src/layout.js';
import {keepPythonPath} from '../scripts/construir-paquetes.mjs';
import {identifyCurrentProcess} from '../src/process-identity.js';
import {BASE_FORMAT_VERSION} from '../src/base-format.js';
const run=promisify(execFile),repository=fileURLToPath(new URL('..',import.meta.url));
async function write(root,relative,value){const file=path.join(root,...relative.split('/'));await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,value);}
// Concurrencia acotada, como mapLimit del producto: una entrega real tiene miles de archivos y abrirlos todos a la vez agota los descriptores (EMFILE).
async function snapshot(root){const files=(await scanTree(root)).filter(e=>e.type==='file'),entries=new Array(files.length);let next=0;await Promise.all(Array.from({length:Math.min(32,files.length)},async()=>{while(next<files.length){const i=next++;entries[i]=[files[i].path,await hashFile(path.join(root,files[i].path))];}}));return Object.fromEntries(entries);}
async function manifestAt(root,{modern=false,revision=0}={}){
 const files=await snapshot(root);delete files['mind-producto.json'];delete files['Sistema/mind-producto.json'];delete files['Sistema/entrega-firmada.json'];
 const manifest={format:'mind-product',version:1,mindVersion:modern?'1.0.3':'1.0.2',platform:'win32',arch:'x64',targets:[...UNIVERSAL_TARGETS],baseFormatVersion:BASE_FORMAT_VERSION,files,links:{},...(modern?{packageRevision:revision,layoutVersion:2,updateProtocolVersion:2}:{})};
 const bytes=Buffer.from(JSON.stringify(manifest));await write(root,modern?'Sistema/mind-producto.json':'mind-producto.json',bytes);return {manifest,bytes};
}
async function oldCopy(root,publicKey){
 await write(root,'Motor/src/update-channel.json',JSON.stringify({repository:'fixture/mind',url:'https://github.com/fixture/mind/releases/latest/download/stable.json',publicKey}));
 await write(root,'Motor/app.txt','programa anterior ficticio');await manifestAt(root);
 const base=path.join(root,'Base');await write(root,'Base/mind-base.json',JSON.stringify({format:'mind-base',version:BASE_FORMAT_VERSION}));await write(root,'Base/continuidad.md','decisión ficticia');
 await write(root,'Conversaciones/recurso.bin',Buffer.from([0,255,42]));
 const config={propiedadPersonal:'conservar',mcpServers:{otro:{command:'ajeno',args:['dato']},mind:{type:'stdio',command:'Runtime/node/node.exe',args:['Motor/bin/mind.js','mcp','--carpeta','Carpeta ficticia'],env:{PERSONAL_FICTICIO:'conservar',NODE_OPTIONS:''}}}};
 await write(root,'.mcp.json',JSON.stringify(config));return {root,base,config};
}

test('corregir verifica confianza existente, migra copia real, conserva configuración y prepara con sesión activa',async t=>{
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'mind-corregir-'));t.after(()=>fs.rm(temp,{recursive:true,force:true}));
 const source=path.join(temp,'Entrega firmada'),target=path.join(temp,'My Mind');
 const {publicKey,privateKey}=generateKeyPairSync('ed25519');const trusted=publicKey.export({type:'spki',format:'pem'});
 const old=await oldCopy(target,trusted);const beforeBase=await snapshot(old.base),beforeUser=await snapshot(path.join(target,'Conversaciones'));
 const modern={layoutVersion:2,targets:[...UNIVERSAL_TARGETS]},paths=productPaths(source,modern),runtime=productRuntime(source,modern);
 await fs.mkdir(paths.motorDirectory,{recursive:true});for(const name of ['src','bin'])await fs.cp(path.join(repository,name),path.join(paths.motorDirectory,name),{recursive:true});await fs.copyFile(path.join(repository,'package.json'),path.join(paths.motorDirectory,'package.json'));
 await fs.copyFile(path.join(repository,'packaging','iniciadores','arranque.cjs'),path.join(source,'Sistema','arranque.cjs'));
 await write(source,'Sistema/Programa/Motor/src/update-channel.json',JSON.stringify({repository:'fixture/mind',url:'https://github.com/fixture/mind/releases/latest/download/stable.json',publicKey:trusted}));
 await fs.mkdir(path.dirname(runtime.nodeExecutable),{recursive:true});await fs.copyFile(process.execPath,runtime.nodeExecutable,constants.COPYFILE_FICLONE);await fs.chmod(runtime.nodeExecutable,0o755);
 const pythonCommand=process.env.MIND_PYTHON??process.env.MIND_TEST_PYTHON??(process.platform==='win32'?'python':'python3');
 const pythonHome=(await run(pythonCommand,['-I','-B','-c','import sys;print(sys.base_prefix)'])).stdout.trim();
 await fs.cp(pythonHome,runtime.pythonDirectory,{recursive:true,filter:entry=>entry===pythonHome||keepPythonPath(path.relative(pythonHome,entry).split(path.sep).join('/'))});
 const signed=await manifestAt(source,{modern:true,revision:1});const envelope=createSignedPackageDescriptor({manifest:signed.manifest,manifestBytes:signed.bytes,privateKey});
 await write(source,'Sistema/entrega-firmada.json',JSON.stringify(envelope));
 const profileFiles=[path.join(process.env.CODEX_HOME??path.join(os.homedir(),'.codex'),'AGENTS.md'),path.join(os.homedir(),'.claude','CLAUDE.md'),path.join(os.homedir(),'.gemini','GEMINI.md')];
 const profileState=async()=>Promise.all(profileFiles.map(async file=>{const stat=await fs.lstat(file).catch(e=>{if(e.code==='ENOENT')return null;throw e;});return stat?{size:stat.size,mtimeMs:stat.mtimeMs}:null;}));
 const beforeProfiles=await profileState();
 const beforeTarget=await snapshot(target);const previousStartup=process.env.MIND_AGENT_STARTUP;process.env.MIND_AGENT_STARTUP='0';t.after(()=>{if(previousStartup===undefined)delete process.env.MIND_AGENT_STARTUP;else process.env.MIND_AGENT_STARTUP=previousStartup;});
 await t.test('origen igual o contenido dentro del destino se rechaza sin cambios',async()=>{
  await assert.rejects(correctInstallation({source:target,target}),{code:'UPDATE_SOURCE_INVALID'});assert.deepEqual(await snapshot(target),beforeTarget);
  const nested=path.join(target,'entrega-anidada');await write(nested,'Sistema/Programa/Motor/app.txt','ficticio');
  const nestedSigned=await manifestAt(nested,{modern:true,revision:1});await write(nested,'Sistema/entrega-firmada.json',JSON.stringify(createSignedPackageDescriptor({manifest:nestedSigned.manifest,manifestBytes:nestedSigned.bytes,privateKey})));
  const nestedBefore=await snapshot(target);await assert.rejects(correctInstallation({source:nested,target,verifyInstalled:async()=>{}}),{code:'UPDATE_SOURCE_INVALID'});assert.deepEqual(await snapshot(target),nestedBefore);await fs.rm(nested,{recursive:true,force:true});
 });
 await t.test('firma alterada y una clave de paquete propia no sustituyen la confianza existente',async()=>{
  await write(source,'Sistema/entrega-firmada.json',JSON.stringify({...envelope,signature:Buffer.alloc(64).toString('base64')}));
  await assert.rejects(correctInstallation({source,target}),{code:'PACKAGE_SIGNATURE_INVALID'});assert.deepEqual(await snapshot(target),beforeTarget);
  const foreign=generateKeyPairSync('ed25519');await write(source,'Sistema/entrega-firmada.json',JSON.stringify(createSignedPackageDescriptor({manifest:signed.manifest,manifestBytes:signed.bytes,privateKey:foreign.privateKey})));
  await assert.rejects(correctInstallation({source,target}),{code:'PACKAGE_SIGNATURE_INVALID'});assert.deepEqual(await snapshot(target),beforeTarget);
  await write(source,'Sistema/entrega-firmada.json',JSON.stringify(envelope));
 });
 await t.test('sesión verdadera conserva la actualización preparada sin sustituir programa',async()=>{
  const active=await oldCopy(path.join(temp,'Copia activa'),trusted);const identity=await identifyCurrentProcess({pythonExecutable:runtime.pythonExecutable});
  const id='11111111-1111-4111-8111-111111111111';await write(active.root,`Base/sesiones/sesion-${id}.json`,JSON.stringify({format:'mind-session',version:2,id,...identity,startedAt:new Date().toISOString()}));
  await assert.rejects(correctInstallation({source,target:active.root,verifyInstalled:async()=>{}}),e=>e.code==='MIND_IN_USE'&&e.prepared===true);
  assert.equal((await readManifestFile(active.root)).mindVersion,'1.0.2');
  const journal=JSON.parse(await fs.readFile(path.join(active.root,'Sistema/Actualizaciones/transaccion.json'),'utf8'));assert.equal(journal.phase,'prepared');
 });
 await t.test('corrección completa conserva Base, recursos y argumentos/env de MCP',async()=>{
  const result=await correctInstallation({source,target,verifyInstalled:async()=>{}});assert.equal(result.status,'actualizada');assert.equal(result.cleanupPending,false);
  assert.equal((await readManifestFile(target)).packageRevision,1);assert.deepEqual(await snapshot(path.join(target,'Sistema/Base')),beforeBase);assert.deepEqual(await snapshot(path.join(target,'Conversaciones')),beforeUser);
  const config=JSON.parse(await fs.readFile(path.join(target,'.mcp.json'),'utf8'));assert.equal(config.propiedadPersonal,'conservar');assert.deepEqual(config.mcpServers.otro,old.config.mcpServers.otro);
  assert.deepEqual(config.mcpServers.mind.args,['Sistema/arranque.cjs',...old.config.mcpServers.mind.args.slice(1)]);
  assert.equal(config.mcpServers.mind.env.PERSONAL_FICTICIO,'conservar');assert.match(config.mcpServers.mind.command,/Sistema[\/]Componentes[\/]Node/);
  assert.equal(result.configuration.status,'actualizada');assert.deepEqual(await profileState(),beforeProfiles);await assert.rejects(fs.stat(path.join(target,'Sistema/Actualizaciones/Trabajo/actual')),{code:'ENOENT'});
 });
});
