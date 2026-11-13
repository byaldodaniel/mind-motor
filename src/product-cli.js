import { MotorError } from './errors.js';
import { resolveLayout, productInstallation, productRuntime } from './layout.js';
import { MOTOR_VERSION } from './version.js';
import { COMMANDS } from './commands/index.js';

export { MOTOR_VERSION };

const USAGE = `Mind ${MOTOR_VERSION}

Uso: mind <orden> [opciones]

Para el usuario:
  preparar                   Prepara la conexión y el inicio automático en los agentes detectados.
  inicio                     Lee instrucciones y destinos al iniciar una conversación.
  estado                     Resumen de la Base, las carpetas y sus permisos.
  despertar                  Enciende o reutiliza el Motor Central en segundo plano.
  apagar                     Detiene el Motor Central activo de forma limpia.
  autorizar [ruta]           Revisa y aprueba solicitudes de agentes; con una ruta,
                             autoriza esa carpeta (pregunta qué permisos conceder).
  permisos [retirar <id>]    Lista permisos o retira una carpeta de Mind.
  permisos excluir <id> <subcarpeta>...
  permisos incluir <id> <subcarpeta>...
                             Deja fuera de Mind subcarpetas de una carpeta autorizada,
                             o vuelve a incluirlas.
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
`;

const OPTIONS = `
Opciones:
  --carpeta <ruta>           Carpeta abierta por el iniciador; acceso completo sin formulario.
  --base <ruta>              Base que se usará (en el producto: la carpeta Base).
`;

