import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openMotor } from '../src/motor.js';
import { MAX_TEXT_BYTES, readNative } from '../src/text-reader.js';

const development = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const pythonExecutable = process.platform === 'win32' ? 'python' : 'python3';
const linkType = process.platform === 'win32' ? 'junction' : 'dir';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(development, '.mind-read-test-'));
  t.after(async () => {
    assert.equal(path.dirname(root), development);
    assert.ok(path.basename(root).startsWith('.mind-read-test-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const base = path.join(root, 'Base');
  const folder = path.join(root, 'Información ficticia');
  await fs.mkdir(base);
  await fs.mkdir(folder);
  const motor = await openMotor({ baseDirectory: base });
  const registered = await motor.authorizeFolder(folder);
  const requester = Object.freeze({ name: 'Agente ficticio' });
  const grant = (relativePath = 'texto.txt', who = requester) => motor.grantTextRead({
    requester: who, folderId: registered.id, relativePath,
  });
  const read = async (relativePath) => motor.readTextFile({ requester, authorization: await grant(relativePath) });
  return { root, base, folder, motor, registered, requester, grant, read };
}

test('lee solo el texto solicitado, conserva bytes y mtime, sin registrar contenido en Base', async (t) => {
  const { base, folder, read } = await fixture(t);
  await fs.mkdir(path.join(folder, 'sub'));
  const original = path.join(folder, 'sub', 'café 🧠.txt');
  const content = '\uFEFFTexto ficticio: café, 中文, 🧠\r\n';
  await fs.writeFile(original, content);
  await fs.writeFile(path.join(folder, 'otro.txt'), 'No solicitado');
  const before = await fs.stat(original);
  const metadata = await fs.readdir(base);
  // El auxiliar tampoco enumera entradas: se comprueba además en pruebas Python.
  const result = await read('sub/café 🧠.txt');
  assert.equal(result.content, content);
  assert.equal(result.relativePath, 'sub/café 🧠.txt');
  assert.equal(await fs.readFile(original, 'utf8'), content);
  assert.equal((await fs.stat(original)).mtimeMs, before.mtimeMs);
  assert.deepEqual(await fs.readdir(base), metadata);
});

test('conocer id/ruta, copiar un permiso o declarar el mismo nombre no concede acceso', async (t) => {
  const { folder, motor, requester, registered, grant } = await fixture(t);
  await fs.writeFile(path.join(folder, 'texto.txt'), 'ficticio');
  for (const authorization of [undefined, {}, registered.id, { ...registered }, path.join(folder, 'texto.txt')]) {
    await assert.rejects(motor.readTextFile({ requester, authorization }), { code: 'READ_NOT_AUTHORIZED' });
  }
  const authorization = await grant();
  await assert.rejects(motor.readTextFile({ requester, authorization: { ...authorization } }), { code: 'READ_NOT_AUTHORIZED' });
  await assert.rejects(motor.readTextFile({ requester: { ...requester }, authorization }), { code: 'READ_NOT_AUTHORIZED' });
  assert.equal((await motor.readTextFile({ requester, authorization })).content, 'ficticio');
  await assert.rejects(motor.readTextFile({ requester, authorization }), { code: 'READ_NOT_AUTHORIZED' });
});

test('el permiso no autoriza otro archivo ni otra instancia; no puede reutilizarse en paralelo', async (t) => {
  const { base, folder, motor, requester, grant } = await fixture(t);
  await fs.writeFile(path.join(folder, 'texto.txt'), 'permitido');
  await fs.writeFile(path.join(folder, 'otro.txt'), 'ajeno');
  const authorization = await grant();
  const other = await openMotor({ baseDirectory: base });
  await assert.rejects(other.readTextFile({ requester, authorization }), { code: 'READ_NOT_AUTHORIZED' });
  const results = await Promise.allSettled([
    motor.readTextFile({ requester, authorization, relativePath: 'otro.txt' }),
    motor.readTextFile({ requester, authorization }),
  ]);
  assert.equal(results[0].value.content, 'permitido');
  assert.equal(results[1].reason.code, 'READ_NOT_AUTHORIZED');
});

test('permite revocar el permiso antes del intento y observa la retirada persistente de carpeta', async (t) => {
  const { base, motor, requester, registered, grant } = await fixture(t);
  const authorization = await grant();
  assert.equal(motor.revokeTextRead(authorization), true);
  assert.equal(motor.revokeTextRead(authorization), false);
  await assert.rejects(motor.readTextFile({ requester, authorization }), { code: 'READ_NOT_AUTHORIZED' });
  const pending = await grant();
  const other = await openMotor({ baseDirectory: base });
  await other.revokeFolder(registered.id);
  await assert.rejects(motor.readTextFile({ requester, authorization: pending }), { code: 'FOLDER_NOT_AUTHORIZED' });
  await assert.rejects(grant(), { code: 'FOLDER_NOT_AUTHORIZED' });
});

test('valida identidad, registro y sintaxis común antes de abrir originales', async (t) => {
  const { motor, registered, requester } = await fixture(t);
  for (const relativePath of ['', '/etc/passwd', '../escape', 'sub/../x', 'sub//x', './x', 'x/', 'C:/x',
    'sub\\x', 'x:stream', 'nul.txt', 'CON', 'x.', 'x ', 'x\0y', 'x\ny', null, 42]) {
    await assert.rejects(motor.grantTextRead({ requester, folderId: registered.id, relativePath }), { code: 'INVALID_READ_PATH' });
  }
  await assert.rejects(motor.grantTextRead({ requester: 'agente', folderId: registered.id, relativePath: 'x' }), { code: 'INVALID_REQUESTER' });
  await assert.rejects(motor.grantTextRead({ requester, folderId: 'a'.repeat(64), relativePath: 'x' }), { code: 'FOLDER_NOT_AUTHORIZED' });
});

test('retirar y registrar de nuevo no reactiva permisos antiguos, incluso con un registro heredado v1', async (t) => {
  const { base, folder, motor, registered, grant, requester } = await fixture(t);
  await fs.writeFile(path.join(folder, 'texto.txt'), 'ficticio');
  const other = await openMotor({ baseDirectory: base });
  for (const legacy of [false, true]) {
    if (legacy) {
      await fs.writeFile(path.join(base, `folder-authorization-${registered.id}.json`), JSON.stringify({
        format: 'mind-folder-authorization', version: 1, ...registered,
      }));
    }
    const authorization = await grant();
    await other.revokeFolder(registered.id);
    await other.authorizeFolder(folder);
    await assert.rejects(motor.readTextFile({ requester, authorization }), { code: 'READ_NOT_AUTHORIZED' });
  }
});

test('distingue desaparición, UTF-8 inválido, NUL, directorio y exceso de tamaño; no devuelve contenido parcial', async (t) => {
  const { folder, read } = await fixture(t);
  await assert.rejects(read('ausente.txt'), { code: 'FILE_NOT_FOUND' });
  await fs.writeFile(path.join(folder, 'texto.txt'), Buffer.from([0xc3, 0x28]));
  await assert.rejects(read(), { code: 'TEXT_UNREADABLE' });
  await fs.writeFile(path.join(folder, 'texto.txt'), 'abc\0def');
  await assert.rejects(read(), { code: 'TEXT_UNREADABLE' });
  await fs.mkdir(path.join(folder, 'directorio'));
  await assert.rejects(read('directorio'), { code: 'UNSAFE_PATH' });
  await fs.writeFile(path.join(folder, 'texto.txt'), Buffer.alloc(MAX_TEXT_BYTES + 1, 97));
  await assert.rejects(read(), { code: 'FILE_TOO_LARGE' });
  await fs.writeFile(path.join(folder, 'texto.txt'), Buffer.alloc(MAX_TEXT_BYTES, 97));
  assert.equal((await read()).content.length, MAX_TEXT_BYTES);
  await fs.writeFile(path.join(folder, 'texto.txt'), '');
  assert.equal((await read()).content, '');
});

test('rechaza enlaces de directorio y raíz, tanto internos como hacia fuera', async (t) => {
  const { root, folder, read } = await fixture(t);
  const outside = path.join(root, 'ajena');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'texto.txt'), 'SECRETO FICTICIO');
  await fs.mkdir(path.join(folder, 'dentro'));
  await fs.writeFile(path.join(folder, 'dentro', 'texto.txt'), 'interno');
  await fs.symlink(outside, path.join(folder, 'fuera'), linkType);
  await fs.symlink(path.join(folder, 'dentro'), path.join(folder, 'alias'), linkType);
  for (const name of ['fuera/texto.txt', 'alias/texto.txt']) {
    await assert.rejects(read(name), { code: 'UNSAFE_PATH' });
  }
  await fs.rename(folder, `${folder}-original`);
  await fs.symlink(outside, folder, linkType);
  await assert.rejects(read(), { code: 'UNSAFE_PATH' });
});

test('rechaza enlaces duros que comparten un archivo con otra ubicación', async (t) => {
  const { root, folder, read } = await fixture(t);
  const outside = path.join(root, 'ajeno.txt');
  await fs.writeFile(outside, 'ajeno ficticio');
  await fs.link(outside, path.join(folder, 'texto.txt'));
  await assert.rejects(read(), { code: 'UNSAFE_PATH' });
});

test('revalida el permiso de carpeta después de la apertura y antes de leer', async (t) => {
  const { folder, motor, registered } = await fixture(t);
  await fs.writeFile(path.join(folder, 'texto.txt'), 'ficticio');
  await assert.rejects(readNative({ root: folder, relativePath: 'texto.txt', pythonExecutable,
    confirm: async () => {
      await motor.revokeFolder(registered.id);
      throw Object.assign(new Error('Retirada antes de leer'), { code: 'FOLDER_NOT_AUTHORIZED' });
    },
  }), { code: 'FOLDER_NOT_AUTHORIZED' });
});

test('si el intérprete seguro no está disponible falla cerrado', async (t) => {
  const { base, folder, requester, registered } = await fixture(t);
  await fs.writeFile(path.join(folder, 'texto.txt'), 'ficticio');
  const motor = await openMotor({ baseDirectory: base, pythonExecutable: path.join(folder, 'python-inexistente') });
  const authorization = await motor.grantTextRead({ requester, folderId: registered.id, relativePath: 'texto.txt' });
  await assert.rejects(motor.readTextFile({ requester, authorization }), { code: 'SAFE_OPEN_UNAVAILABLE' });
});
