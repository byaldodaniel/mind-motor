import { lockInstallation } from '../installation-lock.js';
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
import {
  MANIFEST_NAME, readManifestFile, verifyTree, describeProblems, compareVersions,
} from '../product-files.js';

/**
 * `mind actualizar <paquete.zip|.tar.gz|carpeta> [--forzar]`
 *
 * Sustituye Motor/, Runtime/, iniciadores, configuraciones y documentación
 * por los de un paquete nuevo y nunca toca Base/:
 *
 * 1. exige que no haya sesiones de Mind vivas sobre la Base;
 * 2. prepara al lado (dentro de la carpeta de Mind) una copia del paquete y
 *    verifica su manifiesto y el SHA-256 de cada archivo;
 * 3. exige la misma plataforma y arquitectura, rechaza bajar de versión salvo
 *    --forzar y comprueba que el Motor nuevo admite el formato de la Base;
 * 4. tras la confirmación del usuario, renombra lo anterior a
 *    .anterior-<versión>/ y coloca lo nuevo; comprueba que el Mind nuevo
 *    arranca (`mind version`) y, si algo falla, vuelve atrás.
 *
 * Todos los módulos necesarios se importan antes de sustituir Motor/: después
 * no se carga ningún archivo del Motor anterior.
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
async function prepare(source, staging, report) {
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
    await fsp.copyFile(path.join(source, MANIFEST_NAME), path.join(tree, MANIFEST_NAME));
    return { tree, manifest };
  }
  report('Extrayendo y verificando el paquete…');
  const extracted = path.join(staging, 'extraido');
  await extractEntries(readArchive(source), extracted);
  // El paquete trae una carpeta raíz Mind-<versión>-<plataforma>-<arquitectura>/.
  let root = extracted;
  if (!(await exists(path.join(extracted, MANIFEST_NAME)))) {
    const names = await fsp.readdir(extracted);
    if (names.length !== 1 || !(await exists(path.join(extracted, names[0], MANIFEST_NAME)))) {
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
  const text = await fsp.readFile(path.join(tree, 'Motor', 'src', 'base-format.js'), 'utf8').catch(() => '');
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

async function requireNoSessions(baseDirectory, root) {
  const baseSessions = await liveSessions(baseDirectory);
  const installationSessions = await liveSessions(path.join(root, '.mind-producto'));
  const live = [...new Map([...baseSessions.live, ...installationSessions.live].map(entry => [entry.id, entry])).values()];
  const stale = [...baseSessions.stale, ...installationSessions.stale];
  if (live.length > 0) {
    throw fail('MIND_IN_USE', `Hay ${live.length} sesión(es) de Mind abiertas (agentes u órdenes en otra ventana). Ciérralas y vuelve a intentarlo.${stale.length > 0 ? ' Si un agente se cerró de forma abrupta, "mind reparar" limpia las sesiones abandonadas.' : ''}`);
  }
}

/** Bloqueo de la carpeta de Mind durante la actualización; recupera el de un proceso que ya terminó. */
async function lock(root) {
  const file = path.join(root, LOCK_NAME);
  const content = `${JSON.stringify({ pid: process.pid, host: os.hostname(), startedAt: new Date().toISOString() })}\n`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await fsp.writeFile(file, content, { flag: 'wx', mode: 0o600 });
      return () => fsp.rm(file, { force: true });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let data = {};
      try {
        data = JSON.parse(await fsp.readFile(file, 'utf8'));
      } catch {
        // Ilegible: se trata como abandonado.
      }
      let alive = data.host !== os.hostname();
      if (!alive && Number.isSafeInteger(data.pid)) {
        try {
          process.kill(data.pid, 0);
          alive = true;
        } catch (failure) {
          alive = failure.code === 'EPERM';
        }
      }
      if (alive) throw fail('UPDATE_IN_PROGRESS', 'Ya hay una actualización de Mind en curso en esta carpeta.');
      await fsp.rm(file, { force: true });
    }
  }
  throw fail('UPDATE_IN_PROGRESS', 'No se pudo bloquear la carpeta de Mind para actualizar.');
}

