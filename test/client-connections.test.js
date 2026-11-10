import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { updateManagedClientConnections } from '../src/client-connections.js';
import { prepareAgentStartup } from '../src/agent-startup.js';
import { productPaths, productRuntime } from '../src/layout.js';

async function fixture(t) {
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'mind-client-connections-'));
 t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const root=path.join(directory,'My Mind'),home=path.join(directory,'Perfil ficticio');
 await fs.mkdir(root);await fs.mkdir(path.join(home,'.codex'),{recursive:true});
 const manifest={layoutVersion:2,packageRevision:1,updateProtocolVersion:2};
 const runtime=productRuntime(root,manifest),paths=productPaths(root,manifest),legacy=productRuntime(root,null);
 const codex=path.join(home,'.codex','config.toml');
 const oldEntry=path.join(root,'Motor','bin','mind.js');
 const options={root,runtime,manifest,home,env:{}};
 return {directory,root,home,manifest,runtime,paths,legacy,codex,oldEntry,options};
}
const basic = f => `[mcp_servers.mind]\ncommand = ${JSON.stringify(f.legacy.nodeExecutable)}\nargs = [${JSON.stringify(f.oldEntry)}, "mcp"]\n`;

 test('Codex TOML CRLF literal y args multilinea: solo rutas propias cambian, opciones y comentarios quedan',async t=>{
 const f=await fixture(t),from=path.join(f.root,'Base'),to=path.join(f.root,'Sistema','Base');
 const text=['# regla ficticia','[mcp_servers.other]','command = "no-cambiar"','[mcp_servers.mind]',
  `command = '${f.legacy.nodeExecutable}' # comentario`, 'args = [', `  '${f.oldEntry}', # entrada`, "  'mcp',", "  '--base',", `  '${from}',`, "  '--carpeta',", "  'externa',", ']','enabled = false','startup_timeout_sec = 19','[mcp_servers.mind.env]','TOKEN = "secreto-ficticio"','[otra.seccion]','valor = 23',''].join('\r\n');
 await fs.writeFile(f.codex,text);
 const results=await updateManagedClientConnections({...f.options,baseMigration:{from,to}});
 assert.equal(results[0].estado,'actualizada');
 const next=await fs.readFile(f.codex,'utf8');
 assert.ok(next.includes(`command = ${JSON.stringify(f.runtime.nodeExecutable)} # comentario`));
 assert.ok(next.includes(`${JSON.stringify(f.paths.agentEntrypoint)}, # entrada`));
 assert.ok(next.includes(JSON.stringify(to)));assert.ok(next.includes("  'mcp',\r\n  '--base',"));
 assert.ok(next.endsWith('[otra.seccion]\r\nvalor = 23\r\n'));
 assert.ok(next.includes('enabled = false\r\nstartup_timeout_sec = 19\r\n[mcp_servers.mind.env]\r\nTOKEN = "secreto-ficticio"'));
 assert.ok(!JSON.stringify(results).includes('secreto-ficticio'));
 });

 test('Codex actual con enabled false es vigente e idempotente',async t=>{
 const f=await fixture(t),text=`[mcp_servers.mind]\ncommand = ${JSON.stringify(f.runtime.nodeExecutable)}\nargs = [${JSON.stringify(f.paths.agentEntrypoint)}, "mcp", "--base", "externa"]\nenabled = false\n`;
 await fs.writeFile(f.codex,text);
 const results=await updateManagedClientConnections(f.options);assert.equal(results[0].estado,'vigente');
 assert.equal(await fs.readFile(f.codex,'utf8'),text);
 });

 test('omision explicita no lee ni cambia perfiles',async t=>{
 const f=await fixture(t);await fs.writeFile(f.codex,basic(f));
 assert.deepEqual(await updateManagedClientConnections({...f.options,env:{MIND_AGENT_STARTUP:'0'}}),[]);
 assert.equal(await fs.readFile(f.codex,'utf8'),basic(f));
 });

 test('CODEX_HOME alternativo conserva config por defecto',async t=>{
 const f=await fixture(t),custom=path.join(f.directory,'Codex alternativo');await fs.mkdir(custom);
 await fs.writeFile(f.codex,basic(f));const file=path.join(custom,'config.toml');await fs.writeFile(file,basic(f));
 const results=await updateManagedClientConnections({...f.options,env:{CODEX_HOME:custom}});
 assert.equal(results[0].archivo,file);assert.equal(results[0].estado,'actualizada');
 assert.equal(await fs.readFile(f.codex,'utf8'),basic(f));
 });

 test('no crea servidores ausentes ni cambia otras instalaciones o ejecutables personalizados',async t=>{
 for(const mode of ['ausente','otro-root','comando-custom','args-custom']){
  const f=await fixture(t);let text=basic(f);
  if(mode==='ausente')text='[mcp_servers.other]\ncommand = "otro"\n';
  if(mode==='otro-root')text=text.replace(JSON.stringify(f.oldEntry),JSON.stringify(path.join(f.directory,'Otra Mind','Motor','bin','mind.js')));
  if(mode==='comando-custom')text=text.replace(JSON.stringify(f.legacy.nodeExecutable),'"node-personalizado"');
  if(mode==='args-custom')text=text.replace('args = [','args = ["--opcion-personalizada", ');
  await fs.writeFile(f.codex,text);const results=await updateManagedClientConnections(f.options);
  assert.notEqual(results[0].estado,'actualizada',mode);assert.equal(await fs.readFile(f.codex,'utf8'),text,mode);
 }
 });

 test('JSON conocidos actualizan solo command/args y preservan texto, env y servidores ajenos',async t=>{
 const f=await fixture(t),files=[['Claude Code','.claude.json'],['Gemini CLI','.gemini/settings.json'],['Antigravity','.gemini/antigravity/mcp_config.json']];
 const text='{\n "mcpServers": {\n "mind": { "command": '+JSON.stringify(f.legacy.nodeExecutable)+', "args": ['+JSON.stringify(f.oldEntry)+', "mcp", "--base", "externa"], "env": { "TOKEN": "secreto-ficticio-json" }, "disabled": true },\n "other": { "command": "otro", "env": {"KEEP": "igual"} }\n }, "personal": 42\n}\n';
 for(const [,relative]of files){const file=path.join(f.home,relative);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,text);}
 const results=await updateManagedClientConnections(f.options);
 for(const [client,relative]of files){assert.equal(results.find(x=>x.cliente===client).estado,'actualizada');
  const expected=text.replace(JSON.stringify(f.legacy.nodeExecutable),JSON.stringify(f.runtime.nodeExecutable)).replace(JSON.stringify(f.oldEntry),JSON.stringify(f.paths.agentEntrypoint));
  assert.equal(await fs.readFile(path.join(f.home,relative),'utf8'),expected);
 }
 assert.ok(!JSON.stringify(results).includes('secreto-ficticio-json'));
 });

 test('base predeterminada solo migra con señal verificada; bases externas no cambian',async t=>{
 for(const mode of ['sin-senal','externa','predeterminada','senal-ajena']){
  const f=await fixture(t),from=path.join(f.root,'Base'),to=path.join(f.root,'Sistema','Base'),external=path.join(f.directory,'Base externa');
  const base=mode==='externa'?external:from;
  const text=basic(f).replace(', "mcp"]',`, "mcp", "--base", ${JSON.stringify(base)}]`);await fs.writeFile(f.codex,text);
  const env=mode==='sin-senal'?{}:{MIND_BASE_MIGRATED_FROM:mode==='senal-ajena'?external:from,MIND_BASE_MIGRATED_TO:to};
  await updateManagedClientConnections({...f.options,env});
  const next=await fs.readFile(f.codex,'utf8');assert.ok(next.includes(JSON.stringify(mode==='predeterminada'?to:base)),mode);
 }
 });

 test('base igual en forma --base= conserva la opcion y migra solo valor propio',async t=>{
 const f=await fixture(t),from=path.join(f.root,'Base'),to=path.join(f.root,'Sistema','Base');
 await fs.writeFile(f.codex,basic(f).replace(', "mcp"]',`, "mcp", ${JSON.stringify('--base='+from)}]`));
 await updateManagedClientConnections({...f.options,baseMigration:{from,to}});
 assert.ok((await fs.readFile(f.codex,'utf8')).includes(JSON.stringify('--base='+to)));
 });

 test('configuracion enlazada o ambigua se conserva sin imprimir contenido',async t=>{
 for(const mode of ['hardlink','toml-duplicado','json-duplicado']){
  const f=await fixture(t);let file=f.codex,text=basic(f);
  if(mode==='hardlink'){const original=path.join(f.directory,'original.toml');await fs.writeFile(original,text);await fs.link(original,file);}
  else if(mode==='toml-duplicado'){text+=basic(f);await fs.writeFile(file,text);}
  else {file=path.join(f.home,'.claude.json');text='{"mcpServers":{"mind":{"command":"secreto-ficticio","command":"otro","args":["mcp"]}}}';await fs.writeFile(file,text);}
  const results=await updateManagedClientConnections(f.options);assert.equal(results.find(x=>x.archivo===file).estado,'pendiente',mode);
  assert.equal(await fs.readFile(file,'utf8'),text);assert.ok(!JSON.stringify(results).includes('secreto-ficticio'));
 }
 });

 test('integracion preparar actualiza reglas y conexion existente del mismo root',async t=>{
 const f=await fixture(t);await fs.writeFile(f.codex,basic(f));
 const result=await prepareAgentStartup(f.options);assert.equal(result.estado,'preparado');
 assert.equal(result.conexiones[0].estado,'actualizada');
 assert.ok((await fs.readFile(f.codex,'utf8')).includes(JSON.stringify(f.paths.agentEntrypoint)));
 });
