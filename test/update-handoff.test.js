import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { requestUpdate, runHandoff, takeUpdateReport, describeHandoff, runnerPython } from '../src/update-handoff.js';
import { readHandoff, writeHandoff, handoffDirectory } from '../src/update-handoff-state.js';
import { verifyInstalledBase } from '../src/update-verifier.js';
import { writeUpdateState, readUpdateState } from '../src/update-state.js';
import { downloadUpdate } from '../src/auto-update.js';
import { productPaths, productRuntime } from '../src/layout.js';
import { releaseOf, createSignedPackageDescriptor } from '../src/package-descriptor.js';
import { UNIVERSAL_TARGETS, readManifestFile, hashFile, scanTree } from '../src/product-files.js';
import { writeZip } from '../src/archive.js';
import { identifyCurrentProcess, inspectProcessOwners } from '../src/process-identity.js';
import { startCentralMotor } from '../src/motor-central.js';
import { checkHealthyConnector, httpRequest, connectorPaths, stopCentralMotor } from '../src/connector.js';

const run = promisify(execFile);
const sourceMotor = fileURLToPath(new URL('..', import.meta.url));
const handoffModule = new URL('../src/update-handoff.js', import.meta.url).href;
const autoModule = new URL('../src/auto-update.js', import.meta.url).href;
const sha = value => createHash('sha256').update(value).digest('hex');
const python = process.env.MIND_TEST_BUNDLED_PYTHON ?? process.env.MIND_TEST_PYTHON ?? process.env.MIND_PYTHON;
const runtimeRelative = (kind, executable) => 'Sistema/Componentes/' + kind + '/' + process.platform + '-' + process.arch + '/' + executable;
const nodeRelative = runtimeRelative('Node', process.platform === 'win32' ? 'node.exe' : 'bin/node');
const pythonRelative = runtimeRelative('Python', process.platform === 'win32' ? 'python.exe' : 'bin/python3');

