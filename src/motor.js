import { lstat, realpath, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MOTOR_DIRECTORY = fileURLToPath(new URL('..', import.meta.url));
const VALID_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** @typedef {{ id: string, value: string }} TechnicalRecord */
/** @typedef {{ baseDirectory: string }} MotorOptions */
/**
 * @typedef {object} Motor
 * @property {string} baseDirectory Ruta física de la Base externa existente.
 * @property {(id: string, value: string) => Promise<TechnicalRecord>} writeRecord
 * @property {(id: string) => Promise<TechnicalRecord | null>} readRecord
 */

export class MotorError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'MotorError';
    this.code = code;
  }
}

function contains(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..'
    && !relative.startsWith(`..${path.sep}`));
}

function validateId(id) {
  if (typeof id !== 'string' || !VALID_ID.test(id)) {
    throw new MotorError('INVALID_ID', 'El identificador debe tener de 1 a 64 caracteres: minúsculas ASCII, números, guion o guion bajo; comenzar con letra o número.');
  }
}

async function rejectLink(filename) {
  try {
    if ((await lstat(filename)).isSymbolicLink()) {
      throw new MotorError('RECORD_LINK', 'Un registro técnico no puede ser un enlace.');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

/**
 * Abre una Base existente; no crea directorios ni mantiene recursos abiertos.
 * @param {MotorOptions} options
 * @returns {Promise<Motor>}
 */
export async function openMotor({ baseDirectory } = {}) {
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

  return Object.freeze({
    baseDirectory: base,

    async writeRecord(id, value) {
      const target = filename(id);
      if (typeof value !== 'string') {
        throw new MotorError('INVALID_VALUE', 'El valor de un registro técnico debe ser texto.');
      }
      await rejectLink(target);
      const record = { format: 'mind-technical-record', version: 1, id, value };
      const temporary = path.join(base, `.mind-${randomUUID()}.tmp`);
      try {
        // El temporal y el destino están en la misma Base y volumen.
        await writeFile(temporary, `${JSON.stringify(record)}\n`, {
          encoding: 'utf8', flag: 'wx', mode: 0o600, flush: true,
        });
        await rename(temporary, target);
      } finally {
        await rm(temporary, { force: true });
      }
      return { id, value };
    },

    async readRecord(id) {
      const target = filename(id);
      await rejectLink(target);
      let text;
      try {
        text = await readFile(target, 'utf8');
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
      let record;
      try {
        record = JSON.parse(text);
      } catch (error) {
        throw new MotorError('RECORD_CORRUPT', 'El registro técnico no contiene JSON válido.', { cause: error });
      }
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
