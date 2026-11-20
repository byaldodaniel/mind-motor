import { productPaths } from './layout.js';
import { identifyCurrentProcess, inspectProcessOwners } from './process-identity.js';
import { writeJson } from './storage.js';
import { ensureUserDataDirectory } from './user-data-directory.js';
import { lockInstallation } from './installation-lock.js';
import { cleanStaleBaseTemporaries } from './connector.js';
import fs from 'node:fs/promises';
import { watch as fsWatch } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { MotorError } from './errors.js';
import { openMotor } from './motor.js';
import { ensureBase } from './base-format.js';
import { createAccessPolicy } from './access-policy.js';
import { createConsentRequests } from './consent.js';
import { createRemovalLog } from './removals.js';
import { SESSION_EXTENSIONS } from './session-extensions.js';
import { createBackgroundLease } from './background-coordinator.js';
import { closePersistentScanner } from './index-scan.js';
import { setTimeout as delay } from 'node:timers/promises';
import { withRequestContext, requestSignal, waitForRequest } from './request-context.js';

const SYNC_INTERVAL_MS = 30_000;
const OWNER_CHECK_MS = 2_000;
const CLOSE_TIMEOUT_MS = 5_000;
/** Recorridos iniciales simultáneos: con muchas carpetas, el inicio no satura el equipo. */
const INITIAL_SCANS = 2;
const SESSIONS_DIRECTORY = 'sesiones';

/** Registro de auditoría local: decisiones de acceso y operaciones sobre originales, sin contenido. */
function createAudit(baseDirectory) {
  const file = path.join(baseDirectory, 'auditoria.jsonl');
  const recentOpens = new Map();
  return async function audit(event, data = {}) {
    if (event === 'carpeta-abierta' && data?.carpeta) {
      const key = `${data.carpeta}:${data.canal ?? ''}`;
      const now = Date.now();
      const prev = recentOpens.get(key);
      if (prev && now - prev < 60_000) return;
      recentOpens.set(key, now);
    }
    const line = `${JSON.stringify({ fecha: new Date().toISOString(), evento: event, ...data })}\n`;
    await fs.appendFile(file, line, { encoding: 'utf8', mode: 0o600 });
  };
}

/**
 * Sesión del Motor ligada al uso de un agente (opción B aprobada):
 *
 * - abre la Base existente o la inicializa en el primer uso;
 * - recupera autorizaciones y decisiones de acceso;
 * - al empezar, reconcilia cada carpeta registrada (recupera lo que cambió
 *   mientras Mind estuvo cerrado) y activa la observación;
 * - al cerrar, detiene observadores y temporizadores; no queda nada residente.
 *
 * Con observe=false (operaciones individuales) no hay observación: cada consulta
 * reconcilia bajo demanda la carpeta que necesita.
 *
 * @param {{ layout: object, motorVersion: string, log?: Function, observe?: boolean, functionExecutors?: object }} options
 */
