import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {writeJson,readJson} from '../src/storage.js';
import {agentFixture} from './helpers/agent-fixture.js';
test('un bloqueo transitorio de Windows se resuelve sin publicar contenido parcial ni borrar el registro',async t=>{
 const f=await agentFixture(t);const target=path.join(f.mind,'registro.json');
 await writeJson(target,{value:'anterior'});let calls=0;
 await writeJson(target,{value:'vigente'},{platform:'win32',pause:async()=>{},renameFile:async(from,to)=>{
  assert.deepEqual((await readJson(target)).data,{value:'anterior'});
  if(++calls<3)throw Object.assign(new Error('Handle ocupado'),{code:'EPERM'});
  await fs.rename(from,to);
 }});
 assert.equal(calls,3);assert.deepEqual((await readJson(target)).data,{value:'vigente'});
 assert.deepEqual((await fs.readdir(f.mind)).filter(x=>x.endsWith('.tmp')),[]);
});
test('un rechazo persistente permanece acotado, conserva el registro anterior y limpia el temporal',async t=>{
 const f=await agentFixture(t);const target=path.join(f.mind,'registro.json');await writeJson(target,{value:'anterior'});let calls=0;
 await assert.rejects(writeJson(target,{value:'no publicar'},{platform:'win32',pause:async()=>{},renameFile:async()=>{calls++;throw Object.assign(new Error('Denegado'),{code:'EPERM'});}}),{code:'EPERM'});
 assert.equal(calls,5);assert.deepEqual((await readJson(target)).data,{value:'anterior'});
 assert.deepEqual((await fs.readdir(f.mind)).filter(x=>x.endsWith('.tmp')),[]);
});
test('otros fallos de publicación no se reintentan ni se ocultan',async t=>{
 const f=await agentFixture(t);const target=path.join(f.mind,'registro.json');let calls=0;
 await assert.rejects(writeJson(target,{value:'no publicar'},{platform:'win32',pause:async()=>{},renameFile:async()=>{calls++;throw Object.assign(new Error('Disco lleno'),{code:'ENOSPC'});}}),{code:'ENOSPC'});
 assert.equal(calls,1);assert.equal(await readJson(target),null);
});
