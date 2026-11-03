import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const launcher = fileURLToPath(new URL('../../bin/mind.js', import.meta.url));

/**
 * Cliente MCP de pruebas: inicia `mind mcp` como lo haría un agente y habla
 * JSON-RPC por stdio. onElicit simula la interfaz del cliente que muestra el
 * formulario al usuario (en un cliente real responde la persona, no el modelo).
 */
export function startMcp({ args = [], env = {}, command = process.execPath, commandArgs = [launcher, 'mcp'],
  capabilities = { elicitation: { form: {} } }, clientInfo = { name: 'cliente-de-prueba', version: '1.0' },
  protocolVersion = '2025-11-25', onElicit = null, roots = [], cwd, baseEnv = process.env } = {}) {
  const child = spawn(command, [...commandArgs, ...args], {
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, cwd,
    env: { ...baseEnv, ...env },
  });
  const waiting = new Map();
  const elicitations = [];
  let nextId = 1;
  let buffer = '';
  let stderr = '';
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (message.method && Object.hasOwn(message, 'id')) {
        // Petición del servidor al cliente.
        if (message.method === 'roots/list') {
          Promise.resolve(typeof roots === 'function' ? roots() : roots).then(value => {
            child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { roots: value } })}\n`);
          });
        } else if (message.method === 'elicitation/create') {
          elicitations.push(message.params);
          Promise.resolve(onElicit ? onElicit(message.params) : { action: 'decline' }).then((result) => {
            child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`);
          });
        } else {
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'no' } })}\n`);
        }
        continue;
      }
      const pending = waiting.get(message.id);
      if (pending) {
        waiting.delete(message.id);
        pending(message);
      }
    }
  });

  function request(method, params = {}) {
    const id = nextId++;
    return new Promise((resolve) => {
      waiting.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  function notify(method, params) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) })}\n`);
  }

  return {
    child,
    elicitations,
    exited,
    stderr: () => stderr,
    request,
    notify,
    async initialize() {
      const response = await request('initialize', { protocolVersion, capabilities, clientInfo });
      notify('notifications/initialized');
      return response;
    },
    /** Llama a una herramienta y devuelve { data, isError, text }. */
    async call(name, args = {}) {
      const response = await request('tools/call', { name, arguments: args });
      if (response.error) return { rpcError: response.error };
      const { structuredContent, isError = false, content } = response.result;
      return { data: structuredContent, isError, text: content?.[0]?.text ?? '' };
    },
    async close() {
      child.stdin.end();
      return exited;
    },
  };
}
