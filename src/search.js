import { MotorError } from './errors.js';
import { validateScopeId } from './index-store.js';

export const DEFAULT_SEARCH_LIMIT = 50;
export const MAX_SEARCH_LIMIT = 500;
const MAX_SCOPES = 64;
const MAX_QUERY = 256;
const TYPES = new Set(['file', 'directory', 'link', 'other']);
const MATCHES = new Set(['contains', 'prefix', 'exact']);
const FIELDS = new Set(['name', 'path']);
const SORTS = new Set(['relevance', 'path', 'modified', 'size']);
const KEYS = new Set(['folderIds', 'query', 'match', 'field', 'types', 'extensions', 'pathPrefix',
  'minSize', 'maxSize', 'modifiedAfter', 'modifiedBefore', 'includeUnverified', 'sort', 'limit', 'offset']);
/** Errores de un índice concreto que no deben ocultar los demás ámbitos. */
const INDEX_FAILURES = new Set(['INDEX_CORRUPT', 'RECORD_CORRUPT', 'RECORD_LINK']);

/**
 * @typedef {object} SearchRequest
 * @property {string[]} folderIds Ámbitos que el anfitrión autorizó para esta consulta.
 * @property {string} [query] Texto buscado; sin él coinciden todos los nombres.
 * @property {'contains' | 'prefix' | 'exact'} [match]
 * @property {'name' | 'path'} [field] Comparar con el nombre o con la ruta relativa.
 * @property {('file' | 'directory' | 'link' | 'other')[]} [types] Por defecto, solo archivos.
 * @property {string[]} [extensions] Por ejemplo [".md", "txt"].
 * @property {string} [pathPrefix] Carpeta relativa dentro de cada ámbito.
 * @property {number} [minSize]
 * @property {number} [maxSize]
 * @property {string} [modifiedAfter] Fecha ISO, inclusiva.
 * @property {string} [modifiedBefore] Fecha ISO, exclusiva.
 * @property {boolean} [includeUnverified] Por defecto true; esos resultados se marcan.
 * @property {'relevance' | 'path' | 'modified' | 'size'} [sort]
 * @property {number} [limit]
 * @property {number} [offset]
 */
/**
 * Referencia precisa a una entrada indexada. No contiene la ruta absoluta ni contenido.
 * folderId + relativePath es la forma que espera una solicitud de lectura autorizada.
 * @typedef {object} SearchResult
 * @property {string} folderId
 * @property {string} relativePath
 * @property {string} name
 * @property {'file' | 'directory' | 'link' | 'other' | 'unknown'} type
 * @property {number | null} size
 * @property {string | null} modifiedAt
 * @property {string | null} changedAt
 * @property {string | null} createdAt
 * @property {'indexed' | 'unverified'} status "indexed": confirmado en indexedAt.
 * @property {string | null} reason Por qué no pudo confirmarse.
 * @property {string} indexedAt Fecha del índice del que procede.
 */
/**
 * @typedef {object} ScopeStatus
 * @property {string} folderId
 * @property {'searched' | 'not-indexed' | 'not-authorized' | 'index-unavailable'} status
 * @property {string | null} indexedAt
 * @property {number | null} indexGeneration
 * @property {boolean | null} complete false si el índice tiene carpetas sin listar o entradas sin verificar.
 * @property {string | null} code
 */

function invalid(message) {
  return new MotorError('INVALID_SEARCH', message);
}

/** Comparación insensible a mayúsculas y diacríticos: "informacion" encuentra "Información". */
export function fold(text) {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

function date(value, name) {
  if (value === undefined) return null;
  const time = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(time)) throw invalid(`${name} debe ser una fecha ISO.`);
  return time;
}

function size(value, name) {
  if (value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw invalid(`${name} debe ser un entero no negativo.`);
  return value;
}

function list(value, name, check) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32 || !value.every(check)) {
    throw invalid(`${name} no es válido.`);
  }
  return value;
}

