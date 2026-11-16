import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { MotorError } from './errors.js';
import { readJson, writeJson } from './storage.js';
import { contains } from './paths.js';
import { withIndexLock } from './index-lock.js';

/**
 * Marca de formato de la Base del producto. Permite que un Motor reconozca una
 * Base creada por una versión posterior y se niegue a abrirla en lugar de
 * alterarla (protección ante volver a una versión anterior del Motor).
 */
export const BASE_MARKER = 'mind-base.json';
export const BASE_FORMAT_VERSION = 3;

function validMarker(data) {
  return data && typeof data === 'object' && !Array.isArray(data)
    && data.format === 'mind-base' && Number.isSafeInteger(data.version) && data.version >= 1
    && typeof data.baseId === 'string' && /^[a-f0-9-]{36}$/.test(data.baseId)
    && typeof data.createdAt === 'string';
}

/** Lectura sin creación ni migración: también la usa la API del núcleo. */
export async function readBaseMarker(baseDirectory) {
  const stored = await readJson(path.join(baseDirectory, BASE_MARKER));
  if (stored === null) return null;
  if (!validMarker(stored.data)) {
    throw new MotorError('BASE_MARKER_CORRUPT', 'La marca de formato de la Base no es válida; no se modifica la Base.');
  }
  if (stored.data.version > BASE_FORMAT_VERSION) {
    throw new MotorError('BASE_TOO_NEW', 'La Base fue creada por una versión más reciente de Mind. Actualiza el Motor; esta versión no la modificará.');
  }
  return stored.data;
}

/**
 * Barrera anterior a publicar subformatos incompatibles. Bajo un bloqueo global
 * solo eleva la marca, conservando identidad y fechas; nunca reescribe datos.
 * Si la publicación posterior falla, conservar una marca más alta es seguro.
 */
export async function prepareBaseFormat(baseDirectory, version, { motorVersion } = {}) {
  if (!Number.isSafeInteger(version) || version < 1 || version > BASE_FORMAT_VERSION) {
    throw new MotorError('BASE_TOO_NEW', 'Este Motor no puede escribir ese formato de Base.');
  }
  return withIndexLock(baseDirectory, 'migration', async () => {
    const current = await readBaseMarker(baseDirectory);
    if (current && current.version >= version) return current;
    const marker = current ? { ...current, version } : {
      format: 'mind-base', version, baseId: randomUUID(),
      createdAt: new Date().toISOString(), createdBy: motorVersion ?? null,
    };
    await writeJson(path.join(baseDirectory, BASE_MARKER), marker);
    return marker;
  }, 'base-format');
}

/**
 * Abre la Base del producto o la crea en el primer uso. Nunca elimina ni
 * reescribe datos existentes: si falta la marca en una Base anterior, solo la añade.
 * @param {string} baseDirectory Ruta absoluta.
 * @param {{ create?: boolean, motorVersion: string, protectedFrom?: string }} options
 * @returns {Promise<{ baseDirectory: string, baseId: string, createdAt: string, created: boolean, version: number }>}
 */
export async function ensureBase(baseDirectory, { create = true, motorVersion, protectedFrom } = {}) {
  if (typeof baseDirectory !== 'string' || !path.isAbsolute(baseDirectory)) {
    throw new MotorError('INVALID_BASE', 'La ruta de la Base debe ser absoluta.');
  }
  if (protectedFrom && contains(protectedFrom, baseDirectory)) {
    throw new MotorError('BASE_OVERLAPS_MOTOR', 'La Base no puede estar dentro del Motor.');
  }
  let created = false;
  try {
    const info = await fs.lstat(baseDirectory);
    if (info.isSymbolicLink()) {
      // Se admite una Base enlazada, pero se resuelve a su ubicación física.
      const target = await fs.stat(baseDirectory);
      if (!target.isDirectory()) throw new MotorError('INVALID_BASE', 'La Base debe ser un directorio.');
    } else if (!info.isDirectory()) {
      throw new MotorError('INVALID_BASE', 'La Base debe ser un directorio.');
    }
  } catch (error) {
    if (error instanceof MotorError) throw error;
    if (error.code !== 'ENOENT') throw error;
    if (!create) throw new MotorError('BASE_NOT_FOUND', 'La Base no existe.');
    // Solo el usuario de Mind debe poder leerla: contiene índices y continuidad.
    await fs.mkdir(baseDirectory, { recursive: true, mode: 0o700 });
    created = true;
  }
  const physical = await fs.realpath(baseDirectory);
  // Abrir una Base v1 no la migra. La primera escritura de un subformato nuevo
  // eleva su marca antes de publicar; una Base nueva empieza en formato actual.
  const marker = await readBaseMarker(physical)
    ?? await prepareBaseFormat(physical, BASE_FORMAT_VERSION, { motorVersion });
  return { baseDirectory: physical, baseId: marker.baseId, createdAt: marker.createdAt, created, version: marker.version };
}
