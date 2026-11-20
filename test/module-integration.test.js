import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openMotor } from '../src/motor.js';
import { createFolderIndexer } from '../src/indexer.js';
import {
  catalogFile, catalogScope, catalogScopeRow, legacyIndexFiles, publishCatalogScope,
} from './helpers/catalog.js';

const motorDirectory = fileURLToPath(new URL('..', import.meta.url));
const development = path.dirname(motorDirectory);

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(development, '.mind-module-test-'));
  t.after(async () => {
    assert.equal(path.dirname(root), development);
    assert.ok(path.basename(root).startsWith('.mind-module-test-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const base = path.join(root, 'Base ficticia');
  const folder = path.join(root, 'Información ficticia');
  await fs.mkdir(base);
  await fs.mkdir(folder);
  await fs.writeFile(path.join(folder, 'anterior.txt'), 'Contenido ficticio');
  const motor = await openMotor({ baseDirectory: base });
  const scope = await motor.authorizeFolder(folder);
  // Índice heredado (JSON) que r3 todavía lee y migra a catalog.sqlite.
  const legacy = path.join(base, `folder-index-${scope.id}.json`);
  const published = () => catalogScope(base, scope.id);
  return { root, base, folder, motor, scope, legacy, published };
}

test('Motor indexa y reconcilia solo ids del registro; continuidad y funciones son administración del anfitrión', async (t) => {
  const { base, folder, motor, scope } = await fixture(t);
  for (const invalid of [folder, '../escape', '', null]) {
    await assert.rejects(motor.indexFolder(invalid), { code: 'INVALID_SCOPE_ID' });
    await assert.rejects(motor.readFolderIndex(invalid), { code: 'INVALID_SCOPE_ID' });
  }
  await assert.rejects(motor.indexFolder('a'.repeat(64)), { code: 'FOLDER_NOT_AUTHORIZED' });
  assert.equal(await motor.readFolderIndex(scope.id), null);
  assert.equal((await motor.indexFolder(scope.id)).mode, 'initial');
  await fs.writeFile(path.join(folder, 'nuevo.txt'), 'Otra nota ficticia');
  assert.deepEqual((await motor.indexFolder(scope.id)).changes.added, ['nuevo.txt']);
  assert.deepEqual((await motor.readFolderIndex(scope.id)).entries.map((item) => item.path), ['anterior.txt', 'nuevo.txt']);
  // Las vistas de agente y la lectura interna de versiones no forman parte del Motor administrativo.
  for (const name of ['getFunctionVersion', 'readContinuityContext', 'recordContinuityResult']) {
    assert.equal(Object.hasOwn(motor, name), false);
  }
  // Continuidad y funciones se integran como administración del anfitrión
  // (véanse continuity-integration y function-integration).
  assert.equal(typeof motor.recordContinuity, 'function');
  assert.equal(typeof motor.createFunction, 'function');
  const requester = {};
  await assert.rejects(motor.readTextFile({ requester, authorization: scope.id }), { code: 'READ_NOT_AUTHORIZED' });
  assert.deepEqual((await fs.readdir(base)).sort(), [
    'catalog.sqlite', `folder-authorization-${scope.id}.json`, 'mind-base.json', 'resource-queue',
  ].sort());
  assert.deepEqual(await fs.readdir(path.join(base, 'resource-queue')), [], 'La cola queda vacía al terminar');
});

test('el índice y su vínculo de autorización sobreviven a un proceso nuevo', async (t) => {
  const { base, motor, scope } = await fixture(t);
  await motor.indexFolder(scope.id);
  const source = `
    import { openMotor } from ${JSON.stringify(pathToFileURL(path.join(motorDirectory, 'src/motor.js')).href)};
    const motor = await openMotor({ baseDirectory: ${JSON.stringify(base)} });
    console.log(JSON.stringify(await motor.readFolderIndex(${JSON.stringify(scope.id)})));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), await motor.readFolderIndex(scope.id));
  const saved = await catalogScopeRow(base, scope.id);
  const registered = JSON.parse(await fs.readFile(path.join(base, `folder-authorization-${scope.id}.json`), 'utf8'));
  assert.equal(JSON.parse(await fs.readFile(path.join(base, 'mind-base.json'), 'utf8')).version, 3);
  assert.ok(registered.generation);
  assert.equal(saved.authorization_generation, registered.generation);
});

test('retirar elimina el índice y deniega a instancias abiertas sin modificar originales', async (t) => {
  const { base, folder, motor, scope, published } = await fixture(t);
  await motor.indexFolder(scope.id);
  const other = await openMotor({ baseDirectory: base });
  const original = path.join(folder, 'anterior.txt');
  const before = await fs.stat(original);
  assert.equal(await other.revokeFolder(scope.id), true);
  assert.equal(await published(), null);
  await assert.rejects(motor.readFolderIndex(scope.id), { code: 'FOLDER_NOT_AUTHORIZED' });
  await assert.rejects(motor.indexFolder(scope.id), { code: 'FOLDER_NOT_AUTHORIZED' });
  assert.equal(await motor.revokeFolder(scope.id), false);
  assert.equal(await fs.readFile(original, 'utf8'), 'Contenido ficticio');
  assert.equal((await fs.stat(original)).mtimeMs, before.mtimeMs);
});

test('retirar y reautorizar invalida incluso un índice viejo restaurado o publicado tarde', async (t) => {
  const { base, folder, motor, scope, published } = await fixture(t);
  await motor.indexFolder(scope.id);
  const previous = await published();
  const other = await openMotor({ baseDirectory: base });
  await other.revokeFolder(scope.id);
  await fs.unlink(path.join(folder, 'anterior.txt'));
  await fs.writeFile(path.join(folder, 'actual.txt'), 'Actual ficticio');
  const reauthorized = await other.authorizeFolder(folder);
  assert.equal(reauthorized.id, scope.id);
  await publishCatalogScope(base, previous); // Simula una publicación tardía de otro proceso.
  assert.equal(await motor.readFolderIndex(scope.id), null);
  const result = await motor.indexFolder(scope.id);
  assert.equal(result.mode, 'initial');
  assert.equal(result.generation, 1);
  assert.equal(result.changes, null);
  assert.deepEqual((await motor.readFolderIndex(scope.id)).entries.map((item) => item.path), ['actual.txt']);
});

test('los índices v1 sin vínculo nunca se ofrecen como vigentes; se reconstruyen', async (t) => {
  const { motor, scope, legacy, folder } = await fixture(t);
  await motor.indexFolder(scope.id);
  const { authorizationGeneration, ...current } = await motor.readFolderIndex(scope.id);
  assert.ok(authorizationGeneration);
  // Un índice JSON v1 heredado no tenía vínculo con la concesión.
  const index = { format: 'mind-folder-index', version: 1, ...current,
    entries: current.entries.map(({ identity, ...item }) => item) };
  await fs.writeFile(legacy, JSON.stringify(index));
  await fs.unlink(path.join(folder, 'anterior.txt'));
  assert.equal(await motor.readFolderIndex(scope.id), null);
  assert.deepEqual(await legacyIndexFiles(motor.baseDirectory), [], 'El heredado se migró al catálogo');
  assert.equal(await motor.readFolderIndex(scope.id), null, 'Migrado sigue sin vínculo vigente');
  assert.equal((await motor.indexFolder(scope.id)).mode, 'initial');
  assert.deepEqual((await motor.readFolderIndex(scope.id)).entries, []);
});

test('un índice sin vínculo en el catálogo tampoco se ofrece como vigente', async (t) => {
  let { base, motor, scope, folder, published } = await fixture(t);
  await motor.indexFolder(scope.id);
  const unbound = JSON.parse(await published());
  unbound.scope.authorization_generation = null;
  await publishCatalogScope(base, JSON.stringify(unbound));
  await fs.unlink(path.join(folder, 'anterior.txt'));
  // Ni la instancia abierta (su caché se valida con el catálogo) ni un Motor nuevo lo ofrecen.
  assert.equal(await motor.readFolderIndex(scope.id), null);
  motor = await openMotor({ baseDirectory: base });
  assert.equal(await motor.readFolderIndex(scope.id), null);
  assert.equal((await motor.indexFolder(scope.id)).mode, 'initial');
  assert.deepEqual((await motor.readFolderIndex(scope.id)).entries, []);
});

test('un registro de carpeta heredado v1 tampoco revive índices al reautorizar', async (t) => {
  const { base, folder, motor, scope, published } = await fixture(t);
  await fs.writeFile(path.join(base, `folder-authorization-${scope.id}.json`), JSON.stringify({
    format: 'mind-folder-authorization', version: 1, ...scope,
  }));
  await motor.indexFolder(scope.id);
  const old = await published();
  assert.equal(JSON.parse(old).scope.authorization_generation, null);
  await motor.revokeFolder(scope.id);
  await motor.authorizeFolder(folder);
  await publishCatalogScope(base, old);
  assert.equal(await motor.readFolderIndex(scope.id), null);
  assert.equal((await motor.indexFolder(scope.id)).mode, 'initial');
});

test('un ciclo de retirada y concesión durante el recorrido impide publicar', async (t) => {
  const { base, folder, motor, scope, published } = await fixture(t);
  let calls = 0;
  const indexer = createFolderIndexer({ baseDirectory: base, resolveScope: async (id) => {
    if (++calls === 3) {
      await motor.revokeFolder(id);
      await motor.authorizeFolder(folder);
    }
    const registration = JSON.parse(await fs.readFile(path.join(base, `folder-authorization-${id}.json`), 'utf8'));
    return { id, path: registration.path, generation: registration.generation };
  } });
  await assert.rejects(indexer.indexFolder(scope.id), { code: 'INDEX_SCOPE_CHANGED' });
  assert.equal(await published(), null);
});

for (const [where, linkName, code] of [
  ['catálogo', (base) => catalogFile(base), 'INDEX_CORRUPT'],
  ['índice heredado', (base, id) => path.join(base, `folder-index-${id}.json`), 'RECORD_LINK'],
]) test(`un fallo de limpieza (${where} enlazado) se informa con la carpeta ya retirada, sin seguir el enlace`, async (t) => {
  const { root, base, motor, scope } = await fixture(t);
  const filename = linkName(base, scope.id);
  const target = path.join(root, 'ajeno');
  await fs.mkdir(target);
  await fs.writeFile(path.join(target, 'conservar.txt'), 'Ficticio ajeno');
  await fs.symlink(target, filename, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(motor.revokeFolder(scope.id), { code });
  assert.deepEqual(await motor.listAuthorizedFolders(), []);
  await assert.rejects(motor.readFolderIndex(scope.id), { code: 'FOLDER_NOT_AUTHORIZED' });
  assert.deepEqual(await fs.readdir(target), ['conservar.txt']);
  await fs.unlink(filename).catch(() => fs.rmdir(filename));
  assert.equal(await motor.revokeFolder(scope.id), false);
});

test('Motor usa el mismo intérprete configurado y falla cerrado si no está disponible', async (t) => {
  const { base, root, scope, published } = await fixture(t);
  const motor = await openMotor({ baseDirectory: base, pythonExecutable: path.join(root, 'python-inexistente') });
  await assert.rejects(motor.indexFolder(scope.id), { code: 'SAFE_SCAN_UNAVAILABLE' });
  assert.equal(await published(), null);
});
