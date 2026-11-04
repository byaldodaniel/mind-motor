import { watch as fsWatch } from 'node:fs';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { MotorError } from './errors.js';
import { validateScopeId } from './index-store.js';

/**
 * Observación de cambios para mantener los índices durante una sesión.
 *
 * Las notificaciones del sistema operativo solo deciden *cuándo* reconciliar;
 * nunca qué se escribe. Cada actualización es una llamada a `indexFolder`, que
 * recorre la carpeta con el auxiliar seguro existente y publica el índice ligado
 * a su autorización. Este módulo no abre, lee ni consulta metadatos de los
 * originales: solo mantiene manejadores de observación sobre directorios que el
 * propio índice confirmó como directorios no enlazados.
 */

const DEFAULTS = Object.freeze({
  debounceMs: 300,
  maxDelayMs: 5_000,
  minIntervalMs: 2_000,
  safetyIntervalMs: 3_600_000,
  fallbackIntervalMs: 300_000,
  authorizationCheckMs: 5_000,
  maxWatchedDirectories: 8_192,
  maxHints: 256,
});
const AUTHORIZATION_FILE = /^folder-authorization-([a-f0-9]{64})\.json$/;
/** Errores tras los que continuar sería inseguro o inútil. */
const FATAL = new Map([
  ['FOLDER_NOT_AUTHORIZED', 'revoked'],
  ['SCOPE_CHANGED', 'scope-changed'],
  ['INVALID_SCOPE', 'scope-changed'],
  ['SCOPE_OVERLAPS_INTERNAL', 'scope-changed'],
  ['SAFE_SCAN_UNAVAILABLE', 'scan-unavailable'],
  ['INDEX_LIMIT_EXCEEDED', 'limit-exceeded'],
  ['INDEX_CORRUPT', 'index-corrupt'],
  ['INDEX_INVALID', 'index-corrupt'],
  ['AUTHORIZATION_CORRUPT', 'authorization-corrupt'],
]);

/** @typedef {'recursive' | 'directories'} WatchStrategy */
/**
 * @typedef {object} ObserverReport
 * @property {'reconciled' | 'watching' | 'degraded' | 'error' | 'stopped'} type
 * @property {string} folderId
 * @property {string[]} [reasons] Motivos agrupados: start, event, overflow, watch-error, root-changed, safety, poll, retry, verify, manual.
 * @property {{ paths: string[], overflow: boolean }} [hints] Rutas notificadas; orientativas, no verificadas.
 * @property {{ added: string[], modified: string[], removed: string[], renamed: { from: string, to: string, type: string }[] } | null} [changes]
 * @property {string} [code]
 * @property {string} [reason] Motivo de la detención.
 */

function positiveInteger(name, value, allowZero = false) {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new MotorError('INVALID_OBSERVER_OPTION', `La opción ${name} debe ser un entero ${allowZero ? 'no negativo' : 'positivo'}.`);
  }
  return value;
}

function defaultStrategy(platform) {
  // FSEvents y ReadDirectoryChangesW observan subárboles sin recorrerlos desde JS.
  return platform === 'win32' || platform === 'darwin' ? 'recursive' : 'directories';
}

/**
 * libuv aborta el proceso en Windows si una ruta observada contiene nombres
 * cortos 8.3 y el sistema notifica con nombres largos. El registro guarda rutas
 * canónicas largas; aun así, una ruta con esa forma no se observa.
 */
function unsafeWatchPath(target) {
  return process.platform === 'win32' && /~\d/.test(target);
}

function toRelative(...parts) {
  return parts.filter((part) => part !== '' && part != null)
    .join('/').split(/[\\/]+/).filter(Boolean).join('/');
}

function absolute(root, relative) {
  return relative === '' ? root : path.join(root, ...relative.split('/'));
}

function signature(entry) {
  if (!entry || entry.state !== 'indexed' || entry.modifiedAt === null) return null;
  return `${entry.type}|${entry.size}|${entry.modifiedAt}|${entry.createdAt}`;
}