async function uniqueDirectory(root, name) {
  for (let index = 1; ; index += 1) {
    const candidate = path.join(root, index === 1 ? name : `${name}-${index}`);
    try {
      await fsp.mkdir(candidate);
      return candidate;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
}

/** Comprobación tras sustituir: el Mind nuevo arranca con su propio Node y declara la versión esperada. */
export function smokeTest(root, manifest) {
  const node = process.platform === 'win32'
    ? path.join(root, 'Runtime', 'node', 'node.exe')
    : path.join(root, 'Runtime', 'node', 'bin', 'node');
  return new Promise((resolve, reject) => {
    const env = { ...process.env, NODE_OPTIONS: '' };
    delete env.MIND_BASE;
    delete env.MIND_PYTHON;
    const child = spawn(node, [path.join(root, 'Motor', 'bin', 'mind.js'), 'version'], {
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

/**
 * Actualiza la carpeta de Mind `root` con el paquete `source`.
 *
 * @param {object} options
 * @param {string} options.root Carpeta de Mind instalada (con mind-producto.json).
 * @param {string} options.source Paquete .zip/.tar.gz o carpeta extraída.
 * @param {string} options.baseDirectory Base cuyas sesiones y formato se comprueban (no se modifica).
 * @param {(summary: object) => Promise<boolean> | boolean} options.confirm Confirmación del usuario.
 * @param {boolean} [options.force] Permite bajar de versión.
 * @param {(line: string) => void} [options.report]
 * @param {(root: string, manifest: object) => Promise<unknown>} [options.verifyInstalled]
 * @param {{ rename?: Function, platform?: string, afterMove?: Function }} [options.testing] Solo para pruebas.
 */
async function updateMindUnlocked({
  root, source, baseDirectory, confirm, force = false, report = () => {}, verifyInstalled = smokeTest, testing = {},
}) {
  const current = await readManifestFile(root);
  if (!current) throw fail('NOT_PRODUCT', '"mind actualizar" solo funciona en la carpeta de Mind del paquete (con mind-producto.json).');
  const sourcePath = path.resolve(source);
  if (inside(root, sourcePath) || inside(sourcePath, root)) {
    throw fail('UPDATE_SOURCE_INVALID', 'El paquete nuevo debe estar fuera de la carpeta de Mind que se actualiza.');
  }
  // --base admite ubicaciones personalizadas: ninguna puede quedar entre los
  // elementos que se apartan o sustituyen, tampoco a través de un enlace.
  await protectBase(root, baseDirectory, [...managedItems(current), MANIFEST_NAME]);
  await requireNoSessions(baseDirectory, root);
  const unlock = await lock(root);
  const staging = await fsp.mkdtemp(path.join(root, STAGING_PREFIX));
  const moves = { aside: [], placed: [] };
  let backup = null;
  let restoreSignals = null;
  const move = (from, to) => moveEntry(from, to, { rename: testing.rename, platform: testing.platform });
  try {
    const { tree, manifest: incoming } = await prepare(sourcePath, staging, report);
    await protectBase(root, baseDirectory, [...managedItems(current, incoming), MANIFEST_NAME]);
    if (incoming.platform !== current.platform || incoming.arch !== current.arch) {
      throw fail('UPDATE_PLATFORM_MISMATCH', `El paquete es para ${incoming.platform}-${incoming.arch} y esta instalación es ${current.platform}-${current.arch}.`);
    }
    const order = compareVersions(incoming.mindVersion, current.mindVersion);
    if (order < 0 && !force) {
      throw fail('UPDATE_DOWNGRADE', `El paquete (${incoming.mindVersion}) es anterior a la versión instalada (${current.mindVersion}). Usa --forzar si de verdad quieres volver a esa versión.`);
    }
    const supported = await supportedBaseFormat(tree, incoming);
    const stored = await baseFormat(baseDirectory);
    if (stored !== null && stored > supported) {
      throw fail('UPDATE_BASE_INCOMPATIBLE', `La Base usa el formato ${stored} y el Mind ${incoming.mindVersion} solo admite hasta el ${supported}. No se actualiza: la Base no se modifica.`);
    }
    const backupName = `.anterior-${current.mindVersion.replace(/[^0-9A-Za-z.+-]/gu, '_')}`;
    const summary = {
      from: current.mindVersion, to: incoming.mindVersion, platform: `${current.platform}-${current.arch}`,
      files: Object.keys(incoming.files).length, downgrade: order < 0, reinstall: order === 0,
      base: stored === null ? 'sin crear' : `formato ${stored}`, supportedBase: supported, backup: backupName,
    };
    if (!(await confirm(summary))) return { status: 'cancelada', ...summary };
    await requireNoSessions(baseDirectory, root);

    // Sustitución: un Ctrl+C a mitad dejaría la carpeta incompleta, así que se pospone.
    const deferred = () => {};
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, deferred);
    restoreSignals = () => {
      for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.removeListener(signal, deferred);
    };
    backup = await uniqueDirectory(root, backupName);
    const items = [...managedItems(current, incoming), MANIFEST_NAME];
    for (const item of items) {
      const live = native(root, item);
      if (!(await exists(live))) continue;
      const aside = native(backup, item);
      await fsp.mkdir(path.dirname(aside), { recursive: true });
      await move(live, aside);
      moves.aside.push({ live, aside });
      await testing.afterMove?.('aside', item);
    }
    for (const item of items) {
      const fresh = native(tree, item);
      if (!(await exists(fresh))) continue;
      const live = native(root, item);
      await fsp.mkdir(path.dirname(live), { recursive: true });
      await move(fresh, live);
      moves.placed.push({ live, fresh });
      await testing.afterMove?.('placed', item);
    }
    report('Comprobando que el Mind nuevo arranca…');
    await verifyInstalled(root, incoming);
    restoreSignals();
    restoreSignals = null;
    return { status: 'actualizada', ...summary, backup: path.basename(backup) };
  } catch (error) {
    if (moves.aside.length > 0 || moves.placed.length > 0) {
      const problems = [];
      for (const { live, fresh } of moves.placed.reverse()) {
        await move(live, fresh).catch((failure) => problems.push(`${live}: ${failure.message}`));
      }
      for (const { live, aside } of moves.aside.reverse()) {
        await fsp.mkdir(path.dirname(live), { recursive: true }).catch(() => {});
        await move(aside, live).catch((failure) => problems.push(`${live}: ${failure.message}`));
      }
      if (problems.length > 0) {
        throw fail('UPDATE_ROLLBACK_FAILED', `La actualización falló (${error.message}) y no se pudo restaurar todo. Lo anterior sigue en ${backup}. Detalles: ${problems.slice(0, 3).join('; ')}`, { cause: error });
      }
      error.message = `${error.message} Se restauró la versión anterior.`;
    }
    if (backup && (await emptyTree(backup))) await fsp.rm(backup, { recursive: true, force: true });
    throw error;
  } finally {
    restoreSignals?.();
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
    await unlock();
  }
}

function describeSummary(summary) {
  const lines = [
    `Actualización de Mind: ${summary.from} → ${summary.to} (${summary.platform}).`,
    `Paquete verificado: ${summary.files} archivos coinciden con su manifiesto (SHA-256).`,
  ];
  if (summary.downgrade) lines.push('Atención: el paquete es una versión ANTERIOR a la instalada (--forzar).');
  if (summary.reinstall) lines.push('Es la misma versión: se reinstalará.');
  lines.push('Se sustituyen Motor/, Runtime/, iniciadores, configuraciones de agentes y documentación.');
  lines.push(`Lo actual se conserva en ${summary.backup}/. La Base (${summary.base}) no se modifica.`);
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
      print(`Listo: Mind ${result.to}. La versión anterior queda en ${result.backup}/ (puedes borrarla cuando compruebes que todo funciona).`);
    }
  } finally {
    prompt.close();
  }
  return 0;
}


export async function updateMind(options) {
  const release = await lockInstallation(options.root);
  try { return await updateMindUnlocked(options); }
  finally { await release(); }
}
