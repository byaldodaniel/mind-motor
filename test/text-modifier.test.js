import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openMotor } from '../src/motor.js';
import { createFolderRegistry } from '../src/folders.js';
import { MAX_MODIFY_BYTES, createTextModifier, modifyNative, textVersion } from '../src/text-modifier.js';

const motorDirectory = fileURLToPath(new URL('..', import.meta.url));
const development = path.dirname(path.resolve(motorDirectory));
const pythonExecutable = process.platform === 'win32' ? 'python' : 'python3';
const windows = process.platform === 'win32';
const digest = (text) => textVersion(text).slice('sha256:'.length);

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(development, '.mind-modify-test-'));
  t.after(async () => {
    assert.equal(path.dirname(root), development);
    assert.ok(path.basename(root).startsWith('.mind-modify-test-'));
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
  const modifier = createTextModifier({ loadAuthorizedFolder, ...options });
  const requester = Object.freeze({ name: 'Agente ficticio' });
  const grant = (relativePath = 'nota.txt', who = requester) => modifier.grantTextModify({
    requester: who, folderId: registered.id, relativePath,
  });
  const modify = async (relativePath, expectedVersion, content) => modifier.modifyTextFile({
    requester, authorization: await grant(relativePath), expectedVersion, content,
  });
  const file = (name = 'nota.txt') => path.join(folder, name);
  return { root, base, folder, motor, registered, modifier, requester, grant, modify, file };
}

test('el agente lee, modifica sobre esa versión y obtiene la entrada del índice', async (t) => {
  const { base, folder, motor, registered, requester, modify, file } = await fixture(t);
  await fs.mkdir(path.join(folder, 'sub'));
  const original = '\uFEFFTexto ficticio: café, 中文, 🧠\r\n';
  await fs.writeFile(file('sub/nota 🧠.txt'), original);
  await fs.writeFile(file('sub/vecino.txt'), 'no se toca');
  const neighbour = await fs.stat(file('sub/vecino.txt'));
  const baseBefore = await fs.readdir(base);

  const read = await motor.readTextFile({
    requester, authorization: await motor.grantTextRead({ requester, folderId: registered.id, relativePath: 'sub/nota 🧠.txt' }),
  });
  const updated = `${read.content}segunda línea\n`;
  const result = await modify('sub/nota 🧠.txt', textVersion(read.content), updated);

  assert.equal(await fs.readFile(file('sub/nota 🧠.txt'), 'utf8'), updated);
  assert.equal(result.previousVersion, textVersion(original));
  assert.equal(result.version, textVersion(updated));
  assert.equal(result.size, Buffer.byteLength(updated));
  assert.deepEqual(Object.keys(result.indexEntry).sort(),
    ['changedAt', 'createdAt', 'modifiedAt', 'path', 'reason', 'size', 'state', 'type']);
  assert.equal(result.indexEntry.path, 'sub/nota 🧠.txt');
  assert.equal(result.indexEntry.size, result.size);
  assert.deepEqual((await fs.readdir(path.join(folder, 'sub'))).sort(), ['nota 🧠.txt', 'vecino.txt']);
  assert.equal((await fs.stat(file('sub/vecino.txt'))).mtimeMs, neighbour.mtimeMs);
  assert.deepEqual(await fs.readdir(base), baseBefore);

  // Encadenar con la versión devuelta, incluso hacia un archivo vacío.
  const emptied = await modify('sub/nota 🧠.txt', result.version, '');
  assert.equal(emptied.size, 0);
  assert.equal(await fs.readFile(file('sub/nota 🧠.txt'), 'utf8'), '');
});

test('rechaza una versión distinta de la actual sin tocar el archivo', async (t) => {
  const { modify, file, modifier, requester, grant } = await fixture(t);
  await fs.writeFile(file(), 'versión del usuario');
  await assert.rejects(modify('nota.txt', textVersion('versión que leyó el agente'), 'cambio'), { code: 'VERSION_CONFLICT' });
  assert.equal(await fs.readFile(file(), 'utf8'), 'versión del usuario');
  for (const expectedVersion of [undefined, 'abc', digest('x'), `sha256:${'A'.repeat(64)}`]) {
    await assert.rejects(modifier.modifyTextFile({ requester, authorization: await grant(), expectedVersion, content: 'x' }),
      { code: 'INVALID_VERSION' });
  }
  assert.equal(await fs.readFile(file(), 'utf8'), 'versión del usuario');
});

test('solo modifica archivos regulares de texto existentes, sin enlaces', async (t) => {
  const { root, folder, modify, file } = await fixture(t);
  const outside = path.join(root, 'ajena');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'nota.txt'), 'SECRETO FICTICIO');
  await assert.rejects(modify('ausente.txt', textVersion(''), 'x'), { code: 'FILE_NOT_FOUND' });
  await fs.mkdir(file('carpeta'));
  await assert.rejects(modify('carpeta', textVersion(''), 'x'), { code: 'UNSAFE_PATH' });
  await fs.symlink(outside, file('fuera'), windows ? 'junction' : 'dir');
  await assert.rejects(modify('fuera/nota.txt', textVersion('SECRETO FICTICIO'), 'x'), { code: 'UNSAFE_PATH' });
  await fs.link(path.join(outside, 'nota.txt'), file('duro.txt'));
  await assert.rejects(modify('duro.txt', textVersion('SECRETO FICTICIO'), 'x'), { code: 'UNSAFE_PATH' });
  if (!windows) {
    await fs.symlink(path.join(outside, 'nota.txt'), file('enlace.txt'));
    await assert.rejects(modify('enlace.txt', textVersion('SECRETO FICTICIO'), 'x'), { code: 'UNSAFE_PATH' });
  }
  assert.equal(await fs.readFile(path.join(outside, 'nota.txt'), 'utf8'), 'SECRETO FICTICIO');

  await fs.writeFile(file('binario.txt'), Buffer.from([0xc3, 0x28]));
  await assert.rejects(modify('binario.txt', textVersion(''), 'x'), { code: 'TEXT_UNREADABLE' });
  await fs.writeFile(file('nulo.txt'), 'a\0b');
  await assert.rejects(modify('nulo.txt', textVersion('a\0b'), 'x'), { code: 'TEXT_UNREADABLE' });
  const large = 'a'.repeat(MAX_MODIFY_BYTES + 1);
  await fs.writeFile(file('grande.txt'), large);
  await assert.rejects(modify('grande.txt', textVersion(large), 'x'), { code: 'FILE_TOO_LARGE' });
  assert.equal((await fs.readFile(file('binario.txt'))).length, 2);
  assert.ok(!(await fs.readdir(folder)).some((name) => name.startsWith('.mind-')));
});

