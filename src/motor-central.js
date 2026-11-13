import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { MOTOR_VERSION } from './version.js';
import { MotorError } from './errors.js';
import { ensureBase } from './base-format.js';
import { openSession } from './session.js';
import { createWorkspaceAccess } from './workspace-access.js';
import { createAgentTools, AGENT_INSTRUCTIONS } from './agent-tools.js';
import { acquireOwnerFileLock } from './process-identity.js';
import { createMcpProcessor, MAX_MESSAGE_BYTES, formatError, rpcError, INVALID_REQUEST, PARSE_ERROR, toolResult, toolError } from './mcp-core.js';
import { createSmartQueue, QUEUE_PRIORITY, classifyToolPriority, resolveToolResourceKeys } from './smart-queue.js';
import {
  baseIdOf,
  preferredPort,
  canonicalBaseDirectory,
  connectorPaths,
  readOrCreateSecret,
  writeConnectorState,
  removeConnectorState,
  writeJsonAtomic,
  checkHealthyConnector,
} from './connector.js';

const DEFAULT_LIGHT_IDLE_MS = 3 * 60_000;
const DEFAULT_SHUTDOWN_IDLE_MS = 10 * 60_000;
const SSE_HEARTBEAT_MS = 25_000;
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

function parseHeaderPaths(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item) => typeof item === 'string' && item.trim() !== '');
  } catch {
    return [];
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
  observe = true,
  log = () => {},
  onShutdown,
} = {}) {
  let canonicalBase = await canonicalBaseDirectory(layout.baseDirectory);
  try {
    const validated = await ensureBase(layout.baseDirectory, {
      motorVersion,
      protectedFrom: layout.motorDirectory,
    });
    canonicalBase = validated.baseDirectory;
  } catch (error) {
    const { errorFile } = connectorPaths(canonicalBase);
    if (error instanceof MotorError) {
      await writeJsonAtomic(errorFile, {
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
        at: new Date().toISOString(),
      }).catch(() => {});
    }
    throw error;
  }
  const { lockFile, errorFile } = connectorPaths(canonicalBase);
  const lockAttempt = await acquireConnectorLock(lockFile, canonicalBase, layout.pythonExecutable);
  if (lockAttempt.alreadyRunning) {
    return { alreadyRunning: true, ...lockAttempt.existing, stop: async () => false };
  }

  const releaseLock = lockAttempt.release;
  await fs.rm(errorFile, { force: true }).catch(() => {});

  let session = null;
  let httpServer = null;
  let boundPort = null;
  let shuttingDown = false;
  let shutdownPromise = null;
  let shutdown = null;
  let activeWork = 0;
  let activityState = 'active';
  let lastActivityAt = Date.now();
  let lightIdleTimer = null;
  let shutdownIdleTimer = null;
  const mcpSessions = new Map();
  const inFlight = new Set();

  function clearIdleTimers() {
    clearTimeout(lightIdleTimer);
    clearTimeout(shutdownIdleTimer);
    lightIdleTimer = null;
    shutdownIdleTimer = null;
  }

  function scheduleIdleTimers() {
    clearIdleTimers();
    if (shuttingDown || activeWork > 0) return;
    if (Number.isFinite(idleLightMs) && idleLightMs > 0) {
      lightIdleTimer = setTimeout(() => {
        if (shuttingDown || activeWork > 0) return;
        activityState = 'light-idle';
        (session?.pauseIdle?.() ?? session?.clearCaches?.())?.catch?.(() => {});
      }, idleLightMs);
      lightIdleTimer.unref?.();
    }
    if (Number.isFinite(idleShutdownMs) && idleShutdownMs > 0) {
      shutdownIdleTimer = setTimeout(() => {
        if (shuttingDown || activeWork > 0) return;
        shutdown('idle-timeout').catch((error) => log('error', 'Error en autoapagado por inactividad', { error: String(error) }));
      }, idleShutdownMs);
      shutdownIdleTimer.unref?.();
    }
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

  try {
    const smartQueue = createSmartQueue();
    session = await openSession({ layout, motorVersion, log, observe, backgroundGate: smartQueue });
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

    function createIsolatedMcpSession({ workspacePaths = [], cwd = process.cwd() } = {}) {
      const id = randomUUID();
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
        instructions: AGENT_INSTRUCTIONS,
        tools(connection) {
          const tools = createAgentTools({ session: workspace.session, connection, log });
          const fallbackDir = workspacePaths[0] ?? cwd;
          return {
            definitions: tools.definitions,
            call(name, args, context) {
              return executeToolWithQueue(
                name,
                args,
                async () => {
                  await workspace.beforeCall(name, args);
                  return tools.call(name, args, context);
                },
                { signal: context?.signal, fallbackDir },
              );
            },
          };
        },
        onInitialized: async (connection) => {
          await session.start();
          await session.sync();
          await workspace.initialize(connection);
        },
        onRootsChanged: (connection) => workspace.refresh(connection),
        onClose: async () => {
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

      const sessionHeader = typeof req.headers['mcp-session-id'] === 'string' ? req.headers['mcp-session-id'] : '';
      let mcpSession;

      if (sessionHeader) {
        mcpSession = mcpSessions.get(sessionHeader);
        if (!mcpSession) {
          return sendJson(res, 404, { jsonrpc: '2.0', error: { code: -32001, message: 'Sesión MCP no encontrada.' } });
        }
      } else if (!Array.isArray(body) && body?.method === 'initialize') {
        const workspacePaths = parseHeaderPaths(req.headers['x-mind-workspace-paths']);
        const headerCwd = typeof req.headers['x-mind-cwd'] === 'string' && req.headers['x-mind-cwd'].trim()
          ? req.headers['x-mind-cwd']
          : process.cwd();
        mcpSession = createIsolatedMcpSession({ workspacePaths, cwd: headerCwd });
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
      const runMessages = async () => {
        const replies = [];
        for (const message of messages) {
          const reply = await mcpSession.processor.dispatchOne(message, { route });
          if (reply !== null) replies.push(reply);
        }
        return replies;
      };
      const replies = isKeepaliveMcpBody(body)
        ? await runMessages()
        : await trackWork(runMessages);

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

      const cleanup = () => {
        clearInterval(keepAlive);
        mcpSession.sseStreams.delete(res);
      };
      req.on('close', cleanup);
      res.on('close', cleanup);
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

      if (body.accion === 'apagar') {
        if (body.soloSiInactivo === true && activeWork > 0) {
          return sendJson(res, 200, {
            ok: false,
            busy: true,
            activeRequests: activeWork,
            sessions: mcpSessions.size,
          });
        }
        sendJson(res, 200, { ok: true, apagando: true });
        setImmediate(() => {
          shutdown('rpc').catch((error) => log('error', 'Error al apagar Motor Central por RPC', { error: String(error) }));
        });
        return;
      }

      const workspacePaths = parseRpcPaths(body.paths);
      const cwd = typeof body.cwd === 'string' && body.cwd.trim() ? body.cwd : process.cwd();
      const conn = nonElicitingConnection();

      try {
        return await trackWork(async () => {
          await session.start();
          await session.sync();
          const workspace = createWorkspaceAccess(session, { paths: workspacePaths, cwd, log });
          await workspace.initialize({ clientCapabilities: {} });
          const tools = createAgentTools({ session: workspace.session, connection: conn, log });
          const controller = new AbortController();
          req.on('close', () => {
            if (!res.writableEnded) controller.abort();
          });

          const fallbackDir = workspacePaths[0] ?? cwd;

          if (body.accion === 'inicio') {
            const formatted = toolResult(await executeToolWithQueue(
              'destinos_consultar',
              {},
              () => tools.call('destinos_consultar', {}, { signal: controller.signal, connection: conn }),
              { signal: controller.signal, fallbackDir },
            ));
            return sendJson(res, 200, {
              ok: true,
              mind: layout?.manifest?.mindVersion ?? motorVersion,
              motor: motorVersion,
              instrucciones: AGENT_INSTRUCTIONS,
              destinos: formatted.structuredContent,
            });
          }

          if (body.accion === 'estado') {
            let formatted;
            try {
              formatted = toolResult(await executeToolWithQueue(
                'estado',
                {},
                () => tools.call('estado', {}, { signal: controller.signal, connection: conn }),
                { signal: controller.signal, fallbackDir },
              ));
            } catch (error) {
              formatted = toolError(error);
            }
            return sendJson(res, 200, { ok: true, value: formatted.structuredContent, text: formatted.content[0].text, isError: formatted.isError === true });
          }

          if (body.accion === 'herramienta') {
            const name = typeof body.tool === 'string' ? body.tool : '';
            const args = body.args === undefined ? {} : body.args;
            if (!name || !tools.definitions.some((tool) => tool.name === name)) {
              return sendJson(res, 400, { ok: false, error: { codigo: 'INVALID_ARGUMENTS', mensaje: `Herramienta desconocida: ${name}. Disponibles: ${tools.definitions.map((tool) => tool.name).join(', ')}.` } });
            }
            if (!args || typeof args !== 'object' || Array.isArray(args)) {
              return sendJson(res, 400, { ok: false, error: { codigo: 'INVALID_ARGUMENTS', mensaje: 'Los argumentos deben ser un objeto JSON.' } });
            }
            let formatted;
            try {
              formatted = toolResult(await executeToolWithQueue(
                name,
                args,
                async () => {
                  await workspace.beforeCall(name, args);
                  return tools.call(name, args, { signal: controller.signal, connection: conn });
                },
                { signal: controller.signal, fallbackDir },
              ));
            } catch (error) {
              formatted = toolError(error);
            }
            return sendJson(res, 200, { ok: true, value: formatted.structuredContent, text: formatted.content[0].text, isError: formatted.isError === true });
          }

          return sendJson(res, 400, { ok: false, error: { codigo: 'UNKNOWN_RPC_ACTION', mensaje: `Acción no admitida: ${body.accion}` } });
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
        sendJson(res, 200, {
          ok: true,
          baseId,
          port: boundPort,
          pid: process.pid,
          motorVersion,
          startedAt,
          state: activityState,
          activeRequests: activeWork,
          lastActivityAt,
          sessions: mcpSessions.size,
          queue: smartQueue.status(),
        });
        return;
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

    await writeConnectorState(canonicalBase, {
      baseId,
      port: boundPort,
      pid: process.pid,
      motorVersion,
      startedAt,
      url: `http://127.0.0.1:${boundPort}/mcp`,
    });

    scheduleIdleTimers();

    shutdown = async function shutdown(reason = 'manual') {
      if (shutdownPromise) return shutdownPromise;
      shutdownPromise = (async () => {
        shuttingDown = true;
        clearIdleTimers();
        await removeConnectorState(canonicalBase);
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
        await onShutdown?.(reason);
        return { stopped: true, reason };
      })();
      return shutdownPromise;
    };

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
    const { errorFile: targetErrorFile } = connectorPaths(canonicalBase);
    if (error instanceof MotorError) {
      await writeJsonAtomic(targetErrorFile, {
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
        at: new Date().toISOString(),
      }).catch(() => {});
    }
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
  let shuttingDown = false;
  let motor;
  const finish = new Promise((resolve, reject) => {
    startCentralMotor({
      ...options,
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
      process.once('SIGINT', () => onSignal('SIGINT'));
      process.once('SIGTERM', () => onSignal('SIGTERM'));
    }, reject);
  });

  const reason = await finish;
  if (motor?.alreadyRunning) return { status: 'already-running', port: motor.state?.port ?? motor.port };
  return { status: 'stopped', reason };
}
