import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { MotorError } from './errors.js';
import { readJson, writeJson, removeJson } from './storage.js';
import { withIndexLock } from './index-lock.js';
import { TRASH_DIRECTORY } from './paths.js';

export { TRASH_DIRECTORY };

/**
 * Registro de la papelera de Mind (docs/FUNCION_03_ORGANIZAR.md). Lo borrado
 * mediante Mind se mueve a <raíz>/.papelera-mind/<id>/<nombre>, dentro de la
 * misma carpeta autorizada; aquí solo se guardan sus metadatos: ruta original,
 * tipo, tamaño, fechas, cuándo y quién lo borró y, para archivos, el SHA-256
 * calculado por el auxiliar nativo. Nunca el contenido.
 *
 * El registro se liga a la generación de la autorización: retirar y volver a
 * autorizar la carpeta no recupera entradas de la concesión anterior (siguen en
 * .papelera-mind, pero Mind deja de gestionarlas). Las mutaciones usan el mismo
 * bloqueo por carpeta que el índice, de modo que una retirada coordinada
 * impide publicaciones tardías de una autorización anterior.
 */

const FOLDER_ID = /^[a-f0-9]{64}$/;
export const TRASH_ID = /^\d{8}T\d{6}Z-[a-f0-9]{12}$/;
const TYPES = new Set(['file', 'directory']);
const MAX_ENTRIES = 10_000;

/** Identificador único y legible: fecha UTC y 48 bits aleatorios. */
export function newTrashId(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `${stamp}-${randomBytes(6).toString('hex')}`;
}

export function validateTrashId(id) {
  if (typeof id !== 'string' || !TRASH_ID.test(id)) {
    throw new MotorError('INVALID_TRASH_ID', 'El identificador de la papelera no es válido.');
  }
  return id;
}

const isDate = (value) => value === null || (typeof value === 'string' && Number.isFinite(Date.parse(value)));

function validEntry(entry) {
  return entry && typeof entry === 'object' && !Array.isArray(entry)
    && typeof entry.id === 'string' && TRASH_ID.test(entry.id)
    && typeof entry.path === 'string' && entry.path !== '' && !entry.path.includes('\0')
    && TYPES.has(entry.type)
    && (entry.size === null || (Number.isSafeInteger(entry.size) && entry.size >= 0))
    && [entry.modifiedAt, entry.changedAt, entry.createdAt].every(isDate)
    && typeof entry.deletedAt === 'string' && Number.isFinite(Date.parse(entry.deletedAt))
    && typeof entry.by === 'string'
    && (entry.sha256 === null || (typeof entry.sha256 === 'string' && /^[a-f0-9]{64}$/.test(entry.sha256)))
    && (entry.entries === null || (Number.isSafeInteger(entry.entries) && entry.entries >= 0))
    && (entry.reason === null || typeof entry.reason === 'string')
    // Propiedades retiradas al borrar (se reponen al restaurar).
    && (entry.properties === undefined || (Array.isArray(entry.properties) && entry.properties.length <= 100_000));
}

/**
 * @param {{ baseDirectory: string, loadAuthorizedFolder: (id: string) => Promise<{ id: string, path: string, generation: string | null } | null> }} options
 */
