import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openMotor } from '../src/motor.js';
import { readBaseContents } from './helpers/base-content.js';
import { catalogFile, catalogScope, removeCatalog } from './helpers/catalog.js';

const motorDirectory = fileURLToPath(new URL('..', import.meta.url));
const development = path.dirname(motorDirectory);

async function fixture(t, { index = true } = {}) {
  const root = await fs.mkdtemp(path.join(development, '.mind-create-integration-test-'));
  t.after(async () => {
    assert.equal(path.dirname(root), development);
    assert.ok(path.basename(root).startsWith('.mind-create-integration-test-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const base = path.join(root, 'Base ficticia');
  const folder = path.join(root, 'Información ficticia');
  await fs.mkdir(base);
  await fs.mkdir(path.join(folder, 'Proyectos'), { recursive: true });
  await fs.writeFile(path.join(folder, 'existente.txt'), 'Nota ficticia previa');
  const motor = await openMotor({ baseDirectory: base });
  const scope = await motor.authorizeFolder(folder);
  if (index) await motor.indexFolder(scope.id);
  return { root, base, folder, motor, scope, filename: path.join(base, `folder-index-${scope.id}.json`),
    // Estado publicado del índice en catalog.sqlite.
    published: () => catalogScope(base, scope.id) };
}

async function create(motor, scope, relativePath, content = 'Texto ficticio creado por Mind\n') {
  const requester = Object.freeze({});
  const authorization = await motor.grantTextCreate({ requester, folderId: scope.id, relativePath });
  return { requester, authorization, result: await motor.createTextFile({ requester, authorization, content }) };
}

test('registro → creación autorizada → búsqueda → lectura del archivo nuevo, sin reutilizar permisos', async (t) => {
  const { base, folder, motor, scope } = await fixture(t);
  const content = 'MARCADOR-CREACION-0912: acta ficticia nueva.\n';
  const { requester, authorization, result } = await create(motor, scope, 'Proyectos/Acta nueva.txt', content);
  assert.equal(result.folderId, scope.id);
  assert.equal(result.relativePath, 'Proyectos/Acta nueva.txt');
  assert.equal(result.size, Buffer.byteLength(content));
  assert.deepEqual(result.index, { status: 'updated', generation: 2, code: null });

  // Creación: un solo intento.
  await assert.rejects(motor.createTextFile({ requester, authorization, content: 'otro' }), { code: 'CREATE_NOT_AUTHORIZED' });
  assert.equal(motor.revokeTextCreate(authorization), false);

  const found = await motor.searchFiles({ folderIds: [scope.id], query: 'acta nueva' });
  assert.equal(found.total, 1);
  const [selected] = found.results;
  assert.deepEqual({ folderId: selected.folderId, relativePath: selected.relativePath, status: selected.status },
    { folderId: scope.id, relativePath: 'Proyectos/Acta nueva.txt', status: 'indexed' });
  for (const field of ['size', 'modifiedAt', 'changedAt', 'createdAt']) {
    assert.equal(selected[field], result.indexEntry[field]);
  }

  const reader = Object.freeze({});
  const readPermission = await motor.grantTextRead({
    requester: reader, folderId: selected.folderId, relativePath: selected.relativePath,
  });
  assert.deepEqual(await motor.readTextFile({ requester: reader, authorization: readPermission }),
    { folderId: scope.id, relativePath: 'Proyectos/Acta nueva.txt', content });
  await assert.rejects(motor.readTextFile({ requester: reader, authorization: readPermission }), { code: 'READ_NOT_AUTHORIZED' });

  // La entrada publicada coincide con el disco: reconciliar no informa cambios.
  assert.deepEqual((await motor.indexFolder(scope.id)).changes, { added: [], modified: [], removed: [] });
  assert.equal(await fs.readFile(path.join(folder, 'existente.txt'), 'utf8'), 'Nota ficticia previa');
  const stored = await readBaseContents(base);
  assert.ok(!stored.includes('MARCADOR-CREACION'), 'El contenido no se guarda en la Base');
});

test('conceder y retirar siguen en el anfitrión; permisos de lectura y creación no se intercambian', async (t) => {
  const { folder, motor, scope } = await fixture(t);
  assert.equal(Object.hasOwn(motor, 'recordCreatedFile'), false);
  const requester = Object.freeze({});
  const createPermission = await motor.grantTextCreate({ requester, folderId: scope.id, relativePath: 'a.txt' });
  const readPermission = await motor.grantTextRead({ requester, folderId: scope.id, relativePath: 'existente.txt' });
  await assert.rejects(motor.readTextFile({ requester, authorization: createPermission }), { code: 'READ_NOT_AUTHORIZED' });
  await assert.rejects(motor.createTextFile({ requester, authorization: readPermission, content: 'x' }), { code: 'CREATE_NOT_AUTHORIZED' });
  await assert.rejects(motor.createTextFile({ requester: {}, authorization: createPermission, content: 'x' }), { code: 'CREATE_NOT_AUTHORIZED' });

  const other = await openMotor({ baseDirectory: motor.baseDirectory });
  const fresh = await motor.grantTextCreate({ requester, folderId: scope.id, relativePath: 'b.txt' });
  await assert.rejects(other.createTextFile({ requester, authorization: fresh, content: 'x' }), { code: 'CREATE_NOT_AUTHORIZED' });

  const revoked = await motor.grantTextCreate({ requester, folderId: scope.id, relativePath: 'c.txt' });
  assert.equal(motor.revokeTextCreate(revoked), true);
  await assert.rejects(motor.createTextFile({ requester, authorization: revoked, content: 'x' }), { code: 'CREATE_NOT_AUTHORIZED' });

  const pending = await motor.grantTextCreate({ requester, folderId: scope.id, relativePath: 'd.txt' });
  await motor.revokeFolder(scope.id);
  await motor.authorizeFolder(folder);
  await assert.rejects(motor.createTextFile({ requester, authorization: pending, content: 'x' }), { code: 'CREATE_NOT_AUTHORIZED' });
  assert.deepEqual((await fs.readdir(folder)).sort(), ['Proyectos', 'existente.txt']);
});

test('sin índice vigente la creación no inventa uno; la reconciliación lo incorpora', async (t) => {
  const { folder, motor, scope, filename, published } = await fixture(t, { index: false });
  const { result } = await create(motor, scope, 'nuevo.txt');
  assert.deepEqual(result.index, { status: 'not-indexed', generation: null, code: null });
  assert.equal(await published(), null);
  await assert.rejects(fs.access(filename));
  assert.equal((await motor.searchFiles({ folderIds: [scope.id], query: 'nuevo' })).scopes[0].status, 'not-indexed');
  await motor.indexFolder(scope.id);
  assert.equal((await motor.searchFiles({ folderIds: [scope.id], query: 'nuevo' })).total, 1);
  assert.ok((await fs.readdir(folder)).includes('nuevo.txt'));
});

test('ante conflictos no publica metadatos y deja la reconciliación explícita', async (t) => {
  const { folder, motor, scope, filename, published } = await fixture(t);
  const before = await published();

  // Carpeta padre creada después del último recorrido: el índice no la conoce.
  await fs.mkdir(path.join(folder, 'Nueva carpeta'));
  const orphan = (await create(motor, scope, 'Nueva carpeta/hija.txt')).result;
  assert.deepEqual(orphan.index, { status: 'needs-reconciliation', generation: 1, code: 'INDEX_PARENT_NOT_CURRENT' });

  // Entrada vieja con el mismo nombre: el archivo indexado se borró y se crea otro.
  await fs.rm(path.join(folder, 'existente.txt'));
  const replaced = (await create(motor, scope, 'existente.txt', 'Contenido distinto y más largo\n')).result;
  assert.deepEqual(replaced.index, { status: 'needs-reconciliation', generation: 1, code: 'INDEX_ENTRY_CONFLICT' });
  assert.equal(await published(), before, 'El índice queda intacto');
  assert.equal((await motor.searchFiles({ folderIds: [scope.id], query: 'hija' })).total, 0);

  const reconciled = await motor.indexFolder(scope.id);
  assert.deepEqual(reconciled.changes, {
    added: ['Nueva carpeta', 'Nueva carpeta/hija.txt'], modified: ['existente.txt'], removed: [],
  });
  const [current] = (await motor.searchFiles({ folderIds: [scope.id], query: 'existente' })).results;
  assert.equal(current.size, replaced.size);
});

test('un fallo al actualizar el índice no anula la creación ya realizada', async (t) => {
  const { folder, motor, scope, filename, published } = await fixture(t);
  await fs.writeFile(filename, '{dañado');
  const { result } = await create(motor, scope, 'tras-fallo.txt', 'ficticio\n');
  assert.deepEqual(result.index, { status: 'needs-reconciliation', generation: null, code: 'RECORD_CORRUPT' });
  assert.equal(await fs.readFile(path.join(folder, 'tras-fallo.txt'), 'utf8'), 'ficticio\n');
  assert.equal(await fs.readFile(filename, 'utf8'), '{dañado');
});

test('un catálogo dañado tampoco anula la creación ya publicada ni se repara', async (t) => {
  const { base, folder, motor, scope } = await fixture(t);
  await removeCatalog(base);
  await fs.writeFile(catalogFile(base), '{dañado');
  const { result } = await create(motor, scope, 'tras-fallo.txt', 'ficticio\n');
  assert.deepEqual(result.index, { status: 'needs-reconciliation', generation: null, code: 'INDEX_CORRUPT' });
  assert.equal(await fs.readFile(path.join(folder, 'tras-fallo.txt'), 'utf8'), 'ficticio\n');
  assert.equal(await fs.readFile(catalogFile(base), 'utf8'), '{dañado');
});

test('crear un nombre existente falla sin tocar el original ni el índice', async (t) => {
  const { folder, motor, scope, filename, published } = await fixture(t);
  const before = await published();
  const original = await fs.stat(path.join(folder, 'existente.txt'));
  await assert.rejects(create(motor, scope, 'existente.txt', 'sobrescritura'), { code: 'FILE_EXISTS' });
  assert.equal(await fs.readFile(path.join(folder, 'existente.txt'), 'utf8'), 'Nota ficticia previa');
  assert.equal((await fs.stat(path.join(folder, 'existente.txt'))).mtimeMs, original.mtimeMs);
  assert.equal(await published(), before);
});
