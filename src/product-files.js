import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { MotorError } from './errors.js';
import { safeRelativePath, resolveLinkTarget, compareBytes } from './archive.js';

/**
 * Manifiesto del paquete (mind-producto.json) y comprobación de los archivos
 * de una carpeta de Mind contra él. Lo usan la construcción del paquete, la
 * retirada de la cuarentena de macOS y `mind actualizar`.
 *
 * {
 *   "format": "mind-product", "version": 1, "mindVersion": "1.0.0",
 *   "platform": "darwin", "arch": "arm64", "baseFormatVersion": 2,
 *   "components": [...],
 *   "files": { "<ruta>": "<sha256>" },   archivos normales, con "/"
 *   "links": { "<ruta>": "<destino>" }   enlaces simbólicos internos (POSIX)
 * }
 *
 * El manifiesto no se incluye a sí mismo. Base/ nunca forma parte del paquete.
 */

export const MANIFEST_NAME = 'mind-producto.json';
export const PLATFORMS = Object.freeze(['win32', 'darwin', 'linux']);
export const ARCHITECTURES = Object.freeze(['x64', 'arm64']);
const SHA256 = /^[a-f0-9]{64}$/u;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;

const invalid = (message) => new MotorError('PRODUCT_MANIFEST_INVALID', message);

/**
 * Compara versiones según SemVer 2.0 (la metainformación tras "+" no cuenta).
 * @returns {number} <0, 0 o >0
 */
export function compareVersions(a, b) {
  const left = VERSION.exec(a);
  const right = VERSION.exec(b);
  if (!left || !right) throw new MotorError('INVALID_VERSION', `Versión no válida: ${!left ? a : b}`);
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(left[index]) - Number(right[index]);
    if (difference !== 0) return Math.sign(difference);
  }
  if (!left[4] || !right[4]) return left[4] ? -1 : right[4] ? 1 : 0;
  const first = left[4].split('.');
  const second = right[4].split('.');
  for (let index = 0; index < Math.max(first.length, second.length); index += 1) {
    if (first[index] === undefined) return -1;
    if (second[index] === undefined) return 1;
    const numericA = /^\d+$/u.test(first[index]);
    const numericB = /^\d+$/u.test(second[index]);
    if (numericA && numericB) {
      const difference = Number(first[index]) - Number(second[index]);
      if (difference !== 0) return Math.sign(difference);
    } else if (numericA !== numericB) {
      return numericA ? -1 : 1;
    } else if (first[index] !== second[index]) {
      return first[index] < second[index] ? -1 : 1;
    }
  }
  return 0;
}

export const isVersion = (value) => typeof value === 'string' && VERSION.test(value);

/** Primer componente de una ruta del paquete, para reconocer Base/ sin distinguir mayúsculas. */
const topLevel = (relative) => relative.split('/')[0].toLowerCase();

/**
 * Valida un manifiesto ya leído. Devuelve una copia congelada.
 * @param {unknown} data
 */
export function validateManifest(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw invalid('El manifiesto del paquete no es un objeto.');
  if (data.format !== 'mind-product' || data.version !== 1) throw invalid('El manifiesto no tiene el formato mind-product versión 1.');
  if (!isVersion(data.mindVersion)) throw invalid('El manifiesto no indica una versión de Mind válida.');
  if (!PLATFORMS.includes(data.platform) || !ARCHITECTURES.includes(data.arch)) {
    throw invalid('El manifiesto no indica una plataforma y arquitectura admitidas.');
  }
  if (data.baseFormatVersion !== undefined && (!Number.isSafeInteger(data.baseFormatVersion) || data.baseFormatVersion < 1)) {
    throw invalid('El manifiesto indica un formato de Base no válido.');
  }
  if (!data.files || typeof data.files !== 'object' || Array.isArray(data.files)) throw invalid('El manifiesto no contiene la lista de archivos.');
  const links = data.links ?? {};
  if (typeof links !== 'object' || Array.isArray(links)) throw invalid('Los enlaces del manifiesto no son válidos.');
  const folded = new Set();
  const check = (relative) => {
    if (safeRelativePath(relative) !== relative) throw invalid(`Ruta no válida en el manifiesto: ${String(relative).slice(0, 200)}`);
    if (topLevel(relative) === 'base' || relative === MANIFEST_NAME) throw invalid(`El paquete no puede contener ${relative}.`);
    const key = relative.normalize('NFC').toLowerCase();
    if (folded.has(key)) throw invalid(`Rutas repetidas (o que difieren solo en mayúsculas): ${relative}`);
    folded.add(key);
  };
  for (const [relative, hash] of Object.entries(data.files)) {
    check(relative);
    if (typeof hash !== 'string' || !SHA256.test(hash)) throw invalid(`Huella SHA-256 no válida para ${relative}.`);
  }
  for (const [relative, target] of Object.entries(links)) {
    check(relative);
    const resolved = resolveLinkTarget(relative, target);
    if (!resolved || topLevel(resolved) === 'base') throw invalid(`Enlace no válido en el manifiesto: ${relative}`);
  }
  // Ningún archivo puede quedar «dentro» de otro archivo o de un enlace.
  const leaves = new Set([...Object.keys(data.files), ...Object.keys(links)]);
  for (const relative of leaves) {
    const parts = relative.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      if (leaves.has(parts.slice(0, index).join('/'))) throw invalid(`Ruta dentro de un archivo: ${relative}`);
    }
  }
  return Object.freeze({
    ...data,
    components: Array.isArray(data.components) ? data.components : [],
    files: Object.freeze({ ...data.files }),
    links: Object.freeze({ ...links }),
  });
}

