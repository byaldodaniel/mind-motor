import http from 'node:http';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import {
  MAX_MESSAGE_BYTES,
  PARSE_ERROR,
  INVALID_REQUEST,
  INTERNAL_ERROR,
  rpcError,
  formatError,
  isObject,
  SUPPORTED_PROTOCOL_VERSIONS,
  toolResult,
  toolError,
} from './mcp-core.js';
import { ensureCentralMotor, checkHealthyConnector } from './connector.js';
import { classifyToolPriority, QUEUE_PRIORITY } from './smart-queue.js';
import { MotorError } from './errors.js';
import { currentDirectory } from './paths.js';
import { MOTOR_VERSION } from './version.js';
import { CONNECTION_ID, announcePresence, clientLabel, newConnectionId } from './connections.js';

const CONNECTION_ENV = 'MIND_CONEXION';

/** Fallos de arranque deterministas: repetir no los resuelve, el usuario debe intervenir. */
const STARTUP_GUIDANCE = Object.freeze({
  BASE_TOO_NEW: 'La Base fue creada por una versión más reciente de Mind. Pide al usuario que actualice Mind con "mind actualizar <paquete>"; esta versión no la modificará.',
  BASE_MARKER_CORRUPT: 'La marca de formato de la Base está dañada. No se modificó nada. Pide al usuario que la restaure desde un respaldo con "mind respaldo restaurar".',
  RUNTIME_MISSING: 'Falta un componente incluido de Mind. Pide al usuario que vuelva a extraer el paquete de Mind.',
  INVALID_BASE: 'La ubicación de la Base no es válida. Pide al usuario que revise la carpeta Base de Mind.',
  BASE_OVERLAPS_MOTOR: 'La Base no puede estar dentro del Motor. Pide al usuario que revise la instalación.',
});
const TRANSIENT_GUIDANCE = 'Mind lo intentará de nuevo en la próxima llamada. Si persiste, pide al usuario que ejecute "mind estado" en la carpeta de Mind para ver el detalle, o "mind reparar" si cerró Mind de forma abrupta.';

/** Respuestas HTTP con las que el Motor rechaza una petición sin procesarla. */
const REJECTED_STATUS = new Set([401, 404, 503]);
const INIT_TIMEOUT_MS = 30_000;
const PING_TIMEOUT_MS = 10_000;
const INIT_RETRY_DELAY_MS = 300;
const SSE_RETRY_MIN_MS = 1_000;
const SSE_RETRY_MAX_MS = 30_000;
const RELAY_INIT_ID = 'mind-relevo-initialize';
const RELAY_ENV = 'MIND_BRIDGE_RELAYED';
const MAX_RELAYS = 3;

function hasRequestId(message) {
  return Object.hasOwn(message, 'id') && (typeof message.id === 'string' || Number.isInteger(message.id));
}

function isJsonRpcReply(value) {
  return isObject(value) && value.jsonrpc === '2.0' && (Object.hasOwn(value, 'result') || Object.hasOwn(value, 'error'));
}

function isPermanentStartupFailure(error) {
  return error instanceof MotorError && Object.hasOwn(STARTUP_GUIDANCE, error.code);
}

/**
 * Peticiones que pueden repetirse sin riesgo aunque el Motor ya las hubiera
 * recibido: el protocolo, la lista de herramientas y las herramientas de solo
 * lectura. Una escritura nunca se repite a ciegas.
 */
function isRepeatable(message) {
  if (['initialize', 'ping', 'tools/list'].includes(message.method)) return true;
  if (message.method !== 'tools/call') return false;
  const name = message.params?.name;
  const args = isObject(message.params?.arguments) ? message.params.arguments : {};
  return typeof name === 'string' && classifyToolPriority(name, args) === QUEUE_PRIORITY.READ;
}

function connectionLostError() {
  return new MotorError(
    'MOTOR_CONNECTION_LOST',
    'Se perdió la conexión con el Motor de Mind mientras ejecutaba la operación; no se sabe si terminó. Compruébalo antes de repetirla.',
  );
}

function unavailableError(status) {
  if (status === 401) return new MotorError('MOTOR_UNAUTHORIZED', 'El Motor de Mind rechazó las credenciales locales. Vuelve a intentarlo en unos segundos.');
  return new MotorError('MOTOR_UNAVAILABLE', 'El Motor de Mind no está disponible en este momento. Vuelve a intentarlo en unos segundos.');
}

