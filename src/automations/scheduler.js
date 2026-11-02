import { matchingChanges, mergeChanges, changesInput } from './schedule.js';
import { functionServiceFor } from './service.js';

/**
 * Programador de automatizaciones durante una sesión de Mind (sin servicio
 * residente). Lo que vence se ejecuta con temporizadores unref(); los cambios
 * reconciliados de la sesión (session.onChanges) disparan las automatizaciones
 * por evento, agrupando ráfagas. Al empezar, ejecuta como máximo una vez cada
 * automatización cuyo turno venció con Mind cerrado. close() lo detiene todo.
 *
 * Cada ejecución pasa por service.execute: bloqueo por función en la Base y
 * marca del último turno, de modo que otra sesión o `mind programadas` no la
 * duplican. El reloj y los temporizadores son inyectables para las pruebas.
 */

export const TICK_MS = 60_000;
/** Una ráfaga de cambios no retrasa la ejecución más de este múltiplo de la espera. */
const MAX_WAIT_FACTOR = 10;
const MAX_WAIT_MS = 30 * 60_000;
const DEFAULT_TIMERS = Object.freeze({
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle),
});

/**
 * @param {{ service: object, now?: () => number, timers?: { setTimeout: Function, clearTimeout: Function },
 *   subscribe?: (listener: Function) => (() => void) | void, log?: Function, tickMs?: number }} options
 */
