import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { buildNativePackage } from '../../scripts/construir-paquetes.mjs';
import { scanTree } from '../../src/product-files.js';
import { checkHealthyConnector } from '../../src/connector.js';
import { binary, connect, eventually, lab, python, readJson } from '../medicion/etapa7-fixture.mjs';

test('1.0.4-r3 → 1.0.5 con Ed25519, quietud, Base intacta y vuelta a r3', {
  skip: (!binary || !python) && 'Indica MIND_NATIVE_EXE y MIND_PYTHON',
  timeout: 200000,
}, async t => {
  const f = await lab(t);
  const originalManifest = await fs.readFile(f.manifestFile);
  const id = f.seeded.conversacion.id;
  const note = f.seeded.conversacion.archivo;
  const markdown = await fs.readFile(note);
  const base = await fs.readFile(path.join(f.base,'mind-base.json'));
  const permissionFiles = ['agent-continuity-access.json','folder-access-'+f.seeded.scope+'.json'];
  const readPermissions = () => Promise.all(permissionFiles.map(file=>fs.readFile(path.join(f.base,file))));
  const permissions = await readPermissions();
  const command = (...args) => f.command(binary,['actualizar-firmada',f.installation,f.base,...args]);
  const wrongFeed = path.join(f.root,'firma-falsa.json');
  await fs.writeFile(wrongFeed,JSON.stringify(f.envelope(f.feed,generateKeyPairSync('ed25519').privateKey)));
  await assert.rejects(command(wrongFeed,f.zip,'--confirmar'), /UPDATE_SIGNATURE_INVALID/u);
  await assert.rejects(command(f.feedFile,f.zip,'--no-confirmar'), /UPDATE_CONSENT_REQUIRED/u);
  const changedZip = path.join(f.root,'alterado.zip');
  await fs.copyFile(f.zip,changedZip);
  await fs.appendFile(changedZip,Buffer.from('alterado'));
  await assert.rejects(command(f.feedFile,changedZip,'--confirmar'), /UPDATE_PACKAGE_ALTERED/u);
  const target=process.platform+'-'+process.arch;
  const foreignDirectory=path.join(f.root,'Firma de otro emisor');
  const foreign=await buildNativePackage({output:foreignDirectory,targets:[target],binaries:{[target]:binary},
    channel:f.channel,privateKey:generateKeyPairSync('ed25519').privateKey,mtime:1704067200});
  const foreignZip=path.join(foreignDirectory,foreign.name);
  const foreignFeed=path.join(f.root,'descriptor-falso.json');
  await fs.writeFile(foreignFeed,JSON.stringify(f.envelope({...f.feed,
    packages:[{...f.feed.packages[0],sha256:foreign.sha256,bytes:(await fs.stat(foreignZip)).size}]})));
  await assert.rejects(command(foreignFeed,foreignZip,'--confirmar'), /UPDATE_SIGNATURE_INVALID/u);
  assert.deepEqual(await fs.readFile(f.manifestFile),originalManifest);
  await fs.stat(f.node);
  const previousId=(await readJson(f.reportFile)).id;

  const old = await f.startOld();
  assert.equal(old.health.motorVersion,'1.0.4');
  const oldClient = await connect(old);
  assert.equal((await oldClient.call('conversacion_leer',{id})).conversacion.id,id);
  let hold=true;
  const activity=(async()=>{while(hold) { await oldClient.call('estado'); await delay(220); }})();
  try {
    const migration=f.migrate();
    await eventually(async()=>{
      const state=await readJson(f.reportFile);
      if (state.id===previousId) return false;
      if (state.phase==='fallida') assert.fail(JSON.stringify(state.error));
      if (migration.child.exitCode !== null) assert.fail((await migration.finished).stderr);
      return state.phase==='espera-quietud';
    });
    assert.equal((await checkHealthyConnector(f.base)).health.pid,old.health.pid);
    assert.deepEqual(await fs.readFile(f.manifestFile),originalManifest);
    hold=false;
    await activity;
    await oldClient.close();
    const result=await migration.finished;
    assert.equal(result.code,0,result.stderr);
    const report=JSON.parse(result.stdout);
    assert.equal(report.phase,'completada');
    assert.equal(report.verification.runtime,'rust');
    assert.equal(report.verification.baseId,JSON.parse(base).baseId);
  } finally {
    hold=false;
    await activity.catch(()=>{});
  }

  const installed=await readJson(f.manifestFile);
  assert.equal(installed.mindVersion,'1.0.5');
  assert.equal(installed.runtime,'rust');
  await assert.rejects(fs.stat(f.node),{code:'ENOENT'});
  const entries=await scanTree(f.installation);
  assert.ok(entries.every(entry=>!/(?:^|\/)(?:Node|Python|Semantica|arranque\.cjs)(?:\/|$)|\.onnx$/iu.test(entry.path)));
  assert.deepEqual(await fs.readFile(path.join(f.base,'mind-base.json')),base);
  assert.deepEqual(await readPermissions(),permissions);
  assert.deepEqual(await fs.readFile(note),markdown);
  const cli=(...args)=>f.command(f.installed,['producto',...args]);
  if(process.platform==='win32'){
    const launcher=path.join(f.system,'mind.cmd');
    const response=await f.command(f.env.ComSpec||'cmd.exe',['/d','/c','call',launcher,'version']);
    assert.equal(JSON.parse(response.stdout).mind,'1.0.5');
  }
  const startup = performance.now();
  const awakened = await f.command(f.installed,['producto','despertar'],{timeout:15000});
  assert.equal(JSON.parse(awakened.stdout).estado,'listo');
  assert.ok(performance.now()-startup < 15000,'El Motor retuvo abierta la salida de la consola.');
  const native=await f.active();
  assert.equal(native.health.backend,'rust');
  assert.equal(native.health.packageRevision,1);
  assert.notEqual(native.health.pid,old.health.pid);
  if(process.platform==='win32'){
    const ps=path.join(f.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
    const children=await f.command(ps,['-NoProfile','-NonInteractive','-Command',
      'Get-CimInstance Win32_Process -Filter "ParentProcessId = '+native.health.pid+
      '" | Where-Object Name -ne "conhost.exe" | Select-Object -ExpandProperty Name']);
    assert.equal(children.stdout.trim(),'');
  }
  const client=await connect(native);
  assert.equal((await client.list()).tools.length,13);
  assert.equal((await client.call('retomar',{id})).conversacion.id,id);
  assert.equal((await client.call('buscar',{en:'conversaciones',consultas:['alternativa ficticia','brujula']})).conversaciones[0].id,id);
  const missed=await client.call('buscar',{en:'conversaciones',consulta:'inexistente en el proyecto orbital'});
  assert.equal(missed.total,0);
  assert.ok(missed.recientes.some(note=>note.id===id));
  const read=(operacion,argumentos={})=>client.call('mind',{operacion,argumentos});
  assert.equal((await read('destinos_consultar')).general.carpeta,f.project);
  const properties=await read('propiedades',{carpeta:f.seeded.scope,ruta:'resultado.txt'});
  assert.equal(properties.propiedades.etiqueta,'laboratorio');
  const record=await client.call('conversacion_leer',{id});
  assert.ok((record.resultados??record.conversacion.resultados).some(result=>JSON.stringify(result).includes('resultado.txt')));
  const text=await client.call('leer',{carpeta:f.seeded.scope,ruta:'resultado.txt'});
  assert.match(text.contenido,/Resultado ficticio/u);

  await fs.writeFile(path.join(f.project,'index.html'),'<h1>Vista ficticia</h1>');
  const view=JSON.parse((await cli('vista','abrir','--proyecto','Órbita','--copia',f.project,'--contenido',f.project)).stdout);
  assert.equal(view.inactividad_ms,1200);
  assert.equal((await fetch(view.url)).status,200);
  await delay(view.inactividad_ms+500);
  assert.equal((await fetch(view.url)).status,404);
  await client.close();

  const profile=path.join(f.home,'.codex','config.toml');
  await fs.writeFile(profile,'# configuración ficticia\n[mcp_servers.otro]\nurl = "https://ejemplo.invalid/mcp"\n');
  const settings=JSON.parse((await f.command(f.installed,['producto','preparar'],
    {env:{...f.env,MIND_AGENT_STARTUP:'1'}})).stdout);
  assert.ok(settings.conexiones.some(item=>item.cliente==='Codex'&&item.estado==='actualizada'));
  const toml=await fs.readFile(profile,'utf8');
  assert.match(toml,/\[mcp_servers\.otro\]/u);
  assert.match(toml,/\[mcp_servers\.mind\]/u);
  await f.stop();

  const restored=JSON.parse((await f.command(binary,['actualizar-recuperar',f.installation,'--confirmar'])).stdout);
  assert.equal(restored.result.status,'revertida');
  assert.deepEqual(await fs.readFile(f.manifestFile),originalManifest);
  assert.deepEqual(await readPermissions(),permissions);
  assert.deepEqual(await fs.readFile(note),markdown);
  const legacy=await f.startOld();
  const legacyClient=await connect(legacy);
  assert.equal((await legacyClient.call('conversacion_leer',{id})).conversacion.id,id);
  await legacyClient.close();
  t.diagnostic('Firma ajena, ZIP alterado y petición sin confirmación rechazados. Base y Markdown conservados entre los dos motores.');
});
