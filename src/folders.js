import fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { MotorError } from './errors.js';
import { readJson, writeJson, removeJson } from './storage.js';
import { contains, samePath, normalizeExclusions } from './paths.js';

const VALID_ID = /^[a-f0-9]{64}$/;
const FILENAME = /^folder-authorization-([a-f0-9]{64})\.json$/;

/** @typedef {{ id: string, path: string }} AuthorizedFolder */

function validatePath(value) {
  if (typeof value !== 'string' || value.includes('\0') || !path.isAbsolute(value)) {
    throw new MotorError('INVALID_FOLDER_PATH', 'Indica una ruta absoluta válida.');
  }
}

async function resolveFolder(folderPath) {
  validatePath(folderPath);
  try {
    const canonical = await fs.realpath(folderPath);
    if (!(await fs.stat(canonical)).isDirectory()) {
      throw new MotorError('NOT_A_FOLDER', 'La ubicación debe corresponder a una carpeta.');
    }
    // Solo se abre y cierra la carpeta para comprobar acceso; no se leen entradas.
    const directory = await fs.opendir(canonical);
    await directory.close();
    return canonical;
  } catch (error) {
    if (error instanceof MotorError) throw error;
    throw new MotorError('FOLDER_UNAVAILABLE', 'La carpeta no existe o no es accesible.', { cause: error });
  }
}

function authorizationId(canonical) {
  const normalized = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
  return createHash('sha256').update(normalized).digest('hex');
}

/**
 * Registro local del usuario. No representa permisos concedidos a un agente.
 * protectedDirectories: ubicaciones adicionales que ninguna carpeta autorizada
 * puede contener ni ocupar (en el producto, la carpeta completa de Mind).
 */
export function createFolderRegistry(baseDirectory, motorDirectory, protectedDirectories = [], userDataDirectory = null) {
  function filename(id) {
    if (typeof id !== 'string' || !VALID_ID.test(id)) {
      throw new MotorError('INVALID_AUTHORIZATION_ID', 'El identificador de autorización no es válido.');
    }
    return path.join(baseDirectory, `folder-authorization-${id}.json`);
  }

  function rejectInternal(canonical) {
    for (const internal of [baseDirectory, motorDirectory]) {
      if(contains(internal,canonical)||contains(canonical,internal))throw new MotorError('FOLDER_OVERLAPS_INTERNAL','Motor y Base permanecen protegidos.');
    }
    for (const internal of protectedDirectories) {
      if(userDataDirectory && contains(internal,userDataDirectory) && contains(userDataDirectory,canonical))continue;
      if (contains(internal, canonical) || contains(canonical, internal)) {
        throw new MotorError('FOLDER_OVERLAPS_INTERNAL', 'La carpeta de información no puede contener ni estar dentro del Motor o de la Base.');
      }
    }
  }

  async function load(id, includeGeneration = false) {
    const stored = await readJson(filename(id));
    if (stored === null) return null;
    const data = stored.data;
    const generationOk = (value) => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
    if (!data || typeof data !== 'object' || Array.isArray(data)
        || data.format !== 'mind-folder-authorization'
        || !((data.version === 1 && Object.keys(data).length === 4)
          || (data.version === 2 && Object.keys(data).length === 5 && generationOk(data.generation))
          // v3 añade las subcarpetas que el usuario excluyó del ámbito.
          || (data.version === 3 && Object.keys(data).length === 6
            && (data.generation === null || generationOk(data.generation))
            && Array.isArray(data.exclusions)
            && normalizeExclusions(data.exclusions)?.join('\0') === data.exclusions.join('\0')))
        || data.id !== id || typeof data.path !== 'string'
        || data.path.includes('\0') || !path.isAbsolute(data.path)
        || authorizationId(data.path) !== id) {
      throw new MotorError('AUTHORIZATION_CORRUPT', 'El registro de autorización no tiene el formato esperado.');
    }
    rejectInternal(data.path);
    return {
      id: data.id, path: data.path,
      ...(includeGeneration ? { generation: data.generation ?? null, exclusions: data.exclusions ?? [] } : {}),
    };
  }

  return {
    // Uso interno del Motor; no se expone al solicitante.
    loadAuthorizedFolder: (id) => load(id, true),
    /** @param {string} folderPath @returns {Promise<AuthorizedFolder>} */
    async authorizeFolder(folderPath) {
      const canonical = await resolveFolder(folderPath);
      rejectInternal(canonical);
      const id = authorizationId(canonical);
      const existing = await load(id);
      if (existing) return existing;
      await writeJson(filename(id), {
        format: 'mind-folder-authorization', version: 2, id, path: canonical, generation: randomUUID(),
      });
      return { id, path: canonical };
    },

    /** Consulta registros persistidos sin recorrer las carpetas originales. */
    async listAuthorizedFolders() {
      const entries = await fs.readdir(baseDirectory);
      const folders = [];
      for (const entry of entries.sort()) {
        const match = FILENAME.exec(entry);
        if (match) {
          const folder = await load(match[1]);
          if (folder) folders.push(folder);
        }
      }
      return folders;
    },

    /**
     * Sustituye las subcarpetas excluidas del ámbito, conservando la generación.
     * El Motor lo llama bajo la coordinación del índice (véase setFolderExclusions).
     * @returns {Promise<string[] | null>} null si la carpeta no está registrada.
     */
    async setExclusions(id, exclusions) {
      const normalized = normalizeExclusions(exclusions);
      if (normalized === null) {
        throw new MotorError('INVALID_EXCLUSIONS', 'Las exclusiones deben ser hasta 64 rutas relativas dentro de la carpeta, con "/" entre componentes.');
      }
      const stored = await readJson(filename(id));
      if (stored === null) return null;
      const current = await load(id, true);
      await writeJson(filename(id), {
        format: 'mind-folder-authorization', version: 3, id, path: current.path,
        generation: current.generation, exclusions: normalized,
      });
      return normalized;
    },

    /** Retira solo el registro de la Base, aunque la carpeta ya no exista. */
    async revokeFolder(id) {
      return removeJson(filename(id));
    },

    /**
     * Precomprobación de alcance sobre metadatos; no abre el archivo ni autoriza agentes.
     * @returns {Promise<{ folderId: string, path: string }>}
     */
    async checkFolderScope(id, targetPath) {
      const folder = await load(id);
      if (!folder) {
        throw new MotorError('FOLDER_NOT_AUTHORIZED', 'La carpeta no está autorizada o su autorización fue retirada.');
      }
      validatePath(targetPath);
      const current = await resolveFolder(folder.path);
      if (!samePath(folder.path, current)) {
        throw new MotorError('FOLDER_CHANGED', 'La ruta registrada ahora apunta a otra carpeta.');
      }
      rejectInternal(current);
      let target;
      try {
        target = await fs.realpath(targetPath);
      } catch (error) {
        throw new MotorError('PATH_UNAVAILABLE', 'La ubicación solicitada no existe o no es accesible.', { cause: error });
      }
      if (!contains(current, target)) {
        throw new MotorError('PATH_OUTSIDE_SCOPE', 'La ubicación está fuera de la carpeta autorizada.');
      }
      return { folderId: id, path: target };
    },
  };
}
