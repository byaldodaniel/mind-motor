import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { agentFixture, connection, answers, scriptedPrompt } from './helpers/agent-fixture.js';
import { authorizeConsole } from '../src/console.js';

const grant = (acceso) => ({ action: 'accept', content: { acceso } });
const yes = { action: 'accept', content: { confirmar: true } };
const exists = (file) => fs.access(file).then(() => true, () => false);
const names = async (call, consulta = '') => (await call('buscar', { consulta })).data.resultados.map((item) => item.ruta).sort();

async function authorized(t, { acceso = 'completo', onElicit = null, ...options } = {}) {
  const fixture = await agentFixture(t, { prefix: '.mind-organize-test-', ...options });
  const session = await fixture.open();
  const queue = [grant(acceso)];
  const conn = connection({ onElicit: (params) => (queue.length > 0 ? queue.shift() : onElicit ? onElicit(params) : { action: 'decline' }) });
  const call = fixture.agent(session, conn);
  const granted = await call('solicitar_acceso', { ruta: fixture.folder, acceso });
  assert.equal(granted.data.estado, 'autorizado', JSON.stringify(granted.data));
  await session.ensureIndex(granted.data.carpeta.id);
  return { ...fixture, session, conn, call, folderId: granted.data.carpeta.id, queue };
}

test('organizar exige el permiso "organizar"; leer no basta y las rutas no pueden salir de la carpeta', async (t) => {
  const { call, folder } = await authorized(t, { acceso: 'leer' });
  for (const [name, args] of [
    ['crear_carpeta', { ruta: 'Nueva' }], ['mover', { desde: 'notas.txt', hasta: 'otra.txt' }],
    ['renombrar', { ruta: 'notas.txt', nuevo_nombre: 'x.txt' }], ['borrar', { ruta: 'notas.txt' }],
  ]) {
    const result = await call(name, args);
    assert.equal(result.code, 'ACCESS_NOT_GRANTED', name);
  }
  assert.ok(await exists(path.join(folder, 'notas.txt')));
});

test('crear carpeta, mover y renombrar sin reemplazar nunca; el índice queda al día', async (t) => {
  const { call, folder } = await authorized(t, { files: { 'Proyectos/acta ñ.txt': 'Acta\n' } });
  assert.equal((await call('crear_carpeta', { ruta: 'Archivo 2026' })).data.estado, 'creada');
  assert.equal((await call('crear_carpeta', { ruta: 'Archivo 2026' })).code, 'FILE_EXISTS');
  assert.equal((await call('crear_carpeta', { ruta: 'No/Existe' })).code, 'PARENT_NOT_FOUND');
  for (const bad of ['../fuera', '/absoluta', 'a/../b', '.papelera-mind/x']) {
    const result = await call('crear_carpeta', { ruta: bad });
    assert.ok(result.isError, bad);
  }

  const moved = await call('mover', { desde: 'Proyectos/acta ñ.txt', hasta: 'Archivo 2026/acta ñ.txt' });
  assert.equal(moved.data.estado, 'movido', JSON.stringify(moved.data));
  assert.equal(await fs.readFile(path.join(folder, 'Archivo 2026', 'acta ñ.txt'), 'utf8'), 'Acta\n');
  assert.ok(!(await exists(path.join(folder, 'Proyectos', 'acta ñ.txt'))));
  assert.deepEqual(await names(call, 'acta'), ['Archivo 2026/acta ñ.txt']);

  // Nunca reemplaza: el destino ocupado se conserva intacto.
  const occupied = await call('mover', { desde: 'notas.txt', hasta: 'Proyectos/presupuesto.md' });
  assert.equal(occupied.code, 'FILE_EXISTS');
  assert.match(await fs.readFile(path.join(folder, 'Proyectos', 'presupuesto.md'), 'utf8'), /Presupuesto ficticio/);
  assert.equal((await call('mover', { desde: 'Proyectos', hasta: 'Proyectos/dentro' })).code, 'INVALID_MOVE');

  const renamed = await call('renombrar', { ruta: 'notas.txt', nuevo_nombre: 'Notas renombradas.txt' });
  assert.equal(renamed.data.hasta, 'Notas renombradas.txt');
  assert.equal((await call('renombrar', { ruta: 'Proyectos', nuevo_nombre: 'a/b' })).code, 'INVALID_ARGUMENTS');
  assert.ok((await names(call)).includes('Notas renombradas.txt'));
  assert.ok(!(await names(call)).includes('notas.txt'));
});

