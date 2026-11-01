import { serveMcp } from './mcp-server.js';
import { openSession } from './session.js';
import { createAgentTools, AGENT_INSTRUCTIONS } from './agent-tools.js';
import { MOTOR_VERSION } from './version.js';

/**
 * Sesión MCP ligada al agente: empieza cuando el cliente inicia el proceso y
 * termina cuando cierra stdin. No queda ningún proceso residente.
 * @param {{ layout: Awaited<ReturnType<import('./layout.js').resolveLayout>>, input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream }} options
 */
export async function runMcpSession({ layout, input = process.stdin, output = process.stdout }) {
  const log = (level, message, data) => {
    process.stderr.write(`${JSON.stringify({ nivel: level, mensaje: message, ...(data ? { datos: data } : {}), fecha: new Date().toISOString() })}\n`);
  };
  const session = await openSession({ layout, motorVersion: MOTOR_VERSION, log });
  let closing = null;
  const close = () => {
    closing ??= session.close().catch((error) => log('error', 'Fallo al cerrar la sesión', { error: String(error) }));
    return closing;
  };

  const server = serveMcp({
    input,
    output,
    serverInfo: { name: 'mind', title: 'Mind', version: MOTOR_VERSION },
    instructions: AGENT_INSTRUCTIONS,
    tools: (connection) => createAgentTools({ session, connection, log }),
    onInitialized: () => session.start(),
    onClose: close,
    log,
  });

  // Cierre ordenado si el cliente termina el proceso con una señal.
  const signals = process.platform === 'win32' ? ['SIGINT', 'SIGBREAK'] : ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const onSignal = () => {
    close().finally(() => process.exit(0));
  };
  for (const signal of signals) process.once(signal, onSignal);
  await server.finished;
  await close();
  for (const signal of signals) process.removeListener(signal, onSignal);
  return 0;
}
