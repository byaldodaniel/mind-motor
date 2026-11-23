import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { scanTree, hashFile } from '../../src/product-files.js';
import { writeZip } from '../../src/archive.js';
import { buildNativePackage } from '../../scripts/construir-paquetes.mjs';
import { checkHealthyConnector, postRpc } from '../../src/connector.js';
import { r3Commit } from '../test/r3-fixture.mjs';
import { RUNS } from '../test/runs.mjs';

export const run = promisify(execFile);
const repo = fileURLToPath(new URL('../../', import.meta.url));
export const binary = process.env.MIND_NATIVE_EXE && path.resolve(process.env.MIND_NATIVE_EXE);
export const python = process.env.MIND_TEST_BUNDLED_PYTHON || process.env.MIND_PYTHON;
export const target = process.platform + '-' + process.arch;
const windows = process.platform === 'win32';
const pfx = 'mind-etapa7-';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const exists = file => fs.lstat(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });

export async function eventually(probe, timeout = 15000) {
  const stop = Date.now() + timeout;
  for (;;) {
    const result = await probe();
    if (result) return result;
    if (Date.now() > stop) assert.fail('El ensayo no alcanzó el estado esperado.');
    await delay(90);
  }
}

async function copyPython(destination, env) {
  const source = (await run(python || 'python3',['-I','-B','-c','import sys; print(sys.executable)'],{ env, timeout: 12000 })).stdout.trim();
  await fs.mkdir(path.dirname(destination), { recursive: true });
  if (!windows) {
    await fs.writeFile(destination, '#!/bin/sh\nexec ' + "'" + source.replaceAll("'", "'\\''") + "'" + ' "$@"\n', { mode: 0o755 });
    return;
  }
  const original = path.dirname(source);
  const files = await fs.readdir(original);
  const dll = files.find(name => /^python\d{2,3}\.dll$/i.test(name));
  assert.ok(dll);
  for (const name of files.filter(name => /^(?:python.*\.(?:dll|zip)|vcruntime.*\.dll|python\.exe)$/i.test(name))) {
    await fs.copyFile(path.join(original,name),path.join(path.dirname(destination),name));
  }
  const zip = files.find(name => /^python\d{2,3}\.zip$/i.test(name));
  await fs.writeFile(path.join(path.dirname(destination),dll.replace(/\.dll$/i,'._pth')),
    [zip && path.join(original,zip), path.join(original,'Lib'),path.join(original,'DLLs'),original].filter(Boolean).join('\n') + '\n');
}

