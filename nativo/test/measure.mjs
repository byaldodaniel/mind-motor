import {RUNS} from './runs.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {performance} from 'node:perf_hooks';
import {fileURLToPath} from 'node:url';
import os from 'node:os';
import {baseIdOf,healthProof} from '../../src/connector.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const [label,exe]=process.argv.slice(2);if(!exe||!label)throw new Error('measure label exe');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const stat=a=>{const b=[...a].sort((x,y)=>x-y);const q=p=>b[Math.ceil(p*b.length)-1];return {n:a.length,min:b[0],p50:q(.5),p95:q(.95),p99:q(.99),max:b.at(-1)}};
const fixture=await fs.mkdtemp(path.join(RUNS,'measure-'+label+'-'));const base=path.join(fixture,'Base');await fs.mkdir(base);const directory=path.join(fixture,'scan');await fs.mkdir(directory);
await Promise.all(Array.from({length:256},(_,i)=>fs.writeFile(path.join(directory,'entry-'+String(i).padStart(4,'0')+'.txt'),'fixture')));
const token='c'.repeat(64),baseId=baseIdOf(base);let sessions=0;
const server=http.createServer((req,res)=>{const u=new URL(req.url,'http://127.0.0.1');const port=server.address().port;
 if(u.pathname==='/health'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,baseId,port,proof:healthProof(token,u.searchParams.get('nonce'),baseId,port)}));return;}
 if(req.headers.authorization!=='Bearer '+token){res.writeHead(401);res.end();return;}
 if(req.method==='GET'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(': connected\n\n');return;}
 if(req.method==='DELETE'){res.end('{}');return;}
 let b='';req.on('data',c=>b+=c);req.on('end',()=>{const m=JSON.parse(b);if(m.method==='initialize'){res.setHeader('Mcp-Session-Id','bench-'+(++sessions));}if(m.id===undefined){res.writeHead(202);res.end();return;}
 const result=m.method==='initialize'?{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'bench',version:'1'}}:m.method==='tools/list'?{tools:[{name:'buscar',annotations:{readOnlyHint:true}}]}:{content:[{type:'text',text:'ok'}],structuredContent:{ok:true}};
 res.setHeader('Content-Type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));});
});await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;
await fs.writeFile(path.join(base,'conector.json'),JSON.stringify({version:1,baseId,port,pid:process.pid}));await fs.writeFile(path.join(base,'conector-secreto.json'),JSON.stringify({version:1,token}));
function client(mode){const args=mode==='bridge'?['bridge','--base',base,'--cwd',directory,'--paths','[]','--launch-command',process.execPath,'--launch-arg',path.join(root,'test/benchmark-refuse.mjs')]:['scan'];const p=spawn(exe,args,{cwd:root,stdio:['pipe','pipe','pipe'],windowsHide:true,env:{...process.env,TEMP:RUNS,TMP:RUNS}});
 let seq=0,buffer='',stderr='';const pending=new Map();p.stderr.on('data',c=>stderr+=c);p.stdin.on('error',()=>{});p.stdout.setEncoding('utf8');p.stdout.on('data',c=>{buffer+=c;let n;while((n=buffer.indexOf('\n'))>=0){const l=buffer.slice(0,n);buffer=buffer.slice(n+1);if(!l.trim())continue;const m=JSON.parse(l);if(m.id===undefined)continue;pending.get(String(m.id))?.(m);pending.delete(String(m.id));}});
 const send=m=>p.stdin.write(JSON.stringify(m)+'\n');
 return {p,send,async request(body){const id=++seq;const start=performance.now();const m=await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(new Error('timeout '+stderr)),15000);pending.set(String(id),m=>{clearTimeout(t);resolve(m)});send({...(mode==='bridge'?{jsonrpc:'2.0'}:{}),id,...body});});if(m.error||m.result?.isError)throw new Error(JSON.stringify(m));return {ms:performance.now()-start,m};},async initialize(){await this.request({method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'bench',version:'1'}}});send({jsonrpc:'2.0',method:'notifications/initialized'});},async close(){p.stdin.end();await Promise.race([new Promise(r=>p.once('exit',r)),wait(3000).then(()=>p.kill())]);}};
}
const run=promisify(execFile);
async function memory(pid){const ps="$p=Get-Process -Id "+pid+" -ErrorAction Stop; [pscustomobject]@{privateBytes=$p.PrivateMemorySize64;rssBytes=$p.WorkingSet64;cpuMs=$p.TotalProcessorTime.TotalMilliseconds;threads=$p.Threads.Count;handles=$p.HandleCount}|ConvertTo-Json -Compress";return JSON.parse((await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',ps],{windowsHide:true})).stdout);}
async function idle(c){await wait(1200);const samples=[];for(let i=0;i<5;i++){samples.push(await memory(c.p.pid));await wait(150);}return {samples,privateBytes:stat(samples.map(x=>x.privateBytes)),rssBytes:stat(samples.map(x=>x.rssBytes)),cpuDeltaMs:samples.at(-1).cpuMs-samples[0].cpuMs};}
const raw={label,exe,time:new Date().toISOString(),host:{platform:process.platform,arch:process.arch,cpus:os.cpus().length,cpu:os.cpus()[0]?.model,totalMemory:os.totalmem(),node:process.version},notes:['Sequential loopback fake motor; no filesystem IO inside echo tool','Memory Get-Process private=PrivateMemorySize64 RSS=WorkingSet64; warm idle sample','Windows measurements only; no Mac/Linux runtime inference'],bridge:{coldMs:[],warmMs:[]},scan:{coldMs:[],warmMs:[]}};
try{
 for(let i=0;i<15;i++){const t=performance.now(),c=client('bridge');await c.initialize();await c.request({method:'tools/call',params:{name:'buscar',arguments:{}}});raw.bridge.coldMs.push(performance.now()-t);await c.close();}
 const b=client('bridge');await b.initialize();for(let i=0;i<20;i++)await b.request({method:'tools/call',params:{name:'buscar',arguments:{}}});raw.bridge.idle=await idle(b);
 for(let r=0;r<3;r++)for(let i=0;i<200;i++)raw.bridge.warmMs.push((await b.request({method:'tools/call',params:{name:'buscar',arguments:{consulta:'fixture'}}})).ms);
 await b.close();
 for(let i=0;i<15;i++){const t=performance.now(),c=client('scan');const v=await c.request({root:directory,maxEntries:1000});if(!v.m.complete||v.m.entries.length!==256)throw new Error('incorrect scan');raw.scan.coldMs.push(performance.now()-t);await c.close();}
 const c=client('scan');for(let i=0;i<10;i++)await c.request({root:directory,maxEntries:1000});raw.scan.idle=await idle(c);
 for(let r=0;r<3;r++)for(let i=0;i<100;i++){const v=await c.request({root:directory,maxEntries:1000});if(v.m.entries.length!==256||!v.m.complete)throw new Error('incorrect scan');raw.scan.warmMs.push(v.ms);}await c.close();
 raw.summary={bridgeColdMs:stat(raw.bridge.coldMs),bridgeWarmMs:stat(raw.bridge.warmMs),scanColdMs:stat(raw.scan.coldMs),scanWarmMs:stat(raw.scan.warmMs),binaryBytes:(await fs.stat(exe)).size};
 await fs.writeFile(path.join(root,'evidence',label+'-metrics.json'),JSON.stringify(raw,null,2));console.log(JSON.stringify({label,...raw.summary,bridgeIdle:raw.bridge.idle,scanIdle:raw.scan.idle},null,2));
}finally{server.closeAllConnections();await new Promise(r=>server.close(r));if(!fixture.startsWith(RUNS))throw new Error('cleanup scope');await fs.rm(fixture,{recursive:true,force:true});}