/** Valida la petición completa antes de leer cualquier índice. */
export function parseSearch(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw invalid('Indica una petición de búsqueda.');
  for (const key of Object.keys(request)) {
    if (!KEYS.has(key)) throw invalid(`Parámetro desconocido: ${key}.`);
  }
  const { folderIds } = request;
  if (!Array.isArray(folderIds) || folderIds.length === 0 || folderIds.length > MAX_SCOPES) {
    throw invalid(`Indica de 1 a ${MAX_SCOPES} carpetas autorizadas.`);
  }
  folderIds.forEach(validateScopeId);
  if (new Set(folderIds).size !== folderIds.length) throw invalid('Las carpetas no pueden repetirse.');
  const query = request.query ?? '';
  if (typeof query !== 'string' || query.length > MAX_QUERY || query.includes('\0')) {
    throw invalid(`La consulta debe ser texto de hasta ${MAX_QUERY} caracteres.`);
  }
  const match = request.match ?? 'contains';
  const field = request.field ?? 'name';
  const sort = request.sort ?? 'relevance';
  if (!MATCHES.has(match) || !FIELDS.has(field) || !SORTS.has(sort)) throw invalid('Modo, campo u orden no válido.');
  const types = new Set(request.types === undefined ? ['file']
    : list(request.types, 'types', (type) => TYPES.has(type)));
  const extensions = request.extensions === undefined ? null
    : new Set(list(request.extensions, 'extensions', (item) => typeof item === 'string'
      && /^\.?[^./\\\0]{1,32}$/u.test(item)).map((item) => fold(item.startsWith('.') ? item : `.${item}`)));
  const pathPrefix = request.pathPrefix ?? null;
  if (pathPrefix !== null && (typeof pathPrefix !== 'string' || pathPrefix === ''
      || pathPrefix.split('/').some((part) => !part || part === '.' || part === '..' || part.includes('\0')))) {
    throw invalid('pathPrefix debe ser una carpeta relativa con "/" entre componentes.');
  }
  const includeUnverified = request.includeUnverified ?? true;
  if (typeof includeUnverified !== 'boolean') throw invalid('includeUnverified debe ser booleano.');
  const limit = request.limit ?? DEFAULT_SEARCH_LIMIT;
  const offset = request.offset ?? 0;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SEARCH_LIMIT) {
    throw invalid(`limit debe estar entre 1 y ${MAX_SEARCH_LIMIT}.`);
  }
  if (!Number.isSafeInteger(offset) || offset < 0) throw invalid('offset debe ser un entero no negativo.');
  const minSize = size(request.minSize, 'minSize');
  const maxSize = size(request.maxSize, 'maxSize');
  const modifiedAfter = date(request.modifiedAfter, 'modifiedAfter');
  const modifiedBefore = date(request.modifiedBefore, 'modifiedBefore');
  return {
    folderIds, needle: fold(query), match, field, types, extensions, pathPrefix, includeUnverified,
    minSize, maxSize, modifiedAfter, modifiedBefore, sort, limit, offset,
  };
}

function nameOf(relativePath) {
  return relativePath.slice(relativePath.lastIndexOf('/') + 1);
}

/** 0 = igual, 1 = empieza por, 2 = contiene; null si no coincide. */
function rank(text, needle, match) {
  if (needle === '') return 2;
  if (text === needle) return 0;
  if (match === 'exact') return null;
  if (text.startsWith(needle)) return 1;
  if (match === 'prefix') return null;
  return text.includes(needle) ? 2 : null;
}

function matches(entry, criteria) {
  if (!criteria.types.has(entry.type)) return null;
  if (entry.state === 'unverified' && !criteria.includeUnverified) return null;
  if (criteria.pathPrefix && !entry.path.startsWith(`${criteria.pathPrefix}/`)) return null;
  const name = nameOf(entry.path);
  if (criteria.extensions) {
    const dot = name.lastIndexOf('.');
    if (dot <= 0 || !criteria.extensions.has(fold(name.slice(dot)))) return null;
  }
  // Los filtros de metadatos no admiten valores desconocidos.
  if (criteria.minSize !== null && !(entry.size >= criteria.minSize)) return null;
  if (criteria.maxSize !== null && !(entry.size !== null && entry.size <= criteria.maxSize)) return null;
  if (criteria.modifiedAfter !== null || criteria.modifiedBefore !== null) {
    const modified = entry.modifiedAt === null ? NaN : Date.parse(entry.modifiedAt);
    if (!Number.isFinite(modified)) return null;
    if (criteria.modifiedAfter !== null && modified < criteria.modifiedAfter) return null;
    if (criteria.modifiedBefore !== null && modified >= criteria.modifiedBefore) return null;
  }
  return rank(fold(criteria.field === 'name' ? name : entry.path), criteria.needle, criteria.match);
}

