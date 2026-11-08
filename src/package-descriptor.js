import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readManifestFile, verifyTree, compareVersions, isVersion } from './product-files.js';

export const PACKAGE_DESCRIPTOR_PATH = 'Sistema/entrega-firmada.json';
const HASH = /^[a-f0-9]{64}$/u;
const fail = (code, message) => Object.assign(new Error(message), { code });

export function releaseOf(value) {
  const release = {
    mindVersion: value?.mindVersion,
    packageRevision: value?.packageRevision ?? 0,
    layoutVersion: value?.layoutVersion ?? 1,
    updateProtocolVersion: value?.updateProtocolVersion ?? 1,
  };
  if (!isVersion(release.mindVersion) || release.mindVersion.includes('-')
      || !Number.isSafeInteger(release.packageRevision) || release.packageRevision < 0
      || ![1, 2].includes(release.layoutVersion) || ![1, 2].includes(release.updateProtocolVersion)) {
    throw fail('UPDATE_RELEASE_INVALID', 'La identidad de la entrega de Mind no es válida.');
  }
  return release;
}

export function compareReleases(left, right) {
  const a = releaseOf(left), b = releaseOf(right);
  return compareVersions(a.mindVersion, b.mindVersion) || Math.sign(a.packageRevision - b.packageRevision);
}

export function requireRelease(actual, expected) {
  const release = releaseOf(actual);
  if (expected && Object.keys(release).some(key => expected[key] !== undefined && expected[key] !== release[key])) {
    throw fail('UPDATE_RELEASE_MISMATCH', 'La entrega no corresponde a la versión y revisión esperadas.');
  }
  return release;
}

export function createSignedPackageDescriptor({ manifest, manifestBytes, privateKey }) {
  const release = releaseOf(manifest);
  if (release.layoutVersion !== 2 || release.updateProtocolVersion !== 2 || release.packageRevision < 1) {
    throw fail('PACKAGE_DESCRIPTOR_INVALID', 'La firma de paquete exige una entrega con revisión y formato nuevos.');
  }
  const key = privateKey?.type === 'private' ? privateKey : createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== 'ed25519') throw fail('PACKAGE_SIGNATURE_INVALID', 'La clave de paquete debe ser Ed25519.');
  const payload = Buffer.from(JSON.stringify({
    format: 'mind-package', version: 1, ...release,
    manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
  }));
  return { payload: payload.toString('base64'), signature: sign(null, payload, key).toString('base64') };
}

export function verifySignedPackageDescriptor(envelope, publicKey) {
  if (typeof envelope?.payload !== 'string' || typeof envelope.signature !== 'string') {
    throw fail('PACKAGE_SIGNATURE_INVALID', 'Falta la firma del paquete de Mind.');
  }
  const payload = Buffer.from(envelope.payload, 'base64');
  const key = createPublicKey(publicKey);
  if (key.asymmetricKeyType !== 'ed25519'
      || !verify(null, payload, key, Buffer.from(envelope.signature, 'base64'))) {
    throw fail('PACKAGE_SIGNATURE_INVALID', 'La firma del paquete no corresponde a la clave de confianza.');
  }
  let descriptor;
  try { descriptor = JSON.parse(payload.toString('utf8')); }
  catch { throw fail('PACKAGE_DESCRIPTOR_INVALID', 'El descriptor firmado no es JSON válido.'); }
  if (descriptor?.format !== 'mind-package' || descriptor.version !== 1 || !HASH.test(descriptor.manifestSha256)) {
    throw fail('PACKAGE_DESCRIPTOR_INVALID', 'El descriptor firmado del paquete no es válido.');
  }
  const release = releaseOf(descriptor);
  if (release.layoutVersion !== 2 || release.updateProtocolVersion !== 2 || release.packageRevision < 1) {
    throw fail('PACKAGE_DESCRIPTOR_INVALID', 'El descriptor no identifica la entrega corregida.');
  }
  return { ...release, manifestSha256: descriptor.manifestSha256 };
}

/** The caller supplies a previously trusted key; never load the trust anchor from this package. */
export async function verifyPackageDescriptor({ root, publicKey, expectedRelease, allowUserState = false }) {
  const descriptorFile = path.join(root, ...PACKAGE_DESCRIPTOR_PATH.split('/'));
  const manifestFile = path.join(root, 'Sistema', 'mind-producto.json');
  for (const file of [descriptorFile, manifestFile]) {
    if (!(await fs.lstat(file)).isFile()) throw fail('PACKAGE_DESCRIPTOR_INVALID', 'Manifiesto y firma deben ser archivos normales.');
  }
  const [envelope, manifestBytes] = await Promise.all([
    fs.readFile(descriptorFile, 'utf8').then(JSON.parse), fs.readFile(manifestFile),
  ]);
  const descriptor = verifySignedPackageDescriptor(envelope, publicKey);
  requireRelease(descriptor, expectedRelease);
  if (createHash('sha256').update(manifestBytes).digest('hex') !== descriptor.manifestSha256) {
    throw fail('PACKAGE_MANIFEST_ALTERED', 'El manifiesto no coincide con la firma del paquete.');
  }
  const manifest = await readManifestFile(root);
  if (!manifest) throw fail('PACKAGE_DESCRIPTOR_INVALID', 'Falta el manifiesto de la entrega.');
  const release = requireRelease(manifest, descriptor);
  const checked = await verifyTree(root, manifest, { allowUserState });
  if (!checked.ok) throw fail('UPDATE_PACKAGE_ALTERED', 'Los archivos del paquete no coinciden con su manifiesto firmado.');
  return { manifest, release, manifestSha256: descriptor.manifestSha256 };
}