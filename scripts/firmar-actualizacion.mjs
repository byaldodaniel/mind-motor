#!/usr/bin/env node
// <versión pública> <clave.pem> <paquetes> <stable.json> --novedades <archivo.json> [--anterior <zip>]
// --verificar <versión> <paquetes> [--novedades <archivo.json>] [--anterior <zip>]
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
import { validateAuthorNotes, validateBaseImpact, deriveComprobado, buildNovedades } from '../src/release-notes.js';

const args = process.argv.slice(2), verifyOnly = args[0] === '--verificar';
// Opciones con valor, en cualquier posición; se retiran antes de interpretar los argumentos posicionales.
function takeOption(name) {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  if (!args[at + 1] || args[at + 1].startsWith('--')) throw new Error(`${name} necesita un valor.`);
  const [, value] = args.splice(at, 2); return value;
}
const notesFile = takeOption('--novedades'), previousFile = takeOption('--anterior');
let testPublicKeyFile;
const testAt = args.indexOf('--clave-ensayo');
if (testAt >= 0) {
  if (!verifyOnly || testAt !== 3 || args.length !== 5 || !args[testAt + 1]) throw new Error('--clave-ensayo solo se admite en la verificacion de artefactos ficticios.');
  testPublicKeyFile = args[testAt + 1]; args.splice(testAt, 2);
}
const [version, keyFile, directory, output] = verifyOnly ? [args[1], null, args[2]] : args;
if (!isVersion(version) || version.includes('-') || !directory || (!verifyOnly && (!keyFile || !output))) {
  throw new Error('Usa <versión> <clave.pem> <paquetes> <stable.json> o --verificar <versión> <paquetes>.');
}
if (!verifyOnly && !notesFile) throw new Error('Firmar exige --novedades <archivo.json> con las novedades de la entrega (ver packaging/novedades.ejemplo.json).');
let authorNotes;
if (notesFile) {
  try { authorNotes = validateAuthorNotes(JSON.parse(await fs.readFile(notesFile, 'utf8'))); }
  catch (error) { throw new Error(`${notesFile}: ${error.message}`); }
}
const root = fileURLToPath(new URL('..', import.meta.url));
const config = JSON.parse(await fs.readFile(path.join(root, 'src', 'update-channel.json'), 'utf8'));
const trustedPublicKey = testPublicKeyFile ? await fs.readFile(testPublicKeyFile, 'utf8') : config.publicKey;
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const publication = JSON.parse(await fs.readFile(path.join(root, 'packaging', 'publicacion.json'), 'utf8'));
if (publication.version !== 1 || publication.paquete !== 'universal' || !validUniversalTargets(publication.plataformas)) throw new Error('La publicación no describe un paquete universal completo.');
const archives = (await fs.readdir(directory)).filter(name => /\.(?:zip|tar\.gz)$/iu.test(name));
if (archives.length !== 1 || !archives[0].endsWith('.zip')) throw new Error('La entrega debe contener un único ZIP universal.');
const name = archives[0], file = path.join(directory, name), { size: bytes } = await fs.stat(file);
if (bytes <= 0 || bytes > 512 * 1024 * 1024) throw new Error('El ZIP universal excede el presupuesto de descarga.');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'mind-publicacion-'));
/** Extrae un ZIP en una carpeta temporal y devuelve su manifiesto y el tamaño de cada archivo listado. */
async function inspectArchive(archive) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mind-novedades-'));
  try {
    await extractEntries(readArchive(archive), directory, { links: 'record' });
    const installation = path.join(directory, 'My Mind'), inspected = await readManifestFile(installation), sizes = {};
    if (!inspected) throw new Error(`${archive} no contiene manifiesto de Mind.`);
    for (const relative of Object.keys(inspected.files)) sizes[relative] = (await fs.stat(path.join(installation, ...relative.split('/')))).size;
    return { manifest: inspected, sizes };
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}
let manifest, manifestSha256, sizes;
try {
  const extracted = await extractEntries(readArchive(file), temporary, { links: 'record' });
  if ((await fs.readdir(temporary)).join() !== 'My Mind') throw new Error('El paquete debe tener una sola raíz My Mind/.');
  const installation = path.join(temporary, 'My Mind');
  manifest = await readManifestFile(installation);
  if (!validUniversalTargets(manifest?.targets) || manifest.mindVersion !== version || manifest.builtFrom !== sourceCommit) throw new Error('El paquete no corresponde al commit, versión o destinos de publicación.');
  const release = releaseOf(manifest);
  if (release.layoutVersion !== 2 || release.updateProtocolVersion !== 2 || release.packageRevision < 1) throw new Error('La entrega requiere revisión, layout y actualizador corregidos.');
  if (name !== `Mind-${version}-universal-r${release.packageRevision}.zip`) throw new Error('El nombre del ZIP no identifica la revisión del paquete.');
  const signed = await verifyPackageDescriptor({ root: installation, publicKey: trustedPublicKey, expectedRelease: release });
  manifestSha256 = signed.manifestSha256;
  sizes = {};
  for (const relative of Object.keys(manifest.files)) sizes[relative] = (await fs.stat(path.join(installation, ...relative.split('/')))).size;
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
// `comprobado` se deriva siempre del ZIP (y del anterior, si se indica); nunca del archivo del autor.
const previousManifest = previousFile ? (await inspectArchive(previousFile)).manifest : null;
if (authorNotes) validateBaseImpact(authorNotes, manifest, previousManifest);
const novedades = authorNotes ? buildNovedades(authorNotes, deriveComprobado({ manifest, sizes, packageBytes: bytes, previousManifest })) : null;
const payload = Buffer.from(JSON.stringify({ format: 'mind-update', version: 2, ...releaseOf(manifest), manifestSha256,
  ...(novedades ? { novedades } : {}),
  packages: [{ platform: 'win32', arch: 'x64', targets: publication.plataformas,
    url: `https://github.com/${config.repository}/releases/download/v${version}/${encodeURIComponent(name)}`,
    bytes, sha256: await hashFile(file) }] }));
if (verifyOnly) process.stdout.write(`Mind ${version}, revisión ${manifest.packageRevision}: ZIP universal firmado y verificado${novedades ? ', novedades válidas' : ''}${testPublicKeyFile ? ' con clave de ensayo (no publicable)' : ''}.\n`);
else {
  const key = createPrivateKey(await fs.readFile(keyFile));
  if (key.asymmetricKeyType !== 'ed25519' || createPublicKey(key).export({ type: 'spki', format: 'pem' }) !== config.publicKey) throw new Error('La clave no corresponde al canal de confianza.');
  await fs.writeFile(output, JSON.stringify({ payload: payload.toString('base64'), signature: sign(null, payload, key).toString('base64') }) + '\n', { flag: 'wx' });
  process.stdout.write(`Canal v2 firmado para Mind ${version}, revisión ${manifest.packageRevision}.\n`);
}