export async function lab(t, { baselineZip = false } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(RUNS,pfx)));
  const installation = path.join(root,'Instalacion');
  const system = path.join(installation,'Sistema');
  const base = path.join(system,'Base');
  const motor = path.join(system,'Programa','Motor');
  const project = path.join(root,'Proyecto ficticio');
  const home = path.join(root,'Perfil');
  const codexHome = path.join(home,'.codex');
  const appData = path.join(home,'AppData');
  const packages = path.join(root,'Paquetes');
  let tracked = [];
  const env = { PATH: process.env.PATH, Path: process.env.Path, SystemRoot: process.env.SystemRoot, WINDIR:process.env.WINDIR,
    PATHEXT:process.env.PATHEXT, ComSpec:process.env.ComSpec,
    PROCESSOR_ARCHITECTURE:process.env.PROCESSOR_ARCHITECTURE,
    PROCESSOR_ARCHITEW6432:process.env.PROCESSOR_ARCHITEW6432, TMP:root,TEMP:root, TMPDIR: root,
    HOME:home,USERPROFILE:home,CODEX_HOME:codexHome,APPDATA:appData,LOCALAPPDATA:appData,GEMINI_CLI_HOME:home,
    MIND_AGENT_STARTUP:'0',MIND_QUIETUD_MS:'1000',MIND_VISTA_INACTIVA_MS:'1200',PYTHONDONTWRITEBYTECODE:'1' };
  const command = (file,args,options={}) => run(file,args,{env,cwd:project,windowsHide:true,timeout:30000,...options});
  async function stop() {
    const active = await checkHealthyConnector(base).catch(() => null);
    if (!active) return;
    await postRpc({port:active.health.port,token:active.token,payload:{accion:'apagar'},timeoutMs:5000}).catch(()=>{});
    await eventually(async()=>!await checkHealthyConnector(base).catch(()=>null),12000);
  }
  t.after(async () => {
    try {
      await stop();
    } finally {
      for (const process of tracked.reverse()) {
        if (process.child.exitCode === null && process.child.signalCode === null) process.child.kill();
        await process.finished;
      }
      assert.equal(path.dirname(root),RUNS);
      assert.ok(path.basename(root).startsWith(pfx));
      await fs.rm(root,{recursive:true,force:true,maxRetries:15,retryDelay:120});
    }
  });
  function launch(file,args,options={}) {
    const child = spawn(file,args,{cwd:project,env,windowsHide:true,stdio:['ignore','pipe','pipe'],...options});
    let stdout='',stderr='';
    child.stdout?.setEncoding('utf8').on('data', part=>{stdout=(stdout+part).slice(-25000)});
    child.stderr?.setEncoding('utf8').on('data', part=>{stderr=(stderr+part).slice(-12000)});
    child.on('error',error=>{ stderr += error.message; });
    const proc = {child,finished:new Promise(resolve=>child.once('close',code=>resolve({code,stdout,stderr})))};
    tracked.push(proc);
    return proc;
  }

  await Promise.all([motor,project,codexHome,appData].map(location=>fs.mkdir(location,{recursive:true})));
  assert.equal((await command('git',['rev-parse','v1.0.4-r3'],{cwd:repo})).stdout.trim(),r3Commit);
  const tar=path.join(root,'r3.tar');
  await command('git',['archive','--format=tar','--output='+tar,r3Commit,'--','bin','src','package.json','packaging/iniciadores'],{cwd:repo});
  await command('tar',['-xf',tar,'-C',motor]);
  await fs.rename(path.join(motor,'packaging','iniciadores'),path.join(root,'iniciadores-r3'));
  await fs.rmdir(path.join(motor,'packaging'));
  for (const name of await fs.readdir(path.join(root,'iniciadores-r3'))) {
    await fs.copyFile(path.join(root,'iniciadores-r3',name),path.join(system,name));
  }
  const runtime=path.join(system,'Componentes');
  const node=path.join(runtime,'Node',target,windows?'node.exe':'bin/node');
  const legacyPython=path.join(runtime,'Python',target,windows?'python.exe':'bin/python3');
  await fs.mkdir(path.dirname(node),{recursive:true});
  await fs.copyFile(process.execPath,node);
  await copyPython(legacyPython,env);
  env.MIND_PYTHON=legacyPython;
  const keys = generateKeyPairSync('ed25519');
  const channel = {repository:'ensayo/mind-ficticio',publicKey:keys.publicKey.export({type:'spki',format:'pem'})};
  await fs.writeFile(path.join(motor,'src','update-channel.json'),JSON.stringify(channel));
  const oldTree=await scanTree(installation);
  assert.ok(oldTree.every(entry=>entry.type==='file'));
  const oldFiles=Object.fromEntries(await Promise.all(oldTree.map(async ({path:relative})=>[relative,await hashFile(path.join(installation,relative))])));
  const oldManifest={format:'mind-product',version:1,packageRevision:3,layoutVersion:2,updateProtocolVersion:2,
    mindVersion:'1.0.4',platform:process.platform,arch:process.arch,baseFormatVersion:3,files:oldFiles,links:{}};
  const manifestFile=path.join(system,'mind-producto.json');
  await fs.writeFile(manifestFile,JSON.stringify(oldManifest)+'\n');
  let oldZipBytes;
  if (baselineZip) {
    const zip=path.join(root,'Mind-r3-laboratorio.zip');
    const entries=Object.keys(oldFiles).concat('Sistema/mind-producto.json')
      .map(relative=>({path:relative,type:'file',source:{file:path.join(installation,relative)}}));
    await writeZip(zip,entries,{root:'My Mind',mtime:1704067200});
    oldZipBytes=(await fs.stat(zip)).size;
  }
  const packageInfo=await buildNativePackage({output:packages,targets:[target],binaries:{[target]:binary},channel,
    privateKey:keys.privateKey,mtime:1704067200,keepStage:true});
  const zip=path.join(packages,packageInfo.name);
  const manifestBytes=await fs.readFile(path.join(packages,'.construccion-nativa','Sistema','mind-producto.json'));
  const feed={format:'mind-update',version:2,mindVersion:'1.0.5',packageRevision:1,layoutVersion:2,updateProtocolVersion:2,
    manifestSha256: hash(manifestBytes),packages:[{platform:process.platform,arch:process.arch,
      url:'https://github.com/ensayo/mind-ficticio/releases/download/v1.0.5/mind.zip',sha256:packageInfo.sha256,bytes:(await fs.stat(zip)).size}]};
  const envelope=(feedValue,key=keys.privateKey)=>{
    const bytes=Buffer.from(JSON.stringify(feedValue));
    return {payload:bytes.toString('base64'),signature:sign(null,bytes,key).toString('base64')};
  };
  const feedFile=path.join(root,'stable.json');
  await fs.writeFile(feedFile,JSON.stringify(envelope(feed)));
  const module=relative=>pathToFileURL(path.join(motor,'src',relative)).href;
  const seed=path.join(root,'semilla.mjs');
  await fs.writeFile(path.join(project,'resultado.txt'),'Resultado ficticio de Órbita.\n');
  await fs.writeFile(seed,[
    'import { resolveLayout } from '+JSON.stringify(module('layout.js')),
    'import { openSession } from '+JSON.stringify(module('session.js')),
    'import { createAgentTools } from '+JSON.stringify(module('agent-tools.js')),
    'const [base,folder,file]=process.argv.slice(2);',
    'const session=await openSession({layout:await resolveLayout({base}),motorVersion:"1.0.4",observe:false});',
    'try { await session.start();',
    'const scope=await session.motor.authorizeFolder(folder);',
    'await session.policy.set(scope.id,["encontrar","leer","escribir","organizar"],{channel:"administracion-local"});',
    'await session.policy.setContinuity(["leer","registrar"],{channel:"administracion-local"});',
    'const tools=createAgentTools({ session, connection:{clientInfo:{name:"laboratorio"},supportsFormElicitation:()=>false} });',
    'const call=(name,args)=>tools.call(name,args,{});',
    'const d=await call("destinos_consultar",{});',
    'await call("destinos_configurar",{revision:d.revision,destinos:{carpeta:folder}});',
    'const {conversacion}=await call("conversacion_guardar",{titulo:"Proyecto Órbita",proyecto:"Órbita",importante:"Se conservan treinta muestras de la brújula."});',
    'await call("resultado_registrar",{conversacion:conversacion.id,ruta:file});',
    'await call("asignar_propiedades",{carpeta:scope.id,ruta:"resultado.txt",asignar:{etiqueta:"laboratorio"}});',
    'console.log(JSON.stringify({scope:scope.id,conversacion}));',
    '} finally { await session.close(); }',
  ].join('\n'));
  const seeded=JSON.parse((await command(node,[seed,base,project,path.join(project,'resultado.txt')])).stdout);
  const daemon=path.join(root,'r3-daemon.mjs');
  await fs.writeFile(daemon,[
    'import { resolveLayout } from '+JSON.stringify(module('layout.js')),
    'import { runCentralMotorDaemon } from '+JSON.stringify(module('motor-central.js')),
    'await runCentralMotorDaemon({layout:await resolveLayout({base:process.argv[2]}),motorVersion:"1.0.4",observe:true,discoverDelayMs:60000,discoverUpdates:async()=>{}});',
  ].join('\n'));
  async function active() {
    return eventually(()=>checkHealthyConnector(base).catch(()=>null));
  }
  async function startOld() {
    const proc=launch(node,[daemon,base]);
    const found=await eventually(async()=>{
      if (proc.child.exitCode !== null) assert.fail((await proc.finished).stderr);
      return checkHealthyConnector(base).catch(()=>null);
    });
    assert.equal(found.health.pid,proc.child.pid);
    return found;
  }
  const installed=path.join(system,'Componentes','Nativo',target,windows?'mind-native.exe':'mind-native');
  const migrate=()=>launch(binary,['actualizar-firmada',installation,base,feedFile,zip,'--confirmar']);
  return {root,system,installation,base,project,home,env,node,motor,command,launch,startOld,stop,active,installed,seeded,feed,feedFile,
    envelope,channel,zip,oldZipBytes,manifestFile,oldManifest,migrate,reportFile:path.join(system,'Actualizaciones','relevo.json')};
}

