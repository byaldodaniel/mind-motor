import { MotorError } from './errors.js';
import { resolveLayout } from './layout.js';
import { MOTOR_VERSION } from './version.js';

export { MOTOR_VERSION };

const USAGE = `Mind ${MOTOR_VERSION}

Uso: mind <orden> [opciones]

Para el usuario:
  estado                     Resumen de la Base, las carpetas y sus permisos.
  autorizar [ruta]           Revisa y aprueba solicitudes de agentes; con una ruta,
                             autoriza esa carpeta (pregunta qué permisos conceder).
  permisos [retirar <id>]    Lista permisos o retira una carpeta de Mind.
  reparar                    Limpia bloqueos y temporales abandonados tras un cierre
                             abrupto (cuando no hay agentes abiertos).
  version                    Versión del Motor y de los componentes.

Para agentes:
  mcp                        Servidor MCP por stdio (lo inicia el agente al abrir
                             la carpeta de Mind).
  herramienta <nombre> [json]
                             Ejecuta una herramienta de Mind en una operación
                             individual (sin observación continua), para agentes
                             sin MCP. Ejemplo: mind herramienta buscar '{"consulta":"acta"}'

Opciones:
  --base <ruta>              Base que se usará (en el producto: la carpeta Base).
`;

function parse(args) {
  const options = {};
  const rest = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === '--base') {
      options.base = args[++index];
      if (!options.base) throw new MotorError('INVALID_ARGUMENTS', 'Falta la ruta después de --base.');
    } else {
      rest.push(value);
    }
  }
  return { options, command: rest[0], parameters: rest.slice(1) };
}

function print(value) {
  process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`);
}

/** Errores para personas: mensaje claro en stderr y código de salida 1. */
function report(error) {
  const known = error instanceof MotorError;
  process.stderr.write(`${JSON.stringify({ error: { codigo: known ? error.code : 'ERROR_INTERNO', mensaje: known ? error.message : String(error?.message ?? error) } })}\n`);
  return 1;
}

/** Sesión sin observación: cada operación reconcilia bajo demanda lo que necesita. */
async function withSession(options, task) {
  const { openSession } = await import('./session.js');
  const session = await openSession({ layout: await resolveLayout({ base: options.base }), motorVersion: MOTOR_VERSION, observe: false });
  try {
    await session.start();
    return await task(session);
  } finally {
    await session.close();
  }
}

/** Ejecuta una herramienta como lo haría un agente sin MCP: sin formularios de consentimiento. */
async function runTool(session, name, args) {
  const { createAgentTools } = await import('./agent-tools.js');
  const { toolResult, toolError } = await import('./mcp-server.js');
  const connection = { clientInfo: { name: 'mind-herramienta' }, supportsFormElicitation: () => false, protocolVersion: null };
  const tools = createAgentTools({ session, connection });
  if (!tools.definitions.some((tool) => tool.name === name)) {
    throw new MotorError('INVALID_ARGUMENTS', `Herramienta desconocida: ${name}. Disponibles: ${tools.definitions.map((tool) => tool.name).join(', ')}.`);
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new MotorError('INVALID_ARGUMENTS', 'Los argumentos deben ser un objeto JSON.');
  let result;
  try {
    result = toolResult(await tools.call(name, args, {}));
  } catch (error) {
    result = toolError(error);
  }
  return { value: result.structuredContent, text: result.content[0].text, isError: result.isError === true };
}

export async function main(args) {
  try {
    const { options, command, parameters } = parse(args);
    switch (command) {
      case undefined:
      case 'ayuda':
      case '--help':
      case '-h':
        print(USAGE);
        return 0;
      case 'version':
      case '--version': {
        const layout = await resolveLayout({ base: options.base, env: { ...process.env, MIND_BASE: process.env.MIND_BASE ?? '/' } }).catch(() => null);
        print({
          mind: layout?.manifest?.mindVersion ?? MOTOR_VERSION,
          motor: MOTOR_VERSION,
          node: process.versions.node,
          plataforma: `${process.platform}-${process.arch}`,
          producto: layout?.product ?? false,
        });
        return 0;
      }
      case 'mcp': {
        const { runMcpSession } = await import('./mcp-session.js');
        return await runMcpSession({ layout: await resolveLayout({ base: options.base }), parameters });
      }
      case 'estado':
        return await withSession(options, async (session) => {
          const result = await runTool(session, 'estado', {});
          print(result.value);
          return 0;
        });
      case 'herramienta': {
        const [name, json = '{}'] = parameters;
        if (!name || parameters.length > 2) throw new MotorError('INVALID_ARGUMENTS', 'Uso: mind herramienta <nombre> [json]');
        let args;
        try {
          args = JSON.parse(json);
        } catch {
          throw new MotorError('INVALID_ARGUMENTS', 'Los argumentos deben ser un objeto JSON.');
        }
        return await withSession(options, async (session) => {
          const result = await runTool(session, name, args);
          print(result.text);
          return result.isError ? 1 : 0;
        });
      }
      case 'autorizar':
      case 'permisos':
      case 'reparar': {
        const consoleModule = await import('./console.js');
        if (command !== 'permisos' || parameters[0] === 'retirar') consoleModule.requireInteractive();
        return await withSession(options, async (session) => {
          const prompt = consoleModule.createPrompter();
          try {
            if (command === 'autorizar') {
              const folderPath = parameters.find((item) => !item.startsWith('--')) ?? null;
              const requested = ['leer', 'escribir', 'organizar'].filter((level) => parameters.includes(`--${level}`));
              await consoleModule.authorizeConsole({ session, prompt, folderPath, requested: requested.length ? requested : null });
            } else if (command === 'permisos') {
              await consoleModule.permissionsConsole({ session, prompt, revoke: parameters[0] === 'retirar' ? parameters[1] ?? null : null });
            } else {
              await consoleModule.repairConsole({ session, prompt });
            }
          } finally {
            prompt.close();
          }
          return 0;
        });
      }
      default:
        throw new MotorError('INVALID_ARGUMENTS', `Orden desconocida: ${command}. Usa "mind ayuda".`);
    }
  } catch (error) {
    return report(error);
  }
}
