import { MotorError } from '../errors.js';
import { isExcluded } from '../paths.js';

/**
 * Activación de una función (campo `activacion` de su definición). Es un dato:
 * describe cuándo podría ejecutarse, pero no concede nada. La ejecución
 * automática exige además la autorización explícita del usuario
 * (src/automations/service.js).
 *
 *   { tipo: 'manual' }                                         (o ausente)
 *   { tipo: 'horario', frecuencia: 'diaria', hora: 'HH:MM' }
 *   { tipo: 'horario', frecuencia: 'semanal', dia: 'lunes', hora: 'HH:MM' }
 *   { tipo: 'horario', frecuencia: 'intervalo', minutos: N }    (N >= 15)
 *   { tipo: 'evento', carpeta: '<id>', subcarpeta?: 'ruta/relativa',
 *     extensiones?: ['.md'], espera_segundos?: 60 }
 *
 * Las horas son locales del equipo. Todas las funciones de este módulo son
 * puras: reciben el instante (ms) en lugar de leer el reloj.
 */

export const MIN_INTERVAL_MINUTES = 15;
export const MAX_INTERVAL_MINUTES = 7 * 24 * 60;
export const DEFAULT_EVENT_WAIT_SECONDS = 60;
export const DAY_NAMES = Object.freeze(['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado']);
const DAY_INDEX = new Map([...DAY_NAMES.map((name, index) => [name, index]), ['miercoles', 3], ['sabado', 6]]);
const HOUR = /^([01]\d|2[0-3]):([0-5]\d)$/;
const FOLDER_ID = /^[a-f0-9]{64}$/;
const EXTENSION = /^\.?[^./\\\s\u0000-\u001f]{1,32}$/u;
const MAX_LISTED = 100;

function invalid(message) {
  return new MotorError('INVALID_ACTIVATION', message);
}

function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function onlyKeys(value, allowed) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw invalid(`Campo desconocido en activacion: ${key.slice(0, 40)}. Admitidos: ${allowed.join(', ')}.`);
  }
}

function parseHour(value) {
  const match = typeof value === 'string' ? HOUR.exec(value) : null;
  if (!match) throw invalid('activacion.hora debe tener el formato HH:MM (24 horas, hora local).');
  return { hora: Number(match[1]), minuto: Number(match[2]) };
}

function subfolder(value) {
  if (value === undefined) return null;
  const item = typeof value === 'string' ? value.replace(/^\/+|\/+$/gu, '') : null;
  if (item === null || item === '' || item.length > 1024 || item.includes('\\')
      || item.split('/').some((part) => part === '' || part === '.' || part === '..' || /[\u0000-\u001f]/u.test(part))) {
    throw invalid('activacion.subcarpeta debe ser una ruta relativa dentro de la carpeta, con "/" entre componentes.');
  }
  return item;
}

function extensions(value) {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length === 0 || value.length > 32
      || !value.every((item) => typeof item === 'string' && EXTENSION.test(item))) {
    throw invalid('activacion.extensiones debe ser una lista de 1 a 32 extensiones, por ejemplo [".md", ".txt"].');
  }
  return [...new Set(value.map((item) => (item.startsWith('.') ? item : `.${item}`).toLowerCase()))].sort();
}

/**
 * Valida y normaliza una activación. Ausente equivale a manual.
 * @returns {Readonly<object>} Forma interna normalizada.
 */
