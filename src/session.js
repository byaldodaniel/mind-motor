import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { MotorError } from './errors.js';
import { openMotor } from './motor.js';
import { ensureBase } from './base-format.js';
import { createAccessPolicy } from './access-policy.js';
import { createConsentRequests } from './consent.js';
import { createRemovalLog } from './removals.js';

const SYNC_INTERVAL_MS = 30_000;
const SESSIONS_DIRECTORY = 'sesiones';

/** Registro de auditoría local: decisiones de acceso y operaciones sobre originales, sin contenido. */
function createAudit(baseDirectory) {
  const file = path.join(baseDirectory, 'auditoria.jsonl');
  return async function audit(event, data = {}) {
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
export async function openSession({ layout, motorVersion, log = () => {}, observe = true, functionExecutors = {} }) {
  const base = await ensureBase(layout.baseDirectory, { motorVersion, protectedFrom: layout.motorDirectory });
  const motor = await openMotor({
    baseDirectory: base.baseDirectory,
    pythonExecutable: layout.pythonExecutable,
    protectedDirectories: layout.protectedDirectories,
    functionExecutors,
  });
  const policy = createAccessPolicy({ baseDirectory: motor.baseDirectory, getAuthorizedFolder: motor.getAuthorizedFolder });
  const requests = createConsentRequests(motor.baseDirectory);
  const removals = createRemovalLog({ baseDirectory: motor.baseDirectory, getAuthorizedFolder: motor.getAuthorizedFolder });
  const audit = createAudit(motor.baseDirectory);
  const sessionId = randomUUID();
  const sessionsDirectory = path.join(motor.baseDirectory, SESSIONS_DIRECTORY);
  const sessionFile = path.join(sessionsDirectory, `sesion-${sessionId}.json`);
  const folders = new Map();
  const listeners = new Set();
  let observer = null;
  let syncTimer = null;
  let started = false;
  let closed = false;
  let syncing = null;

  await fs.mkdir(sessionsDirectory, { recursive: true, mode: 0o700 });
  await fs.writeFile(sessionFile, `${JSON.stringify({
    format: 'mind-session', version: 1, id: sessionId, pid: process.pid, host: os.hostname(),
    startedAt: new Date().toISOString(), observe,
  })}\n`, { encoding: 'utf8', mode: 0o600 });

  function track(folderId) {
    let state = folders.get(folderId);
    if (!state) {
      state = { ready: null, lastReport: null, lastError: null, lastChanges: null, entries: null, chain: Promise.resolve() };
      folders.set(folderId, state);
    }
    return state;
  }

  async function indexedEntries(folderId) {
    const index = await motor.readFolderIndex(folderId).catch(() => null);
    return index ? new Map(index.entries.map((entry) => [entry.path, entry])) : null;
  }

  /** Anota lo desaparecido usando el índice anterior y avanza al nuevo, en orden por carpeta. */
  function trackRemovals(folderId, removed) {
    const state = track(folderId);
    state.chain = state.chain.then(async () => {
      if (removed.length > 0 && state.entries) await removals.record(folderId, removed, state.entries);
      state.entries = await indexedEntries(folderId);
    }).catch((error) => log('aviso', 'No se pudo anotar lo eliminado', { carpeta: folderId, error: String(error) }));
    return state.chain;
  }

  function onReport(report) {
    const state = track(report.folderId);
    if (report.type === 'reconciled') trackRemovals(report.folderId, report.changes?.removed ?? []);
    state.lastReport = { type: report.type, at: new Date().toISOString(), ...(report.code ? { code: report.code } : {}) };
    if (report.type === 'error' || report.type === 'degraded') {
      state.lastError = report.code ?? null;
      log('aviso', 'Observación con incidencias', { carpeta: report.folderId, tipo: report.type, codigo: report.code });
    }
    if (report.type === 'reconciled') {
      state.lastError = null;
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
      log('info', 'Observación detenida', { carpeta: report.folderId, motivo: report.reason });
    }
  }

  function begin(folderId) {
    const state = track(folderId);
    if (state.ready) return state.ready;
    if (!observer) {
      // Sin observación: la reconciliación se hace bajo demanda (ensureIndex).
      state.ready = Promise.resolve(null);
      return state.ready;
    }
    // El índice anterior permite describir lo que desapareció mientras Mind estuvo cerrado.
    state.ready = indexedEntries(folderId).then((entries) => {
      state.entries ??= entries;
      return observer.observe(folderId);
    }).then((status) => {
      state.lastError = null;
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
    syncing ??= (async () => {
      try {
        const registered = await motor.listAuthorizedFolders();
        const ids = new Set(registered.map((folder) => folder.id));
        for (const id of ids) if (!folders.get(id)?.ready) begin(id);
        for (const id of [...folders.keys()]) {
          if (!ids.has(id)) {
            folders.delete(id);
            await observer?.unobserve(id).catch(() => {});
          }
        }
      } finally {
        syncing = null;
      }
    })();
    return syncing;
  }

  return Object.freeze({
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
    observing: () => observer !== null,

    /** Empieza la reconciliación inicial y la observación, sin bloquear al agente. */
    async start() {
      if (started || closed) return;
      started = true;
      if (observe) observer = motor.openIndexObserver({ onReport });
      await policy.prune().catch((error) => log('aviso', 'No se pudieron limpiar decisiones antiguas', { error: String(error) }));
      sync().catch((error) => log('error', 'No se pudo leer el registro de carpetas', { error: String(error) }));
      syncTimer = setInterval(() => {
        sync().catch((error) => log('aviso', 'Sincronización del registro fallida', { error: String(error) }));
      }, SYNC_INTERVAL_MS);
      syncTimer.unref?.();
    },

    sync,
    begin,

    /**
     * Garantiza un índice coherente antes de consultarlo: con observación espera
     * la reconciliación inicial; sin ella reconcilia ahora (operación individual).
     */
    async ensureIndex(folderId, { timeoutMs = 60_000 } = {}) {
      if (!started) await this.start();
      if (observer) {
        const ready = begin(folderId);
        let timer;
        const timeout = new Promise((resolve) => {
          timer = setTimeout(() => resolve('timeout'), timeoutMs);
          timer.unref?.();
        });
        const result = await Promise.race([ready, timeout]);
        clearTimeout(timer);
        if (result === 'timeout') return { status: 'reconciling' };
        if (await motor.readFolderIndex(folderId)) return { status: 'current' };
      }
      const state = track(folderId);
      state.entries ??= await indexedEntries(folderId);
      const indexed = await motor.indexFolder(folderId);
      await trackRemovals(folderId, indexed.changes?.removed ?? []);
      return { status: 'reconciled', generation: indexed.generation };
    },

    folderStatus(folderId) {
      const state = folders.get(folderId);
      const observed = observer?.status(folderId) ?? null;
      return {
        observacion: observed ? observed.mode : observer ? 'inactiva' : 'bajo-demanda',
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

    async close() {
      if (closed) return;
      closed = true;
      clearInterval(syncTimer);
      listeners.clear();
      try {
        await observer?.close();
      } finally {
        await fs.rm(sessionFile, { force: true }).catch(() => {});
      }
    },
  });
}

/** Sesiones registradas en la Base cuyo proceso sigue vivo en este equipo. */
export async function liveSessions(baseDirectory) {
  const directory = path.join(baseDirectory, SESSIONS_DIRECTORY);
  let entries = [];
  try {
    entries = await fs.readdir(directory);
  } catch (error) {
    if (error.code === 'ENOENT') return { live: [], stale: [] };
    throw error;
  }
  const live = [];
  const stale = [];
  for (const entry of entries) {
    if (!/^sesion-[a-f0-9-]{36}\.json$/.test(entry)) continue;
    let data = null;
    try {
      data = JSON.parse(await fs.readFile(path.join(directory, entry), 'utf8'));
    } catch {
      stale.push({ file: entry, reason: 'ilegible' });
      continue;
    }
    if (data.host !== os.hostname()) {
      live.push({ ...data, file: entry, note: 'otro-equipo' });
      continue;
    }
    let alive = true;
    try {
      process.kill(data.pid, 0);
    } catch (error) {
      alive = error.code === 'EPERM';
    }
    (alive ? live : stale).push({ ...data, file: entry });
  }
  return { live, stale, directory };
}

export { MotorError };
