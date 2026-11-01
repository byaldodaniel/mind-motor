import { MotorError } from './errors.js';
import { CONTINUITY_LIMITS, formatContinuityMarkdown, parseContinuityExport } from './continuity.js';

const FORMATS = ['json', 'markdown', 'object'];
const RESULT_FIELDS = ['content', 'kind', 'references'];

function fail(code, message, options) {
  throw new MotorError(code, message, options);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function rejectUnknownFields(request, allowed) {
  if (!isPlainObject(request)) fail('INVALID_CONTINUITY_FIELD', 'La petición debe ser un objeto.');
  const unknown = Object.keys(request).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) fail('INVALID_CONTINUITY_FIELD', `Campos no admitidos: ${unknown.join(', ')}.`);
}

/**
 * Acceso controlado de agentes a la continuidad existente.
 * Solo el anfitrión de confianza recibe este objeto: concede, describe y retira.
 * Al agente le entrega `bindContinuityAgent(...)`, ligado a su identidad opaca.
 * No guarda registros propios: lee y escribe a través del núcleo recibido.
 * @param {ReturnType<import('./continuity.js').createContinuity>} continuity
 */
export function createContinuityAccess(continuity) {
  if (!continuity || typeof continuity.getContinuity !== 'function'
      || typeof continuity.recordContinuity !== 'function' || typeof continuity.exportContinuity !== 'function') {
    fail('INVALID_CONTINUITY_FIELD', 'Indica el núcleo de continuidad creado con createContinuity.');
  }
  const grants = new WeakMap();
  const denied = () => new MotorError('CONTINUITY_ACCESS_DENIED',
    'No existe un acceso vigente de este solicitante a ese contexto de continuidad.');

  function grantFor(requester, authorization) {
    const grant = grants.get(authorization);
    if (!grant || grant.revoked || grant.requester !== requester) throw denied();
    return grant;
  }

  /** Paquete del núcleo restringido a la selección; los retirados pasan a `missing`. */
  async function exportReadable(grant) {
    for (let attempt = 0; ; attempt += 1) {
      const present = [];
      const missing = [];
      for (const id of [...grant.readable].sort()) {
        const entry = await continuity.getContinuity(id);
        if (entry === null) missing.push(id);
        else present.push(entry);
      }
      present.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1));
      try {
        // Sin includeReferenced: las referencias externas a la selección quedan como ids, sin contenido.
        const pack = present.length > 0
          ? await continuity.exportContinuity({ ids: present.map((entry) => entry.id) })
          : { format: 'mind-continuity-export', version: 1, exportedAt: new Date().toISOString(), entries: [] };
        // El `missing` del núcleo revelaría si existen registros no seleccionados.
        const restricted = { ...pack, missing };
        parseContinuityExport(restricted);
        return restricted;
      } catch (error) {
        // Un registro retirado durante la lectura se vuelve a clasificar como no disponible.
        if (error?.code !== 'CONTINUITY_NOT_FOUND' || attempt >= 2) throw error;
      }
    }
  }

  async function readContinuityContext(request) {
    rejectUnknownFields(request, ['requester', 'authorization', 'format']);
    const { requester, authorization, format = 'json' } = request;
    const grant = grantFor(requester, authorization);
    if (!FORMATS.includes(format)) fail('INVALID_CONTINUITY_FIELD', `format debe ser ${FORMATS.join(', ')}.`);
    const pack = await exportReadable(grant);
    grantFor(requester, authorization); // No se entrega si se retiró durante la lectura.
    if (format === 'object') return pack;
    return format === 'markdown' ? formatContinuityMarkdown(pack) : JSON.stringify(pack, null, 2);
  }

  async function recordContinuityResult(request) {
    rejectUnknownFields(request, ['requester', 'authorization', 'result']);
    const { requester, authorization, result } = request;
    const grant = grantFor(requester, authorization);
    if (!grant.allowRecord) throw denied();
    // `source` lo fija el anfitrión en la concesión; el agente no puede declararse otro origen.
    rejectUnknownFields(result, RESULT_FIELDS);
    if (Array.isArray(result.references)) {
      for (const reference of result.references) {
        // Igual respuesta para registros ajenos e inexistentes: no se revela qué hay en la Base.
        if (isPlainObject(reference) && typeof reference.entry === 'string' && !grant.readable.has(reference.entry)) {
          throw denied();
        }
      }
    }
    const recorded = { ...(grant.source === null ? {} : { source: grant.source }) };
    for (const key of RESULT_FIELDS) if (Object.hasOwn(result, key)) recorded[key] = result[key];
    const entry = await continuity.recordContinuity(recorded);
    grant.readable.add(entry.id);
    return entry;
  }

  return Object.freeze({
    /**
     * Concede a un solicitante la consulta de registros elegidos y, opcionalmente, el
     * registro de resultados nuevos. Conectar un agente no concede nada por sí solo.
     * @param {{ requester: object, ids?: string[], includeReferenced?: boolean, allowRecord?: boolean, source?: string | null }} request
     * @returns {Promise<object>} Permiso opaco, válido solo en esta instancia y para ese solicitante.
     */
    async grantContinuityAccess(request) {
      rejectUnknownFields(request, ['requester', 'ids', 'includeReferenced', 'allowRecord', 'source']);
      const { requester, ids = [], includeReferenced = false, allowRecord = false, source = null } = request;
      if (!requester || typeof requester !== 'object') {
        fail('INVALID_REQUESTER', 'El anfitrión debe proporcionar la identidad opaca del solicitante.');
      }
      if (!Array.isArray(ids) || typeof includeReferenced !== 'boolean' || typeof allowRecord !== 'boolean') {
        fail('INVALID_CONTINUITY_FIELD', 'ids es una lista; includeReferenced y allowRecord son booleanos.');
      }
      if (ids.length === 0 && !allowRecord) {
        fail('INVALID_CONTINUITY_FIELD', 'Selecciona registros concretos o concede el registro de resultados.');
      }
      if (source !== null && (typeof source !== 'string' || source.length === 0
          || source.length > CONTINUITY_LIMITS.labelLength || !source.isWellFormed() || /[\u0000-\u001f\u007f]/.test(source))) {
        fail('INVALID_CONTINUITY_FIELD', `source debe ser texto de 1 a ${CONTINUITY_LIMITS.labelLength} caracteres, sin controles.`);
      }
      const readable = new Set();
      const pending = [];
      const add = (entry) => {
        readable.add(entry.id);
        pending.push(entry);
        if (readable.size > CONTINUITY_LIMITS.exportEntries) {
          fail('CONTINUITY_TOO_LARGE', 'La selección supera el número de registros admitido.');
        }
      };
      for (const id of ids) {
        if (readable.has(id)) continue;
        const entry = await continuity.getContinuity(id);
        if (entry === null) fail('CONTINUITY_NOT_FOUND', 'No existe un registro de continuidad con ese identificador.');
        add(entry);
      }
      // Las referencias se resuelven ahora: relaciones añadidas después no amplían el acceso.
      while (includeReferenced && pending.length > 0) {
        for (const { entry: target } of pending.shift().references) {
          if (target === undefined || readable.has(target)) continue;
          const entry = await continuity.getContinuity(target);
          if (entry !== null) add(entry);
        }
      }
      const authorization = Object.freeze(Object.create(null));
      grants.set(authorization, { requester, readable, allowRecord, source, revoked: false });
      return authorization;
    },

    /** Lo que cubre un permiso, para mostrarlo al usuario. Solo anfitrión. */
    describeContinuityAccess(authorization) {
      const grant = grants.get(authorization);
      if (!grant) return null;
      return {
        ids: [...grant.readable].sort(), allowRecord: grant.allowRecord, source: grant.source, revoked: grant.revoked,
      };
    },

    /** Retira el permiso; las lecturas y registros posteriores se rechazan. */
    revokeContinuityAccess(authorization) {
      const grant = grants.get(authorization);
      if (!grant || grant.revoked) return false;
      grant.revoked = true;
      return true;
    },

    /**
     * @param {{ requester: object, authorization: object, format?: 'json' | 'markdown' | 'object' }} request
     * @returns {Promise<string | object>} Paquete `mind-continuity-export` con solo la selección.
     */
    readContinuityContext,

    /**
     * @param {{ requester: object, authorization: object, result: { content: unknown, kind?: string, references?: object[] } }} request
     */
    recordContinuityResult,

    /**
     * Vista que el anfitrión entrega al agente: solo sus dos operaciones, sin listar la Base
     * ni la API administrativa.
     */
    bindContinuityAgent({ requester, authorization } = {}) {
      grantFor(requester, authorization);
      return Object.freeze({
        readContext: ({ format } = {}) => readContinuityContext({
          requester, authorization, ...(format === undefined ? {} : { format }),
        }),
        recordResult: (result) => recordContinuityResult({ requester, authorization, result }),
      });
    },
  });
}
