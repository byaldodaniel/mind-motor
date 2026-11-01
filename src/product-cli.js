import { MotorError } from './errors.js';
import { resolveLayout } from './layout.js';
import { MOTOR_VERSION } from './version.js';

export { MOTOR_VERSION };

const USAGE = `Mind ${MOTOR_VERSION}

Uso: mind <orden> [opciones]

  version              Versión del Motor y de los componentes.
  mcp                  Servidor MCP por stdio para agentes compatibles
                       (lo inicia el agente al abrir la carpeta de Mind).

Opciones comunes:
  --base <ruta>        Base que se usará (en el producto: la carpeta Base de Mind).
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
      default:
        throw new MotorError('INVALID_ARGUMENTS', `Orden desconocida: ${command}. Usa "mind ayuda".`);
    }
  } catch (error) {
    return report(error);
  }
}
