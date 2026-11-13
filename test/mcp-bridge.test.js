import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { runMcpBridge } from '../src/mcp-bridge.js';
import {
  baseIdOf,
  canonicalBaseDirectory,
  checkHealthyConnector,
  connectorPaths,
  healthProof,
  stopCentralMotor,
} from '../src/connector.js';
import { startMcp } from './helpers/mcp-client.js';

const PROTOCOL = '2025-11-25';

async function createTempRoot(t, prefix = 'mind-puente-') {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
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
async function startFakeMotor(env, { onToolCall, onInitialized } = {}) {
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
      return sendJson(200, { ok: true, baseId, port, ...(nonce ? { proof: healthProof(token, nonce, baseId, port) } : {}) });
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
function startBridge(env, { cwd = env.root, workspacePaths = [] } = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const waiting = new Map();
  const notifications = [];
  const stray = [];
  let nextId = 1;
  let buffer = '';
  const finished = runMcpBridge({ layout: env.layout, cwd, workspacePaths, input, output });
  output.setEncoding('utf8');
  output.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
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
      await finished;
    },
  };
}

function decodeWorkspace(headers) {
  return JSON.parse(Buffer.from(String(headers['x-mind-workspace']), 'base64url').toString('utf8'));
}

test('puente: arranca y lee desde carpetas con nombre japonés y con acento NFD (Motor real)', { timeout: 90_000 }, async (t) => {
  const env = await createTempRoot(t);
  const folders = [path.join(env.root, '日本語'), path.join(env.root, 'José Proyecto')];
  for (const folder of folders) {
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, 'nota.txt'), `Contenido en ${path.basename(folder)}\n`);
  }
  for (const folder of folders) {
    const client = startMcp({ args: ['--base', env.base], cwd: folder });
    try {
      const init = await client.initialize();
      assert.equal(init.error, undefined);
      assert.doesNotMatch(String(init.result.instructions ?? ''), /STARTUP_FAILED|MOTOR_/);
      const read = await client.call('leer', { carpeta: folder, ruta: 'nota.txt' });
      assert.equal(read.isError, false, read.text);
      assert.ok(read.text.includes(`Contenido en ${path.basename(folder)}`), read.text);
    } finally {
      await client.close().catch(() => {});
    }
  }
  assert.ok(await checkHealthyConnector(env.base));
});

