import fs from 'node:fs/promises';
import path from 'node:path';
import { MotorError } from './errors.js';
import { samePath } from './paths.js';

const UTF8 = new TextDecoder('utf-8', { fatal: true });
const VANISHED = new Set(['ENOENT', 'ENOTDIR']);
const SEPARATOR = '/';

/** @typedef {'file' | 'directory' | 'link' | 'other' | 'unknown'} EntryType */
/** @typedef {'indexed' | 'not-listed' | 'unverified'} EntryState */
/**
 * Metadatos de una entrada. Nunca incluye contenido ni destino de enlaces.
 * @typedef {object} IndexEntry
 * @property {string} path Ruta relativa a la raíz, separada por "/".
 * @property {EntryType} type
 * @property {number | null} size Solo para archivos regulares.
 * @property {string | null} modifiedAt
 * @property {string | null} changedAt Cambio de metadatos (ctime).
 * @property {string | null} createdAt null si el sistema no lo informa.
 * @property {EntryState} state
 * @property {string | null} reason Código que explica un estado distinto de "indexed".
 */
/** @typedef {{ path: string, code: string }} ScanIssue */

/** Error del sistema de archivos que debe registrarse, no ocultarse. */
function systemCode(error) {
  if (typeof error?.code === 'string' && /^E[A-Z0-9]+$/.test(error.code)) return error.code;
  throw error;
}

function iso(date) {
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function typeOf(stats) {
  if (stats.isSymbolicLink()) return 'link';
  if (stats.isDirectory()) return 'directory';
  if (stats.isFile()) return 'file';
  return 'other';
}

function describe(relative, stats) {
  const type = typeOf(stats);
  return {
    path: relative,
    type,
    size: type === 'file' ? Number(stats.size) : null,
    modifiedAt: iso(stats.mtime),
    changedAt: iso(stats.ctime),
    createdAt: stats.birthtimeMs > 0n ? iso(stats.birthtime) : null,
    state: 'indexed',
    reason: null,
  };
}

function join(parent, name) {
  return parent === '' ? name : `${parent}${SEPARATOR}${name}`;
}

/**
 * Comprueba que la raíz entregada por el Motor sigue siendo la carpeta física
 * registrada: existe, es un directorio y ni ella ni sus ancestros la redirigen.
 */
export async function inspectRoot(root) {
  let stats;
  let physical;
  try {
    stats = await fs.lstat(root, { bigint: true });
    physical = await fs.realpath(root);
  } catch (error) {
    throw new MotorError('SCOPE_UNAVAILABLE', 'La carpeta autorizada no existe o no es accesible.', { cause: error });
  }
  if (stats.isSymbolicLink() || !stats.isDirectory() || !samePath(physical, root)) {
    throw new MotorError('SCOPE_CHANGED', 'La ruta autorizada ya no corresponde a la carpeta registrada.');
  }
  return stats;
}

/** Lista nombres y comprueba que el directorio no fue sustituido durante la lectura. */
async function listNames(absolute, before) {
  const names = [];
  // Solo se leen entradas de directorio; los archivos no se abren.
  const directory = await fs.opendir(absolute, { encoding: 'buffer' });
  for await (const dirent of directory) names.push(dirent.name);
  const after = await fs.lstat(absolute, { bigint: true });
  if (!after.isDirectory() || after.isSymbolicLink()
      || after.ino !== before.ino || after.dev !== before.dev) {
    throw Object.assign(new Error('El directorio cambió durante el recorrido.'), { code: 'ECHANGED' });
  }
  return names;
}

/**
 * Recorre una raíz ya validada sin seguir enlaces ni cambiar de volumen.
 * Las entradas que no pueden comprobarse conservan su último registro como
 * "unverified", para no confundir un acceso denegado con una eliminación.
 * @param {string} root
 * @param {object} options
 * @param {import('node:fs').BigIntStats} options.rootStats
 * @param {IndexEntry[]} options.previous Entradas del índice anterior, ordenadas.
 * @param {number} options.maxEntries
 * @returns {Promise<{ entries: IndexEntry[], issues: ScanIssue[] }>}
 */
export async function scanFolder(root, { rootStats, previous, maxEntries }) {
  const known = new Map(previous.map((entry) => [entry.path, entry]));
  const entries = [];
  const issues = [];

  function add(entry) {
    entries.push(entry);
    if (entries.length > maxEntries) {
      throw new MotorError('INDEX_LIMIT_EXCEEDED', `La carpeta supera el límite de ${maxEntries} entradas indexables.`);
    }
  }

  function carryDescendants(relative, reason) {
    const prefix = `${relative}${SEPARATOR}`;
    for (const entry of previous) {
      if (entry.path.startsWith(prefix)) add({ ...entry, state: 'unverified', reason });
    }
  }

  const stack = [{ absolute: root, relative: '', stats: rootStats, entry: null }];
  while (stack.length > 0) {
    const directory = stack.pop();
    let names;
    try {
      names = await listNames(directory.absolute, directory.stats);
    } catch (error) {
      const code = systemCode(error);
      if (directory.entry === null) {
        const changed = code === 'ECHANGED';
        throw new MotorError(changed ? 'SCOPE_CHANGED' : 'SCOPE_UNAVAILABLE',
          changed ? 'La carpeta autorizada cambió durante la indexación.'
            : 'No se pudo listar la carpeta autorizada.', { cause: error });
      }
      if (VANISHED.has(code)) {
        directory.entry.vanished = true;
      } else {
        directory.entry.state = 'not-listed';
        directory.entry.reason = code;
        carryDescendants(directory.relative, code);
      }
      continue;
    }

    for (const raw of names) {
      let name;
      try {
        name = UTF8.decode(raw);
      } catch {
        issues.push({ path: directory.relative, code: 'NAME_NOT_UTF8' });
        continue;
      }
      const relative = join(directory.relative, name);
      const absolute = path.join(directory.absolute, name);
      let stats;
      try {
        stats = await fs.lstat(absolute, { bigint: true });
      } catch (error) {
        const code = systemCode(error);
        if (VANISHED.has(code)) continue;
        const before = known.get(relative);
        add(before ? { ...before, state: 'unverified', reason: code } : {
          path: relative, type: 'unknown', size: null, modifiedAt: null,
          changedAt: null, createdAt: null, state: 'unverified', reason: code,
        });
        carryDescendants(relative, code);
        continue;
      }
      const entry = describe(relative, stats);
      add(entry);
      if (entry.type !== 'directory') continue;
      if (stats.dev !== rootStats.dev) {
        entry.state = 'not-listed';
        entry.reason = 'OTHER_VOLUME';
        carryDescendants(relative, 'OTHER_VOLUME');
      } else {
        stack.push({ absolute, relative, stats, entry });
      }
    }
  }

  const present = entries.filter((entry) => !entry.vanished);
  present.sort((a, b) => (a.path < b.path ? -1 : 1));
  issues.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { entries: present, issues };
}