export async function openSession({ layout, motorVersion, log = () => {}, observe = true, functionExecutors = {},
  motorFactory = openMotor, backgroundGate = null, installationLeaseHeld = false }) {
  const releaseStartup = layout.product && !installationLeaseHeld ? await lockInstallation(layout.root, { pythonExecutable: layout.pythonExecutable }) : async () => {};
  try {
  await ensureUserDataDirectory(layout);
  const base = await ensureBase(layout.baseDirectory, { motorVersion, protectedFrom: layout.motorDirectory });
  const lifecycle = new AbortController();
  const motor = await motorFactory({
    baseDirectory: base.baseDirectory,
    pythonExecutable: layout.pythonExecutable,
    protectedDirectories: layout.protectedDirectories,
    userDataDirectory: layout.userDataDirectory,
    functionExecutors,
    signal: lifecycle.signal,
    backgroundGate,
  });
  const policy = createAccessPolicy({ baseDirectory: motor.baseDirectory, getAuthorizedFolder: motor.getAuthorizedFolder });
  const requests = createConsentRequests(motor.baseDirectory);
  const removals = createRemovalLog({ baseDirectory: motor.baseDirectory, getAuthorizedFolder: motor.getAuthorizedFolder });
  const audit = createAudit(motor.baseDirectory);
  const sessionId = randomUUID();
  const lease = observe ? createBackgroundLease(motor.baseDirectory, sessionId, { pythonExecutable: layout.pythonExecutable }) : null;
  const sessionsDirectory = path.join(motor.baseDirectory, SESSIONS_DIRECTORY);
  const sessionFile = path.join(sessionsDirectory, `sesion-${sessionId}.json`);
  const folders = new Map();
  const listeners = new Set();
  let observer = null;
  let syncTimer = null;
  let started = false;
  let closed = false;
  let syncing = null;
  let lastSyncAt = 0;
  let closing = null;
  let registryWatcher = null;
  let registryWake = null;

  function watchRegistry() {
    try {
      registryWatcher = fsWatch(motor.baseDirectory, { persistent: false }, (_type, filename) => {
        // A follower can authorize a new scope. Ignore index/queue/audit writes
        // so normal background activity cannot trigger a synchronization loop.
        if (closed || (filename != null && !/^folder-authorization-[a-f0-9]{64}\.json$/.test(String(filename)))) return;
        clearTimeout(registryWake);
        registryWake = setTimeout(() => {
          registryWake = null;
          sync().catch((error) => log('aviso', 'No se pudo actualizar el registro compartido', { error: String(error) }));
        }, 80);
        registryWake.unref?.();
      });
      registryWatcher.on('error', () => {
        registryWatcher?.close();
        registryWatcher = null; // The periodic registry check remains available.
      });
    } catch { registryWatcher = null; }
  }

  await fs.mkdir(sessionsDirectory, { recursive: true, mode: 0o700 });
  const ownerIdentity = await identifyCurrentProcess({ pythonExecutable: layout.pythonExecutable });
  const sessionRecord = { format: 'mind-session', version: 2, id: sessionId, ...ownerIdentity,
    startedAt: new Date().toISOString(), observe };
  await writeJson(sessionFile, sessionRecord);
  const installationSession = layout.product ? path.join(layout.installationStateDirectory ?? productPaths(layout.root, layout.manifest).installationStateDirectory, SESSIONS_DIRECTORY, `sesion-${sessionId}.json`) : null;
  if (installationSession) {
    await fs.mkdir(path.dirname(installationSession), { recursive: true, mode: 0o700 });
    await writeJson(installationSession, sessionRecord);
  }
  await releaseStartup();

  function track(folderId) {
    let state = folders.get(folderId);
    if (!state) {
      state = { ready: null, lastReport: null, lastError: null, lastChanges: null,
        halted: null, haltRetryCount: 0, haltRetryTimer: null, configuration: null, chain: Promise.resolve() };
      folders.set(folderId, state);
    }
    return state;
  }

  function scheduleHaltedRetry(folderId) {
    const state = track(folderId);
    if (closed || !observe || !state.halted || state.haltRetryTimer) return;
    if (!['SAFE_SCAN_UNAVAILABLE', 'SCOPE_UNAVAILABLE'].includes(state.halted)) return;
    const waitMs = Math.min(15_000 * (2 ** state.haltRetryCount), 300_000);
    state.haltRetryTimer = setTimeout(() => {
      state.haltRetryTimer = null;
      if (closed || !state.halted) return;
      state.haltRetryCount += 1;
      state.halted = null;
      state.ready = null;
      begin(folderId);
    }, waitMs);
    state.haltRetryTimer.unref?.();
  }

  /** Anota lo desaparecido usando las entradas salientes del delta sin retener todo el índice en RAM. */
  function trackRemovals(folderId, changes) {
    const removed = changes?.removed ?? [];
    const previous = changes?.removedEntries ?? null;
    const state = track(folderId);
    state.chain = state.chain.then(async () => {
      if (removed.length > 0 && previous) await removals.record(folderId, removed, previous);
      // Lo que desapareció ya no tiene propiedades: un elemento nuevo con ese nombre no las hereda.
      if (removed.length > 0) await motor.dropProperties(folderId, removed).catch(() => {});
    }).catch((error) => log('aviso', 'No se pudo anotar lo eliminado', { carpeta: folderId, error: String(error) }));
    return state.chain;
  }

  function onReport(report) {
    const state = track(report.folderId);
    if (report.type === 'reconciled') trackRemovals(report.folderId, report.changes);
    state.lastReport = { type: report.type, at: new Date().toISOString(), ...(report.code ? { code: report.code } : {}) };
    if (report.type === 'error' || report.type === 'degraded') {
      state.lastError = report.code ?? null;
      log('aviso', 'Observación con incidencias', { carpeta: report.folderId, tipo: report.type, codigo: report.code });
    }
    if (report.type === 'reconciled') {
      state.lastError = null;
      state.halted = null;
      state.haltRetryCount = 0;
      clearTimeout(state.haltRetryTimer);
      state.haltRetryTimer = null;
      if (report.changes) {
        state.lastChanges = { at: state.lastReport.at, ...report.changes };
        const total = report.changes.added.length + report.changes.modified.length + report.changes.removed.length;
        if (total > 0) for (const listener of listeners) {
          Promise.resolve().then(() => listener({ folderId: report.folderId, changes: report.changes, reasons: report.reasons ?? [] }))
            .catch((error) => log('error', 'Fallo de un oyente de cambios', { error: String(error) }));
        }
      }
    }
    if (report.type === 'stopped') {
      state.ready = null;
      if (report.code && report.reason !== 'revoked') {
        state.halted = report.code;
        state.lastError = report.code;
      }
      log('info', 'Observación detenida', { carpeta: report.folderId, motivo: report.reason });
    }
  }

  // Semáforo sencillo para los recorridos iniciales.
  let activeScans = 0;
  const waitingScans = [];
  async function scanSlot(task) {
    if (activeScans >= INITIAL_SCANS) await new Promise((resolve) => waitingScans.push(resolve));
    activeScans += 1;
    try {
      lifecycle.signal.throwIfAborted();
      return await task();
    } finally {
      activeScans -= 1;
      waitingScans.shift()?.();
    }
  }

  function begin(folderId) {
    const state = track(folderId);
    if (closed || state.halted) return Promise.resolve({ mode: 'stopped', code: state.halted });
    if (state.ready) return state.ready;
    if (!observer) {
      // Sin observación: la reconciliación se hace bajo demanda (ensureIndex).
      return Promise.resolve(null);
    }
    // El índice anterior permite describir lo que desapareció mientras Mind estuvo cerrado.
    state.ready = scanSlot(async () => {
      state.configuration = JSON.stringify(await motor.getAuthorizedFolder(folderId));
      lifecycle.signal.throwIfAborted();
      return observer.observe(folderId);
    }).then((status) => {
      if (!state.halted) state.lastError = null;
      return status;
    }, (error) => {
      state.lastError = error?.code ?? 'OBSERVE_FAILED';
      state.ready = null;
      log('aviso', 'No se pudo iniciar la observación', { carpeta: folderId, codigo: state.lastError });
      return null;
    });
    return state.ready;
  }

  /** Alinea las carpetas observadas con el registro (otra sesión o la consola pueden cambiarlo). */
  async function sync() {
    if (closed) return;
    syncing ??= withRequestContext({}, async () => {
      try {
        if (observe && !observer) {
          if (!await lease.acquire()) return;
          if (closed) { await lease.release(); return; }
          observer = motor.openIndexObserver({ onReport, signal: lifecycle.signal, initialPriority: 'background' });
          watchRegistry();
          for (const factory of SESSION_EXTENSIONS) {
            try {
              const extension = factory(api);
              extensions.push(extension);
              await extension.start?.();
            } catch (error) {
              log('error', 'No se pudo iniciar una extensión de la sesión', { error: String(error?.stack ?? error) });
            }
          }
        }
        if (closed || !observer) return;
        const registered = await motor.listAuthorizedFolders();
        const ids = new Set(registered.map((folder) => folder.id));
        for (const id of ids) {
          const state = folders.get(id);
          if (state?.halted) {
            const configuration = JSON.stringify(await motor.getAuthorizedFolder(id));
            if (configuration === state.configuration) continue;
            state.halted = null;
            state.ready = null;
          }
          if (!state?.ready) begin(id);
        }
        for (const id of [...folders.keys()]) {
          if (!ids.has(id)) {
            folders.delete(id);
            await observer?.unobserve(id).catch(() => {});
          }
        }
      } finally {
        lastSyncAt = Date.now();
        syncing = null;
      }
    });
    return syncing;
  }

  function ensureSyncTimer() {
    if (syncTimer || !observe || !started || closed) return;
    syncTimer = setInterval(() => {
      if (!observer || Date.now() - lastSyncAt >= SYNC_INTERVAL_MS) {
        sync().catch((error) => log('aviso', 'Sincronización del registro fallida', { error: String(error) }));
      }
    }, OWNER_CHECK_MS);
    syncTimer.unref?.();
  }

  async function clearCaches() {
    motor.clearCache?.();
    await motor.unloadConversationSearch?.();
  }

  const extensions = [];
  const api = Object.freeze({
    id: sessionId,
    motorVersion,
    removals,
    layout,
    base,
    motor,
    policy,
    requests,
    audit,
    log,
    observing: () => observe && started && !closed,
    ownsBackground: () => observer !== null && !closed,
    backgroundStatus: () => observe ? lease.status() : { role: 'disabled', ownerPid: null },

    /**
     * Hay trabajo de fondo que no conviene interrumpir: el recorrido inicial de una
     * carpeta, la sincronización del registro o la preparación semántica. Reposar o
     * apagar ahora obligaría a empezarlo de nuevo. Los cambios que una carpeta ya
     * observada va recibiendo no cuentan: una carpeta que cambia sin parar no debe
     * mantener el Motor despierto.
     */
    isBackgroundBusy() {
      if (closed) return false;
      if (syncing || activeScans > 0 || waitingScans.length > 0) return true;
      if (motor.isConversationSearchBusy?.()) return true;
      return (observer?.list?.() ?? []).some((folder) => folder.mode === 'starting');
    },

    /** Empieza la reconciliación inicial y la observación, sin bloquear al agente. */
    async start() {
      if (started || closed) return;
      started = true;
      await cleanStaleBaseTemporaries(motor.baseDirectory).catch(() => {});
      await liveSessions(motor.baseDirectory, { pythonExecutable: layout.pythonExecutable }).then(async ({ stale, directory }) => {
        for (const item of stale) await fs.rm(path.join(directory, item.file), { force: true }).catch(() => {});
        if (installationSession) {
          const instDir = path.dirname(installationSession);
          for (const item of stale) await fs.rm(path.join(instDir, item.file), { force: true }).catch(() => {});
        }
      }).catch(() => {});
      await policy.prune().catch((error) => log('aviso', 'No se pudieron limpiar decisiones antiguas', { error: String(error) }));
      try {
        await sync();
      } catch (error) {
        // Sin observación activa: el siguiente uso debe poder reintentar el inicio.
        started = false;
        throw error;
      }
      ensureSyncTimer();
    },

    sync,
    begin,

    /**
     * Garantiza un índice coherente antes de consultarlo: con `allowStale: true`,
     * responde al instante desde el último índice guardado sin esperar ni abortar
     * si una carpeta está detenida (p. ej., disco externo desconectado).
     */
    async ensureIndex(folderId, { timeoutMs = 60_000, allowStale = false } = {}) {
      const request = requestSignal();
      const signal = request ? AbortSignal.any([lifecycle.signal, request]) : lifecycle.signal;
      signal.throwIfAborted();
      if (!started) await waitForRequest(withRequestContext({}, () => this.start()), signal);
      lifecycle.signal.throwIfAborted();
      if (allowStale) {
        const state = folders.get(folderId);
        const existing = await motor.readFolderIndex(folderId).catch(() => null);
        if (state?.halted) {
          scheduleHaltedRetry(folderId);
          if (existing) return { status: 'current', stale: true, code: state.halted };
          return { status: 'unavailable', code: state.halted };
        }
        // Solo con observación (propia o de otra sesión) el índice guardado se mantiene al
        // día; con observe=false cada consulta reconcilia bajo demanda, como se documenta arriba.
        if (existing && observe) {
          if (observer && !state?.ready) void begin(folderId);
          return { status: 'current', stale: false };
        }
      }
      if (observe) await motor.prioritizeIndex(folderId, timeoutMs);
      if (observe && !observer) {
        const until = Date.now() + timeoutMs;
        for (;;) {
          // The Motor revalidates the folder's authorization on each read.
          if (await motor.readFolderIndex(folderId)) return { status: 'current' };
          await waitForRequest(sync(), signal);
          if (observer) break;
          if (Date.now() >= until) return { status: 'reconciling' };
          await delay(Math.min(200, until - Date.now()), undefined, { signal });
        }
      }
      if (observer) {
        const ready = withRequestContext({}, () => begin(folderId));
        // Esta llamada espera el recorrido de fondo de la carpeta: que no ceda ante ella.
        const unhurry = backgroundGate?.expedite?.(folderId);
        let timer;
        const timeout = new Promise((resolve) => {
          timer = setTimeout(() => resolve('timeout'), timeoutMs);
          timer.unref?.();
        });
        let result;
        try { result = await waitForRequest(Promise.race([ready, timeout]), signal); }
        finally { clearTimeout(timer); unhurry?.(); }
        if (result === 'timeout') return { status: 'reconciling' };
        if (folders.get(folderId)?.halted) {
          const halted = folders.get(folderId).halted;
          if (allowStale) {
            scheduleHaltedRetry(folderId);
            const existing = await motor.readFolderIndex(folderId).catch(() => null);
            if (existing) return { status: 'current', stale: true, code: halted };
            return { status: 'unavailable', code: halted };
          }
          throw new MotorError(halted, 'La indexación está detenida; cambia la configuración o solicita una reindexación explícita.');
        }
        if (await motor.readFolderIndex(folderId)) return { status: 'current' };
      }
      const state = track(folderId);
      const indexed = await motor.indexFolder(folderId);
      state.halted = null;
      state.haltRetryCount = 0;
      clearTimeout(state.haltRetryTimer);
      state.haltRetryTimer = null;
      await trackRemovals(folderId, indexed.changes);
      return { status: 'reconciled', generation: indexed.generation };
    },

    /**
     * Reconcilia ahora una carpeta tras una operación de Mind que cambió su
     * estructura (crear carpetas, mover, papelera), con o sin observación.
     */
    async reindex(folderId, options = {}) {
      const state = track(folderId);
      state.halted = null;
      state.haltRetryCount = 0;
      clearTimeout(state.haltRetryTimer);
      state.haltRetryTimer = null;
      state.ready = null;
      const hints = options?.relativePath ? { paths: [options.relativePath], overflow: false } : undefined;
      const indexed = await motor.indexFolder(folderId, hints ? { hints } : undefined);
      await trackRemovals(folderId, indexed.changes);
      return indexed;
    },

    folderStatus(folderId) {
      const state = folders.get(folderId);
      const observed = observer?.status(folderId) ?? null;
      return {
        observacion: observed ? observed.mode : state?.halted ? 'detenida' : observer ? 'inactiva' : observe ? 'compartida' : 'bajo-demanda',
        ultimaReconciliacion: observed?.lastReconciledAt ? new Date(observed.lastReconciledAt).toISOString() : null,
        pendiente: observed?.pending ?? false,
        incidencia: state?.lastError ?? null,
      };
    },

    /** Oyentes de cambios reconciliados (índices personalizados, automatizaciones por evento). */
    onChanges(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /** Espera a que se anote lo eliminado en las reconciliaciones ya informadas. */
    async settled(folderId) {
      await folders.get(folderId)?.chain;
    },

    async forget(folderId) {
      await removals.remove(folderId).catch(() => {});
      folders.delete(folderId);
      await observer?.unobserve(folderId).catch(() => {});
    },

    /** Libera cachés de índices en RAM y descarga el subproceso semántico sin cerrar la sesión. */
    clearCaches,

    /** Pausa sondeos periódicos y libera cachés en RAM durante el reposo ligero. */
    async pauseIdle() {
      clearInterval(syncTimer);
      syncTimer = null;
      clearTimeout(registryWake);
      registryWake = null;
      observer?.pausePeriodic?.();
      closePersistentScanner();
      await clearCaches();
    },

    /** Reanuda la observación periódica al salir del reposo ligero. */
    resumeIdle() {
      if (closed) return;
      observer?.resumePeriodic?.();
      if (started && observe) {
        ensureSyncTimer();
        if (!observer || Date.now() - lastSyncAt >= SYNC_INTERVAL_MS) {
          sync().catch((error) => log('aviso', 'Sincronización del registro fallida', { error: String(error) }));
        }
      }
    },

    async close() {
      if (closing) return closing;
      closed = true;
      lifecycle.abort(new MotorError('SESSION_CLOSED', 'La sesión se cerró.'));
      clearInterval(syncTimer);
      syncTimer = null;
      clearTimeout(registryWake);
      registryWatcher?.close();
      registryWatcher = null;
      for (const state of folders.values()) {
        clearTimeout(state.haltRetryTimer);
        state.haltRetryTimer = null;
      }
      listeners.clear();
      const cleanup = (async () => {
        closePersistentScanner();
        await motor.closeConversationSearch();
        await syncing?.catch(() => {});
        await Promise.allSettled([
          observer?.close(),
          ...extensions.reverse().map((extension) => Promise.resolve().then(() => extension.close?.())),
          ...[...folders.values()].map((state) => state.ready),
        ]);
        await Promise.allSettled([...folders.values()].map((state) => state.chain));
        // Release ownership only after work stops: a delayed extension must
        // never overlap the replacement owner.
        await lease?.release();
        await fs.rm(sessionFile, { force: true }).catch(() => {});
        if (installationSession) await fs.rm(installationSession, { force: true }).catch(() => {});
      })();
      closing = (async () => {
        let timer;
        try {
          await Promise.race([cleanup, new Promise((resolve) => {
            timer = setTimeout(() => {
              log('aviso', 'El cierre continúa; el coordinador conserva su dueño hasta terminar.');
              resolve();
            }, CLOSE_TIMEOUT_MS);
          })]);
        } finally { clearTimeout(timer); }
      })();
      cleanup.catch((error) => log('error', 'Fallo al liberar la sesión', { error: String(error) }));
      return closing;
    },
  });
  return api;
  } catch (error) { await releaseStartup().catch(() => {}); throw error; }
}

/** Unknown records block old callers conservatively but remain separately diagnosable. */
export async function liveSessions(baseDirectory, options = {}) {
  const directory = path.join(baseDirectory, SESSIONS_DIRECTORY);
  let entries;
  try { entries = await fs.readdir(directory); }
  catch (error) { if (error.code === 'ENOENT') return { live: [], stale: [], unknown: [], directory }; throw error; }
  const records = [];
  for (const file of entries) {
    if (!/^sesion-[a-f0-9-]{36}\.json$/.test(file)) continue;
    try {
      const info = await fs.lstat(path.join(directory, file));
      if (!info.isFile()) { records.push({ file, invalid: true }); continue; }
      const record = JSON.parse(await fs.readFile(path.join(directory, file), 'utf8'));
      if (!record || record.format !== 'mind-session' || ![1, 2].includes(record.version)
          || !/^[a-f0-9-]{36}$/.test(record.id ?? '') || file !== 'sesion-' + record.id + '.json') {
        records.push({ file, invalid: true }); continue;
      }
      records.push({ ...record, file });
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      records.push({ file, invalid: true, reason: 'unreadable-record' });
    }
  }
  const inspected = await inspectProcessOwners(records, options);
  const unknown = inspected.filter(record => record.state === 'unknown');
  return {
    live: inspected.filter(record => record.state === 'active' || record.state === 'unknown'),
    stale: inspected.filter(record => record.state === 'stale'), unknown, directory,
  };
}

export { MotorError };