/** Lee y valida <root>/mind-producto.json; null si no existe. */
export async function readManifestFile(root) {
  let text;
  try {
    text = await fsp.readFile(path.join(root, MANIFEST_NAME), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (cause) {
    throw new MotorError('PRODUCT_MANIFEST_INVALID', 'El manifiesto del paquete de Mind no es JSON válido.', { cause });
  }
  return validateManifest(data);
}

/** SHA-256 hexadecimal de un archivo, leído por flujo. */
export async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

const native = (root, relative) => path.join(root, ...relative.split('/'));

/** Recorre un árbol sin seguir enlaces. Devuelve archivos, enlaces y otros (no carpetas). */
export async function scanTree(root, start = '') {
  const result = [];
  async function walk(relative) {
    const directory = relative === '' ? root : native(root, relative);
    let names;
    try {
      names = await fsp.readdir(directory);
    } catch (error) {
      if (error.code === 'ENOENT' && relative === start) return;
      throw error;
    }
    for (const name of names) {
      const child = relative === '' ? name : `${relative}/${name}`;
      const info = await fsp.lstat(native(root, child));
      if (info.isDirectory()) await walk(child);
      else if (info.isSymbolicLink()) result.push({ path: child, type: 'symlink', target: await fsp.readlink(native(root, child)) });
      else if (info.isFile()) result.push({ path: child, type: 'file', size: info.size, mode: info.mode });
      else result.push({ path: child, type: 'other' });
    }
  }
  await walk(start);
  return result.sort((a, b) => compareBytes(a.path, b.path));
}

async function mapLimit(items, limit, task) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await task(items[index]);
    }
  }));
  return results;
}

/**
 * Comprueba los archivos de una carpeta de Mind contra su manifiesto.
 * Con prefix solo se considera ese subárbol (por ejemplo, "Runtime").
 * Con allowExtra=false, cualquier archivo que el manifiesto no declare es una diferencia.
 * @returns {Promise<{ ok: boolean, files: number, links: number, problems: Array<{ path: string, problem: string }> }>}
 */
export async function verifyTree(root, manifest, { prefix = '', allowExtra = false } = {}) {
  const within = (relative) => prefix === '' || relative === prefix || relative.startsWith(`${prefix}/`);
  const expectedFiles = Object.entries(manifest.files).filter(([relative]) => within(relative));
  const expectedLinks = Object.entries(manifest.links ?? {}).filter(([relative]) => within(relative));
  const actual = new Map((await scanTree(root, prefix)).map((entry) => [entry.path, entry]));
  if (prefix === '') actual.delete(MANIFEST_NAME);
  const problems = [];
  const hashes = await mapLimit(expectedFiles, 8, async ([relative, hash]) => {
    const entry = actual.get(relative);
    if (!entry) return { path: relative, problem: 'falta' };
    if (entry.type !== 'file') return { path: relative, problem: 'tipo' };
    return (await hashFile(native(root, relative))) === hash ? null : { path: relative, problem: 'distinto' };
  });
  for (const problem of hashes) if (problem) problems.push(problem);
  for (const [relative, target] of expectedLinks) {
    const entry = actual.get(relative);
    if (!entry) problems.push({ path: relative, problem: 'falta' });
    else if (entry.type !== 'symlink' || entry.target !== target) problems.push({ path: relative, problem: 'distinto' });
  }
  if (!allowExtra) {
    for (const relative of actual.keys()) {
      if (!Object.hasOwn(manifest.files, relative) && !Object.hasOwn(manifest.links ?? {}, relative)) {
        problems.push({ path: relative, problem: 'sobrante' });
      }
    }
  }
  problems.sort((a, b) => compareBytes(a.path, b.path));
  return { ok: problems.length === 0, files: expectedFiles.length, links: expectedLinks.length, problems };
}

/** Resumen legible de las diferencias, para mensajes al usuario. */
export function describeProblems(problems, limit = 5) {
  const labels = { falta: 'falta', distinto: 'no coincide', sobrante: 'no figura en el manifiesto', tipo: 'tipo inesperado' };
  const shown = problems.slice(0, limit).map((item) => `${item.path} (${labels[item.problem] ?? item.problem})`);
  return `${shown.join('; ')}${problems.length > limit ? `; y ${problems.length - limit} más` : ''}`;
}
