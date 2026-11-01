import { createHash } from 'node:crypto';
import { MotorError } from './errors.js';
import { copyJson } from './functions.js';

const VALID_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const CAPABILITY_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
export const MAX_INPUT_BYTES = 64 * 1024;
export const MAX_RESULT_BYTES = 64 * 1024;
export const MAX_TIMEOUT_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const NO_CAPABILITIES = Object.freeze(Object.create(null));

const invalidExecutor = () => new MotorError('INVALID_EXECUTOR', 'El catálogo de ejecutores de confianza no tiene el formato esperado.');
const notBound = () => new MotorError('FUNCTION_NOT_BOUND', 'No existe un vínculo vigente entre esta función y un ejecutor de confianza.');
const invalidInput = () => new MotorError('INVALID_FUNCTION_INPUT', 'La entrada no es válida para este ejecutor.');

function validName(name) {
  return typeof name === 'string' && VALID_NAME.exec(name)?.[0] === name;
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

/** Copia JSON y tamaño serializado; null si el valor no es un dato JSON. */
function measure(value) {
  try {
    const copy = copyJson(value);
    return { copy, bytes: Buffer.byteLength(JSON.stringify(copy), 'utf8') };
  } catch {
    return null;
  }
}

// La huella liga el vínculo al contenido exacto aprobado, no solo al id.
function fingerprint(definition) {
  return createHash('sha256').update(JSON.stringify(definition)).digest('hex');
}

function trustedCatalog(executors) {
  if (!executors || typeof executors !== 'object' || Array.isArray(executors)) throw invalidExecutor();
  const catalog = new Map();
  for (const [name, executor] of Object.entries(executors)) {
    if (!validName(name) || !executor || typeof executor !== 'object'
        || typeof executor.run !== 'function' || typeof executor.validateInput !== 'function'
        || (executor.acceptsDefinition !== undefined && typeof executor.acceptsDefinition !== 'function')) {
      throw invalidExecutor();
    }
    const { timeoutMs = DEFAULT_TIMEOUT_MS, maxResultBytes = MAX_RESULT_BYTES, capabilities = [] } = executor;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS
        || !Number.isInteger(maxResultBytes) || maxResultBytes < 1 || maxResultBytes > MAX_RESULT_BYTES
        || !Array.isArray(capabilities)
        || !capabilities.every((name) => typeof name === 'string' && CAPABILITY_NAME.test(name))) {
      throw invalidExecutor();
    }
    // Se fijan las referencias: cambiar después el objeto del anfitrión no altera el catálogo.
    catalog.set(name, Object.freeze({
      run: executor.run,
      validateInput: executor.validateInput,
      acceptsDefinition: executor.acceptsDefinition,
      timeoutMs,
      maxResultBytes,
      capabilities: new Set(capabilities),
    }));
  }
  return catalog;
}

function grantCapabilities(entry, capabilities) {
  if (capabilities === undefined) return NO_CAPABILITIES;
  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) {
    throw new MotorError('INVALID_CAPABILITIES', 'Las capacidades deben ser un objeto proporcionado por el anfitrión.');
  }
  const granted = Object.create(null);
  for (const [name, value] of Object.entries(capabilities)) {
    if (!entry.capabilities.has(name)) {
      throw new MotorError('INVALID_CAPABILITIES', 'El ejecutor no declaró una de las capacidades proporcionadas.');
    }
    granted[name] = value;
  }
  return Object.freeze(granted);
}

/**
 * Módulo interno del anfitrión: ejecución manual de definiciones registradas
 * mediante ejecutores de confianza. Nunca interpreta el contenido de la Base
 * como código; la definición llega al ejecutor solo como datos congelados.
 * @param {{ functions: ReturnType<import('./functions.js').createFunctionRegistry>, executors: object }} options
 */