test('MIND_BASE predeterminada migra por token JSON y TOML preservando todos los otros env',async t=>{
 for(const kind of ['json','toml','toml-inline']){
  const f=await fixture(t),from=path.join(f.root,'Base'),to=path.join(f.root,'Sistema','Base');
  const file=kind==='json'?path.join(f.home,'.claude.json'):f.codex;
  let text;
  if(kind==='json')text=JSON.stringify({mcpServers:{mind:{command:f.legacy.nodeExecutable,args:[f.oldEntry,'mcp'],env:{MIND_BASE:from,TOKEN:'privado-ficticio',KEEP:'igual'}}},other:'igual'},null,2);
  else if(kind==='toml')text=basic(f)+'[mcp_servers.mind.env]\nMIND_BASE = '+JSON.stringify(from)+' # propia\nTOKEN = "privado-ficticio"\nKEEP = "igual"\n';
  else text=basic(f)+'env = { MIND_BASE = '+JSON.stringify(from)+', TOKEN = "privado-ficticio", KEEP = "igual" }\n';
  await fs.writeFile(file,text);
  const results=await updateManagedClientConnections({...f.options,baseMigration:{from,to}});
  assert.equal(results.find(x=>x.archivo===file).estado,'actualizada',kind);
  const expected=text.replace(JSON.stringify(f.legacy.nodeExecutable),JSON.stringify(f.runtime.nodeExecutable)).replace(JSON.stringify(f.oldEntry),JSON.stringify(f.paths.agentEntrypoint)).replace(JSON.stringify(from),JSON.stringify(to));
  assert.equal(await fs.readFile(file,'utf8'),expected,kind);
  assert.ok(!JSON.stringify(results).includes('privado-ficticio'));
 }
});

