import fs from 'node:fs/promises';
import path from 'node:path';
import { MotorError } from './errors.js';
import { readJson, writeJson, removeJson } from './storage.js';

/**
 * Decisiones del usuario sobre qué pueden hacer los agentes, mediante Mind, en
 * cada carpeta registrada. No resuelve ámbitos ni sustituye al registro: solo
 * restringe lo que el anfitrión hace con carpetas que el registro ya reconoce.
 *
 * Cada decisión se liga a la generación del registro de la carpeta. Si la
 * carpeta se retira y se vuelve a autorizar, la decisión anterior deja de
 * aplicarse aunque su archivo siga en la Base: el usuario decide de nuevo.
 *
 * Los permisos se mantienen separados: encontrar (metadatos del índice) no
 * implica leer contenido, y leer no implica escribir ni organizar.
 */

export const ACCESS_LEVELS = Object.freeze(['encontrar', 'leer', 'escribir', 'organizar']);

/**
 * Elección única que ve el usuario (decisión del 2026-11-01, opción 1). Internamente
 * se conservan los permisos separados; encontrar nunca implica leer.
 */
export const ACCESS_PRESETS = Object.freeze({
  encontrar: Object.freeze(['encontrar']),
  leer: Object.freeze(['encontrar', 'leer']),
  completo: Object.freeze(['encontrar', 'leer', 'escribir', 'organizar']),
});
export const PRESET_LABELS = Object.freeze({
  encontrar: 'Solo encontrar (nombres, rutas y fechas; sin abrir archivos)',
  leer: 'Encontrar y leer (sin cambiar nada)',
  completo: 'Acceso completo (leer, crear, modificar y organizar; borrar pide tu confirmación cada vez)',
});

/** El nivel más bajo que cubre lo pedido. */
export function minimumPreset(access) {
  if (access.escribir || access.organizar) return 'completo';
  return access.leer ? 'leer' : 'encontrar';
}

/** Nombre del nivel que corresponde exactamente a unos permisos, o "personalizado". */
export function presetName(access) {
  const granted = ACCESS_LEVELS.filter((level) => access?.[level] === true).join();
  const found = Object.entries(ACCESS_PRESETS).find(([, levels]) => levels.join() === granted);
  return found ? found[0] : granted === '' ? 'ninguno' : 'personalizado';
}
export const CONTINUITY_LEVELS = Object.freeze(['leer', 'registrar']);
const FOLDER_ID = /^[a-f0-9]{64}$/;
const CHANNELS = new Set(['formulario-del-cliente', 'consola', 'administracion-local']);

function emptyAccess(levels) {
  return Object.fromEntries(levels.map((level) => [level, false]));
}

/** Normaliza una lista o un objeto de permisos a un objeto completo de booleanos. */
export function normalizeAccess(value, levels = ACCESS_LEVELS) {
  const access = emptyAccess(levels);
  const names = Array.isArray(value) ? value
    : value && typeof value === 'object' ? Object.keys(value).filter((key) => value[key] === true) : null;
  if (!names) throw new MotorError('INVALID_ACCESS', `Indica los permisos como lista: ${levels.join(', ')}.`);
  for (const name of names) {
    if (typeof name !== 'string' || !levels.includes(name)) {
      throw new MotorError('INVALID_ACCESS', `Permiso desconocido: ${String(name).slice(0, 32)}. Admitidos: ${levels.join(', ')}.`);
    }
    access[name] = true;
  }
  return access;
}

export function describeAccess(access, levels = ACCESS_LEVELS) {
  return levels.filter((level) => access?.[level] === true);
}

function validRecord(data, folderId) {
  return data && typeof data === 'object' && !Array.isArray(data)
    && data.format === 'mind-folder-access' && data.version === 1 && data.folderId === folderId
    && (data.generation === null || (typeof data.generation === 'string' && /^[a-f0-9-]{36}$/.test(data.generation)))
    && data.access && typeof data.access === 'object'
    && ACCESS_LEVELS.every((level) => typeof data.access[level] === 'boolean')
    && Object.keys(data.access).length === ACCESS_LEVELS.length
    && typeof data.grantedAt === 'string' && CHANNELS.has(data.channel);
}

/**
 * @param {{ baseDirectory: string, getAuthorizedFolder: (id: string) => Promise<{ id: string, path: string, generation: string | null } | null> }} options
 */
