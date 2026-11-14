import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { writeZip } from '../src/archive.js';
import { releaseOf, createSignedPackageDescriptor } from '../src/package-descriptor.js';
import { UNIVERSAL_TARGETS, hashFile, readManifestFile } from '../src/product-files.js';
import { readUpdateState, writeUpdateState, updateStatePaths } from '../src/update-state.js';
import { readHandoff, writeHandoff } from '../src/update-handoff-state.js';
import { runHandoff, runnerPython } from '../src/update-handoff.js';
import { discoverUpdate, downloadUpdate } from '../src/auto-update.js';

const run = promisify(execFile);
const sha = value => createHash('sha256').update(value).digest('hex');
const python = process.env.MIND_TEST_BUNDLED_PYTHON ?? process.env.MIND_TEST_PYTHON ?? process.env.MIND_PYTHON;
const baseId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const modules = Object.fromEntries(['auto-update', 'update-handoff-state', 'update-transaction', 'process-identity', 'package-descriptor', 'commands/actualizar']
  .map(name => [name, new URL('../src/' + name + '.js', import.meta.url).href]));

async function put(root, relative, value) {
  const file = path.join(root, ...relative.split('/'));
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, value);
}
// Sólo se copian el ejecutable y sus DLL; la biblioteca estándar sigue siendo la
// del runtime de ensayo. No se copia ni se abre ninguna Base personal.
async function recoveryPython(destination) {
  assert.ok(python && path.isAbsolute(python), 'Las pruebas requieren MIND_TEST_BUNDLED_PYTHON absoluto.');
  await fs.mkdir(path.dirname(destination), { recursive: true });
  if (process.platform !== 'win32') { await fs.symlink(python, destination); return; }
  const origin = path.dirname(python);
  const names = await fs.readdir(origin);
  for (const name of names) if (/^(?:python.*\.dll|vcruntime.*\.dll|python\.exe)$/iu.test(name)) {
    await fs.copyFile(path.join(origin, name), path.join(path.dirname(destination), name));
  }
  const dll = names.find(name => /^python\d{2,3}\.dll$/iu.test(name));
  assert.ok(dll, 'El Python portable debe incluir su biblioteca dinámica.');
  await fs.writeFile(path.join(path.dirname(destination), dll.replace(/\.dll$/iu, '._pth')),
    [path.join(origin, 'Lib'), path.join(origin, 'DLLs')].join('\n') + '\n');
}
async function fixture(t) {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mind-recovery-state-')));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, 'Mind');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const channel = JSON.stringify({ repository: 'ficticio/mind',
    url: 'https://github.com/ficticio/mind/releases/latest/download/stable.json',
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }) });
  const executable = (kind, name) => 'Sistema/Componentes/' + kind + '/' + process.platform + '-' + process.arch + '/' + name;
  const files = { 'Sistema/Programa/Motor/app.txt': 'anterior ficticio',
    'Sistema/Programa/Motor/src/update-channel.json': channel,
    [executable('Node', process.platform === 'win32' ? 'node.exe' : 'bin/node')]: 'node ficticio',
    [executable('Python', process.platform === 'win32' ? 'python.exe' : 'bin/python3')]: 'python ficticio' };
  const current = { format: 'mind-product', version: 1, mindVersion: '1.0.4', packageRevision: 1,
    layoutVersion: 2, updateProtocolVersion: 2, platform: 'win32', arch: 'x64', targets: UNIVERSAL_TARGETS,
    baseFormatVersion: 2, files: Object.fromEntries(Object.entries(files).map(([name, data]) => [name, sha(data)])), links: {} };
  for (const [name, value] of Object.entries(files)) await put(root, name, value);
  await put(root, 'Sistema/mind-producto.json', JSON.stringify(current));
  const incomingFiles = { ...files, 'Sistema/Programa/Motor/app.txt': 'nuevo ficticio' };
  const incoming = { ...current, mindVersion: '1.0.5',
    files: Object.fromEntries(Object.entries(incomingFiles).map(([name, value]) => [name, sha(value)])) };
  const manifestBytes = JSON.stringify(incoming) + '\n';
  const archiveFiles = { ...incomingFiles, 'Sistema/mind-producto.json': manifestBytes,
    'Sistema/entrega-firmada.json': JSON.stringify(createSignedPackageDescriptor({ manifest: incoming, manifestBytes, privateKey })) };
  const archive = path.join(temporary, 'ficticio.zip');
  await writeZip(archive, Object.entries(archiveFiles).map(([name, value]) => ({ path: name, type: 'file', source: { data: value } })),
    { root: 'My Mind', mtime: 1700000000 });
  const packageSha256 = await hashFile(archive);
  const feed = { format: 'mind-update', version: 2, ...releaseOf(incoming), manifestSha256: sha(manifestBytes),
    packages: [{ platform: 'win32', arch: 'x64', targets: UNIVERSAL_TARGETS, sha256: packageSha256,
      bytes: (await fs.stat(archive)).size, url: 'https://github.com/ficticio/mind/releases/download/v1.0.5/mind.zip' }] };
  const payload = Buffer.from(JSON.stringify(feed));
  const envelope = { payload: payload.toString('base64'), signature: sign(null, payload, privateKey).toString('base64') };
  const downloaded = path.join(updateStatePaths(root).downloads, packageSha256 + '.zip');
  await fs.mkdir(path.dirname(downloaded), { recursive: true });
  await fs.copyFile(archive, downloaded);
  await writeUpdateState(root, { phase: 'descargada', release: releaseOf(incoming), envelope, package: feed.packages[0], nextCheckAt: null });
  const baseDirectory = path.join(root, 'Sistema', 'Base');
  await put(baseDirectory, 'mind-base.json', JSON.stringify({ format: 'mind-base', version: 2, baseId, createdAt: '2026-01-01T00:00:00.000Z' }));
  await put(baseDirectory, 'dato-ficticio.txt', 'Decisión ficticia conservada.');
  const id = randomUUID();
  await recoveryPython(runnerPython(root, id));
  await writeHandoff(root, { id, phase: 'verificando', release: releaseOf(incoming), expectedRelease: releaseOf(incoming),
    expectedManifestSha256: feed.manifestSha256, expectedPackageSha256: packageSha256, baseDirectory, baseIdentity: baseId, reported: {} });
  return { root, baseDirectory, id, current, incoming, feed, envelope, downloaded, python: runnerPython(root, id) };
}
async function cutInsideInstallation(f, phase) {
  const script = [
    'import fs from "node:fs/promises";',
    'import {installDownloaded} from ' + JSON.stringify(modules['auto-update']) + ';',
    'import {updateMind} from ' + JSON.stringify(modules['commands/actualizar']) + ';',
    'import {readHandoff,writeHandoff} from ' + JSON.stringify(modules['update-handoff-state']) + ';',
    'import {identifyCurrentProcess} from ' + JSON.stringify(modules['process-identity']) + ';',
    'import {releaseOf} from ' + JSON.stringify(modules['package-descriptor']) + ';',
    'const c=JSON.parse(process.env.MIND_RECOVERY_CUT);',
    'let record=await readHandoff(c.root);record={...record,owner:await identifyCurrentProcess({pythonExecutable:c.python})};await writeHandoff(c.root,record);',
    'await installDownloaded({root:c.root,baseDirectory:c.baseDirectory,install:options=>updateMind({...options,pythonExecutable:c.python,assistedVerification:true,',
    'verifyInstalled:async(root,incoming,context)=>{record={...record,verification:{ok:true,release:releaseOf(incoming),baseDirectory:context.baseDirectory,baseId:c.baseId}};await writeHandoff(c.root,record);if(c.phase==="verifying")process.exit(74);},',
    'testing:{afterPhase:phase=>{if(c.phase==="committed"&&phase===c.phase)process.exit(74);}}})});',
  ].join('\n');
  await assert.rejects(run(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, MIND_RECOVERY_CUT: JSON.stringify({ root: f.root, baseDirectory: f.baseDirectory, python: f.python, baseId, phase }) }, timeout: 45_000,
  }), error => error.code === 74);
  assert.equal((await readUpdateState(f.root)).phase, 'instalando', 'el corte debe preceder al guardado final del actualizador');
  assert.equal(JSON.parse(await fs.readFile(path.join(f.root, 'Sistema/Actualizaciones/transaccion.json'), 'utf8')).phase, phase);
  assert.equal((await readHandoff(f.root)).verification.ok, true);
}