test('MIND_BASE externa queda intacta y tablas inline complejas se conservan como pendientes',async t=>{
 for(const kind of ['json','toml','inline-complex']){
  const f=await fixture(t),from=path.join(f.root,'Base'),to=path.join(f.root,'Sistema','Base'),external=path.join(f.directory,'Base externa');
  const file=kind==='json'?path.join(f.home,'.claude.json'):f.codex;
  let text;
  if(kind==='json')text=JSON.stringify({mcpServers:{mind:{command:f.legacy.nodeExecutable,args:[f.oldEntry,'mcp'],env:{MIND_BASE:external,TOKEN:'privado-ficticio'}}}});
  else if(kind==='toml')text=basic(f)+'[mcp_servers.mind.env]\nMIND_BASE = '+JSON.stringify(external)+'\nTOKEN = "privado-ficticio"\n';
  else text=basic(f)+'env = { MIND_BASE = '+JSON.stringify(from)+', CUSTOM = ["estructura", "ambigua"] }\n';
  await fs.writeFile(file,text);const results=await updateManagedClientConnections({...f.options,baseMigration:{from,to}});
  const next=await fs.readFile(file,'utf8');
  if(kind==='inline-complex'){assert.equal(results.find(x=>x.archivo===file).estado,'pendiente');assert.equal(next,text);}
  else {assert.equal(results.find(x=>x.archivo===file).estado,'actualizada');assert.ok(next.includes(JSON.stringify(external)));assert.ok(next.includes('privado-ficticio'));}
  assert.ok(!JSON.stringify(results).includes('privado-ficticio'));
 }
});

test('opciones globales antes de mcp se reconocen como en el parser CLI real',async t=>{
 for(const kind of ['json','toml']){
  const f=await fixture(t),from=path.join(f.root,'Base'),to=path.join(f.root,'Sistema','Base'),workspace=path.join(f.directory,'Proyecto');
  const args=[f.oldEntry,'--base',from,'--carpeta',workspace,'mcp'];
  const file=kind==='json'?path.join(f.home,'.claude.json'):f.codex;
  const text=kind==='json'?JSON.stringify({mcpServers:{mind:{command:f.legacy.nodeExecutable,args}}}):'[mcp_servers.mind]\ncommand = '+JSON.stringify(f.legacy.nodeExecutable)+'\nargs = '+JSON.stringify(args)+'\n';
  await fs.writeFile(file,text);const result=await updateManagedClientConnections({...f.options,baseMigration:{from,to}});
  assert.equal(result.find(x=>x.archivo===file).estado,'actualizada');
  const expected=text.replace(JSON.stringify(f.legacy.nodeExecutable),JSON.stringify(f.runtime.nodeExecutable)).replace(JSON.stringify(f.oldEntry),JSON.stringify(f.paths.agentEntrypoint)).replace(JSON.stringify(from),JSON.stringify(to));
  assert.equal(await fs.readFile(file,'utf8'),expected);
 }
});
