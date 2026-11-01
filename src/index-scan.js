import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MotorError } from './errors.js';

const helper = fileURLToPath(new URL('./native_index.py', import.meta.url));
const SEPARATOR = '/';
const messages = {
  SCOPE_UNAVAILABLE: 'La carpeta autorizada no existe o no es accesible.',
  SCOPE_CHANGED: 'La ruta autorizada ya no corresponde a la carpeta registrada.',
  SAFE_SCAN_UNAVAILABLE: 'El recorrido seguro no está disponible en este entorno.',
  SAFE_SCAN_FAILED: 'El recorrido seguro falló.',
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
function runHelper({ root, maxEntries, pythonExecutable, exclude = [] }) {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonExecutable, ['-I', '-B', helper], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    const output = [];
    let diagnostic = '';
    let failure;
    child.on('error', (cause) => {
      failure ??= new MotorError('SAFE_SCAN_UNAVAILABLE', messages.SAFE_SCAN_UNAVAILABLE, { cause });
    });
    child.stdin.on('error', () => {});
    child.stdout.on('data', (chunk) => output.push(chunk));
    child.stderr.on('data', (chunk) => {
      if (diagnostic.length < 256) diagnostic += chunk.toString('utf8');
    });
    child.on('close', (code) => {
      if (failure) return reject(failure);
      if (code !== 0) {
        const nativeCode = diagnostic.trim();
        if (nativeCode === 'INDEX_LIMIT_EXCEEDED') {
          return reject(new MotorError(nativeCode, `La carpeta supera el límite de ${maxEntries} entradas indexables.`));
        }
        const errorCode = Object.hasOwn(messages, nativeCode) ? nativeCode : 'SAFE_SCAN_FAILED';
        return reject(new MotorError(errorCode, messages[errorCode]));
      }
      try {
        resolve(JSON.parse(Buffer.concat(output).toString('utf8')));
      } catch (cause) {
        reject(new MotorError('SAFE_SCAN_FAILED', messages.SAFE_SCAN_FAILED, { cause }));
      }
    });
    child.stdin.end(`${JSON.stringify({ root, maxEntries, ...(exclude.length > 0 ? { exclude } : {}) })}\n`);
  });
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
        changedAt: null, createdAt: null, state: 'unverified', reason: record.error,
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
 * @param {{ previous: IndexEntry[], maxEntries: number, pythonExecutable: string }} options
 * @returns {Promise<{ entries: IndexEntry[], issues: ScanIssue[] }>}
 */
export async function scanFolder(root, { previous, maxEntries, pythonExecutable, exclude = [] }) {
  const scanned = await runHelper({ root, maxEntries, pythonExecutable, exclude });
  return mergeScan(scanned, { previous, maxEntries });
}
