// Windows x64. Execute from the worktree with MIND_NATIVE_EXE and MIND_PYTHON.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { binary, connect, lab, python, run } from './etapa7-fixture.mjs';
import { r3Commit } from '../test/r3-fixture.mjs';

assert.equal(process.platform + '-' + process.arch,'win32-x64');
assert.ok(binary && python,'Indica MIND_NATIVE_EXE y MIND_PYTHON.');
const reportFile=fileURLToPath(new URL('../evidence/etapa7-windows-x64.json',import.meta.url));
const powershell=path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
const elapsed=async operation=>{
  const start=performance.now();
  const result=await operation();
  return [result,Math.round((performance.now()-start)*100)/100];
};
async function footprint(pid, serviceRoot=null) {
  assert.ok(Number.isSafeInteger(pid) && pid>0);
  const program=[
    '$Items=@(Get-CimInstance Win32_Process | Select-Object Name,ProcessId,ParentProcessId,CreationDate)',
    '$Owner=$Items | Where-Object ProcessId -eq '+pid,
    'if (-not $Owner) { throw "Motor ausente" }',
    '$Tree=@($Owner); $Depth=0',
    'do { $Count=$Tree.Count; $Seen=@($Tree.ProcessId); $Tree+=@($Items | Where-Object {$_.ParentProcessId -in $Seen -and $_.ProcessId -notin $Seen -and $_.CreationDate -ge $Owner.CreationDate}); $Depth++ } while ($Count -lt $Tree.Count -and $Depth -lt 12)',
    '$Tree | Where-Object Name -ne "conhost.exe" | ForEach-Object {$p=Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue; if($p){[pscustomobject]@{pid=$_.ProcessId;parent=$_.ParentProcessId;exe=$_.Name;rss=$p.WorkingSet64}}} | ConvertTo-Json -Compress',
  ].join('\n');
  const response=await run(powershell,['-NoProfile','-NonInteractive','-Command',program],{windowsHide:true,timeout:12000});
  const tree=[JSON.parse(response.stdout)].flat();
  const roots=new Set(serviceRoot?[serviceRoot]:[]);
  while (true) {
    const found=tree.filter(entry=>roots.has(entry.parent)&&!roots.has(entry.pid));
    if(!found.length)break;
    found.forEach(entry=>roots.add(entry.pid));
  }
  const service=tree.filter(item=>roots.has(item.pid)), mind=tree.filter(item=>!roots.has(item.pid));
  const pack=items=>({procesos:items.length,rssBytes:items.reduce((sum,item)=>sum+item.rss,0),ejecutables:items.map(item=>item.exe)});
  return {mind:pack(mind),servicioDePrueba:pack(service)};
}
function stats(samples) {
  const sorted=[...samples].sort((a,b)=>a-b);
  return {muestras:samples,p50:sorted[Math.floor(sorted.length/2)],p95:sorted[Math.ceil(sorted.length*0.95)-1]};
}
async function warm(operation, n) {
  const times=[];
  for(let i=0;i<n;i++)times.push((await elapsed(operation))[1]);
  return stats(times);
}

