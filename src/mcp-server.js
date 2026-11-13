import {
  SUPPORTED_PROTOCOL_VERSIONS,
  MAX_MESSAGE_BYTES,
  PARSE_ERROR,
  INVALID_REQUEST,
  rpcError,
  formatError,
  createMcpProcessor,
  toolResult,
  toolError,
} from './mcp-core.js';

/**
 * Servidor MCP mínimo sobre stdio (JSON-RPC 2.0, un mensaje JSON por línea).
 * Delega la ejecución del protocolo al núcleo común (`mcp-core.js`).
 */

export { SUPPORTED_PROTOCOL_VERSIONS, MAX_MESSAGE_BYTES, toolResult, toolError };

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
export function serveMcp({ input, output, serverInfo, instructions, tools, onInitialized, onRootsChanged, onClose, log = () => {} }) {
  let buffer = '';
  let closed = false;

  function send(message) {
    if (closed) return;
    output.write(`${JSON.stringify(message)}\n`);
  }

  const processor = createMcpProcessor({
    serverInfo,
    instructions,
    tools,
    onInitialized,
    onRootsChanged,
    onClose,
    send,
    log,
  });

  function dispatch(message) {
    processor.dispatchOne(message).then((reply) => {
      if (reply) send(reply);
    });
  }

  function processLine(line) {
    if (line.trim() === '') return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return send(formatError(null, rpcError(PARSE_ERROR, 'JSON no válido.')));
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
      send(formatError(null, rpcError(INVALID_REQUEST, 'El mensaje supera el tamaño admitido.')));
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
      try {
        await processor.close();
      } finally {
        closed = true;
        resolve();
      }
    };
    input.on('end', end);
    input.on('close', end);
    input.on('error', end);
  });

  return Object.freeze({ connection: processor.connection, finished });
}
