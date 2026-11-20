import {RUNS} from './runs.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const exe=process.env.MIND_NATIVE_EXE;if(!exe)throw new Error('MIND_NATIVE_EXE');
function client(){
 const p=spawn(exe,['scan'],{cwd:root,stdio:['pipe','pipe','pipe'],windowsHide:true});let buf='',seq=0;const waiting=new Map();let err='';
 p.stderr.on('data',c=>err+=c);p.stdout.setEncoding('utf8');p.stdout.on('data',c=>{buf+=c;let n;while((n=buf.indexOf('\n'))>=0){const l=buf.slice(0,n);buf=buf.slice(n+1);if(l.trim()){const m=JSON.parse(l);waiting.get(String(m.id))?.(m);waiting.delete(String(m.id));}}});
 return {async call(args){const id=++seq;return new Promise((res,rej)=>{const t=setTimeout(()=>rej(new Error('scan timeout '+err)),10000);waiting.set(String(id),m=>{clearTimeout(t);res(m)});p.stdin.write(JSON.stringify({id,...args})+'\n');});},async close(){p.stdin.end();await new Promise(r=>p.once('exit',r));}};
}
test('scanner descriptor-relative contract and no traversal',{timeout:30000},async t=>{
 const fixture=await fs.mkdtemp(path.join(RUNS,'scan-'));const dir=path.join(fixture,'root'),out=path.join(fixture,'outside');
 await fs.mkdir(dir);await fs.mkdir(out);await fs.mkdir(path.join(dir,'sub'));await fs.writeFile(path.join(dir,'日本語 José.txt'),'12345');await fs.writeFile(path.join(out,'SECRET.txt'),'never enumerate outside');
 await fs.symlink(out,path.join(dir,'jump'),'junction');
 const c=client();t.after(async()=>{await c.close();assert.ok(fixture.startsWith(RUNS));await fs.rm(fixture,{recursive:true,force:true});});
 const a=await c.call({root:dir,maxEntries:100});assert.equal(a.error,undefined,JSON.stringify(a));assert.equal(a.complete,true);assert.ok(a.entries.some(e=>e.name==='日本語 José.txt'));assert.ok(a.entries.some(e=>e.name==='sub'));assert.ok(!a.entries.some(e=>e.name==='SECRET.txt'));assert.ok(!a.entries.some(e=>e.name==='.'||e.name==='..'));assert.ok(a.entries.every(e=>!e.name.includes('/')));
 for(const relative of ['jump','jump/x','../outside','/outside','sub/../jump']){
  const b=await c.call({root:dir,relative});assert.ok(b.error,'must refuse '+relative+': '+JSON.stringify(b));
 }
 const symlinkRoot=await c.call({root:path.join(dir,'jump')});assert.ok(symlinkRoot.error,'must refuse junction root');
 const missing=await c.call({root:path.join(fixture,'missing')});assert.ok(missing.error);
 const partial=await c.call({root:dir,maxEntries:1});assert.ok(partial.entries.length<=1);assert.equal(partial.complete,false);
 const empty=await c.call({root:dir,relative:'sub'});assert.equal(empty.complete,true);assert.deepEqual(empty.entries,[]);
 const pivot=path.join(dir,'pivot'),parked=path.join(dir,'parked'),link=path.join(dir,'link-parked');
 await fs.mkdir(pivot);await fs.writeFile(path.join(pivot,'SAFE.txt'),'safe');await fs.symlink(out,link,'junction');
 let swapping=true,turns=0;
 const swap=(async()=>{while(swapping){try{await fs.rename(pivot,parked);await fs.rename(link,pivot);await new Promise(r=>setTimeout(r,1));await fs.rename(pivot,link);await fs.rename(parked,pivot);turns++;}catch{await new Promise(r=>setTimeout(r,1));}}})();
 try{for(let i=0;i<100;i++){const result=await c.call({root:dir,relative:'pivot'});assert.ok(!(result.entries??[]).some(e=>e.name==='SECRET.txt'),'race escaped root');}}
 finally{swapping=false;await swap;}
 assert.ok(turns>0,'race fixture must actually swap');
 const again=await c.call({root:dir});assert.equal(again.complete,true,'errors must not poison persistent scanner');
});