async function put(root, relative, data) {
  const file = path.join(root, ...relative.split('/'));
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, data);
}
async function fixture(t) {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mind-handoff-')));
  const cleanups = [];
  t.after(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); await fs.rm(temp, { recursive: true, force: true }); });
  const root = path.join(temp, 'Mind');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const channel = JSON.stringify({ repository: 'ensayo/mind', publicKey: publicKey.export({ type: 'spki', format: 'pem' }) });
  const files = { 'Sistema/Programa/Motor/app.txt': 'programa anterior ficticio',
    'Sistema/Programa/Motor/src/update-channel.json': channel, [nodeRelative]: 'node ficticio', [pythonRelative]: 'python ficticio' };
  const current = { format: 'mind-product', version: 1, mindVersion: '1.0.4', packageRevision: 1,
    layoutVersion: 2, updateProtocolVersion: 2, platform: 'win32', arch: 'x64', targets: UNIVERSAL_TARGETS,
    baseFormatVersion: 2, files: Object.fromEntries(Object.entries(files).map(([file, data]) => [file, sha(data)])), links: {} };
  for (const [name, data] of Object.entries(files)) await put(root, name, data);
  await put(root, 'Sistema/mind-producto.json', JSON.stringify(current));
  const incomingFiles = { ...files, 'Sistema/Programa/Motor/app.txt': 'programa nuevo ficticio' };
  const incoming = { ...current, mindVersion: '1.0.5', files: Object.fromEntries(Object.entries(incomingFiles).map(([file, data]) => [file, sha(data)])) };
  const incomingBytes = JSON.stringify(incoming) + '\n';
  const archive = path.join(temp, 'paquete-ficticio.zip');
  const archiveData = { ...incomingFiles, 'Sistema/mind-producto.json': incomingBytes,
    'Sistema/entrega-firmada.json': JSON.stringify(createSignedPackageDescriptor({ manifest: incoming, manifestBytes: incomingBytes, privateKey })) };
  await writeZip(archive, Object.entries(archiveData).map(([name, data]) => ({ path: name, type: 'file', source: { data } })), { root: 'My Mind', mtime: 1700000000 });
  const zip = await fs.readFile(archive);
  const feed = { format: 'mind-update', version: 2, ...releaseOf(incoming), manifestSha256: sha(incomingBytes),
    packages: [{ platform: 'win32', arch: 'x64', targets: UNIVERSAL_TARGETS,
      url: 'https://github.com/ensayo/mind/releases/download/v1.0.5/mind.zip', sha256: sha(zip), bytes: zip.length }] };
  const payload = Buffer.from(JSON.stringify(feed));
  await writeUpdateState(root, { phase: 'disponible', release: releaseOf(incoming), manifestSha256: feed.manifestSha256,
    package: feed.packages[0], envelope: { payload: payload.toString('base64'), signature: sign(null, payload, privateKey).toString('base64') } });
  const layout = { product: true, root, manifest: current, ...productPaths(root, current), pythonExecutable: python };
  await put(root, 'Sistema/Base/mind-base.json', JSON.stringify({ format: 'mind-base', version: 2,
    baseId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', createdAt: '2026-01-01T00:00:00.000Z' }));
  await put(root, 'Sistema/Base/continuidad.md', 'Decisión ficticia que se conserva.');
  await put(root, 'Conversaciones/recurso.txt', 'Recurso ficticio.');
  const expected = { expectedRelease: releaseOf(incoming), expectedManifestSha256: feed.manifestSha256, expectedPackageSha256: feed.packages[0].sha256 };
  return { temp, root, archive, zip, layout, current, incoming, feed, expected, cleanups,
    download: options => downloadUpdate({ ...options, fetcher: async () => new Response(zip) }) };
}

// Runtime de ensayo: usa los binarios instalados y su biblioteca estándar sin
// duplicar toda la distribución de Python. Los archivos originales solo se leen.
async function testPython(destination) {
  assert.ok(python && path.isAbsolute(python), 'MIND_TEST_BUNDLED_PYTHON debe apuntar al Python portable');
  await fs.mkdir(path.dirname(destination), { recursive: true });
  if (process.platform !== 'win32') { await fs.rm(destination, { force: true }); await fs.symlink(python, destination); return; }
  const origin = path.dirname(python);
  for (const name of await fs.readdir(origin)) {
    if (/^(?:python.*\.dll|vcruntime.*\.dll|python\.exe)$/i.test(name)) await fs.copyFile(path.join(origin, name), path.join(path.dirname(destination), name));
  }
  const pythonDll = (await fs.readdir(origin)).find(name => /^python\d{2,3}\.dll$/i.test(name));
  await fs.writeFile(path.join(path.dirname(destination), pythonDll.replace(/\.dll$/i, '._pth')),
    [path.join(origin, 'Lib'), path.join(origin, 'DLLs')].join('\n') + '\n');
}
async function recordFor(f, phase = 'iniciando') {
  const id = randomUUID();
  await testPython(runnerPython(f.root, id));
  const record = { id, phase, release: releaseOf(f.incoming), ...f.expected,
    baseDirectory: f.layout.baseDirectory, baseIdentity: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', owner: await identifyCurrentProcess({ pythonExecutable: python }), reported: {} };
  await writeHandoff(f.root, record);
  return record;
}

test('requestUpdate fija los hashes aprobados, copia antes de lanzar y no repite un relevo vivo', async t => {
  const f = await fixture(t);
  const calls = [];
  const options = { layout: f.layout, ...f.expected, waitForWorker: async () => ({ phase: 'descargando' }),
    prepareRunner: async (...args) => { calls.push({ prepare: args }); return { node: process.execPath, runner: 'runner-ficticio.js' }; },
    launch: async options => { calls.push({ launch: options }); return { pid: process.pid, independencia: true, mecanismo: 'ensayo' }; } };
  const first = await requestUpdate(options);
  assert.equal(first.estado, 'en-curso');
  assert.equal(calls.length, 2);
  assert.ok(calls[0].prepare);
  assert.equal(calls[1].launch.env.NODE_OPTIONS, '');
  assert.equal(calls[1].launch.env.UV_THREADPOOL_SIZE, undefined);
  assert.equal(calls[1].launch.env.MIND_CONEXION, undefined);
  const saved = await readHandoff(f.root);
  assert.equal(saved.expectedManifestSha256, f.expected.expectedManifestSha256);
  assert.equal(saved.baseDirectory, await fs.realpath(f.layout.baseDirectory));
  assert.equal((await requestUpdate(options)).id, first.id);
  assert.equal(calls.length, 2);
});

test('requestUpdate rechaza otra entrega y registra un fallo de preparación o lanzamiento', async t => {
  const f = await fixture(t);
  await assert.rejects(requestUpdate({ layout: f.layout, ...f.expected, expectedPackageSha256: '0'.repeat(64) }), { code: 'UPDATE_OFFER_CHANGED' });
  assert.equal(await readHandoff(f.root), null);
  await assert.rejects(requestUpdate({ layout: f.layout, ...f.expected,
    prepareRunner: async () => { throw Object.assign(new Error('No hay espacio para el relevo'), { code: 'ENOSPC' }); } }), { code: 'ENOSPC' });
  assert.equal((await readHandoff(f.root)).phase, 'fallida');
  assert.equal((await readHandoff(f.root)).error.code, 'ENOSPC');
});

test('el relevista descarga y aplica un ZIP real sin MCP, verifica antes del acta y conserva datos', async t => {
  const f = await fixture(t);
  const record = await recordFor(f);
  const phases = [], verifications = [], restarts = [];
  const result = await runHandoff({ root: f.root, id: record.id, download: f.download, healthy: async () => null,
    verify: async options => { verifications.push(options); return { ok: true, baseDirectory: options.baseDirectory, baseId: options.expectedBaseId, release: releaseOf(options.manifest) }; },
    restart: async options => { restarts.push(options); },
    hooks: { afterPhase: phase => { phases.push(phase); } } });
  assert.equal(result.status, 'actualizada');
  assert.equal(verifications.length, 1);
  assert.equal(verifications[0].baseDirectory, f.layout.baseDirectory);
  assert.equal((await readManifestFile(f.root)).mindVersion, '1.0.5');
  assert.equal((await readHandoff(f.root)).phase, 'completada');
  assert.equal(restarts.length, 1);
  assert.ok(phases.indexOf('verificando') < phases.indexOf('completada'));
  assert.equal(await fs.readFile(path.join(f.layout.baseDirectory, 'continuidad.md'), 'utf8'), 'Decisión ficticia que se conserva.');
  assert.equal(await fs.readFile(path.join(f.root, 'Conversaciones/recurso.txt'), 'utf8'), 'Recurso ficticio.');
  assert.equal((await readUpdateState(f.root)).phase, 'actualizada');
});

test('un fallo del Motor nuevo revierte el programa y aparece en el acta una vez por conexión', async t => {
  const f = await fixture(t);
  const record = await recordFor(f);
  const beforeBase = await hashFile(path.join(f.layout.baseDirectory, 'continuidad.md'));
  const result = await runHandoff({ root: f.root, id: record.id, download: f.download, healthy: async () => null,
    verify: async () => { throw Object.assign(new Error('La Base real no responde'), { code: 'UPDATE_CHECK_FAILED' }); },
    restart: async () => {} });
  assert.equal(result.status, 'fallida');
  assert.equal((await readManifestFile(f.root)).mindVersion, '1.0.4');
  assert.equal(await hashFile(path.join(f.layout.baseDirectory, 'continuidad.md')), beforeBase);
  const report = await takeUpdateReport({ layout: f.layout, conexion: 'chat-a' });
  assert.equal(report.estado, 'fallida');
  assert.match(report.texto, /no se completó/);
  assert.equal(report.error.code, 'UPDATE_CHECK_FAILED');
  assert.equal(await takeUpdateReport({ layout: f.layout, conexion: 'chat-a' }), null);
  assert.ok(await takeUpdateReport({ layout: f.layout, conexion: 'chat-b' }));
});

test('el acta de éxito llega una vez, no aparece durante la operación y resume el estado', async t => {
  const f = await fixture(t);
  const record = await recordFor(f);
  assert.equal(await takeUpdateReport({ layout: f.layout, conexion: 'chat' }), null);
  await writeHandoff(f.root, { ...record, phase: 'completada', verification: { ok: true }, result: { status: 'actualizada' } });
  assert.equal((await describeHandoff(f.layout)).fase, 'completada');
  const reports = await Promise.all(Array.from({ length: 4 }, () => takeUpdateReport({ layout: f.layout, conexion: 'chat' })));
  assert.equal(reports.filter(Boolean).length, 1);
  assert.match(reports.find(Boolean).texto, /Motor nuevo comprobó la Base real/);
  assert.equal(await takeUpdateReport({ layout: { product: false } }), null);
});

for (const phase of ['descargando', 'preparando', 'espera-quietud', 'aplicando', 'verificando', 'completada']) {
  test('corte abrupto en ' + phase + ': recupera sin descargar ni perder la Base', { timeout: 45_000 }, async t => {
    const f = await fixture(t);
    const record = await recordFor(f);
    const script = 'import fs from "node:fs/promises"; import {runHandoff} from ' + JSON.stringify(handoffModule)
      + '; import {downloadUpdate} from ' + JSON.stringify(autoModule)
      + '; const c=JSON.parse(process.env.MIND_HANDOFF_TEST); const zip=await fs.readFile(c.archive); await runHandoff({root:c.root,id:c.id,'
      + 'download:o=>downloadUpdate({...o,fetcher:async()=>new Response(zip)}),healthy:async()=>null,restart:async()=>{},'
      + 'verify:async o=>({ok:true,baseDirectory:o.baseDirectory,baseId:o.expectedBaseId,release:{mindVersion:o.manifest.mindVersion,packageRevision:o.manifest.packageRevision,layoutVersion:o.manifest.layoutVersion,updateProtocolVersion:o.manifest.updateProtocolVersion}}),hooks:{afterPhase:p=>{if(p===c.phase)process.exit(74)}}});';
    await assert.rejects(run(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, MIND_HANDOFF_TEST: JSON.stringify({ root: f.root, archive: f.archive, id: record.id, phase }) }, timeout: 35_000,
    }), error => error.code === 74);
    assert.equal((await readHandoff(f.root)).phase, phase);
    const outcome = await runHandoff({ root: f.root, id: record.id, recoverOnly: true,
      download: async () => { assert.fail('recuperar no puede usar la red'); }, restart: async () => {} });
    const committed = phase === 'completada';
    // Una terminal ya completa no requiere otra recuperación.
    assert.equal(outcome.status, committed ? 'sin-operacion' : 'recuperada');
    assert.equal((await readManifestFile(f.root)).mindVersion, committed ? '1.0.5' : '1.0.4');
    assert.equal(await fs.readFile(path.join(f.layout.baseDirectory, 'continuidad.md'), 'utf8'), 'Decisión ficticia que se conserva.');
    assert.equal(await fs.readFile(path.join(f.root, 'Conversaciones/recurso.txt'), 'utf8'), 'Recurso ficticio.');
  });
}

test('la quietud real espera a dos chats y revalida al apagar antes de aplicar', { timeout: 25_000 }, async t => {
  const f = await fixture(t);
  const record = await recordFor(f);
  const liveLayout = { product: false, root: null, baseDirectory: f.layout.baseDirectory, motorDirectory: sourceMotor,
    pythonExecutable: python, protectedDirectories: [] };
  const motor = await startCentralMotor({ layout: liveLayout, preferredPort: 0, observe: false, discoverDelayMs: -1,
    updateRoot: null, quietMs: 120, idleLightMs: 0, idleShutdownMs: 0 });
  f.cleanups.push(() => motor.stop('test-end'));
  async function openChats() { for (const client of ['codex-ficticio', 'otro-chat-ficticio']) {
    const payload = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: client, version: '1' } } });
    const response = await httpRequest({ port: motor.port, method: 'POST', pathName: '/mcp',
      headers: { Authorization: 'Bearer ' + motor.token, 'Content-Type': 'application/json' }, body: payload });
    assert.equal(response.status, 200);
  }
  }
  let waits = 0;
  let opened = false;
  const result = await runHandoff({ root: f.root, id: record.id, download: f.download, pollMs: 25,
    hooks: { afterPhase: async phase => { if (phase === 'espera-quietud' && !opened) { opened = true; await openChats(); } } },
    rpc: async options => {
      const { postRpc } = await import('../src/connector.js');
      const value = await postRpc(options);
      if (!value.quieto) { waits++; assert.ok(value.conexiones.length >= 2); }
      return value;
    },
    verify: async options => ({ ok: true, baseDirectory: options.baseDirectory, baseId: options.expectedBaseId, release: releaseOf(options.manifest) }), restart: async () => {},
  });
  assert.equal(result.status, 'actualizada');
  assert.ok(waits > 0, 'el relevista observó chats que todavía no estaban en quietud');
  assert.equal(await checkHealthyConnector(f.layout.baseDirectory), null);
});

