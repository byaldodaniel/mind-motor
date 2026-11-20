import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openMotor } from '../src/motor.js';
import { createFolderRegistry } from '../src/folders.js';
import { MAX_CREATE_BYTES, createNative, createTextCreator } from '../src/text-creator.js';

const motorDirectory = fileURLToPath(new URL('..', import.meta.url));
const development = path.dirname(path.resolve(motorDirectory));
const pythonExecutable = process.env.MIND_TEST_BUNDLED_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
const nativeFilesExecutable = process.env.MIND_TEST_NATIVE_FILES;
const executables = { pythonExecutable, nativeFilesExecutable };
const linkType = process.platform === 'win32' ? 'junction' : 'dir';

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(development, '.mind-create-test-'));
  t.after(async () => {
    assert.equal(path.dirname(root), development);
    assert.ok(path.basename(root).startsWith('.mind-create-test-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const base = path.join(root, 'Base');
  const folder = path.join(root, 'Información ficticia');
  await fs.mkdir(base);
  await fs.mkdir(folder);
  const motor = await openMotor({ baseDirectory: base });
  const registered = await motor.authorizeFolder(folder);
  // Mismo registro privado que usa el Motor oficial; no hay otro sistema de permisos.
  const { loadAuthorizedFolder } = createFolderRegistry(motor.baseDirectory, await fs.realpath(motorDirectory));
  const creator = createTextCreator({ loadAuthorizedFolder, ...executables, ...options });
  const requester = Object.freeze({ name: 'Agente ficticio' });
  const grant = (relativePath = 'nuevo.txt', who = requester) => creator.grantTextCreate({
    requester: who, folderId: registered.id, relativePath,
  });
  const create = async (relativePath, content = 'texto ficticio') => creator.createTextFile({
    requester, authorization: await grant(relativePath), content,
  });
  return { root, base, folder, motor, registered, creator, requester, grant, create };
}

async function tree(directory) {
  const result = [];
  for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    result.push(entry.name);
    if (entry.isDirectory()) result.push(...(await tree(path.join(directory, entry.name))).map((name) => `${entry.name}/${name}`));
  }
  return result;
}

test('crea solo el archivo pedido con el texto exacto y prepara la entrada del índice', async (t) => {
  const { base, folder, create, registered } = await fixture(t);
  await fs.mkdir(path.join(folder, 'sub'));
  const neighbour = path.join(folder, 'sub', 'vecino.txt');
  await fs.writeFile(neighbour, 'no se toca');
  const before = await fs.stat(neighbour);
  const baseBefore = await fs.readdir(base);
  const content = '\uFEFFTexto ficticio: café, 中文, 🧠\r\nsegunda línea\n';

  const result = await create('sub/café 🧠.txt', content);
  assert.equal(await fs.readFile(path.join(folder, 'sub', 'café 🧠.txt'), 'utf8'), content);
  assert.equal(result.folderId, registered.id);
  assert.equal(result.relativePath, 'sub/café 🧠.txt');
  assert.equal(result.size, Buffer.byteLength(content));
  assert.deepEqual(Object.keys(result.indexEntry).sort(),
    ['changedAt', 'createdAt', 'identity', 'modifiedAt', 'path', 'reason', 'size', 'state', 'type']);
  assert.equal(result.indexEntry.path, 'sub/café 🧠.txt');
  assert.equal(result.indexEntry.type, 'file');
  assert.equal(result.indexEntry.size, result.size);
  assert.match(result.indexEntry.modifiedAt, /^\d{4}-\d{2}-\d{2}T.*Z$/);

  assert.deepEqual(await tree(folder), ['sub', 'sub/café 🧠.txt', 'sub/vecino.txt']);
  assert.equal((await fs.stat(neighbour)).mtimeMs, before.mtimeMs);
  // La Base no recibe copias del contenido creado.
  assert.deepEqual(await fs.readdir(base), baseBefore);
  assert.equal((await create('vacío.txt', '')).size, 0);
  assert.equal(await fs.readFile(path.join(folder, 'vacío.txt'), 'utf8'), '');
});

test('nunca sobrescribe archivos, carpetas ni enlaces existentes', async (t) => {
  const { root, folder, create } = await fixture(t);
  const outside = path.join(root, 'ajena');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(folder, 'existe.txt'), 'original');
  await fs.mkdir(path.join(folder, 'carpeta'));
  await fs.symlink(outside, path.join(folder, 'enlace'), linkType);
  for (const name of ['existe.txt', 'EXISTE.txt', 'carpeta', 'enlace']) {
    if (name === 'EXISTE.txt' && process.platform === 'linux') continue; // Linux distingue mayúsculas.
    await assert.rejects(create(name, 'sustituto'), { code: 'FILE_EXISTS' });
  }
  assert.equal(await fs.readFile(path.join(folder, 'existe.txt'), 'utf8'), 'original');
  assert.deepEqual(await fs.readdir(path.join(folder, 'carpeta')), []);
  assert.deepEqual(await fs.readdir(outside), []);
  assert.deepEqual(await tree(folder), ['carpeta', 'enlace', 'existe.txt']);
});

test('rechaza enlaces y junctions en la ruta, y una raíz sustituida por un enlace', async (t) => {
  const { root, folder, create } = await fixture(t);
  const outside = path.join(root, 'ajena');
  await fs.mkdir(outside);
  await fs.mkdir(path.join(folder, 'dentro'));
  await fs.symlink(outside, path.join(folder, 'fuera'), linkType);
  await fs.symlink(path.join(folder, 'dentro'), path.join(folder, 'alias'), linkType);
  for (const name of ['fuera/nuevo.txt', 'alias/nuevo.txt']) {
    await assert.rejects(create(name), { code: 'UNSAFE_PATH' });
  }
  await fs.rename(folder, `${folder}-original`);
  await fs.symlink(outside, folder, linkType);
  await assert.rejects(create('nuevo.txt'), { code: 'UNSAFE_PATH' });
  assert.deepEqual(await fs.readdir(outside), []);
  assert.deepEqual(await fs.readdir(path.join(`${folder}-original`, 'dentro')), []);
});

test('no crea carpetas intermedias ni atraviesa archivos', async (t) => {
  const { folder, create } = await fixture(t);
  await fs.writeFile(path.join(folder, 'archivo'), 'x');
  await assert.rejects(create('falta/nuevo.txt'), { code: 'PARENT_NOT_FOUND' });
  await assert.rejects(create('archivo/nuevo.txt'), { code: 'UNSAFE_PATH' });
  assert.deepEqual(await tree(folder), ['archivo']);
});

test('valida identidad, registro, sintaxis y contenido', async (t) => {
  const { folder, creator, registered, requester, grant } = await fixture(t);
  for (const relativePath of ['', '/etc/passwd', '../escape', 'sub/../x', 'sub//x', './x', 'x/', 'C:/x',
    'sub\\x', 'x:stream', 'nul.txt', 'CON', 'x.', 'x ', 'x\0y', 'x\ny', null, 42]) {
    await assert.rejects(creator.grantTextCreate({ requester, folderId: registered.id, relativePath }), { code: 'INVALID_CREATE_PATH' });
  }
  await assert.rejects(creator.grantTextCreate({ requester: 'agente', folderId: registered.id, relativePath: 'x' }), { code: 'INVALID_REQUESTER' });
  await assert.rejects(creator.grantTextCreate({ requester, folderId: 'a'.repeat(64), relativePath: 'x' }), { code: 'FOLDER_NOT_AUTHORIZED' });
  for (const content of [undefined, 42, Buffer.from('x'), 'a\0b', 'mal\uD800formado']) {
    await assert.rejects(creator.createTextFile({ requester, authorization: await grant(), content }), { code: 'INVALID_TEXT' });
  }
  await assert.rejects(
    creator.createTextFile({ requester, authorization: await grant(), content: 'a'.repeat(MAX_CREATE_BYTES + 1) }),
    { code: 'TEXT_TOO_LARGE' },
  );
  const limit = await creator.createTextFile({ requester, authorization: await grant('límite.txt'), content: 'a'.repeat(MAX_CREATE_BYTES) });
  assert.equal(limit.size, MAX_CREATE_BYTES);
  assert.deepEqual(await fs.readdir(folder), ['límite.txt']);
});

test('el permiso es del solicitante, destino y operación; no se copia ni sirve para leer', async (t) => {
  const { folder, motor, creator, registered, requester, grant } = await fixture(t);
  for (const authorization of [undefined, {}, registered.id, { ...registered }, path.join(folder, 'nuevo.txt')]) {
    await assert.rejects(creator.createTextFile({ requester, authorization, content: 'x' }), { code: 'CREATE_NOT_AUTHORIZED' });
  }
  const authorization = await grant();
  await assert.rejects(creator.createTextFile({ requester, authorization: { ...authorization }, content: 'x' }), { code: 'CREATE_NOT_AUTHORIZED' });
  await assert.rejects(creator.createTextFile({ requester: { ...requester }, authorization, content: 'x' }), { code: 'CREATE_NOT_AUTHORIZED' });
  // Un permiso de lectura no autoriza crear y uno de creación no autoriza leer.
  const readAuthorization = await motor.grantTextRead({ requester, folderId: registered.id, relativePath: 'nuevo.txt' });
  await assert.rejects(creator.createTextFile({ requester, authorization: readAuthorization, content: 'x' }), { code: 'CREATE_NOT_AUTHORIZED' });
  await assert.rejects(motor.readTextFile({ requester, authorization }), { code: 'READ_NOT_AUTHORIZED' });
  // El destino lo fija el permiso; un relativePath adicional se ignora.
  await creator.createTextFile({ requester, authorization, content: 'permitido', relativePath: 'otro.txt' });
  assert.deepEqual(await fs.readdir(folder), ['nuevo.txt']);
  await assert.rejects(creator.createTextFile({ requester, authorization, content: 'x' }), { code: 'CREATE_NOT_AUTHORIZED' });
  // Otra instancia no reconoce permisos ajenos.
  const { loadAuthorizedFolder } = createFolderRegistry(motor.baseDirectory, await fs.realpath(motorDirectory));
  const other = createTextCreator({ loadAuthorizedFolder });
  await assert.rejects(other.createTextFile({ requester, authorization: await grant('b.txt'), content: 'x' }), { code: 'CREATE_NOT_AUTHORIZED' });
});

test('un solo intento: un fallo o un uso paralelo consumen el permiso', async (t) => {
  const { folder, creator, requester, grant } = await fixture(t);
  await fs.writeFile(path.join(folder, 'existe.txt'), 'original');
  const failed = await grant('existe.txt');
  await assert.rejects(creator.createTextFile({ requester, authorization: failed, content: 'x' }), { code: 'FILE_EXISTS' });
  await fs.rm(path.join(folder, 'existe.txt'));
  await assert.rejects(creator.createTextFile({ requester, authorization: failed, content: 'x' }), { code: 'CREATE_NOT_AUTHORIZED' });

  const invalid = await grant('inválido.txt');
  await assert.rejects(creator.createTextFile({ requester, authorization: invalid, content: 42 }), { code: 'INVALID_TEXT' });
  await assert.rejects(creator.createTextFile({ requester, authorization: invalid, content: 'x' }), { code: 'CREATE_NOT_AUTHORIZED' });

  const shared = await grant('paralelo.txt');
  const results = await Promise.allSettled([
    creator.createTextFile({ requester, authorization: shared, content: 'uno' }),
    creator.createTextFile({ requester, authorization: shared, content: 'dos' }),
  ]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].reason.code, 'CREATE_NOT_AUTHORIZED');
  assert.equal(await fs.readFile(path.join(folder, 'paralelo.txt'), 'utf8'), 'uno');
});

