import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openSession } from '../../src/session.js';
import { createAgentTools } from '../../src/agent-tools.js';
import { toolResult, toolError } from '../../src/mcp-server.js';

export const motorDirectory = await fs.realpath(fileURLToPath(new URL('../..', import.meta.url)));
const development = path.dirname(motorDirectory);
export const pythonExecutable = process.platform === 'win32' ? 'python' : 'python3';

/** Conexión simulada: onElicit hace de interfaz del cliente que pregunta al usuario. */
export function connection({ onElicit = null, clientInfo = { name: 'cliente-de-prueba', version: '1.0' } } = {}) {
  const asked = [];
  return {
    asked,
    protocolVersion: '2025-11-25',
    clientInfo,
    supportsFormElicitation: () => onElicit !== null,
    async request(method, params) {
      asked.push({ method, params });
      return onElicit(params);
    },
  };
}

/** Respuestas del usuario en los formularios, en orden; el resto se rechaza. */
export function answers(...responses) {
  return (params) => {
    const next = responses.shift();
    return typeof next === 'function' ? next(params) : next ?? { action: 'decline' };
  };
}

/** Consola guionada: ask y yes consumen respuestas en orden. */
export function scriptedPrompt(...replies) {
  const lines = [];
  return {
    lines,
    write: (line) => lines.push(line),
    ask: async () => replies.shift() ?? '',
    secret: async () => replies.shift() ?? '',
    yes: async () => ['s'].includes(replies.shift()),
  };
}

/** Datos ficticios y una carpeta Mind temporal fuera del repositorio. */
export async function agentFixture(t, { observe = false, prefix = '.mind-agent-test-', files = {} } = {}) {
  const root = await fs.mkdtemp(path.join(development, prefix));
  const sessions = [];
  t.after(async () => {
    await Promise.allSettled(sessions.map((session) => session.close()));
    assert.equal(path.dirname(root), development);
    assert.ok(path.basename(root).startsWith(prefix));
    await fs.rm(root, { recursive: true, force: true });
  });
  const mind = path.join(root, 'Mind');
  await fs.mkdir(mind);
  const folder = path.join(root, 'Información ficticia');
  const content = {
    'Proyectos/presupuesto.md': '# Presupuesto ficticio\nTotal: 100\n',
    'notas.txt': 'Notas ficticias\n',
    ...files,
  };
  for (const [relative, text] of Object.entries(content)) {
    await fs.mkdir(path.dirname(path.join(folder, relative)), { recursive: true });
    await fs.writeFile(path.join(folder, relative), text);
  }
  const layout = {
    product: true, manifest: null, root: mind, motorDirectory,
    baseDirectory: path.join(mind, 'Base'), pythonExecutable, protectedDirectories: [mind],
  };
  async function open(options = {}) {
    const session = await openSession({ layout, motorVersion: '0.0.0-prueba', observe, ...options });
    sessions.push(session);
    await session.start();
    return session;
  }
  /** Llama a una herramienta como lo haría el servidor MCP. */
  function agent(session, conn) {
    const tools = createAgentTools({ session, connection: conn });
    return async (name, args = {}) => {
      try {
        const result = toolResult(await tools.call(name, args, {}));
        return { data: result.structuredContent, text: result.content[0].text, isError: false };
      } catch (error) {
        const result = toolError(error);
        return { data: result.structuredContent, text: result.content[0].text, isError: true, code: result.structuredContent.error.codigo };
      }
    };
  }
  return { root, mind, folder: await fs.realpath(folder), layout, open, agent };
}