test('el verificador usa el Node instalado y lee por RPC la Base real sin publicar un conector', { timeout: 45_000 }, async t => {
  const f = await fixture(t);
  const manifest = f.incoming;
  const paths = productPaths(f.root, manifest);
  for (const directory of ['src', 'bin']) await fs.cp(path.join(sourceMotor, directory), path.join(paths.motorDirectory, directory), { recursive: true });
  await fs.copyFile(path.join(sourceMotor, 'package.json'), path.join(paths.motorDirectory, 'package.json'));
  const runtime = productRuntime(f.root, manifest);
  await fs.copyFile(process.execPath, runtime.nodeExecutable);
  await testPython(runtime.pythonExecutable);
  await fs.writeFile(paths.manifestFile, JSON.stringify(manifest));
  const record = await recordFor(f, 'verificando');
  const verificationToken = 'e'.repeat(64);
  await writeHandoff(f.root, { ...record, verificationToken });
  const installedPackagePath = path.join(paths.motorDirectory, 'package.json');
  await assert.rejects(verifyInstalledBase({ root: f.root, manifest, baseDirectory: f.layout.baseDirectory, handoffId: record.id, verificationToken, parent: record.owner, expectedBaseId: record.baseIdentity, pythonExecutable: runtime.pythonExecutable, timeoutMs: 5_000 }), { code: 'UPDATE_CHECK_FAILED' });
  const candidatePackageBytes = JSON.stringify({ ...JSON.parse(await fs.readFile(installedPackagePath, 'utf8')), version: '1.0.5' }) + '\n';
  await fs.writeFile(installedPackagePath, candidatePackageBytes);
  manifest.files['Sistema/Programa/Motor/package.json'] = sha(candidatePackageBytes);
  await fs.writeFile(paths.manifestFile, JSON.stringify(manifest));
  const proof = await verifyInstalledBase({ root: f.root, manifest, baseDirectory: f.layout.baseDirectory,
    handoffId: record.id, verificationToken, parent: record.owner, expectedBaseId: record.baseIdentity, pythonExecutable: runtime.pythonExecutable, timeoutMs: 20_000 });
  assert.equal(proof.ok, true);
  assert.equal(proof.baseDirectory, await fs.realpath(f.layout.baseDirectory));
  assert.deepEqual(proof.release, releaseOf(manifest));
  await assert.rejects(fs.stat(connectorPaths(f.layout.baseDirectory).stateFile), { code: 'ENOENT' });
  await assert.rejects(verifyInstalledBase({ root: f.root, manifest, baseDirectory: f.layout.baseDirectory,
    handoffId: record.id, verificationToken: 'f'.repeat(64), parent: record.owner, expectedBaseId: record.baseIdentity, pythonExecutable: runtime.pythonExecutable, timeoutMs: 5_000 }), { code: 'UPDATE_CHECK_FAILED' });
});

