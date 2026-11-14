// Novedades de una entrega: bloque `novedades` del canal firmado `stable.json`.
// Parte humana (la escribe el autor) + parte `comprobado` (la deriva el firmante del ZIP).
// Lógica pura: sin red, sin disco y sin git, para poder probarla y reutilizarla.

const fail = (code, message) => Object.assign(new Error(message), { code });
const invalid = message => fail('UPDATE_NOTES_INVALID', `Novedades no válidas: ${message}`);

export const CHANGE_TYPES = Object.freeze(['mejora', 'correccion', 'seguridad', 'rendimiento']);
export const IMPORTANCE_LEVELS = Object.freeze(['normal', 'recomendada', 'seguridad']);
export const BASE_IMPACTS = Object.freeze(['sin-cambios', 'migracion-automatica', 'requiere-copia']);
export const FOLDER_IMPACTS = Object.freeze(['intactas', 'revisar']);
const MAX_CHANGES = 30, MAX_COMPONENTS = 200, MAX_GROUPS = 5000;

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const length = text => [...text].length;

/** Quita controles y marcas bidireccionales; `multiline` conserva el salto de línea. Recorta espacios. */
export function cleanText(value, where, { min = 0, max, multiline = false } = {}) {
  if (typeof value !== 'string') throw invalid(`${where} debe ser texto.`);
  let text = value.normalize('NFC').replace(/\r\n?/gu, '\n').replace(/[\u202A-\u202E\u2066-\u2069\u2028\u2029\uFEFF]/gu, '');
  text = multiline
    ? text.replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/gu, '')
    : text.replace(/[\u0000-\u001F\u007F-\u009F]/gu, ' ');
  text = text.trim();
  if (length(text) < min || length(text) > max) throw invalid(`${where} debe tener entre ${min} y ${max} caracteres.`);
  return text;
}

function oneOf(value, allowed, where) {
  if (!allowed.includes(value)) throw invalid(`${where} debe ser uno de: ${allowed.join(', ')}.`);
  return value;
}

function exactKeys(value, allowed, where) {
  if (!isObject(value)) throw invalid(`${where} debe ser un objeto.`);
  const extra = Object.keys(value).filter(key => !allowed.includes(key));
  if (extra.length) throw invalid(`${where} contiene campos desconocidos: ${extra.slice(0, 5).join(', ')}.`);
}

const integer = (value, where) => {
  if (!Number.isSafeInteger(value) || value < 0) throw invalid(`${where} debe ser un entero no negativo.`);
  return value;
};

/** Parte humana: lo único que puede escribir el autor. */
function humanPart(value) {
  const n = cleanText(value.nombre, 'nombre', { min: 1, max: 80 });
  const resumen = cleanText(value.resumen, 'resumen', { min: 1, max: 400, multiline: true });
  if (!Array.isArray(value.cambios) || value.cambios.length < 1 || value.cambios.length > MAX_CHANGES) {
    throw invalid(`cambios debe ser una lista de 1 a ${MAX_CHANGES} elementos.`);
  }
  const cambios = value.cambios.map((item, index) => {
    const where = `cambios[${index}]`;
    exactKeys(item, ['titulo', 'detalle', 'tipo'], where);
    return {
      titulo: cleanText(item.titulo, `${where}.titulo`, { min: 1, max: 120 }),
      detalle: cleanText(item.detalle ?? '', `${where}.detalle`, { max: 400, multiline: true }),
      tipo: oneOf(item.tipo, CHANGE_TYPES, `${where}.tipo`),
    };
  });
  const importancia = oneOf(value.importancia, IMPORTANCE_LEVELS, 'importancia');
  const impact = value.impacto_datos;
  exactKeys(impact, ['base', 'conversaciones', 'carpetas_autorizadas', 'nota'], 'impacto_datos');
  const impacto_datos = {
    base: oneOf(impact.base, BASE_IMPACTS, 'impacto_datos.base'),
    conversaciones: oneOf(impact.conversaciones, ['intactas'], 'impacto_datos.conversaciones'),
    carpetas_autorizadas: oneOf(impact.carpetas_autorizadas, FOLDER_IMPACTS, 'impacto_datos.carpetas_autorizadas'),
    nota: cleanText(impact.nota ?? '', 'impacto_datos.nota', { max: 400, multiline: true }),
  };
  return { nombre: n, resumen, cambios, importancia, impacto_datos };
}

const HUMAN_KEYS = ['nombre', 'resumen', 'cambios', 'importancia', 'impacto_datos'];

