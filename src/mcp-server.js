import { MotorError } from './errors.js';

/**
 * Servidor MCP mínimo sobre stdio (JSON-RPC 2.0, un mensaje JSON por línea).
 * Sin dependencias: implementa solo lo que Mind necesita del protocolo
 * (https://modelcontextprotocol.io/specification): initialize, ping,
 * tools/list, tools/call, cancelaciones y peticiones del servidor al cliente
 * (elicitation/create para el consentimiento del usuario).
 *
 * El contenido de las peticiones del cliente son datos: nunca se evalúan ni
 * conceden permisos por sí mismos.
 */

export const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);
export const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
const SERVER_REQUEST_TIMEOUT_MS = 10 * 60_000;

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

function rpcError(code, message, data) {
  return Object.assign(new Error(message), { rpcCode: code, rpcData: data });
}

function isObject(value) {
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

/**
 * @param {object} options
 * @param {NodeJS.ReadableStream} options.input
 * @param {NodeJS.WritableStream} options.output
 * @param {{ name: string, title?: string, version: string }} options.serverInfo
 * @param {string} [options.instructions] Instrucciones para el agente (InitializeResult.instructions).
 * @param {(connection: object) => { definitions: object[], call: (name: string, args: object, context: object) => Promise<object> }} options.tools
 * @param {(connection: object) => void | Promise<void>} [options.onInitialized]
 * @param {() => void | Promise<void>} [options.onClose]
 * @param {(level: string, message: string, data?: object) => void} [options.log]
 */
export function serveMcp({ input, output, serverInfo, instructions, tools, onInitialized, onClose, log = () => {} }) {
  const pending = new Map();
  const running = new Map();
  let nextId = 1;
  let buffer = '';
  let closed = false;
  let toolset = null;

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
    request(method, params, { timeoutMs = SERVER_REQUEST_TIMEOUT_MS, signal } = {}) {
      if (closed) return Promise.reject(new MotorError('SESSION_CLOSED', 'La sesión con el agente terminó.'));
      const id = `mind-${nextId++}`;
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
        send({ jsonrpc: '2.0', id, method, params });
      });
    },
    notify(method, params) {
      if (!closed) send({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
    },
  };

  function send(message) {
    if (closed) return;
    output.write(`${JSON.stringify(message)}\n`);
  }

  function reply(id, result) {
    send({ jsonrpc: '2.0', id, result });
  }

  function fail(id, error) {
    const code = error?.rpcCode ?? INTERNAL_ERROR;
    send({
      jsonrpc: '2.0', id,
      error: { code, message: error?.rpcCode ? error.message : 'Error interno de Mind.', ...(error?.rpcData ? { data: error.rpcData } : {}) },
    });
  }

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
          return toolResult(await toolset.call(name, args, { signal: controller.signal, connection }));
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
        await onInitialized?.(connection);
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

  function dispatch(message) {
    if (!isObject(message) || message.jsonrpc !== '2.0') {
      return fail(isObject(message) ? message.id ?? null : null, rpcError(INVALID_REQUEST, 'Mensaje JSON-RPC no válido.'));
    }
    const hasId = Object.hasOwn(message, 'id') && (typeof message.id === 'string' || Number.isInteger(message.id));
    if (typeof message.method === 'string') {
      if (!hasId) {
        handleNotification(message).catch((error) => log('error', 'Fallo al procesar una notificación', { error: String(error) }));
        return undefined;
      }
      handleRequest(message).then((result) => reply(message.id, result), (error) => fail(message.id, error));
      return undefined;
    }
    if (hasId && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'))) return handleResponse(message);
    return fail(hasId ? message.id : null, rpcError(INVALID_REQUEST, 'Mensaje JSON-RPC no válido.'));
  }

  function processLine(line) {
    if (line.trim() === '') return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return fail(null, rpcError(PARSE_ERROR, 'JSON no válido.'));
    }
    // Las versiones anteriores a 2025-06-18 admitían lotes.
    if (Array.isArray(message)) return message.forEach(dispatch);
    return dispatch(message);
  }

  input.setEncoding?.('utf8');
  input.on('data', (chunk) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer, 'utf8') > MAX_MESSAGE_BYTES && !buffer.includes('\n')) {
      buffer = '';
      fail(null, rpcError(INVALID_REQUEST, 'El mensaje supera el tamaño admitido.'));
      return;
    }
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      processLine(line);
    }
  });

  const finished = new Promise((resolve) => {
    let ended = false;
    const end = async () => {
      if (ended) return;
      ended = true;
      for (const controller of running.values()) controller.abort();
      for (const waiting of pending.values()) waiting.reject(new MotorError('SESSION_CLOSED', 'La sesión con el agente terminó.'));
      try {
        await onClose?.();
      } finally {
        closed = true;
        resolve();
      }
    };
    input.on('end', end);
    input.on('close', end);
    input.on('error', end);
  });

  return Object.freeze({ connection, finished });
}
