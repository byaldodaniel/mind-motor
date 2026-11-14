import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';

export const QUEUE_PRIORITY = Object.freeze({
  READ: 1,
  WRITE: 2,
  BACKGROUND: 3,
});

// `leer` es lectura pura: abre el archivo por un solo handle sin impedir
// escrituras ajenas, y `crear`/`modificar` publican con un renombrado atómico
// (temporal + rename). Un lector ve el contenido anterior o el nuevo, nunca uno
// a medias; la versión que devuelve protege la escritura posterior.
const READ_TOOLS = new Set([
  'estado',
  'buscar',
  'explorar',
  'leer',
  'eliminados',
  'continuidad_consultar',
  'conversaciones_buscar',
  'conversacion_leer',
  'conversacion_preferencias',
  'destinos_consultar',
  'actualizacion_consultar',
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

/**
 * Normaliza una ruta para usarla como clave, igual en todos los sistemas.
 * Se compara sin distinguir mayúsculas y en forma NFC porque Windows y macOS
 * suelen no distinguirlas (y macOS entrega nombres en NFD). En un volumen que
 * sí las distingue, dos rutas distintas pueden compartir clave: solo se
 * serializan de más, nunca se pierde exclusión.
 */
function pathKeyText(raw) {
  let value = path.normalize(raw.trim()).normalize('NFC').toLowerCase();
  while (value.length > 1 && /[\\/]$/.test(value) && !/^[a-z]:[\\/]$/.test(value)) value = value.slice(0, -1);
  return value;
}

function pathKey(prefix, raw) {
  if (typeof raw !== 'string' || !raw.trim()) return `${prefix}:default`;
  return `${prefix}:${pathKeyText(raw)}`;
}

const hasText = (value) => typeof value === 'string' && value.trim() !== '';

export function classifyToolPriority(name, args = {}) {
  if (READ_TOOLS.has(name)) return QUEUE_PRIORITY.READ;
  if (name === 'destino_resolver' && args?.preparar !== true) return QUEUE_PRIORITY.READ;
  return QUEUE_PRIORITY.WRITE;
}

export async function resolveToolResourceKeys(name, args = {}, resolveFolderKey) {
  const folderKey = async (ref) => {
    if (typeof resolveFolderKey === 'function') {
      const resolved = await resolveFolderKey(ref);
      if (hasText(resolved)) return `folder:${pathKeyText(resolved)}`;
    }
    return pathKey('folder', ref);
  };
  // Destino de una creación: destino explícito, conversación o proyecto.
  const destinationKeys = async (fallback) => {
    if (hasText(args?.destino)) return [await folderKey(args.destino)];
    if (hasText(args?.conversacion)) return [`dest-conv:${args.conversacion.trim()}`];
    if (hasText(args?.proyecto)) return [`dest-proj:${args.proyecto.trim()}`];
    return fallback();
  };

  if (name === 'mover' || name === 'crear_indice') {
    const second = name === 'mover' ? args?.carpeta_destino : args?.carpeta_csv;
    const keys = [await folderKey(args?.carpeta)];
    if (hasText(second)) keys.push(await folderKey(second));
    return keys;
  }

  if (name === 'actualizar_indice' || name === 'modificar_indice' || name === 'retirar_indice') {
    return [`custom-index:${hasText(args?.id) ? args.id : 'default'}`];
  }

  if (FOLDER_WRITE_TOOLS.has(name)) {
    if (hasText(args?.carpeta)) return [await folderKey(args.carpeta)];
    return destinationKeys(async () => [await folderKey(undefined)]);
  }

  if (name === 'solicitar_acceso') {
    return hasText(args?.ruta) ? [pathKey('access-path', args.ruta)] : ['continuity'];
  }

  if (name === 'retirar_acceso') {
    return hasText(args?.carpeta) ? [await folderKey(args.carpeta)] : ['continuity'];
  }

  if (name === 'destino_resolver' || name === 'resultado_importar' || name === 'resultado_registrar') {
    return destinationKeys(async () => ['destinations:default']);
  }

  if (name === 'conversacion_guardar' || name === 'conversacion_trasladar') {
    return [`conversation:${hasText(args?.id) ? args.id : 'new'}`];
  }

  if (name === 'conversacion_configurar') {
    return [`conversation-config:${hasText(args?.id) ? args.id : 'global'}`];
  }

  if (name === 'conversaciones_preparar') return ['conversation-search-prep'];
  if (name === 'destinos_configurar') return ['destinations-config'];
  if (CONTINUITY_TOOLS.has(name)) return ['continuity'];
  if (name === 'crear_respaldo') return ['backup'];

  if (FUNCTION_WRITE_TOOLS.has(name)) {
    return [`function:${hasText(args?.id) ? args.id : 'global'}`];
  }

  return [`tool:${name}`];
}

function abortError(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : Object.assign(new Error('Operación cancelada.'), { name: 'AbortError' });
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal);
}

/**
 * Cola en memoria de 3 prioridades:
 * - P1 (lectura): ejecución inmediata, sin exclusión.
 * - P2 (escritura): exclusiva por clave de recurso, en orden de llegada.
 * - P3 (fondo): cede mientras haya lecturas o escrituras activas o en espera.
 *
 * Una escritura puede soltar su exclusión mientras espera al usuario
 * (`suspendWhile`); al terminar la espera vuelve a la cola de sus mismas claves.
 */
export function createSmartQueue({ backgroundYieldMs = 12 } = {}) {
  // Por clave, las reservas en orden de llegada; la cabeza es la que la tiene.
  const locks = new Map();
  const idleWaiters = new Set();
  const writeContext = new AsyncLocalStorage();
  // Cada escritura está en un solo estado: queued, held, suspended o done.
  const counts = { queued: 0, held: 0, suspended: 0 };
  // Trabajos de fondo que una llamada en primer plano está esperando (clave → cuántas).
  const expedited = new Map();
  let activeReads = 0;
  let completedReads = 0;
  let completedWrites = 0;

  function hasForegroundDemand() {
    return activeReads > 0 || counts.held > 0 || counts.queued > 0;
  }

  function notifyIdleWaiters() {
    if (hasForegroundDemand()) return;
    for (const done of [...idleWaiters]) done();
  }

  function setState(ctx, next) {
    if (ctx.state === next || ctx.state === 'done') return;
    if (ctx.state in counts) counts[ctx.state] -= 1;
    if (next in counts) counts[next] += 1;
    ctx.state = next;
    notifyIdleWaiters();
  }

  const isHead = (reservation) => reservation.keys.every((key) => locks.get(key)[0] === reservation);

  /**
   * Reserva todas las claves en un mismo paso síncrono. Como cada reserva entra
   * a la vez en todas sus colas, dos reservas guardan el mismo orden en cada
   * clave que comparten y no puede haber interbloqueo entre escrituras
   * multiclave. release() es idempotente y sirve también para abandonar una
   * reserva que aún espera.
   */
  function reserve(keys) {
    let settle;
    const reservation = {
      keys,
      status: 'waiting',
      granted: new Promise((resolve) => { settle = resolve; }),
      grant() {
        reservation.status = 'granted';
        settle(true);
      },
      release() {
        if (reservation.status === 'released') return;
        if (reservation.status === 'waiting') settle(false);
        reservation.status = 'released';
        for (const key of keys) {
          const queue = locks.get(key);
          queue.splice(queue.indexOf(reservation), 1);
          if (queue.length === 0) locks.delete(key);
        }
        for (const key of keys) {
          const head = locks.get(key)?.[0];
          if (head?.status === 'waiting' && isHead(head)) head.grant();
        }
      },
    };
    for (const key of keys) {
      if (!locks.has(key)) locks.set(key, []);
      locks.get(key).push(reservation);
    }
    if (isHead(reservation)) reservation.grant();
    return reservation;
  }

  /** Pone la escritura a la cola de sus claves; si se cancela, abandona la reserva. */
  async function acquire(ctx, stateOnFailure) {
    if (ctx.signal?.aborted) {
      setState(ctx, stateOnFailure);
      throw abortError(ctx.signal);
    }
    const reservation = reserve(ctx.keys);
    ctx.reservation = reservation;
    setState(ctx, 'queued');
    const onAbort = () => reservation.release();
    ctx.signal?.addEventListener('abort', onAbort, { once: true });
    let granted;
    try {
      granted = await reservation.granted;
    } finally {
      ctx.signal?.removeEventListener('abort', onAbort);
    }
    // La escritura terminó mientras esta reserva esperaba: ya no hay nada que tener.
    if (ctx.state === 'done') return;
    if (!granted) {
      ctx.reservation = null;
      setState(ctx, stateOnFailure);
      throw abortError(ctx.signal);
    }
    setState(ctx, 'held');
  }

  function releaseReservation(ctx) {
    ctx.reservation?.release();
    ctx.reservation = null;
  }

  /** Recupera la exclusión tras una suspensión; las suspensiones hermanas comparten el intento. */
  async function resume(ctx) {
    if (ctx.state === 'suspended') {
      ctx.resuming = acquire(ctx, 'suspended').finally(() => { ctx.resuming = null; });
    }
    if (ctx.resuming) await ctx.resuming;
  }

  /** El trabajo de fondo `key` debe ceder: hay demanda en primer plano y nadie lo está esperando. */
  const mustYield = (key) => hasForegroundDemand() && !(key !== undefined && expedited.has(key));

  async function waitForForegroundIdle({ signal, maxWaitMs = 2_000, key } = {}) {
    throwIfAborted(signal);
    if (!mustYield(key)) return;
    await new Promise((resolve, reject) => {
      const finish = (error) => {
        clearTimeout(timer);
        idleWaiters.delete(done);
        signal?.removeEventListener('abort', onAbort);
        if (error) reject(error);
        else resolve();
      };
      const done = () => finish();
      done.key = key;
      const onAbort = () => finish(abortError(signal));
      const timer = setTimeout(done, maxWaitMs);
      timer.unref?.();
      idleWaiters.add(done);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  return Object.freeze({
    async runRead(fn, { signal } = {}) {
      throwIfAborted(signal);
      activeReads += 1;
      try {
        return await fn();
      } finally {
        activeReads -= 1;
        completedReads += 1;
        notifyIdleWaiters();
      }
    },

    async runWrite(keysOrResolver, fn, { signal } = {}) {
      throwIfAborted(signal);
      const ctx = { keys: null, signal, state: 'new', reservation: null, resuming: null };
      // Mientras se resuelven las claves ya cuenta como escritura en espera.
      setState(ctx, 'queued');
      try {
        const rawKeys = typeof keysOrResolver === 'function' ? await keysOrResolver() : keysOrResolver;
        const keys = Array.isArray(rawKeys) ? rawKeys.filter((key) => typeof key === 'string' && key) : [];
        ctx.keys = keys.length > 0 ? [...new Set(keys)] : ['general'];
        await acquire(ctx, 'queued');
        return await writeContext.run({ ctx, suspended: false }, fn);
      } finally {
        releaseReservation(ctx);
        setState(ctx, 'done');
        completedWrites += 1;
      }
    },

    /**
     * Ejecuta fn sin retener la exclusión de la escritura en curso (p. ej.,
     * mientras se espera una confirmación del usuario) y la recupera, a la cola
     * de las mismas claves, antes de devolver su resultado o propagar su error.
     * Fuera de una escritura, o dentro de otra suspensión, solo ejecuta fn.
     * Si la escritura se cancela mientras vuelve a la cola, propaga la
     * cancelación sin retener nada. Lo observado antes de suspender puede haber
     * cambiado al volver.
     */
    async suspendWhile(fn) {
      const store = writeContext.getStore();
      const ctx = store?.ctx;
      if (!ctx || store.suspended || ctx.state === 'done') return await fn();
      if (ctx.state === 'held') {
        releaseReservation(ctx);
        setState(ctx, 'suspended');
      }
      let outcome;
      try {
        outcome = { value: await writeContext.run({ ctx, suspended: true }, fn) };
      } catch (error) {
        outcome = { error };
      }
      // Cada suspensión que termina recupera la exclusión: el código que sigue
      // siempre corre con ella, aunque una suspensión hermana siga esperando.
      await resume(ctx);
      if ('error' in outcome) throw outcome.error;
      return outcome.value;
    },

    async runBackground(fn, { signal, maxWaitMs = 2_000 } = {}) {
      await waitForForegroundIdle({ signal, maxWaitMs });
      throwIfAborted(signal);
      return await fn();
    },

    async yieldIfNeeded({ signal, maxWaitMs = backgroundYieldMs, key } = {}) {
      if (!mustYield(key)) return false;
      await waitForForegroundIdle({ signal, maxWaitMs, key });
      return true;
    },

    /**
     * Una llamada en primer plano espera el resultado del trabajo de fondo `key`
     * (p. ej., una búsqueda que necesita el recorrido inicial de su carpeta): ese
     * trabajo deja de ceder, porque cedería justamente ante quien lo espera.
     * Devuelve la función que retira la prisa; es idempotente.
     */
    expedite(key) {
      expedited.set(key, (expedited.get(key) ?? 0) + 1);
      for (const done of [...idleWaiters]) if (done.key === key) done();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const remaining = expedited.get(key) - 1;
        if (remaining > 0) expedited.set(key, remaining);
        else expedited.delete(key);
      };
    },

    hasForegroundDemand,
    waitForForegroundIdle,

    status() {
      return {
        activeReads,
        activeWrites: counts.held,
        queuedWrites: counts.queued,
        suspendedWrites: counts.suspended,
        activeLocks: locks.size,
        completedReads,
        completedWrites,
        foregroundBusy: hasForegroundDemand(),
      };
    },
  });
}
