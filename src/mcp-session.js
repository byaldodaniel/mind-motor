import { serveMcp } from './mcp-server.js';
import { MotorError } from './errors.js';
import { openSession } from './session.js';
import { createAgentTools, AGENT_INSTRUCTIONS } from './agent-tools.js';
import { MOTOR_VERSION } from './version.js';
import { releaseQuarantine } from './quarantine.js';

/**
 * Sesión MCP ligada al agente: empieza cuando el cliente inicia el proceso y
 * termina cuando cierra stdin. No queda ningún proceso residente.
 * @param {{ layout: Awaited<ReturnType<import('./layout.js').resolveLayout>>, input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream }} options
 */
export async function runMcpSession({ layout, input = process.stdin, output = process.stdout }) {
  const log = (level, message, data) => {
    process.stderr.write(`${JSON.stringify({ nivel: level, mensaje: message, ...(data ? { datos: data } : {}), fecha: new Date().toISOString() })}\n`);
  };
  // macOS: retira la cuarentena de Runtime/ tras verificar sus hashes, antes del primer uso de Python.
  const quarantine = await releaseQuarantine(layout, { log });
  let session;
  try {
    session = await openSession({ layout, motorVersion: MOTOR_VERSION, log });
  } catch (error) {
    // Error de inicio: se atiende al agente igualmente para que pueda explicar
    // al usuario qué pasa, en lugar de que el servidor desaparezca sin aviso.
    log('error', 'No se pudo abrir la Base', { codigo: error?.code ?? null, error: String(error?.message ?? error) });
    return serveStartupError({ layout, error, input, output, log });
  }
  let closing = null;
  const close = () => {
    closing ??= session.close().catch((error) => log('error', 'Fallo al cerrar la sesión', { error: String(error) }));
    return closing;
  };

  const server = serveMcp({
    input,
    output,
    serverInfo: { name: 'mind', title: 'Mind', version: MOTOR_VERSION },
    instructions: quarantine.aviso ? `${AGENT_INSTRUCTIONS}\n\nAviso para el usuario: ${quarantine.aviso}` : AGENT_INSTRUCTIONS,
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

const STARTUP_GUIDANCE = Object.freeze({
  BASE_TOO_NEW: 'La Base fue creada por una versión más reciente de Mind. Pide al usuario que actualice Mind con "mind actualizar <paquete>"; esta versión no la modificará.',
  BASE_MARKER_CORRUPT: 'La marca de formato de la Base está dañada. No se modificó nada. Pide al usuario que la restaure desde un respaldo con "mind respaldo restaurar".',
  RUNTIME_MISSING: 'Falta un componente incluido de Mind. Pide al usuario que vuelva a extraer el paquete de Mind.',
  INVALID_BASE: 'La ubicación de la Base no es válida. Pide al usuario que revise la carpeta Base de Mind.',
  BASE_OVERLAPS_MOTOR: 'La Base no puede estar dentro del Motor. Pide al usuario que revise la instalación.',
});

/** Servidor mínimo cuando la sesión no puede abrirse: solo "estado", con el motivo. */
async function serveStartupError({ layout, error, input, output, log }) {
  const code = error instanceof MotorError ? error.code : (error?.code === 'EACCES' || error?.code === 'EPERM' ? 'BASE_ACCESS_DENIED' : 'STARTUP_FAILED');
  const message = error instanceof MotorError ? error.message
    : code === 'BASE_ACCESS_DENIED' ? 'El sistema no permite abrir o crear la Base de Mind con este usuario.'
      : 'Mind no pudo iniciarse.';
  const report = {
    error: { codigo: code, mensaje: message },
    base: layout?.baseDirectory ?? null,
    que_hacer: STARTUP_GUIDANCE[code] ?? 'Pide al usuario que ejecute "mind estado" en la carpeta de Mind para ver el detalle, o "mind reparar" si cerró Mind de forma abrupta.',
  };
  const server = serveMcp({
    input,
    output,
    serverInfo: { name: 'mind', title: 'Mind', version: MOTOR_VERSION },
    instructions: `Mind no pudo iniciarse (${code}). Llama a "estado" para conocer el motivo y explícaselo al usuario. No hay otras herramientas disponibles.`,
    tools: () => ({
      definitions: [{
        name: 'estado',
        title: 'Estado de Mind',
        description: 'Mind no pudo iniciarse: devuelve el motivo y qué debe hacer el usuario.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true, openWorldHint: false },
      }],
      call: async () => report,
    }),
    log,
  });
  await server.finished;
  return 1;
}
