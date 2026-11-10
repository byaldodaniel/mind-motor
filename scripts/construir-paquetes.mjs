#!/usr/bin/env node
// Construye el ZIP universal de Mind para Windows, macOS y Linux.
//
//   node scripts/construir-paquetes.mjs [--plataforma <id> ...] [--salida <carpeta>]
//                                       [--cache <carpeta>] [--sumas-oficiales] [--conservar-carpeta]
//
// El ZIP incluye un Motor y los runtimes de todas las plataformas publicadas.
// --plataforma permite construir los paquetes nativos de diagnóstico.
// Ninguno contiene una Base: se crea en el primer uso.
//
// Reproducible: los runtimes se descargan de las URL de packaging/componentes.json
// y se rechazan si su SHA-256 no coincide; el Motor sale de los archivos
// versionados en git; las entradas se ordenan y la fecha de todas es la del
// commit (o SOURCE_DATE_EPOCH). Dos construcciones del mismo commit producen
// paquetes idénticos byte a byte.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import {
  readArchive, extractEntries, writeTarGz, writeZip, compareBytes, normalizedMode, resolveLinkTarget, safeRelativePath,
} from '../src/archive.js';
import {
  hashFile, scanTree, validateManifest, validUniversalTargets, verifyTree, describeProblems, MANIFEST_NAME, MANIFEST_RELATIVE_PATH, manifestRelativePath,
} from '../src/product-files.js';
import { copySemanticBundle } from '../src/semantic-bundle.js';
import { BASE_FORMAT_VERSION } from '../src/base-format.js';

/** El manifiesto declara siempre la capacidad real del Motor que se empaqueta. */
export function createPackageManifest(metadata) {
  return validateManifest({ ...metadata, baseFormatVersion: BASE_FORMAT_VERSION });
}

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PACKAGING = path.join(ROOT, 'packaging');

export const TARGETS = Object.freeze({
  'linux-x64': { platform: 'linux', arch: 'x64', format: 'tar.gz' },
  'linux-arm64': { platform: 'linux', arch: 'arm64', format: 'tar.gz' },
  'darwin-arm64': { platform: 'darwin', arch: 'arm64', format: 'tar.gz' },
  'darwin-x64': { platform: 'darwin', arch: 'x64', format: 'tar.gz' },
  'win32-x64': { platform: 'win32', arch: 'x64', format: 'zip' },
});

/** Archivos del Motor que viajan en el paquete (solo los versionados en git). */
const MOTOR_PATHS = ['bin', 'src', 'package.json', 'LICENSE', 'docs/PRODUCTO.md', 'docs/CONTROL_RECURSOS.md', 'docs/CIERRE_1_0_3.md'];

function fail(message) {
  throw new Error(message);
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** Descarga (o reutiliza de la caché) un componente y comprueba su SHA-256. */
async function fetchComponent({ url, archivo, sha256 }, cache) {
  await fsp.mkdir(cache, { recursive: true });
  const file = path.join(cache, archivo);
  if (fs.existsSync(file)) {
    if (await hashFile(file) === sha256) return file;
    await fsp.rm(file);
  }
  process.stdout.write(`  descargando ${archivo}\n`);
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) fail(`No se pudo descargar ${url} (HTTP ${response.status}).`);
  const partial = `${file}.parcial`;
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(partial));
  const actual = await hashFile(partial);
  if (actual !== sha256) {
    await fsp.rm(partial, { force: true });
    fail(`SHA-256 incorrecto para ${archivo}: se esperaba ${sha256} y se obtuvo ${actual}. No se empaqueta.`);
  }
  await fsp.rename(partial, file);
  return file;
}

/** Contrasta las huellas de componentes.json con las listas oficiales publicadas. */
async function checkOfficialSums(components, targets) {
  const sources = [
    { url: `https://nodejs.org/dist/v${components.node.version}/SHASUMS256.txt`, entries: targets.map((id) => components.node.plataformas[id]) },
    { url: components.python.sumas_oficiales, entries: targets.map((id) => components.python.plataformas[id]) },
  ];
  for (const { url, entries } of sources) {
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok) fail(`No se pudieron obtener las sumas oficiales de ${url} (HTTP ${response.status}).`);
    const listed = new Map((await response.text()).split('\n').map((line) => line.trim().split(/\s+/u)).filter((parts) => parts.length === 2)
      .map(([hash, name]) => [name.replace(/^\*/u, ''), hash]));
    for (const entry of entries) {
      if (listed.get(entry.archivo) !== entry.sha256) fail(`La huella de ${entry.archivo} no coincide con ${url}.`);
    }
    process.stdout.write(`  huellas contrastadas con ${url}\n`);
  }
}

