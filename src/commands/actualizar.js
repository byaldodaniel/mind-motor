import { runUpdateTransaction } from '../update-transaction.js';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { MotorError } from '../errors.js';
import { readJson } from '../storage.js';
import { BASE_MARKER } from '../base-format.js';
import { liveSessions } from '../session.js';
import { requireInteractive, createPrompter } from '../console.js';
import { readArchive, extractEntries, compareBytes } from '../archive.js';
import { productRuntime, productPaths } from '../layout.js';
import {
  MANIFEST_NAME, readManifestFile, verifyTree, describeProblems, compareVersions, supportsProductTarget,
} from '../product-files.js';

/** Actualización verificada con diario durable, espera de sesiones y recuperación solo temporal.
 * Nunca sustituye los datos persistentes ni conserva revisiones anteriores tras confirmar.
 */
/** Carpetas que pertenecen por completo al paquete y se sustituyen enteras. */
export const OWNED_DIRECTORIES = Object.freeze(['Motor', 'Runtime', 'LICENCIAS']);
const LOCK_NAME = '.mind-actualizacion.lock';
const STAGING_PREFIX = '.mind-actualizacion-';

const fail = (code, message, options) => new MotorError(code, message, options);
const native = (root, relative) => path.join(root, ...relative.split('/'));

