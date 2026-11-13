import path from 'node:path';
import { MotorError } from './errors.js';
import { contains, samePath, isExcluded, TRASH_DIRECTORY } from './paths.js';
import { scanFolder } from './index-scan.js';
import { createIndexStore, validateScopeId } from './index-store.js';
import { createResourceGovernor } from './resource-governor.js';
import { requestSignal as currentRequestSignal } from './request-context.js';

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
  if ((before.identity ?? null) !== (after.identity ?? null)) return true;
  // La fecha de una carpeta cambia con sus hijos; esos cambios se informan en los hijos.
  return after.type !== 'directory'
    && (before.size !== after.size || before.modifiedAt !== after.modifiedAt);
}

/** Compara dos pasadas; lo no comprobable no cuenta como añadido, cambiado ni eliminado. */
function compare(previous, current) {
  const before = new Map(previous.map((entry) => [entry.path, entry]));
  const now = new Set(current.map((entry) => entry.path));
  const changes = { added: [], modified: [], removed: [] };
  const addedEntries = new Map();
  const removedEntries = new Map();
  for (const entry of current) {
    if (entry.state === 'unverified') continue;
    const old = before.get(entry.path);
    if (!old || old.type === 'unknown') {
      changes.added.push(entry.path);
      addedEntries.set(entry.path, entry);
    } else if (changed(old, entry)) changes.modified.push(entry.path);
  }
  for (const entry of previous) {
    if (!now.has(entry.path)) {
      changes.removed.push(entry.path);
      removedEntries.set(entry.path, entry);
    }
  }
  // Metadatos no enumerables por delta para que observador y sesión no retengan todo el índice en RAM.
  Object.defineProperties(changes, {
    addedEntries: { value: addedEntries, configurable: true },
    removedEntries: { value: removedEntries, configurable: true },
  });
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

function requireSameScanScope(before, after) {
  requireSameAuthorization(before, after);
  if ((before.exclusions ?? []).join('\0') !== (after.exclusions ?? []).join('\0')) {
    throw new MotorError('INDEX_CONFLICT', 'Las exclusiones cambiaron durante el recorrido; se descarta la instantánea.');
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
  signal: lifecycleSignal, resourceSample, backgroundGate = null,
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
  const governor = createResourceGovernor(baseDirectory, { sample: resourceSample });
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

  const reconcile = (code, generation = null) => ({ status: 'needs-reconciliation', generation, code });
  const sameEntry = (first, second) => ['type', 'size', 'modifiedAt', 'changedAt', 'createdAt', 'state', 'reason']
    .every((field) => first[field] === second[field]);
  const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

  /** Las carpetas padre de relativePath deben figurar como carpetas indexadas. */
  function parentsCurrent(known, relativePath) {
    const parts = relativePath.split('/');
    for (let depth = 1; depth < parts.length; depth += 1) {
      const parent = known.get(parts.slice(0, depth).join('/'));
      if (parent?.type !== 'directory' || parent.state !== 'indexed') return false;
    }
    return true;
  }

  /**
   * Publica una actualización incremental bajo la cola del ámbito y el bloqueo
   * entre procesos, revalidando la autorización como recordCreatedFile.
   * prepare(index, scope) devuelve { result } para no publicar o
   * { entries, issues? } para publicar la generación siguiente.
   */
  async function publishIncremental(scopeId, prepare) {
    validateScopeId(scopeId);
    const requestedScope = await authorized(scopeId);
    return exclusive(scopeId, () => store.exclusive(scopeId, async () => {
      const scope = await authorized(scopeId);
      requireSameAuthorization(requestedScope, scope);
      const index = boundIndex(await store.load(scopeId), scope);
      const prepared = prepare(index, scope);
      if (prepared.result) return prepared.result;
      requireSameAuthorization(scope, await authorized(scopeId));
      const latest = boundIndex(await store.load(scopeId), scope);
      if (latest?.generation !== index.generation) return reconcile('INDEX_CONFLICT');
      const generation = index.generation + 1;
      // save valida la forma completa; una entrada mal formada no se publica.
      await store.save({ ...index, generation, entries: prepared.entries, issues: prepared.issues ?? index.issues });
      return { status: 'updated', generation, code: null, ...(prepared.extra ?? {}) };
    }));
  }

  /** Incorpora una entrada nueva (archivo o carpeta vacía) creada por el Motor. */
  function recordNewEntry(scopeId, entry, type, invalidCode) {
    return publishIncremental(scopeId, (index, scope) => {
      if (entry?.type !== type || entry.state !== 'indexed' || typeof entry.path !== 'string') {
        return { result: reconcile(invalidCode) };
      }
      if (isExcluded(scope.exclusions, entry.path)) return { result: reconcile('PATH_EXCLUDED') };
      if (!index) return { result: { status: 'not-indexed', generation: null, code: null } };
      const known = new Map(index.entries.map((item) => [item.path, item]));
      const existing = known.get(entry.path);
      if (existing) {
        return { result: sameEntry(existing, entry) ? { status: 'current', generation: index.generation, code: null }
          : reconcile('INDEX_ENTRY_CONFLICT', index.generation) };
      }
      if (!parentsCurrent(known, entry.path)) return { result: reconcile('INDEX_PARENT_NOT_CURRENT', index.generation) };
      if (index.entries.length + 1 > maxEntries) return { result: reconcile('INDEX_LIMIT_EXCEEDED', index.generation) };
      return { entries: [...index.entries, entry].sort(byPath) };
    });
  }

  return Object.freeze({
    resourceStatus: governor.status,
    async prioritizeIndex(scopeId, timeoutMs) {
      await authorized(scopeId);
      return governor.promote(scopeId, timeoutMs);
    },
    /**
     * Crea el índice inicial o lo reconcilia con el estado actual de la carpeta.
     * Si falla, el índice anterior permanece intacto.
     * @param {string} scopeId
     * @returns {Promise<IndexResult>}
     */
    async indexFolder(scopeId, { signal: requestSignal = currentRequestSignal(), priority = 'interactive', timeoutMs } = {}) {
      validateScopeId(scopeId);
      const signals = [lifecycleSignal, requestSignal].filter(Boolean);
      const signal = signals.length ? AbortSignal.any(signals) : undefined;
      signal?.throwIfAborted();
      const requestedScope = await authorized(scopeId);
      if (priority === 'background') {
        await backgroundGate?.waitForForegroundIdle?.({ signal });
      }
      return governor.run(() => exclusive(scopeId, async () => {
        signal?.throwIfAborted();
        if (priority === 'background') {
          await backgroundGate?.yieldIfNeeded?.({ signal });
        }
        let scope;
        const previous = await store.exclusive(scopeId, async () => {
          // A queued request keeps its authorization identity, but must use
          // the current exclusions when it is finally admitted.
          scope = await authorized(scopeId);
          requireSameAuthorization(requestedScope, scope);
          return boundIndex(await store.load(scopeId), scope);
        });
        // La papelera de Mind es una exclusión implícita: nunca se recorre ni se indexa.
        const { entries, issues } = await scanFolder(scope.path, {
          previous: previous?.entries ?? [], maxEntries, pythonExecutable,
          exclude: [...(scope.exclusions ?? []), TRASH_DIRECTORY],
          signal, timeoutMs,
        });
        // El recorrido no retiene el bloqueo. Se descarta si cambió su base.
        requireSameScanScope(scope, await authorized(scopeId));
        signal?.throwIfAborted();
        if (priority === 'background') {
          await backgroundGate?.yieldIfNeeded?.({ signal });
        }
        return store.exclusive(scopeId, async () => {
          requireSameScanScope(scope, await authorized(scopeId));
          const latest = boundIndex(await store.load(scopeId), scope);
          if (JSON.stringify(latest) !== JSON.stringify(previous)) {
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
      }), { signal, priority, scopeId });
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
      const requestedScope = await authorized(scopeId);
      return exclusive(scopeId, () => store.exclusive(scopeId, async () => {
        const scope = await authorized(scopeId);
        requireSameAuthorization(requestedScope, scope);
        const reconcile = (code, generation = null) => ({ status: 'needs-reconciliation', generation, code });
        if (entry?.type !== 'file' || entry.state !== 'indexed' || typeof entry.path !== 'string') {
          return reconcile('INVALID_CREATED_ENTRY');
        }
        if (isExcluded(scope.exclusions, entry.path)) return reconcile('PATH_EXCLUDED');
        const index = boundIndex(await store.load(scopeId), scope);
        if (!index) return { status: 'not-indexed', generation: null, code: null };
        const known = new Map(index.entries.map((item) => [item.path, item]));
        const existing = known.get(entry.path);
        if (existing) {
          const same = ['type', 'size', 'modifiedAt', 'changedAt', 'createdAt', 'identity', 'state', 'reason']
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
      }));
    },

    /**
     * Sustituye la entrada del archivo que el Motor acaba de modificar, sin recorrer
     * la carpeta. Solo publica si el índice vigente ya tenía ese nombre como archivo;
     * si no lo conocía o era otro tipo, deja el índice intacto y pide una
     * reconciliación explícita con indexFolder. updatedAt sigue siendo la fecha del
     * último recorrido: la entrada aporta sus propias fechas.
     * @param {string} scopeId
     * @param {import('./index-scan.js').IndexEntry} entry
     * @returns {Promise<{ status: 'updated' | 'current' | 'not-indexed' | 'needs-reconciliation', generation: number | null, code: string | null }>}
     */
    async recordModifiedFile(scopeId, entry) {
      validateScopeId(scopeId);
      const requestedScope = await authorized(scopeId);
      return exclusive(scopeId, () => store.exclusive(scopeId, async () => {
        const scope = await authorized(scopeId);
        requireSameAuthorization(requestedScope, scope);
        const reconcile = (code, generation = null) => ({ status: 'needs-reconciliation', generation, code });
        if (entry?.type !== 'file' || entry.state !== 'indexed' || typeof entry.path !== 'string') {
          return reconcile('INVALID_MODIFIED_ENTRY');
        }
        if (isExcluded(scope.exclusions, entry.path)) return reconcile('PATH_EXCLUDED');
        const index = boundIndex(await store.load(scopeId), scope);
        if (!index) return { status: 'not-indexed', generation: null, code: null };
        const position = index.entries.findIndex((item) => item.path === entry.path);
        const existing = index.entries[position];
        if (!existing) return reconcile('INDEX_ENTRY_MISSING', index.generation);
        if (existing.type !== 'file') return reconcile('INDEX_ENTRY_CONFLICT', index.generation);
        const same = ['type', 'size', 'modifiedAt', 'changedAt', 'createdAt', 'identity', 'state', 'reason']
          .every((field) => existing[field] === entry[field]);
        if (same) return { status: 'current', generation: index.generation, code: null };
        requireSameAuthorization(scope, await authorized(scopeId));
        const latest = boundIndex(await store.load(scopeId), scope);
        if (latest?.generation !== index.generation) return reconcile('INDEX_CONFLICT');
        const entries = index.entries.with(position, entry);
        const generation = index.generation + 1;
        // save valida la forma completa; una entrada mal formada no se publica.
        await store.save({ ...index, generation, entries });
        return { status: 'updated', generation, code: null };
      }));
    },

    /**
     * Incorpora la carpeta vacía que el Motor acaba de crear, con las mismas
     * condiciones que recordCreatedFile: padres listados y verificados, sin otra
     * entrada con ese nombre. Si no, deja el índice intacto y pide reconciliar.
     * @param {string} scopeId
     * @param {import('./index-scan.js').IndexEntry} entry
     */
    recordCreatedDirectory(scopeId, entry) {
      return recordNewEntry(scopeId, entry, 'directory', 'INVALID_CREATED_ENTRY');
    },

    /**
     * Refleja un movimiento o cambio de nombre hecho por el Motor sin recorrer la
     * carpeta. Mover una carpeta cambia el prefijo de todos sus descendientes;
     * las entradas conservan sus metadatos y estado, y la movida toma los leídos
     * del objeto movido. Solo publica si el índice conocía el origen con ese tipo,
     * no tenía nada en el destino y conoce sus carpetas padre; si no, deja el
     * índice intacto y pide una reconciliación explícita.
     * @param {string} scopeId
     * @param {{ from: string, to: string, type: 'file' | 'directory', entry: import('./index-scan.js').IndexEntry }} move
     */
    recordMovedEntry(scopeId, { from, to, type, entry } = {}) {
      return publishIncremental(scopeId, (index, scope) => {
        if (typeof from !== 'string' || typeof to !== 'string' || from === to || !['file', 'directory'].includes(type)
            || entry?.type !== type || entry.path !== to || entry.state !== 'indexed') {
          return { result: reconcile('INVALID_MOVED_ENTRY') };
        }
        if (isExcluded(scope.exclusions, from) || isExcluded(scope.exclusions, to)) {
          return { result: reconcile('PATH_EXCLUDED') };
        }
        if (!index) return { result: { status: 'not-indexed', generation: null, code: null } };
        const known = new Map(index.entries.map((item) => [item.path, item]));
        const source = known.get(from);
        const target = known.get(to);
        const prefix = `${from}/`;
        if (!source) {
          // Otro proceso pudo reconciliar ya el movimiento.
          const settled = target && sameEntry(target, entry) && !index.entries.some((item) => item.path.startsWith(prefix));
          return { result: settled ? { status: 'current', generation: index.generation, code: null }
            : reconcile('INDEX_ENTRY_MISSING', index.generation) };
        }
        if (source.type !== type) return { result: reconcile('INDEX_ENTRY_CONFLICT', index.generation) };
        const destination = `${to}/`;
        if (target || index.entries.some((item) => item.path.startsWith(destination) && !item.path.startsWith(prefix))) {
          return { result: reconcile('INDEX_ENTRY_CONFLICT', index.generation) };
        }
        if (!parentsCurrent(known, to)) return { result: reconcile('INDEX_PARENT_NOT_CURRENT', index.generation) };
        const rename = (relative) => (relative === from ? to
          : relative.startsWith(prefix) ? `${to}${relative.slice(from.length)}` : relative);
        const entries = index.entries.map((item) => (item.path === from ? entry
          : item.path.startsWith(prefix) ? { ...item, path: rename(item.path) } : item)).sort(byPath);
        const issues = index.issues.map((issue) => (issue.path === '' ? issue : { ...issue, path: rename(issue.path) }))
          .sort(byPath);
        return { entries, issues };
      });
    },

    /**
     * Retira del índice la entrada que el Motor acaba de mover a la papelera y,
     * si es una carpeta, todos sus descendientes. Solo publica si el índice tenía
     * esa entrada con ese tipo; si ya no la tenía, el índice ya está al día.
     * @param {string} scopeId
     * @param {{ path: string, type: 'file' | 'directory' }} removal
     */
    recordRemovedEntry(scopeId, { path: relative, type } = {}) {
      return publishIncremental(scopeId, (index, scope) => {
        if (typeof relative !== 'string' || relative === '' || !['file', 'directory'].includes(type)) {
          return { result: reconcile('INVALID_REMOVED_ENTRY') };
        }
        if (isExcluded(scope.exclusions, relative)) return { result: reconcile('PATH_EXCLUDED') };
        if (!index) return { result: { status: 'not-indexed', generation: null, code: null } };
        const prefix = `${relative}/`;
        const existing = index.entries.find((item) => item.path === relative);
        const inside = (item) => item.path === relative || item.path.startsWith(prefix);
        const removed = index.entries.filter(inside);
        if (!existing) {
          return { result: removed.length === 0 ? { status: 'current', generation: index.generation, code: null }
            : reconcile('INDEX_ENTRY_MISSING', index.generation) };
        }
        if (existing.type !== type) return { result: reconcile('INDEX_ENTRY_CONFLICT', index.generation) };
        return {
          entries: index.entries.filter((item) => !inside(item)),
          issues: index.issues.filter((issue) => issue.path === '' || !inside(issue)),
          extra: { removed: removed.length },
        };
      });
    },

    /**
     * Cambia las exclusiones del ámbito bajo la misma coordinación que las
     * publicaciones y retira del índice vigente las entradas excluidas, para que
     * dejen de encontrarse en ese mismo momento. Lo que se vuelve a incluir
     * aparece en la siguiente reconciliación.
     * @param {string} scopeId
     * @param {() => Promise<string[] | null>} change Escribe el registro y devuelve las exclusiones vigentes.
     */
    async applyExclusions(scopeId, change) {
      validateScopeId(scopeId);
      return exclusive(scopeId, () => store.exclusive(scopeId, async () => {
        const exclusions = await change();
        if (exclusions === null) throw new MotorError('FOLDER_NOT_AUTHORIZED', 'La carpeta no está autorizada o fue retirada.');
        const scope = await authorized(scopeId);
        const index = boundIndex(await store.load(scopeId), scope);
        let removed = 0;
        if (index) {
          const entries = index.entries.filter((entry) => !isExcluded(exclusions, entry.path));
          const issues = index.issues.filter((issue) => issue.path === '' || !isExcluded(exclusions, issue.path));
          removed = index.entries.length - entries.length;
          if (removed > 0 || issues.length !== index.issues.length) {
            await store.save({ ...index, generation: index.generation + 1, entries, issues });
          }
        }
        return { exclusions, removedEntries: removed };
      }));
    },

    /** Retira el índice; revoke permite al Motor retirar primero el registro bajo el mismo bloqueo. */
    async removeFolderIndex(scopeId, revoke) {
      validateScopeId(scopeId);
      return exclusive(scopeId, () => store.exclusive(scopeId, async () => {
        const revoked = revoke ? await revoke() : undefined;
        const removed = await store.remove(scopeId);
        return revoke ? revoked : removed;
      }));
    },

    /** Libera los índices en caché de RAM cuando el Motor entra en reposo ligero. */
    clearCache: store.clearCache,
  });
}
