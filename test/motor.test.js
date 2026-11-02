import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, symlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openMotor } from '../src/motor.js';

const motorDirectory = fileURLToPath(new URL('..', import.meta.url));
const developmentDirectory = path.dirname(motorDirectory);
const cliPath = path.join(motorDirectory, 'src', 'cli.js');

async function fixture(t) {
  // Todos los temporales son hermanos del Motor, fuera del repositorio.
  const root = await mkdtemp(path.join(developmentDirectory, '.mind-test-'));
  t.after(async () => {
    assert.equal(path.dirname(root), developmentDirectory);
    assert.ok(path.basename(root).startsWith('.mind-test-'));
    await rm(root, { recursive: true, force: true });
  });
  const base = path.join(root, 'Base');
  await mkdir(base);
  return { root, base };
}

function cli(base, ...args) {
  return spawnSync(process.execPath, [cliPath, '--base', base, ...args], {
    cwd: developmentDirectory, encoding: 'utf8', timeout: 10_000,
  });
}

async function snapshot(directory = motorDirectory, prefix = '') {
  const result = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const name = path.join(prefix, entry.name);
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(result, await snapshot(absolute, name));
    else result[name] = createHash('sha256').update(await readFile(absolute)).digest('hex');
  }
  return result;
}

test('arranca sin escribir y distingue un registro inexistente', async (t) => {
  const { base } = await fixture(t);
  const motor = await openMotor({ baseDirectory: base });
  assert.equal(motor.baseDirectory, base);
  assert.equal(await motor.readRecord('inexistente'), null);
  assert.deepEqual(await readdir(base), []);
});

test('escribe, recupera y reemplaza texto Unicode sin dejar temporales', async (t) => {
  const { base } = await fixture(t);
  const motor = await openMotor({ baseDirectory: base });
  const value = 'Registro ficticio: café, 中文, 🧠\nsegunda línea';
  assert.deepEqual(await motor.writeRecord('prueba', value), { id: 'prueba', value });
  assert.deepEqual(await motor.readRecord('prueba'), { id: 'prueba', value });
  await motor.writeRecord('prueba', '');
  assert.deepEqual(await motor.readRecord('prueba'), { id: 'prueba', value: '' });
  assert.deepEqual(await readdir(base), ['record-prueba.json']);
});

test('el registro persiste entre procesos terminados y no modifica el Motor', async (t) => {
  const { base } = await fixture(t);
  const before = await snapshot();
  const status = cli(base, 'status');
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).status, 'ready');
  const write = cli(base, 'write', 'reinicio', 'persistente');
  assert.equal(write.status, 0, write.stderr);
  assert.equal(write.signal, null);
  // spawnSync solo retorna al terminar el proceso escritor; otro proceso lee.
  const read = cli(base, 'read', 'reinicio');
  assert.equal(read.status, 0, read.stderr);
  assert.deepEqual(JSON.parse(read.stdout), { id: 'reinicio', value: 'persistente' });
  assert.deepEqual(await snapshot(), before);
  assert.deepEqual(await readdir(base), ['record-reinicio.json']);
});

test('dos Bases conservan datos independientes con el mismo identificador', async (t) => {
  const { root, base } = await fixture(t);
  const secondBase = path.join(root, 'Otra Base');
  await mkdir(secondBase);
  const first = await openMotor({ baseDirectory: base });
  const second = await openMotor({ baseDirectory: secondBase });
  await first.writeRecord('prueba', 'uno');
  assert.equal(await second.readRecord('prueba'), null);
  await second.writeRecord('prueba', 'dos');
  assert.equal((await first.readRecord('prueba')).value, 'uno');
  assert.equal((await second.readRecord('prueba')).value, 'dos');
});

test('exige una Base absoluta, existente y que sea directorio', async (t) => {
  const { root } = await fixture(t);
  for (const options of [undefined, {}, { baseDirectory: '../Base' }]) {
    await assert.rejects(openMotor(options), { code: 'INVALID_BASE' });
  }
  await assert.rejects(openMotor({ baseDirectory: path.join(root, 'no-existe') }), { code: 'BASE_NOT_FOUND' });
  const file = path.join(root, 'archivo');
  await writeFile(file, 'prueba');
  await assert.rejects(openMotor({ baseDirectory: file }), { code: 'INVALID_BASE' });
});