function uniqueMatches(left, right) {
  const count = (items) => {
    const map = new Map();
    for (const [key, value] of items) {
      if (key === null) continue;
      map.set(key, map.has(key) ? null : value);
    }
    return map;
  };
  const before = count(left);
  const after = count(right);
  const pairs = [];
  for (const [key, from] of before) {
    const to = after.get(key);
    if (from !== null && to != null) pairs.push([from, to]);
  }
  return pairs;
}

function isInside(relative, directories) {
  for (let at = relative.lastIndexOf('/'); at > 0; at = relative.lastIndexOf('/', at - 1)) {
    if (directories.has(relative.slice(0, at))) return true;
  }
  return false;
}

/**
 * Deriva cambios de nombre de dos índices consecutivos. Es una inferencia por
 * metadatos: un par se informa solo si su firma es única en ambos lados; en caso
 * contrario permanece como eliminación y alta.
 * @param {{ added: string[], modified: string[], removed: string[] }} changes
 * @param {import('./index-scan.js').IndexEntry[]} before
 * @param {import('./index-scan.js').IndexEntry[]} after
 */
export function pairRenames(changes, before, after) {
  const old = new Map(before.map((entry) => [entry.path, entry]));
  const now = new Map(after.map((entry) => [entry.path, entry]));
  const removed = changes.removed.filter((item) => old.has(item));
  const added = changes.added.filter((item) => now.has(item));

  // Huella de una carpeta: sus descendientes relativos con tipo, tamaño y fecha.
  function fingerprints(paths, entries) {
    const directories = new Set(paths.filter((item) => entries.get(item).type === 'directory'));
    const parts = new Map([...directories].map((item) => [item, []]));
    for (const item of paths) {
      for (let at = item.lastIndexOf('/'); at > 0; at = item.lastIndexOf('/', at - 1)) {
        const parent = item.slice(0, at);
        if (!directories.has(parent)) continue;
        const entry = entries.get(item);
        if (entry.state !== 'indexed') parts.set(parent, null);
        else parts.get(parent)?.push(`${item.slice(at + 1)}|${signature(entry)}`);
      }
    }
    return [...directories].map((item) => {
      const list = parts.get(item);
      const entry = entries.get(item);
      if (list === null || entry.state !== 'indexed') return [null, item];
      if (list.length === 0) return [entry.createdAt ? `empty|${entry.createdAt}` : null, item];
      return [list.sort().join('\n'), item];
    });
  }

  const renamed = [];
  const movedFrom = new Set();
  const movedTo = new Set();
  const byDepth = (a, b) => a[0].split('/').length - b[0].split('/').length;
  for (const [from, to] of uniqueMatches(fingerprints(removed, old), fingerprints(added, now)).sort(byDepth)) {
    if (isInside(from, movedFrom) || isInside(to, movedTo)) continue;
    movedFrom.add(from);
    movedTo.add(to);
    renamed.push({ from, to, type: 'directory' });
  }
  const restRemoved = removed.filter((item) => !movedFrom.has(item) && !isInside(item, movedFrom));
  const restAdded = added.filter((item) => !movedTo.has(item) && !isInside(item, movedTo));
  const files = (paths, entries) => paths.filter((item) => entries.get(item).type !== 'directory')
    .map((item) => [signature(entries.get(item)), item]);
  for (const [from, to] of uniqueMatches(files(restRemoved, old), files(restAdded, now))) {
    movedFrom.add(from);
    movedTo.add(to);
    renamed.push({ from, to, type: old.get(from).type });
  }
  renamed.sort((a, b) => (a.from < b.from ? -1 : 1));
  return {
    added: changes.added.filter((item) => !movedTo.has(item) && !isInside(item, movedTo)),
    modified: changes.modified,
    removed: changes.removed.filter((item) => !movedFrom.has(item) && !isInside(item, movedFrom)),
    renamed,
  };
}