function parse(args) {
  const options = {};
  const rest = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === '--carpeta') {
      const folder = args[++index];
      if (!folder || !folder.trim()) throw new MotorError('INVALID_ARGUMENTS', 'Falta la ruta después de --carpeta.');
      (options.workspacePaths ??= []).push(folder);
    } else if (value === '--base') {
      options.base = args[++index];
      if (!options.base) throw new MotorError('INVALID_ARGUMENTS', 'Falta la ruta después de --base.');
    } else if (value === '--direct') {
      options.direct = true;
    } else if (value === '--headers') {
      options.headers = true;
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
async function withSession(options, task, { observe = false } = {}) {
  const { openSession } = await import('./session.js');
  const layout = await resolveLayout({ base: options.base });
  // macOS: retira la cuarentena de Runtime/ tras verificar sus hashes, antes del primer uso de Python.
  const { releaseQuarantine } = await import('./quarantine.js');
  const quarantine = await releaseQuarantine(layout);
  if (quarantine.aviso) process.stderr.write(`Aviso: ${quarantine.aviso}\n`);
  const session = await openSession({ layout, motorVersion: MOTOR_VERSION, observe });
  try {
    if (options.autoWorkspace) {
      const { createWorkspaceAccess } = await import('./workspace-access.js');
      const workspace = createWorkspaceAccess(session, { paths: options.workspacePaths });
      await session.start();
      await session.sync();
      await workspace.initialize({ clientCapabilities: {} });
      return await task(workspace.session);
    }
    await session.start();
    return await task(session);
  } finally {
    await session.close();
  }
}

export async function main(args) {
  try {
    const { options, command, parameters } = parse(args);
    options.autoWorkspace = ['estado', 'herramienta', 'inicio'].includes(command);
    if (!['version', '--version', 'actualizar', 'corregir', 'despertar', 'apagar', 'motor'].includes(command)) {
      const { prepareProductMcp } = await import('./product-mcp.js');
      try {
        const result = await prepareProductMcp();
        const installation = await productInstallation();
        let startup = {estado:'no_aplica',clientes:[]};
        if (installation.root) {
          const { prepareAgentStartup } = await import('./agent-startup.js');
          startup = await prepareAgentStartup({root:installation.root,runtime:productRuntime(installation.root,installation.manifest)});
        }
        if (command === 'preparar') {
          print({conexion:result,inicio:startup,indicacion:'Las instrucciones se cargan en conversaciones nuevas de los clientes detectados.'});
          return startup.estado === 'parcial' ? 1 : 0;
        }
        if (startup.estado === 'parcial') process.stderr.write('Aviso: algún cliente no pudo preparar el inicio de Mind; ejecuta preparar para consultar la incidencia.\\n');
      } catch (error) {
        if (command === 'preparar') throw error;
        process.stderr.write(`Aviso al preparar la conexión de Mind: ${error.message}\n`);
      }
    }
    switch (command) {
      case undefined:
      case 'ayuda':
      case '--help':
      case '-h':
        // Cada ayuda registrada empieza por su propia forma de uso.
        print(`${USAGE}\nMantenimiento:\n${Object.entries(COMMANDS).map(([name, entry]) => `  ${entry.ayuda ?? name}`).join('\n')}\n${OPTIONS}`);
        return 0;
      case 'version':
      case '--version': {
        const layout = await resolveLayout({ base: options.base, env: { ...process.env, MIND_BASE: process.env.MIND_BASE ?? '/' } }).catch(() => null);
        print({
          mind: layout?.manifest?.mindVersion ?? MOTOR_VERSION,
          motor: MOTOR_VERSION,
          revision: layout?.manifest?.packageRevision ?? 0,
          estructura: layout?.manifest?.layoutVersion ?? 1,
          node: process.versions.node,
          plataforma: `${process.platform}-${process.arch}`,
          producto: layout?.product ?? false,
        });
        return 0;
      }
      case 'motor': {
        if (parameters.length > 0) throw new MotorError('INVALID_ARGUMENTS', `motor no admite argumentos (${parameters[0]}).`);
        const layout = await resolveLayout({ base: options.base });
        const { releaseQuarantine } = await import('./quarantine.js');
        const quarantine = await releaseQuarantine(layout);
        if (quarantine.aviso) process.stderr.write(`Aviso: ${quarantine.aviso}\n`);
        const { runCentralMotorDaemon } = await import('./motor-central.js');
        await runCentralMotorDaemon({ layout, motorVersion: MOTOR_VERSION, observe: true });
        return 0;
      }
      case 'despertar': {
        if (parameters.length > 0) throw new MotorError('INVALID_ARGUMENTS', `despertar no admite argumentos (${parameters[0]}).`);
        const layout = await resolveLayout({ base: options.base });
        const { ensureCentralMotor } = await import('./connector.js');
        const conn = await ensureCentralMotor({ layout, baseDirectory: layout.baseDirectory });
        if (options.headers) {
          process.stdout.write(`${JSON.stringify({ Authorization: `Bearer ${conn.token}` })}\n`);
        } else {
          print({ ok: true, pid: conn.health.pid, port: conn.state.port, url: conn.url, despertado: conn.spawned });
        }
        return 0;
      }
      case 'apagar': {
        if (parameters.length > 0) throw new MotorError('INVALID_ARGUMENTS', `apagar no admite argumentos (${parameters[0]}).`);
        const layout = await resolveLayout({ base: options.base });
        const { stopCentralMotor } = await import('./connector.js');
        const stopped = await stopCentralMotor({ baseDirectory: layout.baseDirectory });
        print({ ok: true, apagado: stopped });
        return 0;
      }
      case 'mcp': {
        const layout = await resolveLayout({ base: options.base });
        if (options.direct) {
          const { runMcpSession } = await import('./mcp-session.js');
          return await runMcpSession({ layout, parameters, workspacePaths: options.workspacePaths });
        }
        if (parameters.length > 0) throw new MotorError('INVALID_ARGUMENTS', `mcp no admite argumentos (${parameters[0]}).`);
        const { runMcpBridge } = await import('./mcp-bridge.js');
        await runMcpBridge({ layout, workspacePaths: options.workspacePaths });
        return 0;
      }
      case 'inicio': {
        const layout = await resolveLayout({ base: options.base });
        const { callCentralRpc } = await import('./connector.js');
        const res = await callCentralRpc({
          layout,
          baseDirectory: layout.baseDirectory,
          payload: { accion: 'inicio', paths: options.workspacePaths, cwd: process.cwd() },
        });
        print({ mind: res.mind, instrucciones: res.instrucciones, destinos: res.destinos });
        return 0;
      }
      case 'estado': {
        const layout = await resolveLayout({ base: options.base });
        const { callCentralRpc } = await import('./connector.js');
        const res = await callCentralRpc({
          layout,
          baseDirectory: layout.baseDirectory,
          payload: { accion: 'estado', paths: options.workspacePaths, cwd: process.cwd() },
        });
        print(res.value);
        return res.isError ? 1 : 0;
      }
      case 'herramienta': {
        const [name, json = '{}'] = parameters;
        if (!name || parameters.length > 2) throw new MotorError('INVALID_ARGUMENTS', 'Uso: mind herramienta <nombre> [json]');
        let parsedArgs;
        try {
          parsedArgs = JSON.parse(json);
        } catch {
          throw new MotorError('INVALID_ARGUMENTS', 'Los argumentos deben ser un objeto JSON.');
        }
        if (!parsedArgs || typeof parsedArgs !== 'object' || Array.isArray(parsedArgs)) {
          throw new MotorError('INVALID_ARGUMENTS', 'Los argumentos deben ser un objeto JSON.');
        }
        const layout = await resolveLayout({ base: options.base });
        const { callCentralRpc } = await import('./connector.js');
        const res = await callCentralRpc({
          layout,
          baseDirectory: layout.baseDirectory,
          payload: { accion: 'herramienta', tool: name, args: parsedArgs, paths: options.workspacePaths, cwd: process.cwd() },
        });
        print(res.text);
        return res.isError ? 1 : 0;
      }
      case 'autorizar':
      case 'permisos':
      case 'reparar': {
        const consoleModule = await import('./console.js');
        if (command !== 'permisos' || ['retirar', 'incluir'].includes(parameters[0])) consoleModule.requireInteractive();
        return await withSession(options, async (session) => {
          const prompt = consoleModule.createPrompter();
          try {
            if (command === 'autorizar') {
              const folderPath = parameters.find((item) => !item.startsWith('--')) ?? null;
              const requested = ['leer', 'escribir', 'organizar'].filter((level) => parameters.includes(`--${level}`));
              await consoleModule.authorizeConsole({ session, prompt, folderPath, requested: requested.length ? requested : null });
            } else if (command === 'permisos') {
              const [action, target, ...paths] = parameters;
              await consoleModule.permissionsConsole({
                session, prompt,
                revoke: action === 'retirar' ? target ?? null : null,
                exclude: action === 'excluir' ? paths : null,
                include: action === 'incluir' ? paths : null,
                target: ['excluir', 'incluir'].includes(action) ? target ?? null : null,
              });
            } else {
              await consoleModule.repairConsole({ session, prompt });
            }
          } finally {
            prompt.close();
          }
          return 0;
        });
      }
      default: {
        // Órdenes de otras áreas (src/commands/index.js).
        const entry = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : null;
        if (!entry) throw new MotorError('INVALID_ARGUMENTS', `Orden desconocida: ${command}. Usa "mind ayuda".`);
        const module = await entry.load();
        return await module.run({
          parameters, options, print, layout: () => resolveLayout({ base: options.base }),
          withSession: (task, sessionOptions) => withSession(options, task, sessionOptions),
        });
      }
    }
  } catch (error) {
    return report(error);
  }
}
