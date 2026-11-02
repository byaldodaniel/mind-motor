import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { updateMind } from '../src/commands/actualizar.js';
import { hashFile, scanTree, readManifestFile } from '../src/product-files.js';
import { agentFixture } from './helpers/agent-fixture.js';
import { openMotor } from '../src/motor.js';
import { BASE_FORMAT_VERSION } from '../src/base-format.js';

const motorDirectory = fileURLToPath(new URL('..', import.meta.url));

async function snapshot(root) {
  const result = {};
  for (const entry of await scanTree(root)) {
    if (entry.type === 'file') result[entry.path] = await hashFile(path.join(root, entry.path));
  }
  return result;
}

async function packageAt(root, version, { real = false, platform = process.platform, baseFormatVersion = BASE_FORMAT_VERSION } = {}) {
  await fs.mkdir(path.join(root, 'Motor'), { recursive: true });
  await fs.mkdir(path.join(root, 'Runtime', 'python', 'bin'), { recursive: true });
  await fs.writeFile(path.join(root, 'LEEME.md'), `Paquete ficticio ${version}\n`);
  await fs.writeFile(path.join(root, 'Motor', 'prueba.txt'), version);
  // Solo comprueba el arranque de `version`: no simula un Python funcional ni
  // sustituye las pruebas de paquetes con los runtimes portables completos.
  await fs.writeFile(path.join(root, 'Runtime', 'python', process.platform === 'win32' ? 'python.exe' : 'bin/python3'), 'Python ficticio\n');
  if (real) {
    for (const directory of ['src', 'bin']) {
      await fs.cp(path.join(motorDirectory, directory), path.join(root, 'Motor', directory), { recursive: true });
    }
    const pkg = JSON.parse(await fs.readFile(path.join(motorDirectory, 'package.json'), 'utf8'));
    await fs.writeFile(path.join(root, 'Motor', 'package.json'), JSON.stringify({ ...pkg, version }));
    const executable = path.join(root, 'Runtime', 'node', process.platform === 'win32' ? 'node.exe' : 'bin/node');
    await fs.mkdir(path.dirname(executable), { recursive: true });
    await fs.copyFile(process.execPath, executable, constants.COPYFILE_FICLONE);
    await fs.chmod(executable, 0o755);
  }
  const files = await snapshot(root);
  delete files['mind-producto.json'];
  await fs.writeFile(path.join(root, 'mind-producto.json'), JSON.stringify({
    format: 'mind-product', version: 1, mindVersion: version, platform, arch: process.arch,
    baseFormatVersion, files, links: {},
  }));
}

async function fixture(t, { real = false } = {}) {
  const f = await agentFixture(t, { prefix: '.mind-update-test-' });
  await packageAt(f.mind, '1.0.0');
  const source = path.join(f.root, 'Paquete nuevo');
  await packageAt(source, '1.1.0', { real });
  const session = await f.open();
  const folder = await session.motor.authorizeFolder(f.folder);
  await session.policy.set(folder.id, ['encontrar', 'leer'], { channel: 'administracion-local' });
  await session.motor.indexFolder(folder.id);
  const definition = { descripcion: 'Función ficticia', parameters: { limite: 3 } };
  await session.motor.createFunction('prueba', definition);
  const continuity = await session.motor.recordContinuity({ content: 'Decisión ficticia persistente' });
  await session.close();
  return { ...f, session, folder, definition, continuity, source, options: {
    root: f.mind, source, baseDirectory: f.layout.baseDirectory, confirm: async () => true,
  } };
}

test('actualización sustituye Motor/Runtime, arranca el código nuevo y conserva toda la Base', async (t) => {
  const f = await fixture(t, { real: true });
  const before = await snapshot(f.layout.baseDirectory);
  const result = await updateMind(f.options); // smokeTest real con el Node copiado.
  assert.equal(result.status, 'actualizada');
  assert.equal(result.to, '1.1.0');
  assert.equal((await readManifestFile(f.mind)).mindVersion, '1.1.0');
  assert.equal(await fs.readFile(path.join(f.mind, 'Motor', 'prueba.txt'), 'utf8'), '1.1.0');
  assert.equal(await fs.readFile(path.join(f.mind, result.backup, 'Motor', 'prueba.txt'), 'utf8'), '1.0.0');
  assert.deepEqual(await snapshot(f.layout.baseDirectory), before);
  const motor = await openMotor({ baseDirectory: f.layout.baseDirectory });
  assert.deepEqual(await motor.listAuthorizedFolders(), [f.folder]);
  assert.ok((await motor.readFolderIndex(f.folder.id)).entries.some((entry) => entry.path === 'notas.txt'));
  assert.deepEqual(await motor.getFunction('prueba'), { id: 'prueba', definition: f.definition });
  assert.deepEqual(await motor.getContinuity(f.continuity.id), f.continuity);
  // Los permisos persistidos forman parte de la comparación byte a byte.
  assert.ok(Object.keys(before).some((name) => name.includes('access')));
});

