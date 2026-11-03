import { MotorError } from '../errors.js';
import { textVersion } from '../text-modifier.js';
import { DAY_NAMES } from '../automations/schedule.js';

/**
 * Utilidades de los ejecutores nativos. Los parámetros de una definición son
 * datos del agente: se validan estrictamente y nunca se interpretan como código.
 * Las plantillas solo sustituyen variables de una lista cerrada.
 */

export const FOLDER_ID = /^[a-f0-9]{64}$/;
export const FUNCTION_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const ORIGINS = Object.freeze(['manual', 'horario', 'evento', 'recuperacion', 'programada']);
export const MAX_TEMPLATE_CHARS = 64 * 1024;

export function definitionError(message) {
  return new MotorError('INVALID_FUNCTION_DEFINITION', message);
}

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

/**
 * Parámetros de la definición para este ejecutor, con campos admitidos.
 * @returns {object} definition.parametros
 */
export function expectParameters(definition, executor, allowed, required = []) {
  if (!isPlainObject(definition) || definition.ejecutor !== executor) {
    throw definitionError(`La definición no corresponde al ejecutor ${executor}.`);
  }
  const parameters = definition.parametros;
  if (!isPlainObject(parameters)) throw definitionError('parametros debe ser un objeto.');
  for (const key of Object.keys(parameters)) {
    if (!allowed.includes(key)) {
      throw definitionError(`Parámetro desconocido para ${executor}: ${key.slice(0, 40)}. Admitidos: ${allowed.join(', ')}.`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(parameters, key)) throw definitionError(`Falta el parámetro ${key} de ${executor}.`);
  }
  return parameters;
}

export function folderIdValue(value, name) {
  if (typeof value !== 'string' || !FOLDER_ID.test(value)) {
    throw definitionError(`${name} debe ser el id de una carpeta autorizada (64 caracteres hexadecimales; lo devuelve "estado").`);
  }
  return value;
}

export function folderIdList(value, name, max) {
  if (!Array.isArray(value) || value.length === 0 || value.length > max) {
    throw definitionError(`${name} debe ser una lista de 1 a ${max} ids de carpetas autorizadas.`);
  }
  value.forEach((item, index) => folderIdValue(item, `${name}[${index}]`));
  if (new Set(value).size !== value.length) throw definitionError(`${name} no puede repetir carpetas.`);
  return value;
}

export function integerValue(value, name, { min, max, fallback }) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw definitionError(`${name} debe ser un entero entre ${min} y ${max}.`);
  }
  return value;
}

export function existingMode(value) {
  if (value === undefined || value === 'error') return 'error';
  if (value === 'reemplazar') return 'reemplazar';
  throw definitionError('si_existe debe ser "error" (no tocar un archivo existente) o "reemplazar".');
}

/** Misma sintaxis que la creación del Motor: relativa, "/" entre componentes, sin alias especiales. */
export function validRelativePath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && value.split('/').every(
    (part) => part && part !== '.' && part !== '..' && !/[\\:\x00-\x1f<>"|?*]/u.test(part)
      && !/[. ]$/u.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part),
  );
}

// ---------------------------------------------------------------- Plantillas

export const TEMPLATE_VARIABLES = Object.freeze({
  fecha: 'fecha local AAAA-MM-DD',
  hora: 'hora local HH:MM (no válida en rutas: contiene «:»)',
  hora_compacta: 'hora local HHMM',
  anio: 'año AAAA',
  mes: 'mes MM',
  dia: 'día del mes DD',
  dia_semana: 'día de la semana (lunes, martes…)',
  semana: 'número de semana ISO 8601 (01-53)',
  funcion: 'id de la función',
  origen: 'manual, horario, evento, recuperacion o programada',
});
const TEMPLATE_TOKEN = /\{\{|\}\}|\{([a-z_]+)\}/gu;
const pad = (value, width = 2) => String(value).padStart(width, '0');

