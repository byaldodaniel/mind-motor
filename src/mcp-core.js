import { AsyncLocalStorage } from 'node:async_hooks';
import { MotorError } from './errors.js';

/**
 * Núcleo del protocolo MCP independiente del transporte (JSON-RPC 2.0):
 * initialize, ping, tools/list, tools/call, cancelaciones y peticiones del
 * servidor al cliente (elicitation/create, roots/list).
 *
 * El contenido de las peticiones del cliente son datos: nunca se evalúan ni
 * conceden permisos por sí mismos.
 */

export const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);
export const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
export const SERVER_REQUEST_TIMEOUT_MS = 10 * 60_000;

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

export function rpcError(code, message, data) {
  return Object.assign(new Error(message), { rpcCode: code, rpcData: data });
}

export function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Resultado de herramienta para el agente: texto legible y datos estructurados. */
export function toolResult(value) {
  if (value && Object.hasOwn(value, '__mcpText')) {
    const { __mcpText: text, ...structured } = value;
    return { content: [{ type: 'text', text }], structuredContent: structured };
  }
  const structured = isObject(value) ? value : { valor: value };
  return { content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }], structuredContent: structured };
}

/** Error de herramienta: el agente lo recibe como resultado con isError, no como fallo del protocolo. */
export function toolError(error) {
  const known = error instanceof MotorError;
  const structured = {
    error: {
      codigo: known ? error.code : 'ERROR_INTERNO',
      mensaje: known ? error.message : 'Mind no pudo completar la operación.',
      ...(known && error.details ? { detalles: error.details } : {}),
    },
  };
  return { content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }], structuredContent: structured, isError: true };
}

export function formatReply(id, result) {
  return { jsonrpc: '2.0', id, result };
}

export function formatError(id, error) {
  const code = error?.rpcCode ?? INTERNAL_ERROR;
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message: error?.rpcCode ? error.message : 'Error interno de Mind.',
      ...(error?.rpcData ? { data: error.rpcData } : {}),
    },
  };
}

/**
 * Crea un procesador de mensajes MCP reutilizable por stdio o HTTP Streamable.
 * `send(message, route)` solo se invoca para peticiones y notificaciones iniciadas
 * por el servidor hacia el cliente; las respuestas JSON-RPC a peticiones entrantes
 * las devuelve `dispatchOne(message, { route })`.
 */