test('un corte después del commit y antes del acta reconoce la instalación confirmada sin red', { timeout: 45_000 }, async t => {
  const f = await fixture(t);
  const record = await recordFor(f);
  const script = 'import fs from "node:fs/promises"; import {runHandoff} from ' + JSON.stringify(handoffModule)
    + '; import {downloadUpdate,installDownloaded} from ' + JSON.stringify(autoModule)
    + '; const c=JSON.parse(process.env.MIND_HANDOFF_TEST); const zip=await fs.readFile(c.archive); await runHandoff({root:c.root,id:c.id,'
    + 'download:o=>downloadUpdate({...o,fetcher:async()=>new Response(zip)}),healthy:async()=>null,restart:async()=>{},'
    + 'verify:async o=>({ok:true,baseDirectory:o.baseDirectory,baseId:o.expectedBaseId,release:{mindVersion:o.manifest.mindVersion,packageRevision:o.manifest.packageRevision,layoutVersion:o.manifest.layoutVersion,updateProtocolVersion:o.manifest.updateProtocolVersion}}),install:async o=>{await installDownloaded(o);process.exit(74)}});';
  await assert.rejects(run(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, MIND_HANDOFF_TEST: JSON.stringify({ root: f.root, archive: f.archive, id: record.id }) }, timeout: 35_000,
  }), error => error.code === 74);
  assert.equal((await readHandoff(f.root)).phase, 'verificando');
  assert.equal((await readManifestFile(f.root)).mindVersion, '1.0.5');
  const result = await runHandoff({ root: f.root, id: record.id, recoverOnly: true,
    download: async () => { assert.fail('recuperar no puede usar red'); } });
  assert.equal(result.status, 'actualizada');
  assert.equal((await readHandoff(f.root)).phase, 'completada');
  assert.equal((await readHandoff(f.root)).result.recovered, true);
});

