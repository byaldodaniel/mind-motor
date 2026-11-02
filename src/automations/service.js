import { createHash } from 'node:crypto';
import { MotorError } from '../errors.js';
import { createFunctionRegistry, copyJson } from '../functions.js';
import { createFunctionRunner } from '../function-runner.js';
import { ACCESS_LEVELS, CONTINUITY_LEVELS } from '../access-policy.js';
import { untrustedText } from '../consent.js';
import { createExecutorCatalog } from '../executors/index.js';
import { isPlainObject, ORIGINS, FOLDER_ID } from '../executors/common.js';
import { normalizeActivation, isAutomatic, dueSlot, nextSlot, describeActivation } from './schedule.js';
import { createAutomationStore } from './store.js';

/**
 * Funciones y automatizaciones de la sesión del anfitrión (Función 04).
 *
 * - Las definiciones son datos JSON en la Base (src/functions.js). El código
 *   solo procede del catálogo de ejecutores de confianza (src/executors/).
 * - Ejecutar a mano usa los permisos vigentes del usuario por carpeta, que cada
 *   ejecutor comprueba al ejecutar.
 * - La activación automática exige el consentimiento explícito del usuario,
 *   ligado a la generación y la huella exactas de la definición y a la
 *   generación de cada carpeta implicada. Cualquier cambio lo hace caducar.
 * - Cada ejecución queda en la auditoría y en un historial acotado, sin contenido,
 *   bajo un bloqueo por función que excluye ejecuciones simultáneas entre procesos.
 */

const DEFINITION_KEYS = Object.freeze(['nombre', 'descripcion', 'ejecutor', 'parametros', 'activacion']);
const MAX_DEFINITION_BYTES = 128 * 1024;
const MAX_SUMMARY_BYTES = 2048;

/** Huella SHA-256 del contenido exacto de la definición (la misma fórmula que src/function-runner.js). */
export function definitionFingerprint(definition) {
  return createHash('sha256').update(JSON.stringify(definition)).digest('hex');
}

const iso = (ms) => new Date(ms).toISOString();
const definitionError = (message) => new MotorError('INVALID_FUNCTION_DEFINITION', message);
const busy = () => new MotorError('FUNCTION_BUSY', 'La función se está ejecutando ahora (en esta u otra sesión de Mind, o en el programador del sistema). Vuelve a intentarlo cuando termine.');

/** Error del ejecutor revisado por el anfitrión: solo código y mensaje propios, sin contenido. */
function failureOf(error) {
  if (error?.code === 'FUNCTION_FAILED' && error.cause instanceof MotorError) return error.cause;
  if (error?.code === 'FUNCTION_DEFINITION_REJECTED' && error.cause instanceof MotorError) return error.cause;
  if (error instanceof MotorError) return error;
  return new MotorError('FUNCTION_FAILED', 'El ejecutor no completó la función.');
}

function summaryOf(result) {
  try {
    return Buffer.byteLength(JSON.stringify(result), 'utf8') <= MAX_SUMMARY_BYTES ? result : { truncado: true };
  } catch {
    return null;
  }
}

/**
 * Validez de una autorización frente a la definición y las carpetas actuales.
 * @returns {Promise<{ valid: true } | { valid: false, reason: string }>}
 */
async function consentValidity(consent, version, getAuthorizedFolder) {
  if (!consent.enabled) return { valid: false, reason: 'desactivada' };
  if (!version) return { valid: false, reason: 'funcion-retirada' };
  if (version.generation !== consent.generation || definitionFingerprint(version.definition) !== consent.fingerprint) {
    return { valid: false, reason: 'definicion-cambiada' };
  }
  for (const [folderId, generation] of Object.entries(consent.folders)) {
    const folder = await getAuthorizedFolder(folderId).catch(() => null);
    if (!folder) return { valid: false, reason: 'carpeta-retirada' };
    if ((folder.generation ?? null) !== generation) return { valid: false, reason: 'carpeta-reautorizada' };
  }
  return { valid: true };
}

/**
 * Automatizaciones por horario vencidas y autorizadas. Solo lee la Base: la usa
 * `mind programadas` antes de abrir una sesión, para no tener efectos cuando no
 * hay nada que hacer.
 * @returns {Promise<{ id: string, slot: number }[]>}
 */