export function normalizeActivation(value) {
  if (value === undefined) return Object.freeze({ tipo: 'manual' });
  if (!plain(value)) throw invalid('activacion debe ser un objeto, por ejemplo {"tipo":"manual"}.');
  switch (value.tipo) {
    case 'manual':
      onlyKeys(value, ['tipo']);
      return Object.freeze({ tipo: 'manual' });
    case 'horario': {
      if (value.frecuencia === 'diaria') {
        onlyKeys(value, ['tipo', 'frecuencia', 'hora']);
        return Object.freeze({ tipo: 'horario', frecuencia: 'diaria', ...parseHour(value.hora) });
      }
      if (value.frecuencia === 'semanal') {
        onlyKeys(value, ['tipo', 'frecuencia', 'dia', 'hora']);
        const day = typeof value.dia === 'string' ? DAY_INDEX.get(value.dia.trim().toLowerCase()) : undefined;
        if (day === undefined) throw invalid(`activacion.dia debe ser uno de: ${DAY_NAMES.slice(1).concat(DAY_NAMES[0]).join(', ')}.`);
        return Object.freeze({ tipo: 'horario', frecuencia: 'semanal', dia: day, ...parseHour(value.hora) });
      }
      if (value.frecuencia === 'intervalo') {
        onlyKeys(value, ['tipo', 'frecuencia', 'minutos']);
        if (!Number.isSafeInteger(value.minutos) || value.minutos < MIN_INTERVAL_MINUTES || value.minutos > MAX_INTERVAL_MINUTES) {
          throw invalid(`activacion.minutos debe ser un entero entre ${MIN_INTERVAL_MINUTES} y ${MAX_INTERVAL_MINUTES}.`);
        }
        return Object.freeze({ tipo: 'horario', frecuencia: 'intervalo', minutos: value.minutos });
      }
      throw invalid('activacion.frecuencia debe ser diaria, semanal o intervalo.');
    }
    case 'evento': {
      onlyKeys(value, ['tipo', 'carpeta', 'subcarpeta', 'extensiones', 'espera_segundos']);
      if (typeof value.carpeta !== 'string' || !FOLDER_ID.test(value.carpeta)) {
        throw invalid('activacion.carpeta debe ser el id de una carpeta autorizada (lo devuelve "estado").');
      }
      const wait = value.espera_segundos ?? DEFAULT_EVENT_WAIT_SECONDS;
      if (!Number.isSafeInteger(wait) || wait < 5 || wait > 3600) {
        throw invalid('activacion.espera_segundos debe ser un entero entre 5 y 3600.');
      }
      return Object.freeze({
        tipo: 'evento', carpeta: value.carpeta, subcarpeta: subfolder(value.subcarpeta),
        extensiones: extensions(value.extensiones), esperaSegundos: wait,
      });
    }
    default:
      throw invalid('activacion.tipo debe ser manual, horario o evento.');
  }
}

export function isAutomatic(activation) {
  return activation.tipo === 'horario' || activation.tipo === 'evento';
}

const pad = (value) => String(value).padStart(2, '0');

function localSlot(year, month, day, hour, minute) {
  return new Date(year, month, day, hour, minute, 0, 0).getTime();
}

/**
 * Último instante programado que no es posterior a nowMs (null si aún no hay).
 * Diaria y semanal no dependen del ancla; el intervalo se mide desde ella
 * (la fecha de la autorización), sin ejecutar en el propio instante del ancla.
 */
export function latestSlot(activation, anchorMs, nowMs) {
  if (activation.tipo !== 'horario') return null;
  if (activation.frecuencia === 'intervalo') {
    const step = activation.minutos * 60_000;
    if (nowMs < anchorMs + step) return null;
    return anchorMs + Math.floor((nowMs - anchorMs) / step) * step;
  }
  const now = new Date(nowMs);
  const back = activation.frecuencia === 'semanal' ? (now.getDay() - activation.dia + 7) % 7 : 0;
  const period = activation.frecuencia === 'semanal' ? 7 : 1;
  let slot = localSlot(now.getFullYear(), now.getMonth(), now.getDate() - back, activation.hora, activation.minuto);
  if (slot > nowMs) slot = localSlot(now.getFullYear(), now.getMonth(), now.getDate() - back - period, activation.hora, activation.minuto);
  return slot;
}

/** Primer instante programado estrictamente posterior a afterMs. */
export function nextSlot(activation, anchorMs, afterMs) {
  if (activation.tipo !== 'horario') return null;
  if (activation.frecuencia === 'intervalo') {
    const step = activation.minutos * 60_000;
    if (afterMs < anchorMs + step) return anchorMs + step;
    return anchorMs + (Math.floor((afterMs - anchorMs) / step) + 1) * step;
  }
  const after = new Date(afterMs);
  const ahead = activation.frecuencia === 'semanal' ? (activation.dia - after.getDay() + 7) % 7 : 0;
  const period = activation.frecuencia === 'semanal' ? 7 : 1;
  let slot = localSlot(after.getFullYear(), after.getMonth(), after.getDate() + ahead, activation.hora, activation.minuto);
  if (slot <= afterMs) slot = localSlot(after.getFullYear(), after.getMonth(), after.getDate() + ahead + period, activation.hora, activation.minuto);
  return slot;
}