function badResponseError(status) {
  return new MotorError('MOTOR_BAD_RESPONSE', `El Motor de Mind respondió de forma inesperada (HTTP ${status}).`);
}

function createSseParser(onEventData) {
  let buffer = '';
  let dataLines = [];

  function flushEvent() {
    if (dataLines.length === 0) return;
    const payload = dataLines.join('\n');
    dataLines = [];
    if (payload.trim()) onEventData(payload);
  }

  return {
    push(chunk) {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        if (line === '') {
          flushEvent();
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).replace(/^ /, ''));
        }
        // Comentarios (":") y otros campos se ignoran.
      }
    },
    end() {
      flushEvent();
    },
  };
}

function parseSseJson(onMessage) {
  return createSseParser((raw) => {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return; // Ignora eventos no JSON.
    }
    onMessage(message);
  });
}

function authHeaders({ port, token, sessionId }) {
  return {
    Host: `127.0.0.1:${port}`,
    Authorization: `Bearer ${token}`,
    ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
  };
}

/**
 * POST /mcp por una conexión nueva (`agent: false`). Sin reutilizar sockets no
 * hay conexiones keep-alive caducadas que fallen con ECONNRESET espurios, y
 * `delivered` es fiable: indica si el socket llegó a conectar, es decir, si el
 * Motor pudo recibir la petición. En loopback el coste de abrir conexión es
 * despreciable frente al de una herramienta.
 */
function postMcp(state, body, { headers = {}, onEvent, timeoutMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const serialized = JSON.stringify(body);
    let connected = false;
    let settled = false;
    let timer = null;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      callback(value);
    };
    const fail = (error) => settle(reject, Object.assign(error ?? new Error('Conexión cerrada.'), { delivered: connected }));

    const req = http.request({
      agent: false,
      host: '127.0.0.1',
      port: state.port,
      method: 'POST',
      path: '/mcp',
      headers: {
        ...authHeaders(state),
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': String(Buffer.byteLength(serialized, 'utf8')),
        ...headers,
      },
    }, (res) => {
      const status = res.statusCode ?? 0;
      const sessionId = typeof res.headers['mcp-session-id'] === 'string' ? res.headers['mcp-session-id'] : state.sessionId ?? null;
      let ended = false;
      res.on('error', fail);
      res.on('close', () => {
        if (!ended) fail(Object.assign(new Error('Respuesta interrumpida.'), { code: 'ECONNRESET' }));
      });
      if (String(res.headers['content-type'] ?? '').includes('text/event-stream')) {
        res.setEncoding('utf8');
        const parser = parseSseJson((message) => onEvent?.(message));
        res.on('data', (chunk) => parser.push(chunk));
        res.on('end', () => {
          ended = true;
          parser.end();
          settle(resolve, { status, sessionId, body: null, streamed: true });
        });
        return;
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        ended = true;
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try {
          parsed = text.trim() ? JSON.parse(text) : null;
        } catch {
          parsed = null;
        }
        settle(resolve, { status, sessionId, body: parsed, streamed: false });
      });
    });
    req.on('socket', (socket) => {
      if (!socket.connecting) connected = true;
      else socket.once('connect', () => { connected = true; });
    });
    req.on('error', fail);
    if (timeoutMs > 0) {
      timer = setTimeout(() => req.destroy(Object.assign(new Error('Tiempo agotado.'), { code: 'ETIMEDOUT' })), timeoutMs);
      timer.unref?.();
    }
    req.end(serialized);
  });
}

function deleteSession(state) {
  return new Promise((done) => {
    const req = http.request({
      agent: false,
      host: '127.0.0.1',
      port: state.port,
      method: 'DELETE',
      path: '/mcp',
      headers: authHeaders(state),
    }, (res) => { res.resume(); res.on('end', done); res.on('error', done); });
    const timer = setTimeout(() => { req.destroy(); done(); }, 500);
    timer.unref?.();
    req.on('close', () => clearTimeout(timer));
    req.on('error', done);
    req.end();
  });
}

