#!/usr/bin/env node
// Aceptación con datos ficticios: instalación nueva, valores predeterminados,
// traslado del elemento completo, reinicio y continuación. Nunca usa la Base personal.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { startMcp } from '../test/helpers/mcp-client.js';
import { productPaths, productRuntime } from '../src/layout.js';
import { readManifestFile } from '../src/product-files.js';

const args=process.argv.slice(2);
const option=name=>{const at=args.indexOf(name);return at<0?undefined:args[at+1];};
const repository=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
const reportFile=path.resolve(option('--informe')??'continuidad-usuario-nuevo.json');
const reportDirectory=path.dirname(reportFile);
const runtimeRoot=option('--runtime-root');
const packageRoot=option('--mind');
if(!runtimeRoot&&!packageRoot)throw new Error('Uso: node scripts/probar-continuidad-nueva.mjs --runtime-root <Mind con Runtime> [--mind <producto extraído>] [--informe <json>] [--codex] [--codex-cli <js>] [--conservar]');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const inside=(root,file)=>{const relative=path.relative(root,file);return relative&&!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith('..'+path.sep);};
const exists=file=>fs.stat(file).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;});
const temporaryParent=await fs.realpath(os.tmpdir());
const temporary=await fs.realpath(await fs.mkdtemp(path.join(temporaryParent,'mind-continuidad-nueva-')));
const product=path.join(temporary,'Mind');
const home=path.join(temporary,'Perfil ficticio');
const project=path.join(temporary,'Proyecto Duna');
let base=path.join(product,'Base');
const store=path.join(product,'Conversaciones');
const clients=[];
const env={...process.env,HOME:home,USERPROFILE:home,CODEX_HOME:path.join(home,'.codex'),MIND_AGENT_STARTUP:'1',MIND_UPDATE_RESTART:'1'};
for(const key of ['MIND_BASE','MIND_PYTHON','NODE_OPTIONS','NODE_PATH','PYTHONPATH','PYTHONHOME'])delete env[key];
const report={formato:'mind-aceptacion-continuidad',version:1,plataforma:`${process.platform}-${process.arch}`,producto:packageRoot?'copia de producto extraído':'instalación ficticia desde checkout y Runtime incluido',resultado:'fallido',fases:[],limites:['Los clientes MCP de aceptación simulan al agente; no equivalen a la interfaz de escritorio.','El informe identifica el entorno de ejecución de las pruebas funcionales del paquete universal único.']};
await fs.mkdir(reportDirectory,{recursive:true});