/**
 * Turno vencido pendiente: el último programado, si es posterior a la
 * autorización y a la última ejecución registrada. Solo uno, aunque se hayan
 * perdido varios mientras Mind estuvo cerrado.
 */
export function dueSlot(activation, { grantedAtMs, lastSlotMs = null, nowMs }) {
  const slot = latestSlot(activation, grantedAtMs, nowMs);
  if (slot === null) return null;
  const reference = Math.max(grantedAtMs, lastSlotMs ?? -Infinity);
  return slot > reference ? slot : null;
}

/** Texto para el usuario y el agente. */
export function describeActivation(activation, { folderPath = null } = {}) {
  switch (activation.tipo) {
    case 'manual':
      return 'solo manual, cuando se pide';
    case 'horario':
      if (activation.frecuencia === 'diaria') return `cada día a las ${pad(activation.hora)}:${pad(activation.minuto)} (hora local de este equipo)`;
      if (activation.frecuencia === 'semanal') return `cada ${DAY_NAMES[activation.dia]} a las ${pad(activation.hora)}:${pad(activation.minuto)} (hora local de este equipo)`;
      return `cada ${activation.minutos} minutos, contados desde la autorización`;
    case 'evento': {
      const where = folderPath === null ? `la carpeta ${activation.carpeta.slice(0, 12)}…` : folderPath;
      const sub = activation.subcarpeta ? `, dentro de «${activation.subcarpeta}»` : '';
      const ext = activation.extensiones ? `, solo archivos ${activation.extensiones.join(', ')}` : '';
      return `cuando cambie algo en ${where}${sub}${ext}; agrupa los cambios durante ${activation.esperaSegundos} s y solo mientras haya una sesión de Mind abierta`;
    }
    default:
      return 'desconocida';
  }
}

function matches(activation, relativePath) {
  if (activation.subcarpeta !== null && !isExcluded([activation.subcarpeta], relativePath)) return false;
  if (activation.extensiones !== null) {
    const lower = relativePath.toLowerCase();
    if (!activation.extensiones.some((extension) => lower.endsWith(extension) && lower.length > extension.length)) return false;
  }
  return true;
}

/**
 * Cambios reconciliados (session.onChanges) que corresponden a una activación
 * por evento. `ignore(path)` permite descartar lo que escribió la propia
 * automatización. null si no hay ninguno.
 */
export function matchingChanges(activation, changes, ignore = () => false) {
  if (activation.tipo !== 'evento' || !changes) return null;
  const keep = (item) => typeof item === 'string' && matches(activation, item) && !ignore(item);
  const renamed = Array.isArray(changes.renamed) ? changes.renamed : [];
  const result = {
    agregados: [...(changes.added ?? []), ...renamed.map((item) => item?.to)].filter(keep),
    modificados: (changes.modified ?? []).filter(keep),
    eliminados: [...(changes.removed ?? []), ...renamed.map((item) => item?.from)].filter(keep),
  };
  return result.agregados.length + result.modificados.length + result.eliminados.length > 0 ? result : null;
}

/** Une cambios agrupados y los acota para la entrada del ejecutor (sin contenido). */
export function mergeChanges(target, addition) {
  for (const key of ['agregados', 'modificados', 'eliminados']) {
    for (const item of addition[key]) target[key].add(item);
  }
  return target;
}

export function changesInput(folderId, grouped) {
  const list = (set) => [...set].sort().slice(0, MAX_LISTED);
  return {
    carpeta: folderId,
    agregados: list(grouped.agregados),
    modificados: list(grouped.modificados),
    eliminados: list(grouped.eliminados),
    total: grouped.agregados.size + grouped.modificados.size + grouped.eliminados.size,
  };
}
