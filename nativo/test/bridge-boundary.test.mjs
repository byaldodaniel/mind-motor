import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import {baseIdOf} from '../../src/connector.js';
import {createTempRoot,startBridge,startFakeMotor} from './native-fixtures.mjs';
test('bridge refuses forged health before sending bearer',{timeout:30000},async t=>{
 const env=await createTempRoot(t);let leaked=0;const token='e'.repeat(64);
 const server=http.createServer((req,res)=>{if(req.headers.authorization)leaked++;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,baseId:baseIdOf(env.base),port:server.address().port,proof:'f'.repeat(64)}));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 await fs.writeFile(env.base+'/conector.json',JSON.stringify({version:1,baseId:baseIdOf(env.base),port:server.address().port,pid:process.pid}));
 await fs.writeFile(env.base+'/conector-secreto.json',JSON.stringify({version:1,token}));
 const bridge=startBridge(env);try{const init=await bridge.initialize();assert.match(init.result.instructions,/MOTOR_START_FAILED/);assert.equal(leaked,0);}finally{await bridge.close();}
});
test('bridge handles fragmented SSE with Unicode and final response once',{timeout:30000},async t=>{
 const env=await createTempRoot(t);await startFakeMotor(env,{onToolCall:({body,res})=>{
 res.writeHead(200,{'Content-Type':'text/event-stream'});
 const message={jsonrpc:'2.0',id:body.id,result:{content:[{type:'text',text:'café 日本語'}],structuredContent:{ok:true}}};
 const data=Buffer.from(': heartbeat\r\n\r\nevent: message\r\ndata: '+JSON.stringify(message)+'\r\n\r\n');
 let p=0;const write=()=>{if(p>=data.length){res.end();return;}res.write(data.subarray(p,p+3));p+=3;setImmediate(write);};write();return true;
 }});
 const bridge=startBridge(env);try{await bridge.initialize();const result=await bridge.call('buscar');assert.equal(result.result.content[0].text,'café 日本語');assert.deepEqual(bridge.stray,[]);}finally{await bridge.close();}
});

test('bridge returns indeterminate error when installed relay dies after receiving write',{timeout:30000},async t=>{
 const env=await createTempRoot(t);env.layout.manifest={packageRevision:1};
 const original=await startFakeMotor(env,{healthRelease:{motorVersion:'1.0.4',packageRevision:1}});
 const runner=env.root+'/relay-dies.mjs',received=env.root+'/received.log';
 await fs.writeFile(runner,[
 "import readline from 'node:readline';import fs from 'node:fs';",
 "readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize'){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2025-11-25',capabilities:{},serverInfo:{name:'relay'}}})+'\\n');return;}if(m.method==='tools/call'){fs.appendFileSync("+JSON.stringify(received)+",'received\\n');process.exit(3);}});"
 ].join('\n'));
 const bridge=startBridge(env,{relaunch:{command:process.execPath,args:[runner]}});
 try{await bridge.initialize();await bridge.call('buscar');await original.close();
 const updated=await startFakeMotor(env,{healthRelease:{motorVersion:'1.0.4',packageRevision:2}});
 const reply=await bridge.call('crear',{ruta:'x',contenido:'x'});
 assert.equal(reply.result.isError,true);assert.equal(reply.result.structuredContent.error.codigo,'MOTOR_CONNECTION_LOST');
 assert.equal(updated.calls('crear'),0);assert.equal((await fs.readFile(received,'utf8')).trim().split('\n').length,1);assert.deepEqual(bridge.stray,[]);
 }finally{await bridge.close();}
});
