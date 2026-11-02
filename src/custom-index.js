import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { MotorError } from './errors.js';
import { readJson, writeJson, removeJson } from './storage.js';
import { withIndexLock } from './index-lock.js';
import { textVersion } from './text-modifier.js';
import { isExcluded } from './paths.js';

/**
 * Índices personalizados en CSV (Función 01). El usuario —normalmente a
 * través de su agente— decide qué se indexa (carpeta, subcarpeta, tipos,
 * extensiones, propiedades), qué campos se incluyen, dónde se guarda el CSV
 * (en una carpeta autorizada con permiso de escritura) y cuándo se actualiza
 * (a petición, al cambiar la carpeta durante una sesión o con una función
 * programada). La Base conserva solo la definición y el estado; el CSV es un
 * archivo abierto (UTF-8, RFC 4180) que cualquier herramienta puede usar.
 *
 * Se escribe con el escritor seguro de Mind: la primera vez sin reemplazar
 * nada y después con control de versión. Si alguien editó el CSV fuera de Mind,
 * no se sobrescribe (CUSTOM_INDEX_MODIFIED_OUTSIDE).
 */

export const CUSTOM_INDEX_LOCK = 'custom-index';
const ID = /^idx-[a-f0-9]{12}$/;
const MAX_INDEXES = 200;
const MAX_FIELDS = 64;
const MAX_ROWS = 200_000;
const MAX_CSV_BYTES = 16 * 1024 * 1024;
const BASE_FIELDS = Object.freeze({
  ruta: (folder, entry) => entry.path,
  nombre: (folder, entry) => entry.path.slice(entry.path.lastIndexOf('/') + 1),
  extension: (folder, entry) => {
    const name = entry.path.slice(entry.path.lastIndexOf('/') + 1);
    const dot = name.lastIndexOf('.');
    return entry.type === 'file' && dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  },
  carpeta: (folder, entry) => (entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : ''),
  tipo: (folder, entry) => ({ file: 'archivo', directory: 'carpeta', link: 'enlace' }[entry.type] ?? 'otro'),
  bytes: (folder, entry) => (Number.isSafeInteger(entry.size) ? entry.size : ''),
  modificado: (folder, entry) => entry.modifiedAt ?? '',
  creado: (folder, entry) => entry.createdAt ?? '',
  ruta_absoluta: (folder, entry) => path.join(folder.path, ...entry.path.split('/')),
});
export const CUSTOM_INDEX_FIELDS = Object.freeze(Object.keys(BASE_FIELDS));
const UPDATE_MODES = Object.freeze(['manual', 'al_cambiar']);
const TYPES = Object.freeze({ archivo: 'file', carpeta: 'directory' });

const invalid = (message) => new MotorError('INVALID_CUSTOM_INDEX', message);

/** Campo válido: uno de los básicos o "propiedad:<clave>". */
function parseField(value) {
  if (typeof value !== 'string') throw invalid('Cada campo debe ser texto.');
  if (CUSTOM_INDEX_FIELDS.includes(value)) return value;
  const match = /^propiedad:(.{1,64})$/u.exec(value);
  if (match && !/[\u0000-\u001f]/u.test(match[1])) return value;
  throw invalid(`Campo no admitido: ${value.slice(0, 80)}. Usa ${CUSTOM_INDEX_FIELDS.join(', ')} o propiedad:<clave>.`);
}