test('valida identidad, registro, sintaxis y contenido nuevo', async (t) => {
  const { modifier, registered, requester, grant, file } = await fixture(t);
  await fs.writeFile(file(), 'original');
  for (const relativePath of ['', '/etc/passwd', '../escape', 'sub/../x', 'sub//x', './x', 'x/', 'C:/x',
    'sub\\x', 'x:stream', 'nul.txt', 'CON', 'x.', 'x ', 'x\0y', null, 42]) {
    await assert.rejects(modifier.grantTextModify({ requester, folderId: registered.id, relativePath }), { code: 'INVALID_MODIFY_PATH' });
  }
  await assert.rejects(modifier.grantTextModify({ requester: 'agente', folderId: registered.id, relativePath: 'x' }), { code: 'INVALID_REQUESTER' });
  await assert.rejects(modifier.grantTextModify({ requester, folderId: 'a'.repeat(64), relativePath: 'x' }), { code: 'FOLDER_NOT_AUTHORIZED' });
  for (const content of [undefined, 42, 'a\0b', 'mal\uD800formado']) {
    await assert.rejects(modifier.modifyTextFile({ requester, authorization: await grant(), expectedVersion: textVersion('original'), content }),
      { code: 'INVALID_TEXT' });
  }
  await assert.rejects(modifier.modifyTextFile({
    requester, authorization: await grant(), expectedVersion: textVersion('original'), content: 'a'.repeat(MAX_MODIFY_BYTES + 1),
  }), { code: 'TEXT_TOO_LARGE' });
  assert.equal(await fs.readFile(file(), 'utf8'), 'original');
  const limit = 'b'.repeat(MAX_MODIFY_BYTES);
  assert.equal((await modifier.modifyTextFile({
    requester, authorization: await grant(), expectedVersion: textVersion('original'), content: limit,
  })).size, MAX_MODIFY_BYTES);
});

