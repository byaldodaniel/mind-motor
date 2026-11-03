import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { MotorError } from '../errors.js';
import { readJson, writeJson, removeJson } from '../storage.js';
import { processAlive } from '../index-lock.js';

/**
 * Registros de automatizaciones en la Base (sin contenido de originales):
 *
 *   automation-consent-<id>.json   autorización del usuario: huella y generación
 *                                  exactas de la definición, generación de cada
 *                                  carpeta implicada, canal y si está activa.
 *   automation-state-<id>.json     marca de la última ejecución automática.
 *   function-history-<id>.json     historial acotado de ejecuciones (sin contenido).
 *   automation-<id>.lock           exclusión mutua entre procesos durante una ejecución.
 */

const FUNCTION_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const FOLDER_ID = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9-]{36}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const CONSENT_FILE = /^automation-consent-([a-z0-9][a-z0-9_-]{0,63})\.json$/;
const HISTORY_FILE = /^function-history-([a-z0-9][a-z0-9_-]{0,63})\.json$/;
export const CONSENT_CHANNELS = Object.freeze(['formulario-del-cliente', 'consola', 'administracion-local']);
export const HISTORY_LIMIT = 50;
/** Un bloqueo con dueño vivo se respeta; pasado este margen se considera abandonado. */
export const LOCK_MAX_AGE_MS = 2 * 3_600_000;
const EMPTY_LOCK_GRACE_MS = 30_000;

const corrupt = (what) => new MotorError('AUTOMATION_CORRUPT', `${what} de la automatización no tiene el formato esperado.`);

function isoOrNull(value) {
  return value === null || (typeof value === 'string' && Number.isFinite(Date.parse(value)));
}

function validConsent(data, id) {
  return data && typeof data === 'object' && !Array.isArray(data)
    && data.format === 'mind-automation' && data.version === 1 && data.functionId === id
    && typeof data.generation === 'string' && UUID.test(data.generation)
    && typeof data.fingerprint === 'string' && SHA256.test(data.fingerprint)
    && typeof data.executor === 'string' && FUNCTION_ID.test(data.executor)
    && data.folders && typeof data.folders === 'object' && !Array.isArray(data.folders)
    && Object.entries(data.folders).every(([folderId, generation]) => FOLDER_ID.test(folderId)
      && (generation === null || (typeof generation === 'string' && UUID.test(generation))))
    && typeof data.grantedAt === 'string' && Number.isFinite(Date.parse(data.grantedAt))
    && CONSENT_CHANNELS.includes(data.channel)
    && (data.client === null || typeof data.client === 'string')
    && typeof data.enabled === 'boolean' && isoOrNull(data.disabledAt);
}

function validState(data, id) {
  return data && typeof data === 'object' && !Array.isArray(data)
    && data.format === 'mind-automation-state' && data.version === 1 && data.functionId === id
    && isoOrNull(data.lastSlot) && isoOrNull(data.lastRunAt)
    && (data.lastStatus === null || ['completada', 'fallida'].includes(data.lastStatus))
    && (data.lastCode === null || typeof data.lastCode === 'string');
}

function validHistory(data, id) {
  return data && typeof data === 'object' && !Array.isArray(data)
    && data.format === 'mind-function-history' && data.version === 1 && data.functionId === id
    && Array.isArray(data.entries) && data.entries.every((entry) => entry && typeof entry === 'object'
      && typeof entry.fecha === 'string' && typeof entry.estado === 'string');
}