function isoWeek(date) {
  const day = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const weekday = day.getUTCDay() || 7;
  day.setUTCDate(day.getUTCDate() + 4 - weekday);
  const yearStart = new Date(Date.UTC(day.getUTCFullYear(), 0, 1));
  return Math.ceil(((day - yearStart) / 86_400_000 + 1) / 7);
}

/** Variables de una ejecución, en hora local, a partir de la entrada del anfitrión. */
export function templateVariables(input) {
  const date = new Date(Date.parse(input.fecha));
  return Object.freeze({
    fecha: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    hora: `${pad(date.getHours())}:${pad(date.getMinutes())}`,
    hora_compacta: `${pad(date.getHours())}${pad(date.getMinutes())}`,
    anio: String(date.getFullYear()),
    mes: pad(date.getMonth() + 1),
    dia: pad(date.getDate()),
    dia_semana: DAY_NAMES[date.getDay()],
    semana: pad(isoWeek(date)),
    funcion: input.funcion,
    origen: input.origen,
  });
}

const SAMPLE = templateVariables({ fecha: '2000-01-03T00:00:00.000Z', funcion: 'ejemplo', origen: 'manual' });

/** Sustituye {variable}; {{ y }} producen llaves literales. Nunca evalúa nada. */
export function renderTemplate(text, variables) {
  return text.replace(TEMPLATE_TOKEN, (match, name) => {
    if (match === '{{') return '{';
    if (match === '}}') return '}';
    if (!Object.hasOwn(variables, name)) {
      throw definitionError(`Variable desconocida: {${name.slice(0, 32)}}. Admitidas: ${Object.keys(TEMPLATE_VARIABLES).join(', ')}. Usa {{ y }} para llaves literales.`);
    }
    return variables[name];
  });
}

export function checkTemplate(value, name, max = MAX_TEMPLATE_CHARS) {
  if (typeof value !== 'string' || value.length > max || !value.isWellFormed() || value.includes('\0')) {
    throw definitionError(`${name} debe ser texto de hasta ${max} caracteres, sin NUL.`);
  }
  renderTemplate(value, SAMPLE);
  return value;
}

/** Destino { carpeta, ruta } con ruta relativa que puede usar variables. */
export function destinationValue(value, name = 'destino') {
  if (!isPlainObject(value)) throw definitionError(`${name} debe ser un objeto { carpeta, ruta }.`);
  for (const key of Object.keys(value)) {
    if (!['carpeta', 'ruta'].includes(key)) throw definitionError(`Campo desconocido en ${name}: ${key.slice(0, 40)}.`);
  }
  folderIdValue(value.carpeta, `${name}.carpeta`);
  checkTemplate(value.ruta, `${name}.ruta`, 1024);
  if (!validRelativePath(renderTemplate(value.ruta, SAMPLE))) {
    throw definitionError(`${name}.ruta debe ser un archivo relativo dentro de la carpeta, con "/" entre componentes, sin ".." ni caracteres como \\ : * ? " < > | (usa {hora_compacta} en lugar de {hora}).`);
  }
  return value;
}

export function renderPath(template, variables) {
  const rendered = renderTemplate(template, variables);
  if (!validRelativePath(rendered)) throw new MotorError('INVALID_OUTPUT_PATH', 'La ruta de destino resultante no es válida.');
  return rendered;
}

// ------------------------------------------------------------ Entrada del anfitrión

function validChanges(value) {
  const list = (item) => Array.isArray(item) && item.length <= 100 && item.every((path) => typeof path === 'string' && path.length <= 4096);
  return isPlainObject(value) && typeof value.carpeta === 'string' && FOLDER_ID.test(value.carpeta)
    && list(value.agregados) && list(value.modificados) && list(value.eliminados)
    && Number.isSafeInteger(value.total) && Object.keys(value).length === 5;
}

/**
 * La entrada la construye Mind en cada ejecución (nunca el agente):
 * { funcion, origen, fecha, cambios? }.
 */
