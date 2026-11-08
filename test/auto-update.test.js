import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, createHash, sign } from 'node:crypto';
import { checkForUpdate, githubDownload, verifyFeed, readUpdateState } from '../src/auto-update.js';
import { UNIVERSAL_TARGETS } from '../src/product-files.js';

async function fixture(t, { legacy = false, revision = 1 } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mind-update-channel-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const motor = path.join(root, ...(legacy ? ['Motor'] : ['Sistema', 'Programa', 'Motor']));
  await fs.mkdir(path.join(motor, 'src'), { recursive: true });
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const key = publicKey.export({ type: 'spki', format: 'pem' });
  const manifest = { format: 'mind-product', version: 1, mindVersion: legacy ? '1.0.2' : '1.0.3', platform: 'win32', arch: 'x64', targets: UNIVERSAL_TARGETS, files: {},
    ...(legacy ? {} : { layoutVersion: 2, packageRevision: revision, updateProtocolVersion: 2 }) };
  const manifestBytes = JSON.stringify(manifest), manifestSha256 = createHash('sha256').update(manifestBytes).digest('hex');
  await fs.writeFile(path.join(root, ...(legacy ? [] : ['Sistema']), 'mind-producto.json'), manifestBytes);
  await fs.writeFile(path.join(motor, 'src', 'update-channel.json'), JSON.stringify({ repository: 'owner/distribution', url: 'https://github.com/owner/distribution/releases/latest/download/stable.json', publicKey: key }));
  const bytes = Buffer.from('paquete ficticio');
  const feed = { format: 'mind-update', version: 2, mindVersion: '1.0.3', packageRevision: revision + 1, layoutVersion: 2, updateProtocolVersion: 2, manifestSha256,
    packages: [{ platform: 'win32', arch: 'x64', targets: UNIVERSAL_TARGETS, url: 'https://github.com/owner/distribution/releases/download/v1.0.3/mind-r2.zip', sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }] };
  const envelope = () => { const payload = Buffer.from(JSON.stringify(feed)); return { payload: payload.toString('base64'), signature: sign(null, payload, privateKey).toString('base64') }; };
  let installed = 0, requests = 0, source, clock = Date.now();
  return { root, feed, envelope, key, manifestSha256, bytes,
    advance(ms) { clock += ms; }, get requests() { return requests; }, get installed() { return installed; }, get source() { return source; },
    options: { root, now: () => clock, random: () => 0, acquireLock: async () => async () => {},
      fetcher: async url => { requests++; return String(url).endsWith('stable.json') ? new Response(JSON.stringify(envelope())) : new Response(bytes); },
      install: async options => { installed++; source = options.source; assert.deepEqual(await fs.readFile(source), bytes); assert.equal(options.expectedRelease.mindVersion, '1.0.3'); assert.equal(options.expectedRelease.packageRevision, revision + 1); },
    },
  };
}

test('firma v2, revisión superior de misma 1.0.3, descarga única e instalación verificada', async t => {
  const f = await fixture(t);
  const result = await checkForUpdate(f.options);
  assert.equal(result.status, 'actualizada'); assert.equal(f.installed, 1); assert.equal(f.requests, 2);
  await assert.rejects(fs.stat(f.source), { code: 'ENOENT' });
  assert.equal((await readUpdateState(f.root)).phase, 'actualizada');
});

test('misma revisión y manifiesto es al día; no descarga paquete y limita comprobaciones por chat', async t => {
  const f = await fixture(t); f.feed.packageRevision = 1;
  assert.equal((await checkForUpdate(f.options)).status, 'al-dia');
  assert.equal(f.requests, 1); assert.equal(f.installed, 0);
  assert.equal((await checkForUpdate(f.options)).cached, true); assert.equal(f.requests, 1);
});

test('misma versión y revisión con otro manifiesto se rechaza', async t => {
  const f = await fixture(t); f.feed.packageRevision = 1; f.feed.manifestSha256 = 'a'.repeat(64);
  const result = await checkForUpdate(f.options);
  assert.equal(result.kind, 'integridad'); assert.equal(f.installed, 0);
});

test('legacy recibe estado de reparación requerida antes de descargar layout incompatible', async t => {
  const f = await fixture(t, { legacy: true });
  assert.equal((await checkForUpdate(f.options)).status, 'requiere-reparacion'); assert.equal(f.requests, 1); assert.equal(f.installed, 0);
});

