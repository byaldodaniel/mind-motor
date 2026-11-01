import path from 'node:path';
import { MotorError } from './errors.js';
import { contains } from './paths.js';
import { inspectRoot, scanFolder } from './index-scan.js';
import { createIndexStore, validateScopeId } from './index-store.js';

const DEFAULT_MAX_ENTRIES = 100_000;

/** @typedef {{ id: string, path: string }} IndexScope Ámbito ya validado por el Motor. */
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

/**
 * Núcleo de indexación de metadatos. No forma parte de la API pública del Motor:
 * el anfitrión lo crea con su Base y con un resolutor de ámbitos autorizados.
 * No lee contenido, no sigue enlaces y no modifica los originales.
 * @param {object} options
 * @param {string} options.baseDirectory Ruta física de la Base ya abierta por el Motor.
 * @param {ScopeResolver} options.resolveScope
 * @param {number} [options.maxEntries]
 */
export function createFolderIndexer({ baseDirectory, resolveScope, maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
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
        const previous = await store.load(scopeId);
        const rootStats = await inspectRoot(scope.path);
        const { entries, issues } = await scanFolder(scope.path, {
          rootStats, previous: previous?.entries ?? [], maxEntries,
        });
        // La autorización se vuelve a consultar: una retirada durante el recorrido no se publica.
        await authorized(scopeId);
        const latest = await store.load(scopeId);
        if ((latest?.generation ?? 0) !== (previous?.generation ?? 0)) {
          throw new MotorError('INDEX_CONFLICT', 'Otro proceso actualizó este índice durante el recorrido.');
        }
        const indexedAt = new Date().toISOString();
        const generation = (previous?.generation ?? 0) + 1;
        await store.save({
          scopeId, root: scope.path, generation, createdAt: previous?.createdAt ?? indexedAt,
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
      await authorized(scopeId);
      return store.load(scopeId);
    },

    /** Retira solo el índice de la Base; admite ámbitos ya retirados. */
    async removeFolderIndex(scopeId) {
      validateScopeId(scopeId);
      return exclusive(scopeId, () => store.remove(scopeId));
    },
  });
}
