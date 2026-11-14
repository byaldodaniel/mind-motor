import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import { applyUpdateConsent, updateConsentPaths } from '../src/update-consent.js';
import { createUpdateTools } from '../src/tools/actualizacion.js';
import { createConsent } from '../src/consent.js';
import { writeUpdateState } from '../src/update-state.js';
import { UNIVERSAL_TARGETS } from '../src/product-files.js';
import { productPaths } from '../src/layout.js';

const AT = Date.parse('2026-11-14T12:00:00.000Z');
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mind-update-consent-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const manifest = { format: 'mind-product', version: 1, mindVersion: '1.0.4', packageRevision: 1, layoutVersion: 2,
    updateProtocolVersion: 2, platform: 'win32', arch: 'x64', targets: UNIVERSAL_TARGETS, files: {} };
  const layout = { product: true, root, manifest, ...productPaths(root, manifest),
    pythonExecutable: process.env.MIND_TEST_BUNDLED_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3') };
  await fs.mkdir(path.join(layout.motorDirectory, 'src'), { recursive: true });
  await fs.writeFile(layout.manifestFile, JSON.stringify(manifest));
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  await fs.writeFile(path.join(layout.motorDirectory, 'src', 'update-channel.json'), JSON.stringify({
    repository: 'owner/distribution', publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
  }));
  const feed = { format: 'mind-update', version: 2, mindVersion: '1.0.5', packageRevision: 1, layoutVersion: 2, updateProtocolVersion: 2,
    manifestSha256: 'a'.repeat(64),
    packages: [{ platform: 'win32', arch: 'x64', targets: UNIVERSAL_TARGETS,
      url: 'https://github.com/owner/distribution/releases/download/v1.0.5/mind.zip', sha256: 'b'.repeat(64), bytes: 100 }] };
  const state = { phase: 'disponible', release: { ...feed }, envelope: null };
  async function write() {
    const payload = Buffer.from(JSON.stringify(feed));
    state.envelope = { payload: payload.toString('base64'), signature: sign(null, payload, privateKey).toString('base64') };
    await writeUpdateState(root, state);
  }
  await write();
  const requests = [];
  async function requestUpdate(options) { requests.push(options); return { estado: 'en-curso' }; }
  const apply = options => applyUpdateConsent({ layout, now: () => AT, requestUpdate, ...options });
  return { root, layout, feed, state, write, requests, requestUpdate, apply };
}

function form(response, { before = async () => {} } = {}) {
  const asked = [];
  const connection = { protocolVersion: '2025-11-25', supportsFormElicitation: () => true,
    async request(method, params) { asked.push({ method, params }); await before(); return response; } };
  return { asked, consent: createConsent({ connection, requests: null }) };
}

test('el formulario del cliente autoriza solo la identidad firmada exacta', async t => {
  const f = await fixture(t);
  const client = form({ action: 'accept', content: { confirmar: true } });
  const result = await f.apply({ consent: client.consent });
  assert.equal(result.estado, 'en-curso');
  assert.equal(client.asked[0].method, 'elicitation/create');
  assert.equal(client.asked[0].params.requestedSchema.properties.confirmar.default, false);
  assert.match(client.asked[0].params.message, /1\.0\.5/);
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.requests[0].expectedRelease, { mindVersion: '1.0.5', packageRevision: 1, layoutVersion: 2, updateProtocolVersion: 2 });
  assert.equal(f.requests[0].expectedManifestSha256, f.feed.manifestSha256);
  assert.equal(f.requests[0].expectedPackageSha256, f.feed.packages[0].sha256);
  await assert.rejects(fs.stat(updateConsentPaths(f.root).file), { code: 'ENOENT' });
});

test('rechazar, cancelar o aceptar sin marcar nunca descarga ni instala', async t => {
  const f = await fixture(t);
  for (const response of [{ action: 'decline' }, { action: 'cancel' }, { action: 'accept', content: { confirmar: false } }]) {
    const result = await f.apply({ consent: form(response).consent });
    assert.equal(result.estado, 'cancelada');
  }
  assert.equal(f.requests.length, 0);
});

test('sin MCP el primer paso entrega un código, guarda solo su hash y no prepara el paquete', async t => {
  const f = await fixture(t);
  const result = await f.apply();
  assert.equal(result.estado, 'requiere-confirmacion');
  assert.match(result.codigo, /^[a-f0-9]{24}$/);
  assert.equal(result.caduca, new Date(AT + 15 * 60_000).toISOString());
  assert.match(result.indicacion, /Espera su respuesta/);
  const bytes = await fs.readFile(updateConsentPaths(f.root).file, 'utf8');
  assert.equal(bytes.includes(result.codigo), false);
  assert.equal(JSON.parse(bytes).status, 'pendiente');
  assert.equal(path.relative(f.layout.baseDirectory, updateConsentPaths(f.root).file).startsWith('..'), true);
  assert.equal(f.requests.length, 0);
  await assert.rejects(fs.stat(path.join(f.root, 'Sistema', 'Actualizaciones', 'descargas')), { code: 'ENOENT' });
});

test('el segundo paso aplica una vez y el código consumido no se puede repetir', async t => {
  const f = await fixture(t);
  const first = await f.apply();
  assert.equal((await f.apply({ codigo: first.codigo })).estado, 'en-curso');
  assert.equal(f.requests.length, 1);
  assert.equal(JSON.parse(await fs.readFile(updateConsentPaths(f.root).file, 'utf8')).status, 'consumido');
  await assert.rejects(f.apply({ codigo: first.codigo }), { code: 'UPDATE_CONSENT_REQUIRED' });
  assert.equal(f.requests.length, 1);
});