/** Valida `comprobado` (ya derivado). Devuelve la copia normalizada. */
function checkedPart(value) {
  exactKeys(value, ['baseFormatVersion', 'paqueteBytes', 'programaBytes', 'archivos', 'componentes', 'gruposCambiados', 'descargaParcialBytes'], 'comprobado');
  const baseFormatVersion = value.baseFormatVersion ?? null;
  if (baseFormatVersion !== null && (!Number.isSafeInteger(baseFormatVersion) || baseFormatVersion < 1)) throw invalid('comprobado.baseFormatVersion no es válido.');
  const componentes = value.componentes ?? [];
  if (!Array.isArray(componentes) || componentes.length > MAX_COMPONENTS) throw invalid('comprobado.componentes no es válido.');
  const groups = value.gruposCambiados ?? null, partial = value.descargaParcialBytes ?? null;
  if ((groups === null) !== (partial === null)) throw invalid('gruposCambiados y descargaParcialBytes deben darse juntos.');
  if (groups !== null && (!Array.isArray(groups) || groups.length > MAX_GROUPS)) throw invalid('comprobado.gruposCambiados no es válido.');
  const short = (item, where) => cleanText(item, where, { min: 1, max: 300 });
  return {
    baseFormatVersion,
    paqueteBytes: integer(value.paqueteBytes, 'comprobado.paqueteBytes'),
    programaBytes: integer(value.programaBytes, 'comprobado.programaBytes'),
    archivos: integer(value.archivos, 'comprobado.archivos'),
    componentes: componentes.map((item, index) => {
      exactKeys(item, ['name', 'version', 'target'], `comprobado.componentes[${index}]`);
      return { name: short(item.name, 'componente.name'), version: short(item.version, 'componente.version'),
        target: item.target == null ? null : short(item.target, 'componente.target') };
    }),
    gruposCambiados: groups === null ? null : groups.map(item => short(item, 'gruposCambiados[]')),
    descargaParcialBytes: partial === null ? null : integer(partial, 'comprobado.descargaParcialBytes'),
  };
}

/**
 * Valida y normaliza el bloque completo tal como viaja en el canal firmado
 * (parte humana + `comprobado`). Lanza UPDATE_NOTES_INVALID.
 */
export function validateNovedades(value) {
  exactKeys(value, [...HUMAN_KEYS, 'comprobado'], 'novedades');
  if (value.comprobado === undefined) throw invalid('falta comprobado.');
  return { ...humanPart(value), comprobado: checkedPart(value.comprobado) };
}

/** Valida el archivo del autor: solo parte humana; rechaza cualquier intento de fijar `comprobado`. */
export function validateAuthorNotes(value) {
  if (isObject(value) && 'comprobado' in value) throw invalid('el campo comprobado lo deriva el firmante del ZIP; el autor no puede fijarlo.');
  exactKeys(value, HUMAN_KEYS, 'novedades');
  return humanPart(value);
}

/** Impide declarar una Base intacta cuando el ZIP anterior acredita otro formato. */
export function validateBaseImpact(authorNotes, manifest, previousManifest = null) {
  if (previousManifest && authorNotes.impacto_datos.base === 'sin-cambios'
      && (manifest.baseFormatVersion ?? null) !== (previousManifest.baseFormatVersion ?? null)) {
    const previous = previousManifest.baseFormatVersion ?? 'desconocido';
    const next = manifest.baseFormatVersion ?? 'desconocido';
    throw invalid(`impacto_datos.base no puede ser sin-cambios: baseFormatVersion cambia de ${previous} a ${next} frente a --anterior. Declara migracion-automatica o requiere-copia.`);
  }
}

/** Grupo de nivel alto al que pertenece un archivo del manifiesto. */
export function groupOf(relative) {
  const parts = relative.split('/');
  if (parts[0] === 'Sistema') {
    if (parts[1] === 'Programa' && parts[2] === 'Motor' && parts.length > 3) return 'Sistema/Programa/Motor';
    if (parts[1] === 'Componentes' && ['Node', 'Python'].includes(parts[2]) && parts.length > 4) return parts.slice(0, 4).join('/');
    if (parts[1] === 'Componentes' && parts[2] === 'Semantica' && parts.length > 3) return 'Sistema/Componentes/Semantica';
    if (parts[1] === 'Licencias' && parts.length > 2) return 'Sistema/Licencias';
  }
  return relative;
}

/** Grupos cuyo contenido difiere entre dos manifiestos (archivo añadido, quitado o con otra huella). */
export function changedGroups(previousFiles, files) {
  const changed = new Set();
  for (const [relative, hash] of Object.entries(files)) if (previousFiles[relative] !== hash) changed.add(groupOf(relative));
  for (const relative of Object.keys(previousFiles)) if (!(relative in files)) changed.add(groupOf(relative));
  return [...changed].sort();
}

/**
 * Deriva `comprobado` del manifiesto del ZIP.
 * @param {{manifest: object, sizes: Record<string, number>, packageBytes: number, previousManifest?: object|null}} input
 *   `sizes`: tamaño en bytes de cada archivo listado en `manifest.files`.
 */
export function deriveComprobado({ manifest, sizes, packageBytes, previousManifest = null }) {
  const files = manifest.files ?? {};
  const names = Object.keys(files);
  let programaBytes = 0;
  for (const relative of names) {
    if (!Number.isSafeInteger(sizes[relative]) || sizes[relative] < 0) throw invalid(`falta el tamaño de ${relative}.`);
    programaBytes += sizes[relative];
  }
  let gruposCambiados = null, descargaParcialBytes = null;
  if (previousManifest) {
    gruposCambiados = changedGroups(previousManifest.files ?? {}, files);
    const set = new Set(gruposCambiados);
    descargaParcialBytes = names.reduce((sum, relative) => set.has(groupOf(relative)) ? sum + sizes[relative] : sum, 0);
  }
  return checkedPart({
    baseFormatVersion: manifest.baseFormatVersion ?? null,
    paqueteBytes: packageBytes,
    programaBytes,
    archivos: names.length,
    componentes: (manifest.components ?? []).map(({ name, version, target }) => ({ name, version, target: target ?? null })),
    gruposCambiados,
    descargaParcialBytes,
  });
}

/** Bloque final para el payload: parte humana validada + `comprobado` derivado. */
export function buildNovedades(authorNotes, derived) {
  return validateNovedades({ ...validateAuthorNotes(authorNotes), comprobado: derived });
}
