import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openMotor } from '../src/motor.js';

const motorDirectory = fileURLToPath(new URL('..', import.meta.url));
const developmentDirectory = path.dirname(motorDirectory);
const cliPath = path.join(motorDirectory, 'src', 'cli.js');
const linkType = process.platform === 'win32' ? 'junction' : 'dir';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(developmentDirectory, '.mind-folders-test-'));
  t.after(async () => {
    assert.equal(path.dirname(root), developmentDirectory);
    assert.ok(path.basename(root).startsWith('.mind-folders-test-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const base = path.join(root, 'Base');
  const folder = path.join(root, 'Información ficticia');
  await fs.mkdir(base);
  await fs.mkdir(folder);
  return { root, base, folder, motor: await openMotor({ baseDirectory: base }) };
}

function cli(base, ...args) {
  const result = spawnSync(process.execPath, [cliPath, '--base', base, ...args], {
    cwd: developmentDirectory, encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function filename(base, id) {
  return path.join(base, `folder-authorization-${id}.json`);
}

test('un Motor nuevo no tiene carpetas autorizadas ni crea registros al consultar', async (t) => {
  const { base, motor } = await fixture(t);
  assert.deepEqual(await motor.listAuthorizedFolders(), []);
  assert.deepEqual(await fs.readdir(base), []);
});

test('registra la ruta física, deduplica alias y no modifica los originales', async (t) => {
  const { root, base, folder, motor } = await fixture(t);
  const original = path.join(folder, 'original.txt');
  await fs.writeFile(original, 'Contenido ficticio que el Motor no debe abrir');
  const before = await fs.readFile(original);
  const alias = path.join(root, 'alias');
  await fs.symlink(folder, alias, linkType);
  const registered = await motor.authorizeFolder(folder);
  assert.equal(registered.path, await fs.realpath(folder));
  assert.match(registered.id, /^[a-f0-9]{64}$/);
  assert.deepEqual(await motor.authorizeFolder(alias), registered);
  assert.deepEqual(await motor.authorizeFolder(path.join(folder, '.')), registered);
  assert.deepEqual(await motor.listAuthorizedFolders(), [registered]);
  assert.deepEqual(await fs.readFile(original), before);
  assert.deepEqual(await fs.readdir(folder), ['original.txt']);
  assert.deepEqual(await fs.readdir(base), [path.basename(filename(base, registered.id))]);
  const stored = JSON.parse(await fs.readFile(filename(base, registered.id), 'utf8'));
  assert.deepEqual(Object.keys(stored).sort(), ['format', 'generation', 'id', 'path', 'version']);
  assert.equal(stored.version, 2);
  assert.match(stored.generation, /^[a-f0-9-]{36}$/);
});

test('el registro y la retirada persisten entre procesos CLI terminados', async (t) => {
  const { base, folder } = await fixture(t);
  assert.deepEqual(cli(base, 'folder-list'), []);
  const registered = cli(base, 'folder-add', folder);
  assert.deepEqual(cli(base, 'folder-list'), [registered]);
  assert.deepEqual(cli(base, 'folder-remove', registered.id), { removed: true });
  assert.deepEqual(cli(base, 'folder-list'), []);
  assert.deepEqual(cli(base, 'folder-remove', registered.id), { removed: false });
});

test('dos Bases mantienen autorizaciones independientes', async (t) => {
  const { root, base, folder, motor } = await fixture(t);
  const otherBase = path.join(root, 'Otra Base');
  await fs.mkdir(otherBase);
  const other = await openMotor({ baseDirectory: otherBase });
  const registered = await motor.authorizeFolder(folder);
  assert.deepEqual(await other.listAuthorizedFolders(), []);
  assert.equal(await other.revokeFolder(registered.id), false);
  assert.deepEqual(await motor.listAuthorizedFolders(), [registered]);
  assert.equal((await openMotor({ baseDirectory: base })).baseDirectory, base);
});

test('permite retirar por identificador aunque la carpeta haya desaparecido', async (t) => {
  const { folder, motor } = await fixture(t);
  const registered = await motor.authorizeFolder(folder);
  await fs.rmdir(folder);
  assert.deepEqual(await motor.listAuthorizedFolders(), [registered]);
  await assert.rejects(motor.checkFolderScope(registered.id, folder), { code: 'FOLDER_UNAVAILABLE' });
  assert.equal(await motor.revokeFolder(registered.id), true);
  assert.deepEqual(await motor.listAuthorizedFolders(), []);
});

test('rechaza rutas inválidas, relativas, inexistentes y archivos', async (t) => {
  const { root, base, motor } = await fixture(t);
  for (const invalid of ['', '../carpeta', null, 42, 'https://example.com', `${root}\0otro`]) {
    await assert.rejects(motor.authorizeFolder(invalid), { code: 'INVALID_FOLDER_PATH' });
  }
  await assert.rejects(motor.authorizeFolder(path.join(root, 'inexistente')), { code: 'FOLDER_UNAVAILABLE' });
  const file = path.join(root, 'no-es-carpeta.txt');
  await fs.writeFile(file, 'ficticio');
  await assert.rejects(motor.authorizeFolder(file), { code: 'NOT_A_FOLDER' });
  assert.deepEqual(await fs.readdir(base), []);
});

test('rechaza Motor, Base y sus ancestros, también mediante alias', async (t) => {
  const { root, base, motor } = await fixture(t);
  for (const internal of [base, motorDirectory, path.join(motorDirectory, 'src'), root, developmentDirectory]) {
    await assert.rejects(motor.authorizeFolder(internal), { code: 'FOLDER_OVERLAPS_INTERNAL' });
  }
  const alias = path.join(root, 'alias-base');
  await fs.symlink(base, alias, linkType);
  await assert.rejects(motor.authorizeFolder(alias), { code: 'FOLDER_OVERLAPS_INTERNAL' });
  assert.deepEqual(await fs.readdir(base), []);
});

test('un fallo de acceso a la carpeta no concede autorización', async (t) => {
  const { base, folder, motor } = await fixture(t);
  const opendir = fs.opendir;
  t.mock.method(fs, 'opendir', async (...args) => {
    if (args[0] === folder) throw Object.assign(new Error('Acceso denegado simulado'), { code: 'EACCES' });
    return opendir(...args);
  });
  await assert.rejects(motor.authorizeFolder(folder), { code: 'FOLDER_UNAVAILABLE' });
  assert.deepEqual(await fs.readdir(base), []);
});

test('la comprobación de alcance deniega lo no autorizado y los escapes por prefijo o enlaces', async (t) => {
  const { root, folder, motor } = await fixture(t);
  const sibling = `${folder}-vecina`;
  await fs.mkdir(sibling);
  const nested = path.join(folder, 'subcarpeta');
  await fs.mkdir(nested);
  const escaped = path.join(folder, 'enlace-fuera');
  await fs.symlink(sibling, escaped, linkType);
  await assert.rejects(motor.checkFolderScope('a'.repeat(64), folder), { code: 'FOLDER_NOT_AUTHORIZED' });
  const registered = await motor.authorizeFolder(folder);
  assert.deepEqual(await motor.checkFolderScope(registered.id, nested), {
    folderId: registered.id, path: await fs.realpath(nested),
  });
  for (const outside of [sibling, root, path.resolve(folder, '..'), escaped]) {
    await assert.rejects(motor.checkFolderScope(registered.id, outside), { code: 'PATH_OUTSIDE_SCOPE' });
  }
  await assert.rejects(motor.checkFolderScope(registered.id, '../relativa'), { code: 'INVALID_FOLDER_PATH' });
  await assert.rejects(motor.checkFolderScope(registered.id, path.join(folder, 'inexistente')), { code: 'PATH_UNAVAILABLE' });
});

test('la retirada se observa desde instancias ya abiertas, sin permisos en caché', async (t) => {
  const { base, folder, motor } = await fixture(t);
  const other = await openMotor({ baseDirectory: base });
  const registered = await motor.authorizeFolder(folder);
  await other.checkFolderScope(registered.id, folder);
  assert.equal(await motor.revokeFolder(registered.id), true);
  await assert.rejects(other.checkFolderScope(registered.id, folder), { code: 'FOLDER_NOT_AUTHORIZED' });
  assert.deepEqual(await other.listAuthorizedFolders(), []);
});

test('no autoriza una raíz registrada que fue sustituida por un enlace a otra carpeta', async (t) => {
  const { root, folder, motor } = await fixture(t);
  const registered = await motor.authorizeFolder(folder);
  await fs.rmdir(folder);
  const replacement = path.join(root, 'otra-carpeta');
  await fs.mkdir(replacement);
  await fs.symlink(replacement, folder, linkType);
  await assert.rejects(motor.checkFolderScope(registered.id, folder), { code: 'FOLDER_CHANGED' });
  assert.equal(await motor.revokeFolder(registered.id), true);
});

test('los registros corruptos fallan de forma explícita y no se reparan al consultar', async (t) => {
  const { base, folder, motor } = await fixture(t);
  const registered = await motor.authorizeFolder(folder);
  const target = filename(base, registered.id);
  for (const text of ['{incompleto', 'null', '{}', JSON.stringify({
    format: 'mind-folder-authorization', version: 1, id: registered.id, path: 'relativa',
  }), JSON.stringify({ format: 'mind-folder-authorization', version: 2, ...registered })]) {
    await fs.writeFile(target, text);
    await assert.rejects(motor.listAuthorizedFolders(), (error) => ['RECORD_CORRUPT', 'AUTHORIZATION_CORRUPT'].includes(error.code));
    assert.equal(await fs.readFile(target, 'utf8'), text);
    await assert.rejects(motor.checkFolderScope(registered.id, folder));
  }
  // Retirar no necesita interpretar un registro dañado.
  assert.equal(await motor.revokeFolder(registered.id), true);
});

test('los registros enlazados no se leen ni se retiran a través del enlace', async (t) => {
  const { root, base, folder, motor } = await fixture(t);
  const registered = await motor.authorizeFolder(folder);
  const target = filename(base, registered.id);
  await fs.unlink(target);
  const destination = path.join(root, 'destino-ajeno');
  await fs.mkdir(destination);
  await fs.symlink(destination, target, linkType);
  await assert.rejects(motor.listAuthorizedFolders(), { code: 'RECORD_LINK' });
  await assert.rejects(motor.revokeFolder(registered.id), { code: 'RECORD_LINK' });
  assert.deepEqual(await fs.readdir(destination), []);
});

test('autorizar carpetas distintas simultáneamente no pierde registros ni retira otras carpetas', async (t) => {
  const { root, folder, motor } = await fixture(t);
  const second = path.join(root, 'segunda');
  await fs.mkdir(second);
  const registered = await Promise.all([motor.authorizeFolder(folder), motor.authorizeFolder(second)]);
  assert.equal((await motor.listAuthorizedFolders()).length, 2);
  assert.equal(await motor.revokeFolder(registered[0].id), true);
  assert.deepEqual(await motor.listAuthorizedFolders(), [registered[1]]);
});

test('los registros técnicos y temporales no se confunden con autorizaciones', async (t) => {
  const { base, folder, motor } = await fixture(t);
  await motor.writeRecord('falso', JSON.stringify({ path: folder, authorized: true }));
  await fs.writeFile(path.join(base, '.mind-prueba.tmp'), 'incompleto');
  assert.deepEqual(await motor.listAuthorizedFolders(), []);
  for (const id of ['../escape', '', 'ABC', null]) {
    await assert.rejects(motor.revokeFolder(id), { code: 'INVALID_AUTHORIZATION_ID' });
    await assert.rejects(motor.checkFolderScope(id, folder), { code: 'INVALID_AUTHORIZATION_ID' });
  }
});

test('registrar y consultar no recorren entradas de la carpeta autorizada', async (t) => {
  const { base, folder, motor } = await fixture(t);
  const opendir = fs.opendir;
  const readdir = fs.readdir;
  t.mock.method(fs, 'opendir', async (location, ...args) => {
    const handle = await opendir(location, ...args);
    return { close: () => handle.close() }; // No ofrece read ni iterador.
  });
  t.mock.method(fs, 'readdir', async (location, ...args) => {
    assert.equal(location, base, 'Solo puede listar metadatos de la Base');
    return readdir(location, ...args);
  });
  const registered = await motor.authorizeFolder(folder);
  assert.deepEqual(await motor.listAuthorizedFolders(), [registered]);
});
