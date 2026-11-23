import {RUNS} from './runs.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  baseIdOf,
  canonicalBaseDirectory,
  checkHealthyConnector,
  connectorPaths,
  healthProof,
  stopCentralMotor,
} from '../../src/connector.js';

const PILOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const NATIVE=process.env.MIND_NATIVE_EXE;
if(!NATIVE)throw new Error('MIND_NATIVE_EXE required');
process.env.MIND_AGENT_STARTUP='0';
process.env.MIND_PYTHON=process.env.MIND_PYTHON || (process.platform==='win32'?'python':'python3');
process.env.TEMP=RUNS;process.env.TMP=process.env.TEMP;
function startMcp({args,cwd}) {
 const env={root:cwd,base:args[1],layout:{entrypoint:path.join(PILOT,'test/real-motor.mjs'),baseDirectory:args[1]}};
 const b=startBridge(env,{cwd});
 return {initialize:()=>b.initialize(),close:()=>b.close(),async call(name,args){const r=await b.call(name,args);return {isError:r.result?.isError??false,text:r.result?.content?.[0]?.text??'',data:r.result?.structuredContent,rpcError:r.error};}};
}


const PROTOCOL = '2025-11-25';

async function createTempRoot(t, prefix = 'mind-puente-') {
  const root = await fs.realpath(await fs.mkdtemp(path.join(RUNS, prefix)));
  const base = path.join(root, 'Base');
  await fs.mkdir(base, { recursive: true });
  // Arranque que siempre falla: simula un Motor que no puede despertarse y cuenta intentos.
  const failingEntrypoint = path.join(root, 'motor-que-falla.mjs');
  await fs.writeFile(failingEntrypoint, [
    "import fs from 'node:fs';",
    "fs.appendFileSync(new URL('./arranques.log', import.meta.url), 'arranque\\n');",
    'process.exit(3);',
    '',
  ].join('\n'));
  const fakes = [];
  t.after(async () => {
    for (const fake of fakes) await fake.close().catch(() => {});
    await stopCentralMotor(base).catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    root,
    base,
    layout: { baseDirectory: base, entrypoint: failingEntrypoint },
    fakes,
    async startAttempts() {
      const text = await fs.readFile(path.join(root, 'arranques.log'), 'utf8').catch(() => '');
      return text.split('\n').filter(Boolean).length;
    },
  };
}

/**
 * Motor falso: /health con la prueba de identidad real y un /mcp mínimo cuyo
 * comportamiento ante tools/call decide cada prueba. Publica conector.json y
 * conector-secreto.json en la Base temporal como lo haría el Motor Central.
 */
async function startFakeMotor(env, { onToolCall, onInitialized, healthRelease = {} } = {}) {
  const canonical = await canonicalBaseDirectory(env.base);
  const baseId = baseIdOf(canonical);
  const token = randomBytes(32).toString('hex');
  const { stateFile, secretFile } = connectorPaths(canonical);
  const received = [];
  let sessions = 0;
  const initializedSessions = new Set();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const port = server.address().port;
    const sendJson = (status, payload, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
      res.end(JSON.stringify(payload));
    };
    if (url.pathname === '/health') {
      const nonce = url.searchParams.get('nonce');
      return sendJson(200, { ok: true, baseId, port, pid: process.pid, ...healthRelease, ...(nonce ? { proof: healthProof(token, nonce, baseId, port) } : {}) });
    }
    if (req.headers.authorization !== `Bearer ${token}`) return sendJson(401, { error: 'UNAUTHORIZED' });
    if (url.pathname !== '/mcp') return sendJson(404, { error: 'NOT_FOUND' });
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      res.write(': connected\n\n');
      return;
    }
    if (req.method === 'DELETE') return sendJson(200, { closed: true });
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', async () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const sessionId = req.headers['mcp-session-id'] ?? null;
      received.push({ body, sessionId, headers: req.headers });
      if (body.method === 'initialize') {
        sessions += 1;
        return sendJson(200, {
          jsonrpc: '2.0',
          id: body.id,
          result: { protocolVersion: PROTOCOL, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'motor-falso', version: '0' } },
        }, { 'Mcp-Session-Id': `sesion-${sessions}` });
      }
      if (body.method === 'notifications/initialized') {
        await onInitialized?.();
        initializedSessions.add(sessionId);
        res.writeHead(202);
        return res.end();
      }
      if (body.method === 'ping') return sendJson(200, { jsonrpc: '2.0', id: body.id, result: {} });
      if (body.method === 'tools/list') {
        return sendJson(200, { jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'buscar' }, { name: 'crear' }] } });
      }
      if (body.method === 'tools/call') {
        // Sin `onToolCall`, o si devuelve `false`, el Motor falso responde con éxito.
        const handled = onToolCall
          ? await onToolCall({ body, req, res, sendJson, initialized: initializedSessions.has(sessionId) })
          : false;
        if (handled !== false) return undefined;
        return sendJson(200, {
          jsonrpc: '2.0',
          id: body.id,
          result: { content: [{ type: 'text', text: 'ok' }], structuredContent: { ok: true } },
        });
      }
      if (!Object.hasOwn(body, 'id')) {
        res.writeHead(202);
        return res.end();
      }
      return sendJson(200, { jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'no' } });
    });
    return undefined;
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await fs.writeFile(stateFile, JSON.stringify({ version: 1, baseId, port, pid: process.pid }));
  await fs.writeFile(secretFile, JSON.stringify({ version: 1, token }));
  let closing = null;
  const fake = {
    port,
    received,
    calls: (name) => received.filter((entry) => entry.body.method === 'tools/call' && entry.body.params?.name === name).length,
    count: (method) => received.filter((entry) => entry.body.method === method).length,
    close() {
      closing ??= (async () => {
        await fs.rm(stateFile, { force: true });
        server.closeAllConnections?.();
        await new Promise((resolve) => server.close(() => resolve()));
      })();
      return closing;
    },
  };
  env.fakes.push(fake);
  return fake;
}