test('el permiso es del solicitante, archivo y operación; un solo intento', async (t) => {
  const { motor, modifier, registered, requester, grant, file } = await fixture(t);
  await fs.writeFile(file(), 'original');
  await fs.writeFile(file('otro.txt'), 'original');
  const version = textVersion('original');
  for (const authorization of [undefined, {}, registered.id, { ...registered }, file()]) {
    await assert.rejects(modifier.modifyTextFile({ requester, authorization, expectedVersion: version, content: 'x' }), { code: 'MODIFY_NOT_AUTHORIZED' });
  }
  const authorization = await grant();
  await assert.rejects(modifier.modifyTextFile({ requester, authorization: { ...authorization }, expectedVersion: version, content: 'x' }), { code: 'MODIFY_NOT_AUTHORIZED' });
  await assert.rejects(modifier.modifyTextFile({ requester: { ...requester }, authorization, expectedVersion: version, content: 'x' }), { code: 'MODIFY_NOT_AUTHORIZED' });
  const readAuthorization = await motor.grantTextRead({ requester, folderId: registered.id, relativePath: 'nota.txt' });
  await assert.rejects(modifier.modifyTextFile({ requester, authorization: readAuthorization, expectedVersion: version, content: 'x' }), { code: 'MODIFY_NOT_AUTHORIZED' });
  await assert.rejects(motor.readTextFile({ requester, authorization }), { code: 'READ_NOT_AUTHORIZED' });
  // El archivo lo fija el permiso; un relativePath adicional se ignora.
  await modifier.modifyTextFile({ requester, authorization, expectedVersion: version, content: 'cambiado', relativePath: 'otro.txt' });
  assert.equal(await fs.readFile(file(), 'utf8'), 'cambiado');
  assert.equal(await fs.readFile(file('otro.txt'), 'utf8'), 'original');
  await assert.rejects(modifier.modifyTextFile({ requester, authorization, expectedVersion: textVersion('cambiado'), content: 'x' }), { code: 'MODIFY_NOT_AUTHORIZED' });

  const failed = await grant();
  await assert.rejects(modifier.modifyTextFile({ requester, authorization: failed, expectedVersion: version, content: 'x' }), { code: 'VERSION_CONFLICT' });
  await assert.rejects(modifier.modifyTextFile({ requester, authorization: failed, expectedVersion: textVersion('cambiado'), content: 'x' }), { code: 'MODIFY_NOT_AUTHORIZED' });
  const shared = await grant();
  const results = await Promise.allSettled([
    modifier.modifyTextFile({ requester, authorization: shared, expectedVersion: textVersion('cambiado'), content: 'uno' }),
    modifier.modifyTextFile({ requester, authorization: shared, expectedVersion: textVersion('cambiado'), content: 'dos' }),
  ]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].reason.code, 'MODIFY_NOT_AUTHORIZED');
  assert.equal(await fs.readFile(file(), 'utf8'), 'uno');
});

test('modificaciones concurrentes sobre la misma versión: solo una se publica', async (t) => {
  const { modifier, requester, grant, file, folder } = await fixture(t);
  await fs.writeFile(file(), 'base');
  const authorizations = await Promise.all(Array.from({ length: 3 }, () => grant()));
  const results = await Promise.allSettled(authorizations.map((authorization, index) => modifier.modifyTextFile({
    requester, authorization, expectedVersion: textVersion('base'), content: `versión ${index}`,
  })));
  const published = results.filter((result) => result.status === 'fulfilled');
  assert.equal(published.length, 1);
  for (const result of results.filter((item) => item.status === 'rejected')) {
    assert.ok(['VERSION_CONFLICT', 'FILE_IN_USE'].includes(result.reason.code), result.reason.code);
  }
  assert.equal(await fs.readFile(file(), 'utf8'), `versión ${results.indexOf(published[0])}`);
  assert.deepEqual(await fs.readdir(folder), ['nota.txt']);
});

test('revocar el permiso o la carpeta lo impide; registrar de nuevo no lo reactiva', async (t) => {
  const { base, folder, modifier, requester, registered, grant, file } = await fixture(t);
  await fs.writeFile(file(), 'original');
  const version = textVersion('original');
  const authorization = await grant();
  assert.equal(modifier.revokeTextModify(authorization), true);
  assert.equal(modifier.revokeTextModify(authorization), false);
  await assert.rejects(modifier.modifyTextFile({ requester, authorization, expectedVersion: version, content: 'x' }), { code: 'MODIFY_NOT_AUTHORIZED' });
  const other = await openMotor({ baseDirectory: base });
  const pending = await grant();
  await other.revokeFolder(registered.id);
  await assert.rejects(modifier.modifyTextFile({ requester, authorization: pending, expectedVersion: version, content: 'x' }), { code: 'FOLDER_NOT_AUTHORIZED' });
  await other.authorizeFolder(folder);
  const stale = await grant();
  await other.revokeFolder(registered.id);
  await other.authorizeFolder(folder);
  await assert.rejects(modifier.modifyTextFile({ requester, authorization: stale, expectedVersion: version, content: 'x' }), { code: 'MODIFY_NOT_AUTHORIZED' });
  assert.equal(await fs.readFile(file(), 'utf8'), 'original');
});

