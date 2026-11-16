import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MotorError } from './errors.js';
import { DEFAULT_PROCESS_TIMEOUT_MS } from './process-supervisor.js';

const helper = fileURLToPath(new URL('./native_index.py', import.meta.url));
const SEPARATOR = '/';
const FOLD_CASE = process.platform === 'win32' || process.platform === 'darwin';
const SCANNER_IDLE_MS = 30_000;
const messages = {
  SCOPE_UNAVAILABLE: 'La carpeta autorizada no existe o no es accesible.',
  SCOPE_CHANGED: 'La ruta autorizada ya no corresponde a la carpeta registrada.',
  SAFE_SCAN_UNAVAILABLE: 'El recorrido seguro no está disponible en este entorno.',
  SAFE_SCAN_FAILED: 'El recorrido seguro falló.',
  SAFE_SCAN_PARENT_GONE: 'Terminó el proceso propietario del recorrido.',
};

/** @typedef {'file' | 'directory' | 'link' | 'other' | 'unknown'} EntryType */
/** @typedef {'indexed' | 'not-listed' | 'unverified'} EntryState */
/**
 * Metadatos de una entrada. Nunca incluye contenido ni destino de enlaces.
 * @typedef {object} IndexEntry
 * @property {string} path Ruta relativa a la raíz, separada por "/".
 * @property {EntryType} type
 * @property {number | null} size Solo para archivos regulares.
 * @property {string | null} modifiedAt
 * @property {string | null} changedAt Cambio de metadatos (ctime).
 * @property {string | null} createdAt null si el sistema no lo informa.
 * @property {string | null} identity Identidad del objeto (volumen e inode/FileId), obtenida por el auxiliar seguro.
 * @property {EntryState} state
 * @property {string | null} reason Código que explica un estado distinto de "indexed".
 */
/** @typedef {{ path: string, code: string }} ScanIssue */

function iso(milliseconds) {
  if (!Number.isSafeInteger(milliseconds)) return null;
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function mapNativeFailure(code, maxEntries) {
  if (code === 'INDEX_LIMIT_EXCEEDED') {
    return new MotorError(code, `La carpeta supera el límite de ${maxEntries} entradas indexables.`);
  }
  const errorCode = Object.hasOwn(messages, code) ? code : 'SAFE_SCAN_FAILED';
  return new MotorError(errorCode, messages[errorCode]);
}

const daemonPool = new Map();

function getDaemon(pythonExecutable) {
  let state = daemonPool.get(pythonExecutable);
  if (state) return state;

  state = {
    pythonExecutable,
    child: null,
    buffer: '',
    stderr: '',
    queue: Promise.resolve(),
    active: null,
    idleTimer: null,
  };
  daemonPool.set(pythonExecutable, state);
  return state;
}

function disposeDaemon(state, error) {
  clearTimeout(state.idleTimer);
  state.idleTimer = null;
  const child = state.child;
  state.child = null;
  state.buffer = '';
  const pending = state.active;
  state.active = null;
  if (child) {
    try { child.stdin?.end(); } catch { /* noop */ }
    if (!child.killed) try { child.kill(); } catch { /* noop */ }
  }
  if (pending && error) pending.reject(error);
}

function armDaemonIdle(state) {
  clearTimeout(state.idleTimer);
  if (state.active || !state.child) return;
  state.child.unref?.();
  state.child.stdin?.unref?.();
  state.child.stdout?.unref?.();
  state.child.stderr?.unref?.();
  state.idleTimer = setTimeout(() => {
    if (!state.active && state.child) disposeDaemon(state, null);
  }, SCANNER_IDLE_MS);
  state.idleTimer.unref?.();
}

function ensureDaemonChild(state) {
  if (state.child && !state.child.killed && state.child.exitCode === null) return state.child;
  const child = spawn(state.pythonExecutable, ['-I', '-B', helper, '--parent-pid', String(process.pid), '--daemon'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false,
  });
  state.child = child;
  state.buffer = '';
  state.stderr = '';

  child.stdin.on('error', () => {});
  child.stderr.on('data', (chunk) => {
    if (state.stderr.length < 256) state.stderr = (state.stderr + chunk.toString('utf8')).slice(0, 256);
  });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    if (state.child !== child) return;
    state.buffer += chunk;
    const newline = state.buffer.indexOf('\n');
    if (newline === -1) return;
    const line = state.buffer.slice(0, newline);
    state.buffer = state.buffer.slice(newline + 1);
    const current = state.active;
    if (!current) return;
    state.active = null;
    try {
      const parsed = JSON.parse(line);
      current.resolve(parsed);
    } catch (cause) {
      current.reject(new MotorError('SAFE_SCAN_FAILED', messages.SAFE_SCAN_FAILED, { cause }));
    }
  });
  child.once('error', (cause) => {
    if (state.child !== child) return;
    disposeDaemon(state, new MotorError('SAFE_SCAN_UNAVAILABLE', messages.SAFE_SCAN_UNAVAILABLE, { cause }));
  });
  child.once('close', (code) => {
    if (state.child !== child) return;
    const err = state.stderr.trim()
      ? mapNativeFailure(state.stderr.trim(), state.active?.maxEntries ?? 0)
      : new MotorError(code === 0 ? 'SAFE_SCAN_FAILED' : 'SAFE_SCAN_FAILED', messages.SAFE_SCAN_FAILED);
    disposeDaemon(state, err);
  });
  return child;
}