async function waitUntil(check, ms = 30_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('No llegó el estado esperado dentro del plazo.');
}

test('requestUpdate real lanza el relevista independiente, instala un ZIP firmado y arranca el Motor nuevo', { timeout: 150_000, skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t);
  const paths = productPaths(f.root, f.current);
  for (const directory of ['src', 'bin']) await fs.cp(path.join(sourceMotor, directory), path.join(paths.motorDirectory, directory), { recursive: true });
  await fs.copyFile(path.join(sourceMotor, 'package.json'), path.join(paths.motorDirectory, 'package.json'));
  // La copia trae la configuración de desarrollo; esta instalación ficticia usa su clave efímera.
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  await put(f.root, 'Sistema/Programa/Motor/src/update-channel.json', JSON.stringify({
    repository: 'ensayo/mind', publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
  }));
  await put(f.root, 'Sistema/arranque.cjs', await fs.readFile(path.join(sourceMotor, 'packaging/iniciadores/arranque.cjs')));
  const runtime = productRuntime(f.root, f.current);
  await fs.copyFile(process.execPath, runtime.nodeExecutable);
  await testPython(runtime.pythonExecutable);
  const entries = (await scanTree(f.root)).filter(entry => entry.type === 'file'
    && (entry.path.startsWith('Sistema/Programa/') || entry.path.startsWith('Sistema/Componentes/') || entry.path === 'Sistema/arranque.cjs'));
  const files = Object.fromEntries(await Promise.all(entries.map(async entry => [entry.path, await hashFile(path.join(f.root, entry.path))])));
  const current = { ...f.current, files }, incoming = { ...f.incoming, files: { ...files } };
  const candidatePackage = { ...JSON.parse(await fs.readFile(path.join(paths.motorDirectory, 'package.json'), 'utf8')), version: '1.0.5' };
  const candidatePackageBytes = JSON.stringify(candidatePackage) + '\n';
  incoming.files['Sistema/Programa/Motor/package.json'] = sha(candidatePackageBytes);
  const newApp = 'programa nuevo ficticio';
  incoming.files['Sistema/Programa/Motor/app.txt'] = sha(newApp);
  await fs.writeFile(paths.manifestFile, JSON.stringify(current));
  const manifestBytes = JSON.stringify(incoming) + '\n';
  const packageEntries = entries.map(entry => ({ ...entry, source: { file: path.join(f.root, entry.path) } }));
  const appEntry = packageEntries.find(entry => entry.path === 'Sistema/Programa/Motor/app.txt');
  appEntry.source = { data: newApp };
  packageEntries.find(entry => entry.path === 'Sistema/Programa/Motor/package.json').source = { data: candidatePackageBytes };
  packageEntries.push({ path: 'Sistema/mind-producto.json', type: 'file', source: { data: manifestBytes } },
    { path: 'Sistema/entrega-firmada.json', type: 'file', source: { data: JSON.stringify(createSignedPackageDescriptor({ manifest: incoming, manifestBytes, privateKey })) } });
  const archive = path.join(f.temp, 'paquete-e2e.zip');
  await writeZip(archive, packageEntries, { root: 'My Mind', mtime: 1700000000 });
  const packageSha = await hashFile(archive);
  const feed = { format: 'mind-update', version: 2, ...releaseOf(incoming), manifestSha256: sha(manifestBytes),
    packages: [{ platform: 'win32', arch: 'x64', targets: UNIVERSAL_TARGETS, sha256: packageSha, bytes: (await fs.stat(archive)).size,
      url: 'https://github.com/ensayo/mind/releases/download/v1.0.5/mind.zip' }] };
  const payload = Buffer.from(JSON.stringify(feed));
  const cached = path.join(f.root, 'Sistema/Actualizaciones/descargas', packageSha + '.zip');
  await fs.mkdir(path.dirname(cached), { recursive: true });
  await fs.copyFile(archive, cached);
  await writeUpdateState(f.root, { phase: 'descargada', release: releaseOf(incoming), package: feed.packages[0],
    envelope: { payload: payload.toString('base64'), signature: sign(null, payload, privateKey).toString('base64') } });
  const layout = { ...f.layout, manifest: current, runtime, motorDirectory: paths.motorDirectory,
    pythonExecutable: runtime.pythonExecutable, protectedDirectories: [paths.programDirectory, paths.componentsDirectory] };
  const motor = await startCentralMotor({ layout, preferredPort: 0, observe: false, discoverDelayMs: -1, updateRoot: null,
    quietMs: 0, idleLightMs: 0, idleShutdownMs: 0 });
  f.cleanups.push(async () => {
    await stopCentralMotor(layout.baseDirectory).catch(() => {});
    await motor.stop('test-end').catch(() => {});
    const record = await readHandoff(f.root).catch(() => null);
    if (record?.owner?.pid && record.owner.pid !== process.pid) {
      const [owner] = await inspectProcessOwners([record.owner], { pythonExecutable: python });
      if (owner?.state === 'active') { process.kill(owner.pid); await new Promise(resolve => setTimeout(resolve, 200)); }
    }
  });
  const requested = await requestUpdate({ layout, expectedRelease: releaseOf(incoming),
    expectedManifestSha256: feed.manifestSha256, expectedPackageSha256: packageSha });
  if (process.platform === 'win32') assert.equal(requested.independencia, 'plena');
  const completed = await waitUntil(async () => {
    const record = await readHandoff(f.root);
    if (record?.phase === 'fallida') throw new Error('Relevista falló: ' + JSON.stringify(record.error));
    return record?.phase === 'completada' ? record : null;
  }, 100_000);
  assert.equal(completed.verification.ok, true);
  assert.equal(completed.verification.node, runtime.nodeExecutable);
  assert.equal(completed.verification.python, runtime.pythonExecutable);
  assert.equal(completed.verification.baseDirectory, await fs.realpath(layout.baseDirectory));
  const newMotor = await waitUntil(() => checkHealthyConnector(layout.baseDirectory), 25_000);
  assert.equal(newMotor.state.motorVersion, '1.0.5');
  assert.notEqual(newMotor.state.pid, process.pid);
  assert.equal((await readManifestFile(f.root)).mindVersion, '1.0.5');
  assert.equal(await fs.readFile(path.join(layout.baseDirectory, 'continuidad.md'), 'utf8'), 'Decisión ficticia que se conserva.');
});