/** Node no incluye xz. En Windows se usa lzma del Python de construcción. */
function decompressXz(file) {
  const windows = process.platform === 'win32';
  const program = windows ? 'python' : 'xz';
  const args = windows
    ? ['-I', '-B', '-c', `import lzma, shutil, sys
with lzma.open(sys.argv[1], "rb") as source:
    shutil.copyfileobj(source, sys.stdout.buffer)`, file]
    : ['-dc', file];
  const child = spawn(program, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('close', (code) => {
    if (code !== 0) child.stdout.destroy(new Error(`${program} terminó con código ${code}: ${stderr.trim()}`));
  });
  child.on('error', (error) => child.stdout.destroy(error));
  return child.stdout;
}

/** Node.js: solo el ejecutable y su licencia (sin npm ni cabeceras). */
async function extractNode(file, runtime, target, direct = false) {
  const keep = target.platform === 'win32' ? new Set(['node.exe', 'LICENSE']) : new Set(['bin/node', 'LICENSE']);
  const extracted = await extractEntries(readArchive(file, { decompressXz }), (direct ? runtime : path.join(runtime, 'node')), {
    map: (name, entry) => {
      const inner = name.split('/').slice(1).join('/');
      return entry.type !== 'directory' && keep.has(inner) ? inner : null;
    },
  });
  const found = new Set(extracted.filter((entry) => entry.type === 'file').map((entry) => entry.path));
  for (const name of keep) if (!found.has(name)) fail(`El archivo de Node no contiene ${name}.`);
  return extracted;
}

/** Perfil mínimo: conserva stdlib y extensiones usadas, excluye herramientas de desarrollo/GUI. */
export function keepPythonPath(relative) {
  const value = relative.toLowerCase();
  if (/(?:^|\/)(?:include|__pycache__|ensurepip|idlelib|tkinter|turtledemo)(?:\/|$)/u.test(value)) return false;
  if (/(?:^|\/)site-packages\/pip(?:[./-]|$)/u.test(value)) return false;
  if (/(?:^|\/)(?:tcl|tk|itcl|tix)(?:\d+(?:\.\d+)*)?(?:\/|$)/u.test(value) || /(?:^|\/)thread\d+(?:\.\d+)*(?:\/|$)/u.test(value)) return false;
  if (/(?:^|\/)(?:lib(?:tcl|tk|itcl|thread)[^/]*|(?:tcl|tk)\d+[^/]*|_tkinter[^/]*)\.(?:so|dylib|dll|pyd)(?:\.\d+)*$/u.test(value)) return false;
  if (/(?:^|\/)(?:turtle\.py|idle(?:3(?:\.\d+)?)?|pip(?:3(?:\.\d+)?)?|2to3(?:-\d+\.\d+)?|python3?(?:\.\d+)?-config|pydoc3?(?:\.\d+)?)$/u.test(value)) return false;
  return !/\.(?:pyc|pyo|a)$/u.test(value) && !value.startsWith('share/terminfo/');
}

async function extractPython(file, runtime, target, recordLinks, direct = false) {
  const extracted = await extractEntries(readArchive(file), (direct ? runtime : path.join(runtime, 'python')), {
    // share/terminfo (bases de datos de terminales para curses) no lo usa Mind y
    // contiene nombres que solo difieren en mayúsculas: chocan en macOS y Windows.
    map: (name) => (name.startsWith('python/') && keepPythonPath(name.slice('python/'.length)) ? name.slice('python/'.length) : null),
    links: recordLinks || target.platform === 'win32' ? 'record' : 'create',
  });
  const interpreter = target.platform === 'win32' ? 'python.exe' : 'bin/python3';
  if (!extracted.some((entry) => entry.path === interpreter)) fail(`El archivo de Python no contiene ${interpreter}.`);
  if (target.platform === 'win32' && extracted.some((entry) => entry.type === 'symlink')) {
    fail('El Python de Windows contiene enlaces simbólicos, que el paquete zip no admite.');
  }
  return extracted;
}

async function copyFile(source, destination, { crlf = false, mode } = {}) {
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  if (crlf) {
    const text = (await fsp.readFile(source, 'utf8')).replace(/\r?\n/gu, '\r\n');
    await fsp.writeFile(destination, text, { flag: 'wx' });
  } else {
    await fsp.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
  }
  if (mode !== undefined && process.platform !== 'win32') await fsp.chmod(destination, mode);
}

/** El paquete sale de los blobs del commit, incluso si el editor escribió CRLF. */
async function copyRepositoryFile(relative, destination, { crlf = false, mode = 0o644 } = {}) {
  let data = execFileSync('git', ['show', `HEAD:${relative}`], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
  if (crlf) data = Buffer.from(data.toString('utf8').replace(/\r?\n/gu, '\r\n'));
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  await fsp.writeFile(destination, data, { flag: 'wx', mode });
  if (process.platform !== 'win32') await fsp.chmod(destination, mode);
}

/** Configuración MCP de proyecto para Claude Code: rutas relativas a la carpeta de Mind. */
function mcpConfig(target) {
  const windows = target.platform === 'win32';
  return `${JSON.stringify({
    mcpServers: {
      mind: {
        type: 'stdio',
        command: windows ? 'Sistema\\Componentes\\Node\\win32-x64\\node.exe' : `Sistema/Componentes/Node/${target.platform}-${target.arch}/bin/node`,
        args: ['Sistema/arranque.cjs', 'mcp'],
        // Opciones de Node del usuario no deben alterar el Motor.
        env: { NODE_OPTIONS: '' },
      },
    },
  }, null, 2)}\n`;
}

function noticesText(components, id, prefix) {
  const node = components.node.plataformas[id];
  const python = components.python.plataformas[id];
  return `# Componentes de terceros

Este paquete de Mind incluye, sin modificarlos, los siguientes componentes. Sus
licencias acompañan al paquete.

| Componente | Versión | Licencia | Archivo de origen | SHA-256 del origen |
|---|---|---|---|---|
| Node.js | ${components.node.version} | ${components.node.licencia} (véase \`node.txt\`) | ${node.url} | \`${node.sha256}\` |
| CPython (python-build-standalone ${components.python.publicacion}, ${components.python.variante}) | ${components.python.version} | ${components.python.licencia} (véase \`python.txt\`) | ${python.url} | \`${python.sha256}\` |

Del archivo de Node.js solo se incluyen el ejecutable y su licencia. De CPython
se incluye el perfil mínimo de ejecución (biblioteca estándar y auxiliares), sin pip, herramientas gráficas ni cabeceras. Los alias ejecutables POSIX son pequeños iniciadores del intérprete original.

La integridad de estos archivos se comprobó con su SHA-256 antes de empaquetarlos
y cada archivo del paquete figura con su huella en \`mind-producto.json\`. Eso
demuestra que el paquete no cambió desde su construcción; no es una garantía de
seguridad de los propios componentes.
`;
}

async function findPythonLicense(runtime, target, direct = false) {
  const candidates = target.platform === 'win32'
    ? [direct ? 'LICENSE.txt' : 'python/LICENSE.txt']
    : [direct ? 'lib/python3.12/LICENSE.txt' : 'python/lib/python3.12/LICENSE.txt'];
  for (const relative of candidates) {
    const file = path.join(runtime, ...relative.split('/'));
    if (fs.existsSync(file)) return file;
  }
  fail('No se encontró la licencia de CPython en el Python incluido.');
}

/** Comprueba que el archivo final conserva los permisos y enlaces esperados. */
async function verifyArchiveMetadata(file, entries) {
  const remaining = new Map(entries.map((entry) => [`My Mind/${entry.path}`, entry]));
  for await (const entry of readArchive(file)) {
    if (entry.type === 'directory') continue;
    const expected = remaining.get(entry.name);
    if (expected?.type !== entry.type || entry.mode !== normalizedMode(expected.type, expected.mode)
        || (entry.type === 'symlink' && entry.linkname !== expected.target)) {
      fail(`Metadatos inesperados en el paquete: ${entry.name}.`);
    }
    remaining.delete(entry.name);
  }
  if (remaining.size > 0) fail(`Faltan entradas en el paquete: ${[...remaining.keys()].slice(0, 5).join(', ')}.`);
}

async function copySharedFiles(stage) {
  // Motor: archivos versionados (sin pruebas, scripts ni Bases de desarrollo).
  const tracked = git(['ls-files', '-z', '--', ...MOTOR_PATHS]).split('\0').filter(Boolean);
  if (tracked.length === 0) fail('No hay archivos del Motor versionados.');
  for (const relative of tracked) {
    await copyRepositoryFile(relative, path.join(stage, 'Sistema', 'Programa', 'Motor', ...relative.split('/')));
  }
  const semanticConfig = JSON.parse(git(['show', 'HEAD:packaging/semantica.json']));
  await copySemanticBundle(path.join(stage, 'Sistema', 'Componentes', 'Semantica'), { manifestSha256: semanticConfig.bundleManifestSha256 });
  for (const name of ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', 'LEEME.md']) {
    await copyRepositoryFile(`packaging/plantilla/${name}`, path.join(stage, name));
  }
  await copyRepositoryFile('LICENSE', path.join(stage, 'Sistema', 'LICENCIA.txt'));
}

async function copyLaunchers(stage, modes, { windows, posix, mac }) {
  await copyRepositoryFile('packaging/iniciadores/arranque.cjs', path.join(stage,'Sistema','arranque.cjs'));
  if (windows) {
    await copyRepositoryFile('packaging/iniciadores/mind.cmd', path.join(stage, 'Sistema', 'mind.cmd'), { crlf: true });
    await copyRepositoryFile('packaging/iniciadores/Autorizar Mind.cmd', path.join(stage, 'Sistema', 'Autorizar Mind.cmd'), { crlf: true });
  }
  if (posix) {
    await copyRepositoryFile('packaging/iniciadores/mind', path.join(stage, 'Sistema', 'mind'), { mode: 0o755 });
    modes.set('Sistema/mind', 0o755);
  }
  if (mac) {
    await copyRepositoryFile('packaging/iniciadores/Autorizar Mind.command', path.join(stage, 'Sistema', 'Autorizar Mind.command'), { mode: 0o755 });
    modes.set('Sistema/Autorizar Mind.command', 0o755);
  }
}

async function copyRuntimeLicenses(runtime, licenses, components, id, prefix = 'Runtime') {
  await copyFile(path.join(runtime, 'node', 'LICENSE'), path.join(licenses, 'node.txt'));
  await copyFile(await findPythonLicense(runtime, TARGETS[id]), path.join(licenses, 'python.txt'));
  await fsp.writeFile(path.join(licenses, 'AVISOS.md'), noticesText(components, id, prefix), { flag: 'wx' });
}

async function stageRuntime(id, runtime, { components, cache, recordLinks }) {
  const target = TARGETS[id];
  process.stdout.write(`\n== ${id}\n`);
  const nodeArchive = await fetchComponent(components.node.plataformas[id], cache);
  const pythonArchive = await fetchComponent(components.python.plataformas[id], cache);
  return {
    nodeEntries: await extractNode(nodeArchive, runtime, target),
    pythonEntries: await extractPython(pythonArchive, runtime, target, recordLinks),
  };
}

function runtimeComponents(components, id) {
  return ['node', 'python'].map((name) => ({
    name, version: components[name].version,
    source: components[name].plataformas[id].url, sha256: components[name].plataformas[id].sha256,
  }));
}

/** Convierte los alias POSIX en archivos normales sin depender de enlaces NTFS. */
export async function materializeRuntimeLinks(directory, entries) {
  const files = new Map(entries.filter((entry) => entry.type === 'file').map((entry) => [entry.path, entry]));
  const materialized = [];
  for (const entry of entries) {
    if (entry.type !== 'symlink') {
      materialized.push(entry);
      continue;
    }
    const alias = safeRelativePath(entry.path);
    const target = alias && resolveLinkTarget(alias, entry.target);
    const original = target && safeRelativePath(target) && files.get(target);
    if (!original) fail(`El enlace ${entry.path} no apunta a un archivo regular del runtime.`);
    if (['bin/python', 'bin/python3'].includes(alias) && /^bin\/python3\.\d+$/u.test(target)) {
      const name = path.posix.basename(target);
      await fsp.writeFile(path.join(directory, ...alias.split('/')), `#!/bin/sh\nDIR=$(CDPATH= cd -P -- "$(dirname -- "$0")" && pwd -P) || exit 1\nexec "$DIR/${name}" "$@"\n`, { flag: 'wx', mode: 0o755 });
      materialized.push({ path: alias, type: 'file', mode: 0o755 });
    } else {
      await copyFile(path.join(directory, ...target.split('/')), path.join(directory, ...alias.split('/')), { mode: original.mode });
      materialized.push({ path: alias, type: 'file', mode: original.mode });
    }
  }
  return materialized;
}

async function archiveStage(stage, { recordedLinks = [], modes, metadata, destination, write, mtime, verifyMetadata, privateKey }) {
  // Manifiesto con la huella de cada archivo.
  const tree = [...await scanTree(stage), ...recordedLinks].sort((a, b) => compareBytes(a.path, b.path));
  const other = tree.filter((entry) => entry.type === 'other');
  if (other.length > 0) fail(`Tipos de archivo no admitidos en el paquete: ${other.map((entry) => entry.path).join(', ')}`);
  const files = {};
  const links = {};
  for (const entry of tree) {
    if (entry.type === 'file') files[entry.path] = await hashFile(path.join(stage, ...entry.path.split('/')));
    else links[entry.path] = entry.target;
  }
  const manifest = createPackageManifest({
    format: 'mind-product',
    version: 1,
    builtFrom: git(['rev-parse', 'HEAD']).trim(),
    ...metadata,
    packageRevision: metadata.packageRevision ?? 1, layoutVersion: 2, updateProtocolVersion: 2,
    files,
    links,
  });
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await fsp.writeFile(path.join(stage, ...MANIFEST_RELATIVE_PATH.split('/')), manifestBytes, { flag: 'wx' });
  const check = await verifyTree(stage, recordedLinks.length > 0 ? { ...manifest, links: {} } : manifest);
  if (!check.ok) fail(`La carpeta construida no coincide con su manifiesto: ${describeProblems(check.problems)}`);

  // Archivo reproducible: carpeta raíz «Mind», fecha fija y permisos normalizados.
  const entries = tree.map((entry) => (entry.type === 'symlink'
    ? { path: entry.path, type: 'symlink', target: entry.target }
    : { path: entry.path, type: 'file', mode: modes.get(entry.path) ?? 0o644, source: { file: path.join(stage, ...entry.path.split('/')) } }));
  entries.push({ path: MANIFEST_RELATIVE_PATH, type: 'file', source: { file: path.join(stage, ...MANIFEST_RELATIVE_PATH.split('/')) } });
  if (privateKey) {
    const { createSignedPackageDescriptor, PACKAGE_DESCRIPTOR_PATH } = await import('../src/package-descriptor.js');
    const descriptor = createSignedPackageDescriptor({ manifest, manifestBytes, privateKey });
    const descriptorFile = path.join(stage, ...PACKAGE_DESCRIPTOR_PATH.split('/'));
    await fsp.writeFile(descriptorFile, JSON.stringify(descriptor) + '\n', {flag:'wx',mode:0o644});
    entries.push({path:PACKAGE_DESCRIPTOR_PATH,type:'file',mode:0o644,source:{file:descriptorFile}});
  }
  const total = (await Promise.all(entries.map(async entry => entry.source?.file ? (await fsp.stat(entry.source.file)).size : 0))).reduce((a,b)=>a+b,0);
  if (entries.length > 4500 || total > Math.floor(1.10 * 1024 ** 3)) fail(`El paquete excede el presupuesto: ${entries.length} archivos, ${total} bytes.`);
  await fsp.rm(destination, { force: true });
  const written = await write(destination, entries, { root: 'My Mind', mtime });
  if (verifyMetadata) await verifyArchiveMetadata(destination, entries);
  const sha256 = await hashFile(destination);
  const size = (await fsp.stat(destination)).size;
  const name = path.basename(destination);
  process.stdout.write(`  ${name}: ${written.entries} entradas, ${(size / 1048576).toFixed(1)} MiB, sha256 ${sha256}\n`);
  return { name, sha256 };
}

async function stageTargetRuntime(stage, id, components, cache, modes) {
  const nodeDirectory = path.join(stage, 'Sistema', 'Componentes', 'Node', id);
  const pythonDirectory = path.join(stage, 'Sistema', 'Componentes', 'Python', id);
  const nodeArchive = await fetchComponent(components.node.plataformas[id], cache);
  const pythonArchive = await fetchComponent(components.python.plataformas[id], cache);
  const nodeEntries = await extractNode(nodeArchive, nodeDirectory, TARGETS[id], true);
  const pythonEntries = await extractPython(pythonArchive, pythonDirectory, TARGETS[id], true, true);
  const pythonFiles = await materializeRuntimeLinks(pythonDirectory, pythonEntries);
  for (const entry of nodeEntries) modes.set(`Sistema/Componentes/Node/${id}/${entry.path}`, entry.mode);
  for (const entry of pythonFiles) modes.set(`Sistema/Componentes/Python/${id}/${entry.path}`, entry.mode);
  const licenses = path.join(stage, 'Sistema', 'Licencias', id);
  await copyFile(path.join(nodeDirectory, 'LICENSE'), path.join(licenses, 'node.txt'));
  await copyFile(await findPythonLicense(pythonDirectory, TARGETS[id], true), path.join(licenses, 'python.txt'));
  await fsp.writeFile(path.join(licenses, 'AVISOS.md'), noticesText(components,id,`Sistema/Componentes/Python/${id}`), {flag:'wx'});
  return runtimeComponents(components,id).map(component => ({...component,target:id}));
}

async function buildTarget(id, { components, cache, output, mtime, version, keepStage, privateKey, packageRevision = 1 }) {
  const target = TARGETS[id];
  const work = path.join(output, '.construccion', id);
  await fsp.rm(work, {recursive:true,force:true});
  const stage = path.join(work,'My Mind');
  await copySharedFiles(stage);
  const modes = new Map();
  const manifestComponents = await stageTargetRuntime(stage,id,components,cache,modes);
  await copyLaunchers(stage,modes,{windows:target.platform==='win32',posix:target.platform!=='win32',mac:target.platform==='darwin'});
  await fsp.writeFile(path.join(stage,'.mcp.json'),mcpConfig(target),{flag:'wx'});
  const result = await archiveStage(stage, {modes,mtime,verifyMetadata:true,privateKey,
    metadata:{mindVersion:version,packageRevision,platform:target.platform,arch:target.arch,components:manifestComponents},
    destination:path.join(output,`Mind-${version}-${id}.${target.format}`),write:target.format==='zip'?writeZip:writeTarGz});
  if(!keepStage)await fsp.rm(work,{recursive:true,force:true});
  return result;
}

async function buildUniversal(targets, { components, cache, output, mtime, version, keepStage, privateKey, packageRevision = 1 }) {
  const work = await fsp.mkdtemp(path.join(output, '.mind-construccion-'));
  try {
    const stage = path.join(work, 'My Mind');
    const modes = new Map();
    const manifestComponents = [];
    await copySharedFiles(stage);
    await copyLaunchers(stage, modes, { windows: true, posix: true, mac: true });
    for (const id of targets) manifestComponents.push(...await stageTargetRuntime(stage,id,components,cache,modes));
    const notices = targets.map((id) => `- [${id}](${id}/AVISOS.md)`).join('\n');
    await fsp.writeFile(path.join(stage, 'Sistema', 'Licencias', 'AVISOS.md'), `# Componentes por plataforma\n\n${notices}\n`, { flag: 'wx' });

    const name = `Mind-${version}-universal-r${packageRevision}.zip`;
    const destination = path.join(work, name);
    const result = await archiveStage(stage, {
      modes, mtime, destination, write: writeZip, verifyMetadata: true, privateKey,
      // El destino primario conserva la compatibilidad con el actualizador Windows 1.0.1.
      metadata: { mindVersion: version, packageRevision, platform: 'win32', arch: 'x64', targets, components: manifestComponents },
    });
    await fsp.rename(destination, path.join(output, name));
    if (keepStage) process.stdout.write(`Carpeta de construcción: ${stage}\n`);
    return result;
  } finally {
    if (!keepStage) await fsp.rm(work, { recursive: true, force: true });
  }
}

async function main(argv) {
  const values = (flag) => argv.flatMap((value, index) => (argv[index - 1] === flag ? [value] : []));
  const output = path.resolve(values('--salida')[0] ?? path.join(ROOT, 'dist'));
  const cache = path.resolve(values('--cache')[0] ?? path.join(ROOT, '.cache', 'descargas'));
  const requested = values('--plataforma');
  const publication = JSON.parse(await fsp.readFile(path.join(PACKAGING, 'publicacion.json'), 'utf8'));
  if (publication.version !== 1 || publication.paquete !== 'universal' || !validUniversalTargets(publication.plataformas)) {
    fail('packaging/publicacion.json no describe el paquete universal completo.');
  }
  const targets = requested.length > 0 ? requested : publication.plataformas;
  for (const id of targets) if (!TARGETS[id]) fail(`Plataforma desconocida: ${id}. Opciones: ${Object.keys(TARGETS).join(', ')}`);

  const components = JSON.parse(await fsp.readFile(path.join(PACKAGING, 'componentes.json'), 'utf8'));
  if (components.formato !== 'mind-componentes' || components.version !== 1) fail('packaging/componentes.json no tiene el formato esperado.');
  const declared = JSON.parse(await fsp.readFile(path.join(ROOT, 'package.json'), 'utf8')).version;
  // --version-paquete: solo para probar "mind actualizar" con un segundo paquete real (CI).
  const version = values('--version-paquete')[0] ?? declared;
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) fail(`Versión no válida: ${version}`);
  const dirty = git(['status', '--porcelain', '--', ...MOTOR_PATHS, 'packaging', 'scripts/construir-paquetes.mjs', '.gitattributes']).trim();
  if (dirty) fail(`Hay cambios sin commit; registra el código antes de construir:\n${dirty}`);
  const mtime = Number(process.env.SOURCE_DATE_EPOCH ?? git(['log', '-1', '--format=%ct']).trim());
  if (!Number.isSafeInteger(mtime) || mtime <= 0) fail('SOURCE_DATE_EPOCH no es válido.');

  process.stdout.write(`Mind ${version} · commit ${git(['rev-parse', '--short', 'HEAD']).trim()} · fecha ${new Date(mtime * 1000).toISOString()}\n`);
  if (argv.includes('--sumas-oficiales')) await checkOfficialSums(components, targets);
  await fsp.mkdir(output, { recursive: true });
  const packageRevision = Number(values('--revision-paquete')[0] ?? 1);
  if(!Number.isSafeInteger(packageRevision)||packageRevision<1)fail('La revisión del paquete debe ser un entero positivo.');
  const privateKeyPath = values('--clave-publicacion')[0];
  const privateKey = privateKeyPath ? await fsp.readFile(path.resolve(privateKeyPath), 'utf8') : undefined;
  const options = { components, cache, output, mtime, version, privateKey, packageRevision, keepStage: argv.includes('--conservar-carpeta') };
  const built = [];
  if (requested.length === 0) built.push(await buildUniversal(targets, options));
  for (const id of requested) built.push(await buildTarget(id, options));
  const sums = built.sort((a, b) => compareBytes(a.name, b.name)).map((item) => `${item.sha256}  ${item.name}\n`).join('');
  await fsp.writeFile(path.join(output, 'SHA256SUMS'), sums);
  if (requested.length > 0 && !options.keepStage) await fsp.rm(path.join(output, '.construccion'), { recursive: true, force: true }).catch(() => {});
  process.stdout.write(`\nPaquetes en ${output}\n${sums}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`Error: ${error?.message ?? error}\n`);
    process.exitCode = 1;
  });
}
