import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { serveMcp, SUPPORTED_PROTOCOL_VERSIONS } from '../src/mcp-server.js';
import { MotorError } from '../src/errors.js';

/** Servidor en memoria con un cliente que escribe y lee líneas JSON. */
function harness({ handlers = {}, onClose, onInitialized } = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const received = [];
  const waiters = [];
  let buffer = '';
  output.setEncoding('utf8');
  output.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const message = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      received.push(message);
      for (const waiter of [...waiters]) {
        if (waiter.match(message)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(message);
        }
      }
    }
  });
  const definitions = Object.keys(handlers).map((name) => ({ name, description: name, inputSchema: { type: 'object' } }));
  const server = serveMcp({
    input, output,
    serverInfo: { name: 'mind', version: '0.0.0-prueba' },
    instructions: 'Instrucciones de prueba',
    tools: (connection) => ({
      definitions,
      call: (name, args, context) => handlers[name](args, { ...context, connection }),
    }),
    onClose,
    onInitialized,
  });
  const next = (match) => {
    const found = received.find(match);
    if (found) {
      received.splice(received.indexOf(found), 1);
      return Promise.resolve(found);
    }
    return new Promise((resolve) => waiters.push({ match, resolve }));
  };
  return {
    server,
    send: (message) => input.write(`${typeof message === 'string' ? message : JSON.stringify(message)}\n`),
    response: (id) => next((message) => message.id === id && !message.method),
    request: (method) => next((message) => message.method === method),
    end: () => input.end(),
  };
}

const init = (id, protocolVersion = '2025-11-25', capabilities = {}) => ({
  jsonrpc: '2.0', id, method: 'initialize',
  params: { protocolVersion, capabilities, clientInfo: { name: 'cliente-de-prueba', version: '1' } },
});

test('negocia la versión del protocolo y entrega instrucciones', async () => {
  const client = harness();
  client.send(init(1, '2025-06-18'));
  const first = await client.response(1);
  assert.equal(first.result.protocolVersion, '2025-06-18');
  assert.equal(first.result.instructions, 'Instrucciones de prueba');
  assert.deepEqual(first.result.capabilities, { tools: { listChanged: false } });
  client.send(init(2, '1999-01-01'));
  assert.equal((await client.response(2)).result.protocolVersion, SUPPORTED_PROTOCOL_VERSIONS[0]);
  client.end();
  await client.server.finished;
});

test('errores de protocolo: JSON inválido, método desconocido, herramienta desconocida y sesión sin iniciar', async () => {
  const client = harness({ handlers: { eco: async (args) => args } });
  client.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.equal((await client.response(1)).error.code, -32600);
  client.send('{no es json');
  assert.equal((await client.response(null)).error.code, -32700);
  client.send(init(2));
  await client.response(2);
  client.send({ jsonrpc: '2.0', id: 3, method: 'resources/list' });
  assert.equal((await client.response(3)).error.code, -32601);
  client.send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'inexistente', arguments: {} } });
  assert.equal((await client.response(4)).error.code, -32602);
  client.send({ jsonrpc: '1.0', id: 5, method: 'ping' });
  assert.equal((await client.response(5)).error.code, -32600);
  client.send({ jsonrpc: '2.0', id: 6, method: 'ping' });
  assert.deepEqual((await client.response(6)).result, {});
  client.end();
  await client.server.finished;
});

test('los fallos de herramienta llegan como resultado isError sin filtrar detalles internos', async () => {
  const client = harness({
    handlers: {
      conocido: async () => { throw new MotorError('ACCESS_NOT_GRANTED', 'Sin permiso ficticio.'); },
      inesperado: async () => { throw new Error('/ruta/secreta/del/sistema'); },
      correcto: async () => ({ valor: 42 }),
    },
  });
  client.send(init(1));
  await client.response(1);
  client.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'conocido', arguments: {} } });
  const known = (await client.response(2)).result;
  assert.equal(known.isError, true);
  assert.equal(known.structuredContent.error.codigo, 'ACCESS_NOT_GRANTED');
  client.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'inesperado', arguments: {} } });
  const unexpected = (await client.response(3)).result;
  assert.equal(unexpected.structuredContent.error.codigo, 'ERROR_INTERNO');
  assert.doesNotMatch(unexpected.content[0].text, /secreta/);
  client.send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'correcto', arguments: {} } });
  const ok = (await client.response(4)).result;
  assert.equal(ok.isError, undefined);
  assert.deepEqual(ok.structuredContent, { valor: 42 });
  assert.deepEqual(JSON.parse(ok.content[0].text), { valor: 42 });
  client.end();
  await client.server.finished;
});