test('el código caduca exactamente a los quince minutos', async t => {
  const f = await fixture(t);
  const first = await f.apply();
  await assert.rejects(f.apply({ codigo: first.codigo, now: () => AT + 15 * 60_000 }), { code: 'UPDATE_CONSENT_EXPIRED' });
  assert.equal(f.requests.length, 0);
});

test('un código incorrecto no autoriza y una solicitud nueva reemplaza la anterior', async t => {
  const f = await fixture(t);
  const first = await f.apply();
  const second = await f.apply();
  assert.notEqual(first.codigo, second.codigo);
  await assert.rejects(f.apply({ codigo: first.codigo }), { code: 'UPDATE_CONSENT_INVALID' });
  assert.equal((await f.apply({ codigo: second.codigo })).estado, 'en-curso');
  assert.equal(f.requests.length, 1);
});

test('el código rechaza cambios de versión, revisión, manifiesto o ZIP aunque estén firmados', async t => {
  for (const change of [
    f => { f.feed.mindVersion = '1.0.6'; },
    f => { f.feed.packageRevision++; },
    f => { f.feed.manifestSha256 = 'c'.repeat(64); },
    f => { f.feed.packages[0].sha256 = 'd'.repeat(64); },
  ]) {
    const f = await fixture(t);
    const first = await f.apply();
    change(f);
    await f.write();
    await assert.rejects(f.apply({ codigo: first.codigo }), { code: 'UPDATE_CANDIDATE_CHANGED' });
    assert.equal(f.requests.length, 0);
    assert.equal(JSON.parse(await fs.readFile(updateConsentPaths(f.root).file, 'utf8')).status, 'cancelado');
  }
});

test('se vuelve a verificar la entrega después de esperar la respuesta del formulario', async t => {
  const f = await fixture(t);
  const client = form({ action: 'accept', content: { confirmar: true } }, { before: async () => { f.feed.manifestSha256 = 'e'.repeat(64); await f.write(); } });
  await assert.rejects(f.apply({ consent: client.consent }), { code: 'UPDATE_CANDIDATE_CHANGED' });
  assert.equal(f.requests.length, 0);
});

test('rechazar el formulario invalida un código pendiente anterior', async t => {
  const f = await fixture(t);
  const first = await f.apply();
  await f.apply({ consent: form({ action: 'decline' }).consent });
  await assert.rejects(f.apply({ codigo: first.codigo }), { code: 'UPDATE_CONSENT_REQUIRED' });
  assert.equal(f.requests.length, 0);
});

test('dos confirmaciones concurrentes solo consumen una autorización', async t => {
  const f = await fixture(t);
  const first = await f.apply();
  const results = await Promise.allSettled([f.apply({ codigo: first.codigo }), f.apply({ codigo: first.codigo })]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'UPDATE_CONSENT_REQUIRED');
  assert.equal(f.requests.length, 1);
});

test('un fallo al lanzar no vuelve reutilizable el código consumido', async t => {
  const f = await fixture(t);
  const first = await f.apply();
  await assert.rejects(f.apply({ codigo: first.codigo, requestUpdate: async () => { throw new Error('fallo de lanzamiento'); } }), /fallo de lanzamiento/);
  await assert.rejects(f.apply({ codigo: first.codigo }), { code: 'UPDATE_CONSENT_REQUIRED' });
});

test('una firma inválida o un consentimiento corrupto no pueden autorizar', async t => {
  const f = await fixture(t);
  const first = await f.apply();
  f.state.envelope.signature = Buffer.alloc(64).toString('base64');
  await writeUpdateState(f.root, f.state);
  await assert.rejects(f.apply({ codigo: first.codigo }), { code: 'UPDATE_SIGNATURE_INVALID' });
  await f.write();
  await fs.writeFile(updateConsentPaths(f.root).file, '{corrupto');
  await assert.rejects(f.apply({ codigo: first.codigo }), { code: 'RECORD_CORRUPT' });
  assert.equal(f.requests.length, 0);
});

test('la herramienta valida argumentos, exige instalación y permite confirmar sin MCP', async t => {
  const f = await fixture(t);
  const tool = createUpdateTools({ session: { layout: f.layout }, requestUpdate: f.requestUpdate })
    .find(item => item.definition.name === 'actualizacion_aplicar');
  assert.ok(tool);
  await assert.rejects(tool.handler({ confirmar: true }), { code: 'INVALID_ARGUMENTS' });
  for (const codigo of ['', 123, true, '0'.repeat(25), 'z'.repeat(24)]) {
    await assert.rejects(tool.handler({ codigo }), { code: 'INVALID_ARGUMENTS' });
  }
  const first = await tool.handler({});
  assert.equal(first.estado, 'requiere-confirmacion');
  assert.equal(f.requests.length, 0);
  assert.equal((await tool.handler({ codigo: first.codigo })).estado, 'en-curso');
  assert.equal(f.requests.length, 1);
  await assert.rejects(applyUpdateConsent({ layout: { product: false } }), { code: 'UPDATE_NOT_INSTALLATION' });
});

test('la versión presentada procede del sobre firmado y no de metadatos de estado alterados', async t => {
  const f = await fixture(t);
  f.state.release = { ...f.feed, mindVersion: '9.9.9' };
  await writeUpdateState(f.root, f.state);
  const result = await f.apply();
  assert.equal(result.version, '1.0.5');
  assert.equal(f.requests.length, 0);
});
