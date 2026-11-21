import fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { MotorError } from './errors.js';
import { withIndexLock } from './index-lock.js';
import { requestSignal } from './request-context.js';
import { parseStoredJson, readJson, writeJson, removeJson } from './storage.js';

const ENTRY_FORMAT = 'mind-continuity-entry';
const EXPORT_FORMAT = 'mind-continuity-export';
const VERSION = 1;
const VALID_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const FILENAME = /^continuity-([a-f0-9-]{36})\.json$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ENTRY_KEYS = ['content', 'createdAt', 'format', 'id', 'kind', 'references', 'revision',
  'source', 'updatedAt', 'version'];

export const CONTINUITY_LIMITS = Object.freeze({
  contentBytes: 256 * 1024,
  contentDepth: 32,
  labelLength: 200,
  locatorLength: 2048,
  references: 100,
  exportEntries: 1000,
});

/**
 * @typedef {null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }} JsonValue
 * @typedef {{ entry: string, relation?: string } | { locator: string, relation?: string }} ContinuityReference
 * @typedef {object} ContinuityEntry
 * @property {string} id
 * @property {number} revision Aumenta en cada actualización.
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {string | null} source Origen declarado por el anfitrión; no prueba identidad.
 * @property {string | null} kind Etiqueta libre: instrucción, decisión, resultado…
 * @property {JsonValue} content
 * @property {ContinuityReference[]} references
 */

function fail(code, message, options) {
  throw new MotorError(code, message, options);
}

function validateId(id, code = 'INVALID_CONTINUITY_ID') {
  if (typeof id !== 'string' || !VALID_ID.test(id)) {
    fail(code, 'El identificador de continuidad no es válido.');
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateLabel(value, field, maxLength = CONTINUITY_LIMITS.labelLength) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength
      || !value.isWellFormed() || /[\u0000-\u001f\u007f]/.test(value)) {
    fail('INVALID_CONTINUITY_FIELD', `El campo ${field} debe ser texto de 1 a ${maxLength} caracteres, sin controles.`);
  }
  return value;
}

/** Copia profunda que solo admite datos JSON; rechaza objetos especiales en vez de convertirlos. */
function copyContent(value, depth = 0) {
  if (depth > CONTINUITY_LIMITS.contentDepth) {
    fail('INVALID_CONTINUITY_CONTENT', 'El contenido supera la profundidad admitida.');
  }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('INVALID_CONTINUITY_CONTENT', 'El contenido solo admite números finitos.');
    return value;
  }
  if (typeof value === 'string') {
    if (!value.isWellFormed()) fail('INVALID_CONTINUITY_CONTENT', 'El contenido tiene texto Unicode mal formado.');
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => copyContent(item, depth + 1));
  if (isPlainObject(value)) {
    const copy = Object.create(null);
    for (const key of Object.keys(value)) {
      if (!key.isWellFormed()) fail('INVALID_CONTINUITY_CONTENT', 'El contenido tiene una clave Unicode mal formada.');
      copy[key] = copyContent(value[key], depth + 1);
    }
    // Los símbolos y propiedades no enumerables no son portables.
    if (Object.getOwnPropertySymbols(value).length > 0) {
      fail('INVALID_CONTINUITY_CONTENT', 'El contenido solo admite datos JSON.');
    }
    return { ...copy };
  }
  fail('INVALID_CONTINUITY_CONTENT', 'El contenido solo admite datos JSON.');
}

function validateContent(value) {
  if (value === undefined) fail('INVALID_CONTINUITY_CONTENT', 'Indica el contenido que se desea conservar.');
  const content = copyContent(value);
  if (Buffer.byteLength(JSON.stringify(content), 'utf8') > CONTINUITY_LIMITS.contentBytes) {
    fail('CONTINUITY_TOO_LARGE', 'El contenido supera el tamaño admitido.');
  }
  return content;
}

function referenceKey(reference) {
  return JSON.stringify([reference.entry ?? null, reference.locator ?? null, reference.relation ?? null]);
}

