import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { agentFixture, connection } from './helpers/agent-fixture.js';
import { csvCell } from '../src/custom-index.js';
import { fork } from 'node:child_process';
import { once } from 'node:events';

const grant = (acceso) => ({ action: 'accept', content: { acceso } });
const yes = { action: 'accept', content: { confirmar: true } };

async function authorized(t, { acceso = 'completo', observe = false, files } = {}) {
  const fixture = await agentFixture(t, { prefix: '.mind-props-test-', observe, files });
  const session = await fixture.open();
  const queue = [grant(acceso)];
  const call = fixture.agent(session, connection({ onElicit: () => queue.shift() ?? { action: 'decline' } }));
  const granted = await call('solicitar_acceso', { ruta: fixture.folder, acceso });
  assert.equal(granted.data.estado, 'autorizado');
  await session.ensureIndex(granted.data.carpeta.id);
  return { ...fixture, session, call, queue, folderId: granted.data.carpeta.id };
}

/** CSV mínimo para las pruebas (RFC 4180, sin BOM). */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const body = text.replace(/^﻿/u, '');
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (quoted) {
      if (char === '"' && body[index + 1] === '"') { cell += '"'; index += 1; } else if (char === '"') quoted = false; else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(cell); cell = ''; } else if (char === '\r' && body[index + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; index += 1; } else cell += char;
  }
  return rows;
}

test('propiedades: consultar requiere encontrar, asignar requiere escribir, y se usan para buscar', async (t) => {
  const reader = await authorized(t, { acceso: 'leer' });
  assert.deepEqual((await reader.call('propiedades', { ruta: 'notas.txt' })).data.propiedades, {});
  assert.equal((await reader.call('asignar_propiedades', { ruta: 'notas.txt', asignar: { estado: 'x' } })).code, 'ACCESS_NOT_GRANTED');

  const { call } = await authorized(t);
  const set = await call('asignar_propiedades', { ruta: 'Proyectos/presupuesto.md', asignar: { estado: 'revisar', importe: 4250, urgente: true } });
  assert.deepEqual(set.data.propiedades, { estado: 'revisar', importe: 4250, urgente: true });
  assert.equal((await call('asignar_propiedades', { ruta: 'no-existe.txt', asignar: { a: 1 } })).isError, true);
  assert.equal((await call('asignar_propiedades', { ruta: 'notas.txt', asignar: { a: { anidado: 1 } } })).isError, true);
  const found = await call('buscar', { propiedades: { estado: 'revisar' } });
  assert.deepEqual(found.data.resultados.map((item) => item.ruta), ['Proyectos/presupuesto.md']);
  assert.equal(found.data.resultados[0].propiedades.importe, 4250);
  assert.equal((await call('buscar', { propiedades: { estado: 'otro' } })).data.total, 0);
  const removed = await call('asignar_propiedades', { ruta: 'Proyectos/presupuesto.md', quitar: ['urgente'] });
  assert.deepEqual(removed.data.propiedades, { estado: 'revisar', importe: 4250 });
});

test('las propiedades siguen al elemento al moverlo o renombrarlo y no pasan a otro con el mismo nombre', async (t) => {
  const { call, folder, session, folderId, queue } = await authorized(t);
  await call('asignar_propiedades', { ruta: 'Proyectos/presupuesto.md', asignar: { estado: 'revisar' } });
  await call('renombrar', { ruta: 'Proyectos', nuevo_nombre: 'Proyectos 2026' });
  assert.deepEqual((await call('propiedades', { ruta: 'Proyectos 2026/presupuesto.md' })).data.propiedades, { estado: 'revisar' });
  assert.deepEqual((await call('propiedades', { ruta: 'Proyectos/presupuesto.md' })).data.propiedades, {});

  // Borrado fuera de Mind y otro archivo con el mismo nombre: no hereda nada.
  await fs.rm(path.join(folder, 'Proyectos 2026', 'presupuesto.md'));
  await session.reindex(folderId);
  await fs.writeFile(path.join(folder, 'Proyectos 2026', 'presupuesto.md'), 'otro\n');
  await session.reindex(folderId);
  assert.deepEqual((await call('propiedades', { ruta: 'Proyectos 2026/presupuesto.md' })).data.propiedades, {});

  // Retirar la carpeta invalida sus propiedades; reautorizarla no las revive.
  await call('asignar_propiedades', { ruta: 'notas.txt', asignar: { a: 1 } });
  await call('retirar_acceso', { todo: true });
  queue.push(grant('completo'));
  await call('solicitar_acceso', { ruta: folder, acceso: 'completo' });
  assert.deepEqual((await call('propiedades', { ruta: 'notas.txt' })).data.propiedades, {});
  void yes;
});