/**
 * Crea un observador ligado a un Motor abierto por el anfitrión administrativo.
 * No es un servicio residente: sus temporizadores y observaciones no mantienen
 * vivo el proceso y `close()` libera todo.
 * @param {object} options
 * @param {{ baseDirectory: string, indexFolder: Function, readFolderIndex: Function, listAuthorizedFolders: Function }} options.motor
 * @param {(report: ObserverReport) => void} [options.onReport]
 * @param {WatchStrategy} [options.strategy] Por defecto: recursiva en Windows y macOS; por directorio en el resto.
 * @param {typeof fsWatch} [options.watch] Solo para pruebas de fallos de observación.
 */
export function createIndexObserver({
  motor, onReport = () => {}, strategy, watch = fsWatch, signal,
  initialPriority = 'interactive', ...settings
} = {}) {
  if (!motor || typeof motor.indexFolder !== 'function' || typeof motor.readFolderIndex !== 'function'
      || typeof motor.listAuthorizedFolders !== 'function' || typeof motor.baseDirectory !== 'string') {
    throw new MotorError('INVALID_OBSERVER_MOTOR', 'El observador necesita un Motor abierto por el anfitrión.');
  }
  if (typeof onReport !== 'function' || typeof watch !== 'function') {
    throw new MotorError('INVALID_OBSERVER_OPTION', 'onReport y watch deben ser funciones.');
  }
  if (!['interactive', 'background'].includes(initialPriority)) {
    throw new MotorError('INVALID_OBSERVER_OPTION', 'La prioridad inicial no es válida.');
  }
  // A standalone observer also owns its pending scans. close() must be able to
  // cancel them even when the caller did not provide a session signal.
  const lifetime = new AbortController();
  signal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
  const mode = strategy ?? defaultStrategy(process.platform);
  if (mode !== 'recursive' && mode !== 'directories') {
    throw new MotorError('INVALID_OBSERVER_OPTION', 'La estrategia debe ser recursive o directories.');
  }
  if (mode === 'directories' && process.platform === 'win32') {
    // Cada observación abre un manejador que impediría al usuario renombrar esa subcarpeta.
    throw new MotorError('INVALID_OBSERVER_OPTION', 'En Windows solo se admite la observación recursiva.');
  }
  const unknown = Object.keys(settings).filter((key) => !Object.hasOwn(DEFAULTS, key));
  if (unknown.length > 0) {
    throw new MotorError('INVALID_OBSERVER_OPTION', `Opción desconocida: ${unknown[0]}.`);
  }
  const config = { ...DEFAULTS, ...settings };
  for (const key of Object.keys(DEFAULTS)) {
    positiveInteger(key, config[key], key === 'safetyIntervalMs' || key === 'debounceMs');
  }

  /** @type {Map<string, object>} */
  const folders = new Map();
  const starting = new Map();
  const inFlight = new Set();
  let closed = false;
  let baseWatcher = null;
  let authorizationTimer = null;
  let authorizationCheck = null;
  function abort() {
    closed = true;
    for (const state of [...folders.values()]) stop(state, 'closed');
    releaseAuthorizationWatch();
  }
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();

  function report(value) {
    try {
      onReport(Object.freeze(value));
    } catch {
      // Un fallo del anfitrión al recibir el informe no detiene la observación.
    }
  }

  function unref(timer) {
    timer?.unref?.();
    return timer;
  }

  function closeWatchers(state) {
    for (const watcher of state.watchers.values()) {
      try { watcher.close(); } catch { /* ya cerrado */ }
    }
    state.watchers.clear();
  }

  function clearTimers(state) {
    clearTimeout(state.timer);
    clearTimeout(state.periodic);
    state.timer = null;
    state.periodic = null;
  }

  function stop(state, reason, code) {
    if (state.stopped) return;
    state.stopped = true;
    state.stopReason = reason;
    state.dirty = false;
    clearTimers(state);
    closeWatchers(state);
    folders.delete(state.id);
    report({ type: 'stopped', folderId: state.id, reason, ...(code ? { code } : {}) });
    if (folders.size === 0 && starting.size === 0) releaseAuthorizationWatch();
  }

  // --- Programación: agrupa ráfagas y limita la frecuencia de recorridos ---

  function spacing(state) {
    return state.failures === 0 ? config.minIntervalMs
      : Math.min(config.minIntervalMs * 2 ** state.failures, config.fallbackIntervalMs);
  }

  function earliestRun(state) {
    return state.lastRunEndedAt + spacing(state);
  }

  function dueAt(state) {
    const quiet = Math.min(state.lastEventAt + config.debounceMs, state.firstEventAt + config.maxDelayMs);
    return Math.max(quiet, state.immediate ? 0 : earliestRun(state));
  }

  function arm(state) {
    if (state.stopped || state.running || !state.dirty || state.timer) return;
    // Un único temporizador por carpeta; al vencer se recalcula, sin reprogramar en cada evento.
    const fire = () => {
      state.timer = null;
      if (state.stopped || state.running || !state.dirty) return;
      const wait = dueAt(state) - Date.now();
      if (wait > 0) state.timer = unref(setTimeout(fire, wait));
      else run(state);
    };
    state.timer = unref(setTimeout(fire, Math.max(0, dueAt(state) - Date.now())));
  }

  function mark(state, reason, hint, immediate = false) {
    if (state.stopped) return;
    const now = Date.now();
    if (!state.dirty) {
      state.dirty = true;
      state.firstEventAt = now;
      state.reasons = new Set();
      state.hints = new Set();
      state.overflow = false;
      state.immediate = false;
    }
    state.lastEventAt = now;
    state.reasons.add(reason);
    state.immediate ||= immediate;
    if (hint === null) state.overflow = true;
    else if (hint !== undefined && !state.hints.has(hint)) {
      if (state.hints.size < config.maxHints) state.hints.add(hint);
      else state.overflow = true;
    }
    arm(state);
  }

  function armPeriodic(state) {
    clearTimeout(state.periodic);
    state.periodic = null;
    const interval = state.mode === 'polling' ? config.fallbackIntervalMs : config.safetyIntervalMs;
    if (state.stopped || interval === 0) return;
    state.periodic = unref(setTimeout(() => {
      state.periodic = null;
      mark(state, state.mode === 'polling' ? 'poll' : 'safety');
    }, interval));
  }

  // --- Observación del sistema operativo ---

  function onWatchEvent(state, directory, filename) {
    if (state.stopped) return;
    // Sin nombre: el sistema agrupó o desbordó notificaciones; se reconcilia igual.
    if (filename == null) return mark(state, 'overflow', null);
    mark(state, 'event', toRelative(directory, String(filename)));
  }

  function openWatcher(state, directory) {
    const watcher = watch(absolute(state.root, directory), {
      persistent: false, recursive: state.strategy === 'recursive',
    }, (_type, filename) => onWatchEvent(state, directory, filename));
    watcher.on('error', () => {
      try { watcher.close(); } catch { /* ya cerrado */ }
      if (state.watchers.get(directory) === watcher) state.watchers.delete(directory);
      // La observación de ese subárbol se perdió: se recupera con una reconciliación.
      mark(state, 'watch-error', null);
    });
    state.watchers.set(directory, watcher);
  }

  function degrade(state, code) {
    closeWatchers(state);
    if (state.mode !== 'polling') {
      state.mode = 'polling';
      report({ type: 'degraded', folderId: state.id, code });
    }
    armPeriodic(state);
  }

  /** Directorios confirmados por el recorrido seguro: nunca enlaces ni reparse points. */
  function watchedDirectories(entries) {
    const result = [''];
    for (const entry of entries ?? []) {
      if (entry.type === 'directory' && entry.state === 'indexed') result.push(entry.path);
    }
    return result;
  }

  /**
   * Sincroniza las observaciones con el último índice. Devuelve cuántas se
   * abrieron, para que las carpetas nuevas se verifiquen con otra reconciliación.
   */
  function syncWatchers(state) {
    if (unsafeWatchPath(state.root)) {
      degrade(state, 'WATCH_PATH_UNSUPPORTED');
      return 0;
    }
    const wanted = state.strategy === 'recursive' ? [''] : watchedDirectories(state.entries);
    if (wanted.length > config.maxWatchedDirectories) {
      degrade(state, 'WATCH_LIMIT');
      return 0;
    }
    const keep = new Set(wanted);
    for (const [directory, watcher] of state.watchers) {
      if (!keep.has(directory)) {
        try { watcher.close(); } catch { /* ya cerrado */ }
        state.watchers.delete(directory);
      }
    }
    let opened = 0;
    for (const directory of wanted) {
      if (state.watchers.has(directory)) continue;
      try {
        openWatcher(state, directory);
        opened += 1;
      } catch (error) {
        // Una subcarpeta que desapareció ya notificó su eliminación a su padre.
        if (directory !== '' && error?.code === 'ENOENT') continue;
        degrade(state, error?.code ?? 'WATCH_UNAVAILABLE');
        return 0;
      }
    }
    if (state.mode !== 'watching') {
      state.mode = 'watching';
      report({ type: 'watching', folderId: state.id, strategy: state.strategy, directories: state.watchers.size });
    }
    return opened;
  }

  // --- Reconciliación mediante el indexador existente ---

  function failure(state, error) {
    const code = typeof error?.code === 'string' ? error.code : 'OBSERVER_FAILED';
    if (FATAL.has(code)) return stop(state, FATAL.get(code), code);
    state.failures += 1;
    // Sin la carpeta no se conserva un manejador sobre lo que ocupe o deje su lugar.
    if (code === 'SCOPE_UNAVAILABLE') degrade(state, code);
    report({ type: 'error', folderId: state.id, code, retryInMs: spacing(state) });
    if (code === 'INDEX_SCOPE_CHANGED') checkAuthorization(state.id, true);
    mark(state, 'retry');
  }

  function run(state, priority = 'background') {
    clearTimeout(state.timer);
    state.timer = null;
    const reasons = [...state.reasons].sort();
    const hints = { paths: [...state.hints].sort(), overflow: state.overflow };
    state.dirty = false;
    state.running = (async () => {
      try {
        const result = await motor.indexFolder(state.id, { priority, signal });
        if (state.stopped) return;
        const index = await motor.readFolderIndex(state.id);
        if (state.stopped) return;
        if (!index || (state.authorization !== undefined && index.authorizationGeneration !== state.authorization)) {
          // Retirada y nueva autorización de la misma ruta: no se hereda la observación.
          return stop(state, 'authorization-changed');
        }
        const consecutive = state.entries !== null && result.changes !== null
          && index.generation === result.generation && result.generation === state.indexGeneration + 1;
        const changes = result.changes === null ? null
          : consecutive ? pairRenames(result.changes, state.entries, index.entries)
            : { ...result.changes, renamed: [] };
        state.authorization = index.authorizationGeneration;
        state.entries = index.entries;
        state.indexGeneration = index.generation;
        state.lastReconciledAt = result.indexedAt;
        state.failures = 0;
        report({
          type: 'reconciled', folderId: state.id, reasons, hints,
          mode: result.mode, generation: result.generation, indexedAt: result.indexedAt,
          totals: result.totals, issues: result.issues.length, changes,
        });
        // Lo ocurrido entre el recorrido y una observación recién abierta no se
        // notificó: se confirma con otra pasada, que ya no abre observaciones nuevas.
        if (syncWatchers(state) > 0) mark(state, 'verify');
      } catch (error) {
        if (!state.stopped) failure(state, error);
      } finally {
        state.running = null;
        state.lastRunEndedAt = Date.now();
        if (!state.stopped) {
          armPeriodic(state);
          arm(state);
        }
      }
    })();
    const running = state.running;
    inFlight.add(running);
    running.finally(() => inFlight.delete(running)).catch(() => {});
    return state.running;
  }

  // --- Vigencia de la autorización ---

  async function checkAuthorization(folderId, deep) {
    const state = folders.get(folderId);
    if (!state || state.stopped) return;
    try {
      if (!deep) {
        const listed = await motor.listAuthorizedFolders();
        if (!listed.some((folder) => folder.id === folderId)) stop(state, 'revoked', 'FOLDER_NOT_AUTHORIZED');
        return;
      }
      const index = await motor.readFolderIndex(folderId);
      if (state.stopped) return;
      if (state.authorization !== undefined
          && (!index || index.authorizationGeneration !== state.authorization)) {
        stop(state, 'authorization-changed');
      }
    } catch (error) {
      if (error?.code === 'FOLDER_NOT_AUTHORIZED') stop(state, 'revoked', error.code);
      // Otros fallos se resolverán en la siguiente comprobación o reconciliación.
    }
  }

  /**
   * Identidad de la raíz autorizada, solo de su propia entrada y sin seguir un
   * enlace final. Windows no notifica a su observación que la raíz se movió.
   * Es únicamente un disparador: la reconciliación segura decide qué es cierto.
   */
  async function rootIdentity(state) {
    try {
      const info = await lstat(state.root, { bigint: true });
      return info.isDirectory() ? `${info.dev}:${info.ino}` : 'not-directory';
    } catch (error) {
      return `error:${error?.code ?? 'UNKNOWN'}`;
    }
  }

  async function checkRoot(state) {
    const identity = await rootIdentity(state);
    if (state.stopped) return;
    if (state.rootIdentity !== undefined && identity !== state.rootIdentity) mark(state, 'root-changed');
    state.rootIdentity = identity;
  }

  function checkAll() {
    if (authorizationCheck || folders.size === 0) return authorizationCheck;
    authorizationCheck = (async () => {
      try {
        const listed = new Set((await motor.listAuthorizedFolders()).map((folder) => folder.id));
        for (const state of [...folders.values()]) {
          if (!listed.has(state.id)) stop(state, 'revoked', 'FOLDER_NOT_AUTHORIZED');
          else await checkRoot(state);
        }
      } catch {
        // El registro ilegible no concede nada: cada reconciliación lo vuelve a comprobar.
      } finally {
        authorizationCheck = null;
      }
    })();
    return authorizationCheck;
  }

  function ensureAuthorizationWatch() {
    if (!authorizationTimer) {
      const tick = () => {
        authorizationTimer = unref(setTimeout(tick, config.authorizationCheckMs));
        if (!baseWatcher) openBaseWatcher();
        checkAll();
      };
      authorizationTimer = unref(setTimeout(tick, config.authorizationCheckMs));
    }
    if (!baseWatcher) openBaseWatcher();
  }

  function openBaseWatcher() {
    if (unsafeWatchPath(motor.baseDirectory)) return;
    try {
      // La Base es de confianza y no recursiva: solo interesan sus registros de autorización.
      baseWatcher = watch(motor.baseDirectory, { persistent: false }, (_type, filename) => {
        if (filename == null) return checkAll();
        const match = AUTHORIZATION_FILE.exec(String(filename));
        if (match && folders.has(match[1])) checkAuthorization(match[1], true);
      });
      baseWatcher.on('error', () => {
        try { baseWatcher?.close(); } catch { /* ya cerrado */ }
        baseWatcher = null;
        checkAll();
      });
    } catch {
      baseWatcher = null; // Queda la comprobación periódica.
    }
  }

  function releaseAuthorizationWatch() {
    clearTimeout(authorizationTimer);
    authorizationTimer = null;
    try { baseWatcher?.close(); } catch { /* ya cerrado */ }
    baseWatcher = null;
  }

  function status(state) {
    return Object.freeze({
      folderId: state.id,
      mode: state.stopped ? 'stopped' : state.mode,
      strategy: state.strategy,
      watchers: state.watchers.size,
      pending: state.dirty,
      running: state.running !== null,
      failures: state.failures,
      indexGeneration: state.indexGeneration,
      lastReconciledAt: state.lastReconciledAt,
      ...(state.stopped ? { stopReason: state.stopReason } : {}),
    });
  }

  async function start(folderId) {
    const listed = await motor.listAuthorizedFolders();
    const folder = listed.find((item) => item.id === folderId);
    if (!folder) {
      throw new MotorError('FOLDER_NOT_AUTHORIZED', 'La carpeta no está autorizada o fue retirada.');
    }
    const baseline = await motor.readFolderIndex(folderId);
    if (closed || signal?.aborted) throw new MotorError('OBSERVER_CLOSED', 'El observador está cerrado.');
    const state = {
      id: folderId, root: folder.path, strategy: mode, mode: 'starting',
      watchers: new Map(), timer: null, periodic: null, running: null,
      dirty: false, reasons: new Set(), hints: new Set(), overflow: false, immediate: false,
      firstEventAt: 0, lastEventAt: 0, lastRunEndedAt: 0, failures: 0,
      stopped: false, stopReason: null, rootIdentity: undefined,
      authorization: baseline ? baseline.authorizationGeneration : undefined,
      entries: baseline?.entries ?? null, indexGeneration: baseline?.generation ?? null,
      lastReconciledAt: baseline?.updatedAt ?? null,
    };
    state.rootIdentity = await rootIdentity(state);
    if (closed || signal?.aborted) throw new MotorError('OBSERVER_CLOSED', 'El observador está cerrado.');
    folders.set(folderId, state);
    ensureAuthorizationWatch();
    // La observación empieza antes del recorrido inicial: lo que cambie durante él
    // vuelve a marcar la carpeta. Lo ocurrido sin observación se recupera aquí.
    syncWatchers(state);
    state.reasons = new Set(['start']);
    state.dirty = true;
    state.firstEventAt = state.lastEventAt = Date.now();
    await run(state, initialPriority);
    return status(state);
  }

  return Object.freeze({
    /**
     * Inicia la observación de una carpeta autorizada y la reconcilia una vez.
     * Resuelve cuando el índice es coherente con el estado inicial observado.
     * @param {string} folderId
     */
    async observe(folderId) {
      validateScopeId(folderId);
      if (closed) throw new MotorError('OBSERVER_CLOSED', 'El observador está cerrado.');
      if (folders.has(folderId)) return status(folders.get(folderId));
      if (!starting.has(folderId)) {
        const pending = start(folderId).finally(() => starting.delete(folderId));
        starting.set(folderId, pending);
      }
      return starting.get(folderId);
    },

    /** Reconciliación solicitada por el anfitrión; omite la espera de agrupación. */
    async reconcile(folderId) {
      validateScopeId(folderId);
      const state = folders.get(folderId);
      if (!state) throw new MotorError('NOT_OBSERVED', 'La carpeta no está en observación.');
      await motor.prioritizeIndex?.(folderId);
      await state.running;
      if (state.stopped) return status(state);
      mark(state, 'manual', undefined, true);
      clearTimeout(state.timer);
      state.timer = null;
      if (!state.running) await run(state, 'interactive');
      else await state.running;
      return status(state);
    },

    status(folderId) {
      validateScopeId(folderId);
      const state = folders.get(folderId);
      return state ? status(state) : null;
    },

    list() {
      return [...folders.values()].map(status);
    },

    /** Deja de observar; el índice publicado se conserva. */
    async unobserve(folderId) {
      validateScopeId(folderId);
      await starting.get(folderId)?.catch(() => {});
      const state = folders.get(folderId);
      if (!state) return false;
      stop(state, 'unobserved');
      await state.running;
      return true;
    },

    /** Detiene todo al cerrar la sesión. Espera a la reconciliación en curso. */
    async close() {
      closed = true;
      lifetime.abort(new MotorError('OBSERVER_CLOSED', 'El observador está cerrado.'));
      const running = [];
      for (const state of [...folders.values()]) {
        stop(state, 'closed');
        if (state.running) running.push(state.running);
      }
      releaseAuthorizationWatch();
      signal?.removeEventListener('abort', abort);
      await Promise.allSettled([...starting.values(), ...inFlight, ...running]);
    },
  });
}