export async function findDueAutomations({ store, functions, getAuthorizedFolder, nowMs }) {
  const due = [];
  for (const id of await store.listConsentIds()) {
    try {
      const consent = await store.getConsent(id);
      if (!consent?.enabled) continue;
      const version = await functions.getFunctionVersion(id);
      if (!(await consentValidity(consent, version, getAuthorizedFolder)).valid) continue;
      const activation = normalizeActivation(version.definition.activacion);
      if (activation.tipo !== 'horario') continue;
      const state = await store.getState(id);
      const slot = dueSlot(activation, {
        grantedAtMs: Date.parse(consent.grantedAt),
        lastSlotMs: state?.lastSlot ? Date.parse(state.lastSlot) : null,
        nowMs,
      });
      if (slot !== null) due.push({ id, slot });
    } catch {
      // Un registro ilegible no impide las demás; queda visible en el estado.
    }
  }
  return due;
}

/** Requisitos declarados por el ejecutor, validados y unidos por carpeta. */
function normalizeRequirements(declared, activation) {
  const items = Array.isArray(declared?.carpetas) ? [...declared.carpetas] : [];
  if (activation.tipo === 'evento') {
    items.push({ id: activation.carpeta, permisos: ['encontrar'], uso: 'observa sus cambios para activar la función' });
  }
  const byId = new Map();
  for (const item of items) {
    if (!item || typeof item.id !== 'string' || !FOLDER_ID.test(item.id) || !Array.isArray(item.permisos)
        || !item.permisos.every((level) => ACCESS_LEVELS.includes(level))) {
      throw new MotorError('INVALID_EXECUTOR', 'El ejecutor declaró requisitos de carpeta no válidos.');
    }
    const known = byId.get(item.id);
    const use = typeof item.uso === 'string' ? item.uso : 'la usa';
    if (!known) byId.set(item.id, { id: item.id, permisos: [...new Set(item.permisos)], uso: use });
    else {
      known.permisos = [...new Set([...known.permisos, ...item.permisos])];
      known.uso = `${known.uso}; ${use}`;
    }
  }
  const continuity = Array.isArray(declared?.continuidad) ? declared.continuidad : [];
  if (!continuity.every((level) => CONTINUITY_LEVELS.includes(level))) {
    throw new MotorError('INVALID_EXECUTOR', 'El ejecutor declaró requisitos de continuidad no válidos.');
  }
  return { carpetas: [...byId.values()], continuidad: [...new Set(continuity)] };
}

export function describeMissing(missing) {
  return missing.map((item) => (item.continuidad
    ? `continuidad: ${item.continuidad.join(', ')}`
    : `${item.ruta ?? `carpeta ${item.carpeta.slice(0, 12)}… no autorizada`}: ${item.permisos.join(', ')}`)).join('; ');
}

const services = new WeakMap();

/** Servicio compartido por la sesión (herramienta de agente, programador en sesión y consola). */
export function functionServiceFor(session) {
  let service = services.get(session);
  if (!service) {
    service = createFunctionService(session);
    services.set(session, service);
  }
  return service;
}

/**
 * @param {object} session Sesión del anfitrión (src/session.js).
 * @param {{ now?: () => number, factories?: ReadonlyArray<Function> }} [options]
 *   now: reloj inyectable (pruebas); factories: fábricas de ejecutores (por omisión, el catálogo de Mind).
 */
