import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  baseIdOf,
  callCentralRpc,
  canonicalBaseDirectory,
  checkConnectorHealth,
  checkHealthyConnector,
  healthProof,
  newStartupErrorFile,
  readOrCreateSecret,
  readSecret,
  validStartupErrorFile,
  writeStartupError,
} from '../src/connector.js';
import { MotorError } from '../src/errors.js';

const TOKEN = 'a1'.repeat(32);

/**
 * Base temporal con el rastro de un Motor Central (estado y secreto) y un servidor
 * local en el puerto anunciado. `knowsSecret` decide si responde la prueba de
 * identidad como el Motor real o como un programa ajeno que ocupó el puerto.
 */
async function fakeMotor(t, { knowsSecret, onRpc }) {
  const base = await canonicalBaseDirectory(await fs.mkdtemp(path.join(os.tmpdir(), 'mind-connector-')));
  const baseId = baseIdOf(base);
  const rpc = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/health') {
      const nonce = url.searchParams.get('nonce');
      const port = server.address().port;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        ok: true, baseId, port, pid: process.pid,
        ...(knowsSecret && nonce ? { proof: healthProof(TOKEN, nonce, baseId, port) } : {}),
      }));
      return;
    }
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      rpc.push({ authorization: req.headers.authorization, body });
      onRpc?.(req, res, rpc.length);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await fs.writeFile(path.join(base, 'conector.json'), JSON.stringify({ version: 1, baseId, port, pid: process.pid }));
  await fs.writeFile(path.join(base, 'conector-secreto.json'), JSON.stringify({ version: 1, token: TOKEN }));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(base, { recursive: true, force: true });
  });
  return { base, baseId, port, rpc };
}

test('un programa que ocupa el puerto de un Motor muerto no recibe el secreto', async (t) => {
  const impostor = await fakeMotor(t, { knowsSecret: false });
  // Responde /health con la Base y el puerto correctos, pero no puede probar que conoce el secreto.
  assert.ok(await checkConnectorHealth(impostor.port, impostor.baseId), 'sin exigir prueba, el impostor parece sano');
  assert.equal(await checkConnectorHealth(impostor.port, impostor.baseId, { token: TOKEN }), null);
  assert.equal(await checkHealthyConnector(impostor.base), null);
  assert.equal(impostor.rpc.length, 0, 'no se le envió ninguna petición autenticada');
});

test('la prueba de identidad no vale para otro puerto ni para otra Base', async (t) => {
  const real = await fakeMotor(t, { knowsSecret: true });
  const healthy = await checkHealthyConnector(real.base);
  assert.equal(healthy?.token, TOKEN);
  assert.equal(healthy.state.port, real.port);
  const nonce = 'ab'.repeat(16);
  const proof = healthProof(TOKEN, nonce, real.baseId, real.port);
  assert.notEqual(proof, healthProof(TOKEN, nonce, real.baseId, real.port + 1));
  assert.notEqual(proof, healthProof(TOKEN, nonce, baseIdOf(path.join(real.base, 'otra')), real.port));
  assert.notEqual(proof, healthProof('b2'.repeat(32), nonce, real.baseId, real.port));
});

test('una escritura no se repite si la conexión se pierde; una lectura sí', async (t) => {
  // El Motor recibe la operación y la conexión se corta antes de la respuesta.
  const cut = await fakeMotor(t, { knowsSecret: true, onRpc: (req) => req.socket.destroy() });
  const write = { accion: 'herramienta', tool: 'crear', args: { ruta: 'nota.md', contenido: 'x' } };
  await assert.rejects(
    callCentralRpc({ baseDirectory: cut.base, payload: write }),
    (error) => error instanceof MotorError && error.code === 'MOTOR_CONNECTION_LOST',
  );
  assert.equal(cut.rpc.length, 1, 'la escritura llegó al Motor una sola vez');

  const flaky = await fakeMotor(t, {
    knowsSecret: true,
    onRpc: (req, res, count) => {
      if (count === 1) { req.socket.destroy(); return; }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, value: { resultados: [] }, text: '{}', isError: false }));
    },
  });
  const read = { accion: 'herramienta', tool: 'buscar', args: { consulta: 'x' } };
  const result = await callCentralRpc({ baseDirectory: flaky.base, payload: read });
  assert.equal(result.ok, true);
  assert.equal(flaky.rpc.length, 2, 'la lectura se reintentó');
});