for (const phase of ['committed', 'verifying']) {
  test('corte de transacción en ' + phase + ': recupera estado de actualización y permite descubrir o reintentar', { timeout: 60_000 }, async t => {
    const f = await fixture(t);
    await cutInsideInstallation(f, phase);
    const recovered = await runHandoff({ root: f.root, id: f.id, recoverOnly: true, restart: async () => {} });
    const committed = phase === 'committed';
    assert.equal(recovered.status, committed ? 'actualizada' : 'recuperada');
    const state = await readUpdateState(f.root);
    assert.equal(state.phase, committed ? 'actualizada' : 'disponible');
    assert.equal((await readManifestFile(f.root)).mindVersion, committed ? '1.0.5' : '1.0.4');
    assert.equal(await fs.readFile(path.join(f.baseDirectory, 'dato-ficticio.txt'), 'utf8'), 'Decisión ficticia conservada.');
    if (committed) {
      assert.equal(state.envelope, null);
      assert.equal(state.package, null);
      assert.deepEqual(state.installedRelease, releaseOf(f.incoming));
    } else assert.deepEqual(state.envelope, f.envelope);
    let requests = 0;
    const discovered = await discoverUpdate({ root: f.root, force: true, fetcher: async () => { requests++; return new Response(JSON.stringify(f.envelope)); } });
    assert.notEqual(discovered.status, 'en-curso');
    assert.equal(discovered.status, committed ? 'al-dia' : 'disponible');
    assert.equal(requests, 1, 'debe volver a consultar el canal, sin quedar bloqueado por instalando');
    if (!committed) {
      const retry = await downloadUpdate({ root: f.root, fetcher: async () => { assert.fail('el ZIP ya está verificado en disco'); } });
      assert.equal(retry.status, 'descargada');
    }
  });
}