/** Cierra los subprocesos Python del escáner persistente para liberar memoria y procesos al reposar o salir. */
export function closePersistentScanner() {
  for (const state of daemonPool.values()) {
    disposeDaemon(state, new MotorError('SCAN_CANCELLED', 'El escáner se detuvo.'));
  }
  daemonPool.clear();
}

process.once('exit', closePersistentScanner);

async function runDaemonRequest({ root, maxEntries, pythonExecutable, exclude = [], subpaths, signal, timeoutMs }) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 1_800_000) {
    throw new MotorError('INVALID_PROCESS_TIMEOUT', 'El tiempo máximo debe estar entre 1 y 1800000 ms.');
  }
  if (signal?.aborted) throw new MotorError('SCAN_CANCELLED', 'El recorrido se canceló.');

  const state = getDaemon(pythonExecutable);
  const runTask = async () => {
    if (signal?.aborted) throw new MotorError('SCAN_CANCELLED', 'El recorrido se canceló.');
    clearTimeout(state.idleTimer);
    state.idleTimer = null;
    const child = ensureDaemonChild(state);
    child.ref?.();
    child.stdin?.ref?.();
    child.stdout?.ref?.();
    child.stderr?.ref?.();
    const maxOutputBytes = Math.min(128 * 1024 * 1024, Math.max(1024 * 1024, maxEntries * 4096));

    return await new Promise((resolve, reject) => {
      let settled = false;
      let timer;
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        child.stdout?.removeListener('data', checkSize);
      };
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (state.active === pending) state.active = null;
        fn(value);
        armDaemonIdle(state);
      };
      const onAbort = () => {
        const err = new MotorError('SCAN_CANCELLED', 'El recorrido se canceló.');
        disposeDaemon(state, null);
        finish(reject, err);
      };
      const checkSize = () => {
        if (Buffer.byteLength(state.buffer, 'utf8') > maxOutputBytes) {
          const err = new MotorError('SCAN_OUTPUT_LIMIT', 'El resultado del recorrido supera el límite de memoria.');
          disposeDaemon(state, null);
          finish(reject, err);
        }
      };

      const pending = {
        maxEntries,
        resolve: (parsed) => finish(resolve, parsed),
        reject: (err) => finish(reject, err),
      };
      state.active = pending;

      timer = setTimeout(() => {
        const err = new MotorError('SCAN_TIMEOUT', 'El recorrido excedió el tiempo permitido.');
        disposeDaemon(state, null);
        finish(reject, err);
      }, timeoutMs);
      timer.unref?.();
      signal?.addEventListener('abort', onAbort, { once: true });
      child.stdout.on('data', checkSize);

      const payload = {
        root,
        maxEntries,
        ...(exclude.length > 0 ? { exclude } : {}),
        ...(Array.isArray(subpaths) ? { subpaths } : {}),
      };
      child.stdin.write(`${JSON.stringify(payload)}\n`, (writeErr) => {
        if (writeErr) {
          const err = new MotorError('SAFE_SCAN_UNAVAILABLE', messages.SAFE_SCAN_UNAVAILABLE, { cause: writeErr });
          disposeDaemon(state, null);
          finish(reject, err);
        }
      });
    });
  };

  const queued = state.queue.then(runTask, runTask);
  state.queue = queued.catch(() => {});
  const response = await queued;
  if (!response?.ok) throw mapNativeFailure(response?.error ?? 'SAFE_SCAN_FAILED', maxEntries);
  return response;
}

/**
 * Ejecuta el auxiliar nativo (persistente reutilizable con respaldo de un solo uso).
 */
async function runHelper({ root, maxEntries, pythonExecutable, exclude = [], subpaths, signal, timeoutMs }) {
  return runDaemonRequest({ root, maxEntries, pythonExecutable, exclude, subpaths, signal, timeoutMs });
}

function toEntry(record, known) {
  if (record.error) {
    const before = known.get(record.path);
    return before ? { ...before, state: 'unverified', reason: record.error } : {
      path: record.path, type: 'unknown', size: null, modifiedAt: null,
      changedAt: null, createdAt: null, identity: null, state: 'unverified', reason: record.error,
    };
  }
  return {
    path: record.path,
    type: record.type,
    size: record.size,
    modifiedAt: iso(record.modifiedMs),
    changedAt: iso(record.changedMs),
    createdAt: record.createdMs > 0 ? iso(record.createdMs) : null,
    identity: record.identity ?? null,
    state: record.listing ? 'not-listed' : 'indexed',
    reason: record.listing ?? null,
  };
}

