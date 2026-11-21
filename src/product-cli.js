import fsSync from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MotorError } from './errors.js';
import { contains, currentDirectory } from './paths.js';
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
  permisos [retirar <id|ruta|continuidad> [permisos...]]
                             Lista permisos o retira una carpeta o permisos de Mind.
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
  --nativo                   Usa el puente MCP nativo (Rust/Go) si está disponible.
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
    } else if (value === '--nativo') {
      options.nativo = true;
    } else {
      rest.push(value);
    }
  }
  return { options, command: rest[0], parameters: rest.slice(1) };
}

async function tryNativeMcpBridge({ layout, workspacePaths = [] }) {
  const nativeExecutable = layout?.runtime?.nativeExecutable;
  if (!nativeExecutable || !fsSync.existsSync(nativeExecutable)) return null;
  const nodeExecutable = layout?.runtime?.nodeExecutable && fsSync.existsSync(layout.runtime.nodeExecutable)
    ? layout.runtime.nodeExecutable
    : process.execPath;
  const entrypoint = layout?.entrypoint
    ?? (layout?.motorDirectory ? path.join(layout.motorDirectory, 'bin', 'mind.js') : null)
    ?? fileURLToPath(new URL('../bin/mind.js', import.meta.url));
  const args = [
    'bridge',
    '--base', layout.baseDirectory,
    '--cwd', currentDirectory(),
    '--paths', JSON.stringify(workspacePaths),
    '--launch-command', nodeExecutable,
    '--launch-arg', entrypoint,
    '--launch-arg', 'motor',
    '--launch-arg', '--base',
    '--launch-arg', layout.baseDirectory,
    '--relaunch-command', process.execPath,
    ...process.argv.slice(1).flatMap((arg) => ['--relaunch-arg', arg]),
    '--motor-version', MOTOR_VERSION,
    '--package-revision', String(layout.manifest?.packageRevision ?? 0),
  ];
  return await new Promise((resolve) => {
    let spawned = false;
    let settled = false;
    const child = spawn(nativeExecutable, args, { stdio: 'inherit', windowsHide: true });
    const onSigTerm = () => child.kill('SIGTERM');
    const onSigInt = () => child.kill('SIGINT');
    const cleanup = () => {
      process.off('SIGTERM', onSigTerm);
      process.off('SIGINT', onSigInt);
    };
    const finish = (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(code);
    };
    process.once('SIGTERM', onSigTerm);
    process.once('SIGINT', onSigInt);
    child.once('spawn', () => { spawned = true; });
    child.once('error', () => finish(spawned ? 1 : null));
    child.once('exit', (code, signal) => finish(code ?? (signal ? 1 : 0)));
  });
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

/** Las órdenes locales conservan el terminal y comparten la propiedad exclusiva con Rust. */
async function holdLegacyConsoleOwner(layout) {
  const { canonicalBaseDirectory, connectorPaths, readConnectorState } = await import('./connector.js');
  const base = await canonicalBaseDirectory(layout.baseDirectory);
  const { lockFile } = connectorPaths(base);
  const { lstat, mkdir } = await import('node:fs/promises');
  const state = await readConnectorState(base);
  const hasLock = state === null && await lstat(lockFile).then(() => true, () => false);
  // La propiedad depende del bloqueo, incluso si el Motor dejó de responder.
  if (process.env.MIND_MOTOR_NATIVO !== '1' && state?.backend !== 'rust' && !hasLock) return null;
  if (contains(layout.motorDirectory, layout.baseDirectory) || contains(layout.motorDirectory, base)) {
    throw new MotorError('BASE_OVERLAPS_MOTOR', 'La Base no puede estar dentro del Motor.');
  }
  const { acquireOwnerFileLock } = await import('./process-identity.js');
  await mkdir(base, { recursive: true, mode: 0o700 });
  try {
    return await acquireOwnerFileLock(lockFile, { pythonExecutable: layout.pythonExecutable });
  } catch (error) {
    if (error.code !== 'LOCK_BUSY') throw error;
    throw new MotorError('BASE_OCUPADA',
      'El Motor está usando esta Base. Cierra las sesiones de Mind, usa "mind apagar" y vuelve a ejecutar esta orden.');
  }
}

async function shouldUseNativeConsole(layout) {
  if (process.env.MIND_MOTOR_NATIVO === '1') return true;
  const { checkHealthyConnector } = await import('./connector.js');
  const active = await checkHealthyConnector(layout.baseDirectory);
  return active?.health?.backend === 'rust';
}

async function withNativeConsole(layout, task) {
  const { ensureCentralMotor, callCentralRpc, stopCentralMotor } = await import('./connector.js');
  const conn = await ensureCentralMotor({ layout, baseDirectory: layout.baseDirectory });
  const rpc = (operacion, args = {}) => callCentralRpc({
    layout,
    baseDirectory: conn.baseDirectory,
    console: true,
    payload: { accion: 'consola', operacion, ...args },
  });
  const session = {
    nativeConsole: true,
    layout,
    motor: {
      baseDirectory: conn.baseDirectory,
      authorizeFolder: async (ruta) => (await rpc('autorizar_carpeta', { ruta })).carpeta,
      getAuthorizedFolder: async (id) => (await rpc('obtener_carpeta', { id })).carpeta,
      listAuthorizedFolders: async () => (await rpc('listar_carpetas')).carpetas,
      setFolderExclusions: async (id, excluidas) => rpc('exclusiones_carpeta', { id, excluidas }),
      revokeFolder: async (id) => (await rpc('retirar_carpeta', { id })).retirada,
      readFolderIndex: async (id) => (await rpc('leer_indice', { id })).indice,
      getTrashEntry: async (id, trashId) => (await rpc('obtener_papelera', { id, papelera: trashId })).entrada,
      grantDelete: async (params) => params,
      deleteEntry: async ({ authorization }) => (await rpc('borrar_elemento', {
        id: authorization.folderId,
        ruta: authorization.relativePath,
        esperado: authorization.expected,
        por: authorization.by,
        motivo: authorization.reason,
      })).borrado,
      grantPurge: async (params) => params,
      purgeEntry: async ({ authorization }) => (await rpc('vaciar_elemento', {
        id: authorization.folderId,
        papelera: authorization.trashId,
      })).vaciado,
      takeProperties: async () => [],
      putProperties: async () => ({ restored: 0 }),
    },
    policy: {
      get: async (id) => (await rpc('obtener_acceso', { id })).acceso,
      set: async (id, permisos, { channel } = {}) => (await rpc('guardar_acceso', { id, permisos, canal: channel })).acceso,
      remove: async (id) => (await rpc('retirar_acceso', { id })).retirado,
      getContinuity: async () => (await rpc('obtener_continuidad')).continuidad,
      setContinuity: async (permisos, { channel } = {}) => (await rpc('guardar_continuidad', { permisos, canal: channel })).continuidad,
    },
    requests: {
      list: async () => (await rpc('listar_solicitudes')).solicitudes,
      remove: async (id) => (await rpc('retirar_solicitud', { id })).retirada,
    },
    removals: {
      record: async () => 0,
    },
    reindex: async (id) => (await rpc('indexar_carpeta', { id })).indice,
    ensureIndex: async (id) => (await rpc('indexar_carpeta', { id })).indice,
    audit: async () => {},
  };
  try {
    return await task(session);
  } finally {
    if (conn.spawned) {
      await stopCentralMotor({ baseDirectory: conn.baseDirectory, onlyIfIdle: true }).catch(() => {});
    }
  }
}

/** Sesión sin observación: cada operación reconcilia bajo demanda lo que necesita. */
async function withSession(options, task, { observe = false } = {}) {
  const { openSession } = await import('./session.js');
  const layout = options.layout ?? await resolveLayout({ base: options.base });
  // macOS: retira la cuarentena de Runtime/ tras verificar sus hashes, antes del primer uso de Python.
  const { releaseQuarantine } = await import('./quarantine.js');
  const quarantine = await releaseQuarantine(layout);
  if (quarantine.aviso) process.stderr.write(`Aviso: ${quarantine.aviso}\n`);
  const release = await holdLegacyConsoleOwner(layout);
  try {
    const session = await openSession({ layout, motorVersion: MOTOR_VERSION, observe });
    try {
      if (options.autoWorkspace) {
        const { createWorkspaceAccess } = await import('./workspace-access.js');
        const workspace = createWorkspaceAccess(session, { paths: options.workspacePaths });
        try {
          await session.start();
          await session.sync();
          await workspace.initialize({ clientCapabilities: {} });
          return await task(workspace.session);
        } finally {
          await workspace.close();
        }
      }
      await session.start();
      return await task(session);
    } finally {
      await session.close();
    }
  } finally {
    await release?.();
  }
}

export async function main(args, io = {}) {
  try {
    const { options, command, parameters } = parse(args);
    if (command === 'mcp' && options.direct && process.env.MIND_MOTOR_NATIVO === '1') {
      throw new MotorError('NATIVE_MOTOR_DIRECT_UNSUPPORTED', 'El Motor Rust usa el conector. Inicia mcp sin --direct.');
    }
    options.autoWorkspace = ['estado', 'herramienta', 'inicio'].includes(command);
    if (!['version', '--version', 'actualizar', 'corregir', 'despertar', 'apagar', 'motor'].includes(command)) {
      const { prepareProductMcp } = await import('./product-mcp.js');
      try {
        const result = await prepareProductMcp();
        const installation = await productInstallation();
        let startup = {estado:'no_aplica',clientes:[]};
        if (installation.root) {
          const { prepareAgentStartup } = await import('./agent-startup.js');
          startup = await prepareAgentStartup({root:installation.root,runtime:productRuntime(installation.root,installation.manifest),createMissing:true});
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
        if (process.env.MIND_MOTOR_NATIVO === '1') {
          const { ensureCentralMotor } = await import('./connector.js');
          await ensureCentralMotor({ layout, baseDirectory: layout.baseDirectory });
          return 0;
        }
        const { releaseQuarantine } = await import('./quarantine.js');
        const quarantine = await releaseQuarantine(layout);
        if (quarantine.aviso) process.stderr.write(`Aviso: ${quarantine.aviso}\n`);
        const { runCentralMotorDaemon } = await import('./motor-central.js');
        const { createFileLog } = await import('./motor-log.js');
        // Restos de una actualización hecha con un chat abierto: se borran cuando ya nadie los usa.
        if (layout.product && layout.root) {
          const fs = await import('node:fs/promises');
          const path = await import('node:path');
          if (await fs.lstat(path.join(layout.root, 'Sistema', 'Actualizaciones', 'Retirados')).then(() => true, () => false)) {
            import('./update-transaction.js')
              .then(({ purgeRetiredUpdates }) => purgeRetiredUpdates(layout.root, { pythonExecutable: layout.pythonExecutable }))
              .catch(() => {});
          }
        }
        await runCentralMotorDaemon({
          layout,
          motorVersion: MOTOR_VERSION,
          observe: true,
          // Quien lanzó este proceso espera aquí el motivo si el inicio falla.
          errorFile: process.env.MIND_MOTOR_ERROR_FILE ?? null,
          log: createFileLog(layout.baseDirectory),
        });
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
          const { health } = conn;
          print({
            ok: true,
            pid: health.pid,
            port: conn.state.port,
            url: conn.url,
            despertado: conn.spawned,
            version: health.motorVersion,
            estado: health.state,
            iniciado: health.startedAt,
            sesiones: health.sessions,
            peticiones_activas: health.activeRequests,
            trabajo_de_fondo: health.backgroundBusy === true,
            cola: health.queue,
            independencia: health.independence ?? 'desconocida',
            lanzamiento: health.launch ?? null,
            cierre_anterior: health.previousEnd ?? null,
            ...(conn.launch?.aviso ? { aviso_lanzamiento: conn.launch.aviso } : {}),
          });
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
        if (process.env.MIND_MOTOR_NATIVO !== '1' && (options.nativo || process.env.MIND_PUENTE_NATIVO === '1')) {
          const nativeCode = await tryNativeMcpBridge({ layout, workspacePaths: options.workspacePaths });
          if (nativeCode !== null) return nativeCode;
        }
        const { runMcpBridge } = await import('./mcp-bridge.js');
        await runMcpBridge({
          layout,
          workspacePaths: options.workspacePaths,
          // La misma orden con la que el cliente inició este puente: tras una
          // actualización con el chat abierto, inicia el programa ya instalado.
          relaunch: { command: process.execPath, args: process.argv.slice(1) },
          // Como la sesión directa: diagnóstico en stderr, una línea JSON por evento.
          log: (level, message, data) => {
            process.stderr.write(`${JSON.stringify({ nivel: level, mensaje: message, ...(data ? { datos: data } : {}), fecha: new Date().toISOString() })}\n`);
          },
        });
        return 0;
      }
      case 'inicio': {
        const layout = await resolveLayout({ base: options.base });
        const { callCentralRpc } = await import('./connector.js');
        const res = await callCentralRpc({
          layout,
          baseDirectory: layout.baseDirectory,
          payload: { accion: 'inicio', paths: options.workspacePaths, cwd: currentDirectory() },
        });
        print({ mind: res.mind, instrucciones: res.instrucciones, destinos: res.destinos, ...(res.aviso_actualizacion ? { aviso_actualizacion: res.aviso_actualizacion } : {}) });
        return 0;
      }
      case 'estado': {
        const layout = await resolveLayout({ base: options.base });
        const { callCentralRpc } = await import('./connector.js');
        const res = await callCentralRpc({
          layout,
          baseDirectory: layout.baseDirectory,
          payload: { accion: 'estado', paths: options.workspacePaths, cwd: currentDirectory() },
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
          payload: { accion: 'herramienta', tool: name, args: parsedArgs, paths: options.workspacePaths, cwd: currentDirectory() },
        });
        print(res.text);
        return res.isError ? 1 : 0;
      }
      case 'autorizar':
      case 'permisos':
      case 'reparar': {
        const consoleModule = await import('./console.js');
        const [action, target, ...paths] = parameters;
        if (command === 'permisos') {
          if (action !== undefined && !['retirar', 'excluir', 'incluir'].includes(action)) {
            throw new MotorError('INVALID_ARGUMENTS', 'Uso: mind permisos [retirar <id|ruta|continuidad> [permisos...]|excluir <id> <subcarpeta>...|incluir <id> <subcarpeta>...]');
          }
          if (action === 'retirar' && !target) {
            throw new MotorError('INVALID_ARGUMENTS', 'Indica la carpeta o "continuidad" para retirar permisos.');
          }
          if (['excluir', 'incluir'].includes(action) && (!target || paths.length === 0)) {
            throw new MotorError('INVALID_ARGUMENTS', `Indica la carpeta y las rutas a ${action}.`);
          }
        }
        if (command !== 'permisos' || ['retirar', 'incluir'].includes(action)) {
          consoleModule.requireInteractive(io.input, io.output);
        }
        const layout = await resolveLayout({ base: options.base });
        const useNative = ['autorizar', 'permisos'].includes(command) && await shouldUseNativeConsole(layout);
        const runWith = useNative
          ? (task) => withNativeConsole(layout, task)
          : (task) => withSession({ ...options, layout }, task);
        return await runWith(async (session) => {
          const prompt = consoleModule.createPrompter(io);
          try {
            if (command === 'autorizar') {
              const folderPath = parameters.find((item) => !item.startsWith('--')) ?? null;
              const requested = ['leer', 'escribir', 'organizar'].filter((level) => parameters.includes(`--${level}`));
              await consoleModule.authorizeConsole({ session, prompt, folderPath, requested: requested.length ? requested : null });
            } else if (command === 'permisos') {
              await consoleModule.permissionsConsole({
                session, prompt,
                revoke: action === 'retirar' ? target ?? null : null,
                revokePermissions: action === 'retirar' && paths.length > 0 ? paths : null,
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