/**
 * Puente fino stdio <-> HTTP/SSE hacia el Motor Central único.
 * No carga sesión, observadores ni indexador: mide unos 58 MB RSS (casi todo el
 * propio Node) por cliente que dependa de stdio, frente al Motor completo. Si el
 * Motor se autoapagó por inactividad, lo despierta y abre otra sesión sin que el
 * cliente lo note.
 *
 * Garantías:
 * - Cada petición con `id` recibe exactamente una respuesta JSON-RPC.
 * - Solo se repite una petición si es seguro: no llegó al Motor, el Motor la
 *   rechazó sin procesarla (401, 404 de sesión, 503) o es idempotente.
 * - Nada se reenvía hasta que el Motor recibió `initialize` y
 *   `notifications/initialized`, en ese orden.
 * - `ping` y el flujo SSE nunca despiertan un Motor apagado.
 * - Un fallo de arranque solo es definitivo si es determinista; en otro caso cada
 *   llamada posterior vuelve a intentarlo, compartiendo un único intento.
 * - Si Mind se actualiza con el chat abierto, este proceso sigue ejecutando el
 *   programa anterior. Al volver a conectar y encontrar un Motor de otra versión,
 *   cede el trabajo a un puente del programa instalado (`relaunch`: la misma orden
 *   con la que el cliente lo inició) y se limita a pasar mensajes, de modo que un
 *   puente antiguo nunca tiene que entenderse con un Motor más nuevo.
 */