test('sesiones reales dejan el paquete pendiente y el siguiente intento lo reutiliza sin red', async t => {
  const f = await fixture(t); let attempts = 0;
  const install = async options => { attempts++; assert.deepEqual(await fs.readFile(options.source), f.bytes); if (attempts === 1) throw Object.assign(new Error('Hay sesiones reales'), { code: 'MIND_IN_USE', prepared: true }); };
  const first = await checkForUpdate({ ...f.options, install });
  assert.equal(first.phase, 'espera-sesiones'); assert.equal(f.requests, 2);
  assert.equal((await checkForUpdate({ ...f.options, install })).cached, true); assert.equal(attempts, 1);
  f.advance(31_000);
  const second = await checkForUpdate({ ...f.options, install, fetcher: async () => { throw new Error('No debe usar la red'); } });
  assert.equal(second.status, 'actualizada'); assert.equal(attempts, 2); assert.equal(f.requests, 2);
});

test('sesión no verificable se informa distinta de sesión activa', async t => {
  const f = await fixture(t);
  const result = await checkForUpdate({ ...f.options, install: async () => { throw Object.assign(new Error('Identidad desconocida'), { code: 'SESSION_IDENTITY_UNKNOWN', prepared: true }); } });
  assert.equal(result.phase, 'espera-verificacion'); assert.equal(result.kind, 'sesiones-no-verificables');
});

test('clasifica DNS, permisos y servidor sin afirmar que la copia está al día', async t => {
  for (const [code, kind] of [['ENOTFOUND', 'dns'], ['EACCES', 'permisos']]) {
    const f = await fixture(t);
    const result = await checkForUpdate({ ...f.options, fetcher: async () => { throw Object.assign(new Error('fetch failed'), { cause: { code } }); } });
    assert.equal(result.status, 'aplazada'); assert.equal(result.kind, kind);
    const state = await readUpdateState(f.root); assert.equal(state.retryable, code === 'ENOTFOUND'); assert.ok(state.nextCheckAt);
  }
  const f = await fixture(t);
  assert.equal((await checkForUpdate({ ...f.options, fetcher: async () => new Response('fallo', { status: 503 }) })).kind, 'http');
});

test('firma falsa, contenido alterado, URL ajena y universal incompleto no se instalan', async t => {
  for (const scenario of ['firma', 'contenido', 'url', 'destinos']) {
    const f = await fixture(t), options = { ...f.options };
    if (scenario === 'contenido') f.feed.packages[0].sha256 = '0'.repeat(64);
    if (scenario === 'url') f.feed.packages[0].url = 'https://evil.example/mind.zip';
    if (scenario === 'destinos') f.feed.packages[0].targets = UNIVERSAL_TARGETS.slice(1);
    if (scenario === 'firma') options.fetcher = async () => new Response(JSON.stringify({ ...f.envelope(), signature: Buffer.alloc(64).toString('base64') }));
    assert.equal((await checkForUpdate(options)).status, 'aplazada', scenario); assert.equal(f.installed, 0);
  }
});

test('coordinador ocupado no modifica estado ni descarga otro paquete', async t => {
  const f = await fixture(t);
  const result = await checkForUpdate({ ...f.options, acquireLock: async () => { throw Object.assign(new Error('ocupado'), { code: 'LOCK_BUSY' }); } });
  assert.equal(result.phase, 'otra-operacion'); assert.equal(f.requests, 0); assert.equal(await readUpdateState(f.root), null);
});

test('el canal firmado exige identidad nueva válida y origen de distribución confiado', async t => {
  const f = await fixture(t); f.feed.packageRevision = -1;
  assert.throws(() => verifyFeed(f.envelope(), f.key));
  for (const url of ['http://github.com/owner/distribution/releases/a', 'https://github.com.evil/owner/distribution/releases/a', 'https://github.com/other/repo/releases/a']) assert.throws(() => githubDownload(url, 'owner/distribution'));
});

test('la actualización confirmada informa limpieza pendiente sin presentarse como fallo de instalación', async t => {
  const f = await fixture(t);
  const result = await checkForUpdate({ ...f.options, install: async () => ({ cleanupPending: true }) });
  assert.equal(result.status, 'actualizada'); assert.equal(result.cleanupPending, true);
  assert.equal((await readUpdateState(f.root)).phase, 'limpieza-pendiente');
});

test('un estado corrupto se conserva y no provoca otra descarga', async t => {
  const f = await fixture(t);
  const directory = path.join(f.root, 'Sistema', 'Actualizaciones');
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, 'estado.json'), bad = '{corrupto';
  await fs.writeFile(file, bad);
  const result = await checkForUpdate(f.options);
  assert.equal(result.phase, 'estado-no-verificable');
  assert.equal(await fs.readFile(file, 'utf8'), bad); assert.equal(f.requests, 0);
});

test('una copia corregida rechaza canal de protocolo anterior aunque lleve firma válida', async t => {
  const f = await fixture(t); f.feed.version = 1;
  const result = await checkForUpdate(f.options);
  assert.equal(result.code, 'UPDATE_PROTOCOL_INVALID'); assert.equal(f.installed, 0);
});