test('rechaza solapamiento entre Base y Motor, incluso mediante un enlace de directorio', async (t) => {
  const { root } = await fixture(t);
  for (const baseDirectory of [motorDirectory, path.join(motorDirectory, 'src'), developmentDirectory]) {
    await assert.rejects(openMotor({ baseDirectory }), { code: 'BASE_OVERLAPS_MOTOR' });
  }
  const alias = path.join(root, 'alias-motor');
  await symlink(motorDirectory, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(openMotor({ baseDirectory: alias }), { code: 'BASE_OVERLAPS_MOTOR' });
});

test('valida identificadores y valores antes de escribir', async (t) => {
  const { base } = await fixture(t);
  const motor = await openMotor({ baseDirectory: base });
  for (const id of ['', '../escape', 'a/b', 'a\\b', 'A', '.', 'a'.repeat(65), null]) {
    await assert.rejects(motor.writeRecord(id, 'texto'), { code: 'INVALID_ID' });
    await assert.rejects(motor.readRecord(id), { code: 'INVALID_ID' });
  }
  await assert.rejects(motor.writeRecord('prueba', { dato: 1 }), { code: 'INVALID_VALUE' });
  assert.deepEqual(await readdir(base), []);
  await motor.writeRecord('con', 'nombre seguro en Windows');
  assert.equal((await motor.readRecord('con')).value, 'nombre seguro en Windows');
});

test('informa datos corruptos sin sobrescribirlos al leer', async (t) => {
  const { base } = await fixture(t);
  const motor = await openMotor({ baseDirectory: base });
  const target = path.join(base, 'record-prueba.json');
  for (const content of ['{incompleto', 'null', '[]', '{}', JSON.stringify({
    format: 'mind-technical-record', version: 2, id: 'prueba', value: 'ficticio',
  }), JSON.stringify({ format: 'mind-technical-record', version: 1, id: 'otro', value: 'ficticio' })]) {
    await writeFile(target, content);
    await assert.rejects(motor.readRecord('prueba'), { code: 'RECORD_CORRUPT' });
    assert.equal(await readFile(target, 'utf8'), content);
  }
});

test('un fallo al publicar el registro limpia el temporal y no elimina el destino', async (t) => {
  const { base } = await fixture(t);
  const motor = await openMotor({ baseDirectory: base });
  await mkdir(path.join(base, 'record-bloqueado.json'));
  await assert.rejects(motor.writeRecord('bloqueado', 'no debe publicarse'));
  assert.deepEqual(await readdir(base), ['record-bloqueado.json']);
});

test('la CLI valida argumentos y reporta errores sin crear registros', async (t) => {
  const { base } = await fixture(t);
  for (const args of [[], ['otro'], ['read'], ['write', 'prueba'], ['status', 'sobrante']]) {
    const result = cli(base, ...args);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).error.code, 'INVALID_ARGUMENTS');
  }
  const invalidBase = cli('relativa', 'status');
  assert.equal(invalidBase.status, 1);
  assert.equal(JSON.parse(invalidBase.stderr).error.code, 'INVALID_BASE');
  const missing = cli(base, 'read', 'inexistente');
  assert.equal(missing.status, 0, missing.stderr);
  assert.equal(JSON.parse(missing.stdout), null);
  assert.deepEqual(await readdir(base), []);
});


test('rechaza registros que sean enlaces sin escribir en su destino', async (t) => {
  const { root, base } = await fixture(t);
  const external = path.join(root, 'destino-ajeno');
  await mkdir(external);
  await symlink(external, path.join(base, 'record-enlace.json'), process.platform === 'win32' ? 'junction' : 'dir');
  const motor = await openMotor({ baseDirectory: base });
  await assert.rejects(motor.readRecord('enlace'), { code: 'RECORD_LINK' });
  await assert.rejects(motor.writeRecord('enlace', 'no escribir'), { code: 'RECORD_LINK' });
  assert.deepEqual(await readdir(external), []);
});
