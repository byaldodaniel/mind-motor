import http from 'node:http';
import path from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { MOTOR_VERSION } from './version.js';
import { MotorError } from './errors.js';
import { BASE_FORMAT_VERSION, ensureBase, prepareBaseFormat, readBaseMarker } from './base-format.js';
import { releaseOf } from './package-descriptor.js';
import { takeUpdateReport } from './update-handoff.js';
import { openSession } from './session.js';
import { createNativeContinuityStore } from './continuity-reader.js';
import { createWorkspaceAccess } from './workspace-access.js';
import { createAgentTools, AGENT_INSTRUCTIONS } from './agent-tools.js';
import { catalogMode, instructionsFor, withCatalog } from './core-catalog.js';
import { acquireOwnerFileLock } from './process-identity.js';
import { createMcpProcessor, MAX_MESSAGE_BYTES, formatError, rpcError, INVALID_REQUEST, PARSE_ERROR, toolResult, toolError } from './mcp-core.js';
import { createSmartQueue, QUEUE_PRIORITY, classifyToolPriority, resolveToolResourceKeys } from './smart-queue.js';
import { LAUNCH_ENV, independenceOf } from './independent-launch.js';
import {
  CONNECTION_ID, QUIET_MS, createConnectionRegistry, connectionSummary, listPresence, quietness,
} from './connections.js';
import { takeNotice } from './update-assistant.js';
import {
  readConnectorState,
  baseIdOf,
  preferredPort,
  canonicalBaseDirectory,
  connectorPaths,
  readOrCreateSecret,
  writeConnectorState,
  removeConnectorState,
  writeStartupError,
  checkHealthyConnector,
  healthProof,
  HEALTH_NONCE_PATTERN,
} from './connector.js';

const DEFAULT_LIGHT_IDLE_MS = 60_000;
const DEFAULT_SHUTDOWN_IDLE_MS = 0;
// Prórroga máxima del reposo y del autoapagado mientras hay trabajo de fondo en curso
// (un recorrido inicial grande o la preparación semántica). Acotada: un trabajo
// atascado no mantiene el Motor despierto para siempre.
const DEFAULT_BACKGROUND_GRACE_MS = 30 * 60_000;
const BACKGROUND_RECHECK_MS = 15_000;
// Una sesión MCP sin flujo abierto, sin peticiones y sin actividad se da por abandonada
// (su puente murió sin despedirse). Un puente vivo que vuelva recibe 404 y se reinicializa.
const DEFAULT_SESSION_IDLE_MS = 15 * 60_000;
// Al apagar, lo ya admitido dispone de este margen para terminar antes de cerrar la sesión.
const DEFAULT_SHUTDOWN_DRAIN_MS = 5_000;
const SSE_HEARTBEAT_MS = 25_000;
// Descubrir actualizaciones: un rato después de encender (la primera llamada del chat
// va antes) y luego cada 6 h mientras el Motor siga vivo. El propio estado respeta
// su intervalo, así que encender muchas veces al día no multiplica las consultas.
const DEFAULT_DISCOVER_DELAY_MS = 20_000;
const DISCOVER_INTERVAL_MS = 6 * 60 * 60_000;
const LOCK_WAIT_TIMEOUT_MS = 20_000;

function serverInfo(motorVersion) {
  return { name: 'mind', title: 'Mind', version: motorVersion };
}

function sendJson(res, status, payload, headers = {}) {
  if (res.writableEnded) return;
  const body = payload === undefined ? '' : JSON.stringify(payload);
  res.writeHead(status, {
    ...(payload === undefined ? {} : { 'Content-Type': 'application/json; charset=utf-8' }),
    ...headers,
  });
  res.end(body);
}

function constantTimeTokenMatch(headerValue, expectedToken) {
  if (typeof headerValue !== 'string' || !headerValue.startsWith('Bearer ')) return false;
  const candidate = headerValue.slice('Bearer '.length);
  const a = Buffer.from(candidate, 'utf8');
  const b = Buffer.from(expectedToken, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function parseBody(req, maxBytes = MAX_MESSAGE_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let rejected = false;
    req.on('data', (chunk) => {
      if (rejected) return;
      total += chunk.length;
      if (total > maxBytes) {
        rejected = true;
        reject(Object.assign(new Error('Cuerpo demasiado grande.'), { httpStatus: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (rejected) return;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) {
        reject(Object.assign(new Error('JSON vacío.'), { httpStatus: 400 }));
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('JSON no válido.'), { httpStatus: 400, parseError: true }));
      }
    });
    req.on('error', (error) => {
      if (!rejected) reject(error);
    });
  });
}

/**
 * Ámbito de trabajo declarado por el puente: `X-Mind-Workspace` lleva
 * base64url(UTF-8 JSON {"cwd": string, "paths": string[]}). Las cabeceras HTTP
 * solo admiten Latin-1, y una ruta puede tener cualquier carácter Unicode.
 * Sin cabecera válida no hay ámbito: nunca se hereda el directorio del Motor.
 */
export function parseWorkspaceHeader(raw) {
  const empty = { cwd: null, paths: [], conexion: null, declared: false };
  if (typeof raw !== 'string' || !raw.trim()) return empty;
  try {
    const parsed = JSON.parse(Buffer.from(raw.trim(), 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return empty;
    return {
      cwd: typeof parsed.cwd === 'string' && parsed.cwd.trim() ? parsed.cwd : null,
      paths: parseRpcPaths(parsed.paths),
      // Identificador estable del chat (lo genera su puente); ampliación compatible del contrato.
      conexion: typeof parsed.conexion === 'string' && CONNECTION_ID.test(parsed.conexion) ? parsed.conexion : null,
      declared: true,
    };
  } catch {
    return empty;
  }
}

function parseRpcPaths(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter((item) => typeof item === 'string' && item.trim() !== '');
}

function nonElicitingConnection() {
  return { clientCapabilities: {}, supportsFormElicitation: () => false };
}

async function acquireConnectorLock(lockFile, baseDirectory, pythonExecutable, waitMs = LOCK_WAIT_TIMEOUT_MS) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const healthy = await checkHealthyConnector(baseDirectory);
    if (healthy) return { alreadyRunning: true, existing: healthy };
    try {
      const release = await acquireOwnerFileLock(lockFile, { pythonExecutable, timeoutMs: 0 });
      return { alreadyRunning: false, release };
    } catch (error) {
      if (error?.code !== 'LOCK_BUSY' || Date.now() >= deadline) throw error;
      await delay(40);
    }
  }
}

async function bindLoopbackPort(server, portToTry) {
  const tryListen = (port) => new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve(server.address().port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });

  try {
    return await tryListen(portToTry);
  } catch (error) {
    if (portToTry !== 0 && ['EADDRINUSE', 'EACCES'].includes(error?.code)) {
      return await tryListen(0);
    }
    throw error;
  }
}

