#!/usr/bin/env node
// Construye los paquetes portables de Mind para Windows, macOS y Linux.
//
//   node scripts/construir-paquetes.mjs [--plataforma <id> ...] [--salida <carpeta>]
//                                       [--cache <carpeta>] [--sumas-oficiales] [--conservar-carpeta]
//
// Plataformas: linux-x64, linux-arm64, darwin-arm64, darwin-x64, win32-x64 (por
// defecto, todas). Cada paquete contiene la carpeta Mind/ con el Motor, Node.js y
// CPython portables, los iniciadores, la configuración MCP de Claude Code, las
// instrucciones para agentes, la documentación mínima, las licencias y el
// manifiesto mind-producto.json con el SHA-256 de cada archivo. Nunca contiene
// una Base: se crea en el primer uso.
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
import { readArchive, extractEntries, writeTarGz, writeZip, compareBytes } from '../src/archive.js';
import { hashFile, scanTree, validateManifest, verifyTree, describeProblems, MANIFEST_NAME } from '../src/product-files.js';
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
const MOTOR_PATHS = ['bin', 'src', 'package.json', 'LICENSE', 'docs/PRODUCTO.md'];

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

/** Flujo descomprimido de un .tar.xz con el xz del sistema que construye (Node no incluye xz). */
function decompressXz(file) {
  const child = spawn('xz', ['-dc', file], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('close', (code) => {
    if (code !== 0) child.stdout.destroy(new Error(`xz terminó con código ${code}: ${stderr.trim()}`));
  });
  child.on('error', (error) => child.stdout.destroy(error));
  return child.stdout;
}

/** Node.js: solo el ejecutable y su licencia (sin npm ni cabeceras). */
async function extractNode(file, stage, target) {
  const keep = target.platform === 'win32' ? new Set(['node.exe', 'LICENSE']) : new Set(['bin/node', 'LICENSE']);
  const extracted = await extractEntries(readArchive(file, { decompressXz }), path.join(stage, 'Runtime', 'node'), {
    map: (name, entry) => {
      const inner = name.split('/').slice(1).join('/');
      return entry.type !== 'directory' && keep.has(inner) ? inner : null;
    },
  });
  const found = new Set(extracted.filter((entry) => entry.type === 'file').map((entry) => entry.path));
  for (const name of keep) if (!found.has(name)) fail(`El archivo de Node no contiene ${name}.`);
}

/** CPython de python-build-standalone (install_only_stripped): su carpeta python/ completa. */
async function extractPython(file, stage, target) {
  const extracted = await extractEntries(readArchive(file), path.join(stage, 'Runtime', 'python'), {
    // share/terminfo (bases de datos de terminales para curses) no lo usa Mind y
    // contiene nombres que solo difieren en mayúsculas: chocan en macOS y Windows.
    map: (name) => (name.startsWith('python/') && !name.startsWith('python/share/terminfo/') ? name.slice('python/'.length) : null),
    links: target.platform === 'win32' ? 'record' : 'create',
  });
  const interpreter = target.platform === 'win32' ? 'python.exe' : 'bin/python3';
  if (!extracted.some((entry) => entry.path === interpreter)) fail(`El archivo de Python no contiene ${interpreter}.`);
  if (target.platform === 'win32' && extracted.some((entry) => entry.type === 'symlink')) {
    fail('El Python de Windows contiene enlaces simbólicos, que el paquete zip no admite.');
  }
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

/** Configuración MCP de proyecto para Claude Code: rutas relativas a la carpeta de Mind. */
function mcpConfig(target) {
  const windows = target.platform === 'win32';
  return `${JSON.stringify({
    mcpServers: {
      mind: {
        type: 'stdio',
        command: windows ? 'Runtime\\node\\node.exe' : 'Runtime/node/bin/node',
        args: [windows ? 'Motor\\bin\\mind.js' : 'Motor/bin/mind.js', 'mcp'],
        // Opciones de Node del usuario no deben alterar el Motor.
        env: { NODE_OPTIONS: '' },
      },
    },
  }, null, 2)}\n`;
}

function noticesText(components, id) {
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
se incluye la carpeta \`python/\` completa en \`Runtime/python\`.

La integridad de estos archivos se comprobó con su SHA-256 antes de empaquetarlos
y cada archivo del paquete figura con su huella en \`mind-producto.json\`. Eso
demuestra que el paquete no cambió desde su construcción; no es una garantía de
seguridad de los propios componentes.
`;
}

async function findPythonLicense(stage, target) {
  const candidates = target.platform === 'win32'
    ? ['Runtime/python/LICENSE.txt']
    : ['Runtime/python/lib/python3.12/LICENSE.txt'];
  for (const relative of candidates) {
    const file = path.join(stage, ...relative.split('/'));
    if (fs.existsSync(file)) return file;
  }
  fail('No se encontró la licencia de CPython en el Python incluido.');
}

async function buildTarget(id, { components, cache, output, mtime, version, keepStage }) {
  const target = TARGETS[id];
  process.stdout.write(`\n== ${id}\n`);
  const nodeArchive = await fetchComponent(components.node.plataformas[id], cache);
  const pythonArchive = await fetchComponent(components.python.plataformas[id], cache);

  const work = path.join(output, '.construccion', id);
  await fsp.rm(work, { recursive: true, force: true });
  const stage = path.join(work, 'Mind');
  await fsp.mkdir(stage, { recursive: true });

  // Motor: archivos versionados (sin pruebas, scripts ni Bases de desarrollo).
  const tracked = git(['ls-files', '-z', '--', ...MOTOR_PATHS]).split('\0').filter(Boolean);
  if (tracked.length === 0) fail('No hay archivos del Motor versionados.');
  for (const relative of tracked) {
    await copyFile(path.join(ROOT, ...relative.split('/')), path.join(stage, 'Motor', ...relative.split('/')));
  }

  await extractNode(nodeArchive, stage, target);
  await extractPython(pythonArchive, stage, target);

  // Documentación, instrucciones para agentes e iniciadores.
  for (const name of ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', 'LEEME.md']) {
    await copyFile(path.join(PACKAGING, 'plantilla', name), path.join(stage, name));
  }
  const launchers = path.join(PACKAGING, 'iniciadores');
  if (target.platform === 'win32') {
    await copyFile(path.join(launchers, 'mind.cmd'), path.join(stage, 'mind.cmd'), { crlf: true });
    await copyFile(path.join(launchers, 'Autorizar Mind.cmd'), path.join(stage, 'Autorizar Mind.cmd'), { crlf: true });
  } else {
    await copyFile(path.join(launchers, 'mind'), path.join(stage, 'mind'), { mode: 0o755 });
    if (target.platform === 'darwin') {
      await copyFile(path.join(launchers, 'Autorizar Mind.command'), path.join(stage, 'Autorizar Mind.command'), { mode: 0o755 });
    }
  }
  await fsp.writeFile(path.join(stage, '.mcp.json'), mcpConfig(target), { flag: 'wx' });

  // Licencias.
  await copyFile(path.join(ROOT, 'LICENSE'), path.join(stage, 'LICENCIA.txt'));
  await copyFile(path.join(stage, 'Runtime', 'node', 'LICENSE'), path.join(stage, 'LICENCIAS', 'node.txt'));
  await copyFile(await findPythonLicense(stage, target), path.join(stage, 'LICENCIAS', 'python.txt'));
  await fsp.writeFile(path.join(stage, 'LICENCIAS', 'AVISOS.md'), noticesText(components, id), { flag: 'wx' });

  // Manifiesto con la huella de cada archivo.
  const tree = await scanTree(stage);
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
    mindVersion: version,
    platform: target.platform,
    arch: target.arch,
    builtFrom: git(['rev-parse', 'HEAD']).trim(),
    components: [
      { name: 'node', version: components.node.version, source: components.node.plataformas[id].url, sha256: components.node.plataformas[id].sha256 },
      { name: 'python', version: components.python.version, source: components.python.plataformas[id].url, sha256: components.python.plataformas[id].sha256 },
    ],
    files,
    links,
  });
  await fsp.writeFile(path.join(stage, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  const check = await verifyTree(stage, manifest);
  if (!check.ok) fail(`La carpeta construida no coincide con su manifiesto: ${describeProblems(check.problems)}`);

  // Archivo reproducible: carpeta raíz «Mind», fecha fija y permisos normalizados.
  const entries = (await scanTree(stage)).map((entry) => (entry.type === 'symlink'
    ? { path: entry.path, type: 'symlink', target: entry.target }
    : { path: entry.path, type: 'file', mode: entry.mode, source: { file: path.join(stage, ...entry.path.split('/')) } }));
  const name = `Mind-${version}-${id}.${target.format}`;
  const destination = path.join(output, name);
  await fsp.rm(destination, { force: true });
  const write = target.format === 'zip' ? writeZip : writeTarGz;
  const written = await write(destination, entries, { root: 'Mind', mtime });
  const sha256 = await hashFile(destination);
  const size = (await fsp.stat(destination)).size;
  process.stdout.write(`  ${name}: ${written.entries} entradas, ${(size / 1048576).toFixed(1)} MiB, sha256 ${sha256}\n`);
  if (!keepStage) await fsp.rm(work, { recursive: true, force: true });
  return { id, name, sha256, size, files: Object.keys(files).length, links: Object.keys(links).length };
}

async function main(argv) {
  const values = (flag) => argv.flatMap((value, index) => (argv[index - 1] === flag ? [value] : []));
  const output = path.resolve(values('--salida')[0] ?? path.join(ROOT, 'dist'));
  const cache = path.resolve(values('--cache')[0] ?? path.join(ROOT, '.cache', 'descargas'));
  const requested = values('--plataforma');
  const targets = requested.length > 0 ? requested : Object.keys(TARGETS);
  for (const id of targets) if (!TARGETS[id]) fail(`Plataforma desconocida: ${id}. Opciones: ${Object.keys(TARGETS).join(', ')}`);

  const components = JSON.parse(await fsp.readFile(path.join(PACKAGING, 'componentes.json'), 'utf8'));
  if (components.formato !== 'mind-componentes' || components.version !== 1) fail('packaging/componentes.json no tiene el formato esperado.');
  const declared = JSON.parse(await fsp.readFile(path.join(ROOT, 'package.json'), 'utf8')).version;
  // --version-paquete: solo para probar "mind actualizar" con un segundo paquete real (CI).
  const version = values('--version-paquete')[0] ?? declared;
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) fail(`Versión no válida: ${version}`);
  const dirty = git(['status', '--porcelain', '--', ...MOTOR_PATHS, 'packaging']).trim();
  if (dirty) process.stdout.write(`Aviso: hay cambios sin commit en el Motor o en packaging; el paquete no será reproducible desde el commit:\n${dirty}\n`);
  const mtime = Number(process.env.SOURCE_DATE_EPOCH ?? git(['log', '-1', '--format=%ct']).trim());
  if (!Number.isSafeInteger(mtime) || mtime <= 0) fail('SOURCE_DATE_EPOCH no es válido.');

  process.stdout.write(`Mind ${version} · commit ${git(['rev-parse', '--short', 'HEAD']).trim()} · fecha ${new Date(mtime * 1000).toISOString()}\n`);
  if (argv.includes('--sumas-oficiales')) await checkOfficialSums(components, targets);
  await fsp.mkdir(output, { recursive: true });
  const built = [];
  for (const id of targets) {
    built.push(await buildTarget(id, { components, cache, output, mtime, version, keepStage: argv.includes('--conservar-carpeta') }));
  }
  const sums = built.sort((a, b) => compareBytes(a.name, b.name)).map((item) => `${item.sha256}  ${item.name}\n`).join('');
  await fsp.writeFile(path.join(output, 'SHA256SUMS'), sums);
  if (!argv.includes('--conservar-carpeta')) await fsp.rm(path.join(output, '.construccion'), { recursive: true, force: true }).catch(() => {});
  process.stdout.write(`\nPaquetes en ${output}\n${sums}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`Error: ${error?.message ?? error}\n`);
    process.exitCode = 1;
  });
}
