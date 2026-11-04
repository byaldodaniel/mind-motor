import { lstat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { MotorError } from './errors.js';
import { readJson, writeJson, removeJson } from './storage.js';
import { withIndexLock } from './index-lock.js';
import { prepareBaseFormat } from './base-format.js';

const VALID_SCOPE_ID = /^[a-f0-9]{64}$/;
const TYPES = new Set(['file', 'directory', 'link', 'other', 'unknown']);
const STATES = new Set(['indexed', 'not-listed', 'unverified']);
const ENTRY_KEYS = ['changedAt', 'createdAt', 'modifiedAt', 'path', 'reason', 'size', 'state', 'type'];
const IDENTITY_ENTRY_KEYS = ['changedAt', 'createdAt', 'identity', 'modifiedAt', 'path', 'reason', 'size', 'state', 'type'];
const RECORD_KEYS = ['createdAt', 'entries', 'format', 'generation', 'issues', 'root', 'scopeId', 'updatedAt', 'version'];
const BOUND_RECORD_KEYS = ['authorizationGeneration', ...RECORD_KEYS];

/**
 * Índice persistido de una carpeta autorizada.
 * @typedef {object} FolderIndex
 * @property {string} scopeId
 * @property {string} root Ruta física indexada.
 * @property {number} generation Aumenta con cada indexación guardada.
 * @property {string | null} [authorizationGeneration] Generación del registro; ausente en índices v1.
 * @property {string} createdAt Primera indexación.
 * @property {string} updatedAt Última indexación o reconciliación.
 * @property {import('./index-scan.js').IndexEntry[]} entries
 * @property {import('./index-scan.js').ScanIssue[]} issues
 */

export function validateScopeId(scopeId) {
  if (typeof scopeId !== 'string' || !VALID_SCOPE_ID.test(scopeId)) {
    throw new MotorError('INVALID_SCOPE_ID', 'El identificador del ámbito no es válido.');
  }
}

function isDate(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function isRelative(value) {
  return typeof value === 'string' && value !== '' && !value.includes('\0')
    && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

function hasKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join() === keys.join();
}

function validSize(entry) {
  if (entry.size === null) return entry.type !== 'file';
  return entry.type === 'file' && Number.isSafeInteger(entry.size) && entry.size >= 0;
}

function validEntry(entry) {
  return (hasKeys(entry, ENTRY_KEYS) || (hasKeys(entry, IDENTITY_ENTRY_KEYS)
      && (entry.identity === null || (typeof entry.identity === 'string'
        && /^(posix|nt):[0-9]+:[0-9]+$/u.test(entry.identity)))))
    && isRelative(entry.path) && TYPES.has(entry.type)
    && STATES.has(entry.state) && validSize(entry)
    && (entry.state === 'indexed' ? entry.reason === null : typeof entry.reason === 'string')
    && (entry.state !== 'not-listed' || entry.type === 'directory')
    && (entry.type !== 'unknown' || entry.state === 'unverified')
    && [entry.modifiedAt, entry.changedAt, entry.createdAt].every((date) => date === null || isDate(date));
}

function validIssue(issue) {
  return hasKeys(issue, ['code', 'path']) && typeof issue.code === 'string'
    && (issue.path === '' || isRelative(issue.path));
}

function validRecord(data, scopeId) {
  const shape = (hasKeys(data, RECORD_KEYS) && data.version === 1)
    || (hasKeys(data, BOUND_RECORD_KEYS) && [2, 3].includes(data.version)
      && (data.authorizationGeneration === null || (typeof data.authorizationGeneration === 'string'
        && /^[a-f0-9-]{36}$/.test(data.authorizationGeneration))));
  if (!shape || data.format !== 'mind-folder-index'
      || data.scopeId !== scopeId || typeof data.root !== 'string' || data.root.includes('\0')
      || !path.isAbsolute(data.root) || !Number.isSafeInteger(data.generation) || data.generation < 1
      || !isDate(data.createdAt) || !isDate(data.updatedAt)
      || !Array.isArray(data.entries) || !Array.isArray(data.issues)
      || !data.issues.every(validIssue)) {
    return false;
  }
  // Orden estricto: garantiza rutas únicas y una comparación determinista.
  return data.entries.every((entry, index) => validEntry(entry)
    && (index === 0 || data.entries[index - 1].path < entry.path));
}

/** Entradas totales que se conservan en memoria por instancia (LRU por carpeta). */
export const INDEX_CACHE_MAX_ENTRIES = 600_000;
export const INDEX_CACHE_MAX_BYTES = 32 * 1024 ** 2;
// Solo para medir el comportamiento sin caché en las comparativas.
const CACHE_ENABLED = process.env.MIND_SIN_CACHE_INDICE !== '1';

async function identity(file) {
  try {
    const info = await lstat(file, { bigint: true });
    // Un enlace u otro tipo no se cachea: la lectura normal lo rechaza.
    if (!info.isFile()) return 'no-archivo';
    return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function deepFreeze(index) {
  for (const entry of index.entries) Object.freeze(entry);
  Object.freeze(index.entries);
  for (const value of Object.values(index)) if (value && typeof value === 'object') Object.freeze(value);
  return Object.freeze(index);
}

/** Persistencia de índices en la Base; un archivo versionado por ámbito. */
export function createIndexStore(baseDirectory, { maxBytes = INDEX_CACHE_MAX_BYTES } = {}) {
  const cache = new Map();
  function remember(scopeId, key, index) {
    cache.delete(scopeId);
    // Account for strings and object overhead, not only the number of entries.
    const bytes = index.entries.reduce((sum, entry) => sum + 256 + entry.path.length * 2, 512)
      + index.issues.reduce((sum, issue) => sum + 128 + issue.path.length * 2 + issue.code.length * 2, 0);
    if (!CACHE_ENABLED || bytes > maxBytes || os.freemem() < os.totalmem() * 0.08) { cache.clear(); return; }
    cache.set(scopeId, { identity: key, index, size: index.entries.length, bytes });
    let total = [...cache.values()].reduce((sum, item) => sum + item.size, 0);
    let totalBytes = [...cache.values()].reduce((sum, item) => sum + item.bytes, 0);
    for (const [id, item] of cache) {
      if (total <= INDEX_CACHE_MAX_ENTRIES && totalBytes <= maxBytes) break;
      cache.delete(id);
      total -= item.size;
      totalBytes -= item.bytes;
    }
  }
  function filename(scopeId) {
    validateScopeId(scopeId);
    return path.join(baseDirectory, `folder-index-${scopeId}.json`);
  }

  return {
    /** Protege la secuencia completa de lectura, preparación y publicación. */
    exclusive(scopeId, task) {
      validateScopeId(scopeId);
      return withIndexLock(baseDirectory, scopeId, task);
    },
    /**
     * Índice validado. Se conserva en memoria ligado a la identidad física del
     * archivo (dispositivo, inodo, tamaño y fechas en ns): cualquier publicación,
     * de este u otro proceso, crea un archivo nuevo y lo invalida. La
     * autorización la sigue comprobando el indexador en cada lectura.
     * @returns {Promise<FolderIndex | null>}
     */
    async load(scopeId) {
      if (os.freemem() < os.totalmem() * 0.08) cache.clear();
      const file = filename(scopeId);
      const before = await identity(file);
      if (before === null) {
        cache.delete(scopeId);
        return null;
      }
      const cached = before === 'no-archivo' || !CACHE_ENABLED ? null : cache.get(scopeId);
      if (cached && cached.identity === before) {
        cache.delete(scopeId);
        cache.set(scopeId, cached); // Más reciente al final (LRU).
        return cached.index;
      }
      const stored = await readJson(file);
      if (stored === null) return null;
      if (!validRecord(stored.data, scopeId)) {
        throw new MotorError('INDEX_CORRUPT', 'El índice guardado no tiene el formato esperado.');
      }
      const { format, version, ...index } = stored.data;
      const frozen = deepFreeze(index);
      // Solo se guarda si el archivo no cambió mientras se leía.
      if (before !== 'no-archivo' && (await identity(file)) === before) remember(scopeId, before, frozen);
      return frozen;
    },

    /** @param {FolderIndex} index */
    async save(index) {
      const record = { format: 'mind-folder-index', ...index, version: 3,
        entries: index.entries.map((entry) => ({ ...entry, identity: entry.identity ?? null })) };
      if (!validRecord(record, index.scopeId)) {
        throw new MotorError('INDEX_INVALID', 'El índice generado no cumple el formato persistente.');
      }
      await prepareBaseFormat(baseDirectory, 2);
      await writeJson(filename(index.scopeId), record);
    },

    async remove(scopeId) {
      cache.delete(scopeId);
      return removeJson(filename(scopeId));
    },
  };
}
