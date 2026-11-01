import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { startMcp } from './helpers/mcp-client.js';

const motorDirectory = await fs.realpath(fileURLToPath(new URL('..', import.meta.url)));
const development = path.dirname(motorDirectory);

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(development, '.mind-mcp-lifecycle-test-'));
  const clients = [];
  t.after(async () => {
    for (const client of clients) {
      client.child.stdin.end();
      if (client.child.exitCode === null) client.child.kill();
    }
    await Promise.allSettled(clients.map((client) => client.exited));
    assert.equal(path.dirname(root), development);
    await fs.rm(root, { recursive: true, force: true });
  });
  const base = path.join(root, 'Base nueva');
  const folder = path.join(root, 'Información ficticia');
  await fs.mkdir(path.join(folder, 'Proyectos'), { recursive: true });
  await fs.writeFile(path.join(folder, 'Proyectos', 'plan.txt'), 'Plan ficticio\n');
  await fs.writeFile(path.join(folder, 'antiguo.txt'), 'Se eliminará con Mind cerrado\n');
  const start = (options = {}) => {
    const client = startMcp({
      args: ['--base', base],
      onElicit: () => ({ action: 'accept', content: { acceso: 'completo' } }),
      ...options,
    });
    clients.push(client);
    return client;
  };
  return { root, base, folder: await fs.realpath(folder), start };
}

async function eventually(check, { timeoutMs = 15_000, intervalMs = 150 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) return value;
    await delay(intervalMs);
  }
}

const names = (result) => result.data.resultados.map((item) => item.ruta).sort();

test('sesión completa: primer uso, observación, cierre sin residuos y reconciliación al reabrir', async (t) => {
  const { base, folder, start } = await fixture(t);
  const first = start();
  const init = await first.initialize();
  assert.equal(init.result.serverInfo.name, 'mind');
  assert.match(init.result.instructions, /solicitar_acceso/);
  const tools = (await first.request('tools/list')).result.tools.map((tool) => tool.name);
  for (const name of ['estado', 'solicitar_acceso', 'buscar', 'leer', 'crear', 'editar', 'continuidad_registrar']) {
    assert.ok(tools.includes(name), name);
  }
  // Primer uso: la Base se crea con su marca de formato.
  const marker = JSON.parse(await fs.readFile(path.join(base, 'mind-base.json'), 'utf8'));
  assert.equal(marker.format, 'mind-base');
  assert.equal((await first.call('solicitar_acceso', { ruta: folder, permisos: ['leer', 'escribir'] })).data.estado, 'autorizado');
  assert.deepEqual(names(await first.call('buscar', { consulta: '' })), ['Proyectos/plan.txt', 'antiguo.txt']);

  // Durante la sesión, un cambio externo llega al índice sin pedir una indexación.
  await fs.writeFile(path.join(folder, 'Proyectos', 'externo.txt'), 'Creado por otro programa\n');
  const observed = await eventually(async () => names(await first.call('buscar', { consulta: 'externo' })).length === 1);
  assert.ok(observed, 'la observación debía incorporar el archivo externo');

  // Cerrar el cliente termina el proceso y libera todo.
  assert.deepEqual(await first.close(), { code: 0, signal: null });
  assert.deepEqual(await fs.readdir(path.join(base, 'sesiones')), []);
  assert.equal((await fs.readdir(base)).some((entry) => entry.endsWith('.lock')), false);

  // Con Mind cerrado cambian los originales.
  await fs.rm(path.join(folder, 'antiguo.txt'));
  await fs.writeFile(path.join(folder, 'mientras-cerrado.md'), 'Nota escrita sin Mind\n');

  const second = start();
  await second.initialize();
  assert.equal(JSON.parse(await fs.readFile(path.join(base, 'mind-base.json'), 'utf8')).baseId, marker.baseId);
  const status = await second.call('estado');
  assert.deepEqual(status.data.carpetas[0].permisos, ['encontrar', 'leer', 'escribir', 'organizar']);
  const after = await eventually(async () => {
    const all = names(await second.call('buscar', { consulta: '' }));
    return all.includes('mientras-cerrado.md') && !all.includes('antiguo.txt') ? all : null;
  });
  assert.deepEqual(after, ['Proyectos/externo.txt', 'Proyectos/plan.txt', 'mientras-cerrado.md']);
  // Lo eliminado con Mind cerrado queda en el rastro, sin contenido.
  const removed = await eventually(async () => {
    const result = await second.call('eliminados');
    return result.data.eliminados.some((item) => item.ruta === 'antiguo.txt') ? result : null;
  });
  assert.ok(removed, 'el rastro debía incluir antiguo.txt');
  assert.deepEqual(await second.close(), { code: 0, signal: null });
});

test('una Base de una versión más reciente no se abre ni se modifica', async (t) => {
  const { base, start } = await fixture(t);
  await fs.mkdir(base);
  const marker = `${JSON.stringify({ format: 'mind-base', version: 99, baseId: '00000000-0000-4000-8000-000000000000', createdAt: '2030-01-01T00:00:00.000Z' })}\n`;
  await fs.writeFile(path.join(base, 'mind-base.json'), marker);
  const client = start();
  const exit = await client.exited;
  assert.equal(exit.code, 1);
  assert.match(client.stderr(), /BASE_TOO_NEW/);
  assert.deepEqual(await fs.readdir(base), ['mind-base.json']);
  assert.equal(await fs.readFile(path.join(base, 'mind-base.json'), 'utf8'), marker);
});

test('sin formularios en el cliente, la solicitud queda pendiente y nada se autoriza', async (t) => {
  const { base, folder, start } = await fixture(t);
  const client = start({ capabilities: {} });
  await client.initialize();
  const answer = await client.call('solicitar_acceso', { ruta: folder, permisos: ['leer'] });
  assert.equal(answer.data.estado, 'pendiente');
  assert.equal(client.elicitations.length, 0);
  assert.equal((await client.call('buscar', {})).data.error.codigo, 'ACCESS_NOT_GRANTED');
  await client.close();
  const requests = (await fs.readdir(base)).filter((entry) => entry.startsWith('consent-request-'));
  assert.equal(requests.length, 1);
  assert.equal((await fs.readdir(base)).some((entry) => entry.startsWith('folder-authorization-')), false);
});
