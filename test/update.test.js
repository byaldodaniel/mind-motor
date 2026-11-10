import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { updateMind } from '../src/commands/actualizar.js';
import { hashFile, scanTree, readManifestFile, UNIVERSAL_TARGETS } from '../src/product-files.js';
import { agentFixture } from './helpers/agent-fixture.js';
import { openMotor } from '../src/motor.js';
import { BASE_FORMAT_VERSION } from '../src/base-format.js';
import { checkForUpdate } from '../src/auto-update.js';
import { generateKeyPairSync, sign } from 'node:crypto';
import { writeZip, writeTarGz } from '../src/archive.js';
import { openSession } from '../src/session.js';

const motorDirectory = fileURLToPath(new URL('..', import.meta.url));

test('canal firmado: descarga, instalador en proceso separado, arranque nuevo y Base intacta', t => updateThroughSignedChannel(t));
test('canal firmado universal: instala el mismo ZIP en el destino local y conserva la Base', t => updateThroughSignedChannel(t, true));

async function updateThroughSignedChannel(t, universal = false) {
  const f = await agentFixture(t, { prefix: '.mind-auto-product-' });
  await packageAt(f.mind, '1.0.0', { real: true });
  const source = path.join(f.root, 'Nuevo');
  await packageAt(source, '1.1.0', { real: true, universal });
  const session = await f.open();
  await session.motor.recordContinuity({ content: 'Dato ficticio que se conserva' });
  await session.close();
  const before = await snapshot(f.layout.baseDirectory);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  await fs.writeFile(path.join(f.mind, 'Motor', 'src', 'update-channel.json'), JSON.stringify({ repository: 'owner/mind', url: 'https://github.com/owner/mind/releases/latest/download/stable.json', publicKey: publicKey.export({ type: 'spki', format: 'pem' }) }));
  const zip = universal || process.platform === 'win32';
  const archive = path.join(f.root, zip ? 'Mind.zip' : 'Mind.tar.gz');
  const entries = (await scanTree(source)).map(e => ({ ...e, source: { file: path.join(source, e.path) } }));
  await (zip ? writeZip : writeTarGz)(archive, entries, { root: 'Mind', mtime: 1700000000 });
  const target = universal ? { platform: 'win32', arch: 'x64', targets: UNIVERSAL_TARGETS } : { platform: process.platform, arch: process.arch };
  const payload = Buffer.from(JSON.stringify({ format: 'mind-update', version: 1, mindVersion: '1.1.0', packages: [{ ...target,
    url: 'https://github.com/owner/mind/releases/download/v1.1.0/Mind.zip', sha256: await hashFile(archive), bytes: (await fs.stat(archive)).size }] }));
  let first = true;
  const result = await checkForUpdate({ root: f.mind, fetcher: async () => {
    if (first) { first = false; return new Response(JSON.stringify({ payload: payload.toString('base64'), signature: sign(null, payload, privateKey).toString('base64') })); }
    return new Response(await fs.readFile(archive));
  } });
  assert.equal(result.status, 'actualizada', result.reason);
  const manifest = await readManifestFile(f.mind);
  assert.equal(manifest.mindVersion, '1.1.0');
  assert.deepEqual(manifest.targets, target.targets);
  assert.deepEqual(await snapshot(f.layout.baseDirectory), before);
}

async function snapshot(root) {
  const result = {};
  for (const entry of await scanTree(root)) {
    if (entry.type === 'file') result[entry.path] = await hashFile(path.join(root, entry.path));
  }
  return result;
}