function validateReference(value) {
  if (!isPlainObject(value)) fail('INVALID_CONTINUITY_REFERENCE', 'Cada referencia debe ser un objeto.');
  const keys = Object.keys(value);
  const relation = validateLabel(value.relation, 'relation');
  const hasEntry = Object.hasOwn(value, 'entry');
  if (hasEntry === Object.hasOwn(value, 'locator')
      || keys.some((key) => !['entry', 'locator', 'relation'].includes(key))) {
    fail('INVALID_CONTINUITY_REFERENCE', 'Una referencia indica entry o locator, y opcionalmente relation.');
  }
  const reference = hasEntry
    ? (validateId(value.entry, 'INVALID_CONTINUITY_REFERENCE'), { entry: value.entry })
    : { locator: validateLabel(value.locator, 'locator', CONTINUITY_LIMITS.locatorLength) };
  if (reference.locator === null) fail('INVALID_CONTINUITY_REFERENCE', 'El localizador no puede estar vacío.');
  return relation === null ? reference : { ...reference, relation };
}

/** Normaliza y deduplica conservando el primer orden recibido. */
function validateReferences(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail('INVALID_CONTINUITY_REFERENCE', 'Las referencias deben ser una lista.');
  const seen = new Set();
  const references = [];
  for (const item of value) {
    const reference = validateReference(item);
    const key = referenceKey(reference);
    if (!seen.has(key)) {
      seen.add(key);
      references.push(reference);
    }
  }
  if (references.length > CONTINUITY_LIMITS.references) {
    fail('INVALID_CONTINUITY_REFERENCE', `Se admiten como máximo ${CONTINUITY_LIMITS.references} referencias.`);
  }
  return references;
}

function rejectUnknownFields(request, allowed) {
  if (!isPlainObject(request)) fail('INVALID_CONTINUITY_FIELD', 'La petición debe ser un objeto.');
  const unknown = Object.keys(request).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) fail('INVALID_CONTINUITY_FIELD', `Campos no admitidos: ${unknown.join(', ')}.`);
}

/** Valida la forma completa; se usa para la Base y para paquetes portables. */
function checkEntry(data, code) {
  const corrupt = (cause) => fail(code, 'El registro de continuidad no tiene el formato esperado.', { cause });
  if (!isPlainObject(data) || data.format !== ENTRY_FORMAT) corrupt();
  if (data.version !== VERSION) {
    fail('CONTINUITY_UNSUPPORTED_VERSION', 'La versión del registro de continuidad no es compatible.');
  }
  const keys = Object.keys(data).sort();
  if (keys.length !== ENTRY_KEYS.length || keys.some((key, index) => key !== ENTRY_KEYS[index])
      || typeof data.id !== 'string' || !VALID_ID.test(data.id)
      || !Number.isSafeInteger(data.revision) || data.revision < 1
      || typeof data.createdAt !== 'string' || !TIMESTAMP.test(data.createdAt)
      || typeof data.updatedAt !== 'string' || !TIMESTAMP.test(data.updatedAt)
      || data.updatedAt < data.createdAt
      || data.source === undefined || data.kind === undefined || !Array.isArray(data.references)) {
    corrupt();
  }
  try {
    const entry = {
      id: data.id,
      revision: data.revision,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
      source: validateLabel(data.source, 'source'),
      kind: validateLabel(data.kind, 'kind'),
      content: validateContent(data.content),
      references: validateReferences(data.references),
    };
    if (entry.references.length !== data.references.length) corrupt();
    return entry;
  } catch (error) {
    if (error instanceof MotorError && error.code !== code) corrupt(error);
    throw error;
  }
}

function toStored(entry) {
  return { format: ENTRY_FORMAT, version: VERSION, ...entry };
}

function nextTimestamp(previous) {
  const now = new Date().toISOString();
  // Mantiene el orden aunque el reloj del sistema retroceda.
  return previous && now < previous ? previous : now;
}

function fence(text) {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const marks = '`'.repeat(longest + 1);
  return `${marks}\n${text}\n${marks}`;
}