test('dos permisos concurrentes al mismo destino crean un solo archivo', async (t) => {
  const { folder, creator, requester, grant } = await fixture(t);
  const authorizations = await Promise.all(Array.from({ length: 4 }, () => grant('carrera.txt')));
  const results = await Promise.allSettled(authorizations.map((authorization, index) => creator.createTextFile({
    requester, authorization, content: `versión ${index}`,
  })));
  const created = results.filter((result) => result.status === 'fulfilled');
  assert.equal(created.length, 1);
  for (const result of results.filter((item) => item.status === 'rejected')) {
    assert.equal(result.reason.code, 'FILE_EXISTS');
  }
  assert.match(await fs.readFile(path.join(folder, 'carrera.txt'), 'utf8'), /^versión \d$/);
  assert.deepEqual(await fs.readdir(folder), ['carrera.txt']);
});

test('revocar el permiso o la carpeta antes del intento lo impide; registrar de nuevo no lo reactiva', async (t) => {
  const { base, folder, creator, requester, registered, grant } = await fixture(t);
  const authorization = await grant();
  assert.equal(creator.revokeTextCreate(authorization), true);
  assert.equal(creator.revokeTextCreate(authorization), false);
  await assert.rejects(creator.createTextFile({ requester, authorization, content: 'x' }), { code: 'CREATE_NOT_AUTHORIZED' });

  const other = await openMotor({ baseDirectory: base });
  const pending = await grant();
  await other.revokeFolder(registered.id);
  await assert.rejects(creator.createTextFile({ requester, authorization: pending, content: 'x' }), { code: 'FOLDER_NOT_AUTHORIZED' });
  await assert.rejects(grant(), { code: 'FOLDER_NOT_AUTHORIZED' });

  await other.authorizeFolder(folder);
  const stale = await grant();
  await other.revokeFolder(registered.id);
  await other.authorizeFolder(folder);
  await assert.rejects(creator.createTextFile({ requester, authorization: stale, content: 'x' }), { code: 'CREATE_NOT_AUTHORIZED' });
  assert.deepEqual(await fs.readdir(folder), []);
});

test('revalida la carpeta tras adquirir el padre y antes de crear', async (t) => {
  const { folder, motor, registered } = await fixture(t);
  await assert.rejects(createNative({
    root: folder, relativePath: 'nuevo.txt', bytes: Buffer.from('x'), ...executables,
    confirm: async () => {
      await motor.revokeFolder(registered.id);
      throw Object.assign(new Error('Retirada antes de crear'), { code: 'FOLDER_NOT_AUTHORIZED' });
    },
  }), { code: 'FOLDER_NOT_AUTHORIZED' });
  assert.deepEqual(await fs.readdir(folder), []);
});

test('si el intérprete seguro no está disponible falla cerrado', async (t) => {
  const { folder, create } = await fixture(t, { [nativeFilesExecutable ? 'nativeFilesExecutable' : 'pythonExecutable']: path.join(development, 'lector-inexistente') });
  await assert.rejects(create('nuevo.txt'), { code: 'SAFE_OPEN_UNAVAILABLE' });
  assert.deepEqual(await fs.readdir(folder), []);
});