async function packageAt(root, version, { real = false, platform = process.platform, baseFormatVersion = BASE_FORMAT_VERSION, universal = false } = {}) {
  const runtime = universal && process.platform !== 'win32'
    ? path.join(root, 'Runtime', `${process.platform}-${process.arch}`) : path.join(root, 'Runtime');
  await fs.mkdir(path.join(root, 'Motor'), { recursive: true });
  await fs.mkdir(path.join(runtime, 'python', 'bin'), { recursive: true });
  await fs.writeFile(path.join(root, 'LEEME.md'), `Paquete ficticio ${version}\n`);
  await fs.writeFile(path.join(root, 'Motor', 'prueba.txt'), version);
  // Solo comprueba el arranque de `version`: no simula un Python funcional ni
  // sustituye las pruebas de paquetes con los runtimes portables completos.
  await fs.writeFile(path.join(runtime, 'python', process.platform === 'win32' ? 'python.exe' : 'bin/python3'), 'Python ficticio\n');
  if (real) {
    for (const directory of ['src', 'bin']) {
      await fs.cp(path.join(motorDirectory, directory), path.join(root, 'Motor', directory), { recursive: true });
    }
    const pkg = JSON.parse(await fs.readFile(path.join(motorDirectory, 'package.json'), 'utf8'));
    await fs.writeFile(path.join(root, 'Motor', 'package.json'), JSON.stringify({ ...pkg, version }));
    const executable = path.join(runtime, 'node', process.platform === 'win32' ? 'node.exe' : 'bin/node');
    await fs.mkdir(path.dirname(executable), { recursive: true });
    await fs.copyFile(process.execPath, executable, constants.COPYFILE_FICLONE);
    await fs.chmod(executable, 0o755);
  }
  const files = await snapshot(root);
  delete files['mind-producto.json'];
  const target = universal ? { platform: 'win32', arch: 'x64', targets: UNIVERSAL_TARGETS } : { platform, arch: process.arch };
  await fs.writeFile(path.join(root, 'mind-producto.json'), JSON.stringify({
    format: 'mind-product', version: 1, mindVersion: version, ...target,
    baseFormatVersion, files, links: {},
  }));
}