test('paquete alterado y cancelación no cambian instalación ni Base', async (t) => {
  const f = await fixture(t);
  const before = await snapshot(f.mind);
  await fs.writeFile(path.join(f.source, 'Motor', 'prueba.txt'), 'alterado');
  await assert.rejects(updateMind(f.options), { code: 'UPDATE_PACKAGE_ALTERED' });
  assert.deepEqual(await snapshot(f.mind), before);
  await packageAt(f.source, '1.1.0');
  assert.equal((await updateMind({ ...f.options, confirm: () => false })).status, 'cancelada');
  assert.deepEqual(await snapshot(f.mind), before);
});

test('fallo del Motor nuevo revierte la sustitución sin perder la Base', async (t) => {
  const f = await fixture(t);
  const before = await snapshot(f.mind);
  await assert.rejects(updateMind({ ...f.options, verifyInstalled: async () => {
    assert.equal(await fs.readFile(path.join(f.mind, 'Motor', 'prueba.txt'), 'utf8'), '1.1.0');
    throw Object.assign(new Error('Fallo ficticio de arranque'), { code: 'UPDATE_CHECK_FAILED' });
  } }), { code: 'UPDATE_CHECK_FAILED' });
  assert.deepEqual(await snapshot(f.mind), before);
});

test('sesiones activas y formato de Base incompatible impiden la sustitución', async (t) => {
  const f = await fixture(t);
  const active = await f.open();
  await assert.rejects(updateMind(f.options), { code: 'MIND_IN_USE' });
  await active.close();
  const markerPath = path.join(f.layout.baseDirectory, 'mind-base.json');
  const marker = JSON.parse(await fs.readFile(markerPath, 'utf8'));
  await fs.writeFile(markerPath, JSON.stringify({ ...marker, version: BASE_FORMAT_VERSION + 1 }));
  const before = await snapshot(f.mind);
  await assert.rejects(updateMind(f.options), { code: 'UPDATE_BASE_INCOMPATIBLE' });
  assert.deepEqual(await snapshot(f.mind), before);
});

test('un Motor anterior que solo admite formato 1 no puede sustituir el Motor de una Base 2', async (t) => {
  const f = await fixture(t);
  const markerPath = path.join(f.layout.baseDirectory, 'mind-base.json');
  const marker = JSON.parse(await fs.readFile(markerPath, 'utf8'));
  await fs.writeFile(markerPath, JSON.stringify({ ...marker, version: 2 }));
  await packageAt(f.source, '1.1.0', { baseFormatVersion: 1 });
  const before = await snapshot(f.mind);
  let confirmed = false;
  await assert.rejects(updateMind({ ...f.options, confirm: () => { confirmed = true; return true; } }), { code: 'UPDATE_BASE_INCOMPATIBLE' });
  assert.equal(confirmed, false, 'rechaza el formato antes de ofrecer la sustitución');
  assert.deepEqual(await snapshot(f.mind), before);
});

test('una Base personalizada dentro de Motor o de otro archivo del paquete nunca se sustituye', async (t) => {
  const f = await fixture(t);
  for (const relative of ['Motor/Datos', 'Motor/..datos', 'Runtime/Datos', 'Documentacion']) {
    const baseDirectory = path.join(f.mind, relative);
    await fs.mkdir(baseDirectory, { recursive: true });
    await fs.writeFile(path.join(baseDirectory, 'continuidad-ficticia.json'), 'Conservar sin cambios');
    if (relative === 'Documentacion') {
      await fs.mkdir(path.join(f.source, 'Documentacion'), { recursive: true });
      await fs.writeFile(path.join(f.source, 'Documentacion', 'nuevo.txt'), 'Nuevo archivo');
      await packageAt(f.source, '1.1.0');
    }
    const before = await snapshot(f.mind);
    await assert.rejects(updateMind({ ...f.options, baseDirectory, verifyInstalled: async () => {} }), { code: 'UPDATE_BASE_OVERLAP' });
    assert.deepEqual(await snapshot(f.mind), before);
  }
  const before = await snapshot(f.mind);
  await assert.rejects(updateMind({ ...f.options, baseDirectory: f.root }), { code: 'UPDATE_BASE_OVERLAP' });
  assert.deepEqual(await snapshot(f.mind), before);
});

test('una instalación bajo un hijo llamado ..datos no se confunde con una ruta ascendente', async (t) => {
  const f = await fixture(t);
  const root = path.join(f.root, '..datos');
  await fs.rename(f.mind, root);
  const before = await snapshot(root);
  // La Base contiene físicamente toda la instalación, pese al prefijo "..".
  await assert.rejects(updateMind({ ...f.options, root, baseDirectory: f.root }), { code: 'UPDATE_BASE_OVERLAP' });
  assert.deepEqual(await snapshot(root), before);
});

test('la Base enlazada hacia Runtime también se protege por su ubicación física', { skip: process.platform === 'win32' }, async (t) => {
  const f = await fixture(t);
  const data = path.join(f.mind, 'Runtime', 'Datos');
  await fs.mkdir(data);
  await fs.writeFile(path.join(data, 'continuidad-ficticia.json'), 'Conservar');
  const baseDirectory = path.join(f.root, 'Base enlazada');
  await fs.symlink(data, baseDirectory, 'dir');
  const before = await snapshot(f.mind);
  await assert.rejects(updateMind({ ...f.options, baseDirectory }), { code: 'UPDATE_BASE_OVERLAP' });
  assert.deepEqual(await snapshot(f.mind), before);
});