export function createTrashRegistry({ baseDirectory, loadAuthorizedFolder }) {
  if (typeof baseDirectory !== 'string' || !path.isAbsolute(baseDirectory) || typeof loadAuthorizedFolder !== 'function') {
    throw new MotorError('INVALID_TRASH_REGISTRY', 'El registro de la papelera necesita la Base y el registro de carpetas.');
  }
  const filename = (folderId) => {
    if (typeof folderId !== 'string' || !FOLDER_ID.test(folderId)) {
      throw new MotorError('INVALID_SCOPE_ID', 'El identificador de la carpeta no es válido.');
    }
    return path.join(baseDirectory, `trash-${folderId}.json`);
  };

  async function folderFor(folderId) {
    const folder = await loadAuthorizedFolder(folderId);
    if (!folder) throw new MotorError('FOLDER_NOT_AUTHORIZED', 'La carpeta no está autorizada o fue retirada.');
    return folder;
  }

  /** Entradas de la generación vigente; un registro de otra concesión no aporta nada. */
  async function load(folderId, folder) {
    const stored = await readJson(filename(folderId));
    if (stored === null) return [];
    const data = stored.data;
    if (!data || data.format !== 'mind-trash' || data.version !== 1 || data.folderId !== folderId
        || !Array.isArray(data.entries) || !(data.generation === null || typeof data.generation === 'string')) {
      throw new MotorError('TRASH_CORRUPT', 'El registro de la papelera no tiene el formato esperado.');
    }
    if (data.generation !== (folder.generation ?? null)) return [];
    if (!data.entries.every(validEntry)) {
      throw new MotorError('TRASH_CORRUPT', 'El registro de la papelera no tiene el formato esperado.');
    }
    return data.entries;
  }

  /** Lectura-modificación-escritura coordinada, solo para la generación esperada. */
  async function mutate(folderId, generation, change) {
    filename(folderId);
    return withIndexLock(baseDirectory, folderId, async () => {
      const folder = await folderFor(folderId);
      if ((folder.generation ?? null) !== (generation ?? null)) {
        throw new MotorError('TRASH_SCOPE_CHANGED', 'La autorización de la carpeta cambió; no se registra en la papelera de otra concesión.');
      }
      const entries = await load(folderId, folder);
      const { next, result } = change(entries);
      if (next.length === 0) await removeJson(filename(folderId));
      else {
        await writeJson(filename(folderId), {
          format: 'mind-trash', version: 1, folderId, generation: folder.generation ?? null, entries: next,
        });
      }
      return result;
    });
  }

  return Object.freeze({
    /** Entradas vigentes, las más recientes primero. */
    async list(folderId) {
      const folder = await folderFor(folderId);
      return [...await load(folderId, folder)].reverse().map((entry) => ({ ...entry }));
    },

    /** Entrada vigente con su generación; TRASH_ENTRY_NOT_FOUND si no existe. */
    async get(folderId, trashId) {
      validateTrashId(trashId);
      const folder = await folderFor(folderId);
      const entry = (await load(folderId, folder)).find((item) => item.id === trashId);
      if (!entry) throw new MotorError('TRASH_ENTRY_NOT_FOUND', 'Esa entrada no está en la papelera de Mind de esta carpeta.');
      return { ...entry, generation: folder.generation ?? null };
    },

    /** Anota una entrada; falla si la autorización ya no es la del permiso. */
    async add(folderId, generation, entry) {
      if (!validEntry(entry)) throw new MotorError('TRASH_CORRUPT', 'La entrada de la papelera no tiene el formato esperado.');
      return mutate(folderId, generation, (entries) => {
        if (entries.some((item) => item.id === entry.id)) {
          throw new MotorError('TRASH_CORRUPT', 'Ya existe una entrada con ese identificador.');
        }
        if (entries.length >= MAX_ENTRIES) {
          throw new MotorError('TRASH_LIMIT_EXCEEDED', `La papelera de esta carpeta ya tiene ${MAX_ENTRIES} entradas: vacíala antes de borrar más.`);
        }
        return { next: [...entries, { ...entry }], result: { ...entry } };
      });
    },

    /** Retira el registro de una carpeta retirada (los elementos físicos siguen en su .papelera-mind). */
    removeFolder: (folderId) => removeJson(filename(folderId)),

    /** Retira la anotación de una entrada restaurada o eliminada definitivamente. */
    async remove(folderId, generation, trashId) {
      validateTrashId(trashId);
      return mutate(folderId, generation, (entries) => ({
        next: entries.filter((item) => item.id !== trashId),
        result: entries.some((item) => item.id === trashId),
      }));
    },
  });
}