async function fixture(t, { real = false, currentUniversal = false } = {}) {
  const f = await agentFixture(t, { prefix: '.mind-update-test-' });
  await packageAt(f.mind, '1.0.0', { universal: currentUniversal });
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
  const userData = path.join(f.mind, 'Conversaciones');
  await fs.mkdir(userData);
  await fs.writeFile(path.join(userData, 'memoria.md'), 'Decisión ficticia que conservar.');
  await fs.writeFile(path.join(userData, 'imagen.png'), Buffer.from([0,255,127,42]));
  const beforeData = await snapshot(userData);
  const before = await snapshot(f.layout.baseDirectory);
  const result = await updateMind(f.options); // smokeTest real con el Node copiado.
  assert.equal(result.status, 'actualizada');
  assert.equal(result.to, '1.1.0');
  assert.deepEqual(await snapshot(userData), beforeData);
  assert.equal((await readManifestFile(f.mind)).mindVersion, '1.1.0');
  assert.equal(await fs.readFile(path.join(f.mind, 'Motor', 'prueba.txt'), 'utf8'), '1.1.0');
  assert.equal(result.backup, undefined);
  assert.ok(!(await fs.readdir(f.mind)).some(name=>name.startsWith('.anterior-')));
  await assert.rejects(fs.stat(path.join(f.mind,'Sistema','Actualizaciones','Trabajo','actual')),{code:'ENOENT'});
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

test('una instalación universal admite la actualización nativa manual del destino local', async (t) => {
  const f = await fixture(t, { real: true, currentUniversal: true });
  const before = await snapshot(f.mind);
  const beforeBase = await snapshot(f.layout.baseDirectory);
  const sourceManifest = path.join(f.source, 'mind-producto.json');
  const native = await readManifestFile(f.source);
  await fs.writeFile(sourceManifest, JSON.stringify({ ...native, arch: process.arch === 'x64' ? 'arm64' : 'x64' }));
  await assert.rejects(updateMind(f.options), { code: 'UPDATE_PLATFORM_MISMATCH' });
  assert.deepEqual(await snapshot(f.mind), before);
  await fs.writeFile(sourceManifest, JSON.stringify(native));
  const result = await updateMind(f.options);
  assert.equal(result.platform, `${process.platform}-${process.arch}`);
  assert.equal(result.status, 'actualizada');
  assert.equal((await readManifestFile(f.mind)).targets, undefined);
  assert.deepEqual(await snapshot(f.layout.baseDirectory), beforeBase);
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

test('sesiones y Base incompatible conservan la preparación para reanudar sin duplicarla', async (t) => {
  const f = await fixture(t);
  const active = await f.open();
  await assert.rejects(updateMind(f.options), { code: 'MIND_IN_USE' });
  const updates = path.join(f.mind, 'Sistema', 'Actualizaciones');
  const journalPath = path.join(updates, 'transaccion.json');
  const work = path.join(updates, 'Trabajo', 'actual');
  const preparedBytes = await fs.readFile(journalPath);
  const prepared = JSON.parse(preparedBytes.toString('utf8'));
  assert.equal(prepared.phase, 'prepared');
  assert.ok((await fs.stat(path.join(work, 'paquete'))).isDirectory());
  const preparedPayload = await snapshot(work);
  await active.close();
  const markerPath = path.join(f.layout.baseDirectory, 'mind-base.json');
  const marker = JSON.parse(await fs.readFile(markerPath, 'utf8'));
  await fs.writeFile(markerPath, JSON.stringify({ ...marker, version: BASE_FORMAT_VERSION + 1 }));
  const withoutUpdateState = entries=>Object.fromEntries(Object.entries(entries).filter(([r])=>!r.startsWith('Sistema/Actualizaciones/')));
  const before = withoutUpdateState(await snapshot(f.mind));
  await assert.rejects(updateMind(f.options), { code: 'UPDATE_BASE_INCOMPATIBLE' });
  assert.deepEqual(withoutUpdateState(await snapshot(f.mind)), before);
  // This retry did not create the operation: it must not destroy the package
  // previously prepared while a real session was active.
  assert.deepEqual(await fs.readFile(journalPath), preparedBytes);
  assert.deepEqual(await snapshot(work), preparedPayload);
  assert.deepEqual(await fs.readdir(path.join(updates, 'Trabajo')), ['actual']);
  // Resolve only the fictional format mismatch, then resume the same payload.
  // This fixture deliberately has a dummy runtime, so it uses an injected
  // verifier; real bootstrap/runtime recovery has separate native coverage.
  const originalMarker = JSON.stringify(marker);
  await fs.writeFile(markerPath, originalMarker);
  const resumed = await updateMind({ ...f.options, verifyInstalled: async () => {} });
  assert.equal(resumed.status, 'actualizada');
  assert.equal(resumed.to, '1.1.0');
  assert.equal(await fs.readFile(markerPath, 'utf8'), originalMarker);
  await assert.rejects(fs.stat(work), { code: 'ENOENT' });
  await assert.rejects(fs.stat(journalPath), { code: 'ENOENT' });
});

test('una sesión con otra Base de la misma instalación impide la actualización automática', async t => {
  const f = await fixture(t);
  const other = await openSession({ layout: { ...f.layout, baseDirectory: path.join(f.root, 'Otra Base') }, motorVersion: '1.0.0', observe: false });
  try { await assert.rejects(updateMind(f.options), { code: 'MIND_IN_USE' }); }
  finally { await other.close(); }
});

test('la sesión nueva espera a que termine la sustitución del producto', async t => {
  const f = await fixture(t);
  let enter;
  const entered = new Promise(resolve => { enter = resolve; });
  let finish;
  const mayFinish = new Promise(resolve => { finish = resolve; });
  const updating = updateMind({ ...f.options, verifyInstalled: async () => { enter(); await mayFinish; } });
  await entered;
  const starting = f.open();
  try {
    await new Promise(resolve => setTimeout(resolve, 75));
    assert.deepEqual(await fs.readdir(path.join(f.mind, '.mind-producto', 'sesiones')), []);
  } finally { finish(); }
  assert.equal((await updating).status, 'actualizada');
  await (await starting).close();
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
