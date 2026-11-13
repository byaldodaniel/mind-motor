import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const QUEUE_PRIORITY = Object.freeze({
  READ: 1,
  WRITE: 2,
  BACKGROUND: 3,
});

const READ_TOOLS = new Set([
  'estado',
  'buscar',
  'explorar',
  'eliminados',
  'continuidad_consultar',
  'conversaciones_buscar',
  'conversacion_leer',
  'conversacion_preferencias',
  'destinos_consultar',
  'papelera',
  'propiedades',
  'indices_personalizados',
  'funciones',
  'historial_funcion',
]);

const CONTINUITY_TOOLS = new Set([
  'continuidad_registrar',
  'continuidad_actualizar',
  'continuidad_exportar',
  'continuidad_importar',
]);

const FUNCTION_WRITE_TOOLS = new Set([
  'crear_funcion',
  'modificar_funcion',
  'retirar_funcion',
  'ejecutar_funcion',
  'activar_funcion',
  'desactivar_funcion',
]);

const FOLDER_WRITE_TOOLS = new Set([
  'leer',
  'crear',
  'modificar',
  'editar',
  'crear_carpeta',
  'renombrar',
  'borrar',
  'restaurar',
  'vaciar_papelera',
  'asignar_propiedades',
]);

function normalizePathKey(prefix, raw) {
  if (typeof raw !== 'string' || !raw.trim()) return `${prefix}:default`;
  const trimmed = raw.trim();
  const normalized = process.platform === 'win32'
    ? path.normalize(trimmed).toLowerCase()
    : path.normalize(trimmed);
  return `${prefix}:${normalized}`;
}

export function classifyToolPriority(name, args = {}) {
  if (READ_TOOLS.has(name)) return QUEUE_PRIORITY.READ;
  if (name === 'destino_resolver' && args?.preparar !== true) return QUEUE_PRIORITY.READ;
  return QUEUE_PRIORITY.WRITE;
}

export async function resolveToolResourceKeys(name, args = {}, resolveFolderKey) {
  const folderKey = async (ref) => {
    if (typeof resolveFolderKey === 'function') {
      const resolved = await resolveFolderKey(ref);
      if (resolved) return `folder:${resolved}`;
    }
    return normalizePathKey('folder', ref);
  };

  if (name === 'mover') {
    const keys = [await folderKey(args?.carpeta)];
    if (typeof args?.carpeta_destino === 'string' && args.carpeta_destino.trim()) {
      keys.push(await folderKey(args.carpeta_destino));
    }
    return keys;
  }

  if (name === 'crear_indice') {
    const keys = [await folderKey(args?.carpeta)];
    if (typeof args?.carpeta_csv === 'string' && args.carpeta_csv.trim()) {
      keys.push(await folderKey(args.carpeta_csv));
    }
    return keys;
  }

  if (name === 'actualizar_indice' || name === 'modificar_indice' || name === 'retirar_indice') {
    return [`custom-index:${typeof args?.id === 'string' && args.id ? args.id : 'default'}`];
  }

  if (FOLDER_WRITE_TOOLS.has(name)) {
    if (typeof args?.carpeta === 'string' && args.carpeta.trim()) {
      return [await folderKey(args.carpeta)];
    }
    if (typeof args?.destino === 'string' && args.destino.trim()) {
      return [await folderKey(args.destino)];
    }
    if (typeof args?.conversacion === 'string' && args.conversacion.trim()) {
      return [`dest-conv:${args.conversacion.trim()}`];
    }
    if (typeof args?.proyecto === 'string' && args.proyecto.trim()) {
      return [`dest-proj:${args.proyecto.trim()}`];
    }
    return [await folderKey(undefined)];
  }

  if (name === 'solicitar_acceso') {
    if (typeof args?.ruta === 'string' && args.ruta.trim()) {
      return [normalizePathKey('access-path', args.ruta)];
    }
    return ['continuity'];
  }

  if (name === 'retirar_acceso') {
    if (typeof args?.carpeta === 'string' && args.carpeta.trim()) {
      return [await folderKey(args.carpeta)];
    }
    return ['continuity'];
  }

  if (name === 'destino_resolver' || name === 'resultado_importar' || name === 'resultado_registrar') {
    if (typeof args?.destino === 'string' && args.destino.trim()) {
      return [await folderKey(args.destino)];
    }
    if (typeof args?.conversacion === 'string' && args.conversacion.trim()) {
      return [`dest-conv:${args.conversacion.trim()}`];
    }
    if (typeof args?.proyecto === 'string' && args.proyecto.trim()) {
      return [`dest-proj:${args.proyecto.trim()}`];
    }
    return ['destinations:default'];
  }

  if (name === 'conversacion_guardar' || name === 'conversacion_trasladar') {
    return [`conversation:${typeof args?.id === 'string' && args.id ? args.id : 'new'}`];
  }

  if (name === 'conversacion_configurar') {
    return [`conversation-config:${typeof args?.id === 'string' && args.id ? args.id : 'global'}`];
  }

  if (name === 'conversaciones_preparar') return ['conversation-search-prep'];
  if (name === 'destinos_configurar') return ['destinations-config'];
  if (CONTINUITY_TOOLS.has(name)) return ['continuity'];
  if (name === 'crear_respaldo') return ['backup'];

  if (FUNCTION_WRITE_TOOLS.has(name)) {
    return [`function:${typeof args?.id === 'string' && args.id ? args.id : 'global'}`];
  }

  return [`tool:${name}`];
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : Object.assign(new Error('Operación cancelada.'), { name: 'AbortError' });
}