export function createFunctionRunner({ functions, executors } = {}) {
  if (!functions || typeof functions.getFunction !== 'function') {
    throw new MotorError('INVALID_FUNCTION_REGISTRY', 'Se requiere el registro de funciones de una Base abierta por el Motor.');
  }
  const catalog = trustedCatalog(executors);
  const bindings = new WeakMap();

  return Object.freeze({
    /** Solo anfitrión: aprueba la definición actual con un ejecutor del catálogo. */
    async bindFunction({ functionId, executor } = {}) {
      const entry = validName(executor) ? catalog.get(executor) : undefined;
      if (!entry) throw new MotorError('EXECUTOR_NOT_FOUND', 'El ejecutor no forma parte del catálogo de confianza.');
      const record = await functions.getFunction(functionId);
      if (!record) throw new MotorError('FUNCTION_NOT_FOUND', 'No existe una definición con ese identificador.');
      if (entry.acceptsDefinition) {
        let accepted;
        try {
          accepted = entry.acceptsDefinition(deepFreeze(record.definition));
        } catch (cause) {
          throw new MotorError('FUNCTION_DEFINITION_REJECTED', 'El ejecutor rechazó la definición.', { cause });
        }
        if (accepted !== true) throw new MotorError('FUNCTION_DEFINITION_REJECTED', 'El ejecutor rechazó la definición.');
      }
      const binding = Object.freeze(Object.create(null));
      bindings.set(binding, {
        functionId, executor, fingerprint: fingerprint(record.definition), revoked: false,
      });
      return binding;
    },

    unbindFunction(binding) {
      const bound = bindings.get(binding);
      if (!bound || bound.revoked) return false;
      bound.revoked = true;
      return true;
    },

    /** Solo anfitrión: una invocación manual explícita sobre un vínculo vigente. */
    async runFunction({ binding, input = null, capabilities } = {}) {
      const bound = bindings.get(binding);
      if (!bound || bound.revoked) throw notBound();
      const entry = catalog.get(bound.executor);
      const measured = measure(input);
      if (!measured || measured.bytes > MAX_INPUT_BYTES) throw invalidInput();
      const granted = grantCapabilities(entry, capabilities);

      const record = await functions.getFunction(bound.functionId);
      if (bound.revoked) throw notBound();
      if (!record) {
        bound.revoked = true;
        throw new MotorError('FUNCTION_NOT_FOUND', 'La definición vinculada fue retirada.');
      }
      if (fingerprint(record.definition) !== bound.fingerprint) {
        bound.revoked = true;
        throw new MotorError('FUNCTION_CHANGED', 'La definición cambió después de vincularla; se requiere un nuevo vínculo.');
      }
      const definition = deepFreeze(record.definition);
      const data = deepFreeze(measured.copy);
      let valid;
      try {
        valid = entry.validateInput(data, definition);
      } catch (cause) {
        throw new MotorError('INVALID_FUNCTION_INPUT', 'La entrada no es válida para este ejecutor.', { cause });
      }
      if (valid !== true) throw invalidInput();

      // El ejecutor corre en este proceso: el límite rechaza y avisa por signal,
      // pero no puede interrumpir código síncrono.
      const controller = new AbortController();
      const expired = new MotorError('FUNCTION_TIMEOUT', 'La ejecución excedió el tiempo permitido.');
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(expired);
        }, entry.timeoutMs);
      });
      let value;
      try {
        value = await Promise.race([
          Promise.resolve().then(() => entry.run({
            input: data, definition, capabilities: granted, signal: controller.signal,
          })),
          timeout,
        ]);
      } catch (cause) {
        if (cause === expired) throw cause;
        throw new MotorError('FUNCTION_FAILED', 'El ejecutor no completó la función.', { cause });
      } finally {
        clearTimeout(timer);
      }

      const result = measure(value);
      if (!result) throw new MotorError('FUNCTION_RESULT_INVALID', 'El resultado no es un dato JSON válido.');
      if (result.bytes > entry.maxResultBytes) {
        throw new MotorError('FUNCTION_RESULT_TOO_LARGE', 'El resultado supera el límite del ejecutor.');
      }
      return { functionId: bound.functionId, executor: bound.executor, result: result.copy };
    },
  });
}
