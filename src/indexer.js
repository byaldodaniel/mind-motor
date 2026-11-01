import path from 'node:path';
import { MotorError } from './errors.js';
import { contains, samePath } from './paths.js';
import { scanFolder } from './index-scan.js';
import { createIndexStore, validateScopeId } from './index-store.js';

const DEFAULT_MAX_ENTRIES = 100_000;

/** @typedef {{ id: string, path: string, generation?: string | null }} IndexScope Ámbito ya validado por el Motor. */
/**
 * Resolución confiable que solo el Motor proporciona. Debe rechazar ámbitos no
 * autorizados o retirados; el indexador nunca recibe rutas de quien lo llama.
 * @callback ScopeResolver
 * @param {string} scopeId
 * @returns {Promise<IndexScope>}
 */
/**
 * @typedef {object} IndexChanges
 * @property {string[]} added
 * @property {string[]} modified
 * @property {string[]} removed
 */
/**
 * @typedef {object} IndexResult
 * @property {string} scopeId
 * @property {'initial' | 'reconciliation'} mode
 * @property {number} generation
 * @property {string} indexedAt
 * @property {{ entries: number, files: number, directories: number, links: number, other: number, notListed: number, unverified: number }} totals
 * @property {IndexChanges | null} changes null en la indexación inicial.
 * @property {{ path: string, code: string }[]} issues
 */

/** Los cambios de accesibilidad se informan como incidencias, no como modificaciones. */
function changed(before, after) {
  if (before.type !== after.type) return true;
  // La fecha de una carpeta cambia con sus hijos; esos cambios se informan en los hijos.
  return after.type !== 'directory'
    && (before.size !== after.size || before.modifiedAt !== after.modifiedAt);
}

/** Compara dos pasadas; lo no comprobable no cuenta como añadido, cambiado ni eliminado. */
function compare(previous, current) {
  const before = new Map(previous.map((entry) => [entry.path, entry]));
  const now = new Set(current.map((entry) => entry.path));
  const changes = { added: [], modified: [], removed: [] };
  for (const entry of current) {
    if (entry.state === 'unverified') continue;
    const old = before.get(entry.path);
    if (!old || old.type === 'unknown') changes.added.push(entry.path);
    else if (changed(old, entry)) changes.modified.push(entry.path);
  }
  for (const entry of previous) {
    if (!now.has(entry.path)) changes.removed.push(entry.path);
  }
  return changes;
}

function summarize(entries, issues) {
  const totals = { entries: entries.length, files: 0, directories: 0, links: 0, other: 0, notListed: 0, unverified: 0 };
  const plural = { file: 'files', directory: 'directories', link: 'links', other: 'other' };
  const problems = [];
  for (const entry of entries) {
    if (plural[entry.type]) totals[plural[entry.type]] += 1;
    if (entry.state === 'not-listed') totals.notListed += 1;
    if (entry.state === 'unverified') totals.unverified += 1;
    if (entry.reason !== null) problems.push({ path: entry.path, code: entry.reason });
  }
  return { totals, issues: [...problems, ...issues] };
}

function sameAuthorization(first, second) {
  return samePath(first.path, second.path)
    && (first.generation ?? null) === (second.generation ?? null);
}

function boundIndex(index, scope) {
  // Los v1 no estaban ligados a una concesión: nunca se reutilizan como vigentes.
  return index && samePath(index.root, scope.path)
    && Object.hasOwn(index, 'authorizationGeneration')
    && index.authorizationGeneration === (scope.generation ?? null) ? index : null;
}

function requireSameAuthorization(before, after) {
  if (!sameAuthorization(before, after)) {
    throw new MotorError('INDEX_SCOPE_CHANGED', 'La autorización cambió durante la operación del índice.');
  }
}

/**
 * Núcleo interno de indexación de metadatos. El Motor lo crea con su Base y
 * resolutor del registro, y expone las operaciones solo al anfitrión administrativo.
 * No lee contenido, no sigue enlaces y no modifica los originales.
 * @param {object} options
 * @param {string} options.baseDirectory Ruta física de la Base ya abierta por el Motor.
 * @param {ScopeResolver} options.resolveScope
 * @param {number} [options.maxEntries]
 * @param {string} [options.pythonExecutable] Intérprete del recorrido seguro.
 */