test('borrar pide confirmación cada vez, va a la papelera de Mind y se restaura con sus propiedades', async (t) => {
  const { call, conn, folder, folderId, session, queue } = await authorized(t);
  await session.motor.setProperties(folderId, 'notas.txt', { set: { estado: 'revisar' } });

  queue.push({ action: 'decline' });
  assert.equal((await call('borrar', { ruta: 'notas.txt', motivo: 'limpieza' })).data.estado, 'rechazado');
  assert.ok(await exists(path.join(folder, 'notas.txt')));
  const asked = conn.asked.at(-1).params;
  assert.match(asked.message, /notas\.txt/);
  assert.match(asked.message, /papelera de Mind/);

  queue.push(yes);
  const deleted = await call('borrar', { ruta: 'notas.txt' });
  assert.equal(deleted.data.estado, 'en_papelera', JSON.stringify(deleted.data));
  assert.ok(!(await exists(path.join(folder, 'notas.txt'))));
  assert.ok(await exists(deleted.data.ubicacion_en_papelera));
  assert.ok(!(await names(call)).some((item) => item.includes('notas')), 'la papelera no se indexa');
  const listed = (await call('papelera')).data;
  assert.equal(listed.total, 1);
  assert.equal(listed.elementos[0].propiedades, 1);
  const removed = (await call('eliminados')).data.eliminados.find((item) => item.ruta === 'notas.txt');
  assert.match(removed.por ?? removed.origen ?? JSON.stringify(removed), /papelera de Mind/);

  // Restaurar con el nombre ocupado no reemplaza: usa un nombre nuevo.
  await fs.writeFile(path.join(folder, 'notas.txt'), 'Otro archivo con el mismo nombre\n');
  const restored = await call('restaurar', { id: deleted.data.id });
  assert.equal(restored.data.estado, 'restaurado', JSON.stringify(restored.data));
  assert.equal(restored.data.renombrado, true);
  assert.equal(await fs.readFile(path.join(folder, 'notas.txt'), 'utf8'), 'Otro archivo con el mismo nombre\n');
  assert.equal(await fs.readFile(restored.data.ruta_absoluta, 'utf8'), 'Notas ficticias\n');
  assert.deepEqual(await session.motor.getProperties(folderId, restored.data.ruta), { estado: 'revisar' });
  assert.equal((await call('papelera')).data.total, 0);
  assert.equal((await call('restaurar', { id: deleted.data.id })).code, 'TRASH_ENTRY_NOT_FOUND');
});

test('vaciar exige dos confirmaciones y la palabra exacta; después no queda nada', async (t) => {
  const { call, folder, queue } = await authorized(t);
  queue.push(yes);
  const deleted = await call('borrar', { ruta: 'Proyectos' });
  assert.equal(deleted.data.estado, 'en_papelera');

  queue.push(yes, { action: 'accept', content: { texto: 'vaciarlo' } });
  assert.equal((await call('vaciar_papelera', { id: deleted.data.id })).data.estado, 'rechazado');
  assert.ok(await exists(path.dirname(deleted.data.ubicacion_en_papelera)));

  queue.push({ action: 'decline' });
  assert.equal((await call('vaciar_papelera', { id: deleted.data.id })).data.estado, 'rechazado');

  queue.push(yes, { action: 'accept', content: { texto: 'VACIAR' } });
  const purged = await call('vaciar_papelera', { id: deleted.data.id });
  assert.equal(purged.data.estado, 'eliminado', JSON.stringify(purged.data));
  assert.ok(purged.data.elementos >= 2);
  assert.ok(!(await exists(path.dirname(deleted.data.ubicacion_en_papelera))));
  assert.deepEqual(await fs.readdir(path.join(folder, '.papelera-mind')), []);
  assert.equal((await call('papelera')).data.total, 0);
});

