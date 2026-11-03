import path from 'node:path';
import { MotorError } from '../errors.js';

/**
 * Utilidades comunes a las herramientas de agente: validación estricta de
 * argumentos y formato de salida. Los argumentos del agente son datos no
 * confiables: nunca conceden permisos por sí mismos.
 */

export const FOLDER_ID = /^[a-f0-9]{64}$/;
export const TYPE_IN = Object.freeze({ archivo: 'file', carpeta: 'directory', enlace: 'link', otro: 'other' });
export const TYPE_OUT = Object.freeze({ file: 'archivo', directory: 'carpeta', link: 'enlace', other: 'otro', unknown: 'desconocido' });

export function invalid(message) {
  return new MotorError('INVALID_ARGUMENTS', message);
}

export function only(args, allowed) {
  const unknown = Object.keys(args).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw invalid(`Parámetros desconocidos: ${unknown.map((key) => key.slice(0, 40)).join(', ')}.`);
}

export function text(value, name, { optional = false, max = 4096, allowEmpty = false } = {}) {
  if (value === undefined && optional) return undefined;
  if (typeof value !== 'string' || (!allowEmpty && value === '') || value.length > max) {
    throw invalid(`${name} debe ser texto${allowEmpty ? '' : ' no vacío'} de hasta ${max} caracteres.`);
  }
  return value;
}

export function integer(value, name, { optional = true, min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined && optional) return undefined;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw invalid(`${name} debe ser un entero entre ${min} y ${max}.`);
  return value;
}

export function bool(value, name) {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw invalid(`${name} debe ser booleano.`);
  return value;
}

export function strings(value, name, { max = 32, itemMax = 256 } = {}) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > max
      || !value.every((item) => typeof item === 'string' && item.length > 0 && item.length <= itemMax)) {
    throw invalid(`${name} debe ser una lista de 1 a ${max} textos.`);
  }
  return value;
}

export function absolute(root, relativePath) {
  return relativePath === '' ? root : path.join(root, ...relativePath.split('/'));
}

export function iso(value) {
  return value ?? null;
}

export function lineCount(content) {
  if (content === '') return 0;
  return content.split('\n').length - (content.endsWith('\n') ? 1 : 0);
}

export function countOccurrences(haystack, needle) {
  let count = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) count += 1;
  return count;
}

export function entryOut(folder, entry) {
  return {
    carpeta: folder.id,
    ruta: entry.path,
    nombre: entry.path.slice(entry.path.lastIndexOf('/') + 1),
    tipo: TYPE_OUT[entry.type] ?? entry.type,
    bytes: entry.size,
    modificado: iso(entry.modifiedAt),
    creado: iso(entry.createdAt),
    estado: entry.state === 'indexed' ? 'indexado' : entry.state === 'not-listed' ? 'sin-listar' : 'sin-verificar',
    ...(entry.reason ? { motivo: entry.reason } : {}),
    ruta_absoluta: absolute(folder.path, entry.path),
  };
}

export function continuityOut(entry) {
  return {
    id: entry.id,
    revision: entry.revision,
    creado: entry.createdAt,
    actualizado: entry.updatedAt,
    origen: entry.source,
    tipo: entry.kind,
    contenido: entry.content,
    referencias: entry.references.map((reference) => ({
      ...(reference.entry ? { registro: reference.entry } : { ubicacion: reference.locator }),
      ...(reference.relation ? { relacion: reference.relation } : {}),
    })),
  };
}

export function referencesIn(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw invalid('referencias debe ser una lista.');
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw invalid('Cada referencia debe ser un objeto.');
    only(item, ['registro', 'ubicacion', 'relacion']);
    const reference = Object.hasOwn(item, 'registro') ? { entry: item.registro } : { locator: item.ubicacion };
    if (item.relacion !== undefined) reference.relation = item.relacion;
    return reference;
  });
}

export function schema(properties, required = []) {
  return { type: 'object', properties, required, additionalProperties: false };
}

export const FOLDER_REF = { type: 'string', description: 'Id de la carpeta autorizada (lo devuelve "estado") o su ruta absoluta registrada. Opcional si solo hay una carpeta.' };
export const RELATIVE_PATH = { type: 'string', description: 'Ruta relativa dentro de la carpeta, con "/" entre componentes (por ejemplo "notas/idea.md").' };