/**
 * Arranca el proceso único del Motor Central en HTTP loopback (127.0.0.1) con `/mcp`,
 * `/rpc` y `/health`, manteniendo `conector.lock` desde antes de abrir la sesión hasta
 * después de liberar todos sus bloqueos e índices.
 */
export async function startCentralMotor({
  layout,
  motorVersion = MOTOR_VERSION,
  preferredPort: explicitPort,
  idleLightMs = DEFAULT_LIGHT_IDLE_MS,
  idleShutdownMs = DEFAULT_SHUTDOWN_IDLE_MS,
  backgroundGraceMs = DEFAULT_BACKGROUND_GRACE_MS,
  sessionIdleMs = DEFAULT_SESSION_IDLE_MS,
  shutdownDrainMs = DEFAULT_SHUTDOWN_DRAIN_MS,
  observe = true,
  verificationToken = null,
  publishConnector = true,
  errorFile = null,
  sessionFactory = openSession,
  readContinuityText,
  writeNativeText,
  log = () => {},
  onShutdown,
  launchMechanism = process.env[LAUNCH_ENV] ?? 'directo',
  discoverDelayMs = DEFAULT_DISCOVER_DELAY_MS,
  discoverUpdates = null,
  updateRoot = undefined,
  // Ventana sin peticiones reales que exige la regla de quietud (las pruebas la acortan).
  quietMs = Number.isSafeInteger(Number(process.env.MIND_QUIETUD_MS)) && Number(process.env.MIND_QUIETUD_MS) >= 0 && process.env.MIND_QUIETUD_MS !== ''
    ? Number(process.env.MIND_QUIETUD_MS) : QUIET_MS,
} = {}) {
  let canonicalBase = await canonicalBaseDirectory(layout.baseDirectory);
  try {
    const validated = await ensureBase(layout.baseDirectory, {
      motorVersion,
      protectedFrom: layout.motorDirectory,
    });
    canonicalBase = validated.baseDirectory;
  } catch (error) {
    await writeStartupError(errorFile, error);
    throw error;
  }
  const { lockFile } = connectorPaths(canonicalBase);
  const lockAttempt = await acquireConnectorLock(lockFile, canonicalBase, layout.pythonExecutable);
  if (lockAttempt.alreadyRunning) {
    return { alreadyRunning: true, ...lockAttempt.existing, stop: async () => false };
  }

  const releaseLock = lockAttempt.release;

  let session = null;
  let httpServer = null;
  let boundPort = null;
  let shuttingDown = false;
  let shutdownPromise = null;
  let activeWork = 0;
  let activityState = 'active';
  let lastActivityAt = Date.now();
  let sessionSweep = null;
  let discoverTimer = null;
  const idleTimers = { light: null, shutdown: null };
  const mcpSessions = new Map();
  const connections = createConnectionRegistry();
  const inFlight = new Set();

  function clearIdleTimers() {
    clearTimeout(idleTimers.light);
    clearTimeout(idleTimers.shutdown);
    idleTimers.light = null;
    idleTimers.shutdown = null;
  }

  /** El trabajo de fondo en curso aplaza el reposo y el apagado, con un tope. */
  function backgroundHolds(idleMs) {
    return session?.isBackgroundBusy?.() === true && Date.now() - lastActivityAt < idleMs + backgroundGraceMs;
  }

  function armIdle(name, idleMs, action, delayMs = idleMs) {
    if (!Number.isFinite(idleMs) || idleMs <= 0) return;
    idleTimers[name] = setTimeout(() => {
      idleTimers[name] = null;
      if (shuttingDown || activeWork > 0) return;
      if (backgroundHolds(idleMs)) {
        armIdle(name, idleMs, action, Math.min(idleMs, BACKGROUND_RECHECK_MS));
        return;
      }
      action();
    }, delayMs);
    idleTimers[name].unref?.();
  }

  function scheduleIdleTimers() {
    clearIdleTimers();
    if (shuttingDown || activeWork > 0) return;
    armIdle('light', idleLightMs, () => {
      activityState = 'light-idle';
      Promise.resolve().then(() => session?.pauseIdle?.())
        .catch((error) => log('aviso', 'No se pudo entrar en reposo ligero', { error: String(error) }));
    });
    armIdle('shutdown', idleShutdownMs, () => {
      shutdown('idle-timeout').catch((error) => log('error', 'Error en autoapagado por inactividad', { error: String(error) }));
    });
  }

  /**
   * Apagado ordenado. Deja de anunciarse, concede un margen a lo ya admitido, cierra
   * las sesiones MCP y el servidor, y solo entonces cierra la sesión compartida y
   * libera `conector.lock`. Lo que llegue durante el apagado recibe 503 y se reintenta
   * contra el Motor siguiente.
   */
  function shutdown(reason = 'manual') {
    shutdownPromise ??= (async () => {
      shuttingDown = true;
      clearIdleTimers();
      clearInterval(sessionSweep);
      clearTimeout(discoverTimer);
      await removeConnectorState(canonicalBase);
      const drainDeadline = Date.now() + shutdownDrainMs;
      while (activeWork > 0 && Date.now() < drainDeadline) await delay(25);
      await Promise.allSettled([...mcpSessions.values()].map((entry) => entry.processor.close()));
      mcpSessions.clear();
      if (httpServer) {
        httpServer.closeIdleConnections?.();
        await Promise.race([
          new Promise((resolve) => httpServer.close(() => resolve())),
          delay(1_500),
        ]);
        httpServer.closeAllConnections?.();
      }
      if (inFlight.size > 0) {
        await Promise.race([Promise.allSettled([...inFlight]), delay(2_000)]);
      }
      await session?.close().catch((error) => log('error', 'Error al cerrar sesión central', { error: String(error) }));
      await releaseLock().catch(() => {});
      log('info', 'Motor Central detenido', { motivo: reason });
      await onShutdown?.(reason);
      return { stopped: true, reason };
    })();
    return shutdownPromise;
  }

  function trackInFlight(promise) {
    inFlight.add(promise);
    promise.finally(() => {
      inFlight.delete(promise);
    });
    return promise;
  }

  async function trackWork(fn) {
    activeWork += 1;
    clearIdleTimers();
    if (activityState !== 'active') {
      activityState = 'active';
      session?.resumeIdle?.();
    }
    lastActivityAt = Date.now();
    try {
      return await fn();
    } finally {
      activeWork = Math.max(0, activeWork - 1);
      lastActivityAt = Date.now();
      if (activeWork === 0 && !shuttingDown) scheduleIdleTimers();
    }
  }

  function isKeepaliveMcpBody(body) {
    const items = Array.isArray(body) ? body : [body];
    return items.length > 0 && items.every((item) => item && typeof item === 'object' && item.method === 'ping');
  }

  // Un `conector.json` que sobrevive a su Motor significa que este no se apagó en
  // orden (cliente cerrado, equipo apagado, proceso terminado a la fuerza). Se
  // registra para poder medirlo; la Base ya está protegida por sus propios bloqueos.
  const previous = await readConnectorState(canonicalBase);
  const previousEnd = previous && previous.pid !== process.pid
    ? { cierre: 'abrupto', pid: previous.pid, iniciado: previous.startedAt ?? null, version: previous.motorVersion ?? null }
    : { cierre: 'ordenado' };
  if (previousEnd.cierre === 'abrupto') log('aviso', 'El Motor anterior terminó sin cierre ordenado', previousEnd);
  const launch = { mecanismo: launchMechanism, independencia: independenceOf(launchMechanism) };

  try {
    const smartQueue = createSmartQueue();
    session = await sessionFactory({
      layout, motorVersion, log, observe, backgroundGate: smartQueue,
      ...(readContinuityText === undefined ? {} : { readContinuityText }),
      ...(writeNativeText === undefined ? {} : { writeNativeText }),
    });
    const baseId = baseIdOf(canonicalBase);
    const token = await readOrCreateSecret(canonicalBase);
    const startedAt = new Date().toISOString();

    async function resolveFolderKey(ref, fallbackDir) {
      const candidate = typeof ref === 'string' && ref.trim() ? ref.trim() : null;
      if (candidate && /^[a-f0-9]{64}$/.test(candidate)) return candidate;
      const folders = await session.motor.listAuthorizedFolders().catch(() => []);
      const norm = (value) => (process.platform === 'win32'
        ? path.normalize(value).toLowerCase()
        : path.normalize(value));
      if (candidate) {
        const target = norm(candidate);
        const hit = folders.find((folder) => norm(folder.path) === target);
        return hit ? hit.id : target;
      }
      if (folders.length === 1) return folders[0].id;
      if (typeof fallbackDir === 'string' && fallbackDir.trim()) {
        const target = norm(fallbackDir.trim());
        const hit = folders.find((folder) => {
          const fp = norm(folder.path);
          return target === fp || target.startsWith(fp.endsWith(path.sep) ? fp : fp + path.sep);
        });
        if (hit) return hit.id;
      }
      return 'default';
    }

    function executeToolWithQueue(name, args, runFn, { signal, fallbackDir } = {}) {
      if (classifyToolPriority(name, args) === QUEUE_PRIORITY.READ) {
        return smartQueue.runRead(runFn, { signal });
      }
      return smartQueue.runWrite(
        () => resolveToolResourceKeys(name, args, (ref) => resolveFolderKey(ref, fallbackDir)),
        runFn,
        { signal },
      );
    }

    /**
     * Mientras una herramienta espera al usuario (un formulario de confirmación puede
     * tardar minutos), no retiene la exclusión de su carpeta: los demás chats siguen
     * leyendo y escribiendo en ella, como cuando cada chat era un proceso aparte. La
     * exclusión se recupera antes de que la herramienta continúe.
     */
    function releasingLocksWhileAsking(connection, sessionId = null) {
      return new Proxy(connection, {
        get(target, property, receiver) {
          if (property !== 'request') return Reflect.get(target, property, receiver);
          return (method, params, options) => smartQueue.suspendWhile(async () => {
            // Un formulario abierto en un chat impide sustituir el programa: el usuario está decidiendo.
            const done = method === 'elicitation/create' && sessionId ? connections.asking(sessionId) : () => {};
            try { return await target.request(method, params, options); } finally { done(); }
          });
        },
      });
    }

    /** Conexiones de los chats: sesiones del Motor más puentes abiertos sin sesión ahora. */
    async function connectionReport({ asking = null, ownWork = 0 } = {}) {
      const presence = await listPresence(layout).catch(() => []);
      const entries = connections.list({ asking });
      // `activeWork` cuenta las peticiones de las sesiones y las de /rpc (consola,
      // agentes sin MCP). Lo que no es de ninguna sesión, menos la propia llamada, es /rpc.
      const rpcWork = Math.max(0, activeWork - totalSessionWork() - ownWork);
      return {
        conexiones: connectionSummary(entries, presence, { quietMs }),
        quietud: quietness(entries, { activeWork: rpcWork, quietMs }),
      };
    }

    function totalSessionWork() {
      let total = 0;
      for (const entry of connections.list()) total += entry.enCurso;
      return total;
    }

    /** Ejecuta una herramienta de un ámbito por la cola. `estado` añade quién la atiende. */
    async function runTool({ tools, workspace, fallbackDir, sessionId = null, conexion = null }, name, args, context) {
      let value = await executeToolWithQueue(name, args, async () => {
        await workspace.beforeCall(name, args);
        return tools.call(name, args, context);
      }, { signal: context?.signal, fallbackDir });
      if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
      const acta = await takeUpdateReport({ layout, conexion }).catch(error => ({ estado: 'error-acta', error: { codigo: error.code, mensaje: error.message } }));
      if (acta) value = { ...value, acta_actualizacion: acta };
      // La consulta con la que empieza cada conversación lleva, una vez, el aviso de una entrega nueva.
      if (name === 'destinos_consultar') {
        const aviso = await takeNotice({ layout, conexion });
        return aviso ? { ...value, aviso_actualizacion: aviso } : value;
      }
      if (name !== 'estado') return value;
      const report = await connectionReport({ asking: sessionId, ownWork: sessionId ? 0 : 1 });
      // Permite detectar un puente de una versión hablando con un Motor de otra.
      return { ...value, motor_central: { version: motorVersion, pid: process.pid, estado: activityState, sesiones: mcpSessions.size,
        independencia: launch.independencia, lanzamiento: launch.mecanismo, cierre_anterior: previousEnd },
      conexiones: report.conexiones, quietud: report.quietud };
    }

    function createIsolatedMcpSession({ workspacePaths = [], cwd = null, conexion = null, declared = false, catalogo = null } = {}) {
      const id = randomUUID();
      // Catálogo núcleo (1.0.5) salvo que el cliente pida el completo de r3 (?catalogo=completo).
      const mode = catalogMode(catalogo);
      // Con cabecera de ámbito habla un puente de Mind; sin ella, un cliente por HTTP directo.
      connections.open(id, { conexion, transporte: declared ? 'puente' : 'http', carpeta: cwd ?? workspacePaths[0] ?? null });
      const workspace = createWorkspaceAccess(session, { paths: workspacePaths, cwd, log });
      const sseStreams = new Set();
      const pendingSse = [];

      function emitSse(res, message) {
        if (res.writableEnded || res.destroyed) return false;
        res.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
        return true;
      }

      function routeOutgoing(message, route) {
        if (route && route.canStream) {
          route.sendSse(message);
          return;
        }
        for (const stream of sseStreams) {
          if (emitSse(stream, message)) return;
        }
        if (pendingSse.length < 64) pendingSse.push(message);
      }

      const processor = createMcpProcessor({
        serverInfo: serverInfo(motorVersion),
        instructions: instructionsFor(mode, AGENT_INSTRUCTIONS),
        tools(connection) {
          const scope = {
            tools: createAgentTools({ session: workspace.session, connection: releasingLocksWhileAsking(connection, id), log }),
            workspace,
            fallbackDir: workspacePaths[0] ?? cwd,
            sessionId: id,
            // Sin puente (HTTP directo) la conversación es la sesión MCP.
            conexion: conexion ?? `sesion:${id}`,
          };
          return withCatalog({
            definitions: scope.tools.definitions,
            call: (name, args, context) => runTool(scope, name, args, context),
          }, mode);
        },
        onInitialized: async (connection) => {
          connections.identify(id, connection.clientInfo, connection.clientCapabilities);
          await session.start();
          await session.sync();
          await workspace.initialize(connection);
        },
        onRootsChanged: (connection) => workspace.refresh(connection),
        onClose: async () => {
          connections.close(id);
          await workspace.close().catch(() => {});
          for (const stream of sseStreams) {
            try { stream.end(); } catch {}
          }
          sseStreams.clear();
          pendingSse.length = 0;
        },
        send: routeOutgoing,
        log,
      });

      const entry = {
        id,
        processor,
        workspace,
        sseStreams,
        activeRequests: 0,
        lastSeenAt: Date.now(),
        flushPendingSse(stream) {
          while (pendingSse.length > 0 && !stream.writableEnded) {
            emitSse(stream, pendingSse.shift());
          }
        },
      };
      mcpSessions.set(id, entry);
      return entry;
    }

    async function handleMcpPost(req, res) {
      let body;
      try {
        body = await parseBody(req);
      } catch (error) {
        if (error?.parseError) return sendJson(res, 400, formatError(null, rpcError(PARSE_ERROR, 'JSON no válido.')));
        return sendJson(res, error?.httpStatus ?? 400, formatError(null, rpcError(INVALID_REQUEST, error?.message ?? 'Petición no válida.')));
      }

      if (!Array.isArray(body) && body?.method === 'server/discover') {
        return sendJson(res, 404, { error: 'DISCOVERY_NOT_SUPPORTED' });
      }
      // El apagado pudo empezar mientras llegaba el cuerpo: no se admite trabajo nuevo.
      if (shuttingDown) return sendJson(res, 503, { error: 'MOTOR_SHUTTING_DOWN' }, { Connection: 'close' });

      const sessionHeader = typeof req.headers['mcp-session-id'] === 'string' ? req.headers['mcp-session-id'] : '';
      let mcpSession;

      if (sessionHeader) {
        mcpSession = mcpSessions.get(sessionHeader);
        if (!mcpSession) {
          return sendJson(res, 404, { jsonrpc: '2.0', error: { code: -32001, message: 'Sesión MCP no encontrada.' } });
        }
      } else if (!Array.isArray(body) && body?.method === 'initialize') {
        const declared = parseWorkspaceHeader(req.headers['x-mind-workspace']);
        const requestedCatalog = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('catalogo');
        mcpSession = createIsolatedMcpSession({ workspacePaths: declared.paths, cwd: declared.cwd, conexion: declared.conexion, declared: declared.declared, catalogo: requestedCatalog });
      } else {
        return sendJson(res, 400, formatError(body?.id ?? null, rpcError(INVALID_REQUEST, 'Falta cabecera Mcp-Session-Id.')));
      }

      if (Array.isArray(body) && body.length === 0) {
        return sendJson(res, 400, formatError(null, rpcError(INVALID_REQUEST, 'Lote JSON-RPC vacío.')));
      }

      const acceptsSse = String(req.headers.accept ?? '').includes('text/event-stream');
      let streamed = false;
      const route = {
        canStream: acceptsSse,
        sendSse(message) {
          if (res.writableEnded || res.destroyed) return;
          if (!streamed) {
            streamed = true;
            res.writeHead(200, {
              'Content-Type': 'text/event-stream; charset=utf-8',
              'Cache-Control': 'no-cache',
              Connection: 'keep-alive',
              'Mcp-Session-Id': mcpSession.id,
            });
          }
          res.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
        },
      };

      const messages = Array.isArray(body) ? body : [body];
      // Si el cliente corta antes de recibir la respuesta, sus llamadas en curso se cancelan.
      res.on('close', () => {
        if (res.writableFinished) return;
        for (const message of messages) {
          if (message && typeof message === 'object' && message.method === 'tools/call') mcpSession.processor.cancel(message.id);
        }
      });
      const runMessages = async () => {
        const replies = [];
        for (const message of messages) {
          const reply = await mcpSession.processor.dispatchOne(message, { route });
          if (reply !== null) replies.push(reply);
        }
        return replies;
      };
      let replies;
      mcpSession.activeRequests += 1;
      try {
        replies = isKeepaliveMcpBody(body)
          ? await runMessages()
          : await trackWork(async () => {
            const done = connections.begin(mcpSession.id);
            try { return await runMessages(); } finally { done(); }
          });
      } finally {
        mcpSession.activeRequests -= 1;
        mcpSession.lastSeenAt = Date.now();
      }

      if (res.writableEnded || res.destroyed) return;
      if (replies.length === 0) {
        if (streamed) {
          res.end();
        } else {
          res.writeHead(202, { 'Mcp-Session-Id': mcpSession.id });
          res.end();
        }
        return;
      }

      if (streamed) {
        for (const reply of replies) route.sendSse(reply);
        res.end();
        return;
      }

      sendJson(res, 200, Array.isArray(body) ? replies : replies[0], { 'Mcp-Session-Id': mcpSession.id });
    }

    async function handleMcpGet(req, res) {
      const sessionHeader = typeof req.headers['mcp-session-id'] === 'string' ? req.headers['mcp-session-id'] : '';
      if (!sessionHeader) return sendJson(res, 400, { error: 'MISSING_SESSION_ID' });
      const mcpSession = mcpSessions.get(sessionHeader);
      if (!mcpSession) return sendJson(res, 404, { error: 'SESSION_NOT_FOUND' });

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Mcp-Session-Id': mcpSession.id,
      });
      res.write(': connected\n\n');
      mcpSession.sseStreams.add(res);
      mcpSession.flushPendingSse(res);

      const keepAlive = setInterval(() => {
        if (!res.writableEnded && !res.destroyed) res.write(': ping\n\n');
      }, SSE_HEARTBEAT_MS);
      keepAlive.unref?.();

      res.on('close', () => {
        clearInterval(keepAlive);
        mcpSession.sseStreams.delete(res);
        mcpSession.lastSeenAt = Date.now();
      });
    }

    async function handleMcpDelete(req, res) {
      const sessionHeader = typeof req.headers['mcp-session-id'] === 'string' ? req.headers['mcp-session-id'] : '';
      if (!sessionHeader) return sendJson(res, 400, { error: 'MISSING_SESSION_ID' });
      const mcpSession = mcpSessions.get(sessionHeader);
      if (!mcpSession) return sendJson(res, 404, { error: 'SESSION_NOT_FOUND' });
      mcpSessions.delete(sessionHeader);
      await mcpSession.processor.close();
      sendJson(res, 200, { closed: true });
    }

    async function handleRpcPost(req, res) {
      let body;
      try {
        body = await parseBody(req);
      } catch (error) {
        return sendJson(res, error?.httpStatus ?? 400, { ok: false, error: { codigo: 'BAD_REQUEST', mensaje: error?.message ?? 'Petición no válida.' } });
      }
      if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.accion !== 'string') {
        return sendJson(res, 400, { ok: false, error: { codigo: 'INVALID_RPC', mensaje: 'Se requiere una acción RPC válida.' } });
      }

      if (body.accion === 'verificar-actualizacion' && verificationToken) {
        const marker = await readBaseMarker(canonicalBase);
        const folders = await session.motor.listAuthorizedFolders();
        if (marker && Number(marker.version ?? 0) < BASE_FORMAT_VERSION) {
          for (const folder of folders) {
            await session.motor.readFolderIndex(folder.id);
          }
          await prepareBaseFormat(canonicalBase, BASE_FORMAT_VERSION, { motorVersion: MOTOR_VERSION });
        }
        const finalMarker = (await readBaseMarker(canonicalBase)) ?? marker;
        const continuity = await session.motor.listContinuityIds();
        for (const id of continuity) {
          if (!(await session.motor.getContinuity(id))) throw new MotorError('UPDATE_BASE_READ_FAILED', 'No se pudo leer un registro de continuidad.');
        }
        const functions = await session.motor.listFunctions();
        return sendJson(res, 200, { ok: true, baseDirectory: canonicalBase, baseId: finalMarker.baseId,
          baseFormatVersion: finalMarker.version, release: releaseOf(layout.manifest),
          carpetas: folders.length, continuidad: continuity.length, funciones: functions.length, node: process.execPath, python: layout.pythonExecutable });
      }
      if (verificationToken) return sendJson(res, 503, { error: 'UPDATE_VERIFICATION_ONLY' });

      if (body.accion === 'ping') {
        return sendJson(res, 200, {
          ok: true,
          pid: process.pid,
          baseId,
          port: boundPort,
          sessions: mcpSessions.size,
          state: activityState,
          activeRequests: activeWork,
        });
      }

      // Para quien va a sustituir el programa: ¿hay algún chat trabajando o decidiendo?
      if (body.accion === 'quietud') {
        const report = await connectionReport();
        return sendJson(res, 200, { ok: true, ...report.quietud, conexiones: report.conexiones, quietMs });
      }

      if (body.accion === 'apagar') {
        if (body.soloSiQuieto === true) {
          const { quietud } = await connectionReport();
          if (!quietud.quieto) return sendJson(res, 200, { ok: false, busy: true, impiden: quietud.impiden });
        }
        if (body.soloSiInactivo === true && activeWork > 0) {
          return sendJson(res, 200, {
            ok: false,
            busy: true,
            activeRequests: activeWork,
            sessions: mcpSessions.size,
          });
        }
        // El apagado empieza antes de responder: desde este instante, lo que llegue
        // recibe 503 y se repite contra el Motor siguiente.
        const motivo = typeof body.motivo === 'string' && /^[a-z-]{1,40}$/u.test(body.motivo) ? body.motivo : 'rpc';
        shutdown(motivo).catch((error) => log('error', 'Error al apagar Motor Central por RPC', { error: String(error) }));
        sendJson(res, 200, { ok: true, apagando: true }, { Connection: 'close' });
        return;
      }

      if (!['inicio', 'estado', 'herramienta'].includes(body.accion)) {
        return sendJson(res, 400, { ok: false, error: { codigo: 'UNKNOWN_RPC_ACTION', mensaje: `Acción no admitida: ${body.accion}` } });
      }
      // El apagado pudo empezar mientras llegaba el cuerpo: no se admite trabajo nuevo.
      if (shuttingDown) return sendJson(res, 503, { error: 'MOTOR_SHUTTING_DOWN' }, { Connection: 'close' });

      const workspacePaths = parseRpcPaths(body.paths);
      const cwd = typeof body.cwd === 'string' && body.cwd.trim() ? body.cwd : null;
      const conn = nonElicitingConnection();
      // Si quien llama se va antes de recibir la respuesta, la operación se cancela.
      const controller = new AbortController();
      res.on('close', () => {
        if (!res.writableFinished) controller.abort();
      });
      const context = { signal: controller.signal, connection: conn };
      const sendToolResult = (formatted) => sendJson(res, 200, {
        ok: true, value: formatted.structuredContent, text: formatted.content[0].text, isError: formatted.isError === true,
      });

      let workspace = null;
      try {
        return await trackWork(async () => {
          await session.start();
          await session.sync();
          workspace = createWorkspaceAccess(session, { paths: workspacePaths, cwd, log });
          await workspace.initialize({ clientCapabilities: {} });
          const scope = {
            tools: createAgentTools({ session: workspace.session, connection: conn, log }),
            workspace,
            fallbackDir: workspacePaths[0] ?? cwd,
          };

          if (body.accion === 'inicio') {
            const { aviso_actualizacion: aviso = null, ...destinos } = await runTool(scope, 'destinos_consultar', {}, context);
            const formatted = toolResult(destinos);
            return sendJson(res, 200, {
              ok: true,
              mind: layout?.manifest?.mindVersion ?? motorVersion,
              motor: motorVersion,
              instrucciones: AGENT_INSTRUCTIONS,
              destinos: formatted.structuredContent,
              ...(aviso ? { aviso_actualizacion: aviso } : {}),
            });
          }

          const name = body.accion === 'estado' ? 'estado' : (typeof body.tool === 'string' ? body.tool : '');
          const args = body.accion === 'estado' || body.args === undefined ? {} : body.args;
          if (!name || !scope.tools.definitions.some((tool) => tool.name === name)) {
            return sendJson(res, 400, { ok: false, error: { codigo: 'INVALID_ARGUMENTS', mensaje: `Herramienta desconocida: ${name}. Disponibles: ${scope.tools.definitions.map((tool) => tool.name).join(', ')}.` } });
          }
          if (!args || typeof args !== 'object' || Array.isArray(args)) {
            return sendJson(res, 400, { ok: false, error: { codigo: 'INVALID_ARGUMENTS', mensaje: 'Los argumentos deben ser un objeto JSON.' } });
          }
          try {
            return sendToolResult(toolResult(await runTool(scope, name, args, context)));
          } catch (error) {
            if (!(error instanceof MotorError)) log('error', 'Fallo inesperado en una herramienta', { tool: name, error: String(error?.stack ?? error) });
            return sendToolResult(toolError(error));
          }
        });
      } catch (error) {
        const known = error instanceof MotorError;
        return sendJson(res, 200, {
          ok: false,
          error: {
            codigo: known ? error.code : 'ERROR_INTERNO',
            mensaje: known ? error.message : String(error?.message ?? 'Error interno de Mind.'),
            ...(known && error.details ? { detalles: error.details } : {}),
          },
        });
      } finally {
        await workspace?.close?.().catch(() => {});
      }
    }

    httpServer = http.createServer((req, res) => {
      if (req.headers.origin !== undefined) {
        sendJson(res, 403, { error: 'ORIGIN_NOT_ALLOWED' }, { Connection: 'close' });
        return;
      }
      if (req.headers.host !== `127.0.0.1:${boundPort}`) {
        sendJson(res, 403, { error: 'HOST_NOT_ALLOWED' }, { Connection: 'close' });
        return;
      }

      const url = new URL(req.url ?? '/', `http://127.0.0.1:${boundPort}`);

      if (url.pathname === '/health' && req.method === 'GET') {
        if (shuttingDown) {
          sendJson(res, 503, { ok: false, shuttingDown: true }, { Connection: 'close' });
          return;
        }
        const nonce = url.searchParams.get('nonce');
        sendJson(res, 200, {
          ok: true,
          baseId,
          port: boundPort,
          ...(nonce && HEALTH_NONCE_PATTERN.test(nonce) ? { proof: healthProof(token, nonce, baseId, boundPort) } : {}),
          pid: process.pid,
          motorVersion,
          packageRevision: layout.manifest?.packageRevision ?? 0,
          startedAt,
          state: activityState,
          activeRequests: activeWork,
          lastActivityAt,
          sessions: mcpSessions.size,
          backgroundBusy: session.isBackgroundBusy?.() === true,
          queue: smartQueue.status(),
          independence: launch.independencia,
          launch: launch.mecanismo,
          previousEnd: previousEnd.cierre,
        });
        return;
      }

      if (verificationToken && (url.pathname !== '/rpc' || req.headers['x-mind-update-verification'] !== verificationToken)) {
        return sendJson(res, 503, { error: 'UPDATE_VERIFICATION_ONLY' }, { Connection: 'close' });
      }
      if (!constantTimeTokenMatch(req.headers.authorization, token)) {
        sendJson(res, 401, { error: 'UNAUTHORIZED' }, { 'WWW-Authenticate': 'Bearer' });
        return;
      }

      if (shuttingDown) {
        sendJson(res, 503, { error: 'MOTOR_SHUTTING_DOWN' }, { Connection: 'close' });
        return;
      }

      if (url.pathname === '/mcp') {
        if (req.method === 'GET') {
          handleMcpGet(req, res).catch((error) => {
            log('error', 'Fallo en SSE /mcp', { error: String(error) });
            if (!res.headersSent) sendJson(res, 500, { error: 'INTERNAL_ERROR' });
          });
          return;
        }
        if (req.method === 'POST') {
          trackInFlight(handleMcpPost(req, res).catch((error) => {
            log('error', 'Fallo en POST /mcp', { error: String(error) });
            if (!res.headersSent) sendJson(res, 500, { error: 'INTERNAL_ERROR' });
          }));
          return;
        }
        if (req.method === 'DELETE') {
          trackInFlight(handleMcpDelete(req, res).catch((error) => {
            log('error', 'Fallo en DELETE /mcp', { error: String(error) });
            if (!res.headersSent) sendJson(res, 500, { error: 'INTERNAL_ERROR' });
          }));
          return;
        }
        sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });
        return;
      }

      if (url.pathname === '/rpc') {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });
          return;
        }
        trackInFlight(handleRpcPost(req, res).catch((error) => {
          log('error', 'Fallo en POST /rpc', { error: String(error) });
          if (!res.headersSent) sendJson(res, 500, { error: 'INTERNAL_ERROR' });
        }));
        return;
      }

      sendJson(res, 404, { error: 'NOT_FOUND' });
    });

    boundPort = await bindLoopbackPort(httpServer, explicitPort ?? preferredPort(baseId));

    if (publishConnector) await writeConnectorState(canonicalBase, {
      baseId,
      port: boundPort,
      pid: process.pid,
      motorVersion,
      startedAt,
      url: `http://127.0.0.1:${boundPort}/mcp`,
    });

    scheduleIdleTimers();

    // Descubrir actualizaciones: solo el canal firmado (unos KB), nunca el paquete,
    // siempre después de estar atendiendo y sin contar como actividad. No mantiene el
    // Motor despierto: sus temporizadores no retienen el proceso.
    const discoverRoot = updateRoot === undefined ? (layout?.product ? layout.root : null) : updateRoot;
    if (discoverRoot && discoverDelayMs >= 0) {
      const discover = async () => {
        if (shuttingDown) return;
        try {
          const run = discoverUpdates ?? (await import('./auto-update.js')).discoverUpdate;
          const result = await run({ root: discoverRoot });
          if (result?.status === 'disponible') log('info', 'Hay una entrega nueva de Mind disponible', { version: result.mindVersion ?? result.release?.mindVersion ?? null });
        } catch (error) {
          log('aviso', 'No se pudo comprobar si hay actualizaciones', { codigo: error?.code ?? null, error: String(error?.message ?? error) });
        }
      };
      discoverTimer = setTimeout(function tick() {
        discover().finally(() => {
          if (shuttingDown) return;
          discoverTimer = setTimeout(tick, DISCOVER_INTERVAL_MS);
          discoverTimer.unref?.();
        });
      }, discoverDelayMs);
      discoverTimer.unref?.();
    }

    // Sesiones abandonadas: su puente murió sin enviar DELETE.
    if (Number.isFinite(sessionIdleMs) && sessionIdleMs > 0) {
      sessionSweep = setInterval(() => {
        const limit = Date.now() - sessionIdleMs;
        for (const [id, entry] of mcpSessions) {
          if (entry.activeRequests > 0 || entry.sseStreams.size > 0 || entry.lastSeenAt > limit) continue;
          mcpSessions.delete(id);
          entry.processor.close().catch(() => {});
        }
      }, Math.min(sessionIdleMs, 60_000));
      sessionSweep.unref?.();
    }

    log('info', 'Motor Central iniciado', { pid: process.pid, puerto: boundPort, version: motorVersion });

    return Object.freeze({
      alreadyRunning: false,
      baseDirectory: canonicalBase,
      baseId,
      port: boundPort,
      token,
      url: `http://127.0.0.1:${boundPort}/mcp`,
      session,
      state: () => activityState,
      lastActivityAt: () => lastActivityAt,
      activeSessionCount: () => mcpSessions.size,
      queueStatus: () => smartQueue.status(),
      stop: shutdown,
    });
  } catch (error) {
    log('error', 'El Motor Central no pudo iniciar', { codigo: error?.code ?? null, error: String(error?.stack ?? error) });
    await writeStartupError(errorFile, error);
    clearIdleTimers();
    clearInterval(sessionSweep);
    clearTimeout(discoverTimer);
    if (httpServer) {
      try { httpServer.closeAllConnections?.(); httpServer.close(); } catch {}
    }
    await removeConnectorState(canonicalBase);
    await session?.close().catch(() => {});
    await releaseLock().catch(() => {});
    throw error;
  }
}