function awaitWithSignal(promise, signal) {
  if (!signal) return promise;
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(
      signal.reason instanceof Error
        ? signal.reason
        : Object.assign(new Error('Operación cancelada.'), { name: 'AbortError' }),
    );
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Cola inteligente en memoria de 3 prioridades:
 * - P1 (lectura): ejecución inmediata sin bloqueo mutuo.
 * - P2 (escritura / E/S Python): serializada solo por clave de recurso.
 * - P3 (fondo): cede cooperativamente mientras haya P1 o P2 activos o en espera.
 */
export function createSmartQueue({ backgroundYieldMs = 12 } = {}) {
  const resourceTails = new Map();
  const idleWaiters = new Set();
  let activeReads = 0;
  let activeWrites = 0;
  let queuedWrites = 0;
  let completedReads = 0;
  let completedWrites = 0;

  function hasForegroundDemand() {
    return activeReads > 0 || activeWrites > 0 || queuedWrites > 0;
  }

  function notifyIdleWaiters() {
    if (hasForegroundDemand()) return;
    for (const resolve of [...idleWaiters]) {
      idleWaiters.delete(resolve);
      resolve();
    }
  }

  async function waitForForegroundIdle({ signal, maxWaitMs = 2_000 } = {}) {
    throwIfAborted(signal);
    if (!hasForegroundDemand()) return;
    await new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        idleWaiters.delete(done);
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      const onAbort = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        idleWaiters.delete(done);
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : Object.assign(new Error('Operación cancelada.'), { name: 'AbortError' }),
        );
      };
      idleWaiters.add(done);
      signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(done, maxWaitMs);
      timer.unref?.();
    });
  }

  async function withResourceLocks(keys, fn, signal) {
    const ordered = [...new Set(keys)].sort();
    const releases = [];
    const predecessors = [];

    // Reserva todas las posiciones en orden determinista antes de esperar,
    // evitando bloqueos mutuos entre escrituras multirrecurso (mover, crear_indice).
    for (const key of ordered) {
      const prev = resourceTails.get(key) ?? Promise.resolve();
      let release;
      const next = new Promise((resolve) => { release = resolve; });
      const chained = prev.catch(() => {}).then(() => next);
      resourceTails.set(key, chained);
      predecessors.push(prev.catch(() => {}));
      releases.push({ key, chained, release });
    }

    try {
      await awaitWithSignal(Promise.all(predecessors), signal);
      throwIfAborted(signal);
      return await fn();
    } finally {
      for (let i = releases.length - 1; i >= 0; i -= 1) {
        const { key, chained, release } = releases[i];
        release();
        if (resourceTails.get(key) === chained) resourceTails.delete(key);
      }
    }
  }

  return Object.freeze({
    async runRead(fn, { signal } = {}) {
      throwIfAborted(signal);
      activeReads += 1;
      try {
        return await fn();
      } finally {
        activeReads = Math.max(0, activeReads - 1);
        completedReads += 1;
        notifyIdleWaiters();
      }
    },

    async runWrite(keysOrResolver, fn, { signal } = {}) {
      throwIfAborted(signal);
      queuedWrites += 1;
      let acquired = false;
      try {
        const rawKeys = typeof keysOrResolver === 'function' ? await keysOrResolver() : keysOrResolver;
        const keys = Array.isArray(rawKeys) && rawKeys.length > 0 ? rawKeys : ['general'];
        return await withResourceLocks(keys, async () => {
          queuedWrites = Math.max(0, queuedWrites - 1);
          acquired = true;
          activeWrites += 1;
          return await fn();
        }, signal);
      } finally {
        if (!acquired) queuedWrites = Math.max(0, queuedWrites - 1);
        else activeWrites = Math.max(0, activeWrites - 1);
        completedWrites += 1;
        notifyIdleWaiters();
      }
    },

    async runBackground(fn, { signal, maxWaitMs = 2_000 } = {}) {
      await waitForForegroundIdle({ signal, maxWaitMs });
      throwIfAborted(signal);
      return await fn();
    },

    async yieldIfNeeded({ signal, maxWaitMs = backgroundYieldMs } = {}) {
      if (!hasForegroundDemand()) return false;
      await Promise.race([
        waitForForegroundIdle({ signal, maxWaitMs }),
        delay(maxWaitMs, undefined, { signal, ref: false }),
      ]);
      return true;
    },

    hasForegroundDemand,
    waitForForegroundIdle,

    status() {
      return {
        activeReads,
        activeWrites,
        queuedWrites,
        activeLocks: resourceTails.size,
        completedReads,
        completedWrites,
        foregroundBusy: hasForegroundDemand(),
      };
    },
  });
}