export function createAccessPolicy({ baseDirectory, getAuthorizedFolder }) {
  if (typeof baseDirectory !== 'string' || !path.isAbsolute(baseDirectory) || typeof getAuthorizedFolder !== 'function') {
    throw new MotorError('INVALID_ACCESS_POLICY', 'La política de acceso necesita la Base y el registro del Motor.');
  }
  const filename = (folderId) => {
    if (typeof folderId !== 'string' || !FOLDER_ID.test(folderId)) {
      throw new MotorError('INVALID_SCOPE_ID', 'El identificador de la carpeta no es válido.');
    }
    return path.join(baseDirectory, `folder-access-${folderId}.json`);
  };
  const continuityFile = path.join(baseDirectory, 'agent-continuity-access.json');

  return Object.freeze({
    /** Permisos vigentes; null si no hay decisión para la autorización actual de la carpeta. */
    async get(folderId) {
      const target = filename(folderId);
      const folder = await getAuthorizedFolder(folderId);
      if (!folder) return null;
      const stored = await readJson(target);
      if (stored === null) return null;
      if (!validRecord(stored.data, folderId)) {
        throw new MotorError('ACCESS_POLICY_CORRUPT', 'La decisión de acceso guardada no tiene el formato esperado.');
      }
      if (stored.data.generation !== (folder.generation ?? null)) return null;
      return { folderId, access: { ...stored.data.access }, grantedAt: stored.data.grantedAt, channel: stored.data.channel };
    },

    /** Guarda la decisión del usuario para la autorización vigente. */
    async set(folderId, access, { channel }) {
      const target = filename(folderId);
      if (!CHANNELS.has(channel)) throw new MotorError('INVALID_ACCESS', 'Canal de consentimiento desconocido.');
      const normalized = normalizeAccess(access);
      const folder = await getAuthorizedFolder(folderId);
      if (!folder) throw new MotorError('FOLDER_NOT_AUTHORIZED', 'La carpeta no está registrada.');
      const record = {
        format: 'mind-folder-access', version: 1, folderId, generation: folder.generation ?? null,
        access: normalized, grantedAt: new Date().toISOString(), channel,
      };
      await writeJson(target, record);
      // Si la carpeta se retiró durante la escritura, la decisión queda ligada a una
      // generación que ya no existe y nunca se aplica.
      return { folderId, access: normalized, grantedAt: record.grantedAt, channel };
    },

    async remove(folderId) {
      return removeJson(filename(folderId));
    },

    /** Elimina decisiones de carpetas ya retiradas o de generaciones anteriores. */
    async prune() {
      let removed = 0;
      for (const entry of await fs.readdir(baseDirectory)) {
        const match = /^folder-access-([a-f0-9]{64})\.json$/.exec(entry);
        if (!match) continue;
        const folder = await getAuthorizedFolder(match[1]).catch(() => undefined);
        if (folder === undefined) continue;
        const stored = await readJson(path.join(baseDirectory, entry)).catch(() => null);
        if (folder === null || (stored && stored.data?.generation !== (folder.generation ?? null))) {
          if (await removeJson(path.join(baseDirectory, entry))) removed += 1;
        }
      }
      return removed;
    },

    /** Permisos de los agentes sobre la continuidad (registros de la Base, no originales). */
    async getContinuity() {
      const stored = await readJson(continuityFile);
      if (stored === null) return { leer: false, registrar: false, grantedAt: null, channel: null };
      const data = stored.data;
      if (!data || data.format !== 'mind-continuity-access' || data.version !== 1
          || typeof data.leer !== 'boolean' || typeof data.registrar !== 'boolean' || !CHANNELS.has(data.channel)) {
        throw new MotorError('ACCESS_POLICY_CORRUPT', 'La decisión de acceso a la continuidad no tiene el formato esperado.');
      }
      return { leer: data.leer, registrar: data.registrar, grantedAt: data.grantedAt, channel: data.channel };
    },

    async setContinuity(access, { channel }) {
      if (!CHANNELS.has(channel)) throw new MotorError('INVALID_ACCESS', 'Canal de consentimiento desconocido.');
      const normalized = normalizeAccess(access, CONTINUITY_LEVELS);
      const record = { format: 'mind-continuity-access', version: 1, ...normalized, grantedAt: new Date().toISOString(), channel };
      await writeJson(continuityFile, record);
      return { ...normalized, grantedAt: record.grantedAt, channel };
    },
  });
}
