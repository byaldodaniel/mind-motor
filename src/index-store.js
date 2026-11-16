import path from 'node:path';
import os from 'node:os';
import { MotorError } from './errors.js';
import { readJson, removeJson } from './storage.js';
import { withIndexLock } from './index-lock.js';
import {
  getScopeMetaFromCatalog,
  loadScopeIndexFromCatalog,
  saveScopeIndexToCatalog,
  saveScopeBranchToCatalog,
  removeScopeFromCatalog,
} from './sqlite-catalog.js';

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
export const INDEX_CACHE_MAX_BYTES = 128 * 1024 ** 2;
// Solo para medir el comportamiento sin caché en las comparativas.
const CACHE_ENABLED = process.env.MIND_SIN_CACHE_INDICE !== '1';

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
     * Índice validado desde SQLite (`catalog.sqlite`), con caché en memoria ligada
     * a generación y revisión del ámbito; si existe un legado JSON previo, lo migra.
     * @returns {Promise<FolderIndex | null>}
     */
    async load(scopeId) {
      validateScopeId(scopeId);
      if (os.freemem() < os.totalmem() * 0.08) cache.clear();

      const file = filename(scopeId);
      const legacy = await readJson(file);
      if (legacy !== null) {
        if (!validRecord(legacy.data, scopeId)) {
          throw new MotorError('INDEX_CORRUPT', 'El índice guardado no tiene el formato esperado.');
        }
        const { format, version, ...rawIndex } = legacy.data;
        const index = {
          ...rawIndex,
          entries: rawIndex.entries.map((entry) => ({ ...entry, identity: entry.identity ?? null })),
        };
        let revision = '';
        try {
          revision = await saveScopeIndexToCatalog(baseDirectory, index);
          await removeJson(file).catch(() => {});
        } catch (error) {
          if (!['EACCES', 'EPERM', 'EROFS'].includes(error?.code)) throw error;
        }
        const frozen = deepFreeze(index);
        if (revision) remember(scopeId, `${index.generation}:${revision}:${index.updatedAt}`, frozen);
        return frozen;
      }

      const meta = await getScopeMetaFromCatalog(baseDirectory, scopeId);
      if (meta === null) {
        cache.delete(scopeId);
        return null;
      }
      const metaKey = `${meta.generation}:${meta.revision}:${meta.updatedAt}`;
      const cached = !CACHE_ENABLED ? null : cache.get(scopeId);
      if (cached && cached.identity === metaKey) {
        cache.delete(scopeId);
        cache.set(scopeId, cached);
        return cached.index;
      }
      const stored = await loadScopeIndexFromCatalog(baseDirectory, scopeId);
      if (stored === null) {
        cache.delete(scopeId);
        return null;
      }
      const { revision, ...index } = stored;
      const candidate = { format: 'mind-folder-index', ...index, version: 3 };
      if (!validRecord(candidate, scopeId)) {
        throw new MotorError('INDEX_CORRUPT', 'El índice guardado no tiene el formato esperado.');
      }
      const frozen = deepFreeze(index);
      remember(scopeId, `${index.generation}:${revision}:${index.updatedAt}`, frozen);
      return frozen;
    },

    /** @param {FolderIndex} index */
    async save(index) {
      const normalizedEntries = index.entries.map((entry) => ({ ...entry, identity: entry.identity ?? null }));
      const record = { format: 'mind-folder-index', ...index, version: 3, entries: normalizedEntries };
      if (!validRecord(record, index.scopeId)) {
        throw new MotorError('INDEX_INVALID', 'El índice generado no cumple el formato persistente.');
      }
      const normalizedIndex = { ...index, entries: normalizedEntries };
      const revision = await saveScopeIndexToCatalog(baseDirectory, normalizedIndex);
      await removeJson(filename(index.scopeId)).catch(() => {});
      const frozen = deepFreeze(normalizedIndex);
      remember(index.scopeId, `${normalizedIndex.generation}:${revision}:${normalizedIndex.updatedAt}`, frozen);
      return frozen;
    },

    /** Actualización incremental por ramas sobre SQLite conservando caché coherente. */
    async saveBranch(branch) {
      validateScopeId(branch?.scopeId);
      const normalizedUpserts = (branch.upserts ?? []).map((entry) => ({ ...entry, identity: entry.identity ?? null }));
      if (!Array.isArray(branch.issues) || !branch.issues.every(validIssue)
          || !normalizedUpserts.every(validEntry) || !path.isAbsolute(branch.root)
          || !Number.isSafeInteger(branch.generation) || branch.generation < 1
          || !isDate(branch.createdAt) || !isDate(branch.updatedAt)) {
        throw new MotorError('INDEX_INVALID', 'La actualización parcial del índice no cumple el formato persistente.');
      }
      cache.delete(branch.scopeId);
      const revision = await saveScopeBranchToCatalog(baseDirectory, {
        ...branch,
        upserts: normalizedUpserts,
      });
      if (branch.mergedIndex) {
        const frozen = deepFreeze(branch.mergedIndex);
        remember(branch.scopeId, `${branch.generation}:${revision}:${branch.updatedAt}`, frozen);
        return frozen;
      }
      return null;
    },

    async remove(scopeId) {
      validateScopeId(scopeId);
      cache.delete(scopeId);
      const removedCatalog = await removeScopeFromCatalog(baseDirectory, scopeId);
      const removedLegacy = await removeJson(filename(scopeId));
      return removedCatalog || removedLegacy;
    },

    clearCache() {
      cache.clear();
    },
  };
}