function parseDefinition(input, previous = null) {
  const pick = (key, fallback) => (input[key] === undefined ? fallback : input[key]);
  const name = pick('name', previous?.name);
  if (typeof name !== 'string' || name.trim() === '' || name.length > 120 || /[\u0000-\u001f]/u.test(name)) {
    throw invalid('El nombre debe ser texto de 1 a 120 caracteres.');
  }
  const fields = pick('fields', previous?.fields);
  if (!Array.isArray(fields) || fields.length === 0 || fields.length > MAX_FIELDS) throw invalid(`Indica entre 1 y ${MAX_FIELDS} campos.`);
  const parsedFields = fields.map(parseField);
  if (new Set(parsedFields).size !== parsedFields.length) throw invalid('Hay campos repetidos.');
  const filters = { ...(previous?.filters ?? {}), ...(input.filters ?? {}) };
  const prefix = filters.prefix ?? null;
  if (prefix !== null && (typeof prefix !== 'string' || prefix === '' || prefix.split('/').some((part) => part === '' || part === '.' || part === '..'))) {
    throw invalid('La subcarpeta debe ser una ruta relativa.');
  }
  const types = filters.types ?? ['file'];
  if (!Array.isArray(types) || types.length === 0 || !types.every((type) => Object.values(TYPES).includes(type))) throw invalid('Tipos no válidos.');
  const extensions = filters.extensions ?? null;
  if (extensions !== null && (!Array.isArray(extensions) || extensions.length > 64
      || !extensions.every((item) => typeof item === 'string' && /^\.?[^./\\]{1,32}$/u.test(item)))) throw invalid('Extensiones no válidas.');
  const properties = filters.properties ?? null;
  if (properties !== null && (typeof properties !== 'object' || Array.isArray(properties) || Object.keys(properties).length > 16
      || !Object.values(properties).every((value) => ['string', 'number', 'boolean'].includes(typeof value)))) {
    throw invalid('El filtro de propiedades debe ser { clave: texto, número o booleano }.');
  }
  const update = pick('update', previous?.update ?? 'manual');
  if (!UPDATE_MODES.includes(update)) throw invalid(`actualizar debe ser ${UPDATE_MODES.join(' o ')}.`);
  return {
    name: name.trim(), fields: parsedFields, update,
    filters: {
      prefix: prefix?.replace(/\/+$/u, '') ?? null, types: [...new Set(types)],
      extensions: extensions && extensions.map((item) => item.replace(/^\./u, '').toLowerCase()), properties,
    },
  };
}