/** Ejecuta el puente en proceso con streams en memoria, como lo usaría un cliente stdio. */
function startBridge(env, { cwd = env.root, workspacePaths = [], relaunch = null, log } = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const waiting = new Map();
  const notifications = [];
  const stray = [];
  let nextId = 1;
  let buffer = '';
  
  const args=['bridge','--base',env.base,'--cwd',cwd,'--paths',JSON.stringify(workspacePaths),'--launch-command',process.execPath,'--launch-arg',env.layout.entrypoint,'--launch-arg',env.base];
  if(env.layout.manifest?.packageRevision)args.push('--package-revision',String(env.layout.manifest.packageRevision),'--motor-version','1.0.4');
  if(relaunch){args.push('--relaunch-command',relaunch.command);for(const a of relaunch.args??[])args.push('--relaunch-arg',a);}
  const child=spawn(NATIVE,args,{cwd:PILOT,stdio:['pipe','pipe','pipe'],windowsHide:true,env:process.env});
  let stderr='';child.stderr.on('data',c=>{stderr+=c;log?.('info',c.toString());});
  child.stdin.on('error',()=>{});
  input.pipe(child.stdin);child.stdout.pipe(output);
  const finished=new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',(code,signal)=>{if(code!==0)reject(new Error('native exit '+code+' '+signal+' '+stderr));else resolve();});});

  output.setEncoding('utf8');
  output.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      
      if(message.method && Object.hasOwn(message,'id')){
        const result=message.method==='roots/list'?{roots:[]}:message.method==='elicitation/create'?{action:'decline'}:undefined;
        input.write(JSON.stringify({jsonrpc:'2.0',id:message.id,...(result?{result}:{error:{code:-32601,message:'unsupported'}})})+'\n');
        continue;
      }
      if (message.method && !Object.hasOwn(message, 'id')) {
        notifications.push(message);
        continue;
      }
      const pending = waiting.get(message.id);
      if (pending) {
        waiting.delete(message.id);
        pending(message);
      } else {
        stray.push(message);
      }
    }
  });

  function request(method, params = {}, { timeoutMs = 15_000 } = {}) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error(`Sin respuesta a ${method} (id ${id}) en ${timeoutMs} ms`));
      }, timeoutMs);
      waiting.set(id, (message) => { clearTimeout(timer); resolve(message); });
      input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  function notify(method) {
    input.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
  }

  return {
    request,
    notify,
    notifications,
    stray,
    async initialize() {
      const response = await request('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'prueba', version: '1' } });
      notify('notifications/initialized');
      return response;
    },
    async call(name, args = {}, options) {
      const response = await request('tools/call', { name, arguments: args }, options);
      return response;
    },
    async close() {
      input.end();
      const timer=setTimeout(()=>child.kill(),5000);
      try{await finished;}finally{clearTimeout(timer);}
    },
  };
}

function decodeWorkspace(headers) {
  return JSON.parse(Buffer.from(String(headers['x-mind-workspace']), 'base64url').toString('utf8'));
}

export {createTempRoot,startBridge,startFakeMotor,decodeWorkspace};
