import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { createSignedPackageDescriptor, verifyPackageDescriptor, verifySignedPackageDescriptor } from '../src/package-descriptor.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mind-package-signature-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const relative = 'Sistema/Programa/Motor/bin/mind.js', program = 'console.log("ficticio");\n';
  await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await fs.writeFile(path.join(root, relative), program);
  const manifest = { format: 'mind-product', version: 1, mindVersion: '1.0.3', platform: process.platform, arch: process.arch,
    packageRevision: 1, layoutVersion: 2, updateProtocolVersion: 2, files: { [relative]: createHash('sha256').update(program).digest('hex') } };
  const manifestBytes = JSON.stringify(manifest) + '\n';
  await fs.writeFile(path.join(root, 'Sistema', 'mind-producto.json'), manifestBytes);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const key = publicKey.export({ type: 'spki', format: 'pem' });
  const envelope = createSignedPackageDescriptor({ manifest, manifestBytes, privateKey });
  await fs.writeFile(path.join(root, 'Sistema', 'entrega-firmada.json'), JSON.stringify(envelope));
  return { root, relative, key, envelope, manifest };
}

test('descriptor autentica manifiesto y todos los archivos con clave previamente confiada', async t => {
  const f = await fixture(t), result = await verifyPackageDescriptor({ root: f.root, publicKey: f.key, expectedRelease: f.manifest });
  assert.equal(result.release.packageRevision, 1); assert.equal(result.release.mindVersion, '1.0.3');
});

test('otra clave, manifiesto modificado, archivo cambiado o extra no son auténticos', async t => {
  for (const mode of ['clave', 'manifiesto', 'archivo', 'extra']) {
    const f = await fixture(t); let publicKey = f.key;
    if (mode === 'clave') publicKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
    if (mode === 'manifiesto') await fs.appendFile(path.join(f.root, 'Sistema', 'mind-producto.json'), ' ');
    if (mode === 'archivo') await fs.writeFile(path.join(f.root, f.relative), 'contenido alterado');
    if (mode === 'extra') await fs.writeFile(path.join(f.root, 'extra.js'), 'código ajeno');
    await assert.rejects(verifyPackageDescriptor({ root: f.root, publicKey }), mode);
  }
});

test('revisión esperada no coincide y firma falsa se rechazan', async t => {
  const f = await fixture(t);
  await assert.rejects(verifyPackageDescriptor({ root: f.root, publicKey: f.key, expectedRelease: { packageRevision: 2 } }), { code: 'UPDATE_RELEASE_MISMATCH' });
  assert.throws(() => verifySignedPackageDescriptor({ ...f.envelope, signature: Buffer.alloc(64).toString('base64') }, f.key), { code: 'PACKAGE_SIGNATURE_INVALID' });
});

test('fuente ya abierta admite solo estado de usuario explicito; programa ajeno sigue rechazado', async t => {
  const f = await fixture(t);
  for (const relative of ['.mcp.json', 'Conversaciones/memoria.md', 'Sistema/Base/config.json', 'Sistema/Estado/sesiones/registro.json', 'Sistema/Actualizaciones/estado.json']) {
    const file = path.join(f.root, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, '{}');
  }
  await assert.rejects(verifyPackageDescriptor({ root: f.root, publicKey: f.key }));
  await verifyPackageDescriptor({ root: f.root, publicKey: f.key, allowUserState: true });
  await fs.writeFile(path.join(f.root, 'Sistema/Programa/Motor/bin/inyectado.js'), 'extra');
  await assert.rejects(verifyPackageDescriptor({ root: f.root, publicKey: f.key, allowUserState: true }), { code: 'UPDATE_PACKAGE_ALTERED' });
});