/** Ejecuta el Motor Central como proceso demonio hasta recibir `apagar`, señal o autoapagado por inactividad. */
export async function runCentralMotorDaemon(options = {}) {
  const port = process.env.MIND_PUERTO_LECTURA_CONTINUIDAD;
  const native = port === undefined ? undefined : createNativeContinuityStore({
    port: Number(port), key: process.env.MIND_CLAVE_LECTURA_CONTINUIDAD,
    baseId: baseIdOf(await canonicalBaseDirectory(options.layout.baseDirectory)),
  });
  const useNativeWriter = process.env.MIND_ESCRITURA_NATIVA === '1';
  if (useNativeWriter && !['win32', 'linux'].includes(process.platform)) {
    throw new Error('La actualización segura en Rust está disponible en Windows y Linux.');
  }
  if (useNativeWriter && !native) throw new Error('La escritura nativa requiere el anfitrión de continuidad.');
  let shuttingDown = false;
  let motor;
  const finish = new Promise((resolve, reject) => {
    startCentralMotor({
      ...options,
      readContinuityText: native?.readContinuityText ?? options.readContinuityText,
      writeNativeText: useNativeWriter ? native.writeNativeText : options.writeNativeText,
      onShutdown(reason) {
        resolve(reason);
      },
    }).then((started) => {
      motor = started;
      if (started.alreadyRunning) {
        resolve('already-running');
        return;
      }
      const onSignal = (signal) => {
        if (shuttingDown) return;
        shuttingDown = true;
        started.stop(signal).catch(reject);
      };
      // SIGHUP: en POSIX llega al cerrarse la terminal de quien lanzó el Motor.
      for (const signal of process.platform === 'win32' ? ['SIGINT', 'SIGBREAK'] : ['SIGINT', 'SIGTERM', 'SIGHUP']) {
        process.once(signal, () => onSignal(signal));
      }
    }, reject);
  });

  const reason = await finish;
  if (motor?.alreadyRunning) return { status: 'already-running', port: motor.state?.port ?? motor.port };
  return { status: 'stopped', reason };
}