test('requestUpdate informa un worker que termina antes de asumir el relevo', async t => {
  const f = await fixture(t);
  await assert.rejects(requestUpdate({ layout: f.layout, ...f.expected,
    prepareRunner: async () => ({ node: process.execPath, runner: 'ficticio.js' }),
    launch: async () => ({ pid: 999_999_999, independencia: 'plena', mecanismo: 'ensayo', exited: () => ({ code: 9 }) }),
  }), { code: 'UPDATE_HANDOFF_START_FAILED' });
  assert.equal((await readHandoff(f.root)).phase, 'fallida');
  assert.equal((await readHandoff(f.root)).error.code, 'UPDATE_HANDOFF_START_FAILED');
});

test('recoveryOnly conserva un dueño vivo y exige prueba ligada al manifiesto exacto', async t => {
  const f = await fixture(t);
  const record = await recordFor(f, 'verificando');
  await assert.rejects(runHandoff({ root: f.root, id: record.id, recoverOnly: true }), { code: 'UPDATE_OWNER_ACTIVE' });
  assert.equal((await readHandoff(f.root)).phase, 'verificando');
  await fs.writeFile(productPaths(f.root, f.incoming).manifestFile, JSON.stringify(f.incoming) + '\n');
  const identityScript = 'import {identifyCurrentProcess} from ' + JSON.stringify(new URL('../src/process-identity.js', import.meta.url).href) + '; console.log(JSON.stringify(await identifyCurrentProcess({pythonExecutable:process.env.MIND_TEST_BUNDLED_PYTHON})));';
  const exitedOwner = JSON.parse((await run(process.execPath, ['--input-type=module', '-e', identityScript], { env: process.env, timeout: 10_000 })).stdout.trim());
  await writeHandoff(f.root, { ...record,
    owner: exitedOwner,
    expectedManifestSha256: 'f'.repeat(64),
    verification: { ok: true, release: releaseOf(f.incoming), baseDirectory: f.layout.baseDirectory },
  });
  await assert.rejects(runHandoff({ root: f.root, id: record.id, recoverOnly: true,
    download: async () => assert.fail('no debe descargar') }), { code: 'UPDATE_INSTALLATION_UNVERIFIED' });
  assert.equal((await readHandoff(f.root)).phase, 'verificando');
});