export function createFunctionService(session, { now = Date.now, factories } = {}) {
  const { motor } = session;
  const log = typeof session.log === 'function' ? session.log : () => {};
  const functions = createFunctionRegistry({ baseDirectory: motor.baseDirectory });
  const catalog = createExecutorCatalog(session, factories);
  // El ejecutor de funciones valida y fija el catálogo (contrato de src/function-runner.js).
  const runner = createFunctionRunner({ functions, executors: catalog });
  // Metadatos del anfitrión, fijados también al crear el servicio.
  const meta = new Map(Object.entries(catalog).map(([name, executor]) => [name, Object.freeze({
    etiqueta: typeof executor.etiqueta === 'string' ? executor.etiqueta : name,
    descripcion: typeof executor.descripcion === 'string' ? executor.descripcion : '',
    parametros: isPlainObject(executor.parametros) ? copyJson(executor.parametros) : {},
    validarDefinicion: typeof executor.validarDefinicion === 'function' ? executor.validarDefinicion : null,
    acceptsDefinition: typeof executor.acceptsDefinition === 'function' ? executor.acceptsDefinition : null,
    requisitos: typeof executor.requisitos === 'function' ? executor.requisitos : null,
    describir: typeof executor.describir === 'function' ? executor.describir : null,
  })]));
  const store = createAutomationStore(motor.baseDirectory);
  const listeners = new Set();
  const getAuthorizedFolder = (id) => motor.getAuthorizedFolder(id);

  function notify() {
    for (const listener of listeners) {
      try {
        listener();
      } catch (error) {
        log('aviso', 'Fallo de un oyente de funciones', { error: String(error) });
      }
    }
  }

  function copyDefinition(definition) {
    let copy;
    try {
      copy = copyJson(definition);
    } catch {
      throw definitionError('La definición debe ser un objeto de datos JSON.');
    }
    if (!isPlainObject(copy)) throw definitionError('La definición debe ser un objeto de datos JSON.');
    if (Buffer.byteLength(JSON.stringify(copy), 'utf8') > MAX_DEFINITION_BYTES) {
      throw definitionError(`La definición supera ${MAX_DEFINITION_BYTES / 1024} KiB.`);
    }
    return copy;
  }

  /** Validación del anfitrión con mensajes claros; no ejecuta nada. */
  function checkDefinition(definition) {
    if (!isPlainObject(definition)) throw definitionError('La definición debe ser un objeto JSON.');
    for (const key of Object.keys(definition)) {
      if (!DEFINITION_KEYS.includes(key)) throw definitionError(`Campo desconocido en la definición: ${key.slice(0, 40)}. Admitidos: ${DEFINITION_KEYS.join(', ')}.`);
    }
    if (definition.nombre !== undefined && (typeof definition.nombre !== 'string' || definition.nombre === '' || definition.nombre.length > 120)) {
      throw definitionError('nombre debe ser texto de 1 a 120 caracteres.');
    }
    if (definition.descripcion !== undefined && (typeof definition.descripcion !== 'string' || definition.descripcion.length > 2000)) {
      throw definitionError('descripcion debe ser texto de hasta 2000 caracteres.');
    }
    const executor = typeof definition.ejecutor === 'string' ? meta.get(definition.ejecutor) : undefined;
    if (!executor) {
      throw new MotorError('EXECUTOR_NOT_FOUND', `ejecutor debe ser uno del catálogo de Mind: ${[...meta.keys()].join(', ')}.`);
    }
    const activation = normalizeActivation(definition.activacion);
    if (executor.validarDefinicion) executor.validarDefinicion(definition);
    else if (executor.acceptsDefinition && executor.acceptsDefinition(definition) !== true) {
      throw definitionError('El ejecutor no admite estos parámetros.');
    }
    return { executor: definition.ejecutor, activation, meta: executor };
  }

  /** Lectura conjunta de definición, identidad y validación. */
  async function inspect(id) {
    const version = await functions.getFunctionVersion(id);
    if (!version) throw new MotorError('FUNCTION_NOT_FOUND', 'No existe una función con ese identificador.');
    let checked = null;
    let problem = null;
    try {
      checked = checkDefinition(version.definition);
    } catch (error) {
      problem = error instanceof MotorError ? error : definitionError('La definición no es válida.');
    }
    return {
      id, definition: version.definition, generation: version.generation,
      fingerprint: definitionFingerprint(version.definition), checked, problem,
    };
  }

  function requirementsOf(info) {
    const declared = info.checked.meta.requisitos ? info.checked.meta.requisitos(info.definition) : null;
    return normalizeRequirements(declared, info.checked.activation);
  }

  async function missingPermissions(requirements) {
    const missing = [];
    for (const item of requirements.carpetas) {
      const folder = await motor.getAuthorizedFolder(item.id);
      if (!folder) {
        missing.push({ carpeta: item.id, ruta: null, permisos: item.permisos });
        continue;
      }
      const decision = await session.policy.get(item.id);
      const lacking = item.permisos.filter((level) => !decision?.access[level]);
      if (lacking.length > 0) missing.push({ carpeta: item.id, ruta: folder.path, permisos: lacking });
    }
    if (requirements.continuidad.length > 0) {
      const decision = await session.policy.getContinuity();
      const lacking = requirements.continuidad.filter((level) => !decision[level]);
      if (lacking.length > 0) missing.push({ continuidad: lacking });
    }
    return missing;
  }

  /** Texto que Mind construye para el consentimiento; lo aportado por el agente va entre comillas. */
  async function consentLines(info, requirements) {
    const { definition, checked } = info;
    const name = typeof definition.nombre === 'string' ? untrustedText(definition.nombre, 120) : '';
    const lines = [
      `Función «${info.id}»${name ? `: «${name}» (nombre indicado por el agente, no verificado)` : ''}.`,
      `Acción: ${checked.meta.etiqueta} (ejecutor de Mind «${checked.executor}»).`,
    ];
    const eventFolder = checked.activation.tipo === 'evento' ? await motor.getAuthorizedFolder(checked.activation.carpeta) : null;
    lines.push(`Cuándo: ${describeActivation(checked.activation, { folderPath: eventFolder?.path ?? null })}.`);
    for (const item of requirements.carpetas) {
      const folder = await motor.getAuthorizedFolder(item.id);
      lines.push(`Carpeta ${folder ? folder.path : `${item.id.slice(0, 12)}… (no autorizada)`}: ${item.uso}. Permisos que usa: ${item.permisos.join(', ')}.`);
    }
    if (requirements.continuidad.length > 0) {
      lines.push(`Continuidad de Mind: ${requirements.continuidad.join(', ')} los registros de decisiones, resultados y contexto.`);
    }
    for (const line of checked.meta.describir?.(definition) ?? []) lines.push(String(line));
    return lines;
  }

  /** Todo lo necesario para pedir (o revisar) la autorización de una automatización. */
  async function prepareActivation(id) {
    const info = await inspect(id);
    if (info.problem) throw info.problem;
    if (info.generation === null) {
      throw new MotorError('FUNCTION_GENERATION_REQUIRED', 'Actualiza la definición heredada antes de activarla.');
    }
    if (!isAutomatic(info.checked.activation)) {
      throw new MotorError('INVALID_ACTIVATION', 'La definición no tiene activación automática (horario o evento); se ejecuta a mano con "ejecutar".');
    }
    const requirements = requirementsOf(info);
    return { ...info, requirements, missing: await missingPermissions(requirements), lines: await consentLines(info, requirements) };
  }

  /** Estado de la automatización de una versión ya leída. */
  async function statusOf(id, version, { nowMs, pending = [] }) {
    const fingerprint = definitionFingerprint(version.definition);
    let checked = null;
    let problem = null;
    try {
      checked = checkDefinition(version.definition);
    } catch (error) {
      problem = error instanceof MotorError ? error : definitionError('La definición no es válida.');
    }
    const item = {
      id, definition: version.definition, generation: version.generation, fingerprint,
      executor: checked?.executor ?? null, activation: checked?.activation ?? null, problem,
      consent: null, state: null, estado: null, motivo: null, due: null, next: null,
    };
    try {
      item.consent = await store.getConsent(id);
      item.state = await store.getState(id);
    } catch (error) {
      return { ...item, estado: 'no-valida', motivo: error.code ?? 'AUTOMATION_CORRUPT' };
    }
    if (problem) return { ...item, estado: 'no-valida', motivo: problem.code };
    if (!isAutomatic(checked.activation)) return { ...item, estado: 'manual' };
    const requested = pending.some((request) => request.automation?.functionId === id
      && request.automation.generation === version.generation && request.automation.fingerprint === fingerprint);
    if (!item.consent) return { ...item, estado: requested ? 'pendiente' : 'sin-autorizar' };
    const validity = await consentValidity(item.consent, version, getAuthorizedFolder);
    if (!validity.valid) {
      if (validity.reason === 'desactivada') return { ...item, estado: 'desactivada' };
      return { ...item, estado: requested ? 'pendiente' : 'caducada', motivo: validity.reason };
    }
    if (checked.activation.tipo === 'horario') {
      const grantedAtMs = Date.parse(item.consent.grantedAt);
      const lastSlotMs = item.state?.lastSlot ? Date.parse(item.state.lastSlot) : null;
      item.due = dueSlot(checked.activation, { grantedAtMs, lastSlotMs, nowMs });
      item.next = nextSlot(checked.activation, grantedAtMs, nowMs);
    }
    return { ...item, estado: 'activa' };
  }

  async function pendingRequests() {
    return (await session.requests.list()).filter((request) => request.kind === 'automatizacion');
  }

  async function status(id, { nowMs = now(), includePending = true } = {}) {
    const version = await functions.getFunctionVersion(id);
    if (!version) throw new MotorError('FUNCTION_NOT_FOUND', 'No existe una función con ese identificador.');
    return statusOf(id, version, { nowMs, pending: includePending ? await pendingRequests() : [] });
  }

  async function execute(id, { origin, slot = null, changes = null, client = null, automatic = false } = {}) {
    if (!ORIGINS.includes(origin)) throw new MotorError('INVALID_ARGUMENTS', 'Origen de ejecución desconocido.');
    const lock = await store.tryLock(id);
    if (!lock) {
      if (!automatic) throw busy();
      return { estado: 'omitida', motivo: 'ocupada' };
    }
    try {
      let consent = null;
      let state = null;
      if (automatic) {
        // Bajo el bloqueo: autorización vigente y turno aún no ejecutado por otro proceso.
        consent = await store.getConsent(id);
        const version = await functions.getFunctionVersion(id);
        const validity = consent ? await consentValidity(consent, version, getAuthorizedFolder) : { valid: false, reason: 'sin-autorizacion' };
        if (!validity.valid) return { estado: 'omitida', motivo: validity.reason };
        const activation = normalizeActivation(version.definition.activacion);
        if ((slot !== null) !== (activation.tipo === 'horario') || (origin === 'evento') !== (activation.tipo === 'evento')) {
          return { estado: 'omitida', motivo: 'activacion-distinta' };
        }
        state = await store.getState(id);
        if (slot !== null && state?.lastSlot && Date.parse(state.lastSlot) >= slot) return { estado: 'omitida', motivo: 'ya-ejecutada' };
      }
      const startedAt = now();
      let executor = null;
      let binding = null;
      let outcome;
      try {
        const version = await functions.getFunctionVersion(id);
        if (!version) throw new MotorError('FUNCTION_NOT_FOUND', 'No existe una función con ese identificador.');
        executor = checkDefinition(version.definition).executor;
        binding = await runner.bindFunction({ functionId: id, executor });
        if (automatic) {
          // El vínculo debe corresponder exactamente a la versión que autorizó el usuario.
          const bound = await functions.getFunctionVersion(id);
          if (!bound || bound.generation !== consent.generation || definitionFingerprint(bound.definition) !== consent.fingerprint) {
            return { estado: 'omitida', motivo: 'definicion-cambiada' };
          }
        }
        const input = { funcion: id, origen: origin, fecha: iso(slot ?? startedAt), ...(changes ? { cambios: changes } : {}) };
        const { result } = await runner.runFunction({ binding, input });
        outcome = { estado: 'completada', resultado: result };
      } catch (error) {
        const failure = failureOf(error);
        outcome = { estado: 'fallida', codigo: failure.code, mensaje: failure.message };
      } finally {
        if (binding) runner.unbindFunction(binding);
      }
      const finishedAt = now();
      const duration = Math.max(0, finishedAt - startedAt);
      const entry = {
        fecha: iso(startedAt), origen: origin, ejecutor: executor, estado: outcome.estado,
        codigo: outcome.codigo ?? null, duracion_ms: duration,
        ...(slot !== null ? { programada: iso(slot) } : {}),
        ...(changes ? { cambios: changes.total } : {}),
        ...(outcome.estado === 'completada' ? { resumen: summaryOf(outcome.resultado) } : {}),
        ...(client ? { cliente: client } : {}),
      };
      await store.appendHistory(id, entry).catch((error) => log('aviso', 'No se pudo anotar el historial de la función', { funcion: id, codigo: error?.code }));
      if (automatic) {
        await store.saveState(id, {
          lastSlot: slot !== null ? iso(slot) : state?.lastSlot ?? null, lastRunAt: iso(finishedAt),
          lastStatus: outcome.estado, lastCode: outcome.codigo ?? null,
        });
      }
      await session.audit('funcion-ejecutada', {
        funcion: id, ejecutor: executor, origen: origin, estado: outcome.estado, codigo: outcome.codigo ?? null,
        duracion_ms: duration, ...(slot !== null ? { programada: iso(slot) } : {}), ...(client ? { cliente: client } : {}),
      }).catch((error) => log('aviso', 'No se pudo anotar la auditoría', { error: String(error) }));
      return { ...outcome, funcion: id, ejecutor: executor, duracion_ms: duration };
    } finally {
      await lock.release();
    }
  }

  return Object.freeze({
    store,

    /** Catálogo para el agente: nombre, etiqueta, descripción y parámetros. */
    executors() {
      return [...meta.entries()].map(([nombre, item]) => ({
        nombre, etiqueta: item.etiqueta, descripcion: item.descripcion, parametros: item.parametros,
      }));
    },

    /** Avisos de cambios (el programador en sesión se reprograma). */
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async create(id, definition) {
      const copy = copyDefinition(definition);
      checkDefinition(copy);
      const created = await functions.createFunction(id, copy);
      notify();
      return created;
    },

    /** Sustituye la definición; una autorización anterior caduca por la nueva generación. */
    async update(id, definition) {
      const copy = copyDefinition(definition);
      checkDefinition(copy);
      const previous = await store.getConsent(id).catch(() => null);
      const updated = await functions.updateFunction(id, copy);
      notify();
      return { ...updated, authorizationExpired: previous?.enabled === true };
    },

    /** Retira la definición con su autorización, marca, historial y solicitudes pendientes. */
    async retire(id) {
      const lock = await store.tryLock(id);
      if (!lock) throw busy();
      try {
        const retired = await functions.retireFunction(id);
        await store.removeAll(id);
        for (const request of await pendingRequests()) {
          if (request.automation?.functionId === id) await session.requests.remove(request.id).catch(() => {});
        }
        notify();
        return retired;
      } finally {
        await lock.release();
      }
    },

    inspect,
    prepareActivation,

    /** Estado de una función: definición, automatización y próximo turno. */
    status,

    async overview({ nowMs = now(), includePending = true } = {}) {
      const pending = includePending ? await pendingRequests() : [];
      const result = [];
      for (const { id } of await functions.listFunctions()) {
        const version = await functions.getFunctionVersion(id);
        if (version) result.push(await statusOf(id, version, { nowMs, pending }));
      }
      return result;
    },

    /** Solo las funciones con autorización registrada (lo que vigila el programador). */
    async authorized({ nowMs = now() } = {}) {
      const result = [];
      for (const id of await store.listConsentIds()) {
        try {
          const version = await functions.getFunctionVersion(id);
          if (version) result.push(await statusOf(id, version, { nowMs }));
        } catch (error) {
          log('aviso', 'No se pudo evaluar una automatización', { funcion: id, codigo: error?.code });
        }
      }
      return result;
    },

    /**
     * Guarda la decisión del usuario, solo si la definición sigue siendo la
     * versión exacta que se le mostró y los permisos necesarios están concedidos.
     */
    async authorize(id, { generation, fingerprint, channel, client = null }) {
      const prepared = await prepareActivation(id);
      if (prepared.generation !== generation || prepared.fingerprint !== fingerprint) {
        throw new MotorError('AUTOMATION_CHANGED', 'La definición cambió desde que se pidió la autorización; hay que solicitarla de nuevo.');
      }
      if (prepared.missing.length > 0) {
        throw new MotorError('ACCESS_NOT_GRANTED', `Faltan permisos para esta automatización: ${describeMissing(prepared.missing)}.`);
      }
      const folders = {};
      for (const item of prepared.requirements.carpetas) {
        const folder = await motor.getAuthorizedFolder(item.id);
        if (!folder) throw new MotorError('FOLDER_NOT_AUTHORIZED', 'Una carpeta de la automatización ya no está autorizada.');
        folders[item.id] = folder.generation ?? null;
      }
      await store.saveConsent({
        functionId: id, generation, fingerprint, executor: prepared.checked.executor, folders,
        grantedAt: iso(now()), channel, client, enabled: true, disabledAt: null,
      });
      // Nueva referencia temporal: lo anterior a esta autorización no se ejecuta.
      await store.removeState(id);
      await session.audit('automatizacion-autorizada', {
        funcion: id, ejecutor: prepared.checked.executor, activacion: describeActivation(prepared.checked.activation),
        canal: channel, ...(client ? { cliente: client } : {}),
      });
      notify();
      return status(id);
    },

    async deactivate(id, { channel = 'administracion-local', client = null } = {}) {
      const consent = await store.getConsent(id);
      if (!consent) return { estado: 'sin-autorizacion' };
      if (!consent.enabled) return { estado: 'desactivada', cambio: false };
      await store.saveConsent({ ...consent, enabled: false, disabledAt: iso(now()) });
      await session.audit('automatizacion-desactivada', { funcion: id, canal: channel, ...(client ? { cliente: client } : {}) });
      notify();
      return { estado: 'desactivada', cambio: true };
    },

    execute,

    async history(id = null, limit = 20) {
      if (id !== null) return (await store.readHistory(id)).slice(-limit).reverse().map((entry) => ({ funcion: id, ...entry }));
      const all = [];
      for (const functionId of await store.listHistoryIds()) {
        const entries = await store.readHistory(functionId).catch(() => []);
        all.push(...entries.map((entry) => ({ funcion: functionId, ...entry })));
      }
      return all.sort((a, b) => (a.fecha < b.fecha ? 1 : a.fecha > b.fecha ? -1 : 0)).slice(0, limit);
    },

    due: ({ nowMs = now() } = {}) => findDueAutomations({ store, functions, getAuthorizedFolder, nowMs }),

    /** Ejecuta, una vez cada una, las automatizaciones por horario vencidas y autorizadas. */
    async runDue({ origin = 'programada', nowMs = now() } = {}) {
      const results = [];
      for (const { id, slot } of await findDueAutomations({ store, functions, getAuthorizedFolder, nowMs })) {
        const outcome = await execute(id, { origin, slot, automatic: true })
          .catch((error) => ({ estado: 'fallida', codigo: error?.code ?? 'ERROR_INTERNO' }));
        results.push({ ...outcome, funcion: id, programada: iso(slot) });
      }
      return results;
    },
  });
}