/** Celda CSV (RFC 4180). Los valores que una hoja de cálculo ejecutaría como fórmula se neutralizan. */
export function csvCell(value) {
  if (value === null || value === undefined) return '';
  let text = typeof value === 'string' ? value : String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/u.test(text)) text = `'${text}`;
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function createCustomIndexes({ session }) {
  const { motor, policy } = session;
  const base = motor.baseDirectory;
  const host = Object.freeze({ cliente: 'Mind: índices personalizados' });
  const filename = (id) => {
    if (typeof id !== 'string' || !ID.test(id)) throw new MotorError('CUSTOM_INDEX_NOT_FOUND', 'Ese índice personalizado no existe.');
    return path.join(base, `custom-index-${id}.json`);
  };

  async function load(id) {
    const stored = await readJson(filename(id));
    const data = stored?.data;
    if (!data) throw new MotorError('CUSTOM_INDEX_NOT_FOUND', 'Ese índice personalizado no existe.');
    if (data.format !== 'mind-custom-index' || data.version !== 1 || data.id !== id) {
      throw new MotorError('CUSTOM_INDEX_CORRUPT', 'La definición del índice personalizado no tiene el formato esperado.');
    }
    return data;
  }

  async function ids() {
    return (await fs.readdir(base)).map((name) => /^custom-index-(idx-[a-f0-9]{12})\.json$/u.exec(name)?.[1]).filter(Boolean).sort();
  }

  /** Estado de los vínculos: la definición sirve solo para las autorizaciones con que se creó. */
  async function bindings(definition) {
    const source = await motor.getAuthorizedFolder(definition.source.folderId);
    const destination = await motor.getAuthorizedFolder(definition.destination.folderId);
    const problems = [];
    if (!source || source.generation !== definition.source.generation) problems.push('la carpeta indexada ya no está autorizada como cuando se creó el índice');
    else if (!(await policy.get(source.id))?.access.encontrar) problems.push('falta el permiso "encontrar" en la carpeta indexada');
    if (!destination || destination.generation !== definition.destination.generation) problems.push('la carpeta del CSV ya no está autorizada como cuando se creó el índice');
    else if (!(await policy.get(destination.id))?.access.escribir) problems.push('falta el permiso "escribir" en la carpeta del CSV');
    return { source, destination, problems };
  }

  /** Filas del CSV desde el índice vigente y las propiedades de la Base (sin abrir originales). */
  async function rows(definition, source, destination) {
    await session.ensureIndex(source.id, { timeoutMs: 60_000 });
    const index = await motor.readFolderIndex(source.id);
    if (!index) throw new MotorError('INDEX_UNAVAILABLE', 'La carpeta indexada todavía no tiene un índice vigente.');
    const properties = new Map(((await motor.readFolderProperties(source.id))?.entries ?? []).map((item) => [item.path, item.properties]));
    const { prefix, types, extensions, properties: wanted } = definition.filters;
    const selfPath = source.id === destination.id ? definition.destination.relativePath : null;
    const selected = index.entries.filter((entry) => {
      if (entry.path === selfPath || !types.includes(entry.type) || isExcluded(source.exclusions, entry.path)) return false;
      if (prefix && entry.path !== prefix && !entry.path.startsWith(`${prefix}/`)) return false;
      if (extensions) {
        const extension = BASE_FIELDS.extension(source, entry);
        if (!extensions.includes(extension)) return false;
      }
      if (wanted) {
        const own = properties.get(entry.path) ?? {};
        if (!Object.entries(wanted).every(([key, value]) => own[key] === value)) return false;
      }
      return true;
    }).sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
    if (selected.length > MAX_ROWS) throw new MotorError('CUSTOM_INDEX_TOO_LARGE', `El índice tendría más de ${MAX_ROWS} filas: acota la subcarpeta o los filtros.`);
    return selected.map((entry) => definition.fields.map((field) => (field.startsWith('propiedad:')
      ? properties.get(entry.path)?.[field.slice('propiedad:'.length)] ?? ''
      : BASE_FIELDS[field](source, entry))));
  }

  function render(definition, data) {
    const lines = [definition.fields.map(csvCell).join(','), ...data.map((row) => row.map(csvCell).join(','))];
    // BOM: Excel reconoce así el UTF-8; el resto de herramientas lo ignoran.
    return `﻿${lines.join('\r\n')}\r\n`;
  }

  /** Escribe el CSV con el escritor seguro: crear sin reemplazar o modificar sobre la última versión de Mind. */
  async function write(definition, destination, content) {
    const relativePath = definition.destination.relativePath;
    const last = definition.lastRun?.version ?? null;
    if (last) {
      try {
        const authorization = await motor.grantTextModify({ requester: host, folderId: destination.id, relativePath, maxBytes: MAX_CSV_BYTES });
        await motor.modifyTextFile({ requester: host, authorization, expectedVersion: last, content });
        return 'actualizado';
      } catch (error) {
        if (error.code === 'VERSION_CONFLICT') {
          throw new MotorError('CUSTOM_INDEX_MODIFIED_OUTSIDE', 'El CSV cambió fuera de Mind desde su última actualización: no se sobrescribe. Muévelo o bórralo y vuelve a actualizar el índice.');
        }
        if (!['FILE_NOT_FOUND', 'TEXT_NOT_FOUND'].includes(error.code)) throw error;
        // Movido o borrado: se crea de nuevo, sin reemplazar nada.
      }
    }
    try {
      const authorization = await motor.grantTextCreate({ requester: host, folderId: destination.id, relativePath, maxBytes: MAX_CSV_BYTES });
      await motor.createTextFile({ requester: host, authorization, content });
      return 'creado';
    } catch (error) {
      if (error.code === 'FILE_EXISTS') {
        throw new MotorError('CUSTOM_INDEX_DESTINATION_EXISTS', 'Ya existe un archivo con ese nombre y Mind no lo creó: no se reemplaza. Elige otra ruta para el CSV.');
      }
      throw error;
    }
  }

  async function regenerate(id) {
    return withIndexLock(base, id, async () => {
      const definition = await load(id);
      const { source, destination, problems } = await bindings(definition);
      if (problems.length > 0) {
        const error = new MotorError('CUSTOM_INDEX_INVALID', `No se puede actualizar el índice: ${problems.join('; ')}.`);
        definition.lastRun = { ...(definition.lastRun ?? {}), at: new Date().toISOString(), status: 'error', error: error.code };
        await writeJson(filename(id), definition);
        throw error;
      }
      let outcome;
      try {
        const data = await rows(definition, source, destination);
        const content = render(definition, data);
        if (Buffer.byteLength(content) > MAX_CSV_BYTES) throw new MotorError('CUSTOM_INDEX_TOO_LARGE', 'El CSV superaría 16 MiB: acota la subcarpeta o los filtros.');
        // Siempre por el escritor seguro: aunque los datos no cambien, se comprueba que
        // el CSV del disco sigue siendo el que escribió Mind.
        const unchanged = definition.lastRun?.version === textVersion(content);
        const written = await write(definition, destination, content);
        outcome = { status: unchanged && written === 'actualizado' ? 'sin-cambios' : written, rows: data.length, version: textVersion(content) };
      } catch (error) {
        definition.lastRun = { ...(definition.lastRun ?? {}), at: new Date().toISOString(), status: 'error', error: error.code ?? 'CUSTOM_INDEX_FAILED' };
        await writeJson(filename(id), definition);
        throw error;
      }
      definition.lastRun = { at: new Date().toISOString(), status: 'ok', rows: outcome.rows, version: outcome.version, error: null };
      await writeJson(filename(id), definition);
      await session.audit('indice-personalizado-actualizado', { indice: id, filas: outcome.rows, estado: outcome.status });
      return { id, ...outcome, csv: path.join(destination.path, ...definition.destination.relativePath.split('/')) };
    }, CUSTOM_INDEX_LOCK);
  }

  return Object.freeze({
    async list() {
      const result = [];
      for (const id of await ids()) {
        const definition = await load(id).catch(() => null);
        if (!definition) continue;
        const { destination, problems } = await bindings(definition);
        result.push({ ...definition, csv: destination ? path.join(destination.path, ...definition.destination.relativePath.split('/')) : null, problems });
      }
      return result;
    },

    get: load,

    /**
     * @param {{ name: string, sourceFolderId: string, destinationFolderId: string, relativePath: string, fields: string[], filters?: object, update?: string }} input
     */
    async create(input) {
      if ((await ids()).length >= MAX_INDEXES) throw new MotorError('CUSTOM_INDEX_LIMIT', `Se admiten ${MAX_INDEXES} índices personalizados como máximo.`);
      const parsed = parseDefinition(input);
      const relativePath = input.relativePath;
      if (typeof relativePath !== 'string' || !/\.csv$/iu.test(relativePath) || relativePath.split('/').some((part) => part === '' || part === '.' || part === '..')) {
        throw invalid('La ruta del CSV debe ser relativa y terminar en .csv.');
      }
      const source = await motor.getAuthorizedFolder(input.sourceFolderId);
      const destination = await motor.getAuthorizedFolder(input.destinationFolderId);
      if (!source || !destination) throw new MotorError('FOLDER_NOT_AUTHORIZED', 'La carpeta no está autorizada.');
      const id = `idx-${randomBytes(6).toString('hex')}`;
      const now = new Date().toISOString();
      const definition = {
        format: 'mind-custom-index', version: 1, id, ...parsed,
        source: { folderId: source.id, generation: source.generation },
        destination: { folderId: destination.id, generation: destination.generation, relativePath },
        createdAt: now, updatedAt: now, lastRun: null,
      };
      await writeJson(filename(id), definition);
      return definition;
    },

    /** Cambia campos, filtros, nombre o modo; la próxima actualización reescribe el CSV con el esquema nuevo. */
    async update(id, changes) {
      return withIndexLock(base, id, async () => {
        const definition = await load(id);
        const next = { ...definition, ...parseDefinition(changes, definition), updatedAt: new Date().toISOString() };
        await writeJson(filename(id), next);
        return next;
      }, CUSTOM_INDEX_LOCK);
    },

    /** Retira la definición; el CSV es del usuario y se queda donde está. */
    async remove(id) {
      return withIndexLock(base, id, async () => {
        await load(id);
        await removeJson(filename(id));
        return true;
      }, CUSTOM_INDEX_LOCK);
    },

    regenerate,
  });
}

