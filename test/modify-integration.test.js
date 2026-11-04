import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openMotor, textVersion } from '../src/motor.js';
import { createFolderRegistry } from '../src/folders.js';
import { createFolderIndexer } from '../src/indexer.js';
import { readBaseContents } from './helpers/base-content.js';

const motorDirectory = fileURLToPath(new URL('..', import.meta.url));
const development = path.dirname(motorDirectory);

async function fixture(t, { index = true } = {}) {
  const root = await fs.mkdtemp(path.join(development, '.mind-modify-integration-test-'));
  t.after(async () => {
    assert.equal(path.dirname(root), development);
    assert.ok(path.basename(root).startsWith('.mind-modify-integration-test-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const base = path.join(root, 'Base ficticia');
  const folder = path.join(root, 'Información ficticia');
  await fs.mkdir(base);
  await fs.mkdir(path.join(folder, 'Proyectos'), { recursive: true });
  await fs.writeFile(path.join(folder, 'Proyectos', 'Acta.txt'), 'Acta ficticia inicial.\n');
  await fs.writeFile(path.join(folder, 'vecino.txt'), 'Nota ficticia que no se toca');
  const motor = await openMotor({ baseDirectory: base });
  const scope = await motor.authorizeFolder(folder);
  if (index) await motor.indexFolder(scope.id);
  return { root, base, folder, motor, scope, filename: path.join(base, `folder-index-${scope.id}.json`) };
}

async function read(motor, scope, relativePath) {
  const requester = Object.freeze({});
  const authorization = await motor.grantTextRead({ requester, folderId: scope.id, relativePath });
  return (await motor.readTextFile({ requester, authorization })).content;
}

async function modify(motor, scope, relativePath, expectedVersion, content) {
  const requester = Object.freeze({});
  const authorization = await motor.grantTextModify({ requester, folderId: scope.id, relativePath });
  return { requester, authorization, result: await motor.modifyTextFile({ requester, authorization, expectedVersion, content }) };
}

test('lectura → versión → modificación autorizada → búsqueda → nueva lectura', async (t) => {
  const { base, folder, motor, scope } = await fixture(t);
  const neighbour = await fs.stat(path.join(folder, 'vecino.txt'));

  const before = await read(motor, scope, 'Proyectos/Acta.txt');
  const updated = `${before}MARCADOR-MODIFICACION-1207: acuerdos ficticios añadidos.\n`;
  const { requester, authorization, result } = await modify(motor, scope, 'Proyectos/Acta.txt', textVersion(before), updated);
  assert.equal(result.folderId, scope.id);
  assert.equal(result.relativePath, 'Proyectos/Acta.txt');
  assert.equal(result.previousVersion, textVersion(before));
  assert.equal(result.version, textVersion(updated));
  assert.equal(result.size, Buffer.byteLength(updated));
  assert.deepEqual(result.index, { status: 'updated', generation: 2, code: null });

  // Un solo intento: el permiso consumido no se reutiliza ni se retira.
  await assert.rejects(motor.modifyTextFile({ requester, authorization, expectedVersion: result.version, content: 'otro' }),
    { code: 'MODIFY_NOT_AUTHORIZED' });
  assert.equal(motor.revokeTextModify(authorization), false);

  // La búsqueda ve los metadatos nuevos sin recorrer la carpeta.
  const found = await motor.searchFiles({ folderIds: [scope.id], query: 'acta', minSize: result.size });
  assert.equal(found.total, 1);
  const [selected] = found.results;
  assert.deepEqual({ folderId: selected.folderId, relativePath: selected.relativePath, status: selected.status },
    { folderId: scope.id, relativePath: 'Proyectos/Acta.txt', status: 'indexed' });
  for (const field of ['size', 'modifiedAt', 'changedAt', 'createdAt']) {
    assert.equal(selected[field], result.indexEntry[field]);
  }
  assert.equal((await motor.searchFiles({ folderIds: [scope.id], query: 'acta', maxSize: result.size - 1 })).total, 0);

  // Nueva lectura con un permiso nuevo: el contenido y su versión son los publicados.
  const after = await read(motor, scope, selected.relativePath);
  assert.equal(after, updated);
  assert.equal(textVersion(after), result.version);

  // La entrada publicada coincide con el disco: reconciliar no informa cambios.
  assert.deepEqual((await motor.indexFolder(scope.id)).changes, { added: [], modified: [], removed: [] });
  assert.equal(await fs.readFile(path.join(folder, 'vecino.txt'), 'utf8'), 'Nota ficticia que no se toca');
  assert.equal((await fs.stat(path.join(folder, 'vecino.txt'))).mtimeMs, neighbour.mtimeMs);
  assert.deepEqual((await fs.readdir(path.join(folder, 'Proyectos'))), ['Acta.txt']);
  const stored = await readBaseContents(base);
  assert.ok(!stored.includes('MARCADOR-MODIFICACION'), 'El contenido no se guarda en la Base');
});

test('VERSION_CONFLICT explícito: un cambio ajeno no se sobrescribe ni toca el índice', async (t) => {
  const { folder, motor, scope, filename } = await fixture(t);
  const seen = await read(motor, scope, 'Proyectos/Acta.txt');
  // Otro programa guarda el archivo después de que el agente lo leyera.
  await fs.writeFile(path.join(folder, 'Proyectos', 'Acta.txt'), 'Cambio ajeno del usuario.\n');
  const indexBefore = await fs.readFile(filename, 'utf8');
  await assert.rejects(modify(motor, scope, 'Proyectos/Acta.txt', textVersion(seen), `${seen}añadido\n`),
    { code: 'VERSION_CONFLICT' });
  assert.equal(await fs.readFile(path.join(folder, 'Proyectos', 'Acta.txt'), 'utf8'), 'Cambio ajeno del usuario.\n');
  assert.equal(await fs.readFile(filename, 'utf8'), indexBefore);

  // Releer y reintentar sobre la versión actual sí publica.
  const current = await read(motor, scope, 'Proyectos/Acta.txt');
  const { result } = await modify(motor, scope, 'Proyectos/Acta.txt', textVersion(current), `${current}fusionado\n`);
  assert.equal(result.index.status, 'updated');
  assert.equal(await read(motor, scope, 'Proyectos/Acta.txt'), 'Cambio ajeno del usuario.\nfusionado\n');
});

test('dos agentes sobre la misma versión: uno publica y el otro recibe VERSION_CONFLICT', async (t) => {
  const { folder, motor, scope } = await fixture(t);
  const seen = await read(motor, scope, 'Proyectos/Acta.txt');
  const attempts = await Promise.allSettled(['A', 'B'].map((agent) => modify(
    motor, scope, 'Proyectos/Acta.txt', textVersion(seen), `${seen}Agente ${agent}\n`,
  )));
  const published = attempts.filter((attempt) => attempt.status === 'fulfilled');
  assert.equal(published.length, 1);
  const [rejected] = attempts.filter((attempt) => attempt.status === 'rejected');
  assert.ok(['VERSION_CONFLICT', 'FILE_IN_USE'].includes(rejected.reason.code), rejected.reason.code);
  const content = await fs.readFile(path.join(folder, 'Proyectos', 'Acta.txt'), 'utf8');
  assert.equal(textVersion(content), published[0].value.result.version);
  // La cola por ámbito deja el índice coherente con lo publicado.
  const [entry] = (await motor.searchFiles({ folderIds: [scope.id], query: 'acta' })).results;
  assert.equal(entry.size, Buffer.byteLength(content));
});

test('conceder y retirar siguen en el anfitrión; lectura, creación y modificación no se intercambian', async (t) => {
  const { folder, motor, scope } = await fixture(t);
  assert.equal(Object.hasOwn(motor, 'recordModifiedFile'), false);
  const requester = Object.freeze({});
  const version = textVersion('Acta ficticia inicial.\n');
  const modifyPermission = await motor.grantTextModify({ requester, folderId: scope.id, relativePath: 'Proyectos/Acta.txt' });
  const readPermission = await motor.grantTextRead({ requester, folderId: scope.id, relativePath: 'Proyectos/Acta.txt' });
  const createPermission = await motor.grantTextCreate({ requester, folderId: scope.id, relativePath: 'Proyectos/Acta.txt' });
  await assert.rejects(motor.readTextFile({ requester, authorization: modifyPermission }), { code: 'READ_NOT_AUTHORIZED' });
  await assert.rejects(motor.createTextFile({ requester, authorization: modifyPermission, content: 'x' }), { code: 'CREATE_NOT_AUTHORIZED' });
  for (const authorization of [readPermission, createPermission]) {
    await assert.rejects(motor.modifyTextFile({ requester, authorization, expectedVersion: version, content: 'x' }), { code: 'MODIFY_NOT_AUTHORIZED' });
  }
  await assert.rejects(motor.modifyTextFile({ requester: {}, authorization: modifyPermission, expectedVersion: version, content: 'x' }), { code: 'MODIFY_NOT_AUTHORIZED' });

  const other = await openMotor({ baseDirectory: motor.baseDirectory });
  const fresh = await motor.grantTextModify({ requester, folderId: scope.id, relativePath: 'Proyectos/Acta.txt' });
  await assert.rejects(other.modifyTextFile({ requester, authorization: fresh, expectedVersion: version, content: 'x' }), { code: 'MODIFY_NOT_AUTHORIZED' });

  const revoked = await motor.grantTextModify({ requester, folderId: scope.id, relativePath: 'Proyectos/Acta.txt' });
  assert.equal(motor.revokeTextModify(revoked), true);
  await assert.rejects(motor.modifyTextFile({ requester, authorization: revoked, expectedVersion: version, content: 'x' }), { code: 'MODIFY_NOT_AUTHORIZED' });

  const pending = await motor.grantTextModify({ requester, folderId: scope.id, relativePath: 'Proyectos/Acta.txt' });
  await motor.revokeFolder(scope.id);
  await motor.authorizeFolder(folder);
  await assert.rejects(motor.modifyTextFile({ requester, authorization: pending, expectedVersion: version, content: 'x' }), { code: 'MODIFY_NOT_AUTHORIZED' });
  assert.equal(await fs.readFile(path.join(folder, 'Proyectos', 'Acta.txt'), 'utf8'), 'Acta ficticia inicial.\n');
});

test('sin índice vigente la modificación no inventa uno; la reconciliación lo incorpora', async (t) => {
  const { motor, scope, filename } = await fixture(t, { index: false });
  const { result } = await modify(motor, scope, 'Proyectos/Acta.txt', textVersion('Acta ficticia inicial.\n'), 'Nueva acta\n');
  assert.deepEqual(result.index, { status: 'not-indexed', generation: null, code: null });
  await assert.rejects(fs.access(filename));
  await motor.indexFolder(scope.id);
  const [entry] = (await motor.searchFiles({ folderIds: [scope.id], query: 'acta' })).results;
  assert.equal(entry.size, result.size);
});

test('un índice que no conocía el archivo no se corrige a ciegas: pide reconciliación', async (t) => {
  const { folder, motor, scope, filename } = await fixture(t);
  // Archivo creado fuera de Mind después del último recorrido.
  await fs.writeFile(path.join(folder, 'externo.txt'), 'Nota ficticia externa\n');
  const before = await fs.readFile(filename, 'utf8');
  const { result } = await modify(motor, scope, 'externo.txt', textVersion('Nota ficticia externa\n'), 'Editada\n');
  assert.deepEqual(result.index, { status: 'needs-reconciliation', generation: 1, code: 'INDEX_ENTRY_MISSING' });
  assert.equal(await fs.readFile(filename, 'utf8'), before, 'El índice queda intacto');
  assert.equal(await fs.readFile(path.join(folder, 'externo.txt'), 'utf8'), 'Editada\n');
  const reconciled = await motor.indexFolder(scope.id);
  assert.deepEqual(reconciled.changes, { added: ['externo.txt'], modified: [], removed: [] });
});

test('un fallo al actualizar el índice no anula la modificación ya publicada', async (t) => {
  const { folder, motor, scope, filename } = await fixture(t);
  await fs.writeFile(filename, '{dañado');
  const { result } = await modify(motor, scope, 'Proyectos/Acta.txt', textVersion('Acta ficticia inicial.\n'), 'Tras fallo\n');
  assert.deepEqual(result.index, { status: 'needs-reconciliation', generation: null, code: 'RECORD_CORRUPT' });
  assert.equal(await fs.readFile(path.join(folder, 'Proyectos', 'Acta.txt'), 'utf8'), 'Tras fallo\n');
  assert.equal(await fs.readFile(filename, 'utf8'), '{dañado');
});

test('el indexador reconoce una entrada ya vigente y no sustituye otro tipo con ese nombre', async (t) => {
  const { motor, scope, filename } = await fixture(t);
  const { result } = await modify(motor, scope, 'Proyectos/Acta.txt', textVersion('Acta ficticia inicial.\n'), 'Otra acta\n');
  assert.deepEqual(result.index, { status: 'updated', generation: 2, code: null });
  // Mismo mecanismo y cola que usa openMotor, con el resolutor del registro.
  const { loadAuthorizedFolder } = createFolderRegistry(motor.baseDirectory, await fs.realpath(motorDirectory));
  const indexer = createFolderIndexer({ baseDirectory: motor.baseDirectory, resolveScope: loadAuthorizedFolder });
  assert.deepEqual(await indexer.recordModifiedFile(scope.id, result.indexEntry), { status: 'current', generation: 2, code: null });
  const before = await fs.readFile(filename, 'utf8');
  assert.deepEqual(await indexer.recordModifiedFile(scope.id, { ...result.indexEntry, path: 'Proyectos' }),
    { status: 'needs-reconciliation', generation: 2, code: 'INDEX_ENTRY_CONFLICT' });
  assert.deepEqual(await indexer.recordModifiedFile(scope.id, { ...result.indexEntry, type: 'directory' }),
    { status: 'needs-reconciliation', generation: null, code: 'INVALID_MODIFIED_ENTRY' });
  assert.equal(await fs.readFile(filename, 'utf8'), before);
});