test('el Motor de verificación rechaza MCP incluso con su token y solo admite la lectura de comprobación', async t => {
  const f = await fixture(t);
  const token = 'e'.repeat(64);
  const layout = { product: false, root: null, manifest: f.incoming, baseDirectory: f.layout.baseDirectory,
    motorDirectory: sourceMotor, pythonExecutable: python, protectedDirectories: [] };
  const motor = await startCentralMotor({ layout, verificationToken: token, publishConnector: false, preferredPort: 0,
    observe: false, discoverDelayMs: -1, updateRoot: null, idleLightMs: 0, idleShutdownMs: 0 });
  f.cleanups.push(() => motor.stop('test-end'));
  const headers = { Authorization: 'Bearer ' + motor.token, 'X-Mind-Update-Verification': token, 'Content-Type': 'application/json' };
  const mcp = await httpRequest({ port: motor.port, method: 'POST', pathName: '/mcp', headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {} } }) });
  assert.equal(mcp.status, 503);
  assert.equal(JSON.parse(mcp.body).error, 'UPDATE_VERIFICATION_ONLY');
  const unrelated = await httpRequest({ port: motor.port, method: 'POST', pathName: '/rpc', headers, body: JSON.stringify({ accion: 'ping' }) });
  assert.equal(unrelated.status, 503);
  const verified = await httpRequest({ port: motor.port, method: 'POST', pathName: '/rpc', headers, body: JSON.stringify({ accion: 'verificar-actualizacion' }) });
  assert.equal(verified.status, 200);
  assert.equal(JSON.parse(verified.body).baseId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  await assert.rejects(fs.stat(connectorPaths(f.layout.baseDirectory).stateFile), { code: 'ENOENT' });
});
