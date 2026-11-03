import path from 'node:path';
import { MotorError } from './errors.js';
import { readJson, writeJson, removeJson } from './storage.js';
import { withIndexLock } from './index-lock.js';
import { isExcluded } from './paths.js';
import { copyJson } from './functions.js';
import { prepareBaseFormat } from './base-format.js';

/**
 * Propiedades clave/valor sobre entradas de una carpeta autorizada (Función 02:
 * encontrar mediante nombres, rutas, propiedades y filtros). Son metadatos que el
 * usuario o sus agentes asignan a archivos y carpetas; se guardan en la Base, en
 * `folder-properties-<id>.json`, nunca en los originales.
 *
 * Cada archivo se liga a la generación de la autorización de la carpeta: retirar
 * y volver a autorizar la misma ubicación empieza sin propiedades, y una
 * escritura pedida bajo una autorización anterior no se publica. Las escrituras
 * se coordinan entre procesos con el bloqueo de la Base (`folder-properties-<id>.lock`),
 * con la misma espera y recuperación que los índices. Las rutas excluidas por el
 * usuario no se leen, no se escriben y no se devuelven.
 */

export const MAX_PROPERTIES_PER_ENTRY = 64;
export const MAX_PROPERTY_KEY_LENGTH = 64;
export const MAX_PROPERTY_TEXT_LENGTH = 1024;
export const MAX_PROPERTY_ENTRIES = 100_000;
export const MAX_PROPERTIES_BYTES = 8 * 1024 * 1024;
export const PROPERTIES_LOCK_NAME = 'folder-properties';

const FOLDER_ID = /^[a-f0-9]{64}$/;
const GENERATION = /^[a-f0-9-]{36}$/;
const RECORD_KEYS = ['authorizationGeneration', 'entries', 'folderId', 'format', 'generation', 'updatedAt', 'version'];
/** Controles, formato (bidi), uso privado y separadores de línea: no forman parte de una clave legible. */
const KEY_FORBIDDEN = /[\p{Cc}\p{Cf}\p{Co}\p{Zl}\p{Zp}]/u;
/** Controles C0 salvo tabulador, salto de línea y retorno; también DEL. */
const TEXT_FORBIDDEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

/** @typedef {string | number | boolean} PropertyValue */
/**
 * @typedef {object} FolderProperties
 * @property {string} folderId
 * @property {string | null} authorizationGeneration Generación de la autorización a la que pertenecen.
 * @property {number} generation Aumenta con cada publicación.
 * @property {string} updatedAt
 * @property {{ path: string, properties: Record<string, PropertyValue> }[]} entries Ordenadas por ruta.
 */

function invalid(message) {
  return new MotorError('INVALID_PROPERTIES', message);
}

function excluded() {
  return new MotorError('PATH_EXCLUDED', 'El usuario excluyó esa ubicación del acceso de Mind.');
}

function limit(message) {
  return new MotorError('PROPERTIES_LIMIT_EXCEEDED', message);
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function isDate(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}

/** Cuenta puntos de código sin recorrer textos enormes (cada uno ocupa una o dos unidades UTF-16). */
function codePoints(text, max) {
  if (text.length > max * 2) return max + 1;
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}

/**
 * Clave de propiedad: de 1 a 64 caracteres, normalizada a NFC, sin espacios al
 * inicio o al final ni caracteres de control; "__proto__" no se admite.
 * @returns {string} La clave normalizada.
 */
export function validatePropertyKey(key) {
  if (typeof key !== 'string' || !key.isWellFormed()) throw invalid('Cada clave de propiedad debe ser texto.');
  const normalized = key.normalize('NFC');
  const length = codePoints(normalized, MAX_PROPERTY_KEY_LENGTH);
  if (length < 1 || length > MAX_PROPERTY_KEY_LENGTH || normalized !== normalized.trim()
      || KEY_FORBIDDEN.test(normalized) || normalized === '__proto__') {
    throw invalid(`Las claves de propiedad deben tener de 1 a ${MAX_PROPERTY_KEY_LENGTH} caracteres, sin espacios al inicio o al final ni caracteres de control; "__proto__" no se admite.`);
  }
  return normalized;
}

/**
 * Valor de propiedad: texto de hasta 1024 caracteres (sin NUL ni controles salvo
 * tabulador y saltos de línea), número finito o booleano.
 * @returns {PropertyValue}
 */
export function validatePropertyValue(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalid('Los valores numéricos deben ser finitos.');
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === 'string' && value.isWellFormed() && !TEXT_FORBIDDEN.test(value)
      && codePoints(value, MAX_PROPERTY_TEXT_LENGTH) <= MAX_PROPERTY_TEXT_LENGTH) {
    return value;
  }
  throw invalid(`Cada valor debe ser texto de hasta ${MAX_PROPERTY_TEXT_LENGTH} caracteres, un número finito o un booleano.`);
}

