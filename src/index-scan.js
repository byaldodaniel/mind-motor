import { fileURLToPath } from 'node:url';
import { MotorError } from './errors.js';
import { spawnSupervised, DEFAULT_PROCESS_TIMEOUT_MS } from './process-supervisor.js';

const helper = fileURLToPath(new URL('./native_index.py', import.meta.url));
const SEPARATOR = '/';
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

/**
 * Ejecuta el auxiliar nativo. No hay alternativa por rutas: si el recorrido por
 * referencias no está disponible, la operación se deniega.
 */
async function runHelper({ root, maxEntries, pythonExecutable, exclude = [], signal, timeoutMs }) {
  let supervised;
  try {
    supervised = spawnSupervised(pythonExecutable, ['-I', '-B', helper, '--parent-pid', String(process.pid)], {
      signal, timeoutMs, kind: 'index',
    });
  } catch (error) {
    if (error.code === 'PROCESS_CANCELLED') throw new MotorError('SCAN_CANCELLED', 'El recorrido se canceló.');
    throw error;
  }
  const { child } = supervised;
  const output = [];
  // Protect Node from unbounded buffering even if the native helper misbehaves.
  const maxOutputBytes = Math.min(128 * 1024 * 1024, Math.max(1024 * 1024, maxEntries * 4096));
  let outputBytes = 0;
  let diagnostic = '';
  child.stdin.on('error', () => {});
  child.stdout.on('data', (chunk) => {
    outputBytes += chunk.length;
    if (outputBytes > maxOutputBytes) {
      output.length = 0;
      supervised.stop(new MotorError('SCAN_OUTPUT_LIMIT', 'El resultado del recorrido supera el límite de memoria.'));
    } else output.push(chunk);
  });
  child.stderr.on('data', (chunk) => {
    if (diagnostic.length < 256) diagnostic = (diagnostic + chunk.toString('utf8')).slice(0, 256);
  });
  child.stdin.end(`${JSON.stringify({ root, maxEntries, ...(exclude.length > 0 ? { exclude } : {}) })}\n`);
  const { code, error } = await supervised.completed;
  if (error) {
    if (error.code === 'PROCESS_CANCELLED') throw new MotorError('SCAN_CANCELLED', 'El recorrido se canceló.');
    if (error.code === 'PROCESS_TIMEOUT') throw new MotorError('SCAN_TIMEOUT', 'El recorrido excedió el tiempo permitido.');
    if (error.code === 'SCAN_OUTPUT_LIMIT') throw error;
    throw new MotorError('SAFE_SCAN_UNAVAILABLE', messages.SAFE_SCAN_UNAVAILABLE, { cause: error });
  }
  if (code !== 0) {
    const nativeCode = diagnostic.trim();
    if (nativeCode === 'INDEX_LIMIT_EXCEEDED') {
      throw new MotorError(nativeCode, `La carpeta supera el límite de ${maxEntries} entradas indexables.`);
    }
    const errorCode = Object.hasOwn(messages, nativeCode) ? nativeCode : 'SAFE_SCAN_FAILED';
    throw new MotorError(errorCode, messages[errorCode]);
  }
  try {
    return JSON.parse(Buffer.concat(output).toString('utf8'));
  } catch (cause) {
    throw new MotorError('SAFE_SCAN_FAILED', messages.SAFE_SCAN_FAILED, { cause });
  }
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
    if (record.error) {
      const before = known.get(record.path);
      add(before ? { ...before, state: 'unverified', reason: record.error } : {
        path: record.path, type: 'unknown', size: null, modifiedAt: null,
        changedAt: null, createdAt: null, identity: null, state: 'unverified', reason: record.error,
      });
      carryDescendants(record.path, record.error);
      continue;
    }
    add({
      path: record.path,
      type: record.type,
      size: record.size,
      modifiedAt: iso(record.modifiedMs),
      changedAt: iso(record.changedMs),
      createdAt: record.createdMs > 0 ? iso(record.createdMs) : null,
      identity: record.identity ?? null,
      state: record.listing ? 'not-listed' : 'indexed',
      reason: record.listing ?? null,
    });
    if (record.listing) carryDescendants(record.path, record.listing);
  }

  entries.sort((a, b) => (a.path < b.path ? -1 : 1));
  const issues = [...scanned.issues];
  issues.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { entries, issues };
}

/**
 * Recorre una raíz autorizada por referencias, sin seguir enlaces ni cambiar de volumen.
 * @param {string} root
 * @param {{ previous: IndexEntry[], maxEntries: number, pythonExecutable: string, signal?: AbortSignal, timeoutMs?: number }} options
 * @returns {Promise<{ entries: IndexEntry[], issues: ScanIssue[] }>}
 */
export async function scanFolder(root, { previous, maxEntries, pythonExecutable, exclude = [], signal, timeoutMs = DEFAULT_PROCESS_TIMEOUT_MS }) {
  const scanned = await runHelper({ root, maxEntries, pythonExecutable, exclude, signal, timeoutMs });
  return mergeScan(scanned, { previous, maxEntries });
}