/**
 * Revisión de una solicitud pendiente de tipo "automatizacion" en `mind autorizar`.
 * Recalcula la descripción a partir de la definición actual y solo autoriza si
 * sigue siendo exactamente la versión solicitada.
 * @returns {Promise<{ approved: boolean, keep: boolean }>} keep: conservar la solicitud.
 */
export async function reviewAutomationRequest({ session, prompt, request }) {
  const service = functionServiceFor(session);
  const { functionId, generation, fingerprint } = request.automation;
  let prepared;
  try {
    prepared = await service.prepareActivation(functionId);
  } catch (error) {
    prompt.write(`No se puede activar la función «${untrustedText(functionId, 64)}»: ${error instanceof MotorError ? error.message : 'error inesperado'}`);
    return { approved: false, keep: false };
  }
  if (prepared.generation !== generation || prepared.fingerprint !== fingerprint) {
    prompt.write('La definición cambió después de la solicitud: esta autorización ya no corresponde. Pide al agente que la solicite de nuevo.');
    return { approved: false, keep: false };
  }
  prompt.write('Activar una automatización (se ejecutará sin que lo pidas cada vez):');
  for (const line of prepared.lines) prompt.write(`  ${line}`);
  if (prepared.missing.length > 0) {
    prompt.write(`Todavía no se puede activar: faltan permisos (${describeMissing(prepared.missing)}). Concédelos y vuelve a ejecutar "mind autorizar"; la solicitud se conserva.`);
    return { approved: false, keep: true };
  }
  prompt.write('Usará los permisos que ya concediste en cada carpeta. Si la definición cambia, esta autorización caduca.');
  if (!(await prompt.yes('¿Activar esta automatización?', false))) {
    prompt.write('Rechazada.');
    return { approved: false, keep: false };
  }
  await service.authorize(functionId, { generation, fingerprint, channel: 'consola', client: request.client || null });
  prompt.write('Automatización activada. Fuera de las sesiones de Mind solo se ejecuta si el programador del sistema está instalado ("mind programador instalar").');
  return { approved: true, keep: false };
}
