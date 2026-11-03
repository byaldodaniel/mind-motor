import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startMcp } from './helpers/mcp-client.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mind-workspace-'));
  const a = path.join(root, 'Proyecto A');
  const b = path.join(root, 'Proyecto B');
  await fs.mkdir(a); await fs.mkdir(b);
  await fs.writeFile(path.join(a, 'nota.txt'), 'Proyecto A ficticio');
  await fs.writeFile(path.join(b, 'nota.txt'), 'Proyecto B ficticio');
  const clients = [];
  t.after(async () => {
    for (const client of clients) { await client.close(); }
    await fs.rm(root, { recursive: true, force: true });
  });
  return { a, b, start(options = {}) {
    const client = startMcp({ args: ['--base', path.join(root, 'Base')], capabilities: {}, ...options });
    clients.push(client); return client;
  } };
}

test('carpeta del iniciador: lectura, escritura y continuidad sin formularios; fuera del ámbito se deniega', async t => {
  const f = await fixture(t);
  const client = f.start({ args: ['--base', path.join(path.dirname(f.a), 'Base'), '--carpeta', f.a] });
  await client.initialize();
  assert.equal((await client.call('leer', { ruta: 'nota.txt' })).isError, false);
  assert.equal((await client.call('crear', { ruta: 'nuevo.txt', contenido: 'Ficticio' })).isError, false);
  assert.equal((await client.call('continuidad_registrar', { contenido: 'Decisión ficticia' })).isError, false);
  assert.equal((await client.call('leer', { ruta: '../Proyecto B/nota.txt' })).isError, true);
  assert.equal((await client.call('solicitar_acceso', { ruta: f.b, acceso: 'completo' })).data.error.codigo, 'WORKSPACE_REQUIRED');
  assert.equal(client.elicitations.length, 0);
  const other = f.start(); await other.initialize();
  assert.equal((await other.call('leer', { carpeta: f.a, ruta: 'nota.txt' })).isError, true, 'el acceso automático no se persiste como permiso global');
});

test('raíces MCP: el cambio de proyecto retira el acceso anterior y una lista vacía cierra el ámbito', async t => {
  const f = await fixture(t);
  let roots = [{ uri: pathToFileURL(f.a).href }];
  const client = f.start({ capabilities: { roots: { listChanged: true } }, roots: () => roots });
  await client.initialize();
  assert.equal((await client.call('leer', { ruta: 'nota.txt' })).isError, false);
  roots = [{ uri: pathToFileURL(f.b).href }];
  client.notify('notifications/roots/list_changed');
  const state = await client.call('estado');
  assert.equal(state.data.carpetas.length, 1);
  assert.equal(state.data.carpetas[0].ruta, await fs.realpath(f.b));
  assert.equal((await client.call('leer', { carpeta: f.a, ruta: 'nota.txt' })).isError, true);
  assert.equal((await client.call('leer', { ruta: 'nota.txt' })).isError, false);
  roots = [];
  client.notify('notifications/roots/list_changed');
  assert.deepEqual((await client.call('estado')).data.carpetas, []);
  assert.equal((await client.call('leer', { carpeta: f.b, ruta: 'nota.txt' })).isError, true);
  assert.equal(client.elicitations.length, 0);
});

test('una raíz inválida o que se solapa con Mind no abre acceso', async t => {
  const f = await fixture(t);
  const client = f.start({ capabilities: { roots: {} }, roots: [{ uri: 'https://example.com' }] });
  await client.initialize();
  assert.deepEqual((await client.call('estado')).data.carpetas, []);
  assert.equal((await client.call('leer', { ruta: 'nota.txt' })).isError, true);
});

test('sin raíces MCP, el directorio de inicio del cliente abre el proyecto sin formularios', async t => {
  const f = await fixture(t);
  const client = f.start({ cwd: f.a });
  await client.initialize();
  assert.equal((await client.call('leer', { ruta: 'nota.txt' })).isError, false);
  assert.equal(client.elicitations.length, 0);
});

test('la carpeta abierta queda observada desde la primera sesión', async t => {
  const f = await fixture(t);
  const client = f.start({ cwd: f.a });
  await client.initialize();
  assert.equal((await client.call('leer', { ruta: 'nota.txt' })).isError, false);
  await fs.writeFile(path.join(f.a, 'externo.txt'), 'Cambio ficticio fuera de Mind');
  let status;
  const deadline = Date.now() + 10000;
  do {
    status = (await client.call('estado')).data.carpetas[0];
    if (status.indice.archivos === 2) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  assert.equal(status.observacion, 'watching');
  assert.equal(status.indice.archivos, 2, 'el observador publica el cambio sin una búsqueda que fuerce reconciliación');
});

test('el acceso automático conserva exclusiones, reducciones explícitas y la confirmación al borrar', async t => {
  const f = await fixture(t);
  const client = f.start({ cwd: f.a });
  await client.initialize();
  const state = await client.call('estado');
  const id = state.data.carpetas[0].id;
  const removed = await client.call('borrar', { carpeta: id, ruta: 'nota.txt' });
  assert.equal(removed.data.estado, 'pendiente');
  assert.equal(await fs.readFile(path.join(f.a, 'nota.txt'), 'utf8'), 'Proyecto A ficticio');
  await client.call('retirar_acceso', { carpeta: id, excluir: ['nota.txt'] });
  assert.equal((await client.call('leer', { ruta: 'nota.txt' })).isError, true);
  await client.call('retirar_acceso', { carpeta: id, permisos: ['escribir'] });
  assert.equal((await client.call('crear', { ruta: 'sin-permiso.txt', contenido: 'ficticio' })).isError, true);
});
