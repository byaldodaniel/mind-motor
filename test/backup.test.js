import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  setupBackup, createBackup, verifyBackup, restoreBackup, describeBackupKey,
  saveRecoveryFile, TEST_ONLY_KDF, KEY_FILE,
  configureBackupDestination,
} from '../src/backup.js';
import { configure, run, restore } from '../src/commands/respaldo.js';
import { createBackupTools } from '../src/tools/respaldo.js';
import { connectorPaths, ensureCentralMotor, restoreLockPath } from '../src/connector.js';
import { acquireOwnerFileLock } from '../src/process-identity.js';

const development = fileURLToPath(new URL('../..', import.meta.url));
const testKdf = { [TEST_ONLY_KDF]: { N: 1024 } };
const passphrase = 'Frase ficticia para pruebas de recuperación';

async function fixture(t, options = testKdf) {
  const root = await fs.mkdtemp(path.join(development, '.mind-backup-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const base = path.join(root, 'Base ficticia');
  const destination = path.join(root, 'Respaldos ficticios');
  const recovery = path.join(root, 'Recuperación ficticia');
  for (const directory of [base, destination, recovery]) await fs.mkdir(directory);
  await fs.mkdir(path.join(base, 'continuidad'));
  await fs.writeFile(path.join(base, 'continuidad', 'nota.json'), '{"texto":"información ficticia ñ"}\n');
  await fs.writeFile(path.join(base, 'binario'), Buffer.from([0, 255, 1, 128]));
  const configured = await setupBackup({ baseDirectory: base, passphrase, ...options });
  const saved = await saveRecoveryFile({ recoveryFile: configured.recoveryFile, directory: recovery, baseDirectory: base, destinationDirectory: destination });
  const created = await createBackup({ baseDirectory: base, destinationDirectory: destination });
  return { root, base, destination, saved, configured, created, options };
}

test('respaldo cifrado: código y archivo protegido recuperan independientemente sin la Base original', async (t) => {
  const { root, base, saved, created, configured } = await fixture(t);
  const bytes = await fs.readFile(created.file);
  assert.equal(bytes.includes(Buffer.from('información ficticia')), false);
  assert.equal(bytes.includes(Buffer.from(configured.recoveryCode)), false);
  await fs.rm(base, { recursive: true });
  for (const [name, material] of [
    ['codigo', { recoveryCode: configured.recoveryCode }],
    ['archivo', { recoveryFile: saved, passphrase }],
  ]) {
    const verified = await verifyBackup({ file: created.file, ...material, ...testKdf });
    assert.equal(verified.valid, true);
    assert.equal(verified.method, name);
    const targetDirectory = path.join(root, `Restaurada-${name}`);
    const restored = await restoreBackup({ file: created.file, targetDirectory, ...material, ...testKdf });
    assert.equal(restored.keyRestored, true);
    assert.equal(await fs.readFile(path.join(targetDirectory, 'continuidad', 'nota.json'), 'utf8'), '{"texto":"información ficticia ñ"}\n');
    assert.deepEqual(await fs.readFile(path.join(targetDirectory, 'binario')), Buffer.from([0, 255, 1, 128]));
    assert.equal((await describeBackupKey(targetDirectory)).keyId, configured.keyId);
    // La clave recuperada permite seguir respaldando con los mismos medios.
    const next = await createBackup({ baseDirectory: targetDirectory, destinationDirectory: path.dirname(created.file) });
    assert.equal((await verifyBackup({ file: next.file, ...material, ...testKdf })).valid, true);
  }
});

test('respaldo: frase incorrecta y credenciales de otra configuración no abren ni publican una Base', async (t) => {
  const { root, created, saved } = await fixture(t);
  const second = path.join(root, 'Otra Base');
  await fs.mkdir(second);
  const other = await setupBackup({ baseDirectory: second, passphrase, ...testKdf });
  for (const material of [
    { recoveryFile: saved, passphrase: 'Frase ficticia equivocada' },
    { recoveryCode: other.recoveryCode },
    { baseDirectory: second },
  ]) {
    const targetDirectory = path.join(root, 'No publicada');
    await assert.rejects(restoreBackup({ file: created.file, targetDirectory, ...material, ...testKdf }), { code: 'BACKUP_KEY_INVALID' });
    await assert.rejects(fs.access(targetDirectory), { code: 'ENOENT' });
    assert.equal((await fs.readdir(root)).some((name) => name.startsWith('.mind-restauracion-')), false);
  }
});

test('respaldo alterado o truncado no restaura contenido parcial ni toca un destino con datos', async (t) => {
  const { root, base, created } = await fixture(t);
  const original = await fs.readFile(created.file);
  const changed = Buffer.from(original);
  changed[changed.length - 1] ^= 1; // Etiqueta GCM completa, pero inválida.
  for (const [name, data] of [['alterado', changed], ['truncado', original.subarray(0, original.length - 20)]]) {
    const file = path.join(root, `${name}.mindbak`);
    await fs.writeFile(file, data);
    await assert.rejects(verifyBackup({ file, baseDirectory: base }), { code: 'BACKUP_CORRUPT' });
    const targetDirectory = path.join(root, name);
    await assert.rejects(restoreBackup({ file, targetDirectory, baseDirectory: base }), { code: 'BACKUP_CORRUPT' });
    await assert.rejects(fs.access(targetDirectory), { code: 'ENOENT' });
  }
  await assert.rejects(restoreBackup({ file: created.file, targetDirectory: base, baseDirectory: base }), { code: 'RESTORE_TARGET_NOT_EMPTY' });
  assert.equal(await fs.readFile(path.join(base, 'continuidad', 'nota.json'), 'utf8'), '{"texto":"información ficticia ñ"}\n');
  assert.equal((await fs.readdir(root)).some((name) => name.startsWith('.mind-restauracion-')), false);
});

test('respaldo excluye clave, sesiones y bloqueos; no publica claves si restoreKey es falso', async (t) => {
  const { root, base, destination, configured } = await fixture(t);
  await fs.mkdir(path.join(base, 'sesiones'));
  await fs.writeFile(path.join(base, 'sesiones', 'sesion.json'), 'ficticio');
  await fs.writeFile(path.join(base, 'indice.lock'), 'bloqueo ficticio');
  const created = await createBackup({ baseDirectory: base, destinationDirectory: destination });
  const targetDirectory = path.join(root, 'Sin clave');
  await restoreBackup({ file: created.file, targetDirectory, recoveryCode: configured.recoveryCode, restoreKey: false, ...testKdf });
  for (const name of [KEY_FILE, 'sesiones', 'indice.lock']) await assert.rejects(fs.access(path.join(targetDirectory, name)), { code: 'ENOENT' });
  await assert.rejects(createBackup({ baseDirectory: base, destinationDirectory: base }), { code: 'BACKUP_DESTINATION_INVALID' });
  await assert.rejects(saveRecoveryFile({ recoveryFile: configured.recoveryFile, directory: destination, baseDirectory: base, destinationDirectory: destination }), { code: 'RECOVERY_LOCATION_INVALID' });
});

test('respaldo usa y acepta scrypt de producción sin la opción exclusiva de pruebas', async (t) => {
  const { created, configured, saved } = await fixture(t, {});
  assert.equal((await verifyBackup({ file: created.file, recoveryCode: configured.recoveryCode })).valid, true);
  assert.equal((await verifyBackup({ file: created.file, recoveryFile: saved, passphrase })).valid, true);
});

test('mind respaldo conecta estado, creación y verificación con el destino elegido', async (t) => {
  const { base, destination } = await fixture(t);
  await configureBackupDestination({ baseDirectory: base, destinationDirectory: destination });
  const results = [];
  const invoke = (parameters) => run({ parameters, layout: async () => ({ baseDirectory: base }), print: (value) => results.push(value) });
  assert.equal(await invoke(['estado']), 0);
  assert.equal(results.at(-1).configurado, true);
  assert.equal(results.at(-1).destino, await fs.realpath(destination));
  assert.equal(await invoke(['crear']), 0);
  const file = results.at(-1).archivo;
  assert.equal(results.at(-1).estado, 'creado');
  assert.equal(await invoke(['verificar', file]), 0);
  assert.equal(results.at(-1).valido, true);
  assert.equal(results.at(-1).metodo, 'base');
});

test('restauración del usuario conserva la Base anterior y respeta rechazar el reemplazo', async (t) => {
  const { root, base, created } = await fixture(t);
  const existing = path.join(root, 'Base actual');
  await fs.mkdir(existing);
  await fs.writeFile(path.join(existing, 'conservar.txt'), 'dato ficticio anterior');
  const declined = await restore({ prompt: { write() {}, async yes() { return false; } }, baseDirectory: existing, file: created.file, recovery: { baseDirectory: base } });
  assert.equal(declined.status, 'preparada');
  assert.equal(await fs.readFile(path.join(existing, 'conservar.txt'), 'utf8'), 'dato ficticio anterior');
  await fs.rm(declined.staging, { recursive: true });
  const accepted = await restore({ prompt: { write() {}, async yes() { return true; } }, baseDirectory: existing, file: created.file, recovery: { baseDirectory: base } });
  assert.equal(accepted.status, 'restaurada');
  assert.equal(await fs.readFile(path.join(accepted.previous, 'conservar.txt'), 'utf8'), 'dato ficticio anterior');
  assert.equal(await fs.readFile(path.join(existing, 'continuidad', 'nota.json'), 'utf8'), '{"texto":"información ficticia ñ"}\n');
});

test('respaldo crear respeta al propietario aunque el conector no responda', async (t) => {
  const { base, destination } = await fixture(t);
  const files = await fs.readdir(destination);
  const release = await acquireOwnerFileLock(connectorPaths(base).lockFile);
  try {
    await assert.rejects(run({
      parameters: ['crear', destination], async layout() { return { baseDirectory: base }; }, print() {},
    }), { code: 'BASE_IN_USE' });
    assert.deepEqual(await fs.readdir(destination), files);
  } finally {
    await release();
  }
});

test('la restauración bloquea nuevos arranques durante el cambio y revierte un fallo', async (t) => {
  const { root, base, created } = await fixture(t);
  const existing = path.join(root, 'Base durante reemplazo');
  await fs.mkdir(existing);
  await fs.writeFile(path.join(existing, 'anterior.txt'), 'Base ficticia anterior');
  const verifySwap = async ({ previous }) => {
    await fs.stat(restoreLockPath(existing));
    await assert.rejects(fs.stat(existing), { code: 'ENOENT' });
    assert.equal(await fs.readFile(path.join(previous, 'anterior.txt'), 'utf8'), 'Base ficticia anterior');
    await assert.rejects(ensureCentralMotor({
      baseDirectory: existing,
      launch() { assert.fail('No debe arrancar un Motor durante el reemplazo'); },
    }), { code: 'BASE_RESTORING' });
  };
  const args = {
    prompt: { write() {}, async yes() { return true; } },
    baseDirectory: existing, file: created.file, recovery: { baseDirectory: base },
  };
  await assert.rejects(restore({
    ...args,
    async onSwap(context) {
      await verifySwap(context);
      throw new Error('Fallo ficticio durante el reemplazo');
    },
  }), /Fallo ficticio durante el reemplazo/);
  assert.equal(await fs.readFile(path.join(existing, 'anterior.txt'), 'utf8'), 'Base ficticia anterior');
  await assert.rejects(fs.stat(restoreLockPath(existing)), { code: 'ENOENT' });

  const restored = await restore({ ...args, onSwap: verifySwap });
  assert.equal(restored.status, 'restaurada');
  assert.equal(await fs.readFile(path.join(restored.previous, 'anterior.txt'), 'utf8'), 'Base ficticia anterior');
  assert.match(await fs.readFile(path.join(existing, 'continuidad', 'nota.json'), 'utf8'), /información ficticia/);
  await assert.rejects(fs.stat(restoreLockPath(existing)), { code: 'ENOENT' });
});

test('herramienta del agente crea solo en el destino configurado, audita y limita frecuencia', async (t) => {
  const { base, destination } = await fixture(t);
  const audited = [];
  const [tool] = createBackupTools({ session: { motor: { baseDirectory: base }, audit: async (...args) => audited.push(args) } });
  await assert.rejects(tool.handler({}, { source: 'agente-ficticio' }), { code: 'BACKUP_NOT_CONFIGURED' });
  await configureBackupDestination({ baseDirectory: base, destinationDirectory: destination });
  await assert.rejects(tool.handler({ destino: '/otra-ruta' }, { source: 'agente-ficticio' }));
  const result = await tool.handler({}, { source: 'agente-ficticio' });
  assert.equal(result.estado, 'creado');
  assert.equal(result.destino, await fs.realpath(destination));
  assert.equal(Object.hasOwn(result, 'size'), false);
  assert.equal(audited[0][0], 'respaldo-creado');
  await assert.rejects(tool.handler({}, { source: 'agente-ficticio' }), { code: 'BACKUP_TOO_FREQUENT' });
});

test('restaurar rechaza una Base en uso antes de escribir y vuelve a comprobar antes de sustituir', async (t) => {
  const { root, base, created } = await fixture(t);
  const existing = path.join(root, 'Base activa');
  const sessions = path.join(existing, 'sesiones');
  await fs.mkdir(sessions, { recursive: true });
  const session = path.join(sessions, 'sesion-00000000-0000-4000-8000-000000000001.json');
  const register = () => fs.writeFile(session, JSON.stringify({ pid: process.pid, host: os.hostname() }));
  await register();
  const invoke = (prompt) => restore({ prompt, baseDirectory: existing, file: created.file, recovery: { baseDirectory: base } });
  await assert.rejects(invoke({ write() {}, async yes() { assert.fail('No debe pedir reemplazo de una Base activa'); } }), { code: 'BASE_IN_USE' });
  assert.equal((await fs.readdir(root)).some((name) => name.includes('.restaurada-')), false);
  await fs.rm(session);
  await assert.rejects(invoke({ write() {}, async yes() { await register(); return true; } }), { code: 'BASE_IN_USE' });
  assert.equal(JSON.parse(await fs.readFile(session, 'utf8')).pid, process.pid);
});

test('configuración pregunta secretos por el prompt y guarda solo material cifrado de recuperación', async (t) => {
  const { root } = await fixture(t);
  const baseDirectory = path.join(root, 'Base nueva');
  const destination = path.join(root, 'Destino nuevo');
  const recoveryDirectory = path.join(root, 'Archivo separado');
  await fs.mkdir(destination);
  await fs.mkdir(recoveryDirectory);
  const lines = [];
  let secretQuestions = 0;
  const configured = await configure({
    baseDirectory, destination,
    prompt: {
      write: (line) => lines.push(line),
      async ask() { return recoveryDirectory; },
      async secret() { secretQuestions += 1; return passphrase; },
      async yes() { return true; },
    },
  });
  assert.equal(secretQuestions, 2);
  const code = lines.find((line) => /^    [0-9A-Z]{4}(?:-[0-9A-Z]{4}){8}$/.test(line))?.trim();
  assert.ok(code, 'Se muestra un código una sola vez en el prompt del usuario');
  assert.equal(lines.filter((line) => line.includes(code)).length, 1);
  assert.equal(lines.some((line) => line.includes(passphrase)), false);
  assert.equal(path.dirname(configured.recoveryFile), await fs.realpath(recoveryDirectory));
  const records = [
    await fs.readFile(path.join(baseDirectory, KEY_FILE), 'utf8'),
    await fs.readFile(configured.recoveryFile, 'utf8'),
    await fs.readFile(path.join(baseDirectory, 'backup-config.json'), 'utf8'),
  ];
  for (const text of records) {
    assert.equal(text.includes(code), false);
    assert.equal(text.includes(code.replaceAll('-', '')), false);
    assert.equal(text.includes(passphrase), false);
  }
  const backup = await createBackup({ baseDirectory, destinationDirectory: destination });
  assert.equal((await verifyBackup({ file: backup.file, recoveryCode: code })).valid, true);
  assert.equal((await verifyBackup({ file: backup.file, recoveryFile: configured.recoveryFile, passphrase })).valid, true);
});

test('rutas físicas de respaldo y recuperación rechazan solapamientos aunque se usen enlaces', async (t) => {
  const { root, base, destination, configured, created } = await fixture(t);
  const nested = path.join(base, 'No guardar aquí');
  await fs.mkdir(nested);
  for (const directory of [base, nested, fileURLToPath(new URL('..', import.meta.url))]) {
    await assert.rejects(saveRecoveryFile({ recoveryFile: configured.recoveryFile, directory, baseDirectory: base, destinationDirectory: destination }), { code: 'RECOVERY_LOCATION_INVALID' });
  }
  const alias = path.join(root, 'Alias de Base');
  await fs.symlink(base, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(createBackup({ baseDirectory: base, destinationDirectory: alias }), { code: 'BACKUP_DESTINATION_INVALID' });
  await assert.rejects(saveRecoveryFile({ recoveryFile: configured.recoveryFile, directory: alias, baseDirectory: base, destinationDirectory: destination }), { code: 'RECOVERY_LOCATION_INVALID' });
  await assert.rejects(restoreBackup({ file: created.file, targetDirectory: alias, baseDirectory: base }), { code: 'RESTORE_TARGET_INVALID' });
  assert.ok(await fs.readFile(path.join(base, KEY_FILE)));
});

test('configurar rechaza un destino inexistente sin dejar una clave que impida reintentar', async (t) => {
  const { root } = await fixture(t);
  const baseDirectory = path.join(root, 'Base para reintentar');
  const recoveryDirectory = path.join(root, 'Recuperación nueva');
  await fs.mkdir(recoveryDirectory);
  let questions = 0;
  await assert.rejects(configure({
    baseDirectory, destination: path.join(root, 'Destino ausente'),
    prompt: { write() {}, async ask() { questions += 1; return recoveryDirectory; }, async secret() { return passphrase; }, async yes() { return true; } },
  }), { code: 'BACKUP_DESTINATION_UNAVAILABLE' });
  assert.equal(await describeBackupKey(baseDirectory), null);
  assert.equal(questions, 0);
  assert.deepEqual(await fs.readdir(recoveryDirectory), []);
});
