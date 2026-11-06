#!/usr/bin/env node
// node scripts/firmar-actualizacion.mjs <versión estable> <clave.pem> <directorio paquetes> <stable.json>
// node scripts/firmar-actualizacion.mjs --verificar <versión estable> <directorio paquetes>
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readArchive, extractEntries } from '../src/archive.js';
import { readManifestFile, verifyTree, hashFile, isVersion, validUniversalTargets } from '../src/product-files.js';
import { productRuntime } from '../src/layout.js';
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
const publication = JSON.parse(await fs.readFile(fileURLToPath(new URL('../packaging/publicacion.json', import.meta.url)), 'utf8'));
if (publication.version !== 1 || publication.paquete !== 'universal' || !validUniversalTargets(publication.plataformas)) {
  throw new Error('packaging/publicacion.json no describe el paquete universal completo.');
}
const name = `Mind-${version}-universal.zip`;
const archives = (await fs.readdir(directory)).filter((file) => /\.(?:zip|tar\.gz)$/iu.test(file));
if (archives.length !== 1 || archives[0] !== name) throw new Error(`La entrega debe contener únicamente ${name} como paquete.`);
const file = path.join(directory, name);
const { size: bytes } = await fs.stat(file);
// El actualizador ya instalado rechaza descargas que superan 512 MiB.
if (bytes <= 0 || bytes > 512 * 1024 * 1024) throw new Error('El ZIP universal excede el límite del actualizador.');

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'mind-publicacion-'));
try {
  const extracted = await extractEntries(readArchive(file), temporary, { links: 'record' });
  const entries = await fs.readdir(temporary);
  if (entries.length !== 1 || entries[0] !== 'Mind') throw new Error('El paquete debe tener una sola raíz Mind/.');
  const root = path.join(temporary, 'Mind');
  const manifest = await readManifestFile(root);
  if (!validUniversalTargets(manifest?.targets) || manifest.mindVersion !== version || manifest.builtFrom !== sourceCommit) {
    throw new Error('El paquete universal no coincide con la versión, plataformas y commit de publicación.');
  }
  if (extracted.some((entry) => entry.type === 'symlink') || !(await verifyTree(root, manifest)).ok) {
    throw new Error('Los archivos del paquete universal difieren del manifiesto o contienen enlaces simbólicos.');
  }

  const required = ['Motor/bin/mind.js', 'Motor/package.json', 'mind', 'mind.cmd', 'Autorizar Mind.command', 'Autorizar Mind.cmd'];
  const executables = new Set(['Mind/mind', 'Mind/Autorizar Mind.command']);
  for (const target of publication.plataformas) {
    const [platform, arch] = target.split('-');
    const runtime = productRuntime(root, manifest, platform, arch);
    for (const executable of [runtime.nodeExecutable, runtime.pythonExecutable]) {
      const relative = path.relative(root, executable).split(path.sep).join('/');
      required.push(relative);
      if (platform !== 'win32') executables.add(`Mind/${relative}`);
    }
  }
  const modes = new Map(extracted.filter((entry) => entry.type === 'file').map((entry) => [entry.path, entry.mode]));
  if (manifest.files['.mcp.json'] || required.some((relative) => !manifest.files[relative])
      || [...executables].some((relative) => modes.get(relative) !== 0o755)) {
    throw new Error('Faltan ejecutores, iniciadores o permisos del paquete universal, o incluye una configuración MCP inicial.');
  }
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
const packages = [{
  platform: 'win32', arch: 'x64', targets: publication.plataformas,
  url: `https://github.com/${config.repository}/releases/download/v${version}/${encodeURIComponent(name)}`,
  bytes, sha256: await hashFile(file),
}];
if (verifyOnly) {
  process.stdout.write(`Mind ${version}: un ZIP universal para ${publication.plataformas.length} destinos, commit ${sourceCommit}.\n`);
} else {
  const key = createPrivateKey(await fs.readFile(keyFile));
  if (key.asymmetricKeyType !== 'ed25519' || createPublicKey(key).export({ type: 'spki', format: 'pem' }) !== config.publicKey) {
    throw new Error('La clave privada no corresponde al canal configurado.');
  }
  const payload = Buffer.from(JSON.stringify({ format: 'mind-update', version: 1, mindVersion: version, packages }));
  await fs.writeFile(output, JSON.stringify({ payload: payload.toString('base64'), signature: sign(null, payload, key).toString('base64') }) + '\n', { flag: 'wx' });
  process.stdout.write(`Canal firmado para Mind ${version}, un ZIP para ${publication.plataformas.length} destinos.\n`);
}