function byCodeUnits(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Orden total: el último desempate (folderId, ruta) es único. */
function comparator(sort) {
  const tail = (a, b) => byCodeUnits(a.key, b.key) || byCodeUnits(a.result.relativePath, b.result.relativePath)
    || byCodeUnits(a.result.folderId, b.result.folderId);
  const time = (item) => (item.result.modifiedAt === null ? -Infinity : Date.parse(item.result.modifiedAt));
  const bytes = (item) => item.result.size ?? -1;
  switch (sort) {
    case 'path': return (a, b) => byCodeUnits(a.result.relativePath, b.result.relativePath)
      || byCodeUnits(a.result.folderId, b.result.folderId);
    case 'modified': return (a, b) => time(b) - time(a) || tail(a, b);
    case 'size': return (a, b) => bytes(b) - bytes(a) || tail(a, b);
    default: return (a, b) => a.rank - b.rank || tail(a, b);
  }
}

/**
 * Búsqueda sobre los índices persistidos. No recorre carpetas ni abre archivos.
 * Los ámbitos llegan del anfitrión; su vigencia se comprueba con el registro
 * existente, sin un sistema de permisos propio.
 * @param {object} options
 * @param {(folderId: string) => Promise<import('./index-store.js').FolderIndex | null>} options.readFolderIndex
 * @param {(folderId: string) => Promise<{ id: string, generation?: string | null } | null>} options.loadAuthorizedFolder
 */
export function createIndexSearch({ readFolderIndex, loadAuthorizedFolder }) {
  async function readScope(folderId) {
    try {
      const index = await readFolderIndex(folderId);
      if (!index) return { scope: status(folderId, 'not-indexed'), index: null };
      return { scope: status(folderId, 'searched', index), index };
    } catch (error) {
      if (error?.code === 'FOLDER_NOT_AUTHORIZED' || error?.code === 'INDEX_SCOPE_CHANGED') {
        return { scope: status(folderId, 'not-authorized', null, error.code), index: null };
      }
      if (INDEX_FAILURES.has(error?.code)) {
        return { scope: status(folderId, 'index-unavailable', null, error.code), index: null };
      }
      throw error;
    }
  }

  /** Confirma que la concesión que produjo el índice sigue vigente al responder. */
  async function stillAuthorized(folderId, index) {
    const folder = await loadAuthorizedFolder(folderId);
    return folder !== null && (folder.generation ?? null) === index.authorizationGeneration;
  }

  return {
    /**
     * @param {SearchRequest} request
     * @returns {Promise<{ results: SearchResult[], total: number, offset: number, limit: number, truncated: boolean, scopes: ScopeStatus[] }>}
     */
    async searchFiles(request) {
      const criteria = parseSearch(request);
      const read = await Promise.all(criteria.folderIds.map(readScope));
      const found = [];
      for (const { scope, index } of read) {
        if (!index) continue;
        if (!(await stillAuthorized(scope.folderId, index))) {
          Object.assign(scope, status(scope.folderId, 'not-authorized', null, 'FOLDER_NOT_AUTHORIZED'));
          continue;
        }
        for (const entry of index.entries) {
          const level = matches(entry, criteria);
          if (level === null) continue;
          found.push({
            rank: level,
            key: fold(nameOf(entry.path)),
            result: {
              folderId: scope.folderId,
              relativePath: entry.path,
              name: nameOf(entry.path),
              type: entry.type,
              size: entry.size,
              modifiedAt: entry.modifiedAt,
              changedAt: entry.changedAt,
              createdAt: entry.createdAt,
              status: entry.state === 'unverified' ? 'unverified' : 'indexed',
              reason: entry.state === 'unverified' ? entry.reason : null,
              indexedAt: index.updatedAt,
            },
          });
        }
      }
      found.sort(comparator(criteria.sort));
      const page = found.slice(criteria.offset, criteria.offset + criteria.limit);
      return {
        results: page.map((item) => item.result),
        total: found.length,
        offset: criteria.offset,
        limit: criteria.limit,
        truncated: criteria.offset + page.length < found.length,
        scopes: read.map(({ scope }) => scope),
      };
    },
  };
}

function status(folderId, state, index = null, code = null) {
  return {
    folderId,
    status: state,
    indexedAt: index?.updatedAt ?? null,
    indexGeneration: index?.generation ?? null,
    complete: index ? index.issues.length === 0
      && index.entries.every((entry) => entry.state === 'indexed') : null,
    code,
  };
}