export function validHostInput(input) {
  return isPlainObject(input)
    && Object.keys(input).every((key) => ['funcion', 'origen', 'fecha', 'cambios'].includes(key))
    && typeof input.funcion === 'string' && FUNCTION_ID.test(input.funcion)
    && ORIGINS.includes(input.origen)
    && typeof input.fecha === 'string' && Number.isFinite(Date.parse(input.fecha))
    && (input.cambios === undefined || validChanges(input.cambios));
}

// ----------------------------------------------------------- Permisos y escritura

/** Comprueba, en el momento de ejecutar, lo que el usuario concedió en la carpeta. */
export async function requireFolderAccess(session, folderId, levels) {
  const folder = await session.motor.getAuthorizedFolder(folderId);
  if (!folder) throw new MotorError('FOLDER_NOT_AUTHORIZED', 'Una carpeta que usa esta función no está autorizada en Mind.');
  const decision = await session.policy.get(folderId);
  for (const level of levels) {
    if (!decision?.access[level]) {
      throw new MotorError('ACCESS_NOT_GRANTED', `El usuario no concedió el permiso "${level}" en una carpeta que usa esta función.`);
    }
  }
  return folder;
}

export async function requireContinuityAccess(session, levels) {
  const decision = await session.policy.getContinuity();
  for (const level of levels) {
    if (!decision[level]) throw new MotorError('ACCESS_NOT_GRANTED', `El usuario no concedió "${level}" sobre la continuidad.`);
  }
}

export function writeLevels(mode) {
  return mode === 'reemplazar' ? ['leer', 'escribir'] : ['escribir'];
}

/**
 * Escribe en un original solo mediante permisos de un solo intento del Motor,
 * ligados a una identidad opaca de esta ejecución. "error": nunca toca un
 * archivo existente (FILE_EXISTS). "reemplazar": si existe, lo lee y lo
 * sustituye con control de versión (requiere leer y escribir).
 */
export async function writeOutput(session, { folderId, relativePath, content, mode = 'error', context }) {
  await requireFolderAccess(session, folderId, writeLevels(mode));
  const { motor } = session;
  const requester = Object.freeze({ funcion: context.funcion, origen: context.origen });
  const trace = { carpeta: folderId, ruta: relativePath, funcion: context.funcion, origen: context.origen };
  try {
    const authorization = await motor.grantTextCreate({ requester, folderId, relativePath });
    const created = await motor.createTextFile({ requester, authorization, content });
    await session.audit('archivo-creado', { ...trace, bytes: created.size });
    return { carpeta: folderId, ruta: relativePath, bytes: created.size, accion: 'creado', indice: created.index.status };
  } catch (error) {
    if (error?.code !== 'FILE_EXISTS' || mode !== 'reemplazar') throw error;
  }
  const readGrant = await motor.grantTextRead({ requester, folderId, relativePath });
  const current = await motor.readTextFile({ requester, authorization: readGrant });
  if (current.content === content) {
    return { carpeta: folderId, ruta: relativePath, bytes: Buffer.byteLength(content, 'utf8'), accion: 'sin-cambios', indice: 'current' };
  }
  const modifyGrant = await motor.grantTextModify({ requester, folderId, relativePath });
  const modified = await motor.modifyTextFile({
    requester, authorization: modifyGrant, expectedVersion: textVersion(current.content), content,
  });
  await session.audit('archivo-modificado', { ...trace, anterior: modified.previousVersion, nueva: modified.version });
  return { carpeta: folderId, ruta: relativePath, bytes: modified.size, accion: 'reemplazado', indice: modified.index.status };
}

// ---------------------------------------------------------------- Markdown

/** Texto de una línea seguro para Markdown (nombres de archivos del usuario). */
export function markdownText(value) {
  return String(value).replace(/[\u0000-\u001f\u007f\u2028\u2029]/gu, ' ').replace(/[\\`*_[\]<>#|~!]/gu, '\\$&');
}

export function localStamp(ms) {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function humanSize(bytes) {
  if (!Number.isSafeInteger(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1).replace('.', ',')} ${units[unit]}`;
}
