import path from 'node:path';
import { MotorError } from './errors.js';
import { readJson, writeJson, removeJson } from './storage.js';
import { withIndexLock } from './index-lock.js';

const VALID_SCOPE_ID = /^[a-f0-9]{64}$/;
const TYPES = new Set(['file', 'directory', 'link', 'other', 'unknown']);
const STATES = new Set(['indexed', 'not-listed', 'unverified']);
const ENTRY_KEYS = ['changedAt', 'createdAt', 'modifiedAt', 'path', 'reason', 'size', 'state', 'type'];
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
  return hasKeys(entry, ENTRY_KEYS) && isRelative(entry.path) && TYPES.has(entry.type)
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
    || (hasKeys(data, BOUND_RECORD_KEYS) && data.version === 2
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

/** Persistencia de índices en la Base; un archivo versionado por ámbito. */
export function createIndexStore(baseDirectory) {
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
    /** @returns {Promise<FolderIndex | null>} */
    async load(scopeId) {
      const stored = await readJson(filename(scopeId));
      if (stored === null) return null;
      if (!validRecord(stored.data, scopeId)) {
        throw new MotorError('INDEX_CORRUPT', 'El índice guardado no tiene el formato esperado.');
      }
      const { format, version, ...index } = stored.data;
      return index;
    },

    /** @param {FolderIndex} index */
    async save(index) {
      const record = { format: 'mind-folder-index', version: 2, ...index };
      if (!validRecord(record, index.scopeId)) {
        throw new MotorError('INDEX_INVALID', 'El índice generado no cumple el formato persistente.');
      }
      await writeJson(filename(index.scopeId), record);
    },

    async remove(scopeId) {
      return removeJson(filename(scopeId));
    },
  };
}