test('puente: envía el ámbito en X-Mind-Workspace solo en initialize y nada antes de notifications/initialized', { timeout: 30_000 }, async (t) => {
  const env = await createTempRoot(t);
  const fake = await startFakeMotor(env, {
    onInitialized: () => delay(200),
    onToolCall: ({ body, sendJson, initialized }) => sendJson(200, {
      jsonrpc: '2.0',
      id: body.id,
      result: initialized
        ? { content: [{ type: 'text', text: 'ok' }], structuredContent: { ok: true } }
        : { content: [{ type: 'text', text: 'sin inicializar' }], isError: true },
    }),
  });
  const cwd = path.join(env.root, 'Carpeta 日本語 José');
  const bridge = startBridge(env, { cwd, workspacePaths: [cwd] });
  try {
    await bridge.request('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'prueba', version: '1' } });
    bridge.notify('notifications/initialized');
    const reply = await bridge.call('buscar', { consulta: 'x' });
    assert.equal(reply.result.isError ?? false, false, 'la herramienta adelantó a notifications/initialized');
    const init = fake.received.find((entry) => entry.body.method === 'initialize');
    assert.deepEqual(decodeWorkspace(init.headers), { cwd, paths: [cwd] });
    assert.equal(init.headers['x-mind-cwd'], undefined);
    const others = fake.received.filter((entry) => entry.body.method !== 'initialize');
    assert.ok(others.length >= 2);
    assert.ok(others.every((entry) => entry.headers['x-mind-workspace'] === undefined));
  } finally {
    await bridge.close();
  }
});

test('puente: responde con error cuando el Motor no puede despertarse', { timeout: 30_000 }, async (t) => {
  const env = await createTempRoot(t);
  const fake = await startFakeMotor(env);
  const bridge = startBridge(env);
  try {
    const init = await bridge.initialize();
    assert.equal(init.result.serverInfo.name, 'motor-falso');
    // El Motor desaparece y no puede volver a arrancar.
    await fake.close();
    const call = await bridge.call('buscar', { consulta: 'x' });
    assert.equal(call.result.isError, true);
    assert.equal(call.result.structuredContent.error.codigo, 'MOTOR_START_FAILED');
    const write = await bridge.call('crear', { ruta: 'a.txt', contenido: 'a' });
    assert.equal(write.result.isError, true);
    // Un método que no es de herramientas recibe un error JSON-RPC, no silencio.
    const other = await bridge.request('resources/list');
    assert.equal(other.jsonrpc, '2.0');
    assert.equal(typeof other.error?.code, 'number');
    assert.ok(await env.startAttempts() >= 1);
    assert.deepEqual(bridge.stray, []);
  } finally {
    await bridge.close();
  }
});

test('puente: un rechazo persistente del Motor (401) llega como error de herramienta JSON-RPC', { timeout: 30_000 }, async (t) => {
  const env = await createTempRoot(t);
  const fake = await startFakeMotor(env, {
    onToolCall: ({ sendJson }) => sendJson(401, { error: 'UNAUTHORIZED' }),
  });
  const bridge = startBridge(env);
  try {
    await bridge.initialize();
    const call = await bridge.call('buscar', { consulta: 'x' });
    assert.equal(call.jsonrpc, '2.0');
    assert.equal(call.result.isError, true);
    assert.equal(call.result.structuredContent.error.codigo, 'MOTOR_UNAUTHORIZED');
    assert.equal(fake.calls('buscar'), 2, 'se reintenta una sola vez tras reabrir sesión');
    assert.deepEqual(bridge.stray, []);
  } finally {
    await bridge.close();
  }
});

test('puente: una escritura cortada a mitad no se repite; una lectura sí', { timeout: 30_000 }, async (t) => {
  const env = await createTempRoot(t);
  let readAttempts = 0;
  const fake = await startFakeMotor(env, {
    onToolCall: ({ body, req, sendJson }) => {
      if (body.params.name === 'crear') {
        req.socket.destroy(); // El Motor recibió la petición y la conexión se perdió.
        return true;
      }
      readAttempts += 1;
      if (readAttempts === 1) {
        req.socket.destroy();
        return true;
      }
      sendJson(200, { jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'encontrado' }], structuredContent: { ok: true } } });
      return true;
    },
  });
  const bridge = startBridge(env);
  try {
    await bridge.initialize();
    const write = await bridge.call('crear', { ruta: 'nota.txt', contenido: 'hola' });
    assert.equal(write.result.isError, true);
    assert.equal(write.result.structuredContent.error.codigo, 'MOTOR_CONNECTION_LOST');
    assert.match(write.result.structuredContent.error.mensaje, /no se sabe si terminó/);
    assert.equal(fake.calls('crear'), 1);

    const read = await bridge.call('buscar', { consulta: 'nota' });
    assert.equal(read.result.isError ?? false, false);
    assert.equal(read.result.content[0].text, 'encontrado');
    assert.equal(fake.calls('buscar'), 2);
  } finally {
    await bridge.close();
  }
});

test('puente: un fallo transitorio de arranque se recupera en la siguiente llamada', { timeout: 30_000 }, async (t) => {
  const env = await createTempRoot(t);
  const bridge = startBridge(env);
  try {
    const init = await bridge.initialize();
    assert.match(init.result.instructions, /MOTOR_START_FAILED/);
    assert.equal(init.result.capabilities.tools.listChanged, true);
    const reduced = await bridge.request('tools/list');
    assert.deepEqual(reduced.result.tools.map((tool) => tool.name), ['estado']);
    const failed = await bridge.call('buscar', { consulta: 'x' });
    assert.equal(failed.result.isError, true);
    assert.equal(failed.result.structuredContent.error.codigo, 'MOTOR_START_FAILED');

    // El Motor ya puede arrancar: la siguiente llamada lo despierta y abre sesión.
    const fake = await startFakeMotor(env);
    const recovered = await bridge.call('buscar', { consulta: 'x' });
    assert.equal(recovered.result.isError ?? false, false);
    assert.equal(fake.count('notifications/initialized'), 1, 'la sesión nueva queda inicializada');
    assert.ok(bridge.notifications.some((message) => message.method === 'notifications/tools/list_changed'));
    const full = await bridge.request('tools/list');
    assert.deepEqual(full.result.tools.map((tool) => tool.name), ['buscar', 'crear']);
  } finally {
    await bridge.close();
  }
});

test('puente: ping no despierta un Motor apagado', { timeout: 30_000 }, async (t) => {
  const env = await createTempRoot(t);
  const fake = await startFakeMotor(env);
  const bridge = startBridge(env);
  try {
    await bridge.initialize();
    assert.deepEqual((await bridge.request('ping')).result, {});
    await fake.close();
    assert.deepEqual((await bridge.request('ping')).result, {});
    assert.deepEqual((await bridge.request('ping')).result, {});
    // Margen para que el flujo SSE cortado compruebe la salud sin despertar nada.
    await delay(1_500);
    assert.equal(await env.startAttempts(), 0);
    assert.equal(await checkHealthyConnector(env.base), null);
  } finally {
    await bridge.close();
  }
});