function inline(text) {
  return text.replace(/[\\`*_[\]<>#|]/g, '\\$&');
}

/**
 * Comprueba un paquete portable recibido de otra aplicación o leído de un archivo.
 * @param {string | object} input
 */
export function parseContinuityExport(input) {
  let data = input;
  if (typeof input === 'string') {
    try {
      data = JSON.parse(input);
    } catch (error) {
      fail('CONTINUITY_EXPORT_INVALID', 'El paquete de continuidad no contiene JSON válido.', { cause: error });
    }
  }
  const invalid = () => fail('CONTINUITY_EXPORT_INVALID', 'El paquete de continuidad no tiene el formato esperado.');
  if (!isPlainObject(data) || data.format !== EXPORT_FORMAT) invalid();
  if (data.version !== VERSION) {
    fail('CONTINUITY_UNSUPPORTED_VERSION', 'La versión del paquete de continuidad no es compatible.');
  }
  const keys = Object.keys(data).sort().join(',');
  if (keys !== 'entries,exportedAt,format,missing,version'
      || typeof data.exportedAt !== 'string' || !TIMESTAMP.test(data.exportedAt)
      || !Array.isArray(data.entries) || data.entries.length > CONTINUITY_LIMITS.exportEntries
      || !Array.isArray(data.missing)) {
    invalid();
  }
  const entries = data.entries.map((entry) => checkEntry(entry, 'CONTINUITY_EXPORT_INVALID'));
  const ids = new Set(entries.map((entry) => entry.id));
  if (ids.size !== entries.length) invalid();
  for (const id of data.missing) {
    validateId(id, 'CONTINUITY_EXPORT_INVALID');
    if (ids.has(id)) invalid();
  }
  return {
    format: EXPORT_FORMAT, version: VERSION, exportedAt: data.exportedAt,
    entries, missing: [...new Set(data.missing)],
  };
}

/** Versión legible del paquete; no sustituye al JSON para reimportar. */
export function formatContinuityMarkdown(input) {
  const pack = parseContinuityExport(input);
  const lines = ['# Continuidad exportada de Mind', '', `Exportado: ${pack.exportedAt}`, ''];
  for (const entry of pack.entries) {
    lines.push(`## ${entry.kind === null ? 'Registro' : inline(entry.kind)} · ${entry.id}`, '');
    lines.push(`- Revisión: ${entry.revision}`);
    lines.push(`- Creado: ${entry.createdAt}`);
    lines.push(`- Actualizado: ${entry.updatedAt}`);
    if (entry.source !== null) lines.push(`- Origen declarado: ${inline(entry.source)}`);
    lines.push('');
    lines.push(fence(typeof entry.content === 'string' ? entry.content : JSON.stringify(entry.content, null, 2)));
    if (entry.references.length > 0) {
      lines.push('', 'Referencias:', '');
      for (const reference of entry.references) {
        const target = reference.entry !== undefined ? `registro ${reference.entry}` : inline(reference.locator);
        lines.push(`- ${reference.relation === undefined ? '' : `${inline(reference.relation)}: `}${target}`);
      }
    }
    lines.push('');
  }
  if (pack.missing.length > 0) {
    lines.push('## Referencias no disponibles', '', ...pack.missing.map((id) => `- ${id}`), '');
  }
  return lines.join('\n');
}

/**
 * Núcleo de continuidad sobre la Base del Motor recibido.
 * Registra solo lo que el anfitrión entrega de forma explícita; no lee historiales
 * de plataformas ni originales, y no decide quién está autorizado a llamarlo.
 * @param {{ baseDirectory: string, readContinuityText?: (id: string) => Promise<string | null> }} motor
 */
export function createContinuity(motor) {
  if (!motor || typeof motor.baseDirectory !== 'string' || !path.isAbsolute(motor.baseDirectory)) {
    fail('INVALID_BASE', 'Indica una instancia del Motor con una Base absoluta.');
  }
  const base = motor.baseDirectory;
  if (motor.writeNativeText && !motor.readContinuityText) {
    fail('INVALID_BASE', 'El escritor de continuidad necesita el lector del mismo anfitrión.');
  }

  function filename(id) {
    validateId(id);
    return path.join(base, `continuity-${id}.json`);
  }

  async function loadRecord(id) {
    const target = filename(id);
    let stored, text;
    if (motor.readContinuityText) {
      text = await motor.readContinuityText(id);
      stored = text === null ? null : parseStoredJson(text);
    } else {
      stored = await readJson(target);
    }
    if (stored === null) return null;
    const entry = checkEntry(stored.data, 'CONTINUITY_CORRUPT');
    if (entry.id !== id) fail('CONTINUITY_CORRUPT', 'El registro de continuidad no corresponde a su archivo.');
    return { entry, text };
  }

  async function load(id) {
    return (await loadRecord(id))?.entry ?? null;
  }

  async function loadExistingRecord(id) {
    const record = await loadRecord(id);
    if (record === null) fail('CONTINUITY_NOT_FOUND', 'No existe un registro de continuidad con ese identificador.');
    return record;
  }

  async function requireEntryReferences(references, selfId, existingReferences = []) {
    const existing = new Set(existingReferences.map(ref=>ref.entry).filter(Boolean));
    for (const reference of references) {
      if (reference.entry === undefined) continue;
      if (reference.entry === selfId) {
        fail('INVALID_CONTINUITY_REFERENCE', 'Un registro no puede referirse a sí mismo.');
      }
      if (!existing.has(reference.entry) && await load(reference.entry) === null) {
        fail('CONTINUITY_REFERENCE_NOT_FOUND', 'La referencia apunta a un registro de continuidad inexistente.');
      }
    }
  }

  function checkRevision(entry, expectedRevision) {
    if (expectedRevision === undefined) return;
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      fail('INVALID_CONTINUITY_FIELD', 'expectedRevision debe ser un entero positivo.');
    }
    if (entry.revision !== expectedRevision) {
      fail('CONTINUITY_REVISION_CONFLICT', 'El registro cambió desde la revisión indicada.');
    }
  }

  async function save(entry, previous, confirm) {
    const target = filename(entry.id);
    const stored = toStored(entry);
    if (motor.writeNativeText) {
      const expected = previous ? createHash('sha256').update(previous.text).digest('hex') : undefined;
      await motor.writeNativeText({
        root: base, relativePath: path.basename(target),
        bytes: Buffer.from(JSON.stringify(stored) + '\n'), expected, maxBytes: 2 * 1024 * 1024,
        confirm: async () => {
          requestSignal()?.throwIfAborted();
          await confirm?.();
        },
      });
    } else {
      await writeJson(target, stored);
    }
    return entry;
  }

  return Object.freeze({
    /**
     * @param {{ content: JsonValue, kind?: string, source?: string, references?: ContinuityReference[] }} request
     * @returns {Promise<ContinuityEntry>}
     */
    async recordContinuity(request, { confirm } = {}) {
      rejectUnknownFields(request, ['content', 'kind', 'source', 'references']);
      const content = validateContent(request.content);
      const kind = validateLabel(request.kind, 'kind');
      const source = validateLabel(request.source, 'source');
      const references = validateReferences(request.references);
      await requireEntryReferences(references);
      const now = nextTimestamp();
      // El id aleatorio evita que dos anfitriones elijan el mismo nombre por accidente.
      return save({
        id: randomUUID(), revision: 1, createdAt: now, updatedAt: now, source, kind, content, references,
      }, undefined, confirm);
    },

    /** @returns {Promise<ContinuityEntry | null>} */
    getContinuity: load,

    /**
     * Sustituye los campos indicados; los omitidos se conservan.
     * @param {string} id
     * @param {{ content?: JsonValue, kind?: string | null, source?: string | null, references?: ContinuityReference[] }} changes
     * @param {{ expectedRevision?: number }} [options]
     */
    async updateContinuity(id, changes, { expectedRevision, preserveExistingReferences = false, confirm } = {}) {
      validateId(id);
      return withIndexLock(base, id, async () => {
        rejectUnknownFields(changes, ['content', 'kind', 'source', 'references']);
        if (Object.keys(changes).length === 0) fail('INVALID_CONTINUITY_FIELD', 'Indica al menos un campo a actualizar.');
        const previous = await loadExistingRecord(id);
        const { entry } = previous;
        checkRevision(entry, expectedRevision);
        const next = { ...entry };
        if (Object.hasOwn(changes, 'content')) next.content = validateContent(changes.content);
        if (Object.hasOwn(changes, 'kind')) next.kind = validateLabel(changes.kind, 'kind');
        if (Object.hasOwn(changes, 'source')) next.source = validateLabel(changes.source, 'source');
        if (Object.hasOwn(changes, 'references')) {
          next.references = validateReferences(changes.references);
          await requireEntryReferences(next.references, id, preserveExistingReferences ? entry.references : []);
        }
        next.revision = entry.revision + 1;
        next.updatedAt = nextTimestamp(entry.updatedAt);
        return save(next, previous, confirm);
      }, 'continuity-entry', { signal: requestSignal() });
    },

    /** Añade referencias sin duplicar las existentes. */
    async relateContinuity(id, references, { expectedRevision } = {}) {
      validateId(id);
      return withIndexLock(base, id, async () => {
        const added = validateReferences(references);
        if (added.length === 0) fail('INVALID_CONTINUITY_REFERENCE', 'Indica al menos una referencia.');
        const previous = await loadExistingRecord(id);
        const { entry } = previous;
        checkRevision(entry, expectedRevision);
        await requireEntryReferences(added, id);
        const merged = validateReferences([...entry.references, ...added]);
        if (merged.length === entry.references.length) return entry;
        return save({
          ...entry, references: merged, revision: entry.revision + 1, updatedAt: nextTimestamp(entry.updatedAt),
        }, previous);
      }, 'continuity-entry', { signal: requestSignal() });
    },

    /** Retira el registro de la Base. Otras referencias a él quedan como no disponibles. */
    async retireContinuity(id, { expectedRevision } = {}) {
      validateId(id);
      return withIndexLock(base, id, async () => {
        if (expectedRevision !== undefined) {
          const entry = await load(id);
          if (entry === null) return false;
          checkRevision(entry, expectedRevision);
        }
        return removeJson(filename(id));
      }, 'continuity-entry', { signal: requestSignal() });
    },

    /** Identificadores presentes en la Base, sin abrir su contenido. */
    async listContinuityIds() {
      const ids = [];
      for (const name of (await fs.readdir(base)).sort()) {
        const match = FILENAME.exec(name);
        if (match && VALID_ID.test(match[1])) ids.push(match[1]);
      }
      return ids;
    },

    /**
     * Paquete portable con los registros elegidos. No incluye originales.
     * @param {{ ids: string[], includeReferenced?: boolean }} request
     */
    async exportContinuity(request) {
      rejectUnknownFields(request, ['ids', 'includeReferenced']);
      const { ids, includeReferenced = false } = request;
      if (!Array.isArray(ids) || ids.length === 0) fail('INVALID_CONTINUITY_FIELD', 'Indica los registros a exportar.');
      if (typeof includeReferenced !== 'boolean') fail('INVALID_CONTINUITY_FIELD', 'includeReferenced debe ser booleano.');
      ids.forEach((id) => validateId(id));
      const selected = [...new Set(ids)];
      const entries = new Map();
      const missing = new Set();
      for (const id of selected) entries.set(id, (await loadExistingRecord(id)).entry);
      const pending = includeReferenced ? [...entries.values()] : [];
      while (pending.length > 0) {
        for (const reference of pending.shift().references) {
          const target = reference.entry;
          if (target === undefined || entries.has(target) || missing.has(target)) continue;
          const entry = await load(target);
          if (entry === null) {
            missing.add(target);
          } else {
            entries.set(target, entry);
            pending.push(entry);
          }
        }
      }
      if (!includeReferenced) {
        for (const entry of entries.values()) {
          for (const { entry: target } of entry.references) {
            if (target !== undefined && !entries.has(target) && await load(target) === null) missing.add(target);
          }
        }
      }
      if (entries.size > CONTINUITY_LIMITS.exportEntries) {
        fail('CONTINUITY_TOO_LARGE', 'La exportación supera el número de registros admitido.');
      }
      return {
        format: EXPORT_FORMAT,
        version: VERSION,
        exportedAt: new Date().toISOString(),
        entries: [...entries.values()].map(toStored),
        missing: [...missing].sort(),
      };
    },

    /**
     * Incorpora un paquete en esta Base sin sobrescribir trabajo distinto.
     * Primero comprueba todo el paquete; ante un conflicto no escribe nada.
     */
    async importContinuity(input) {
      const pack = parseContinuityExport(input);
      const imported = [];
      const unchanged = [];
      for (const entry of pack.entries) {
        const existing = await load(entry.id);
        if (existing === null) {
          imported.push(entry);
        } else if (JSON.stringify(existing) === JSON.stringify(entry)) {
          unchanged.push(entry.id);
        } else {
          fail('CONTINUITY_CONFLICT', 'La Base ya contiene una versión distinta de un registro del paquete.');
        }
      }
      for (const entry of imported) await save(entry);
      return { imported: imported.map((entry) => entry.id), unchanged };
    },
  });
}
