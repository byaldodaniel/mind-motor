import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openMotor } from '../src/motor.js';
import { createIndexSearch, MAX_SEARCH_LIMIT } from '../src/search.js';

const motorDirectory = fileURLToPath(new URL('..', import.meta.url));
const development = path.dirname(motorDirectory);

async function write(file, content, modified) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
  if (modified) await fs.utimes(file, new Date(modified), new Date(modified));
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(development, '.mind-search-test-'));
  t.after(async () => {
    assert.equal(path.dirname(root), development);
    assert.ok(path.basename(root).startsWith('.mind-search-test-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const base = path.join(root, 'Base ficticia');
  const first = path.join(root, 'Información ficticia');
  const second = path.join(root, 'Archivo ficticio');
  await fs.mkdir(base);
  await write(path.join(first, 'Informe anual.md'), 'Contenido ficticio del informe', '2026-03-01T10:00:00Z');
  await write(path.join(first, 'notas.txt'), 'Notas ficticias', '2026-01-15T10:00:00Z');
  await write(path.join(first, 'Proyectos', 'plan-informe.pdf'), Buffer.alloc(2048), '2026-06-01T10:00:00Z');
  await fs.mkdir(path.join(first, 'Proyectos', 'Informes'));
  await write(path.join(second, 'informe.txt'), 'Otro informe ficticio', '2026-02-01T10:00:00Z');
  await write(path.join(second, 'Fotos', 'playa.jpg'), Buffer.alloc(4096), '2025-12-24T10:00:00Z');
  const motor = await openMotor({ baseDirectory: base });
  const one = await motor.authorizeFolder(first);
  const two = await motor.authorizeFolder(second);
  await motor.indexFolder(one.id);
  await motor.indexFolder(two.id);
  return { root, base, first, second, motor, one, two };
}

function refs(response) {
  return response.results.map((item) => `${item.folderId.slice(0, 4)}:${item.relativePath}`);
}

test('busca por nombre parcial sin distinguir mayúsculas ni acentos y devuelve referencias precisas', async (t) => {
  const { first, motor, one, two } = await fixture(t);
  const response = await motor.searchFiles({ folderIds: [one.id, two.id], query: 'INFÓRME' });
  // Relevancia: empieza por la consulta antes que la contiene; luego nombre, ruta y carpeta.
  assert.deepEqual(refs(response), [
    `${one.id.slice(0, 4)}:Informe anual.md`,
    `${two.id.slice(0, 4)}:informe.txt`,
    `${one.id.slice(0, 4)}:Proyectos/plan-informe.pdf`,
  ]);
  const exact = response.results[1];
  assert.deepEqual(Object.keys(exact).sort(), ['changedAt', 'createdAt', 'folderId', 'indexedAt', 'modifiedAt',
    'name', 'reason', 'relativePath', 'size', 'status', 'type']);
  assert.equal(exact.name, 'informe.txt');
  assert.equal(exact.size, Buffer.byteLength('Otro informe ficticio'));
  assert.equal(exact.status, 'indexed');
  const text = JSON.stringify(response);
  assert.ok(!text.includes(first) && !text.includes('ficticio del'), 'Sin rutas absolutas ni contenido');
  assert.deepEqual(response.scopes.map((scope) => scope.status), ['searched', 'searched']);
  assert.equal(response.scopes[0].complete, true);
  assert.deepEqual((await motor.searchFiles({ folderIds: [one.id], query: 'informacion' })).results, []);
  assert.deepEqual(refs(await motor.searchFiles({ folderIds: [one.id], query: 'informacion', field: 'path', types: ['directory'] })), []);
});

test('modos de coincidencia, campo de ruta y tipos', async (t) => {
  const { motor, one } = await fixture(t);
  const search = async (request) => refs(await motor.searchFiles({ folderIds: [one.id], ...request }))
    .map((item) => item.slice(5));
  assert.deepEqual(await search({ query: 'informe anual.md', match: 'exact' }), ['Informe anual.md']);
  assert.deepEqual(await search({ query: 'informe', match: 'exact' }), []);
  assert.deepEqual(await search({ query: 'plan', match: 'prefix' }), ['Proyectos/plan-informe.pdf']);
  assert.deepEqual(await search({ query: 'informe', match: 'prefix' }), ['Informe anual.md']);
  assert.deepEqual(await search({ query: 'proyectos/', field: 'path' }), ['Proyectos/plan-informe.pdf']);
  assert.deepEqual(await search({ query: 'informe', types: ['directory'] }), ['Proyectos/Informes']);
  assert.deepEqual(await search({ types: ['file', 'directory'], pathPrefix: 'Proyectos', sort: 'path' }),
    ['Proyectos/Informes', 'Proyectos/plan-informe.pdf']);
});

test('filtra por extensión, tamaño y fecha de modificación', async (t) => {
  const { motor, one, two } = await fixture(t);
  const search = async (request) => refs(await motor.searchFiles({ folderIds: [one.id, two.id], sort: 'path', ...request }))
    .map((item) => item.slice(5));
  assert.deepEqual(await search({ extensions: ['TXT'] }), ['informe.txt', 'notas.txt']);
  assert.deepEqual(await search({ extensions: ['.pdf', '.jpg'] }), ['Fotos/playa.jpg', 'Proyectos/plan-informe.pdf']);
  assert.deepEqual(await search({ minSize: 2048 }), ['Fotos/playa.jpg', 'Proyectos/plan-informe.pdf']);
  assert.deepEqual(await search({ minSize: 100, maxSize: 3000 }), ['Proyectos/plan-informe.pdf']);
  assert.deepEqual(await search({ modifiedAfter: '2026-02-01T10:00:00Z', modifiedBefore: '2026-06-01T10:00:00Z' }),
    ['Informe anual.md', 'informe.txt']);
  assert.deepEqual(await search({ query: 'informe', sort: 'modified' }),
    ['Proyectos/plan-informe.pdf', 'Informe anual.md', 'informe.txt']);
  assert.deepEqual(await search({ query: 'informe', sort: 'size' }),
    ['Proyectos/plan-informe.pdf', 'Informe anual.md', 'informe.txt']);
});

test('el orden es determinista y los límites informan el total y el truncamiento', async (t) => {
  const { motor, one, two } = await fixture(t);
  const all = await motor.searchFiles({ folderIds: [one.id, two.id] });
  const reversed = await motor.searchFiles({ folderIds: [two.id, one.id] });
  assert.deepEqual(reversed.results, all.results, 'El orden de los ámbitos no altera el resultado');
  assert.equal(all.total, 5);
  const pages = [];
  for (let offset = 0; offset < all.total; offset += 2) {
    const page = await motor.searchFiles({ folderIds: [one.id, two.id], limit: 2, offset });
    assert.equal(page.total, 5);
    assert.equal(page.truncated, offset + 2 < 5);
    pages.push(...page.results);
  }
  assert.deepEqual(pages, all.results);
  const last = await motor.searchFiles({ folderIds: [one.id], offset: 99 });
  assert.deepEqual([last.results, last.truncated], [[], false]);
});

test('valida la petición antes de leer índices', async (t) => {
  const { first, motor, one } = await fixture(t);
  const bad = [
    undefined, [], {}, { folderIds: [] }, { folderIds: [one.id, one.id] },
    { folderIds: Array.from({ length: 65 }, (_, index) => index.toString(16).padStart(64, '0')) },
    { folderIds: [one.id], path: first }, { folderIds: [one.id], query: 7 },
    { folderIds: [one.id], query: 'x'.repeat(257) }, { folderIds: [one.id], match: 'regex' },
    { folderIds: [one.id], types: ['unknown'] }, { folderIds: [one.id], types: [] },
    { folderIds: [one.id], extensions: ['../x'] }, { folderIds: [one.id], pathPrefix: '../fuera' },
    { folderIds: [one.id], pathPrefix: '/abs' }, { folderIds: [one.id], minSize: -1 },
    { folderIds: [one.id], modifiedAfter: 'ayer' }, { folderIds: [one.id], limit: 0 },
    { folderIds: [one.id], limit: MAX_SEARCH_LIMIT + 1 }, { folderIds: [one.id], offset: -1 },
    { folderIds: [one.id], includeUnverified: 'sí' }, { folderIds: [one.id], sort: 'random' },
  ];
  for (const request of bad) {
    await assert.rejects(motor.searchFiles(request), { code: 'INVALID_SEARCH' });
  }
  for (const folderIds of [[first], ['../escape'], ['A'.repeat(64)]]) {
    await assert.rejects(motor.searchFiles({ folderIds }), { code: 'INVALID_SCOPE_ID' });
  }
});

test('busca en los índices sin recorrer ni abrir las carpetas originales', async (t) => {
  const { root, base, first, one } = await fixture(t);
  const before = await fs.stat(path.join(first, 'Informe anual.md'));
  // Sin intérprete, cualquier recorrido fallaría; además se retiran los originales.
  const offline = await openMotor({ baseDirectory: base, pythonExecutable: path.join(root, 'sin-python') });
  await assert.rejects(offline.indexFolder(one.id), { code: 'SAFE_SCAN_UNAVAILABLE' });
  const stats = await fs.stat(path.join(first, 'Informe anual.md'));
  assert.equal(stats.mtimeMs, before.mtimeMs);
  await fs.rename(first, path.join(root, 'movida'));
  const response = await offline.searchFiles({ folderIds: [one.id], query: 'notas' });
  assert.deepEqual(response.results.map((item) => item.relativePath), ['notas.txt']);
  assert.equal(response.results[0].indexedAt, response.scopes[0].indexedAt);
});

test('no devuelve índices de carpetas retiradas ni de autorizaciones anteriores', async (t) => {
  const { base, first, motor, one, two } = await fixture(t);
  const filename = path.join(base, `folder-index-${one.id}.json`);
  const stale = await fs.readFile(filename);
  assert.equal(await motor.revokeFolder(one.id), true);
  let response = await motor.searchFiles({ folderIds: [one.id, two.id], query: 'informe' });
  assert.deepEqual(response.results.map((item) => item.folderId), [two.id]);
  assert.deepEqual(response.scopes.map((scope) => [scope.status, scope.code]),
    [['not-authorized', 'FOLDER_NOT_AUTHORIZED'], ['searched', null]]);

  // Nueva autorización de la misma carpeta y un índice de la concesión anterior restaurado.
  assert.equal((await motor.authorizeFolder(first)).id, one.id);
  await fs.writeFile(filename, stale);
  response = await motor.searchFiles({ folderIds: [one.id], query: 'informe' });
  assert.deepEqual([response.results, response.scopes[0].status], [[], 'not-indexed']);
  await motor.indexFolder(one.id);
  response = await motor.searchFiles({ folderIds: [one.id], query: 'informe' });
  assert.equal(response.total, 2);
});

test('una retirada entre la lectura del índice y la respuesta descarta ese ámbito', async () => {
  const index = {
    scopeId: 'a'.repeat(64), authorizationGeneration: '00000000-0000-4000-8000-000000000001',
    generation: 1, updatedAt: '2026-11-01T00:00:00.000Z', issues: [],
    entries: [{ path: 'x.txt', type: 'file', size: 1, modifiedAt: null, changedAt: null, createdAt: null, state: 'indexed', reason: null }],
  };
  for (const folder of [null, { id: index.scopeId, generation: '00000000-0000-4000-8000-000000000002' }]) {
    const search = createIndexSearch({ readFolderIndex: async () => index, loadAuthorizedFolder: async () => folder });
    const response = await search.searchFiles({ folderIds: [index.scopeId] });
    assert.deepEqual([response.results, response.scopes[0].status], [[], 'not-authorized']);
  }
});

test('distingue resultados indexados de los no confirmados', async () => {
  const id = 'b'.repeat(64);
  const entry = (relative, state, reason = null) => ({ path: relative, type: 'file', size: 1, modifiedAt: null,
    changedAt: null, createdAt: null, state, reason });
  const index = {
    scopeId: id, authorizationGeneration: null, generation: 3, updatedAt: '2026-11-01T00:00:00.000Z',
    issues: [{ path: 'Privada', code: 'EACCES' }],
    entries: [entry('Privada/informe-viejo.txt', 'unverified', 'EACCES'), entry('informe.txt', 'indexed'),
      { ...entry('desconocido', 'unverified', 'EPERM'), type: 'unknown', size: null }],
  };
  const search = createIndexSearch({
    readFolderIndex: async () => index, loadAuthorizedFolder: async () => ({ id, generation: null }),
  });
  const response = await search.searchFiles({ folderIds: [id], query: 'informe' });
  assert.deepEqual(response.results.map((item) => [item.relativePath, item.status, item.reason]),
    [['Privada/informe-viejo.txt', 'unverified', 'EACCES'], ['informe.txt', 'indexed', null]]);
  assert.equal(response.scopes[0].complete, false);
  const confirmed = await search.searchFiles({ folderIds: [id], query: 'informe', includeUnverified: false });
  assert.deepEqual(confirmed.results.map((item) => item.relativePath), ['informe.txt']);
});

test('un ámbito sin índice o con índice dañado no oculta los demás', async (t) => {
  const { root, base, motor, one, two } = await fixture(t);
  const third = await motor.authorizeFolder(await fs.mkdir(path.join(root, 'Sin índice'), { recursive: true }));
  await fs.writeFile(path.join(base, `folder-index-${two.id}.json`), '{dañado');
  const response = await motor.searchFiles({ folderIds: [one.id, two.id, third.id], query: 'informe' });
  assert.deepEqual(new Set(response.results.map((item) => item.folderId)), new Set([one.id]));
  assert.deepEqual(response.scopes.map((scope) => [scope.status, scope.code]), [
    ['searched', null], ['index-unavailable', 'RECORD_CORRUPT'], ['not-indexed', null],
  ]);
});

test('un resultado sirve para solicitar su lectura con la autorización existente', async (t) => {
  const { motor, one } = await fixture(t);
  const [selected] = (await motor.searchFiles({ folderIds: [one.id], query: 'notas' })).results;
  const requester = {};
  // La búsqueda no concede lectura: hace falta el permiso explícito del anfitrión.
  await assert.rejects(motor.readTextFile({ requester, authorization: selected }), { code: 'READ_NOT_AUTHORIZED' });
  const authorization = await motor.grantTextRead({
    requester, folderId: selected.folderId, relativePath: selected.relativePath,
  });
  const read = await motor.readTextFile({ requester, authorization });
  assert.deepEqual(read, { folderId: one.id, relativePath: 'notas.txt', content: 'Notas ficticias' });
});