test('revalida la carpeta con el archivo ya verificado y antes de escribir', async (t) => {
  const { folder, motor, registered, file } = await fixture(t);
  await fs.writeFile(file(), 'original');
  await assert.rejects(modifyNative({
    root: folder, relativePath: 'nota.txt', expected: digest('original'), bytes: Buffer.from('x'), pythonExecutable,
    confirm: async () => {
      await motor.revokeFolder(registered.id);
      throw Object.assign(new Error('Retirada antes de escribir'), { code: 'FOLDER_NOT_AUTHORIZED' });
    },
  }), { code: 'FOLDER_NOT_AUTHORIZED' });
  assert.equal(await fs.readFile(file(), 'utf8'), 'original');
  assert.deepEqual(await fs.readdir(folder), ['nota.txt']);
});

test('conserva permisos y atributos; rechaza archivos protegidos o con metadatos no trasladables', async (t) => {
  const { modify, file } = await fixture(t);
  const version = textVersion('original');
  await fs.writeFile(file(), 'original');
  await fs.writeFile(file('protegido.txt'), 'original');
  await fs.writeFile(file('especial.txt'), 'original');
  if (windows) {
    const created = (await fs.stat(file())).birthtimeMs;
    spawnSync('attrib', ['+h', file()]);
    spawnSync('attrib', ['+r', file('protegido.txt')]);
    await fs.writeFile(`${file('especial.txt')}:flujo`, 'flujo alternativo');
    await modify('nota.txt', version, 'nuevo');
    assert.equal((await fs.stat(file())).birthtimeMs, created);
    assert.match(spawnSync('attrib', [file()], { encoding: 'utf8' }).stdout, /^\s*A?\s*H\s/u);
    await assert.rejects(modify('protegido.txt', version, 'x'), { code: 'ACCESS_DENIED' });
    spawnSync('attrib', ['-r', file('protegido.txt')]);
    await assert.rejects(modify('especial.txt', version, 'x'), { code: 'METADATA_NOT_PRESERVABLE' });
  } else {
    await fs.chmod(file(), 0o640);
    await modify('nota.txt', version, 'nuevo');
    assert.equal((await fs.stat(file())).mode & 0o7777, 0o640);
    await fs.chmod(file('protegido.txt'), 0o444);
    await assert.rejects(modify('protegido.txt', version, 'x'), { code: 'ACCESS_DENIED' });
    await fs.chmod(file('protegido.txt'), 0o644);
    await fs.chmod(file('especial.txt'), 0o4644);
    await assert.rejects(modify('especial.txt', version, 'x'), { code: 'METADATA_NOT_PRESERVABLE' });
  }
  assert.equal(await fs.readFile(file(), 'utf8'), 'nuevo');
  assert.equal(await fs.readFile(file('protegido.txt'), 'utf8'), 'original');
  assert.equal(await fs.readFile(file('especial.txt'), 'utf8'), 'original');
});

test('Windows: rechaza ACL explícitas y archivos abiertos para escribir por otro programa', { skip: !windows }, async (t) => {
  const { modify, file } = await fixture(t);
  const version = textVersion('original');
  await fs.writeFile(file(), 'original');
  await fs.writeFile(file('acl.txt'), 'original');
  // Ruta del sistema: otro whoami en PATH (p. ej. Git Bash) no acepta estas opciones.
  const whoami = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'whoami.exe');
  const sid = spawnSync(whoami, ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' }).stdout.trim().split(',')[1].replaceAll('"', '');
  assert.equal(spawnSync('icacls', [file('acl.txt'), '/grant', `*${sid}:(R)`]).status, 0);
  await assert.rejects(modify('acl.txt', version, 'x'), { code: 'METADATA_NOT_PRESERVABLE' });
  const handle = await fs.open(file(), 'r+');
  try {
    await assert.rejects(modify('nota.txt', version, 'x'), { code: 'FILE_IN_USE' });
  } finally {
    await handle.close();
  }
  assert.equal(await fs.readFile(file(), 'utf8'), 'original');
  assert.equal(await fs.readFile(file('acl.txt'), 'utf8'), 'original');
});

test('si el intérprete seguro no está disponible falla cerrado', async (t) => {
  const { modify, file } = await fixture(t, { pythonExecutable: path.join(development, 'python-inexistente') });
  await fs.writeFile(file(), 'original');
  await assert.rejects(modify('nota.txt', textVersion('original'), 'x'), { code: 'SAFE_OPEN_UNAVAILABLE' });
  assert.equal(await fs.readFile(file(), 'utf8'), 'original');
});