test('sin formularios el borrado queda pendiente y el usuario lo decide en la consola', async (t) => {
  const fixture = await agentFixture(t, { prefix: '.mind-organize-test-' });
  const session = await fixture.open();
  const setup = fixture.agent(session, connection({ onElicit: () => grant('completo') }));
  const granted = await setup('solicitar_acceso', { ruta: fixture.folder, acceso: 'completo' });
  await session.ensureIndex(granted.data.carpeta.id);
  const call = fixture.agent(session, connection());

  const pending = await call('borrar', { ruta: 'notas.txt', motivo: 'duplicado' });
  assert.equal(pending.data.estado, 'pendiente');
  assert.ok(await exists(path.join(fixture.folder, 'notas.txt')), 'nada se toca hasta que el usuario confirma');

  const refused = scriptedPrompt('n');
  await authorizeConsole({ session, prompt: refused });
  assert.ok(refused.lines.some((line) => line.includes('notas.txt')));
  assert.ok(await exists(path.join(fixture.folder, 'notas.txt')));

  await call('borrar', { ruta: 'notas.txt' });
  const approved = scriptedPrompt('s');
  assert.equal(await authorizeConsole({ session, prompt: approved }), 1);
  assert.ok(!(await exists(path.join(fixture.folder, 'notas.txt'))));
  const [entry] = (await call('papelera')).data.elementos;
  assert.match(entry.por, /consola de Mind/);

  await call('vaciar_papelera', { id: entry.id });
  const wrongWord = scriptedPrompt('s', 'no');
  await authorizeConsole({ session, prompt: wrongWord });
  assert.equal((await call('papelera')).data.total, 1);
  await call('vaciar_papelera', { id: entry.id });
  assert.equal(await authorizeConsole({ session, prompt: scriptedPrompt('s', 'VACIAR') }), 1);
  assert.equal((await call('papelera')).data.total, 0);
});

test('mover entre dos carpetas autorizadas exige "organizar" en ambas y nunca entre carpetas anidadas', async (t) => {
  const { call, root, folder, folderId, queue, session } = await authorized(t);
  const second = path.join(root, 'Segunda ficticia');
  await fs.mkdir(second);
  queue.push(grant('leer'));
  const other = (await call('solicitar_acceso', { ruta: second, acceso: 'leer' })).data.carpeta;
  await session.ensureIndex(other.id);
  assert.equal((await call('mover', { carpeta: folderId, desde: 'notas.txt', hasta: 'notas.txt', carpeta_destino: other.id })).code, 'ACCESS_NOT_GRANTED');
  queue.push(grant('completo'));
  await call('solicitar_acceso', { ruta: second, acceso: 'completo' });
  const moved = await call('mover', { carpeta: folderId, desde: 'notas.txt', hasta: 'notas.txt', carpeta_destino: other.id });
  assert.equal(moved.data.estado, 'movido', JSON.stringify(moved.data));
  assert.ok(!(await exists(path.join(folder, 'notas.txt'))));
  assert.equal(await fs.readFile(path.join(second, 'notas.txt'), 'utf8'), 'Notas ficticias\n');
  assert.deepEqual((await call('buscar', { consulta: 'notas', carpetas: [other.id] })).data.resultados.map((item) => item.ruta), ['notas.txt']);

  queue.push(grant('completo'));
  const nested = (await call('solicitar_acceso', { ruta: path.join(folder, 'Proyectos'), acceso: 'completo' })).data;
  if (nested.estado === 'autorizado') {
    const result = await call('mover', { carpeta: folderId, desde: 'Proyectos/presupuesto.md', hasta: 'p.md', carpeta_destino: nested.carpeta.id });
    assert.equal(result.code, 'INVALID_MOVE');
  }
});