async function exists(target) {
  try {
    await fsp.lstat(target);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** Resuelve enlaces incluso cuando la Base o el destino aún no existen. */
async function physicalPath(target) {
  try {
    return await fsp.realpath(target);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = path.dirname(target);
    if (parent === target) throw error;
    return path.join(await physicalPath(parent), path.basename(target));
  }
}

async function protectBase(root, baseDirectory, items) {
  const physicalRoot = await physicalPath(path.resolve(root));
  const base = await physicalPath(path.resolve(baseDirectory));
  if (inside(base, physicalRoot)) {
    throw fail('UPDATE_BASE_OVERLAP', 'La Base no puede contener la instalación que se actualiza.');
  }
  for (const item of items) {
    const target = await physicalPath(native(physicalRoot, item));
    if (inside(target, base) || inside(base, target)) {
      throw fail('UPDATE_BASE_OVERLAP', `La Base se solapa con ${item}, que se sustituye al actualizar. No se modifica nada.`);
    }
  }
}

/** Elementos que gestiona el paquete: carpetas propias enteras y archivos sueltos del manifiesto. */
function managedItems(...manifests) {
  const files = new Set();
  for (const manifest of manifests) {
    for (const relative of [...Object.keys(manifest.files), ...Object.keys(manifest.links ?? {})]) {
      if (!OWNED_DIRECTORIES.includes(relative.split('/')[0])) files.add(relative);
    }
  }
  return [...OWNED_DIRECTORIES, ...[...files].sort(compareBytes)];
}

/** true si la ruta es una carpeta que solo contiene carpetas vacías. */
async function emptyTree(directory) {
  const info = await fsp.lstat(directory).catch(() => null);
  if (!info?.isDirectory()) return false;
  for (const name of await fsp.readdir(directory)) {
    if (!(await emptyTree(path.join(directory, name)))) return false;
  }
  return true;
}

/**
 * Mueve un archivo o carpeta. En Windows no se puede renombrar una carpeta que
 * contiene el programa en ejecución (el Node de esta misma orden); en ese caso
 * se mueve su contenido elemento a elemento (un ejecutable en uso sí puede
 * renombrarse). Si el destino es una carpeta vacía que no se deja borrar, se
 * mueve el contenido dentro de ella.
 */
export async function moveEntry(from, to, options = {}) {
  const { rename = fsp.rename, platform = process.platform } = options;
  if (await exists(to)) {
    if (!(await emptyTree(to))) throw fail('UPDATE_TARGET_EXISTS', `Ya existe ${to}; no se sobrescribe.`);
    const removed = await fsp.rm(to, { recursive: true }).then(() => true, () => false);
    if (!removed) return mergeInto(from, to, options);
  }
  try {
    await rename(from, to);
  } catch (error) {
    if (platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
    if (!(await fsp.lstat(from)).isDirectory()) throw error;
    await mergeInto(from, to, options);
  }
  return undefined;
}

async function mergeInto(from, to, options) {
  if (!(await fsp.lstat(from)).isDirectory()) throw fail('UPDATE_TARGET_EXISTS', `Ya existe ${to}; no se sobrescribe.`);
  await fsp.mkdir(to, { recursive: true });
  for (const name of await fsp.readdir(from)) await moveEntry(path.join(from, name), path.join(to, name), options);
  // Vacía; si Windows no deja borrarla ahora, se queda vacía y no estorba.
  await fsp.rmdir(from).catch(() => {});
}

async function copyVerified(sourceFile, destination, expected) {
  const hash = createHash('sha256');
  const info = await fsp.stat(sourceFile);
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  const handle = await fsp.open(destination, 'wx', info.mode & 0o111 ? 0o755 : 0o644);
  try {
    // Copia por flujo: no arrastra atributos extendidos (como la cuarentena de macOS).
    for await (const chunk of fs.createReadStream(sourceFile)) {
      hash.update(chunk);
      await handle.write(chunk);
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex') === expected;
}

/** Copia del paquete en la carpeta de preparación, ya verificada. Devuelve { tree, manifest }. */
export async function prepare(source, staging, report) {
  const info = await fsp.stat(source).catch(() => null);
  if (!info) throw fail('UPDATE_SOURCE_NOT_FOUND', `No se encuentra el paquete: ${source}`);
  const tree = path.join(staging, 'paquete');
  if (info.isDirectory()) {
    const manifest = await readManifestFile(source);
    if (!manifest) throw fail('UPDATE_PACKAGE_INVALID', 'La carpeta indicada no contiene mind-producto.json: no es un paquete de Mind.');
    report(`Copiando y verificando ${Object.keys(manifest.files).length} archivos…`);
    const problems = [];
    for (const [relative, hash] of Object.entries(manifest.files)) {
      const from = native(source, relative);
      const entry = await fsp.lstat(from).catch(() => null);
      if (!entry?.isFile()) {
        problems.push({ path: relative, problem: entry ? 'tipo' : 'falta' });
        continue;
      }
      if (!(await copyVerified(from, native(tree, relative), hash))) problems.push({ path: relative, problem: 'distinto' });
    }
    for (const [relative, target] of Object.entries(manifest.links)) {
      const actual = await fsp.readlink(native(source, relative)).catch(() => null);
      if (actual !== target) {
        problems.push({ path: relative, problem: actual === null ? 'falta' : 'distinto' });
        continue;
      }
      if (process.platform === 'win32') throw fail('UPDATE_PACKAGE_INVALID', 'El paquete contiene enlaces simbólicos, que no se admiten en Windows.');
      await fsp.mkdir(path.dirname(native(tree, relative)), { recursive: true });
      await fsp.symlink(target, native(tree, relative));
    }
    if (problems.length > 0) {
      throw fail('UPDATE_PACKAGE_ALTERED', `El paquete no coincide con su manifiesto: ${describeProblems(problems)}.`);
    }
    const mf = productPaths(source, manifest).manifestFile;
    await fsp.mkdir(path.dirname(productPaths(tree, manifest).manifestFile), { recursive: true });
    await fsp.copyFile(mf, productPaths(tree, manifest).manifestFile);
    if (manifest.layoutVersion === 2) {
      await fsp.copyFile(path.join(source, 'Sistema', 'entrega-firmada.json'), path.join(tree, 'Sistema', 'entrega-firmada.json')).catch(error => { if(error.code !== 'ENOENT') throw error; });
    }
    return { tree, manifest };
  }
  report('Extrayendo y verificando el paquete…');
  const extracted = path.join(staging, 'extraido');
  await extractEntries(readArchive(source), extracted);
  // El paquete trae una carpeta raíz Mind-<versión>-<plataforma>-<arquitectura>/.
  let root = extracted;
  if (!(await readManifestFile(extracted))) {
    const names = await fsp.readdir(extracted);
    if (names.length !== 1 || !(await readManifestFile(path.join(extracted, names[0])))) {
      throw fail('UPDATE_PACKAGE_INVALID', 'El archivo no contiene un paquete de Mind (falta mind-producto.json).');
    }
    root = path.join(extracted, names[0]);
  }
  const manifest = await readManifestFile(root);
  const verified = await verifyTree(root, manifest);
  if (!verified.ok) throw fail('UPDATE_PACKAGE_ALTERED', `El paquete no coincide con su manifiesto: ${describeProblems(verified.problems)}.`);
  await fsp.rename(root, tree);
  return { tree, manifest };
}

/** Formato de Base que admite el Motor nuevo: del manifiesto o, si falta, leído (sin ejecutarlo) de su base-format.js. */
async function supportedBaseFormat(tree, manifest) {
  if (Number.isSafeInteger(manifest.baseFormatVersion)) return manifest.baseFormatVersion;
  const text = await fsp.readFile(path.join(productPaths(tree, manifest).motorDirectory, 'src', 'base-format.js'), 'utf8').catch(() => '');
  const match = /export const BASE_FORMAT_VERSION\s*=\s*(\d+)\s*;/u.exec(text);
  if (!match) throw fail('UPDATE_BASE_UNKNOWN', 'No se puede comprobar qué formato de Base admite el paquete nuevo; no se actualiza.');
  return Number(match[1]);
}

async function baseFormat(baseDirectory) {
  const stored = await readJson(path.join(baseDirectory, BASE_MARKER)).catch((error) => {
    if (error.code === 'ENOTDIR') return null;
    throw error;
  });
  if (stored === null) return null;
  const data = stored.data;
  if (!data || data.format !== 'mind-base' || !Number.isSafeInteger(data.version)) {
    throw fail('BASE_MARKER_CORRUPT', 'La marca de formato de la Base no es válida; no se actualiza.');
  }
  return data.version;
}

/** Comprobación tras sustituir: el Mind nuevo arranca con su propio Node y declara la versión esperada. */
export function smokeTest(root, manifest) {
  const { nodeExecutable } = productRuntime(root, manifest);
  return new Promise((resolve, reject) => {
    const env = { ...process.env, NODE_OPTIONS: '' };
    delete env.MIND_BASE;
    delete env.MIND_PYTHON;
    const child = spawn(nodeExecutable, [path.join(productPaths(root, manifest).motorDirectory, 'bin', 'mind.js'), 'version'], {
      cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let output = '';
    const timer = setTimeout(() => child.kill(), 60_000);
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.resume();
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(fail('UPDATE_CHECK_FAILED', `El Mind nuevo no arranca: ${error.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      let data = null;
      try {
        data = JSON.parse(output);
      } catch {
        // Se informa abajo.
      }
      if (code !== 0 || data?.mind !== manifest.mindVersion || data?.producto !== true) {
        reject(fail('UPDATE_CHECK_FAILED', `El Mind nuevo no arrancó como se esperaba (código ${code}).`));
      } else {
        resolve(data);
      }
    });
  });
}

function describeSummary(summary) {
  const lines = [
    `Actualización de Mind: ${summary.from} → ${summary.to} (${summary.platform}).`,
    `Paquete verificado: ${summary.files} archivos coinciden con su manifiesto (SHA-256).`,
  ];
  if (summary.downgrade) lines.push('Atención: el paquete es una versión ANTERIOR a la instalada (--forzar).');
  if (summary.reinstall) lines.push('Es la misma versión: se reinstalará.');
  lines.push('Se actualizan el programa, los componentes que cambiaron y las entradas administradas de Mind.');
  lines.push(`La Base (${summary.base}) se conserva. La recuperación temporal se retira tras verificar la entrega.`);
  return lines;
}

/** Orden de consola (interactiva). */
export async function run({ parameters, layout, print }) {
  const flags = parameters.filter((item) => item.startsWith('--'));
  const positional = parameters.filter((item) => !item.startsWith('--'));
  const unknown = flags.filter((item) => item !== '--forzar');
  if (unknown.length > 0 || positional.length !== 1) {
    throw fail('INVALID_ARGUMENTS', 'Uso: mind actualizar <paquete.zip|paquete.tar.gz|carpeta> [--forzar]');
  }
  requireInteractive();
  const installed = await layout();
  if (!installed.product) throw fail('NOT_PRODUCT', '"mind actualizar" solo funciona en la carpeta de Mind del paquete (con mind-producto.json).');
  const prompt = createPrompter();
  try {
    prompt.write(`Mind ${installed.manifest.mindVersion} en ${installed.root}`);
    const result = await updateMind({
      root: installed.root,
      source: positional[0],
      baseDirectory: installed.baseDirectory,
      force: flags.includes('--forzar'),
      report: (line) => prompt.write(line),
      confirm: async (summary) => {
        for (const line of describeSummary(summary)) prompt.write(line);
        return prompt.yes('¿Actualizar Mind?', false);
      },
    });
    if (result.status === 'cancelada') {
      print('No se actualizó nada.');
    } else {
      print(result.status === 'pendiente' ? 'Actualización preparada; espera el cierre seguro de las sesiones.' : `Listo: Mind ${result.to}. ${result.cleanupPending ? 'Limpieza pendiente; se retomará sin acumular otra instalación.' : 'Una sola instalación vigente; temporales retirados.'}`);
    }
  } finally {
    prompt.close();
  }
  return 0;
}


export async function updateMind(options) {
  return runUpdateTransaction(options, { prepare, protectBase, supportedBaseFormat, baseFormat, smokeTest, moveEntry });
}
