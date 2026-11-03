import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openMotor } from '../src/motor.js';
import { isExcluded, normalizeExclusions } from '../src/paths.js';

const development = path.dirname(fileURLToPath(new URL('..', import.meta.url)));

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(development, '.mind-exclusions-test-'));
  t.after(async () => {
    assert.equal(path.dirname(root), development);
    await fs.rm(root, { recursive: true, force: true });
  });
  const base = path.join(root, 'Base ficticia');
  const folder = path.join(root, 'Información ficticia');
  await fs.mkdir(base);
  await fs.mkdir(path.join(folder, 'Privado', 'Diario'), { recursive: true });
  await fs.mkdir(path.join(folder, 'Proyectos'), { recursive: true });
  await fs.writeFile(path.join(folder, 'Privado', 'secreto.txt'), 'Dato privado ficticio');
  await fs.writeFile(path.join(folder, 'Privado', 'Diario', 'hoy.txt'), 'Diario ficticio');
  await fs.writeFile(path.join(folder, 'Proyectos', 'plan.txt'), 'Plan ficticio');
  const motor = await openMotor({ baseDirectory: base });
  const scope = await motor.authorizeFolder(folder);
  return { base, folder, motor, id: scope.id };
}

const paths = async (motor, id) => (await motor.readFolderIndex(id)).entries.map((entry) => entry.path);

test('normalización y pertenencia de exclusiones', () => {
  assert.deepEqual(normalizeExclusions(['/Privado/', 'Finanzas\\2025', 'Privado']), ['Finanzas/2025', 'Privado']);
  for (const bad of [['../fuera'], ['a/./b'], [''], [7], 'Privado', Array(65).fill('x')]) {
    assert.equal(normalizeExclusions(bad), null, JSON.stringify(bad));
  }
  assert.equal(isExcluded(['Privado'], 'Privado'), true);
  assert.equal(isExcluded(['Privado'], 'Privado/Diario/hoy.txt'), true);
  assert.equal(isExcluded(['Privado'], 'Privados/otro.txt'), false);
  assert.equal(isExcluded([], 'Privado'), false);
});

test('excluir retira del índice al instante, la reconciliación no lo recorre y volver a incluir lo recupera', async (t) => {
  const { motor, id } = await fixture(t);
  await motor.indexFolder(id);
  assert.ok((await paths(motor, id)).includes('Privado/secreto.txt'));
  const before = (await motor.readFolderIndex(id)).generation;
  const applied = await motor.setFolderExclusions(id, ['Privado']);
  assert.deepEqual(applied, { exclusions: ['Privado'], removedEntries: 4 });
  assert.deepEqual(await paths(motor, id), ['Proyectos', 'Proyectos/plan.txt']);
  assert.equal((await motor.readFolderIndex(id)).generation, before + 1);
  assert.deepEqual((await motor.getAuthorizedFolder(id)).exclusions, ['Privado']);
  const reconciled = await motor.indexFolder(id);
  assert.deepEqual(reconciled.changes, { added: [], modified: [], removed: [] });
  assert.equal((await motor.searchFiles({ folderIds: [id], query: 'secreto' })).total, 0);

  assert.deepEqual((await motor.setFolderExclusions(id, [])).exclusions, []);
  assert.deepEqual((await motor.indexFolder(id)).changes.added.sort(), ['Privado', 'Privado/Diario', 'Privado/Diario/hoy.txt', 'Privado/secreto.txt']);
  assert.equal((await motor.searchFiles({ folderIds: [id], query: 'secreto' })).total, 1);
});

test('leer, crear y modificar dentro de una exclusión se rechazan, también con un permiso previo', async (t) => {
  const { folder, motor, id } = await fixture(t);
  const requester = Object.freeze({});
  const pendingRead = await motor.grantTextRead({ requester, folderId: id, relativePath: 'Privado/secreto.txt' });
  const pendingModify = await motor.grantTextModify({ requester, folderId: id, relativePath: 'Privado/secreto.txt' });
  await motor.setFolderExclusions(id, ['Privado']);
  await assert.rejects(motor.readTextFile({ requester, authorization: pendingRead }), { code: 'PATH_EXCLUDED' });
  await assert.rejects(motor.modifyTextFile({ requester, authorization: pendingModify, expectedVersion: `sha256:${'0'.repeat(64)}`, content: 'x' }), { code: 'PATH_EXCLUDED' });
  for (const grant of ['grantTextRead', 'grantTextCreate', 'grantTextModify']) {
    await assert.rejects(motor[grant]({ requester, folderId: id, relativePath: 'Privado/Diario/nuevo.txt' }), { code: 'PATH_EXCLUDED' }, grant);
  }
  assert.equal(await fs.readFile(path.join(folder, 'Privado', 'secreto.txt'), 'utf8'), 'Dato privado ficticio');
  // Fuera de la exclusión todo sigue funcionando.
  const read = await motor.grantTextRead({ requester, folderId: id, relativePath: 'Proyectos/plan.txt' });
  assert.equal((await motor.readTextFile({ requester, authorization: read })).content, 'Plan ficticio');
});

test('las exclusiones pertenecen a la autorización: retirar y volver a autorizar empieza sin ellas', async (t) => {
  const { folder, motor, id } = await fixture(t);
  await motor.setFolderExclusions(id, ['Privado']);
  assert.equal(await motor.revokeFolder(id), true);
  await assert.rejects(motor.setFolderExclusions(id, ['Privado']), { code: 'FOLDER_NOT_AUTHORIZED' });
  const again = await motor.authorizeFolder(folder);
  assert.deepEqual((await motor.getAuthorizedFolder(again.id)).exclusions, []);
  await assert.rejects(motor.setFolderExclusions(again.id, ['../fuera']), { code: 'INVALID_EXCLUSIONS' });
  assert.equal(Object.hasOwn(motor, 'setExclusions'), false);
});