async function run(command,parameters,{cwd=project,timeout=180000,environment=env}={}) {
  return new Promise((resolve,reject)=>{
    let stdout='',stderr='';
    const child=spawn(command,parameters,{cwd,env:environment,windowsHide:true,stdio:['ignore','pipe','pipe']});
    const timer=setTimeout(()=>child.kill(),timeout);
    child.stdout.on('data',bytes=>stdout+=bytes);child.stderr.on('data',bytes=>stderr+=bytes);
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal,stdout,stderr});});
  });
}
async function phase(name,task){
  const started=performance.now();
  try{const details=await task();report.fases.push({nombre:name,resultado:'superado',ms:Math.round(performance.now()-started),...details});console.log('✔ '+name);}
  catch(error){report.fases.push({nombre:name,resultado:'fallido',ms:Math.round(performance.now()-started),error:error.stack});throw error;}
}
async function bounded(promise,label,ms=60000){
  let timer;try{return await Promise.race([promise,new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(new Error('Tiempo agotado: '+label)),ms);})]);}finally{clearTimeout(timer);}
}
async function call(client,name,input={}){
  const value=await bounded(client.call(name,input),name);
  assert.equal(value.isError,false,name+': '+JSON.stringify(value.data??value.rpcError));
  assert.ok(!value.rpcError,name+': '+JSON.stringify(value.rpcError));return value.data;
}
async function codeFingerprint(root){
  const files=[];
  async function visit(relative){for(const item of await fs.readdir(path.join(root,relative),{withFileTypes:true})){const name=path.posix.join(relative,item.name);if(item.isDirectory())await visit(name);else if(item.isFile())files.push([name,sha(await fs.readFile(path.join(root,name)))]);}}
  await visit('src');await visit('bin');files.push(['package.json',sha(await fs.readFile(path.join(root,'package.json')))]);files.sort((a,b)=>a[0].localeCompare(b[0]));
  return {archivos:files.length,sha256:sha(JSON.stringify(files))};
}
let node,entry,nativeFirst;
async function openClient(name,cwd=product){
  const client=startMcp({command:node,commandArgs:[entry,'mcp'],cwd,baseEnv:env,capabilities:{},clientInfo:{name,version:'aceptacion'}});
  clients.push(client);const initialized=await bounded(client.initialize(),name,30000);assert.ok(!initialized.error,JSON.stringify(initialized.error));return client;
}
async function close(client){assert.equal((await bounded(client.close(),'cierre MCP',10000)).code,0,client.stderr());}
async function records(){
  const names=(await fs.readdir(base)).filter(name=>/^continuity-[a-f0-9-]{36}\.json$/.test(name));
  return Promise.all(names.map(async name=>JSON.parse(await fs.readFile(path.join(base,name),'utf8'))));
}
async function modelTurn(label,prompt,cwd=project){
  const cli=option('--codex-cli')??path.join(process.env.APPDATA??'','npm','node_modules','@openai','codex','bin','codex.js');
  assert.ok(await exists(cli),'No está instalada la CLI de Codex indicada.');
  const result=await run(process.execPath,[cli,'exec','--ephemeral','--skip-git-repo-check','--approve-for-me','--json','-C',cwd,'--add-dir',cwd===product?project:product,prompt],{cwd,timeout:240000});
  await fs.writeFile(path.join(reportDirectory,label+'.jsonl'),result.stdout);
  await fs.writeFile(path.join(reportDirectory,label+'.stderr'),result.stderr);
  assert.equal(result.code,0,'Codex terminó con '+result.code+'; ver registro '+label);
  const events=result.stdout.trim().split('\n').filter(Boolean).map(line=>{try{return JSON.parse(line);}catch{return null;}}).filter(Boolean);
  const commands=events.filter(value=>value.type==='item.completed'&&value.item?.type==='command_execution').map(value=>value.item.command);
  const answer=events.filter(value=>value.type==='item.completed'&&value.item?.type==='agent_message').map(value=>value.item.text).join('\n');
  return {commands,answer};
}
let authentication;
try{
  await phase('Instalación y perfiles nuevos aislados',async()=>{
    await fs.mkdir(project);await fs.mkdir(product);
    for(const name of ['.codex','.claude','.gemini'])await fs.mkdir(path.join(home,name),{recursive:true});
    if(packageRoot){
      for(const name of await fs.readdir(packageRoot))if(!['Base','Conversaciones'].includes(name))await fs.cp(path.join(packageRoot,name),path.join(product,name),{recursive:true,verbatimSymlinks:true});
    }else{
      const manifest={format:'mind-product',version:1,mindVersion:'1.0.3',platform:process.platform,arch:process.arch,layoutVersion:2,packageRevision:1,updateProtocolVersion:2,files:{}};
      const paths=productPaths(product,manifest),runtime=productRuntime(product,manifest);
      await fs.mkdir(paths.motorDirectory,{recursive:true});
      for(const name of ['src','bin','package.json'])await fs.cp(path.join(repository,name),path.join(paths.motorDirectory,name),{recursive:true,verbatimSymlinks:true});
      const sourceManifest=await readManifestFile(runtimeRoot),sourceRuntime=productRuntime(runtimeRoot,sourceManifest);
      for(const [from,to] of [[sourceRuntime.nodeDirectory,runtime.nodeDirectory],[sourceRuntime.pythonDirectory,runtime.pythonDirectory]]){
        await fs.mkdir(path.dirname(to),{recursive:true});await fs.cp(from,to,{recursive:true,verbatimSymlinks:true});
      }
      const semantic=productPaths(runtimeRoot,sourceManifest).semanticDirectory;
      if(await exists(semantic)){await fs.mkdir(path.dirname(paths.semanticDirectory),{recursive:true});await fs.cp(semantic,paths.semanticDirectory,{recursive:true,verbatimSymlinks:true});}
      await fs.writeFile(paths.manifestFile,JSON.stringify(manifest));
      for(const name of ['AGENTS.md','CLAUDE.md','GEMINI.md','LEEME.md'])await fs.copyFile(path.join(repository,'packaging','plantilla',name),path.join(product,name));
      const launcher=process.platform==='win32'?'mind.cmd':'mind';
      await fs.copyFile(path.join(repository,'packaging','iniciadores',launcher),path.join(paths.launcherDirectory,launcher));
      await fs.copyFile(path.join(repository,'packaging','iniciadores','arranque.cjs'),path.join(paths.launcherDirectory,'arranque.cjs'));
      if(process.platform!=='win32')await fs.chmod(path.join(paths.launcherDirectory,launcher),0o755);
    }
    const manifest=await readManifestFile(product);
    const paths=productPaths(product,manifest);base=paths.baseDirectory;
    report.codigo=await codeFingerprint(paths.motorDirectory);
    node=productRuntime(product,manifest).nodeExecutable;
    report.paquete=manifest?{version:manifest.mindVersion,commit:manifest.builtFrom,targets:manifest.targets??[manifest.platform+'-'+manifest.arch]}:null;
    entry=paths.entrypoint;
    assert.equal(await exists(base),false);assert.equal(await exists(store),false);
    if(args.includes('--codex')){
      const sourceAuth=path.join(process.env.CODEX_HOME??path.join(os.homedir(),'.codex'),'auth.json');
      assert.ok(await exists(sourceAuth),'No hay autenticación local para el modelo de Codex.');
      authentication=path.join(home,'.codex','auth.json');await fs.copyFile(sourceAuth,authentication);await fs.chmod(authentication,0o600);
      assert.equal(await exists(path.join(home,'.codex','AGENTS.md')),false,'Primera apertura sin instrucciones globales previamente preparadas.');
      nativeFirst=await modelTurn('codex-nuevo-1','Proyecto ficticio Aurora aceptación. Hemos aprobado 12 muestras para el jueves y queda pendiente confirmar el embalaje. Crea una nota Markdown y una ilustración SVG sencilla. Conserva el acuerdo para poder continuar este trabajo en otra conversación. Usa solo información y archivos de este ensayo.',product);
      assert.ok(nativeFirst.commands.some(command=>/mind\.js|mind\.cmd/.test(command)),'Debe descubrir el iniciador desde las instrucciones de la carpeta extraída.');
    }
    const started=await run(node,[entry,'inicio']);assert.equal(started.code,0,started.stderr);
    const plan=JSON.parse(started.stdout);assert.equal(plan.destinos.predeterminado,store);assert.equal(plan.destinos.memoria.modo,'esencial');
    assert.deepEqual(plan.destinos.general,{});assert.equal(await exists(store),true);
    for(const relative of ['.codex/AGENTS.md','.claude/CLAUDE.md','.gemini/GEMINI.md'])assert.match(await fs.readFile(path.join(home,relative),'utf8'),/mind-startup:begin/);
    return {destino:store,preferencia:'esencial',eleccionesDeDestinos:0,perfiles:'tres perfiles ficticios, reglas de inicio preparadas'};
  });
  let id,oldMemory,oldMemoryBytes,documentBytes,pngBytes,relocatedMemory,relocatedResults;
  await phase('Primer agente guarda decisiones y resultados con valores predeterminados',async()=>{
    const client=await openClient('usuario-nuevo-A');
    const preferences=await call(client,'conversacion_preferencias');assert.equal(preferences.efectiva.modo,'esencial');
    const saved=await call(client,'conversacion_guardar',{titulo:'Duna aceptación nueva',proyecto:'Duna aceptación nueva',importante:'Decisión vigente: preparar 23 muestras para el martes. Pendiente: confirmar el vehículo.'});
    id=saved.conversacion.id;oldMemory=saved.conversacion.archivo;
    assert.equal(path.dirname(oldMemory),store);oldMemoryBytes=await fs.readFile(oldMemory);
    documentBytes=Buffer.from('# Informe Duna\nDecisión: 23 muestras para el martes.\n','utf8');
    const document=await call(client,'crear',{ruta:'Trabajo Duna/informe.md',contenido:documentBytes.toString('utf8'),conversacion:id});
    assert.equal(document.ruta_absoluta,path.join(store,'Trabajo Duna','informe.md'));
    pngBytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jz1cAAAAASUVORK5CYII=','base64');
    const generated=path.join(store,'temporal-generador.png');await fs.writeFile(generated,pngBytes,{flag:'wx'});
    const image=await call(client,'resultado_importar',{origen:generated,nombre:'Trabajo Duna/imagen.png',conversacion:id});
    assert.equal(image.sha256,sha(pngBytes));
    const read=await call(client,'conversacion_leer',{id});assert.equal(read.conversacion.resultados.length,2);assert.equal(client.elicitations.length,0);
    await close(client);return {id,archivo:oldMemory,resultados:2,formularios:0,imagen_sha256:sha(pngBytes)};
  });
  await phase('Otro agente traslada el elemento y renombra su carpeta',async()=>{
    const client=await openClient('usuario-nuevo-B',project);
    const read=await call(client,'conversacion_leer',{id});
    const destination=path.join(project,'Conversación Duna');
    const transfer=await call(client,'conversacion_trasladar',{id,revision:read.conversacion.revision,destino:destination});assert.equal(transfer.estado,'trasladada',JSON.stringify(transfer));
    const transferred=await call(client,'conversacion_leer',{id});assert.equal(transferred.conversacion.id,id);assert.ok(inside(destination,transferred.conversacion.archivo));
    assert.equal(transferred.conversacion.resultados.length,2);
    const moved=await call(client,'mover',{carpeta:project,desde:'Conversación Duna',hasta:'Trabajo terminado'});assert.equal(moved.estado,'movido');
    const final=await call(client,'conversacion_leer',{id});relocatedMemory=final.conversacion.archivo;relocatedResults=final.conversacion.resultados;
    const renamed=path.join(project,'Trabajo terminado');assert.ok(inside(renamed,relocatedMemory));
    assert.equal(await exists(destination),false);
    assert.match(await fs.readFile(relocatedMemory,'utf8'),/23 muestras para el martes/);
    for(const result of relocatedResults){assert.ok(inside(renamed,result.archivo));const bytes=await fs.readFile(result.archivo);assert.ok(bytes.equals(result.tipo==='imagenes'?pngBytes:documentBytes));}
    assert.equal(client.elicitations.length,0);await close(client);
    return {id,destino:renamed,memoria:relocatedMemory,resultados:relocatedResults,originalesConservados:true};
  });
  await phase('Tercer agente recupera y corrige sin perder archivos ni recrear rutas antiguas',async()=>{
    const client=await openClient('usuario-nuevo-C',project);
    const found=await call(client,'conversaciones_buscar',{consulta:'Duna',modo:'palabras'});assert.equal(found.conversaciones.filter(item=>item.id===id).length,1);
    const read=await call(client,'conversacion_leer',{id});assert.match(read.conversacion.importante,/23 muestras para el martes/);
    const saved=await call(client,'conversacion_guardar',{id,revision:read.conversacion.revision,importante:'Decisión vigente: preparar 31 muestras para el lunes, que sustituye el acuerdo de 23 para el martes. Pendiente: confirmar el vehículo.'});
    assert.equal(saved.conversacion.id,id);assert.equal(saved.conversacion.archivo,relocatedMemory);assert.match(await fs.readFile(relocatedMemory,'utf8'),/31 muestras para el lunes/);
    assert.ok((await fs.readFile(oldMemory)).equals(oldMemoryBytes),'La copia de origen debe seguir intacta.');
    assert.equal(await exists(path.join(project,'Conversación Duna')),false,'No debe recrearse la carpeta intermedia.');
    const next=await call(client,'crear',{ruta:'continuacion.txt',contenido:'Continuado en nueva ubicación.',conversacion:id});assert.ok(inside(path.join(project,'Trabajo terminado'),next.ruta_absoluta));
    for(const result of relocatedResults){const bytes=await fs.readFile(result.archivo);assert.equal(sha(bytes),sha(result.tipo==='imagenes'?pngBytes:documentBytes));}
    const all=await records();assert.equal(all.filter(item=>item.kind==='conversacion'&&item.content.title==='Duna aceptación nueva').length,1);
    await close(client);return {id,revision:saved.conversacion.revision,decisiones:'31 muestras para el lunes',siguienteResultado:next.ruta_absoluta,imagen_sha256:sha(pngBytes),memoriaOriginalIntacta:true,carpetaIntermediaRecreada:false};
  });
  if(args.includes('--codex'))await phase('Codex real usa inicio, guarda y traslada sin mencionar Mind en el prompt',async()=>{
    const first=nativeFirst;assert.ok(first,'Primera apertura real ejecutada antes del inicio de la instalación.');
    let all=await records();const native=all.filter(item=>item.kind==='conversacion'&&/Aurora/i.test(item.content.title));assert.equal(native.length,1,'Un único elemento Aurora.');
    const nativeId=native[0].id;const nativeResults=JSON.parse(await fs.readFile(path.join(base,'conversation-results-'+nativeId+'.json'),'utf8')).results;assert.ok(nativeResults.length>=2,'Nota e ilustración vinculadas a la conversación.');
    const fingerprints=await Promise.all(nativeResults.map(async item=>({type:item.type,hash:sha(await fs.readFile(item.path))})));
    const nativeDestination=path.join(project,'Aurora trasladada');
    const second=await modelTurn('codex-nuevo-2','Retoma el trabajo ficticio Aurora aceptación. Traslada esa conversación con su memoria y todos sus resultados a '+JSON.stringify(nativeDestination)+'. Conserva el acuerdo y comprueba los archivos. No generes otra conversación ni modifiques otros proyectos.');
    assert.ok(second.commands.some(command=>command.includes('mind.js')&&command.includes('inicio')),'La siguiente conversación debe iniciar Mind mediante sus reglas globales.');
    all=await records();const moved=all.find(item=>item.id===nativeId);assert.ok(inside(nativeDestination,moved.content.file),'Memoria trasladada por el modelo.');
    const outputs=JSON.parse(await fs.readFile(path.join(base,'conversation-results-'+nativeId+'.json'),'utf8')).results;assert.equal(outputs.length,nativeResults.length);
    for(const item of outputs){assert.ok(inside(nativeDestination,item.path));const hash=sha(await fs.readFile(item.path));assert.ok(fingerprints.some(old=>old.type===item.type&&old.hash===hash));}
    const third=await modelTurn('codex-nuevo-3','Recupera el trabajo ficticio Aurora aceptación. Indica cantidad de muestras, día acordado, pendiente, memoria y resultados actuales. No cambies nada ni guardes otro elemento.');
    assert.match(third.answer,/12/);assert.match(third.answer,/jueves/i);assert.match(third.answer,/embalaje/i);
    all=await records();assert.equal(all.filter(item=>item.kind==='conversacion'&&/Aurora/i.test(item.content.title)).length,1);
    return {cliente:'Codex CLI real con perfil ficticio',promptMencionaMind:false,id:nativeId,resultados:outputs.length,primeraAperturaSinPreparar:true,inicioAutomatico:true,trasladoVerificado:true,recuperacionVerificada:true,turnos:3};
  });
  report.resultado='superado';
}catch(error){report.error=error.stack;process.exitCode=1;console.error(error.message);}
finally{
  if(authentication)await fs.rm(authentication,{force:true});
  await Promise.allSettled(clients.map(async client=>{try{await bounded(client.close(),'limpieza MCP',10000);}catch{client.child.kill();await bounded(client.exited,'salida MCP',10000);}}));
  report.fecha=new Date().toISOString();report.temporalConservado=args.includes('--conservar')?temporary:null;
  await fs.writeFile(reportFile,JSON.stringify(report,null,2)+'\n');
  if(!args.includes('--conservar')){assert.equal(path.dirname(temporary),temporaryParent);assert.ok(path.basename(temporary).startsWith('mind-continuidad-nueva-'));await fs.rm(temporary,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
}
