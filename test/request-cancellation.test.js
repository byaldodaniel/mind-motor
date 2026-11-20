import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { serveMcp } from '../src/mcp-server.js';
import { createAgentTools } from '../src/agent-tools.js';
import { openSession } from '../src/session.js';
import { createResourceGovernor } from '../src/resource-governor.js';
import { withRequestContext, requestSignal, waitForRequest } from '../src/request-context.js';

async function until(check) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await delay(10); }
  throw new Error('Condition not reached before deadline');
}

test('MCP notifications/cancelled stops a queued buscar and leaves the session usable', async (t) => {
  const root = path.resolve(process.env.MIND_TEST_TMP ?? path.join(os.tmpdir(), 'mind-1.0.1-tests'));
  await fs.mkdir(root, { recursive: true });
  const directory = await fs.mkdtemp(path.join(root, 'request-cancellation-'));
  const folder = path.join(directory, 'Información ficticia');
  await fs.mkdir(folder);
  await fs.writeFile(path.join(folder, 'ficticio.txt'), 'contenido ficticio');
  const session = await openSession({ observe: false, motorVersion: '1.0.1-prueba', layout: {
    product: false, root: null, baseDirectory: path.join(directory, 'Base'),
    motorDirectory: fileURLToPath(new URL('..', import.meta.url)), protectedDirectories: [],
    pythonExecutable: process.env.MIND_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3'),
  } });
  const scope = await session.motor.authorizeFolder(folder);
  await session.policy.set(scope.id, ['encontrar'], { channel: 'administracion-local' });
  const input = new PassThrough();
  const output = new PassThrough();
  const messages = new Map();
  let buffer = '';
  output.on('data', (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      messages.set(message.id, message);
    }
  });
  const server = serveMcp({ input, output, serverInfo: { name: 'mind', version: '1.0.1-prueba' },
    tools: (connection) => createAgentTools({ session, connection }), onClose: () => session.close() });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const governor = createResourceGovernor(session.motor.baseDirectory, { sample: () => ({ pressured: false }) });
  let started;
  const began = new Promise((resolve) => { started = resolve; });
  const held = governor.run(async () => { started(); await gate; });
  t.after(async () => {
    release(); await held;
    input.end(); await server.finished; await session.close();
    assert.equal(path.dirname(directory), root);
    assert.ok(path.basename(directory).startsWith('request-cancellation-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  await began;
  const send = (message) => input.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'ficticio' } } });
  await until(() => messages.get(1));
  send({ method: 'notifications/initialized' });
  send({ id: 2, method: 'tools/call', params: { name: 'buscar', arguments: { consulta: 'ficticio' } } });
  await until(async () => (await governor.status()).cola.length === 2);
  send({ method: 'notifications/cancelled', params: { requestId: 2 } });
  const cancelled = await until(() => messages.get(2));
  assert.equal(cancelled.result.isError, true, JSON.stringify(cancelled));
  assert.equal(cancelled.result.structuredContent.error.codigo, 'REQUEST_CANCELLED');
  assert.equal((await governor.status()).cola.length, 1, 'Only the unrelated held work remains queued');
  release(); await held;
  send({ id: 3, method: 'tools/call', params: { name: 'buscar', arguments: { consulta: 'ficticio' } } });
  const success = await until(() => messages.get(3));
  assert.equal(success.result.isError, undefined);
  assert.equal(success.result.structuredContent.total, 1);
  assert.equal((await governor.status()).cola.length, 0);
});

test('cancelling one wait does not cancel shared work or leak the old signal', async () => {
  const controller = new AbortController();
  let release;
  const shared = new Promise((resolve) => { release = resolve; });
  let later;
  const pending = withRequestContext({ signal: controller.signal }, async () => {
    later = shared.then(() => requestSignal());
    return waitForRequest(shared);
  });
  const rejected = assert.rejects(pending, { code: 'REQUEST_CANCELLED' });
  controller.abort();
  await rejected;
  release('completado');
  assert.equal(await shared, 'completado');
  assert.equal(await later, undefined);
  assert.equal(requestSignal(), undefined);
});