export async function connect(active, workspace) {
  const headers={Authorization:'Bearer '+active.token,Accept:'application/json, text/event-stream','Content-Type':'application/json'};
  if(workspace)headers['X-Mind-Workspace']=Buffer.from(JSON.stringify({paths:[workspace]})).toString('base64url');
  let last=0;
  const url=new URL('/mcp',active.url);
  async function send(method,params) {
    const id=++last;
    const response=await fetch(url,{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id,method,params}),signal:AbortSignal.timeout(8000)});
    assert.equal(response.status,200,method);
    const body=await response.text();
    const parsed=JSON.parse(response.headers.get('content-type')?.includes('text/event-stream')
      ? body.split('\n').find(line=>line.startsWith('data:')).slice(5) : body);
    assert.equal(parsed.id,id);
    assert.equal(parsed.error,undefined,JSON.stringify(parsed.error));
    return {result:parsed.result,bytes:Buffer.byteLength(body),session:response.headers.get('mcp-session-id')};
  }
  const init=await send('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'Laboratorio ficticio',version:'1'}});
  headers['Mcp-Session-Id']=init.session;
  headers['MCP-Protocol-Version']=init.result.protocolVersion;
  const notification=await fetch(url,{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'}),signal:AbortSignal.timeout(6000)});
  assert.ok(notification.ok);
  await notification.text();
  return {
    async list() { const {result,bytes}=await send('tools/list'); return {tools:result.tools,bytes}; },
    async call(name,args={}) {
      const {result}=await send('tools/call',{name,arguments:args});
      const content=result.structuredContent ?? JSON.parse(result.content[0].text);
      assert.ok(!result.isError,name+' '+JSON.stringify(content));
      return content;
    },
    async close(){await (await fetch(url,{method:'DELETE',headers,signal:AbortSignal.timeout(5000)})).text();}
  };
}
