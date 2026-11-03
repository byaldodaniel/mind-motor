import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, createHash, sign } from 'node:crypto';
import { checkForUpdate, githubDownload } from '../src/auto-update.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mind-update-channel-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'Motor', 'src'), { recursive: true });
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  await fs.writeFile(path.join(root, 'mind-producto.json'), JSON.stringify({ format: 'mind-product', mindVersion: '1.0.0', platform: 'win32', arch: 'x64' }));
  await fs.writeFile(path.join(root, 'Motor', 'src', 'update-channel.json'), JSON.stringify({ repository: 'owner/distribution', url: 'https://github.com/owner/distribution/releases/latest/download/stable.json', publicKey: publicKey.export({ type: 'spki', format: 'pem' }) }));
  const bytes = Buffer.from('paquete ficticio');
  const feed = { format: 'mind-update', version: 1, mindVersion: '1.1.0', packages: [{ platform: 'win32', arch: 'x64', url: 'https://github.com/owner/distribution/releases/download/v1.1.0/mind.zip', sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }] };
  const envelope = () => { const payload = Buffer.from(JSON.stringify(feed)); return { payload: payload.toString('base64'), signature: sign(null, payload, privateKey).toString('base64') }; };
  let first = true;
  let installed = 0;
  let source;
  return { root, feed, envelope, get installed() { return installed; }, get source() { return source; }, options: {
    root, fetcher: async () => { if (first) { first = false; return new Response(JSON.stringify(envelope())); } return new Response(bytes); },
    install: async options => { installed++; source = options.source; assert.deepEqual(await fs.readFile(source), bytes); assert.equal(options.version, '1.1.0'); },
  } };
}

test('detecta, descarga y verifica un paquete firmado, instala sin preguntar y limpia la descarga', async t => {
  const f = await fixture(t);
  assert.equal((await checkForUpdate(f.options)).status, 'actualizada');
  assert.equal(f.installed, 1);
  await assert.rejects(fs.stat(f.source), { code: 'ENOENT' });
});

test('sin internet continúa con la instalación actual', async t => {
  const f = await fixture(t);
  const result = await checkForUpdate({ ...f.options, fetcher: async () => { throw new Error('offline'); } });
  assert.equal(result.status, 'aplazada'); assert.equal(f.installed, 0);
});

test('no instala firmas falsas, contenido alterado, versiones antiguas, preliminares ni plataformas incorrectas', async t => {
  for (const scenario of ['firma', 'contenido', 'anterior', 'preliminar', 'plataforma', 'url']) {
    const f = await fixture(t);
    if (scenario === 'contenido') f.feed.packages[0].sha256 = '0'.repeat(64);
    if (scenario === 'anterior') f.feed.mindVersion = '0.9.0';
    if (scenario === 'preliminar') f.feed.mindVersion = '1.2.0-rc.1';
    if (scenario === 'plataforma') f.feed.packages[0].arch = 'arm64';
    if (scenario === 'url') f.feed.packages[0].url = 'https://evil.example/mind.zip';
    const options = { ...f.options };
    if (scenario === 'firma') options.fetcher = async () => new Response(JSON.stringify({ ...f.envelope(), signature: Buffer.alloc(64).toString('base64') }));
    const result = await checkForUpdate(options);
    assert.notEqual(result.status, 'actualizada', scenario); assert.equal(f.installed, 0);
  }
});

test('el canal exige HTTPS y el repositorio de distribución configurado', () => {
  for (const url of ['http://github.com/owner/distribution/releases/a', 'https://github.com.evil/owner/distribution/releases/a', 'https://github.com/other/repo/releases/a']) {
    assert.throws(() => githubDownload(url, 'owner/distribution'));
  }
});
