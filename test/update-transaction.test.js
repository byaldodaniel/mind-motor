import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {promisify} from 'node:util';
import {execFile} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {updateMind} from '../src/commands/actualizar.js';
import {checkPreparationSpace,recoverUpdateTransaction} from '../src/update-transaction.js';
import {readManifestFile,scanTree,UNIVERSAL_TARGETS,hashFile} from '../src/product-files.js';
import {BASE_FORMAT_VERSION} from '../src/base-format.js';
import {startCentralMotor} from '../src/motor-central.js';
import {checkHealthyConnector} from '../src/connector.js';
const sha=x=>createHash('sha256').update(x).digest('hex');
const run=promisify(execFile);
const moduleUrl=new URL('../src/commands/actualizar.js',import.meta.url).href;
const relativeNode=`Sistema/Componentes/Node/${process.platform}-${process.arch}/${process.platform==='win32'?'node.exe':'bin/node'}`;
const relativePython=`Sistema/Componentes/Python/${process.platform}-${process.arch}/${process.platform==='win32'?'python.exe':'bin/python3'}`;
const componentFile='Sistema/Componentes/Semantica/model.bin';
async function write(root,r,value){const f=path.join(root,...r.split('/'));await fs.mkdir(path.dirname(f),{recursive:true});await fs.writeFile(f,value);}
async function packageAt(root,revision,{variant='',legacy=false,components='constantes'}={}){
 const entries=legacy?{'Motor/app.txt':`app-${revision}${variant}`,'Runtime/node/node.exe':'node-ficticio','Runtime/python/python.exe':'python-ficticio'}:{
  'Sistema/Programa/Motor/app.txt':`app-${revision}${variant}`,
  [relativeNode]:'node-ficticio', [relativePython]:'python-ficticio', [componentFile]:components,
  'Sistema/Licencias/licencia.txt':'licencia ficticia', 'LEEME.md':'paquete ficticio'};
 for(const [r,value]of Object.entries(entries))await write(root,r,value);
 const manifest={format:'mind-product',version:1,mindVersion:legacy?'1.0.2':'1.0.3',platform:'win32',arch:'x64',targets:[...UNIVERSAL_TARGETS],baseFormatVersion:BASE_FORMAT_VERSION,
  ...(legacy?{}:{packageRevision:revision,layoutVersion:2,updateProtocolVersion:2}),files:Object.fromEntries(Object.entries(entries).map(([r,value])=>[r,sha(value)])),links:{}};
 await write(root,legacy?'mind-producto.json':'Sistema/mind-producto.json',JSON.stringify(manifest));
 if(!legacy)await write(root,'Sistema/entrega-firmada.json',JSON.stringify({ficticio:true,revision}));
 return manifest;
}
async function fixture(t,{legacy=false}={}){
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'mind-transaccion-'));t.after(()=>fs.rm(temp,{recursive:true,force:true}));
 const root=path.join(temp,'My Mind');await packageAt(root,0,{legacy});
 const base=path.join(root,legacy?'Base':'Sistema/Base');await fs.mkdir(base,{recursive:true});
 await fs.writeFile(path.join(base,'mind-base.json'),JSON.stringify({format:'mind-base',version:BASE_FORMAT_VERSION,baseId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',createdAt:'2026-01-01T00:00:00.000Z'}));
 await fs.writeFile(path.join(base,'continuidad.md'),'decisión ficticia persistente');
 await write(root,'Conversaciones/recurso.bin',Buffer.from([0,255,12]));
 const source=path.join(temp,'paquete');await packageAt(source,1);
 return {temp,root,base,source,options:{root,source,baseDirectory:base,confirm:()=>true,verifyInstalled:async()=>{},pythonExecutable:process.env.MIND_PYTHON??process.env.MIND_TEST_PYTHON}};
}
async function hashes(root){return Object.fromEntries(await Promise.all((await scanTree(root)).filter(e=>e.type==='file').map(async e=>[e.path,await hashFile(path.join(root,e.path))])));}
async function assertClean(root){
 const names=await fs.readdir(root);assert.ok(!names.some(n=>n.startsWith('.anterior-')||n.startsWith('.mind-actualizacion-')),names.join(','));
 await assert.rejects(fs.stat(path.join(root,'Sistema/Actualizaciones/Trabajo/actual')),{code:'ENOENT'});
 await assert.rejects(fs.stat(path.join(root,'Sistema/Actualizaciones/transaccion.json')),{code:'ENOENT'});
}

test('tres revisiones conservan identidad de componentes y no acumulan instalaciones anteriores',async t=>{
 const f=await fixture(t);const beforeBase=await hashes(f.base),beforeUser=await hashes(path.join(f.root,'Conversaciones'));
 const component=path.join(f.root,componentFile),inode=(await fs.stat(component,{bigint:true})).ino;
 for(const revision of [1,2,3]){
  const source=path.join(f.temp,`paquete-${revision}`);await packageAt(source,revision);
  const result=await updateMind({...f.options,source});assert.equal(result.status,'actualizada');assert.ok(result.reusedComponents>=4);
  assert.equal((await readManifestFile(f.root)).packageRevision,revision);assert.equal((await fs.stat(component,{bigint:true})).ino,inode);
  assert.deepEqual(await hashes(f.base),beforeBase);assert.deepEqual(await hashes(path.join(f.root,'Conversaciones')),beforeUser);await assertClean(f.root);
 }
});

test('misma versión pública admite revisión nueva, idéntica es no-op y conflicto de identidad se rechaza',async t=>{
 const f=await fixture(t);await updateMind(f.options);const inode=(await fs.stat(path.join(f.root,componentFile),{bigint:true})).ino;
 assert.equal((await updateMind(f.options)).status,'al-dia');assert.equal((await fs.stat(path.join(f.root,componentFile),{bigint:true})).ino,inode);await assertClean(f.root);
 const conflicting=path.join(f.temp,'conflicto');await packageAt(conflicting,1,{variant:'contenido-distinto'});
 await assert.rejects(updateMind({...f.options,source:conflicting}),{code:'UPDATE_IDENTITY_CONFLICT'});
 assert.equal(await fs.readFile(path.join(f.root,'Sistema/Programa/Motor/app.txt'),'utf8'),'app-1');await assertClean(f.root);
 const metadata=path.join(f.temp,'metadatos-distintos');await packageAt(metadata,1);
 const metadataFile=path.join(metadata,'Sistema','mind-producto.json');const metadataValue=JSON.parse(await fs.readFile(metadataFile,'utf8'));metadataValue.builtFrom='otra-construccion';await fs.writeFile(metadataFile,JSON.stringify(metadataValue));
 await assert.rejects(updateMind({...f.options,source:metadata}),{code:'UPDATE_IDENTITY_CONFLICT'});await assertClean(f.root);
});

test('archivos desconocidos del usuario sobreviven y los internos no gestionados detienen la sustitución',async t=>{
 const f=await fixture(t);await write(f.root,'mi-documento.txt','conservar');await write(f.root,'Sistema/Programa/Motor/personal.txt','no gestionado');
 await assert.rejects(updateMind(f.options),{code:'UPDATE_UNMANAGED_CONTENT'});
 assert.equal(await fs.readFile(path.join(f.root,'Sistema/Programa/Motor/personal.txt'),'utf8'),'no gestionado');
 assert.equal(await fs.readFile(path.join(f.root,'mi-documento.txt'),'utf8'),'conservar');assert.equal((await readManifestFile(f.root)).packageRevision,0);await assertClean(f.root);
});

async function crashUpdate(f,hook){
 const script=`import {updateMind} from ${JSON.stringify(moduleUrl)}; const config=JSON.parse(process.env.MIND_TEST_UPDATE_OPTIONS); await updateMind({...config,confirm:()=>true,verifyInstalled:async()=>{},testing:${hook}});`;
 await assert.rejects(run(process.execPath,['--input-type=module','-e',script],{env:{...process.env,MIND_TEST_UPDATE_OPTIONS:JSON.stringify({root:f.root,source:f.source,baseDirectory:f.base,pythonExecutable:f.options.pythonExecutable})}}),e=>e.code===74);
}
for(const phase of ['aside','verifying','committed'])test(`interrupción abrupta en ${phase}: recupera diario y conserva Base`,async t=>{
 const f=await fixture(t);const beforeBase=await hashes(f.base);const hook=phase==='aside'?'{afterMove:async phase=>{if(phase==="aside")process.exit(74)}}':`{afterPhase:async phase=>{if(phase===${JSON.stringify(phase)})process.exit(74)}}`;
 await crashUpdate(f,hook);const result=await recoverUpdateTransaction(f.root,{pythonExecutable:f.options.pythonExecutable});assert.equal(result.status,'recuperada');
 assert.equal((await readManifestFile(f.root)).packageRevision,phase==='committed'?1:0);assert.deepEqual(await hashes(f.base),beforeBase);await assertClean(f.root);
});

test('migración 1.0.2 traslada Base predeterminada byte a byte y no conserva copia antigua',async t=>{
 const f=await fixture(t,{legacy:true}),beforeBase=await hashes(f.base),beforeUser=await hashes(path.join(f.root,'Conversaciones'));
 const result=await updateMind(f.options);assert.equal(result.status,'actualizada');assert.equal(result.baseDirectory,await fs.realpath(path.join(f.root,'Sistema','Base')));
 assert.deepEqual(await hashes(result.baseDirectory),beforeBase);assert.deepEqual(await hashes(path.join(f.root,'Conversaciones')),beforeUser);
 await assert.rejects(fs.stat(path.join(f.root,'Motor')),{code:'ENOENT'});await assert.rejects(fs.stat(f.base),{code:'ENOENT'});await assertClean(f.root);
});


test('fallo después de migrar MCP revierte configuración exacta y Base',async t=>{
 const f=await fixture(t,{legacy:true});const config={personal:'conservar',mcpServers:{otro:{command:'ajeno',args:[]},mind:{type:'stdio',command:'Runtime/node/node.exe',args:['Motor/bin/mind.js','mcp','--carpeta','datos ficticios'],env:{PERSONAL:'valor'}}}};
 const serialized=JSON.stringify(config,null,3)+'\n';await write(f.root,'.mcp.json',serialized);const beforeBase=await hashes(f.base);
 await assert.rejects(updateMind({...f.options,verifyInstalled:async()=>{
  const migrated=JSON.parse(await fs.readFile(path.join(f.root,'.mcp.json'),'utf8'));
  assert.equal(migrated.mcpServers.mind.args[0],'Sistema/arranque.cjs');
  assert.deepEqual(migrated.mcpServers.mind.args.slice(1),config.mcpServers.mind.args.slice(1));
  assert.equal(migrated.mcpServers.mind.env.PERSONAL,'valor');
  throw Object.assign(new Error('Fallo de verificación ficticio'),{code:'UPDATE_CHECK_FAILED'});
 }}),{code:'UPDATE_CHECK_FAILED'});
 assert.equal(await fs.readFile(path.join(f.root,'.mcp.json'),'utf8'),serialized);assert.deepEqual(await hashes(f.base),beforeBase);
 assert.equal((await readManifestFile(f.root)).mindVersion,'1.0.2');await assertClean(f.root);
});


test('sin espacio no prepara ni sustituye componentes',async t=>{
 const f=await fixture(t),beforeBase=await hashes(f.base),beforeComponent=(await fs.stat(path.join(f.root,componentFile),{bigint:true})).ino;
 let checks=0;
 await assert.rejects(updateMind({...f.options,testing:{statfs:async()=>{checks++;return {bavail:0,bsize:4096};}}}),e=>e.code==='UPDATE_DISK_SPACE'&&e.available===0&&e.required>=64*1024**2);
 assert.equal(checks,1);assert.equal((await readManifestFile(f.root)).packageRevision,0);
 assert.equal((await fs.stat(path.join(f.root,componentFile),{bigint:true})).ino,beforeComponent);assert.deepEqual(await hashes(f.base),beforeBase);await assertClean(f.root);
});

async function changeBaseFormat(source,version){
 const filename=path.join(source,'Sistema','mind-producto.json');
 const manifest=JSON.parse(await fs.readFile(filename,'utf8'));manifest.baseFormatVersion=version;
 await fs.writeFile(filename,JSON.stringify(manifest));
}

test('preparar con Motor vivo no lo apaga ni abre la Base y permite continuar la misma transacción',async t=>{
 const f=await fixture(t);let verifications=0;
 const motor=await startCentralMotor({layout:{product:false,root:f.root,baseDirectory:f.base,motorDirectory:path.resolve('src'),pythonExecutable:f.options.pythonExecutable,protectedDirectories:[]},observe:false,discoverDelayMs:-1,updateRoot:null,quietMs:0});
 t.after(()=>motor.stop());
 const before=await hashes(f.base);
 const prepared=await updateMind({...f.options,prepareOnly:true,verifyInstalled:async()=>{verifications++;}});
 assert.equal(prepared.status,'preparada');assert.equal(prepared.toRevision,1);assert.equal(verifications,0);
 assert.equal((await readManifestFile(f.root)).packageRevision,0);assert.ok(await checkHealthyConnector(f.base));
 assert.equal(JSON.parse(await fs.readFile(path.join(f.root,'Sistema/Actualizaciones/transaccion.json'),'utf8')).phase,'prepared');
 assert.deepEqual(await hashes(f.base),before);
 await motor.stop();
 assert.equal((await updateMind(f.options)).status,'actualizada');await assertClean(f.root);
});

test('verificación asistida recibe la Base real y acepta una migración con copia previa verificada',async t=>{
 const f=await fixture(t);await changeBaseFormat(f.source,BASE_FORMAT_VERSION+1);
 const result=await updateMind({...f.options,assistedVerification:true,verifyInstalled:async(root,manifest,context)=>{
  assert.equal(root,await fs.realpath(f.root));assert.equal(context.baseDirectory,await fs.realpath(f.base));assert.equal(context.previousBaseFormat,BASE_FORMAT_VERSION);assert.equal(context.supportedBaseFormat,BASE_FORMAT_VERSION+1);
  const journal=JSON.parse(await fs.readFile(path.join(f.root,'Sistema/Actualizaciones/transaccion.json'),'utf8'));
  assert.equal(journal.baseSnapshot.ready,true);
  assert.equal(await fs.readFile(path.join(f.root,journal.baseSnapshot.path,'continuidad.md'),'utf8'),'decisión ficticia persistente');
  const marker=JSON.parse(await fs.readFile(path.join(f.base,'mind-base.json'),'utf8'));marker.version=manifest.baseFormatVersion;
  await fs.writeFile(path.join(f.base,'mind-base.json'),JSON.stringify(marker));await write(f.base,'migracion.json','formato nuevo ficticio');
 }});
 assert.equal(result.status,'actualizada');assert.equal(JSON.parse(await fs.readFile(path.join(f.base,'mind-base.json'),'utf8')).version,BASE_FORMAT_VERSION+1);await assertClean(f.root);
});

test('fallo del verificador después de migrar restaura programa y todos los persistentes de la Base',async t=>{
 const f=await fixture(t);await write(f.base,'__proto__','nombre ficticio válido');const before=await hashes(f.base);await changeBaseFormat(f.source,BASE_FORMAT_VERSION+1);
 await assert.rejects(updateMind({...f.options,assistedVerification:true,verifyInstalled:async()=>{
  await fs.writeFile(path.join(f.base,'continuidad.md'),'modificación ficticia');await write(f.base,'nueva/capa.json','migración parcial');
  throw Object.assign(new Error('El Motor no sirve la Base'),{code:'UPDATE_REAL_BASE_FAILED'});
 }}),{code:'UPDATE_REAL_BASE_FAILED'});
 assert.deepEqual(await hashes(f.base),before);assert.equal((await readManifestFile(f.root)).packageRevision,0);await assertClean(f.root);
});

test('sin cambio de formato rechaza cambios persistentes y los revierte, sin confundir metadatos del proceso',async t=>{
 const f=await fixture(t);const before=await hashes(f.base);
 await assert.rejects(updateMind({...f.options,assistedVerification:true,verifyInstalled:async()=>{await fs.writeFile(path.join(f.base,'continuidad.md'),'cambio no permitido');}}),{code:'UPDATE_BASE_CHANGED'});
 assert.deepEqual(await hashes(f.base),before);await assertClean(f.root);
 const result=await updateMind({...f.options,assistedVerification:true,verifyInstalled:async()=>{await write(f.base,'conector.json','metadatos ficticios de proceso');await write(f.base,'motor-central.log','log ficticio');}});
 assert.equal(result.status,'actualizada');await assertClean(f.root);
});

async function crashAssisted(f,body,testing='{}'){
 const script='import fs from "node:fs/promises"; import path from "node:path"; import {updateMind} from '+JSON.stringify(moduleUrl)+'; const config=JSON.parse(process.env.MIND_TEST_UPDATE_OPTIONS); await updateMind({...config,confirm:()=>true,assistedVerification:true,verifyInstalled:async(root,manifest,context)=>{'+body+'},testing:'+testing+'});';
 await assert.rejects(run(process.execPath,['--input-type=module','-e',script],{env:{...process.env,MIND_TEST_UPDATE_OPTIONS:JSON.stringify({root:f.root,source:f.source,baseDirectory:f.base,pythonExecutable:f.options.pythonExecutable})}}),error=>error.code===74);
}
for(const phase of ['snapshot','verifying','committed'])test('corte asistido en '+phase+' conserva copia previa y recupera la Base',async t=>{
 const f=await fixture(t);const before=await hashes(f.base);
 await crashAssisted(f,'','{afterPhase:async phase=>{if(phase==='+JSON.stringify(phase)+')process.exit(74)}}');
 const result=await recoverUpdateTransaction(f.root,{pythonExecutable:f.options.pythonExecutable});assert.equal(result.status,'recuperada');
 assert.equal((await readManifestFile(f.root)).packageRevision,phase==='committed'?1:0);assert.deepEqual(await hashes(f.base),before);await assertClean(f.root);
});

test('corte tras migración y nuevo corte al restaurar permiten repetir recuperación en Base externa',async t=>{
 const f=await fixture(t);const external=path.join(f.temp,'Base externa');await fs.rename(f.base,external);f.base=external;f.options.baseDirectory=external;
 const before=await hashes(f.base);await changeBaseFormat(f.source,BASE_FORMAT_VERSION+1);
 await crashAssisted(f,'await fs.writeFile(path.join(context.baseDirectory,"continuidad.md"),"migración parcial");await fs.writeFile(path.join(context.baseDirectory,"creado.json"),"nuevo");process.exit(74);');
 const recoverModule=new URL('../src/update-transaction.js',import.meta.url).href;
 const script='import {recoverUpdateTransaction} from '+JSON.stringify(recoverModule)+';await recoverUpdateTransaction(process.env.MIND_TEST_ROOT,{pythonExecutable:process.env.MIND_TEST_PYTHON,testing:{afterRestore:async()=>process.exit(74)}});';
 await assert.rejects(run(process.execPath,['--input-type=module','-e',script],{env:{...process.env,MIND_TEST_ROOT:f.root,MIND_TEST_PYTHON:f.options.pythonExecutable}}),error=>error.code===74);
 assert.equal((await recoverUpdateTransaction(f.root,{pythonExecutable:f.options.pythonExecutable})).status,'recuperada');assert.deepEqual(await hashes(f.base),before);
 assert.equal((await readManifestFile(f.root)).packageRevision,0);await assertClean(f.root);
});

test('copia previa alterada se conserva y no se usa para sobrescribir datos',async t=>{
 const f=await fixture(t);await changeBaseFormat(f.source,BASE_FORMAT_VERSION+1);
 await crashAssisted(f,'await fs.writeFile(path.join(context.baseDirectory,"continuidad.md"),"migración parcial");process.exit(74);');
 const journal=JSON.parse(await fs.readFile(path.join(f.root,'Sistema/Actualizaciones/transaccion.json'),'utf8'));
 await fs.writeFile(path.join(f.root,journal.baseSnapshot.path,'continuidad.md'),'copia alterada');
 await assert.rejects(recoverUpdateTransaction(f.root,{pythonExecutable:f.options.pythonExecutable}),{code:'UPDATE_BASE_SNAPSHOT_ALTERED'});
 assert.equal(await fs.readFile(path.join(f.base,'continuidad.md'),'utf8'),'migración parcial');
 assert.equal(JSON.parse(await fs.readFile(path.join(f.root,'Sistema/Actualizaciones/transaccion.json'),'utf8')).baseSnapshot.ready,true);
});

test('sin espacio para la copia previa no sustituye programa ni Base',async t=>{
 const f=await fixture(t),before=await hashes(f.base);
 await assert.rejects(updateMind({...f.options,assistedVerification:true,testing:{snapshotStatfs:async()=>({bavail:0,bsize:4096})}}),{code:'UPDATE_DISK_SPACE'});
 assert.equal((await readManifestFile(f.root)).packageRevision,0);assert.deepEqual(await hashes(f.base),before);await assertClean(f.root);
});


test('corte copiando la Base antes de completar snapshot no altera originales',async t=>{
 const f=await fixture(t),before=await hashes(f.base);
 await crashAssisted(f,'','{afterSnapshot:async()=>process.exit(74)}');
 const journal=JSON.parse(await fs.readFile(path.join(f.root,'Sistema/Actualizaciones/transaccion.json'),'utf8'));assert.equal(journal.baseSnapshot.ready,false);
 assert.equal((await recoverUpdateTransaction(f.root,{pythonExecutable:f.options.pythonExecutable})).status,'recuperada');assert.deepEqual(await hashes(f.base),before);assert.equal((await readManifestFile(f.root)).packageRevision,0);await assertClean(f.root);
});

test('segundo corte deshaciendo programa continúa sin repetir operaciones inversas confirmadas',async t=>{
 const f=await fixture(t),before=await hashes(f.base);await changeBaseFormat(f.source,BASE_FORMAT_VERSION+1);
 await crashAssisted(f,'await fs.writeFile(path.join(context.baseDirectory,"continuidad.md"),"migración parcial");process.exit(74);');
 const module=new URL('../src/update-transaction.js',import.meta.url).href;
 const script='import {recoverUpdateTransaction} from '+JSON.stringify(module)+';await recoverUpdateTransaction(process.env.MIND_TEST_ROOT,{pythonExecutable:process.env.MIND_TEST_PYTHON,testing:{afterRollback:async()=>process.exit(74)}});';
 await assert.rejects(run(process.execPath,['--input-type=module','-e',script],{env:{...process.env,MIND_TEST_ROOT:f.root,MIND_TEST_PYTHON:f.options.pythonExecutable}}),error=>error.code===74);
 assert.equal((await recoverUpdateTransaction(f.root,{pythonExecutable:f.options.pythonExecutable})).status,'recuperada');assert.deepEqual(await hashes(f.base),before);assert.equal((await readManifestFile(f.root)).packageRevision,0);await assertClean(f.root);
});