test('un reemplazo externo entre recorridos no hereda propiedades aunque conserve nombre, tamaño y fecha', async (t) => {
  const { call, folder, root, session, folderId } = await authorized(t);
  await call('asignar_propiedades', { ruta: 'notas.txt', asignar: { estado: 'anterior' } });
  const file = path.join(folder, 'notas.txt');
  const previous = await fs.stat(file);
  const content = await fs.readFile(file);
  // Mantener vivo el objeto anterior impide reutilizar su inode/FileId.
  await fs.rename(file, path.join(root, 'original ficticio.txt'));
  await fs.writeFile(file, content);
  await fs.utimes(file, previous.atime, previous.mtime);
  await session.reindex(folderId);
  assert.deepEqual((await call('propiedades', { ruta: 'notas.txt' })).data.propiedades, {});
  assert.equal((await call('buscar', { propiedades: { estado: 'anterior' } })).data.total, 0);
  await call('asignar_propiedades', { ruta: 'notas.txt', asignar: { nuevo: true } });
  assert.deepEqual((await call('propiedades', { ruta: 'notas.txt' })).data.propiedades, { nuevo: true });
});

test('modificar por Mind conserva propiedades y las liga al nuevo objeto de la publicación atómica', async (t) => {
  const { call, session, folderId } = await authorized(t);
  await call('asignar_propiedades', { ruta: 'notas.txt', asignar: { estado: 'revisado' } });
  const before = (await session.motor.readFolderIndex(folderId)).entries.find((entry) => entry.path === 'notas.txt').identity;
  const read = await call('leer', { ruta: 'notas.txt' });
  const modified = await call('modificar', { ruta: 'notas.txt', version: read.data.version, contenido: 'Texto nuevo ficticio\n' });
  assert.equal(modified.isError, false, JSON.stringify(modified.data));
  const after = (await session.motor.readFolderIndex(folderId)).entries.find((entry) => entry.path === 'notas.txt').identity;
  assert.ok(before);
  assert.ok(after);
  assert.notEqual(after, before);
  await session.reindex(folderId);
  assert.deepEqual((await call('propiedades', { ruta: 'notas.txt' })).data.propiedades, { estado: 'revisado' });
});

test('reponer propiedades de un movimiento no las atribuye a un reemplazo del destino', async (t) => {
  const { call, folder, root, session, folderId } = await authorized(t);
  await call('asignar_propiedades', { ruta: 'notas.txt', asignar: { estado: 'original' } });
  const taken = await session.motor.takeProperties(folderId, 'notas.txt');
  assert.ok(taken[0].identity);
  const file = path.join(folder, 'notas.txt');
  await fs.rename(file, path.join(root, 'original movido ficticio.txt'));
  await fs.writeFile(file, 'otro objeto ficticio\n');
  await session.reindex(folderId);
  assert.equal((await session.motor.putProperties(folderId, 'notas.txt', taken)).restored, 0);
  assert.equal((await session.motor.putProperties(folderId, 'notas.txt', [{ path: '', properties: { antiguo: true } }])).restored, 0);
  assert.deepEqual(await session.motor.getProperties(folderId, 'notas.txt'), {});
});