const cleanup=[];
try {
  const fixture=await lab({after:callback=>cleanup.push(callback)},{baselineZip:true});
  fixture.env.MIND_VISTA_INACTIVA_MS='5000';
  const oldConsole=()=>fixture.command(fixture.node,[path.join(fixture.motor,'bin','mind.js'),'estado','--base',fixture.base]);
  const newConsole=()=>fixture.command(fixture.installed,['producto','estado']);
  async function probe(start,consoleCall) {
    const [,msConsolaFria]=await elapsed(consoleCall);
    await fixture.stop();
    const [active,msArranqueHttp]=await elapsed(start);
    const pid=active.health.pid;
    const reposo=await footprint(pid);
    const [primary,msPrimeraSesion]=await elapsed(()=>connect(active));
    const catalog=await primary.list();
    const unaSesion=await footprint(pid);
    const second=await connect(active);
    const dosSesiones=await footprint(pid);
    const http=await warm(()=>primary.call('estado'),13);
    const consola=await warm(consoleCall,7);
    await second.close();
    await primary.close();
    return {pid,reposo,unaSesion,dosSesiones,tools:catalog.tools.length,catalogoRespuestaBytes:catalog.bytes,
      catalogoHerramientasBytes:Buffer.byteLength(JSON.stringify(catalog.tools)),
      msConsolaFria,msArranqueHttp,msPrimeraSesion,http,consola};
  }
  const r3=await probe(fixture.startOld,oldConsole);
  const migration=await fixture.migrate().finished;
  assert.equal(migration.code,0,migration.stderr);
  const cli=(...args)=>fixture.command(fixture.installed,['producto',...args]);
  const current=await probe(async()=>{await cli('despertar');return fixture.active();},newConsole);
  await fs.writeFile(path.join(fixture.project,'index.html'),'<h1>Vista ficticia de medición</h1>');
  const view=JSON.parse((await cli('vista','abrir','--proyecto','Órbita','--copia',fixture.project,
    '--contenido',fixture.project,'--mantener-abierta')).stdout);
  assert.equal((await fetch(view.url)).status,200);
  const withView=await footprint(current.pid);
  await cli('vista','cerrar','--id',view.id);
  assert.equal((await fetch(view.url)).status,404);
  await delay(400);
  const afterView=await footprint(current.pid);

  const app=path.join(fixture.project,'servicio-medicion.mjs');
  await fs.writeFile(app,[
    'import fs from "node:fs"; import http from "node:http"; import { DatabaseSync } from "node:sqlite";',
    'const env=process.env, db=new DatabaseSync(env.MIND_SQLITE); db.exec("CREATE TABLE IF NOT EXISTS datos (n)");',
    'const server=http.createServer((q,r)=>{r.setHeader("X-Mind-Listo",env.MIND_LISTO_TOKEN);r.end("ok");});',
    'server.listen(0,"127.0.0.1",()=>fs.writeFileSync(env.MIND_LISTO,JSON.stringify({puerto:server.address().port})));',
  ].join('\n'));
  const recipe=path.join(fixture.project,'receta-medicion.json');
  await fs.writeFile(recipe,JSON.stringify({programa:process.execPath,argumentos:[app],plazo_ms:12000}));
  const select=['--proyecto','Órbita','--copia',fixture.project,'--receta',recipe];
  const authorization=JSON.parse((await cli('vista','receta',...select)).stdout).autorizacion;
  const service=JSON.parse((await cli('servicio','abrir',...select,'--autorizar',authorization)).stdout).servida;
  const withService=await footprint(current.pid,service.pid);
  await cli('servicio','cerrar','--id',service.id);
  assert.equal(r3.tools,54);
  assert.equal(current.tools,13);
  for(const snapshot of [current.reposo,current.unaSesion,current.dosSesiones,withView,afterView,withService]){
    assert.deepEqual(snapshot.mind.ejecutables,['mind-native.exe']);
  }
  assert.equal(withService.servicioDePrueba.procesos,1);
  assert.ok(current.msConsolaFria<15000 && current.msArranqueHttp<15000,
    'El arranque nativo tardó demasiado en cerrar la salida de la consola.');
  const result={
    formato:1,plataforma:'win32-x64',fecha:new Date().toISOString(),r3Commit,versionNativa:'1.0.5',
    alcance:'Dos paquetes de laboratorio Windows x64. r3 usa el tag auténtico y runtimes locales, sin modelo E5. El servicio de medición es una aplicación ficticia ejecutada por separado con Node como cliente de SQLite.',
    r3:{...r3,zipBytes:fixture.oldZipBytes,vista:null,trasVista:null,sqlite:null},
    rust:{...current,zipBytes:(await fs.stat(fixture.zip)).size,vista:withView,trasVista:afterView,sqlite:withService},
    codex:{estado:'omitido',motivo:'El perfil ficticio carece de credenciales de modelo. Se midieron MCP y consola sin cuota.'},
  };
  await fs.writeFile(reportFile,JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result));
} finally {
  for(const fn of cleanup.reverse())await fn();
}
