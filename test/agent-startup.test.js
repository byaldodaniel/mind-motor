import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {promisify} from 'node:util';
import {execFile} from 'node:child_process';
import {prepareAgentStartup} from '../src/agent-startup.js';
import {agentFixture,motorDirectory} from './helpers/agent-fixture.js';
const run=promisify(execFile);
async function fixture(t){
 const f=await agentFixture(t,{prefix:'.mind-startup-test-'});
 const home=path.join(f.root,'Perfil ficticio');
 for(const name of ['.codex','.claude','.gemini'])await fs.mkdir(path.join(home,name),{recursive:true});
 const runtime={nodeExecutable:path.join(f.mind,'Runtime','node','node incluido')};
 return {...f,home,runtime,options:{root:f.mind,runtime,home,env:{}}};
}
test('primer arranque prepara los tres clientes, conserva reglas personales y es idempotente',async t=>{
 const f=await fixture(t);
 const file=path.join(f.home,'.gemini','GEMINI.md');await fs.writeFile(file,'Preferencia ficticia: español.\n');
 const first=await prepareAgentStartup(f.options);assert.equal(first.estado,'preparado');assert.equal(first.clientes.length,3);
 const text=await fs.readFile(file,'utf8');assert.ok(text.startsWith('Preferencia ficticia: español.\n'));assert.match(text,/destinos_consultar/);assert.match(text,/inicio/);
 const second=await prepareAgentStartup(f.options);assert.ok(second.clientes.every(x=>x.estado==='vigente'));
 assert.equal(await fs.readFile(file,'utf8'),text);
});
test('Codex recibe el bloque en override activo y respeta CODEX_HOME',async t=>{
 const f=await fixture(t);const custom=path.join(f.root,'Codex alternativo');await fs.mkdir(custom);
 const normal=path.join(custom,'AGENTS.md'), override=path.join(custom,'AGENTS.override.md');
 await fs.writeFile(normal,'No cambiar.');await fs.writeFile(override,'Regla ficticia activa.\n');
 const result=await prepareAgentStartup({...f.options,env:{CODEX_HOME:custom}});
 assert.equal(result.clientes.find(x=>x.cliente==='Codex').archivo,override);
 assert.equal(await fs.readFile(normal,'utf8'),'No cambiar.');
 assert.ok((await fs.readFile(override,'utf8')).startsWith('Regla ficticia activa.'));
 await assert.rejects(fs.stat(path.join(f.home,'.codex','AGENTS.md')),{code:'ENOENT'});
});
test('tras mover Mind actualiza solo su bloque y preserva reglas anteriores y posteriores',async t=>{
 const f=await fixture(t);await prepareAgentStartup(f.options);const file=path.join(f.home,'.claude','CLAUDE.md');
 await fs.appendFile(file,'\nOtra regla ficticia posterior.\n');
 const moved=path.join(f.root,'Mind movido');await prepareAgentStartup({...f.options,root:moved});
 const text=await fs.readFile(file,'utf8');assert.ok(text.includes(JSON.stringify(moved)));assert.ok(!text.includes(JSON.stringify(f.mind)));
 assert.ok(text.endsWith('Otra regla ficticia posterior.\n'));assert.equal(text.split('mind-startup:begin').length,2);
});
test('bloques ambiguos y enlaces no se sobrescriben; informa el cliente pendiente',async t=>{
 const f=await fixture(t);
 const file=path.join(f.home,'.codex','AGENTS.md');const broken='Regla ficticia\n<!-- mind-startup:begin -->\nsin cierre';await fs.writeFile(file,broken);
 const original=path.join(f.root,'original.md');await fs.writeFile(original,'No tocar.');
 const linked=path.join(f.home,'.claude','CLAUDE.md');await fs.link(original,linked);
 const result=await prepareAgentStartup(f.options);assert.equal(result.estado,'parcial');assert.equal(result.clientes.filter(x=>x.estado==='pendiente').length,2);
 assert.equal(await fs.readFile(file,'utf8'),broken);assert.equal(await fs.readFile(original,'utf8'),'No tocar.');
});
test('automatizaciones pueden omitir integración y no se crean perfiles de clientes ausentes',async t=>{
 const f=await fixture(t);
 assert.equal((await prepareAgentStartup({...f.options,env:{MIND_AGENT_STARTUP:'0'}})).estado,'omitido');
 await assert.rejects(fs.stat(path.join(f.home,'.codex','AGENTS.md')),{code:'ENOENT'});
 const empty=path.join(f.root,'Sin agentes');await fs.mkdir(empty);
 assert.equal((await prepareAgentStartup({...f.options,home:empty})).estado,'sin_clientes');assert.deepEqual(await fs.readdir(empty),[]);
});
test('CLI inicio desde otro proyecto devuelve instrucciones y destino sin JSON ni configuración manual',async t=>{
 const f=await fixture(t);
 await fs.mkdir(path.join(f.mind,'Motor'));
 for(const folder of ['src','bin'])await fs.cp(path.join(motorDirectory,folder),path.join(f.mind,'Motor',folder),{recursive:true});
 await fs.copyFile(path.join(motorDirectory,'package.json'),path.join(f.mind,'Motor','package.json'));
 await fs.writeFile(path.join(f.mind,'mind-producto.json'),JSON.stringify({format:'mind-product',version:1,mindVersion:'1.0.3'}));
 const result=await run(process.execPath,[path.join(f.mind,'Motor','bin','mind.js'),'inicio'],{cwd:f.folder,env:{...process.env,MIND_UPDATE_RESTART:'1',MIND_AGENT_STARTUP:'1',MIND_PYTHON:process.platform==='win32'?'python':'python3',CODEX_HOME:path.join(f.home,'.codex'),HOME:f.home,USERPROFILE:f.home}});
 const value=JSON.parse(result.stdout);assert.equal(value.mind,'1.0.3');assert.match(value.instrucciones,/destinos_consultar/);
 assert.equal(value.destinos.predeterminado,path.join(f.mind,'Conversaciones'));
 assert.ok((await fs.stat(value.destinos.predeterminado)).isDirectory());
 for(const relative of ['.codex/AGENTS.md','.claude/CLAUDE.md','.gemini/GEMINI.md'])assert.match(await fs.readFile(path.join(f.home,relative),'utf8'),/mind-startup:begin/);
});