/**
 * Convierte los registros del auxiliar en entradas del índice. Las que no pueden
 * comprobarse conservan su último registro como "unverified", para no confundir
 * un acceso denegado con una eliminación.
 * @param {{ records: object[], issues: ScanIssue[] }} scanned
 * @param {{ previous: IndexEntry[], maxEntries: number }} options
 * @returns {{ entries: IndexEntry[], issues: ScanIssue[] }}
 */
export function mergeScan(scanned, { previous, maxEntries }) {
  const known = new Map(previous.map((entry) => [entry.path, entry]));
  const entries = [];

  function add(entry) {
    entries.push(entry);
    if (entries.length > maxEntries) {
      throw new MotorError('INDEX_LIMIT_EXCEEDED', `La carpeta supera el límite de ${maxEntries} entradas indexables.`);
    }
  }

  function carryDescendants(relative, reason) {
    const prefix = `${relative}${SEPARATOR}`;
    for (const entry of previous) {
      if (entry.path.startsWith(prefix)) add({ ...entry, state: 'unverified', reason });
    }
  }

  for (const record of scanned.records) {
    add(toEntry(record, known));
    const carryReason = record.error ?? record.listing;
    if (carryReason) carryDescendants(record.path, carryReason);
  }

  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const issues = [...scanned.issues];
  issues.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { entries, issues };
}

/** Mezcla una pasada parcial por subrutas sobre el índice previo. */
export function mergeBranchScan(scanned, { previous, previousIssues = [], maxEntries }) {
  const foldKey = (value) => (FOLD_CASE ? value.toLowerCase() : value);
  const rawPrefixes = [...new Set([...(scanned.scannedPrefixes ?? []), ...(scanned.missingPrefixes ?? [])])];
  if (rawPrefixes.includes('')) {
    return mergeScan(scanned, { previous, maxEntries });
  }

  const known = new Map(previous.map((entry) => [entry.path, entry]));
  const foldedPrefixes = rawPrefixes.map((p) => foldKey(p));
  const matchesAnyPrefix = (target) => {
    const k = foldKey(target);
    return foldedPrefixes.some((p) => k === p || k.startsWith(`${p}${SEPARATOR}`));
  };

  const carriedByPath = new Map();
  for (const record of scanned.records) {
    const reason = record.error ?? record.listing;
    if (!reason) continue;
    const prefix = `${record.path}${SEPARATOR}`;
    for (const entry of previous) {
      if (entry.path.startsWith(prefix)) {
        carriedByPath.set(entry.path, { ...entry, state: 'unverified', reason });
      }
    }
  }

  const upsertsMap = new Map();
  for (const entry of carriedByPath.values()) upsertsMap.set(entry.path, entry);
  for (const record of scanned.records) {
    const converted = toEntry(record, known);
    upsertsMap.set(converted.path, converted);
  }

  const entries = [];
  const removedExact = [];
  for (const entry of previous) {
    if (matchesAnyPrefix(entry.path)) {
      const replacement = upsertsMap.get(entry.path);
      if (!replacement) {
        if (!rawPrefixes.some((p) => entry.path === p || entry.path.startsWith(`${p}${SEPARATOR}`))) {
          removedExact.push(entry.path);
        }
      }
      continue;
    }
    if (upsertsMap.has(entry.path)) continue;
    entries.push(entry);
  }

  const upserts = [...upsertsMap.values()];
  for (const entry of upserts) entries.push(entry);
  if (entries.length > maxEntries) {
    throw new MotorError('INDEX_LIMIT_EXCEEDED', `La carpeta supera el límite de ${maxEntries} entradas indexables.`);
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const issues = [
    ...previousIssues.filter((issue) => !issue.path || !matchesAnyPrefix(issue.path)),
    ...scanned.issues,
  ];
  issues.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { entries, issues, prefixes: rawPrefixes, removedExact, upserts };
}

/**
 * Recorre una raíz autorizada por referencias, sin seguir enlaces ni cambiar de volumen.
 * @param {string} root
 * @param {{ previous: IndexEntry[], previousIssues?: ScanIssue[], maxEntries: number, pythonExecutable: string, subpaths?: string[], signal?: AbortSignal, timeoutMs?: number }} options
 */
export async function scanFolder(root, { previous, previousIssues = [], maxEntries, pythonExecutable, exclude = [], subpaths, signal, timeoutMs = DEFAULT_PROCESS_TIMEOUT_MS }) {
  const scanned = await runHelper({ root, maxEntries, pythonExecutable, exclude, subpaths, signal, timeoutMs });
  if (Array.isArray(subpaths) && subpaths.length > 0 && !scanned.scannedPrefixes?.includes('')) {
    return mergeBranchScan(scanned, { previous, previousIssues, maxEntries });
  }
  return mergeScan(scanned, { previous, maxEntries });
}
