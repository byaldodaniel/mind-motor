import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MotorError } from './errors.js';
import { readJson, writeJson } from './storage.js';
import { contains } from './paths.js';
import { createFolderRegistry } from './folders.js';
import { createTextReader } from './text-reader.js';
import { createFolderIndexer } from './indexer.js';
import { createIndexSearch } from './search.js';

export { MotorError } from './errors.js';

const MOTOR_DIRECTORY = fileURLToPath(new URL('..', import.meta.url));
const VALID_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** @typedef {{ id: string, value: string }} TechnicalRecord */
/** @typedef {{ baseDirectory: string, pythonExecutable?: string }} MotorOptions */
/**
 * @typedef {object} Motor
 * @property {string} baseDirectory Ruta física de la Base externa existente.
 * @property {(id: string, value: string) => Promise<TechnicalRecord>} writeRecord
 * @property {(id: string) => Promise<TechnicalRecord | null>} readRecord
 * @property {(folderPath: string) => Promise<import('./folders.js').AuthorizedFolder>} authorizeFolder
 * @property {() => Promise<import('./folders.js').AuthorizedFolder[]>} listAuthorizedFolders
 * @property {(id: string) => Promise<boolean>} revokeFolder
 * @property {(id: string, targetPath: string) => Promise<{folderId: string, path: string}>} checkFolderScope
 * @property {(request: {requester: object, folderId: string, relativePath: string}) => Promise<object>} grantTextRead Solo anfitrión administrativo.
 * @property {(authorization: object) => boolean} revokeTextRead Solo antes del intento.
 * @property {(request: {requester: object, authorization: object}) => Promise<{folderId: string, relativePath: string, content: string}>} readTextFile
 * @property {(folderId: string) => Promise<import('./indexer.js').IndexResult>} indexFolder Solo administración local.
 * @property {(folderId: string) => Promise<import('./index-store.js').FolderIndex | null>} readFolderIndex Solo administración local.
 * @property {(request: import('./search.js').SearchRequest) => Promise<object>} searchFiles Solo anfitrión, sobre ámbitos que él autoriza.
 */

function validateId(id) {
  if (typeof id !== 'string' || !VALID_ID.test(id)) {
    throw new MotorError('INVALID_ID', 'El identificador debe tener de 1 a 64 caracteres: minúsculas ASCII, números, guion o guion bajo; comenzar con letra o número.');
  }
}

/**
 * Abre una Base existente; no crea directorios ni mantiene recursos abiertos.
 * @param {MotorOptions} options
 * @returns {Promise<Motor>}
 */
export async function openMotor({ baseDirectory, pythonExecutable } = {}) {
  if (typeof baseDirectory !== 'string' || !path.isAbsolute(baseDirectory)) {
    throw new MotorError('INVALID_BASE', 'Indica una ruta absoluta a una Base existente.');
  }
  let base;
  try {
    base = await realpath(baseDirectory);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new MotorError('BASE_NOT_FOUND', 'La Base debe existir antes de abrir el Motor.', { cause: error });
    }
    throw error;
  }
  if (!(await lstat(base)).isDirectory()) {
    throw new MotorError('INVALID_BASE', 'La Base debe ser un directorio.');
  }
  const motor = await realpath(MOTOR_DIRECTORY);
  if (contains(motor, base) || contains(base, motor)) {
    throw new MotorError('BASE_OVERLAPS_MOTOR', 'Motor y Base deben ser directorios independientes, sin contenerse.');
  }

  function filename(id) {
    validateId(id);
    // El prefijo evita nombres reservados de Windows, incluso para id="con".
    return path.join(base, `record-${id}.json`);
  }

  const { loadAuthorizedFolder, ...folders } = createFolderRegistry(base, motor);
  const indexer = createFolderIndexer({
    baseDirectory: base,
    pythonExecutable,
    resolveScope: async (id) => {
      const folder = await loadAuthorizedFolder(id);
      if (!folder) throw new MotorError('FOLDER_NOT_AUTHORIZED', 'La carpeta no está autorizada o fue retirada.');
      return folder;
    },
  });
  return Object.freeze({
    baseDirectory: base,
    ...folders,
    ...createTextReader({ loadAuthorizedFolder, pythonExecutable }),
    indexFolder: indexer.indexFolder,
    readFolderIndex: indexer.readFolderIndex,
    ...createIndexSearch({ readFolderIndex: indexer.readFolderIndex, loadAuthorizedFolder }),

    async revokeFolder(id) {
      // Primero se retira la autoridad. Un fallo de limpieza no la restaura.
      const removed = await folders.revokeFolder(id);
      await indexer.removeFolderIndex(id);
      return removed;
    },

    async writeRecord(id, value) {
      const target = filename(id);
      if (typeof value !== 'string') {
        throw new MotorError('INVALID_VALUE', 'El valor de un registro técnico debe ser texto.');
      }
      const record = { format: 'mind-technical-record', version: 1, id, value };
      await writeJson(target, record);
      return { id, value };
    },

    async readRecord(id) {
      const target = filename(id);
      const stored = await readJson(target);
      if (stored === null) return null;
      const record = stored.data;
      if (!record || typeof record !== 'object' || Array.isArray(record)
          || Object.keys(record).length !== 4
          || record.format !== 'mind-technical-record' || record.version !== 1
          || record.id !== id || typeof record.value !== 'string') {
        throw new MotorError('RECORD_CORRUPT', 'El registro técnico no tiene el formato esperado.');
      }
      return { id: record.id, value: record.value };
    },
  });
}