/** Ruta relativa con "/" entre componentes, como las entradas del índice. */
export function validatePropertyPath(value) {
  if (typeof value !== 'string' || value === '' || value.length > 4096 || !value.isWellFormed() || value.includes('\0')
      || value.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    throw new MotorError('INVALID_PROPERTY_PATH', 'Indica una ruta relativa dentro de la carpeta, con "/" entre componentes.');
  }
  return value;
}

/**
 * Copia validada de un objeto { clave: valor }. Rechaza accesores, prototipos
 * ajenos, claves repetidas tras normalizar y valores no admitidos.
 * @returns {Map<string, PropertyValue>}
 */
export function parsePropertyMap(value, { max = MAX_PROPERTIES_PER_ENTRY, allowEmpty = false } = {}) {
  let copy;
  try {
    copy = copyJson(value);
  } catch {
    throw invalid('Las propiedades deben ser un objeto de datos JSON, sin funciones ni accesores.');
  }
  if (!plainObject(copy)) throw invalid('Las propiedades deben ser un objeto { clave: valor }.');
  const result = new Map();
  for (const [rawKey, rawValue] of Object.entries(copy)) {
    const key = validatePropertyKey(rawKey);
    if (result.has(key)) throw invalid('Dos claves coinciden después de normalizarlas.');
    result.set(key, validatePropertyValue(rawValue));
  }
  if (!allowEmpty && result.size === 0) throw invalid('Indica al menos una propiedad.');
  if (result.size > max) throw invalid(`Se admiten como máximo ${max} propiedades.`);
  return result;
}

/** Campos de datos propios de un objeto simple; undefined cuenta como ausente. Nunca invoca accesores. */
function dataFields(value, allowed, message) {
  if (!plainObject(value)) throw invalid(message);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key];
    if (typeof key !== 'string' || !allowed.includes(key) || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw invalid(message);
    }
    if (descriptor.value !== undefined) result[key] = descriptor.value;
  }
  return result;
}

function parseChanges(changes) {
  const fields = dataFields(changes, ['set', 'remove'], 'Indica los cambios como { set: { clave: valor }, remove: [claves] }.');
  const set = fields.set === undefined ? new Map() : parsePropertyMap(fields.set, { allowEmpty: true });
  let remove = [];
  if (fields.remove !== undefined) {
    let list;
    try {
      list = copyJson(fields.remove);
    } catch {
      list = null;
    }
    if (!Array.isArray(list) || list.length > MAX_PROPERTIES_PER_ENTRY) {
      throw invalid(`remove debe ser una lista de hasta ${MAX_PROPERTIES_PER_ENTRY} claves.`);
    }
    remove = [...new Set(list.map(validatePropertyKey))];
  }
  if (set.size === 0 && remove.length === 0) throw invalid('Indica propiedades para establecer o quitar.');
  if (remove.some((key) => set.has(key))) throw invalid('Una misma clave no puede establecerse y quitarse a la vez.');
  return { set, remove };
}

