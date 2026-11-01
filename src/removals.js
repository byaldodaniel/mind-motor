import path from 'node:path';
import { MotorError } from './errors.js';
import { readJson, writeJson, removeJson } from './storage.js';
import { isExcluded } from './paths.js';

/**
 * Rastro de lo que desapareció de una carpeta autorizada (decisión del usuario,
 * opción B): solo metadatos del índice (ruta, tipo, tamaño, fechas) y cuándo se
 * detectó la desaparición. Nunca contenido: los originales no se duplican.
 * Se conserva 30 días y se liga a la generación de la autorización.
 */

const RETENTION_MS = 30 * 24 * 3_600_000;
const MAX_ENTRIES = 10_000;
const FOLDER_ID = /^[a-f0-9]{64}$/;

export function createRemovalLog({ baseDirectory, getAuthorizedFolder }) {
  const filename = (folderId) => {
    if (typeof folderId !== 'string' || !FOLDER_ID.test(folderId)) {
      throw new MotorError('INVALID_SCOPE_ID', 'El identificador de la carpeta no es válido.');
    }
    return path.join(baseDirectory, `folder-removed-${folderId}.json`);
  };

  async function load(folderId, folder) {
    const stored = await readJson(filename(folderId));
    const data = stored?.data;
    if (!data || data.format !== 'mind-folder-removed' || data.version !== 1 || !Array.isArray(data.entries)
        || data.generation !== (folder.generation ?? null)) return [];
    const now = Date.now();
    return data.entries.filter((entry) => entry && typeof entry.path === 'string'
      && Number.isFinite(Date.parse(entry.removedAt)) && now - Date.parse(entry.removedAt) <= RETENTION_MS);
  }

  return Object.freeze({
    /**
     * Anota entradas desaparecidas a partir del índice anterior.
     * @param {string} folderId
     * @param {string[]} removedPaths
     * @param {Map<string, object>} previous Entradas del índice anterior por ruta.
     * @param {{ by?: string }} [options] "externo" (detectado al reconciliar) o el agente que lo borró mediante Mind.
     */
    async record(folderId, removedPaths, previous, { by = 'externo' } = {}) {
      const folder = await getAuthorizedFolder(folderId);
      if (!folder || removedPaths.length === 0) return 0;
      const removedAt = new Date().toISOString();
      const fresh = removedPaths
        .filter((item) => !isExcluded(folder.exclusions, item))
        .map((item) => previous.get(item))
        .filter(Boolean)
        .map((entry) => ({
          path: entry.path, type: entry.type, size: entry.size, modifiedAt: entry.modifiedAt, removedAt, by,
        }));
      if (fresh.length === 0) return 0;
      const known = await load(folderId, folder);
      const replaced = new Set(fresh.map((entry) => entry.path));
      const entries = [...known.filter((entry) => !replaced.has(entry.path)), ...fresh]
        .sort((a, b) => (a.removedAt < b.removedAt ? -1 : a.removedAt > b.removedAt ? 1 : 0))
        .slice(-MAX_ENTRIES);
      await writeJson(filename(folderId), {
        format: 'mind-folder-removed', version: 1, folderId, generation: folder.generation ?? null, entries,
      });
      return fresh.length;
    },

    /** Entradas vigentes, más recientes primero; omite lo que volvió a existir. */
    async list(folderId, { since = null, existing = null } = {}) {
      const folder = await getAuthorizedFolder(folderId);
      if (!folder) return [];
      return (await load(folderId, folder))
        .filter((entry) => !isExcluded(folder.exclusions, entry.path))
        .filter((entry) => since === null || Date.parse(entry.removedAt) >= since)
        .filter((entry) => !existing?.has(entry.path))
        .reverse();
    },

    remove: (folderId) => removeJson(filename(folderId)),
  });
}
