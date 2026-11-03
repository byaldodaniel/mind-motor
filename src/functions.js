import { readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { MotorError } from './errors.js';
import { readJson, writeJson, removeJson } from './storage.js';

const VALID_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const PREFIX = 'function-definition-';
const FILENAME = /^function-definition-([a-z0-9][a-z0-9_-]{0,63})\.json$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

function validateId(id) {
  if (typeof id !== 'string' || VALID_ID.exec(id)?.[0] !== id) {
    throw new MotorError('INVALID_FUNCTION_ID', 'El identificador de función debe tener de 1 a 64 caracteres: minúsculas ASCII, números, guion o guion bajo; comenzar con letra o número.');
  }
}

// Copia solo datos JSON, sin invocar getters ni toJSON ni perder valores al serializar.
export function copyJson(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || ancestors.has(value)) throw new TypeError();
  const array = Array.isArray(value);
  if (!array && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors).filter((key) => !(array && key === 'length'));
  if (array && (keys.length !== value.length
      || keys.some((key, index) => key !== String(index)))) throw new TypeError();
  ancestors.add(value);
  try {
    const entries = keys.map((key) => {
      const descriptor = descriptors[key];
      if (typeof key !== 'string' || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw new TypeError();
      }
      return [key, copyJson(descriptor.value, ancestors)];
    });
    return array ? entries.map(([, item]) => item) : Object.fromEntries(entries);
  } finally {
    ancestors.delete(value);
  }
}

function validateDefinition(definition, code = 'INVALID_FUNCTION_DEFINITION') {
  try {
    if (!definition || typeof definition !== 'object' || Array.isArray(definition)) throw new TypeError();
    return copyJson(definition);
  } catch {
    throw new MotorError(code, 'La definición de función debe ser un objeto de datos JSON válido.');
  }
}

/**
 * Módulo interno: recibe la Base canónica de un Motor ya abierto por el anfitrión.
 * No concede permisos ni expone ejecución. El anfitrión debe serializar las
 * mutaciones del mismo id, también entre procesos (igual que los otros registros).
 * @param {{ baseDirectory: string }} motor Contexto confiable de openMotor.
 */
export function createFunctionRegistry(motor) {
  const baseDirectory = motor?.baseDirectory;
  if (typeof baseDirectory !== 'string' || baseDirectory.includes('\0') || !path.isAbsolute(baseDirectory)) {
    throw new MotorError('INVALID_BASE', 'Se requiere el contexto de una Base existente abierta por el Motor.');
  }

  function filename(id) {
    validateId(id);
    return path.join(baseDirectory, `${PREFIX}${id}.json`);
  }

  async function load(id) {
    const stored = await readJson(filename(id));
    if (stored === null) return null;
    const data = stored.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)
        || !((data.version === 1 && Object.keys(data).length === 4)
          || (data.version === 2 && Object.keys(data).length === 5
            && typeof data.generation === 'string' && data.generation.length === 36 && UUID.test(data.generation)))
        || data.format !== 'mind-function-definition'
        || data.id !== id || !Object.hasOwn(data, 'definition')) {
      throw new MotorError('FUNCTION_CORRUPT', 'El registro de función no tiene el formato esperado.');
    }
    return { id, definition: validateDefinition(data.definition, 'FUNCTION_CORRUPT'),
      generation: data.version === 2 ? data.generation : null };
  }

  async function save(id, definition) {
    await writeJson(filename(id), {
      format: 'mind-function-definition', version: 2, id, definition, generation: randomUUID(),
    });
    return { id, definition };
  }

  return Object.freeze({
    /** Crea, sin reemplazar una definición existente. */
    async createFunction(id, definition) {
      validateId(id);
      const copied = validateDefinition(definition);
      if (await load(id)) {
        throw new MotorError('FUNCTION_EXISTS', 'Ya existe una definición con ese identificador.');
      }
      return save(id, copied);
    },

    async getFunction(id) {
      const record = await load(id);
      return record ? { id: record.id, definition: record.definition } : null;
    },

    // Solo consumo interno del ejecutor: definición e identidad de una misma lectura.
    // Los v1 se pueden consultar, pero requieren actualización explícita antes de vincular.
    getFunctionVersion: load,

    /** Orden por id; una corrupción produce un error, nunca una lista parcial. */
    async listFunctions() {
      const result = [];
      for (const entry of (await readdir(baseDirectory)).sort()) {
        if (!entry.startsWith(PREFIX) || !entry.endsWith('.json')) continue;
        const match = FILENAME.exec(entry);
        if (!match) throw new MotorError('FUNCTION_CORRUPT', 'Nombre de registro de función no válido.');
        const record = await load(match[1]);
        if (record) result.push({ id: record.id, definition: record.definition });
      }
      return result;
    },

    /** Sustituye la definición completa; no crea una función ausente. */
    async updateFunction(id, definition) {
      validateId(id);
      const copied = validateDefinition(definition);
      if (!(await load(id))) {
        throw new MotorError('FUNCTION_NOT_FOUND', 'No existe una definición con ese identificador.');
      }
      return save(id, copied);
    },

    /** Retira únicamente el registro validado; no elimina recursos ni originales. */
    async retireFunction(id) {
      if (!(await load(id))) return false;
      return removeJson(filename(id));
    },
  });
}