export function createFolderIndexer({
  baseDirectory, resolveScope, maxEntries = DEFAULT_MAX_ENTRIES,
  pythonExecutable = process.platform === 'win32' ? 'python' : 'python3',
} = {}) {
  if (typeof baseDirectory !== 'string' || !path.isAbsolute(baseDirectory)) {
    throw new MotorError('INVALID_BASE', 'Indica la ruta absoluta de la Base del Motor.');
  }
  if (typeof resolveScope !== 'function') {
    throw new MotorError('INVALID_SCOPE_RESOLVER', 'El indexador necesita el resolutor de ámbitos del Motor.');
  }
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    throw new MotorError('INVALID_INDEX_LIMIT', 'El límite de entradas debe ser un entero positivo.');
  }
  const store = createIndexStore(baseDirectory);
  const pending = new Map();

  async function authorized(scopeId) {
    validateScopeId(scopeId);
    const scope = await resolveScope(scopeId);
    if (!scope || scope.id !== scopeId || typeof scope.path !== 'string'
        || scope.path.includes('\0') || !path.isAbsolute(scope.path)) {
      throw new MotorError('INVALID_SCOPE', 'El Motor no entregó un ámbito autorizado válido.');
    }
    if (contains(scope.path, baseDirectory) || contains(baseDirectory, scope.path)) {
      throw new MotorError('SCOPE_OVERLAPS_INTERNAL', 'El ámbito no puede contener la Base ni estar dentro de ella.');
    }
    return scope;
  }

  /** Serializa operaciones del mismo ámbito dentro de esta instancia. */
  function exclusive(scopeId, task) {
    const current = (pending.get(scopeId) ?? Promise.resolve()).then(task);
    // La cola guarda una promesa que nunca rechaza; el error llega solo a quien llamó.
    const settled = current.then(() => {}, () => {}).then(() => {
      if (pending.get(scopeId) === settled) pending.delete(scopeId);
    });
    pending.set(scopeId, settled);
    return current;
  }

  return Object.freeze({
    /**
     * Crea el índice inicial o lo reconcilia con el estado actual de la carpeta.
     * Si falla, el índice anterior permanece intacto.
     * @param {string} scopeId
     * @returns {Promise<IndexResult>}
     */
    async indexFolder(scopeId) {
      validateScopeId(scopeId);
      return exclusive(scopeId, async () => {
        const scope = await authorized(scopeId);
        const previous = boundIndex(await store.load(scopeId), scope);
        const { entries, issues } = await scanFolder(scope.path, {
          previous: previous?.entries ?? [], maxEntries, pythonExecutable,
        });
        // La autorización se vuelve a consultar: una retirada durante el recorrido no se publica.
        requireSameAuthorization(scope, await authorized(scopeId));
        const latest = boundIndex(await store.load(scopeId), scope);
        if ((latest?.generation ?? 0) !== (previous?.generation ?? 0)) {
          throw new MotorError('INDEX_CONFLICT', 'Otro proceso actualizó este índice durante el recorrido.');
        }
        const indexedAt = new Date().toISOString();
        const generation = (previous?.generation ?? 0) + 1;
        await store.save({
          scopeId, root: scope.path, authorizationGeneration: scope.generation ?? null,
          generation, createdAt: previous?.createdAt ?? indexedAt,
          updatedAt: indexedAt, entries, issues,
        });
        return {
          scopeId,
          mode: previous ? 'reconciliation' : 'initial',
          generation,
          indexedAt,
          ...summarize(entries, issues),
          changes: previous ? compare(previous.entries, entries) : null,
        };
      });
    },

    /**
     * Recupera el último índice guardado sin recorrer la carpeta.
     * @param {string} scopeId
     * @returns {Promise<import('./index-store.js').FolderIndex | null>}
     */
    async readFolderIndex(scopeId) {
      const scope = await authorized(scopeId);
      const index = await store.load(scopeId);
      requireSameAuthorization(scope, await authorized(scopeId));
      return boundIndex(index, scope);
    },

    /**
     * Incorpora el archivo recién creado por el Motor sin recorrer la carpeta.
     * Solo publica si el índice vigente ya contiene sus carpetas padre listadas y
     * no tiene otra entrada con ese nombre; si no, deja el índice intacto y pide
     * una reconciliación explícita con indexFolder. updatedAt sigue siendo la
     * fecha del último recorrido: la entrada aporta sus propias fechas.
     * @param {string} scopeId
     * @param {import('./index-scan.js').IndexEntry} entry
     * @returns {Promise<{ status: 'updated' | 'current' | 'not-indexed' | 'needs-reconciliation', generation: number | null, code: string | null }>}
     */
    async recordCreatedFile(scopeId, entry) {
      validateScopeId(scopeId);
      return exclusive(scopeId, async () => {
        const reconcile = (code, generation = null) => ({ status: 'needs-reconciliation', generation, code });
        if (entry?.type !== 'file' || entry.state !== 'indexed' || typeof entry.path !== 'string') {
          return reconcile('INVALID_CREATED_ENTRY');
        }
        const scope = await authorized(scopeId);
        const index = boundIndex(await store.load(scopeId), scope);
        if (!index) return { status: 'not-indexed', generation: null, code: null };
        const known = new Map(index.entries.map((item) => [item.path, item]));
        const existing = known.get(entry.path);
        if (existing) {
          const same = ['type', 'size', 'modifiedAt', 'changedAt', 'createdAt', 'state', 'reason']
            .every((field) => existing[field] === entry[field]);
          return same ? { status: 'current', generation: index.generation, code: null }
            : reconcile('INDEX_ENTRY_CONFLICT', index.generation);
        }
        const parts = entry.path.split('/');
        for (let depth = 1; depth < parts.length; depth += 1) {
          const parent = known.get(parts.slice(0, depth).join('/'));
          if (parent?.type !== 'directory' || parent.state !== 'indexed') {
            return reconcile('INDEX_PARENT_NOT_CURRENT', index.generation);
          }
        }
        if (index.entries.length + 1 > maxEntries) return reconcile('INDEX_LIMIT_EXCEEDED', index.generation);
        requireSameAuthorization(scope, await authorized(scopeId));
        const latest = boundIndex(await store.load(scopeId), scope);
        if (latest?.generation !== index.generation) return reconcile('INDEX_CONFLICT');
        const entries = [...index.entries, entry].sort((a, b) => (a.path < b.path ? -1 : 1));
        const generation = index.generation + 1;
        // save valida la forma completa; una entrada mal formada no se publica.
        await store.save({ ...index, generation, entries });
        return { status: 'updated', generation, code: null };
      });
    },

    /** Retira solo el índice de la Base; admite ámbitos ya retirados. */
    async removeFolderIndex(scopeId) {
      validateScopeId(scopeId);
      return exclusive(scopeId, () => store.remove(scopeId));
    },
  });
}