test('peticiones del servidor al cliente: la elicitación espera la respuesta del cliente', async () => {
  const client = harness({
    handlers: {
      preguntar: async (args, { connection }) => {
        const answer = await connection.request('elicitation/create', { message: '¿Autorizar?', requestedSchema: { type: 'object', properties: {} } });
        return { respuesta: answer };
      },
    },
  });
  client.send(init(1, '2025-11-25', { elicitation: { form: {} } }));
  await client.response(1);
  client.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'preguntar', arguments: {} } });
  const ask = await client.request('elicitation/create');
  assert.equal(ask.params.message, '¿Autorizar?');
  client.send({ jsonrpc: '2.0', id: ask.id, result: { action: 'accept', content: { autorizar: true } } });
  assert.deepEqual((await client.response(2)).result.structuredContent.respuesta, { action: 'accept', content: { autorizar: true } });
  client.end();
  await client.server.finished;
});

test('capacidad de formularios: vacía (2025-06-18) o con form; url sola no basta', async () => {
  for (const [capabilities, expected] of [
    [{}, false], [{ elicitation: {} }, true], [{ elicitation: { form: {} } }, true],
    [{ elicitation: { url: {} } }, false], [{ elicitation: { form: {}, url: {} } }, true],
  ]) {
    const client = harness();
    client.send(init(1, '2025-11-25', capabilities));
    await client.response(1);
    assert.equal(client.server.connection.supportsFormElicitation(), expected, JSON.stringify(capabilities));
    client.end();
    await client.server.finished;
  }
});

test('cancelar una llamada aborta su señal; cerrar la entrada termina la sesión y avisa', async () => {
  let aborted = false;
  let closed = false;
  const client = harness({
    handlers: {
      lenta: (args, { signal }) => new Promise((resolve) => {
        signal.addEventListener('abort', () => { aborted = true; resolve({ cancelada: true }); });
      }),
    },
    onClose: () => { closed = true; },
  });
  client.send(init(1));
  await client.response(1);
  client.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'lenta', arguments: {} } });
  await new Promise((resolve) => setImmediate(resolve));
  client.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2 } });
  await client.response(2);
  assert.equal(aborted, true);
  client.end();
  await client.server.finished;
  assert.equal(closed, true);
});

test('admite lotes de versiones anteriores del protocolo', async () => {
  const client = harness();
  client.send([init(1, '2025-03-26'), { jsonrpc: '2.0', id: 2, method: 'ping' }]);
  assert.equal((await client.response(1)).result.protocolVersion, '2025-03-26');
  assert.deepEqual((await client.response(2)).result, {});
  client.end();
  await client.server.finished;
});

test('un inicio fallido no inutiliza la conversación: informa el motivo y se reintenta', async () => {
  let attempts = 0;
  let calls = 0;
  const client = harness({
    handlers: { estado: async () => { calls++; return { ok: true }; } },
    onInitialized: async () => {
      attempts++;
      if (attempts <= 2) throw new MotorError('INDEX_LOCK_TIMEOUT', 'Otro proceso de Mind está actualizando estos datos.');
    },
  });
  client.send(init(1));
  await client.response(1);
  client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  // Primer uso: el reintento vuelve a fallar y el agente recibe el motivo real, no -32603.
  client.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'estado', arguments: {} } });
  const failed = await client.response(2);
  assert.equal(failed.error, undefined);
  assert.equal(failed.result.isError, true);
  assert.equal(failed.result.structuredContent.error.codigo, 'INDEX_LOCK_TIMEOUT');
  assert.equal(calls, 0);
  // Segundo uso: el inicio se recupera y la herramienta funciona.
  client.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'estado', arguments: {} } });
  const recovered = await client.response(3);
  assert.deepEqual(recovered.result.structuredContent, { ok: true });
  assert.equal(attempts, 3);
  // Ya iniciado: no se repite el inicio.
  client.send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'estado', arguments: {} } });
  await client.response(4);
  assert.equal(attempts, 3);
  assert.equal(calls, 2);
  client.end();
  await client.server.finished;
});
