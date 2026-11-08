#!/usr/bin/env node
// <versión pública> <clave.pem> <paquetes> <stable.json>; --verificar <versión> <paquetes>
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readArchive, extractEntries } from '../src/archive.js';
import { readManifestFile, hashFile, isVersion, validUniversalTargets } from '../src/product-files.js';
import { productPaths, productRuntime } from '../src/layout.js';
import { verifyPackageDescriptor, releaseOf } from '../src/package-descriptor.js';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2), verifyOnly = args[0] === '--verificar';
const [version, keyFile, directory, output] = verifyOnly ? [args[1], null, args[2]] : args;
if (!isVersion(version) || version.includes('-') || !directory || (!verifyOnly && (!keyFile || !output))) {
  throw new Error('Usa <versión> <clave.pem> <paquetes> <stable.json> o --verificar <versión> <paquetes>.');
}
const root = fileURLToPath(new URL('..', import.meta.url));
const config = JSON.parse(await fs.readFile(path.join(root, 'src', 'update-channel.json'), 'utf8'));
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const publication = JSON.parse(await fs.readFile(path.join(root, 'packaging', 'publicacion.json'), 'utf8'));
if (publication.version !== 1 || publication.paquete !== 'universal' || !validUniversalTargets(publication.plataformas)) throw new Error('La publicación no describe un paquete universal completo.');
const archives = (await fs.readdir(directory)).filter(name => /\.(?:zip|tar\.gz)$/iu.test(name));
if (archives.length !== 1 || !archives[0].endsWith('.zip')) throw new Error('La entrega debe contener un único ZIP universal.');
const name = archives[0], file = path.join(directory, name), { size: bytes } = await fs.stat(file);
if (bytes <= 0 || bytes > 512 * 1024 * 1024) throw new Error('El ZIP universal excede el presupuesto de descarga.');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'mind-publicacion-'));
let manifest, manifestSha256;
try {
  const extracted = await extractEntries(readArchive(file), temporary, { links: 'record' });
  if ((await fs.readdir(temporary)).join() !== 'My Mind') throw new Error('El paquete debe tener una sola raíz My Mind/.');
  const installation = path.join(temporary, 'My Mind');
  manifest = await readManifestFile(installation);
  if (!validUniversalTargets(manifest?.targets) || manifest.mindVersion !== version || manifest.builtFrom !== sourceCommit) throw new Error('El paquete no corresponde al commit, versión o destinos de publicación.');
  const release = releaseOf(manifest);
  if (release.layoutVersion !== 2 || release.updateProtocolVersion !== 2 || release.packageRevision < 1) throw new Error('La entrega requiere revisión, layout y actualizador corregidos.');
  if (name !== `Mind-${version}-universal-r${release.packageRevision}.zip`) throw new Error('El nombre del ZIP no identifica la revisión del paquete.');
  const signed = await verifyPackageDescriptor({ root: installation, publicKey: config.publicKey, expectedRelease: release });
  manifestSha256 = signed.manifestSha256;
  if (extracted.some(entry => entry.type === 'symlink')) throw new Error('El ZIP universal no puede depender de enlaces simbólicos.');
  const paths = productPaths(installation, manifest);
  const required = [path.relative(installation, paths.entrypoint).split(path.sep).join('/'), 'Sistema/mind', 'Sistema/mind.cmd'];
  const executables = new Set(['My Mind/Sistema/mind', 'My Mind/Sistema/Autorizar Mind.command']);
  for (const target of publication.plataformas) {
    const [platform, arch] = target.split('-'), runtime = productRuntime(installation, manifest, platform, arch);
    for (const executable of [runtime.nodeExecutable, runtime.pythonExecutable]) {
      const relative = path.relative(installation, executable).split(path.sep).join('/'); required.push(relative);
      if (platform !== 'win32') executables.add(`My Mind/${relative}`);
    }
  }
  const modes = new Map(extracted.filter(entry => entry.type === 'file').map(entry => [entry.path, entry.mode]));
  if (manifest.files['.mcp.json'] || required.some(relative => !manifest.files[relative]) || [...executables].some(relative => modes.get(relative) !== 0o755)) {
    throw new Error('Faltan ejecutores, iniciadores o permisos del paquete, o contiene configuración MCP del usuario.');
  }
} finally { await fs.rm(temporary, { recursive: true, force: true }); }
const payload = Buffer.from(JSON.stringify({ format: 'mind-update', version: 2, ...releaseOf(manifest), manifestSha256,
  packages: [{ platform: 'win32', arch: 'x64', targets: publication.plataformas,
    url: `https://github.com/${config.repository}/releases/download/v${version}/${encodeURIComponent(name)}`,
    bytes, sha256: await hashFile(file) }] }));
if (verifyOnly) process.stdout.write(`Mind ${version}, revisión ${manifest.packageRevision}: ZIP universal firmado y verificado.\n`);
else {
  const key = createPrivateKey(await fs.readFile(keyFile));
  if (key.asymmetricKeyType !== 'ed25519' || createPublicKey(key).export({ type: 'spki', format: 'pem' }) !== config.publicKey) throw new Error('La clave no corresponde al canal de confianza.');
  await fs.writeFile(output, JSON.stringify({ payload: payload.toString('base64'), signature: sign(null, payload, key).toString('base64') }) + '\n', { flag: 'wx' });
  process.stdout.write(`Canal v2 firmado para Mind ${version}, revisión ${manifest.packageRevision}.\n`);
}