test('índices antiguos se reconcilian y propiedades sin identidad se preservan sin atribuirlas', async (t) => {
  const { call, session, folderId } = await authorized(t);
  await call('asignar_propiedades', { ruta: 'notas.txt', asignar: { estado: 'histórico' } });
  const base = session.motor.baseDirectory;
  const propertiesFile = path.join(base, `folder-properties-${folderId}.json`);
  const properties = JSON.parse(await fs.readFile(propertiesFile, 'utf8'));
  properties.version = 1;
  for (const entry of properties.entries) delete entry.identity;
  await fs.writeFile(propertiesFile, `${JSON.stringify(properties)}\n`);
  const original = await fs.readFile(propertiesFile, 'utf8');
  // Índice JSON v2 heredado (sin identidades): r3 lo lee y lo migra a catalog.sqlite.
  const indexFile = path.join(base, `folder-index-${folderId}.json`);
  const current = await session.motor.readFolderIndex(folderId);
  const index = { format: 'mind-folder-index', version: 2, ...current,
    entries: current.entries.map(({ identity, ...entry }) => entry) };
  await fs.writeFile(indexFile, `${JSON.stringify(index)}\n`);
  const migrated = await session.motor.readFolderIndex(folderId);
  assert.ok(migrated.entries.length > 0);
  assert.ok(migrated.entries.every((entry) => entry.identity === null), 'sin identidad tras migrar');
  await assert.rejects(fs.access(indexFile), { code: 'ENOENT' });
  await assert.rejects(session.motor.setProperties(folderId, 'notas.txt', { set: { nuevo: true } }), { code: 'ENTRY_IDENTITY_UNAVAILABLE' });
  await session.reindex(folderId);
  assert.deepEqual((await call('propiedades', { ruta: 'notas.txt' })).data.propiedades, {});
  assert.equal(await fs.readFile(propertiesFile, 'utf8'), original, 'consultar no destruye propiedades históricas');
  await call('asignar_propiedades', { ruta: 'Proyectos/presupuesto.md', asignar: { nuevo: true } });
  const saved = JSON.parse(await fs.readFile(propertiesFile, 'utf8'));
  const historical = saved.entries.find((entry) => entry.path === 'notas.txt');
  assert.equal(historical.identity, null);
  assert.deepEqual(historical.properties, { estado: 'histórico' });
});

test('índice CSV: crea el archivo con los campos elegidos, escapa los datos y no reemplaza nada', async (t) => {
  const { call, folder } = await authorized(t, {
    files: {
      'Facturas/f-001.pdf': 'pdf ficticio', 'Facturas/f-002, copia.pdf': 'pdf ficticio 2', 'Facturas/notas.txt': 'x',
      'ya-existe.csv': 'archivo del usuario\n',
    },
  });
  await call('asignar_propiedades', { ruta: 'Facturas/f-001.pdf', asignar: { cliente: '=HYPERLINK("x")', importe: 120.5 } });
  await call('asignar_propiedades', { ruta: 'Facturas/f-002, copia.pdf', asignar: { cliente: 'Comillas "dobles", y coma' } });
  const occupied = await call('crear_indice', { nombre: 'Ocupado', campos: ['ruta'], ruta_csv: 'ya-existe.csv' });
  assert.equal(occupied.data.error?.codigo, 'CUSTOM_INDEX_DESTINATION_EXISTS', JSON.stringify(occupied.data));
  assert.equal(await fs.readFile(path.join(folder, 'ya-existe.csv'), 'utf8'), 'archivo del usuario\n');

  const created = await call('crear_indice', {
    nombre: 'Facturas', dentro_de: 'Facturas', extensiones: ['pdf'], campos: ['nombre', 'bytes', 'propiedad:cliente', 'propiedad:importe'],
    ruta_csv: 'Índices/facturas.csv',
  });
  assert.equal(created.data.error?.codigo, 'PARENT_NOT_FOUND', 'no crea carpetas intermedias');
  await call('crear_carpeta', { ruta: 'Índices' });
  const second = await call('actualizar_indice', { id: created.data.id });
  assert.equal(second.data.estado, 'creado', JSON.stringify(second.data));
  assert.equal(second.data.filas, 2);
  const text = await fs.readFile(path.join(folder, 'Índices', 'facturas.csv'), 'utf8');
  assert.ok(text.startsWith('﻿'));
  assert.deepEqual(parseCsv(text), [
    ['nombre', 'bytes', 'propiedad:cliente', 'propiedad:importe'],
    ['f-001.pdf', '12', `'=HYPERLINK("x")`, '120.5'],
    ['f-002, copia.pdf', '14', 'Comillas "dobles", y coma', ''],
  ]);
  assert.equal(csvCell('-1'), "'-1");
  assert.equal((await call('crear_indice', { nombre: 'Malo', campos: ['inventado'], ruta_csv: 'x.csv' })).isError, true);
  assert.equal((await call('crear_indice', { nombre: 'Malo', campos: ['ruta'], ruta_csv: 'x.txt' })).isError, true);
});

