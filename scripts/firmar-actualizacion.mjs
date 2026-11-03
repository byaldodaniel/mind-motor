#!/usr/bin/env node
// node scripts/firmar-actualizacion.mjs <versión estable> <clave.pem> <directorio paquetes> <stable.json>
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { readArchive, extractEntries } from '../src/archive.js';
import { readManifestFile, verifyTree, hashFile, isVersion } from '../src/product-files.js';
import { fileURLToPath } from 'node:url';

const [version, keyFile, directory, output] = process.argv.slice(2);
if (!isVersion(version) || version.includes('-') || !keyFile || !directory || !output) {
  throw new Error('Uso: node scripts/firmar-actualizacion.mjs <versión estable> <clave.pem> <paquetes> <stable.json>');
}
const config = JSON.parse(await fs.readFile(fileURLToPath(new URL('../src/update-channel.json', import.meta.url)), 'utf8'));
const key = createPrivateKey(await fs.readFile(keyFile));
if (key.asymmetricKeyType !== 'ed25519' || createPublicKey(key).export({ type: 'spki', format: 'pem' }) !== config.publicKey) {
  throw new Error('La clave privada no corresponde al canal configurado.');
}
const packages = [];
const seen = new Set();
for (const name of (await fs.readdir(directory)).filter(name => name.endsWith('.zip') || name.endsWith('.tar.gz')).sort()) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'mind-publicacion-'));
  try {
    const file = path.join(directory, name);
    await extractEntries(readArchive(file), temporary);
    const entries = await fs.readdir(temporary);
    if (entries.length !== 1) throw new Error(`Raíz incorrecta: ${name}`);
    const root = path.join(temporary, entries[0]);
    const manifest = await readManifestFile(root);
    if (!manifest || manifest.mindVersion !== version || !(await verifyTree(root, manifest)).ok) throw new Error(`Paquete no válido: ${name}`);
    const target = `${manifest.platform}-${manifest.arch}`;
    if (seen.has(target)) throw new Error(`Plataforma repetida: ${target}`);
    seen.add(target);
    packages.push({ platform: manifest.platform, arch: manifest.arch,
      url: `https://github.com/${config.repository}/releases/download/v${version}/${encodeURIComponent(name)}`,
      bytes: (await fs.stat(file)).size, sha256: await hashFile(file) });
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}
const publication = JSON.parse(await fs.readFile(fileURLToPath(new URL('../packaging/publicacion.json', import.meta.url)), 'utf8'));
for (const target of publication.plataformas) {
  if (!seen.has(target)) throw new Error(`Falta el paquete ${target}; no se publica un canal incompleto.`);
}
if (packages.length !== publication.plataformas.length) throw new Error('El canal contiene plataformas fuera del alcance publicado.');
const payload = Buffer.from(JSON.stringify({ format: 'mind-update', version: 1, mindVersion: version, packages }));
await fs.writeFile(output, JSON.stringify({ payload: payload.toString('base64'), signature: sign(null, payload, key).toString('base64') }) + '\n', { flag: 'wx' });
process.stdout.write(`Canal firmado para Mind ${version}, ${packages.length} plataformas.\n`);