/**
 * Extensión de sesión: los índices con actualizar = "al_cambiar" se regeneran
 * poco después de que cambie su carpeta, mientras la sesión está abierta. Las
 * escrituras del propio CSV no provocan otra actualización.
 */
export function createCustomIndexExtension(session) {
  const indexes = createCustomIndexes({ session });
  const timers = new Map();
  let unsubscribe = null;
  const DEBOUNCE_MS = 1500;
  return {
    async start() {
      unsubscribe = session.onChanges(async ({ folderId, changes }) => {
        for (const definition of await indexes.list()) {
          if (definition.update !== 'al_cambiar' || definition.source.folderId !== folderId || definition.problems.length > 0) continue;
          const own = definition.destination.folderId === folderId ? definition.destination.relativePath : null;
          const touched = [...changes.added, ...changes.modified, ...changes.removed].some((item) => item !== own);
          if (!touched) continue;
          clearTimeout(timers.get(definition.id));
          const timer = setTimeout(() => {
            timers.delete(definition.id);
            indexes.regenerate(definition.id).catch((error) => session.log('aviso', 'No se pudo actualizar un índice personalizado', { indice: definition.id, codigo: error.code ?? null }));
          }, DEBOUNCE_MS);
          timer.unref?.();
          timers.set(definition.id, timer);
        }
      });
    },
    async close() {
      unsubscribe?.();
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
}

/**
 * Ejecutor de confianza "indice-csv" (src/executors/index.js): una función
 * programada o por evento regenera un índice personalizado existente. Los
 * permisos se comprueban de nuevo en cada ejecución (regenerate).
 */
export function createCustomIndexExecutors(session) {
  const indexes = createCustomIndexes({ session });
  const indexId = (definition) => {
    const id = definition?.parametros?.indice;
    if (typeof id !== 'string' || !ID.test(id) || Object.keys(definition.parametros).some((key) => key !== 'indice')) {
      throw new MotorError('INVALID_FUNCTION_DEFINITION', 'El ejecutor "indice-csv" necesita parametros: { "indice": "<id del índice>" }.');
    }
    return id;
  };
  return Object.freeze({
    'indice-csv': Object.freeze({
      etiqueta: 'Actualizar un índice personalizado (CSV)',
      descripcion: 'Regenera el CSV de un índice personalizado ya creado con "crear_indice".',
      parametros: { indice: 'Id del índice personalizado (idx-…).' },
      timeoutMs: 60_000,
      validarDefinicion: (definition) => { indexId(definition); },
      acceptsDefinition: (definition) => { indexId(definition); return true; },
      async requisitos(definition) {
        const stored = await indexes.get(indexId(definition));
        return {
          carpetas: [
            { id: stored.source.folderId, permisos: ['encontrar'], uso: `indexar (${stored.name})` },
            { id: stored.destination.folderId, permisos: ['escribir'], uso: `escribir el CSV «${stored.destination.relativePath}» (nunca sobrescribe cambios ajenos)` },
          ],
          continuidad: [],
        };
      },
      validateInput: (input) => {
        if (!validInput(input)) throw new MotorError('INVALID_FUNCTION_INPUT', 'Entrada no válida.');
        return true;
      },
      async run({ definition }) {
        const id = indexId(definition);
        const stored = await indexes.get(id);
        const result = await indexes.regenerate(id);
        return {
          estado: result.status, filas: result.rows,
          archivos: [{ carpeta: stored.destination.folderId, ruta: stored.destination.relativePath }],
        };
      },
    }),
  });
}

function validInput(input) {
  return input && typeof input === 'object' && !Array.isArray(input) && typeof input.funcion === 'string' && typeof input.origen === 'string';
}