test('índice CSV: actualizar, cambiar el esquema, cambios externos, CSV movido y permisos retirados', async (t) => {
  const { call, folder, queue, session } = await authorized(t);
  const created = await call('crear_indice', { nombre: 'Todo', campos: ['ruta', 'tipo'], ruta_csv: 'indice.csv' });
  assert.equal(created.data.estado, 'creado', JSON.stringify(created.data));
  const file = path.join(folder, 'indice.csv');
  assert.deepEqual(parseCsv(await fs.readFile(file, 'utf8')).map((row) => row[0]), ['ruta', 'Proyectos/presupuesto.md', 'notas.txt']);

  await fs.writeFile(path.join(folder, 'nuevo.txt'), 'n');
  const updated = await call('actualizar_indice', { id: created.data.id });
  assert.equal(updated.data.estado, 'actualizado');
  assert.ok(parseCsv(await fs.readFile(file, 'utf8')).some((row) => row[0] === 'nuevo.txt'));
  assert.ok(!parseCsv(await fs.readFile(file, 'utf8')).some((row) => row[0] === 'indice.csv'), 'el CSV no se indexa a sí mismo');
  assert.equal((await call('actualizar_indice', { id: created.data.id })).data.estado, 'sin-cambios');

  const schemaChange = await call('modificar_indice', { id: created.data.id, campos: ['nombre', 'extension', 'bytes'] });
  assert.equal(schemaChange.data.estado, 'actualizado', JSON.stringify(schemaChange.data));
  assert.deepEqual(parseCsv(await fs.readFile(file, 'utf8'))[0], ['nombre', 'extension', 'bytes']);

  // Editado fuera de Mind: no se sobrescribe.
  await fs.appendFile(file, 'fila del usuario\r\n');
  assert.equal((await call('actualizar_indice', { id: created.data.id })).code, 'CUSTOM_INDEX_MODIFIED_OUTSIDE');
  assert.match(await fs.readFile(file, 'utf8'), /fila del usuario/);

  // Movido por el usuario: se crea de nuevo sin tocar el movido.
  await fs.rename(file, path.join(folder, 'mio.csv'));
  assert.equal((await call('actualizar_indice', { id: created.data.id })).data.estado, 'creado');
  assert.match(await fs.readFile(path.join(folder, 'mio.csv'), 'utf8'), /fila del usuario/);

  const listed = (await call('indices_personalizados')).data;
  assert.equal(listed.total, 1);
  assert.equal(listed.indices[0].ultima_actualizacion.estado, 'ok');

  // Sin "escribir" ya no se actualiza.
  await call('retirar_acceso', { permisos: ['escribir', 'organizar'] });
  assert.equal((await call('actualizar_indice', { id: created.data.id })).code, 'CUSTOM_INDEX_INVALID');
  queue.push(grant('completo'));
  await call('solicitar_acceso', { ruta: folder, acceso: 'completo' });
  assert.equal((await call('actualizar_indice', { id: created.data.id })).data.estado !== undefined, true);
  // Retirar la carpeta invalida la definición: reautorizar no la revive.
  await call('retirar_acceso', { todo: true });
  queue.push(grant('completo'));
  await call('solicitar_acceso', { ruta: folder, acceso: 'completo' });
  assert.equal((await call('actualizar_indice', { id: created.data.id })).code, 'CUSTOM_INDEX_INVALID');
  assert.equal((await call('retirar_indice', { id: created.data.id })).data.estado, 'retirado');
  assert.equal((await call('indices_personalizados')).data.total, 0);
  void session;
});

test('índice CSV "al_cambiar": se actualiza solo durante la sesión cuando cambia la carpeta', async (t) => {
  const { call, folder } = await authorized(t, { observe: true });
  const created = await call('crear_indice', { nombre: 'Vivo', campos: ['ruta'], ruta_csv: 'vivo.csv', actualizar: 'al_cambiar' });
  assert.equal(created.data.estado, 'creado', JSON.stringify(created.data));
  await fs.writeFile(path.join(folder, 'aparece.txt'), 'hola');
  const deadline = Date.now() + 20_000;
  let rows = [];
  while (Date.now() < deadline) {
    rows = parseCsv(await fs.readFile(path.join(folder, 'vivo.csv'), 'utf8')).map((row) => row[0]);
    if (rows.includes('aparece.txt')) break;
    await delay(250);
  }
  assert.ok(rows.includes('aparece.txt'), `filas: ${rows.join(', ')}`);
});