export async function runMcpBridge({
  layout,
  workspacePaths = [],
  cwd = currentDirectory(),
  input = process.stdin,
  output = process.stdout,
  relaunch = null,
  log = () => {},
  // Identificador estable de este chat. Un puente relevo recibe el de su puente padre.
  connectionId = CONNECTION_ID.test(process.env[CONNECTION_ENV] ?? '') ? process.env[CONNECTION_ENV] : newConnectionId(),
  presence = !process.env[RELAY_ENV],
} = {}) {
  // Cabecera de ámbito: base64url(UTF-8 JSON). Una ruta puede tener cualquier
  // carácter Unicode (日本語, acentos NFD de macOS) y las cabeceras HTTP no.
  const workspaceHeader = {
    'X-Mind-Workspace': Buffer.from(JSON.stringify({ cwd, paths: workspacePaths, conexion: connectionId }), 'utf8').toString('base64url'),
  };
  // Presencia fuera de la Base: el chat se ve abierto aunque el Motor esté apagado.
  const announced = presence && layout ? await announcePresence({ layout, id: connectionId, cwd }) : null;

  let closed = false;
  let buffer = '';
  let initMessage = null; // initialize del cliente, para reabrir sesión
  let clientInitialized = false; // el cliente envió notifications/initialized
  let remote = null; // { port, token, sessionId } de la sesión vigente en el Motor
  let connecting = null; // único intento de conexión en curso
  let permanentFailure = null;
  let toolsReduced = false; // el cliente vio la lista de respaldo
  let sse = null; // { req, timer }
  let sseFailures = 0;
  let hadSession = false; // este puente ya tuvo una sesión con un Motor
  let relay = null; // puente del programa instalado al que se cedió el trabajo
  let relayStarting = null;
  let relays = 0;
  const canRelay = () => relaunch && !process.env[RELAY_ENV] && relays < MAX_RELAYS;

  function writeMessage(message) {
    if (closed || !message || output.destroyed || output.writableEnded) return;
    output.write(`${JSON.stringify(message)}\n`);
  }

  // --- Relevo tras una actualización con el chat abierto ---

  /**
   * Inicia un puente con el programa instalado y le repite el saludo del cliente.
   * Desde entonces todo mensaje pasa por él en ambos sentidos. Si ese proceso
   * termina, las peticiones que tenía pendientes reciben un error y la siguiente
   * vuelve a decidir (otro relevo, o directo si se agotaron).
   */
  function startRelay() {
    relayStarting ??= new Promise((resolve) => {
      relays += 1;
      const pending = new Set();
      let ready = false;
      let text = '';
      const child = spawn(relaunch.command, relaunch.args, {
        stdio: ['pipe', 'pipe', 'inherit'],
        windowsHide: true,
        env: { ...process.env, [RELAY_ENV]: '1', [CONNECTION_ENV]: connectionId },
      });
      const handle = {
        child,
        forward(message) {
          if (isObject(message) && typeof message.method === 'string' && hasRequestId(message)) pending.add(message.id);
          child.stdin.write(`${JSON.stringify(message)}\n`);
        },
      };
      // Un relevo que no saluda a tiempo se descarta y se atiende directamente.
      const startupLimit = setTimeout(() => child.kill(), INIT_TIMEOUT_MS);
      startupLimit.unref?.();
      const finish = (active) => {
        if (ready) return;
        ready = true;
        clearTimeout(startupLimit);
        relayStarting = null;
        if (active) {
          relay = handle;
          if (clientInitialized) handle.forward({ jsonrpc: '2.0', method: 'notifications/initialized' });
          log('info', 'Mind se actualizó con el chat abierto: el puente cede el trabajo al programa instalado', { version: MOTOR_VERSION });
        }
        resolve(active);
      };
      child.stdin.on('error', () => {});
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        text += chunk;
        let newline;
        while ((newline = text.indexOf('\n')) >= 0) {
          const line = text.slice(0, newline).replace(/\r$/, '');
          text = text.slice(newline + 1);
          if (!line.trim()) continue;
          let message = null;
          try { message = JSON.parse(line); } catch { /* se pasa tal cual */ }
          if (isJsonRpcReply(message)) {
            if (message.id === RELAY_INIT_ID) { finish(true); continue; } // el cliente ya recibió su saludo
            pending.delete(message.id);
          }
          if (!closed && !output.destroyed && !output.writableEnded) output.write(`${line}\n`);
        }
      });
      const ended = () => {
        if (relay === handle) relay = null;
        for (const id of pending) writeMessage(formatError(id, rpcError(INTERNAL_ERROR, connectionLostError().message, { codigo: 'MOTOR_CONNECTION_LOST' })));
        pending.clear();
        finish(false);
      };
      child.once('error', ended);
      child.once('exit', ended);
      child.stdin.write(`${JSON.stringify({ ...initMessage, id: RELAY_INIT_ID })}\n`);
    });
    return relayStarting;
  }

  function writeBodies(body) {
    for (const item of Array.isArray(body) ? body : [body]) {
      if (isObject(item) && item.jsonrpc === '2.0') writeMessage(item);
    }
  }

  // --- Flujo SSE de la sesión (peticiones y avisos del Motor sin POST asociado) ---

  function closeSse() {
    if (!sse) return;
    if (sse.timer) clearTimeout(sse.timer);
    try { sse.req?.destroy(); } catch {}
    sse = null;
  }

  function openSse(state) {
    closeSse();
    if (closed || remote !== state) return;
    const handle = { req: null, timer: null };
    let finished = false;
    const finish = (statusCode) => {
      if (finished) return;
      finished = true;
      if (sse !== handle || closed || remote !== state) return;
      // La sesión ya no existe, o el Motor se apaga o cambió de credenciales.
      if (REJECTED_STATUS.has(statusCode)) {
        invalidate(state);
        return;
      }
      scheduleSseReopen(state, handle);
    };
    handle.req = http.request({
      agent: false,
      host: '127.0.0.1',
      port: state.port,
      method: 'GET',
      path: '/mcp',
      headers: { ...authHeaders(state), Accept: 'text/event-stream' },
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        finish(res.statusCode);
        return;
      }
      sseFailures = 0;
      res.setEncoding('utf8');
      const parser = parseSseJson(writeMessage);
      res.on('data', (chunk) => parser.push(chunk));
      res.on('end', () => { parser.end(); finish(null); });
      res.on('error', () => finish(null));
      res.on('close', () => finish(null));
    });
    handle.req.on('error', () => finish(null));
    handle.req.end();
    sse = handle;
  }

  /** Reabre el flujo con espera creciente, solo si el mismo Motor sigue vivo. */
  function scheduleSseReopen(state, handle) {
    const wait = Math.min(SSE_RETRY_MIN_MS * 2 ** sseFailures, SSE_RETRY_MAX_MS);
    sseFailures += 1;
    handle.req = null;
    handle.timer = setTimeout(async () => {
      handle.timer = null;
      if (sse !== handle || closed || remote !== state) return;
      const healthy = await checkHealthyConnector(layout.baseDirectory).catch(() => null);
      if (sse !== handle || closed || remote !== state) return;
      if (!healthy || healthy.state.port !== state.port || healthy.token !== state.token) {
        invalidate(state); // El Motor se apagó: lo despertará la próxima petición.
        return;
      }
      openSse(state);
    }, wait);
    handle.timer.unref?.();
  }

  // --- Sesión remota ---

  function invalidate(state) {
    if (!state || remote !== state) return;
    remote = null;
    closeSse();
  }

  async function deliverInitialized(state) {
    const res = await postMcp(state, { jsonrpc: '2.0', method: 'notifications/initialized' }, { timeoutMs: INIT_TIMEOUT_MS });
    if (res.status !== 202 && res.status !== 200) throw badResponseError(res.status);
  }

  /** Despierta el Motor si hace falta, abre sesión y, si procede, la deja inicializada. */
  async function establish() {
    for (let attempt = 0; ; attempt += 1) {
      const conn = await ensureCentralMotor({ layout, baseDirectory: layout.baseDirectory });
      const motorVersion = conn.health?.motorVersion;
      const motorRevision = conn.health?.packageRevision;
      const bridgeRevision = layout?.manifest?.packageRevision ?? 0;
      const changedRelease = (motorVersion && motorVersion !== MOTOR_VERSION)
        || (Number.isSafeInteger(motorRevision) && motorRevision !== bridgeRevision);
      if (hadSession && changedRelease) {
        if (canRelay()) throw new MotorError('BRIDGE_OUTDATED', 'Mind se actualizó mientras este chat estaba abierto.', { motor: motorVersion, revisionMotor: motorRevision, puente: MOTOR_VERSION, revisionPuente: bridgeRevision });
        log('aviso', 'El Motor Central es de otra versión que este puente', { motor: motorVersion, puente: MOTOR_VERSION });
      }
      const base = { port: conn.state.port, token: conn.token, sessionId: null };
      let reply = null;
      let res;
      try {
        res = await postMcp(base, initMessage, {
          headers: workspaceHeader,
          timeoutMs: INIT_TIMEOUT_MS,
          onEvent: (event) => {
            if (isJsonRpcReply(event) && event.id === initMessage.id) reply = event;
            else writeMessage(event);
          },
        });
      } catch (error) {
        // El Motor pudo apagarse entre la comprobación de salud y el POST.
        if (!error.delivered && attempt === 0) { await delay(50); continue; }
        throw unavailableError(null);
      }
      if (REJECTED_STATUS.has(res.status) && attempt === 0) { await delay(50); continue; }
      reply ??= isJsonRpcReply(res.body) ? res.body : null;
      if (res.status !== 200 || !res.sessionId || !reply) throw badResponseError(res.status);
      const state = { ...base, sessionId: res.sessionId };
      if (clientInitialized) await deliverInitialized(state);
      return { state, reply };
    }
  }

  /** Un único intento de conexión compartido por todas las peticiones simultáneas. */
  function connect() {
    if (!connecting) {
      connecting = establish().then((result) => {
        remote = result.state;
        hadSession = true;
        sseFailures = 0;
        openSse(result.state);
        if (toolsReduced) {
          toolsReduced = false;
          writeMessage({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
        }
        return result;
      }, (error) => {
        if (isPermanentStartupFailure(error)) permanentFailure = error;
        throw error;
      }).finally(() => {
        connecting = null;
      });
    }
    return connecting;
  }

  async function obtainRemote() {
    if (remote) return remote;
    if (permanentFailure) throw permanentFailure;
    return (await connect()).state;
  }

  // --- Respuestas cuando Mind no pudo iniciarse ---

  function startupReport(error) {
    const known = error instanceof MotorError;
    const code = known ? error.code : 'STARTUP_FAILED';
    return {
      code,
      message: known ? error.message : 'Mind no pudo iniciarse.',
      guidance: STARTUP_GUIDANCE[code] ?? TRANSIENT_GUIDANCE,
    };
  }

  function replyStartupFailure(message, error) {
    const { code, message: text, guidance } = startupReport(error);
    if (message.method === 'initialize') {
      const requested = message.params?.protocolVersion;
      writeMessage({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0],
          // Si el fallo es pasajero, la lista completa llegará con list_changed.
          capabilities: { tools: { listChanged: !isPermanentStartupFailure(error) } },
          serverInfo: { name: 'mind', title: 'Mind', version: MOTOR_VERSION },
          instructions: `[${code}] ${text} ${guidance}`,
        },
      });
      return;
    }
    if (message.method === 'tools/list') {
      if (!isPermanentStartupFailure(error)) toolsReduced = true;
      writeMessage({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          tools: [{
            name: 'estado',
            title: 'Estado de Mind',
            description: 'Informa el estado actual de Mind y el motivo por el que no pudo iniciarse.',
            inputSchema: { type: 'object', additionalProperties: false },
          }],
        },
      });
      return;
    }
    if (message.method === 'tools/call') {
      const report = { error: { codigo: code, mensaje: text }, base: layout?.baseDirectory ?? null, que_hacer: guidance };
      writeMessage({ jsonrpc: '2.0', id: message.id, result: { ...toolResult(report), isError: true } });
      return;
    }
    writeMessage(formatError(message.id, rpcError(INTERNAL_ERROR, `[${code}] ${text}`, { codigo: code })));
  }

  /** Fallo de comunicación con el Motor ya iniciado: error de herramienta o JSON-RPC. */
  function replyFailure(message, error) {
    if (message.method === 'tools/call') {
      writeMessage({ jsonrpc: '2.0', id: message.id, result: toolError(error) });
      return;
    }
    const code = error instanceof MotorError ? error.code : 'ERROR_INTERNO';
    writeMessage(formatError(message.id, rpcError(INTERNAL_ERROR, error?.message ?? 'Error interno de Mind.', { codigo: code })));
  }

  // --- Manejo de mensajes del cliente ---

  async function handleInitialize(message) {
    invalidate(remote);
    initMessage = message;
    void announced?.update({ cliente: clientLabel(message.params?.clientInfo) });
    clientInitialized = false;
    permanentFailure = null;
    toolsReduced = false;
    let lastError = null;
    // Un reintento breve cubre el caso común de un Motor que se apagaba justo ahora.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const { reply } = await connect();
        writeMessage({ ...reply, id: message.id });
        return;
      } catch (error) {
        lastError = error;
        // Un tiempo agotado ya esperó el arranque completo; no se dobla la espera.
        if (isPermanentStartupFailure(error) || error?.code === 'MOTOR_START_TIMEOUT') break;
        if (attempt === 0) await delay(INIT_RETRY_DELAY_MS);
      }
    }
    log('error', 'Error al despertar Motor Central desde puente stdio', { codigo: lastError?.code ?? null, error: String(lastError) });
    if (!isPermanentStartupFailure(lastError)) toolsReduced = true;
    replyStartupFailure(message, lastError);
  }

  async function handleInitialized() {
    clientInitialized = true;
    const state = remote;
    if (!state) return; // Se entregará al abrir la sesión.
    try {
      await deliverInitialized(state);
    } catch (error) {
      log('error', 'No se pudo entregar notifications/initialized al Motor Central', { error: String(error) });
      invalidate(state); // La próxima petición abrirá otra sesión ya inicializada.
    }
  }

  /** ping nunca despierta al Motor: sin sesión viva responde el propio puente. */
  async function handlePing(message) {
    const state = remote;
    if (state) {
      try {
        const res = await postMcp(state, message, { timeoutMs: PING_TIMEOUT_MS });
        if (REJECTED_STATUS.has(res.status)) {
          invalidate(state);
        } else if (isJsonRpcReply(res.body)) {
          writeMessage(res.body);
          return;
        }
      } catch (error) {
        if (!error.delivered) invalidate(state);
      }
    }
    writeMessage({ jsonrpc: '2.0', id: message.id, result: {} });
  }

  /**
   * Notificaciones y respuestas a peticiones del Motor: solo tienen sentido en la
   * sesión vigente, así que se entregan a ella sin despertar ni repetir.
   */
  async function handlePassThrough(message) {
    const state = remote;
    if (!state) return;
    try {
      const res = await postMcp(state, message);
      if (REJECTED_STATUS.has(res.status)) invalidate(state);
      else if (res.body !== null) writeBodies(res.body);
    } catch (error) {
      if (!error.delivered) invalidate(state);
    }
  }

  async function handleRequest(message) {
    if (!initMessage) {
      writeMessage(formatError(message.id, rpcError(INVALID_REQUEST, 'La sesión no se inicializó.')));
      return;
    }
    const repeatable = isRepeatable(message);
    let reconnects = 0;
    let resets = 0;
    for (;;) {
      let state;
      try {
        state = await obtainRemote();
      } catch (error) {
        if (error?.code === 'BRIDGE_OUTDATED') {
          if (await startRelay()) { relay.forward(message); return; }
          continue; // El relevo no arrancó: se atiende directamente.
        }
        replyStartupFailure(message, error);
        return;
      }
      let answered = false;
      let res;
      try {
        res = await postMcp(state, message, {
          onEvent: (event) => {
            if (isJsonRpcReply(event) && event.id === message.id) answered = true;
            writeMessage(event);
          },
        });
      } catch (error) {
        if (!error.delivered) {
          // No llegó al Motor: repetir es seguro tras reabrir la sesión.
          invalidate(state);
          if (reconnects++ < 1) continue;
          replyFailure(message, unavailableError(null));
          return;
        }
        if (repeatable && resets++ < 1) continue;
        replyFailure(message, connectionLostError());
        return;
      }
      if (REJECTED_STATUS.has(res.status)) {
        invalidate(state);
        if (reconnects++ < 1) continue;
        replyFailure(message, unavailableError(res.status));
        return;
      }
      if (res.streamed) {
        if (answered) return;
        // El flujo terminó sin la respuesta: el Motor pudo cerrarse a mitad.
        if (repeatable && resets++ < 1) continue;
        replyFailure(message, connectionLostError());
        return;
      }
      const replies = (Array.isArray(res.body) ? res.body : [res.body]).filter(isJsonRpcReply);
      if (replies.length === 0) {
        replyFailure(message, badResponseError(res.status));
        return;
      }
      replies.forEach(writeMessage);
      return;
    }
  }

  async function handleMessage(message) {
    if (!isObject(message) || message.jsonrpc !== '2.0') {
      writeMessage(formatError(isObject(message) ? message.id ?? null : null, rpcError(INVALID_REQUEST, 'Mensaje JSON-RPC no válido.')));
      return;
    }
    if (relayStarting) await relayStarting;
    if (relay) return relay.forward(message);
    const isRequest = typeof message.method === 'string' && hasRequestId(message);
    if (isRequest && message.method === 'initialize') return handleInitialize(message);
    if (message.method === 'notifications/initialized') return handleInitialized();
    if (!isRequest) return handlePassThrough(message);
    if (message.method === 'ping') return handlePing(message);
    return handleRequest(message);
  }

  // --- Lectura de stdin ---

  const inFlight = new Set();
  // initialize y notifications/initialized hacen de barrera: lo posterior espera
  // a que el Motor los haya recibido. El resto se atiende en paralelo, porque
  // una herramienta puede esperar una respuesta del cliente (elicitation).
  let barrier = Promise.resolve();

  function dispatch(message) {
    const isBarrier = isObject(message) && (message.method === 'initialize' || message.method === 'notifications/initialized');
    const task = barrier
      .then(() => handleMessage(message))
      .catch((error) => log('error', 'Fallo en puente MCP', { error: String(error?.stack ?? error) }));
    if (isBarrier) barrier = task;
    inFlight.add(task);
    task.finally(() => inFlight.delete(task));
  }

  function processLine(line) {
    if (line.trim() === '') return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      writeMessage(formatError(null, rpcError(PARSE_ERROR, 'JSON no válido.')));
      return;
    }
    for (const item of Array.isArray(message) ? message : [message]) dispatch(item);
  }

  input.setEncoding?.('utf8');
  input.on('data', (chunk) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer, 'utf8') > MAX_MESSAGE_BYTES && !buffer.includes('\n')) {
      buffer = '';
      writeMessage(formatError(null, rpcError(INVALID_REQUEST, 'El mensaje supera el tamaño admitido.')));
      return;
    }
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      processLine(line);
    }
  });

  await new Promise((resolve) => {
    let ended = false;
    const end = async () => {
      if (ended) return;
      ended = true;
      if (buffer.trim()) {
        processLine(buffer.replace(/\r$/, ''));
        buffer = '';
      }
      if (inFlight.size > 0) {
        // Sin `ref`, la espera máxima no retiene el proceso cuando todo terminó antes.
        await Promise.race([Promise.allSettled([...inFlight]), delay(25_000, undefined, { ref: false })]);
      }
      if (relayStarting) await relayStarting;
      if (relay) {
        // El puente relevo termina por sí mismo al cerrarse su entrada.
        const { child } = relay;
        const exited = new Promise((done) => child.once('exit', done));
        child.stdin.end();
        await Promise.race([exited, delay(25_000, undefined, { ref: false })]);
        if (child.exitCode === null && child.signalCode === null) child.kill();
      }
      closed = true;
      closeSse();
      const state = remote;
      remote = null;
      if (state) await deleteSession(state);
      await announced?.remove();
      resolve();
    };
    input.on('end', end);
    input.on('close', end);
    input.on('error', end);
  });
}