test('agotar la espera tampoco repite una escritura, y por defecto no hay límite de tiempo', async (t) => {
  const slow = await fakeMotor(t, { knowsSecret: true, onRpc: () => { /* nunca responde */ } });
  const write = { accion: 'herramienta', tool: 'conversacion_trasladar', args: { id: 'x' } };
  await assert.rejects(
    callCentralRpc({ baseDirectory: slow.base, payload: write, timeoutMs: 250 }),
    (error) => error instanceof MotorError && error.code === 'MOTOR_CONNECTION_LOST',
  );
  assert.equal(slow.rpc.length, 1);

  // Sin `timeoutMs`, una operación lenta sigue esperando su respuesta.
  const patient = await fakeMotor(t, {
    knowsSecret: true,
    onRpc: (req, res) => setTimeout(() => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, value: {}, text: '{}', isError: false }));
    }, 600),
  });
  const done = await callCentralRpc({ baseDirectory: patient.base, payload: write });
  assert.equal(done.ok, true);
  assert.equal(patient.rpc.length, 1);
});

test('un rechazo sin procesar (apagándose, credenciales anteriores) se reintenta aunque sea escritura', async (t) => {
  const restarting = await fakeMotor(t, {
    knowsSecret: true,
    onRpc: (req, res, count) => {
      res.setHeader('Content-Type', 'application/json');
      if (count === 1) { res.statusCode = 503; res.end(JSON.stringify({ error: 'MOTOR_SHUTTING_DOWN' })); return; }
      res.end(JSON.stringify({ ok: true, value: {}, text: '{}', isError: false }));
    },
  });
  const write = { accion: 'herramienta', tool: 'crear', args: { ruta: 'nota.md', contenido: 'x' } };
  assert.equal((await callCentralRpc({ baseDirectory: restarting.base, payload: write })).ok, true);
  assert.equal(restarting.rpc.length, 2);
});

test('un secreto vacío o dañado se regenera en lugar de impedir el arranque', async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'mind-connector-secret-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const file = path.join(base, 'conector-secreto.json');

  const first = await readOrCreateSecret(base);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(await readOrCreateSecret(base), first, 'un secreto válido se conserva');

  for (const damaged of ['', '{"version":1,"token":', '{"version":1,"token":"corto"}']) {
    await fs.writeFile(file, damaged);
    assert.equal(await readSecret(base), null);
    const regenerated = await readOrCreateSecret(base);
    assert.match(regenerated, /^[a-f0-9]{64}$/);
    assert.equal(await readSecret(base), regenerated);
  }

  // Un directorio con ese nombre no se sobrescribe: se informa con el código propio.
  await fs.rm(file, { force: true });
  await fs.mkdir(file);
  await assert.rejects(readOrCreateSecret(base), (error) => error.code === 'CONNECTOR_SECRET_UNAVAILABLE');
});

test('el archivo del error de inicio tiene nombre impredecible y solo se acepta en el temporal', async () => {
  const one = newStartupErrorFile();
  const two = newStartupErrorFile();
  assert.notEqual(one, two);
  assert.equal(validStartupErrorFile(one), true);
  assert.equal(validStartupErrorFile(path.join(os.tmpdir(), 'mind-motor-error-fijo.json')), false);
  assert.equal(validStartupErrorFile(path.join(os.tmpdir(), 'otra', path.basename(one))), false);
  assert.equal(validStartupErrorFile(path.basename(one)), false);
  assert.equal(validStartupErrorFile(undefined), false);

  try {
    await writeStartupError(one, new MotorError('BASE_TOO_NEW', 'La Base es más reciente.'));
    const stored = JSON.parse(await fs.readFile(one, 'utf8'));
    assert.equal(stored.code, 'BASE_TOO_NEW');
    // Un fallo inesperado no se publica, y una ruta no válida se ignora sin lanzar.
    await writeStartupError(two, new Error('interno'));
    await assert.rejects(fs.stat(two), { code: 'ENOENT' });
    await writeStartupError(path.join(os.tmpdir(), 'mind-motor-error-fijo.json'), new MotorError('X', 'y'));
    await assert.rejects(fs.stat(path.join(os.tmpdir(), 'mind-motor-error-fijo.json')), { code: 'ENOENT' });
  } finally {
    await fs.rm(one, { force: true });
    await fs.rm(two, { force: true });
  }
});