export function createAutomationScheduler({ service, now = Date.now, timers = DEFAULT_TIMERS, subscribe = null, log = () => {}, tickMs = TICK_MS }) {
  const startedAt = now();
  let closed = false;
  let started = false;
  let timer = null;
  let ticking = null;
  let again = false;
  let unsubscribe = null;
  let unlisten = null;
  /** Automatizaciones por evento vigentes, según la última evaluación. */
  let events = new Map();
  /** Ráfagas agrupadas por función: { cambios, firstAt, timer }. */
  const bursts = new Map();
  /** Ejecuciones en curso en este proceso, encadenadas por función. */
  const chains = new Map();
  const inFlight = new Set();
  /** Archivos escritos por la última ejecución de cada automatización (no la vuelven a disparar). */
  const ownWrites = new Map();

  function schedule(callback, ms) {
    const handle = timers.setTimeout(callback, Math.max(0, ms));
    handle?.unref?.();
    return handle;
  }

  function track(promise) {
    inFlight.add(promise);
    promise.finally(() => inFlight.delete(promise)).catch(() => {});
    return promise;
  }

  /** Ejecuciones de una misma función, en orden, sin solaparse en este proceso. */
  function run(id, options) {
    const previous = chains.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      if (closed) return { estado: 'omitida', motivo: 'sesion-cerrada' };
      const outcome = await service.execute(id, { ...options, automatic: true });
      if (outcome.estado === 'completada') {
        const written = Array.isArray(outcome.resultado?.archivos) ? outcome.resultado.archivos : [];
        ownWrites.set(id, new Set(written.filter((item) => item && typeof item.ruta === 'string')
          .map((item) => `${item.carpeta}\u0000${item.ruta}`)));
      }
      if (outcome.estado === 'fallida') log('aviso', 'Una automatización falló', { funcion: id, codigo: outcome.codigo });
      return outcome;
    });
    chains.set(id, next);
    next.finally(() => {
      if (chains.get(id) === next) chains.delete(id);
    }).catch(() => {});
    return track(next.catch((error) => {
      log('error', 'No se pudo ejecutar una automatización', { funcion: id, error: String(error?.stack ?? error) });
      return { estado: 'fallida', codigo: error?.code ?? 'ERROR_INTERNO' };
    }));
  }

  function arm(ms) {
    if (closed) return;
    if (timer !== null) timers.clearTimeout(timer);
    timer = schedule(() => {
      timer = null;
      tick().catch(() => {});
    }, ms);
  }

  /** Evalúa las autorizaciones, ejecuta lo vencido y reprograma el siguiente turno. */
  async function tick() {
    if (closed) return undefined;
    if (ticking) {
      again = true;
      return ticking;
    }
    ticking = (async () => {
      let wake = tickMs;
      try {
        const authorized = await service.authorized({ nowMs: now() });
        events = new Map(authorized.filter((item) => item.estado === 'activa' && item.activation?.tipo === 'evento')
          .map((item) => [item.id, item]));
        for (const item of authorized) {
          if (closed) break;
          if (item.estado !== 'activa' || item.due === null) continue;
          // Venció antes de abrir esta sesión: recuperación (una sola, la del último turno).
          await run(item.id, { origin: item.due < startedAt ? 'recuperacion' : 'horario', slot: item.due });
        }
        const current = now();
        for (const item of authorized) {
          if (item.estado === 'activa' && item.next !== null) wake = Math.min(wake, item.next - current);
        }
      } catch (error) {
        log('aviso', 'No se pudieron evaluar las automatizaciones', { error: String(error?.stack ?? error) });
      } finally {
        ticking = null;
      }
      if (again) {
        again = false;
        wake = 0;
      }
      arm(wake);
      return undefined;
    })();
    return ticking;
  }

  function fire(id) {
    const burst = bursts.get(id);
    bursts.delete(id);
    if (closed || !burst) return;
    run(id, { origin: 'evento', changes: changesInput(burst.folderId, burst.cambios) });
  }

  function onChanges({ folderId, changes }) {
    if (closed) return;
    for (const [id, item] of events) {
      if (item.activation.carpeta !== folderId) continue;
      const written = ownWrites.get(id);
      const matched = matchingChanges(item.activation, changes, (relativePath) => written?.has(`${folderId}\u0000${relativePath}`) ?? false);
      if (!matched) continue;
      let burst = bursts.get(id);
      if (!burst) {
        burst = { folderId, firstAt: now(), timer: null, cambios: { agregados: new Set(), modificados: new Set(), eliminados: new Set() } };
        bursts.set(id, burst);
      }
      mergeChanges(burst.cambios, matched);
      const wait = item.activation.esperaSegundos * 1000;
      const limit = burst.firstAt + Math.min(wait * MAX_WAIT_FACTOR, MAX_WAIT_MS);
      if (burst.timer !== null) timers.clearTimeout(burst.timer);
      burst.timer = schedule(() => fire(id), Math.min(wait, Math.max(0, limit - now())));
    }
  }

  /** Reevalúa pronto (por ejemplo, tras activar o desactivar desde la herramienta). */
  function refresh() {
    if (!closed && started) arm(0);
  }

  return Object.freeze({
    /** Empieza sin bloquear: la primera evaluación (con la recuperación) es asíncrona. */
    start() {
      if (started || closed) return;
      started = true;
      if (subscribe) unsubscribe = subscribe(onChanges) ?? null;
      unlisten = service.onChange(refresh);
      arm(0);
    },

    tick,
    refresh,

    /** Espera a que terminen la evaluación y las ejecuciones en curso. */
    async idle() {
      for (;;) {
        const pending = [...inFlight, ...(ticking ? [ticking] : [])];
        if (pending.length === 0) return;
        await Promise.allSettled(pending);
      }
    },

    /** Estado para diagnóstico: próximo despertar y ráfagas pendientes. */
    status() {
      return { activo: started && !closed, eventos: [...events.keys()], rafagas: [...bursts.keys()], enCurso: inFlight.size };
    },

    async close() {
      if (closed) return;
      closed = true;
      if (timer !== null) timers.clearTimeout(timer);
      timer = null;
      for (const burst of bursts.values()) if (burst.timer !== null) timers.clearTimeout(burst.timer);
      bursts.clear();
      unsubscribe?.();
      unlisten?.();
      await Promise.allSettled([...inFlight, ...(ticking ? [ticking] : [])]);
    },
  });
}

const schedulers = new WeakMap();

/** Programador activo de una sesión, si lo hay (solo en sesiones con observación). */
export function schedulerFor(session) {
  return schedulers.get(session) ?? null;
}

/**
 * Extensión de la sesión (src/session-extensions.js). Solo actúa en sesiones con
 * observación (la sesión MCP de un agente): las operaciones individuales de la
 * consola no programan nada; fuera de sesión ejecuta `mind programadas`.
 */
export function createAutomationExtension(session) {
  let scheduler = null;
  return {
    async start() {
      if (!session.observing()) return;
      scheduler = createAutomationScheduler({
        service: functionServiceFor(session),
        subscribe: (listener) => session.onChanges(listener),
        log: session.log,
      });
      schedulers.set(session, scheduler);
      scheduler.start();
    },
    async close() {
      const current = scheduler;
      scheduler = null;
      schedulers.delete(session);
      await current?.close();
    },
  };
}