export function createMcpProcessor({
  serverInfo,
  instructions,
  tools,
  onInitialized,
  onRootsChanged,
  onClose,
  send = () => {},
  log = () => {},
} = {}) {
  const pending = new Map();
  const running = new Map();
  const routeContext = new AsyncLocalStorage();
  // Señal de la `tools/call` en curso: cancelarla cancela también lo que esa
  // herramienta esté esperando del cliente (un formulario de confirmación).
  const callSignal = new AsyncLocalStorage();
  let nextId = 1;
  let closed = false;
  let closing = null;
  let toolset = null;
  let initialization = Promise.resolve();
  let retrying = null;

  /**
   * Un fallo de inicio (por ejemplo, una coordinación ocupada) no debe inutilizar
   * la conversación: cada llamada posterior reintenta el inicio, compartiendo un
   * único reintento entre llamadas simultáneas. Si vuelve a fallar se propaga el
   * motivo real para que el agente pueda explicarlo.
   */
  async function ensureInitialized() {
    try {
      await initialization;
      return;
    } catch {
      // Reintentar a continuación.
    }
    if (!retrying) {
      const attempt = Promise.resolve().then(() => onInitialized?.(connection));
      retrying = attempt;
      attempt.then(() => { initialization = attempt; }, () => {}).finally(() => { if (retrying === attempt) retrying = null; });
    }
    await retrying;
  }

  const connection = {
    protocolVersion: null,
    clientInfo: null,
    clientCapabilities: {},
    initialized: false,
    /** El cliente declaró soporte de formularios de elicitación (consentimiento mostrado por el cliente). */
    supportsFormElicitation() {
      const elicitation = this.clientCapabilities?.elicitation;
      if (!isObject(elicitation)) return false;
      // En 2025-06-18 la capacidad vacía implica formularios; desde 2025-11-25 se declaran modos.
      return Object.keys(elicitation).length === 0 || isObject(elicitation.form);
    },
    /** Petición del servidor al cliente; resuelve con el resultado o rechaza con el error del cliente. */
    request(method, params, { timeoutMs = SERVER_REQUEST_TIMEOUT_MS, signal = callSignal.getStore() } = {}) {
      if (closed) return Promise.reject(new MotorError('SESSION_CLOSED', 'La sesión con el agente terminó.'));
      if (signal?.aborted) return Promise.reject(new MotorError('REQUEST_CANCELLED', 'La solicitud se canceló.'));
      const id = `mind-${nextId++}`;
      const route = routeContext.getStore();
      return new Promise((resolve, reject) => {
        const finish = (callback, value) => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          pending.delete(id);
          callback(value);
        };
        const abort = () => finish(reject, new MotorError('REQUEST_CANCELLED', 'La solicitud se canceló.'));
        const timer = setTimeout(() => finish(reject, new MotorError('CLIENT_TIMEOUT', 'El cliente no respondió a tiempo.')), timeoutMs);
        timer.unref?.();
        signal?.addEventListener('abort', abort, { once: true });
        pending.set(id, {
          resolve: (value) => finish(resolve, value),
          reject: (error) => finish(reject, error),
        });
        send({ jsonrpc: '2.0', id, method, params }, route);
      });
    },
    notify(method, params) {
      if (!closed) {
        const route = routeContext.getStore();
        send({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }, route);
      }
    },
  };

  function negotiate(requested) {
    return SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0];
  }

  async function handleRequest(message) {
    const { id, method, params = {} } = message;
    if (!isObject(params)) throw rpcError(INVALID_PARAMS, 'params debe ser un objeto.');
    switch (method) {
      case 'initialize': {
        connection.protocolVersion = negotiate(params.protocolVersion);
        connection.clientInfo = isObject(params.clientInfo) ? params.clientInfo : null;
        connection.clientCapabilities = isObject(params.capabilities) ? params.capabilities : {};
        toolset = tools(connection);
        return {
          protocolVersion: connection.protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo,
          ...(instructions ? { instructions } : {}),
        };
      }
      case 'ping':
        return {};
      case 'tools/list':
        if (!toolset) throw rpcError(INVALID_REQUEST, 'La sesión no se inicializó.');
        return { tools: toolset.definitions };
      case 'tools/call': {
        if (!toolset) throw rpcError(INVALID_REQUEST, 'La sesión no se inicializó.');
        const { name, arguments: args = {} } = params;
        if (typeof name !== 'string' || !toolset.definitions.some((tool) => tool.name === name)) {
          throw rpcError(INVALID_PARAMS, `Herramienta desconocida: ${String(name).slice(0, 64)}.`);
        }
        if (!isObject(args)) throw rpcError(INVALID_PARAMS, 'arguments debe ser un objeto.');
        const controller = new AbortController();
        running.set(id, controller);
        try {
          try {
            await ensureInitialized();
          } catch (error) {
            log('error', 'Mind no pudo iniciar la sesión', { tool: name, codigo: error?.code ?? null, error: String(error?.stack ?? error) });
            return toolError(error);
          }
          if (controller.signal.aborted) {
            return toolError(new MotorError('REQUEST_CANCELLED', 'La solicitud se canceló.'));
          }
          return toolResult(await callSignal.run(controller.signal, () => toolset.call(name, args, { signal: controller.signal, connection })));
        } catch (error) {
          if (!(error instanceof MotorError)) log('error', 'Fallo inesperado en una herramienta', { tool: name, error: String(error?.stack ?? error) });
          return toolError(error);
        } finally {
          running.delete(id);
        }
      }
      default:
        throw rpcError(METHOD_NOT_FOUND, `Método no admitido: ${String(method).slice(0, 64)}.`);
    }
  }

  async function handleNotification(message) {
    switch (message.method) {
      case 'notifications/initialized':
        if (connection.initialized) return;
        connection.initialized = true;
        initialization = Promise.resolve(onInitialized?.(connection));
        await initialization;
        return;
      case 'notifications/roots/list_changed':
        if (connection.initialized) await onRootsChanged?.(connection);
        return;
      case 'notifications/cancelled': {
        const target = message.params?.requestId;
        running.get(target)?.abort();
        return;
      }
      default:
        // Las notificaciones desconocidas se ignoran, como indica el protocolo.
    }
  }

  function handleResponse(message) {
    const waiting = pending.get(message.id);
    if (!waiting) return;
    if (Object.hasOwn(message, 'error')) {
      waiting.reject(new MotorError('CLIENT_ERROR', 'El cliente rechazó la solicitud.', { cause: message.error }));
    } else {
      waiting.resolve(message.result);
    }
  }

  /**
   * Procesa un mensaje JSON-RPC individual. Devuelve la respuesta JSON-RPC si el
   * mensaje era una petición (o un error de validación), o `null` para notificaciones
   * y respuestas a peticiones del servidor.
   */
  async function dispatchOne(message, { route } = {}) {
    if (closed) {
      const hasId = isObject(message) && Object.hasOwn(message, 'id') && (typeof message.id === 'string' || Number.isInteger(message.id));
      return hasId ? formatError(message.id, new MotorError('SESSION_CLOSED', 'La sesión con el agente terminó.')) : null;
    }
    if (!isObject(message) || message.jsonrpc !== '2.0') {
      return formatError(isObject(message) ? message.id ?? null : null, rpcError(INVALID_REQUEST, 'Mensaje JSON-RPC no válido.'));
    }
    const hasId = Object.hasOwn(message, 'id') && (typeof message.id === 'string' || Number.isInteger(message.id));
    if (typeof message.method === 'string') {
      if (!hasId) {
        // Las notificaciones nunca responden en el POST actual: peticiones emitidas van a la ruta de sesión.
        routeContext.run(undefined, () => {
          handleNotification(message).catch((error) => log('error', 'Fallo al procesar una notificación', { error: String(error) }));
        });
        return null;
      }
      return routeContext.run(route, async () => {
        try {
          const result = await handleRequest(message);
          return formatReply(message.id, result);
        } catch (error) {
          return formatError(message.id, error);
        }
      });
    }
    if (hasId && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'))) {
      handleResponse(message);
      return null;
    }
    return formatError(hasId ? message.id : null, rpcError(INVALID_REQUEST, 'Mensaje JSON-RPC no válido.'));
  }

  function close() {
    if (closing) return closing;
    closing = (async () => {
      for (const controller of running.values()) controller.abort();
      for (const waiting of pending.values()) waiting.reject(new MotorError('SESSION_CLOSED', 'La sesión con el agente terminó.'));
      try {
        await onClose?.();
      } finally {
        closed = true;
      }
    })();
    return closing;
  }

  return Object.freeze({
    connection,
    dispatchOne,
    /** Cancela una `tools/call` en curso, como haría `notifications/cancelled` (el cliente se fue). */
    cancel(requestId) { running.get(requestId)?.abort(); },
    close,
    isClosed: () => closed,
  });
}