function independentProcess(t, config) {
  const child = fork(new URL('./fixtures/properties_process.mjs', import.meta.url), [JSON.stringify(config)], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  });
  return {
    child,
    async message(phase) {
      const [message] = await once(child, 'message');
      assert.equal(message.phase, phase, JSON.stringify(message));
      return message;
    },
    async exit() {
      const [code, signal] = await exited;
      assert.equal(code, 0, `signal=${signal} ${stderr}`);
    },
  };
}

test('propiedades: dos procesos conservan ambas asignaciones sobre el mismo archivo', { timeout: 30_000 }, async (t) => {
  const { layout, folderId, session } = await authorized(t);
  const first = independentProcess(t, { operation: 'properties', layout, folderId, properties: { estado: 'revisado' } });
  const second = independentProcess(t, { operation: 'properties', layout, folderId, properties: { importe: 42 } });
  await Promise.all([first.message('ready'), second.message('ready')]);
  const results = Promise.all([first.message('result'), second.message('result')]);
  first.child.send('continue');
  second.child.send('continue');
  await results;
  await Promise.all([first.exit(), second.exit()]);
  assert.deepEqual(await session.motor.getProperties(folderId, 'notas.txt'), { estado: 'revisado', importe: 42 });
});

test('CSV: otro proceso recupera la definición y detecta modificaciones externas después de reiniciar', { timeout: 30_000 }, async (t) => {
  const { call, folder, layout } = await authorized(t);
  const created = await call('crear_indice', { nombre: 'Persistente', campos: ['ruta'], ruta_csv: 'persistente.csv' });
  assert.equal(created.data.estado, 'creado', JSON.stringify(created.data));
  await fs.writeFile(path.join(folder, 'nuevo-proceso.txt'), 'dato ficticio');
  const other = independentProcess(t, { operation: 'csv', layout, id: created.data.id });
  const { result } = await other.message('result');
  await other.exit();
  assert.equal(result.status, 'actualizado');
  const file = path.join(folder, 'persistente.csv');
  assert.ok(parseCsv(await fs.readFile(file, 'utf8')).some((row) => row[0] === 'nuevo-proceso.txt'));
  await fs.appendFile(file, 'fila externa\r\n');
  assert.equal((await call('actualizar_indice', { id: created.data.id })).code, 'CUSTOM_INDEX_MODIFIED_OUTSIDE');
  assert.match(await fs.readFile(file, 'utf8'), /fila externa/);
});

test('las propiedades de descendientes acompañan un movimiento entre carpetas y las exclusiones no se exportan al CSV', async (t) => {
  const { call, root, queue, folderId, session } = await authorized(t);
  await call('asignar_propiedades', { ruta: 'Proyectos/presupuesto.md', asignar: { estado: 'revisado' } });
  const destination = path.join(root, 'Destino ficticio');
  await fs.mkdir(destination);
  queue.push(grant('completo'));
  const granted = await call('solicitar_acceso', { ruta: destination, acceso: 'completo' });
  const destinationId = granted.data.carpeta.id;
  const moved = await call('mover', { carpeta: folderId, desde: 'Proyectos', hasta: 'Archivo', carpeta_destino: destinationId });
  assert.equal(moved.data.estado, 'movido', JSON.stringify(moved.data));
  assert.deepEqual(await session.motor.getProperties(folderId, 'Proyectos/presupuesto.md'), {});
  assert.deepEqual((await call('propiedades', { carpeta: destinationId, ruta: 'Archivo/presupuesto.md' })).data.propiedades, { estado: 'revisado' });
  await call('retirar_acceso', { carpeta: destinationId, excluir: ['Archivo'] });
  assert.equal((await call('propiedades', { carpeta: destinationId, ruta: 'Archivo/presupuesto.md' })).code, 'PATH_EXCLUDED');
  const created = await call('crear_indice', { carpeta: destinationId, nombre: 'Sin excluidos', campos: ['ruta', 'propiedad:estado'], ruta_csv: 'indice.csv' });
  assert.equal(created.data.estado, 'creado', JSON.stringify(created.data));
  assert.deepEqual(parseCsv(await fs.readFile(path.join(destination, 'indice.csv'), 'utf8')), [['ruta', 'propiedad:estado']]);
});