/** Dueño del bloqueo, si está demostrablemente abandonado; null ante cualquier duda. */
async function abandonedLock(filename, nowMs) {
  let info;
  let text;
  try {
    info = await fs.lstat(filename, { bigint: true });
    if (!info.isFile()) return null;
    text = await fs.readFile(filename, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  let owner = null;
  try {
    owner = JSON.parse(text);
  } catch {
    owner = null;
  }
  if (owner && typeof owner === 'object' && Number.isSafeInteger(owner.pid) && owner.pid > 0) {
    const age = nowMs - Date.parse(owner.createdAt);
    if (Number.isFinite(age) && age > LOCK_MAX_AGE_MS) return info;
    if (owner.host !== os.hostname()) return null;
    return processAlive(owner.pid) ? null : info;
  }
  return text === '' && nowMs - Number(info.mtimeMs) > EMPTY_LOCK_GRACE_MS ? info : null;
}

/** Aparta el bloqueo examinado sin poder retirar uno nuevo de otro proceso (como index-lock.js). */
async function recoverLock(filename, examined) {
  const aside = `${filename}.abandonado-${randomUUID()}`;
  try {
    await fs.rename(filename, aside);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  const moved = await fs.lstat(aside, { bigint: true });
  if (moved.dev !== examined.dev || moved.ino !== examined.ino) {
    await fs.link(aside, filename).catch(() => {});
    await fs.rm(aside, { force: true });
    return false;
  }
  await fs.rm(aside, { force: true });
  return true;
}

/**
 * @param {string} baseDirectory Ruta física de la Base.
 */
export function createAutomationStore(baseDirectory) {
  if (typeof baseDirectory !== 'string' || !path.isAbsolute(baseDirectory)) {
    throw new MotorError('INVALID_BASE', 'Se requiere la Base abierta por el Motor.');
  }
  const file = (prefix, id, extension = 'json') => {
    if (typeof id !== 'string' || !FUNCTION_ID.test(id)) {
      throw new MotorError('INVALID_FUNCTION_ID', 'El identificador de función no es válido.');
    }
    return path.join(baseDirectory, `${prefix}${id}.${extension}`);
  };

  async function readHistory(id) {
    const stored = await readJson(file('function-history-', id));
    if (stored === null) return [];
    if (!validHistory(stored.data, id)) throw corrupt('El historial');
    return stored.data.entries;
  }

  async function listIds(pattern) {
    const ids = [];
    for (const entry of (await fs.readdir(baseDirectory)).sort()) {
      const match = pattern.exec(entry);
      if (match) ids.push(match[1]);
    }
    return ids;
  }

  return Object.freeze({
    listConsentIds: () => listIds(CONSENT_FILE),
    listHistoryIds: () => listIds(HISTORY_FILE),

    async getConsent(id) {
      const stored = await readJson(file('automation-consent-', id));
      if (stored === null) return null;
      if (!validConsent(stored.data, id)) throw corrupt('La autorización');
      return stored.data;
    },

    async saveConsent(record) {
      const data = {
        format: 'mind-automation', version: 1, functionId: record.functionId,
        generation: record.generation, fingerprint: record.fingerprint, executor: record.executor,
        folders: record.folders, grantedAt: record.grantedAt, channel: record.channel,
        client: record.client ?? null, enabled: record.enabled !== false, disabledAt: record.disabledAt ?? null,
      };
      if (!validConsent(data, record.functionId)) throw corrupt('La autorización');
      await writeJson(file('automation-consent-', record.functionId), data);
      return data;
    },

    async getState(id) {
      const stored = await readJson(file('automation-state-', id));
      if (stored === null) return null;
      if (!validState(stored.data, id)) throw corrupt('La marca de ejecución');
      return stored.data;
    },

    async saveState(id, { lastSlot = null, lastRunAt = null, lastStatus = null, lastCode = null }) {
      const data = { format: 'mind-automation-state', version: 1, functionId: id, lastSlot, lastRunAt, lastStatus, lastCode };
      if (!validState(data, id)) throw corrupt('La marca de ejecución');
      await writeJson(file('automation-state-', id), data);
      return data;
    },

    removeState: (id) => removeJson(file('automation-state-', id)),

    readHistory,

    /** Añade una entrada; conserva las HISTORY_LIMIT más recientes. Un historial corrupto no se sobrescribe. */
    async appendHistory(id, entry) {
      const entries = await readHistory(id);
      await writeJson(file('function-history-', id), {
        format: 'mind-function-history', version: 1, functionId: id,
        entries: [...entries, entry].slice(-HISTORY_LIMIT),
      });
    },

    /** Retira autorización, marca e historial de una función (al retirarla). */
    async removeAll(id) {
      const removed = await Promise.all([
        removeJson(file('automation-consent-', id)),
        removeJson(file('automation-state-', id)),
        removeJson(file('function-history-', id)),
      ]);
      return removed.some(Boolean);
    },

    /**
     * Exclusión mutua entre procesos (y dentro del mismo proceso) para una función.
     * No espera: devuelve null si otro proceso vivo la tiene.
     * @returns {Promise<{ release: () => Promise<void> } | null>}
     */
    async tryLock(id) {
      const filename = file('automation-', id, 'lock');
      let handle = null;
      for (let attempt = 0; attempt < 2 && handle === null; attempt += 1) {
        try {
          handle = await fs.open(filename, 'wx', 0o600);
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
          // Reloj real: la antigüedad de un bloqueo se compara entre procesos.
          const examined = attempt === 0 ? await abandonedLock(filename, Date.now()) : null;
          if (!examined || !(await recoverLock(filename, examined))) return null;
        }
      }
      if (handle === null) return null;
      let owned = null;
      try {
        owned = await handle.stat({ bigint: true });
        await handle.writeFile(`${JSON.stringify({
          version: 1, owner: randomUUID(), pid: process.pid, host: os.hostname(), createdAt: new Date().toISOString(),
        })}\n`);
        await handle.close();
        handle = null;
      } catch (error) {
        await handle?.close().catch(() => {});
        await fs.rm(filename, { force: true });
        throw error;
      }
      let released = false;
      return {
        async release() {
          if (released) return;
          released = true;
          // Nunca se borra un bloqueo distinto del que se creó.
          const current = await fs.lstat(filename, { bigint: true }).catch(() => null);
          if (current && current.isFile() && current.dev === owned.dev && current.ino === owned.ino) {
            await fs.unlink(filename).catch(() => {});
          }
        },
      };
    },
  });
}