function byCodeUnits(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Objeto simple con las claves ordenadas: salida determinista y sin prototipos compartidos. */
function toObject(map) {
  return Object.fromEntries([...map].sort(([a], [b]) => byCodeUnits(a, b)));
}

function sameMap(first, second) {
  if (first.size !== second.size) return false;
  for (const [key, value] of first) {
    if (!second.has(key) || !Object.is(second.get(key), value)) return false;
  }
  return true;
}

function inside(candidate, root) {
  return candidate === root || candidate.startsWith(`${root}/`);
}

/**
 * Almacén de propiedades del Motor. Solo el anfitrión lo recibe: resuelve las
 * carpetas exclusivamente con el registro (loadAuthorizedFolder) y nunca acepta
 * rutas absolutas. readFolderIndex, si se indica, exige que una entrada figure
 * en el índice vigente antes de asignarle valores.
 * @param {object} options
 * @param {string} options.baseDirectory
 * @param {(id: string) => Promise<{ id: string, path: string, generation?: string | null, exclusions?: string[] } | null>} options.loadAuthorizedFolder
 * @param {(id: string) => Promise<import('./index-store.js').FolderIndex | null>} [options.readFolderIndex]
 * @param {number} [options.maxEntries] Entradas con propiedades por carpeta.
 * @param {number} [options.maxBytes] Tamaño máximo del archivo de propiedades de una carpeta.
 */
export function createPropertyStore({
  baseDirectory, loadAuthorizedFolder, readFolderIndex = null,
  maxEntries = MAX_PROPERTY_ENTRIES, maxBytes = MAX_PROPERTIES_BYTES,
} = {}) {
  if (typeof baseDirectory !== 'string' || !path.isAbsolute(baseDirectory)) {
    throw new MotorError('INVALID_BASE', 'Indica la ruta absoluta de la Base del Motor.');
  }
  if (typeof loadAuthorizedFolder !== 'function' || (readFolderIndex !== null && typeof readFolderIndex !== 'function')) {
    throw new MotorError('INVALID_SCOPE_RESOLVER', 'Las propiedades necesitan el registro de carpetas del Motor.');
  }
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new MotorError('INVALID_PROPERTIES_LIMIT', 'Los límites de propiedades deben ser enteros positivos.');
  }
  const pending = new Map();

  function filename(folderId) {
    if (typeof folderId !== 'string' || !FOLDER_ID.test(folderId)) {
      throw new MotorError('INVALID_SCOPE_ID', 'El identificador del ámbito no es válido.');
    }
    return path.join(baseDirectory, `folder-properties-${folderId}.json`);
  }

  async function folderFor(folderId) {
    filename(folderId);
    const folder = await loadAuthorizedFolder(folderId);
    if (!folder) throw new MotorError('FOLDER_NOT_AUTHORIZED', 'La carpeta no está autorizada o fue retirada.');
    return folder;
  }

  function parseRecord(data, folderId) {
    const corrupt = () => new MotorError('PROPERTIES_CORRUPT', 'Las propiedades guardadas no tienen el formato esperado.');
    if (!plainObject(data) || Object.keys(data).sort().join() !== RECORD_KEYS.join()
        || data.format !== 'mind-folder-properties' || ![1, 2].includes(data.version) || data.folderId !== folderId
        || !(data.authorizationGeneration === null
          || (typeof data.authorizationGeneration === 'string' && GENERATION.test(data.authorizationGeneration)))
        || !Number.isSafeInteger(data.generation) || data.generation < 1 || !isDate(data.updatedAt)
        || !Array.isArray(data.entries) || data.entries.length > maxEntries) {
      throw corrupt();
    }
    const entries = new Map();
    let last = null;
    for (const entry of data.entries) {
      if (!plainObject(entry) || Object.keys(entry).sort().join() !== (data.version === 1 ? 'path,properties' : 'identity,path,properties')) throw corrupt();
      if (data.version === 2 && entry.identity !== null
          && (typeof entry.identity !== 'string' || !/^(posix|nt):[0-9]+:[0-9]+$/u.test(entry.identity))) throw corrupt();
      let map;
      try {
        validatePropertyPath(entry.path);
        map = parsePropertyMap(entry.properties);
      } catch {
        throw corrupt();
      }
      // Orden estricto (rutas únicas) y claves ya normalizadas y ordenadas.
      if ((last !== null && !(last < entry.path))
          || Object.keys(entry.properties).join('\0') !== [...map.keys()].sort(byCodeUnits).join('\0')) {
        throw corrupt();
      }
      last = entry.path;
      map.identity = entry.identity ?? null;
      entries.set(entry.path, map);
    }
    return { authorizationGeneration: data.authorizationGeneration, generation: data.generation, updatedAt: data.updatedAt, entries };
  }

  /** Registro vigente para la autorización actual; los de otra concesión no se aplican. */
  async function bound(folderId, folder, transition = null) {
    const stored = await readJson(filename(folderId));
    const record = stored === null ? null : parseRecord(stored.data, folderId);
    if (!record || record.authorizationGeneration !== (folder.generation ?? null)) return null;
    // Una ruta no identifica al objeto: un archivo reemplazado entre recorridos
    // no hereda metadatos. Los registros antiguos sin identidad se conservan en
    // disco hasta una mutación, pero no se atribuyen a ningún objeto nuevo.
    const index = readFolderIndex ? await readFolderIndex(folderId) : null;
    const identities = new Map((index?.entries ?? []).filter((entry) => entry.state === 'indexed')
      .map((entry) => [entry.path, entry.identity]));
    for (const [entryPath, map] of record.entries) {
      if (transition && entryPath === transition.path && map.identity === transition.before
          && identities.get(entryPath) === transition.after) map.identity = transition.after;
      // Conservar datos históricos sin atribuirlos a un objeto distinto o no
      // verificable; otra asignación explícita puede reemplazar esa ruta.
      map.current = Boolean(map.identity) && map.identity === identities.get(entryPath);
    }
    return record;
  }

  /** Serializa en este proceso y coordina con los demás mediante el bloqueo de la Base. */
  function exclusive(folderId, task) {
    const run = () => withIndexLock(baseDirectory, folderId, task, PROPERTIES_LOCK_NAME);
    const current = (pending.get(folderId) ?? Promise.resolve()).then(run);
    const settled = current.then(() => {}, () => {}).then(() => {
      if (pending.get(folderId) === settled) pending.delete(folderId);
    });
    pending.set(folderId, settled);
    return current;
  }

  function requireSame(requested, current) {
    if (requested.path !== current.path || (requested.generation ?? null) !== (current.generation ?? null)) {
      throw new MotorError('PROPERTIES_SCOPE_CHANGED', 'La autorización de la carpeta cambió durante la operación; no se guardó nada.');
    }
  }

  /**
   * Lectura, cambio y publicación bajo el bloqueo. La autorización se captura al
   * pedir la operación y se exige la misma bajo el bloqueo y antes de publicar.
   */
  async function mutate(folderId, requested, apply, transition = null) {
    return exclusive(folderId, async () => {
      const folder = await folderFor(folderId);
      requireSame(requested, folder);
      const record = await bound(folderId, folder, transition);
      const entries = record?.entries ?? new Map();
      const { changed, value } = await apply(entries, folder);
      if (!changed) return { ...value, generation: record?.generation ?? null };
      if (entries.size > maxEntries) throw limit(`Se admiten propiedades en ${maxEntries} entradas por carpeta como máximo.`);
      const next = {
        format: 'mind-folder-properties', version: 2, folderId,
        authorizationGeneration: folder.generation ?? null,
        generation: (record?.generation ?? 0) + 1,
        updatedAt: new Date().toISOString(),
        entries: [...entries].sort(([a], [b]) => byCodeUnits(a, b))
          .map(([entryPath, map]) => ({ path: entryPath, identity: map.identity, properties: toObject(map) })),
      };
      if (Buffer.byteLength(JSON.stringify(next), 'utf8') > maxBytes) {
        throw limit('Las propiedades de esta carpeta superan el tamaño máximo permitido.');
      }
      // Una retirada o nueva autorización mientras se preparaba no recibe estos datos.
      requireSame(requested, await folderFor(folderId));
      await prepareBaseFormat(baseDirectory, 2);
      await writeJson(filename(folderId), next);
      return { ...value, generation: next.generation };
    });
  }

  return Object.freeze({
    /**
     * Establece y quita propiedades de una entrada. Para asignar valores, la
     * entrada debe figurar en el índice vigente de la carpeta.
     * @param {string} folderId
     * @param {string} relativePath
     * @param {{ set?: Record<string, PropertyValue>, remove?: string[] }} changes
     * @returns {Promise<{ folderId: string, relativePath: string, properties: Record<string, PropertyValue>, generation: number | null }>}
     */
    async setProperties(folderId, relativePath, changes) {
      const name = validatePropertyPath(relativePath);
      const { set, remove } = parseChanges(changes);
      const folder = await folderFor(folderId);
      if (isExcluded(folder.exclusions, name)) throw excluded();
      let identity;
      if (set.size > 0 && !readFolderIndex) {
        throw new MotorError('ENTRY_IDENTITY_UNAVAILABLE', 'Las propiedades necesitan un índice con identidad verificada.');
      }
      if (set.size > 0 && readFolderIndex) {
        const index = await readFolderIndex(folderId);
        const entry = index?.entries.find((item) => item.path === name);
        if (!entry) {
          throw new MotorError('PATH_NOT_INDEXED', 'La ruta no figura en el índice vigente de la carpeta; revisa la ruta o reconcilia el índice.');
        }
        identity = entry.state === 'indexed' ? entry.identity : null;
        if (!identity) throw new MotorError('ENTRY_IDENTITY_UNAVAILABLE', 'No se pueden asignar propiedades sin una identidad verificada; reconcilia el índice.');
      }
      return mutate(folderId, folder, (entries, current) => {
        if (isExcluded(current.exclusions, name)) throw excluded();
        const existing = entries.get(name);
        const before = existing?.current ? existing : new Map();
        const after = new Map(before);
        after.identity = identity ?? before.identity;
        for (const key of remove) after.delete(key);
        for (const [key, value] of set) after.set(key, value);
        if (after.size > MAX_PROPERTIES_PER_ENTRY) {
          throw limit(`Una entrada admite como máximo ${MAX_PROPERTIES_PER_ENTRY} propiedades.`);
        }
        if (after.size === 0) entries.delete(name);
        else entries.set(name, after);
        return { changed: !sameMap(before, after), value: { folderId, relativePath: name, properties: toObject(after) } };
      });
    },

    /** @returns {Promise<Record<string, PropertyValue>>} Las propiedades de la entrada; {} si no tiene. */
    async getProperties(folderId, relativePath) {
      const name = validatePropertyPath(relativePath);
      const folder = await folderFor(folderId);
      if (isExcluded(folder.exclusions, name)) throw excluded();
      const record = await bound(folderId, folder);
      const map = record?.entries.get(name);
      return toObject(map?.current ? map : new Map());
    },

    /**
     * Todas las propiedades vigentes de la carpeta, sin las rutas excluidas.
     * @returns {Promise<FolderProperties | null>} null si no hay propiedades de la autorización actual.
     */
    async readFolderProperties(folderId) {
      const folder = await folderFor(folderId);
      const record = await bound(folderId, folder);
      if (!record) return null;
      return {
        folderId,
        authorizationGeneration: record.authorizationGeneration,
        generation: record.generation,
        updatedAt: record.updatedAt,
        entries: [...record.entries].filter(([entryPath, map]) => map.current && !isExcluded(folder.exclusions, entryPath))
          .map(([entryPath, map]) => ({ path: entryPath, properties: toObject(map) })),
      };
    },

    /**
     * Traslada las propiedades de una entrada, y de sus descendientes si es una
     * carpeta, cuando otro módulo la mueve o renombra. Las que hubiera en el
     * destino pertenecían a entradas que ya no existen y se descartan. Las rutas
     * excluidas no se mueven ni se descartan.
     * @returns {Promise<{ folderId: string, from: string, to: string, moved: number, discarded: number, generation: number | null }>}
     */
    async renameProperties(folderId, from, to) {
      const source = validatePropertyPath(from);
      const target = validatePropertyPath(to);
      if (target.startsWith(`${source}/`)) {
        throw new MotorError('INVALID_PROPERTY_PATH', 'No se puede mover una entrada dentro de sí misma.');
      }
      const folder = await folderFor(folderId);
      if (isExcluded(folder.exclusions, source) || isExcluded(folder.exclusions, target)) throw excluded();
      return mutate(folderId, folder, (entries, current) => {
        const value = { folderId, from: source, to: target, moved: 0, discarded: 0 };
        if (source === target) return { changed: false, value };
        const visible = (entryPath) => !isExcluded(current.exclusions, entryPath);
        const renamed = (entryPath) => `${target}${entryPath.slice(source.length)}`;
        // Nunca se escribe en una ruta excluida: lo que caería en ella se queda donde estaba.
        const moving = [...entries].filter(([entryPath, map]) => map.current && inside(entryPath, source)
          && visible(entryPath) && visible(renamed(entryPath)));
        for (const entryPath of [...entries.keys()]) {
          if (inside(entryPath, target) && !inside(entryPath, source) && visible(entryPath)) {
            entries.delete(entryPath);
            value.discarded += 1;
          }
        }
        for (const [entryPath] of moving) entries.delete(entryPath);
        for (const [entryPath, map] of moving) entries.set(renamed(entryPath), map);
        value.moved = moving.length;
        return { changed: moving.length + value.discarded > 0, value };
      });
    },

    /**
     * Retira y devuelve las propiedades de una entrada y sus descendientes (al
     * moverla a la papelera de Mind): rutas relativas a la entrada.
     * @returns {Promise<Array<{ path: string, properties: Record<string, PropertyValue> }>>}
     */
    async takeProperties(folderId, relativePath) {
      const source = validatePropertyPath(relativePath);
      const folder = await folderFor(folderId);
      const result = await mutate(folderId, folder, (entries) => {
        const taken = [];
        for (const [entryPath, map] of [...entries]) {
          if (!map.current || !inside(entryPath, source)) continue;
          entries.delete(entryPath);
          taken.push({ path: entryPath === source ? '' : entryPath.slice(source.length + 1), identity: map.identity, properties: toObject(map) });
        }
        return { changed: taken.length > 0, value: { taken } };
      });
      return result.taken;
    },

    /**
     * Repone propiedades retiradas con takeProperties en la ruta donde la entrada
     * se restauró. No reemplaza propiedades que ya tenga una entrada del destino.
     */
    async putProperties(folderId, relativePath, items) {
      const target = validatePropertyPath(relativePath);
      if (!Array.isArray(items) || items.length === 0) return { restored: 0 };
      const folder = await folderFor(folderId);
      return mutate(folderId, folder, async (entries, current) => {
        const index = readFolderIndex ? await readFolderIndex(folderId) : null;
        const identities = new Map((index?.entries ?? []).filter((entry) => entry.state === 'indexed')
          .map((entry) => [entry.path, entry.identity]));
        let restored = 0;
        for (const item of items) {
          if (!item || typeof item.path !== 'string') continue;
          const entryPath = item.path === '' ? target : `${target}/${validatePropertyPath(item.path)}`;
          if (isExcluded(current.exclusions, entryPath) || entries.get(entryPath)?.current) continue;
          const identity = identities.get(entryPath);
          if (!identity) throw new MotorError('ENTRY_IDENTITY_UNAVAILABLE', 'No se pueden restaurar propiedades sin una identidad verificada; reconcilia el índice.');
          // Mover y restaurar conservan el objeto. Si fue reemplazado durante
          // la operación (o el respaldo es antiguo y no identifica el objeto),
          // sus propiedades no se atribuyen al archivo que ahora ocupa la ruta.
          if (!item.identity || item.identity !== identity) continue;
          const map = parsePropertyMap(item.properties);
          map.identity = identity;
          entries.set(entryPath, map);
          restored += 1;
        }
        return { changed: restored > 0, value: { restored } };
      });
    },

    /** Una modificación explícita de Mind reemplaza el inode: conserva solo las
     * propiedades ligadas al objeto anterior verificado por el auxiliar nativo. */
    async rebindModifiedProperties(folderId, relativePath, before, after) {
      if (!before || !after) return { rebound: 0 };
      const name = validatePropertyPath(relativePath);
      const folder = await folderFor(folderId);
      return mutate(folderId, folder, (entries, current) => {
        if (isExcluded(current.exclusions, name)) throw excluded();
        const rebound = entries.get(name)?.current ? 1 : 0;
        return { changed: rebound > 0, value: { rebound } };
      }, { path: name, before, after });
    },

    /**
     * Retira las propiedades de rutas que desaparecieron del índice (y de sus
     * descendientes): un elemento nuevo con el mismo nombre no las hereda.
     */
    async dropProperties(folderId, relativePaths) {
      if (!Array.isArray(relativePaths) || relativePaths.length === 0) return { dropped: 0 };
      const roots = relativePaths.map((item) => validatePropertyPath(item));
      const folder = await folderFor(folderId);
      return mutate(folderId, folder, (entries) => {
        let dropped = 0;
        for (const entryPath of [...entries.keys()]) {
          if (roots.some((root) => inside(entryPath, root))) {
            entries.delete(entryPath);
            dropped += 1;
          }
        }
        return { changed: dropped > 0, value: { dropped } };
      });
    },

    /** Elimina todas las propiedades de la carpeta, aunque ya no esté autorizada. */
    async removeFolderProperties(folderId) {
      const target = filename(folderId);
      return exclusive(folderId, () => removeJson(target));
    },
  });
}