test('exclusiones, enlaces y revocación: nada fuera de lo autorizado', async (t) => {
  const { call, folder, folderId, session, root, queue } = await authorized(t, { files: { 'Privado/secreto.txt': 'no\n' } });
  await call('retirar_acceso', { excluir: ['Privado'] });
  assert.equal((await call('mover', { desde: 'Privado/secreto.txt', hasta: 'fuera.txt' })).code, 'PATH_EXCLUDED');
  assert.equal((await call('mover', { desde: 'notas.txt', hasta: 'Privado/notas.txt' })).code, 'PATH_EXCLUDED');
  queue.push(yes);
  assert.equal((await call('borrar', { ruta: 'Privado' })).isError, true);
  assert.ok(await exists(path.join(folder, 'Privado', 'secreto.txt')));

  if (process.platform !== 'win32') {
    const outside = path.join(root, 'fuera');
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(folder, 'enlace'));
    await session.reindex(folderId);
    const result = await call('mover', { desde: 'notas.txt', hasta: 'enlace/notas.txt' });
    assert.ok(result.isError, JSON.stringify(result.data));
    assert.deepEqual(await fs.readdir(outside), []);
  }

  queue.push(yes);
  const deleted = await call('borrar', { ruta: 'notas.txt' });
  assert.equal(deleted.data.estado, 'en_papelera');
  await call('retirar_acceso', { todo: true });
  assert.equal((await call('restaurar', { id: deleted.data.id, carpeta: folderId })).code, 'FOLDER_NOT_AUTHORIZED');
  const base = session.motor.baseDirectory;
  assert.ok(!(await fs.readdir(base)).some((name) => name.startsWith('trash-')), 'el registro de la papelera se retira con la carpeta');
  assert.ok(await exists(deleted.data.ubicacion_en_papelera), 'los originales nunca se borran al retirar la autorización');
});

test('dos movimientos simultáneos del mismo archivo: solo uno ocurre y nada se pierde', async (t) => {
  const { call, folder } = await authorized(t);
  const results = await Promise.all([
    call('mover', { desde: 'notas.txt', hasta: 'uno.txt' }),
    call('mover', { desde: 'notas.txt', hasta: 'dos.txt' }),
  ]);
  const ok = results.filter((result) => !result.isError);
  assert.equal(ok.length, 1, JSON.stringify(results.map((result) => result.data)));
  const present = (await fs.readdir(folder)).filter((name) => name.endsWith('.txt'));
  assert.equal(present.length, 1);
  assert.equal(await fs.readFile(path.join(folder, present[0]), 'utf8'), 'Notas ficticias\n');
});

test('revocar mientras se confirma borrar impide usar la respuesta tardía', async (t) => {
  let entered;
  const waiting = new Promise((resolve) => { entered = resolve; });
  let answer;
  const response = new Promise((resolve) => { answer = resolve; });
  const { call, folder } = await authorized(t, {
    onElicit: async () => { entered(); return response; },
  });
  const deleting = call('borrar', { ruta: 'notas.txt' });
  await waiting;
  try {
    const revoked = await call('retirar_acceso', { todo: true });
    assert.ok(!revoked.isError, JSON.stringify(revoked.data));
  } finally {
    answer(yes);
  }
  const result = await deleting;
  assert.ok(result.isError, JSON.stringify(result.data));
  assert.equal(await fs.readFile(path.join(folder, 'notas.txt'), 'utf8'), 'Notas ficticias\n');
  assert.ok(!(await exists(path.join(folder, '.papelera-mind'))));
});
