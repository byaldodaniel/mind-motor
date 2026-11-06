#!/usr/bin/env node
// node scripts/firmar-actualizacion.mjs <versión estable> <clave.pem> <directorio paquetes> <stable.json>
// node scripts/firmar-actualizacion.mjs --verificar <versión estable> <directorio paquetes>
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readArchive, extractEntries, compareBytes } from '../src/archive.js';
import { readManifestFile, verifyTree, hashFile, isVersion } from '../src/product-files.js';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const verifyOnly = args[0] === '--verificar';
const [version, keyFile, directory, output] = verifyOnly ? [args[1], null, args[2]] : args;
if (!isVersion(version) || version.includes('-') || !directory || (!verifyOnly && (!keyFile || !output))) {
  throw new Error('Usa <versión estable> <clave.pem> <paquetes> <stable.json> o --verificar <versión estable> <paquetes>.');
}
const config = JSON.parse(await fs.readFile(fileURLToPath(new URL('../src/update-channel.json', import.meta.url)), 'utf8'));
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  encoding: 'utf8',
}).trim();
const packages = [];
const seen = new Set();
let sharedMotor;
for (const name of (await fs.readdir(directory)).filter(name => name.endsWith('.zip') || name.endsWith('.tar.gz')).sort()) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'mind-publicacion-'));
  try {
    const file = path.join(directory, name);
    const extracted = await extractEntries(readArchive(file), temporary, { links: 'record' });
    const entries = await fs.readdir(temporary);
    if (entries.length !== 1 || entries[0] !== 'Mind') throw new Error(`Raíz incorrecta: ${name}`);
    const root = path.join(temporary, 'Mind');
    const manifest = await readManifestFile(root);
    if (!manifest || manifest.mindVersion !== version || !(await verifyTree(root, { ...manifest, links: {} })).ok) {
      throw new Error(`Paquete no válido: ${name}`);
    }
    const recordedLinks = extracted.filter(entry => entry.type === 'symlink');
    if (recordedLinks.length !== Object.keys(manifest.links).length
        || recordedLinks.some(entry => !entry.path.startsWith('Mind/') || manifest.links[entry.path.slice(5)] !== entry.target)) {
      throw new Error(`Los enlaces del paquete ${name} difieren de su manifiesto.`);
    }
    const target = `${manifest.platform}-${manifest.arch}`;
    const extension = manifest.platform === 'win32' ? 'zip' : 'tar.gz';
    if (name !== `Mind-${version}-${target}.${extension}`) throw new Error(`Nombre de paquete incorrecto: ${name}`);
    if (manifest.builtFrom !== sourceCommit) throw new Error(`El paquete ${name} no viene del commit ${sourceCommit}.`);
    const motor = Object.keys(manifest.files).filter(relative => relative.startsWith('Motor/')).sort(compareBytes)
      .map(relative => [relative, manifest.files[relative]]);
    if (!manifest.files['Motor/bin/mind.js'] || !manifest.files['Motor/package.json']
        || Object.keys(manifest.links).some(relative => relative.startsWith('Motor/'))) {
      throw new Error(`El paquete ${name} no contiene el Motor esperado.`);
    }
    const motorContents = JSON.stringify(motor);
    if (sharedMotor !== undefined && motorContents !== sharedMotor) {
      throw new Error(`El Motor del paquete ${name} difiere del resto de la entrega.`);
    }
    sharedMotor = motorContents;
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
if (verifyOnly) {
  process.stdout.write(`Mind ${version}: Motor idéntico en ${packages.length} paquetes de ${sourceCommit}.\n`);
} else {
  const key = createPrivateKey(await fs.readFile(keyFile));
  if (key.asymmetricKeyType !== 'ed25519' || createPublicKey(key).export({ type: 'spki', format: 'pem' }) !== config.publicKey) {
    throw new Error('La clave privada no corresponde al canal configurado.');
  }
  const payload = Buffer.from(JSON.stringify({ format: 'mind-update', version: 1, mindVersion: version, packages }));
  await fs.writeFile(output, JSON.stringify({ payload: payload.toString('base64'), signature: sign(null, payload, key).toString('base64') }) + '\n', { flag: 'wx' });
  process.stdout.write(`Canal firmado para Mind ${version}, ${packages.length} plataformas.\n`);
}
