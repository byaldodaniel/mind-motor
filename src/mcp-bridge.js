import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import {
  MAX_MESSAGE_BYTES,
  PARSE_ERROR,
  INVALID_REQUEST,
  rpcError,
  formatError,
  isObject,
  SUPPORTED_PROTOCOL_VERSIONS,
  toolResult,
  toolError,
} from './mcp-core.js';
import { ensureCentralMotor } from './connector.js';
import { MotorError } from './errors.js';
import { MOTOR_VERSION } from './version.js';

const STARTUP_GUIDANCE = Object.freeze({
  BASE_TOO_NEW: 'La Base fue creada por una versión más reciente de Mind. Pide al usuario que actualice Mind con "mind actualizar <paquete>"; esta versión no la modificará.',
  BASE_MARKER_CORRUPT: 'La marca de formato de la Base está dañada. No se modificó nada. Pide al usuario que la restaure desde un respaldo con "mind respaldo restaurar".',
  RUNTIME_MISSING: 'Falta un componente incluido de Mind. Pide al usuario que vuelva a extraer el paquete de Mind.',
  INVALID_BASE: 'La ubicación de la Base no es válida. Pide al usuario que revise la carpeta Base de Mind.',
  BASE_OVERLAPS_MOTOR: 'La Base no puede estar dentro del Motor. Pide al usuario que revise la instalación.',
});

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
        } else if (line.startsWith(':')) {
          continue;
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).replace(/^ /, ''));
        }
      }
    },
    end() {
      flushEvent();
    },
  };
}

function httpPostMcp({ port, token, sessionId, headers = {}, body, onSseMessage }) {
  return new Promise((resolve, reject) => {
    const serialized = JSON.stringify(body);
    const reqHeaders = {
      Host: `127.0.0.1:${port}`,
      Authorization: `Bearer ${token}`,
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(Buffer.byteLength(serialized, 'utf8')),
      ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
      ...headers,
    };

    const req = http.request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/mcp',
      headers: reqHeaders,
    }, (res) => {
      const contentType = String(res.headers['content-type'] ?? '');
      const nextSessionId = typeof res.headers['mcp-session-id'] === 'string' ? res.headers['mcp-session-id'] : sessionId;
      if (contentType.includes('text/event-stream')) {
        res.setEncoding('utf8');
        const parser = createSseParser((raw) => {
          try {
            onSseMessage?.(JSON.parse(raw));
          } catch {
            // Ignora eventos no JSON.
          }
        });
        res.on('data', (chunk) => parser.push(chunk));
        res.on('end', () => {
          parser.end();
          resolve({ status: res.statusCode ?? 0, sessionId: nextSessionId, streamed: true, body: null });
        });
        res.on('error', reject);
        return;
      }

      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        if (text.trim()) {
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = null;
          }
        }
        resolve({ status: res.statusCode ?? 0, sessionId: nextSessionId, streamed: false, body: parsed });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.write(serialized);
    req.end();
  });
}

function isRetryableFailure(error, status) {
  if (status === 404 || status === 503 || status === 401) return true;
  return ['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ECONNABORTED'].includes(error?.code);
}

/**
 * Puente fino stdio <-> HTTP/SSE hacia el Motor Central único.
 * No carga sesión, observadores ni indexador en memoria, reduciendo la huella a ~19 MB
 * por cliente que aún dependa de stdio y reconectándose transparentemente si el Motor
 * se autoapagó por inactividad.
 */
export async function runMcpBridge({
  layout,
  workspacePaths = [],
  cwd = process.cwd(),
  input = process.stdin,
  output = process.stdout,
  log = () => {},
} = {}) {
  let closed = false;
  let buffer = '';
  let sessionState = null; // { port, token, sessionId }
  let cachedInitialize = null;
  let initializedNotified = false;
  let fatalStartupError = null;
  let connecting = null;
  let reconnecting = null;
  let sseRequest = null;

  function writeMessage(message) {
    if (closed || !message || output.destroyed || output.writableEnded) return;
    output.write(`${JSON.stringify(message)}\n`);
  }

  function closeSse() {
    if (sseRequest) {
      try { sseRequest.destroy(); } catch {}
      sseRequest = null;
    }
  }

  function openSse({ port, token, sessionId }) {
    closeSse();
    if (closed || !sessionId) return;
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: 'GET',
      path: '/mcp',
      headers: {
        Host: `127.0.0.1:${port}`,
        Authorization: `Bearer ${token}`,
        Accept: 'text/event-stream',
        'Mcp-Session-Id': sessionId,
      },
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return;
      }
      res.setEncoding('utf8');
      const parser = createSseParser((raw) => {
        try {
          writeMessage(JSON.parse(raw));
        } catch {
          // Ignora eventos no JSON.
        }
      });
      res.on('data', (chunk) => parser.push(chunk));
      res.on('end', () => parser.end());
      res.on('error', () => {});
    });
    req.on('error', () => {});
    req.end();
    sseRequest = req;
  }

  async function initializeOnCentral(initMessage, { replayInitializedNotification = false } = {}) {
    const conn = await ensureCentralMotor({ layout, baseDirectory: layout.baseDirectory });
    const headers = {
      'X-Mind-Cwd': cwd,
      ...(workspacePaths.length > 0 ? { 'X-Mind-Workspace-Paths': JSON.stringify(workspacePaths) } : {}),
    };
    const res = await httpPostMcp({
      port: conn.state.port,
      token: conn.token,
      headers,
      body: initMessage,
    });
    if (res.status !== 200 || !res.sessionId || !res.body) {
      throw Object.assign(new Error(`Fallo al inicializar sesión remota (${res.status}).`), { status: res.status });
    }
    const nextState = { port: conn.state.port, token: conn.token, sessionId: res.sessionId };
    sessionState = nextState;
    openSse(nextState);
    if (replayInitializedNotification) {
      await httpPostMcp({
        port: nextState.port,
        token: nextState.token,
        sessionId: nextState.sessionId,
        body: { jsonrpc: '2.0', method: 'notifications/initialized' },
      });
    }
    return res.body;
  }

  async function ensureReconnected(failedState) {
    if (connecting) {
      await connecting;
      if (sessionState && (!failedState || sessionState.sessionId !== failedState.sessionId)) {
        return sessionState;
      }
    }
    if (sessionState && failedState && sessionState.sessionId !== failedState.sessionId) {
      return sessionState;
    }
    if (!cachedInitialize) {
      throw new Error('No hay inicialización previa para reconectar.');
    }
    if (!reconnecting) {
      reconnecting = (async () => {
        closeSse();
        sessionState = null;
        await delay(25);
        await initializeOnCentral(cachedInitialize, { replayInitializedNotification: initializedNotified });
        return sessionState;
      })().finally(() => {
        reconnecting = null;
      });
    }
    return reconnecting;
  }

  function handleFatalFallback(message) {
    if (!isObject(message)) return;
    const hasId = Object.hasOwn(message, 'id') && (typeof message.id === 'string' || Number.isInteger(message.id));
    if (!hasId) return;
    if (message.method === 'initialize') {
      const requested = message.params?.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0];
      const code = fatalStartupError instanceof MotorError ? fatalStartupError.code : 'STARTUP_FAILED';
      const msg = fatalStartupError instanceof MotorError ? fatalStartupError.message : 'Mind no pudo iniciarse.';
      const guidance = STARTUP_GUIDANCE[code] ?? 'Pide al usuario que ejecute "mind estado" en la carpeta de Mind para ver el detalle, o "mind reparar" si cerró Mind de forma abrupta.';
      writeMessage({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'mind', title: 'Mind', version: MOTOR_VERSION },
          instructions: `[${code}] ${msg} ${guidance}`,
        },
      });
      return;
    }
    if (message.method === 'ping') {
      writeMessage({ jsonrpc: '2.0', id: message.id, result: {} });
      return;
    }
    if (message.method === 'tools/list') {
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
      const code = fatalStartupError instanceof MotorError ? fatalStartupError.code : 'STARTUP_FAILED';
      const msg = fatalStartupError instanceof MotorError ? fatalStartupError.message : 'Mind no pudo iniciarse.';
      const report = {
        error: { codigo: code, mensaje: msg },
        base: layout?.baseDirectory ?? null,
        que_hacer: STARTUP_GUIDANCE[code] ?? 'Pide al usuario que ejecute "mind estado" en la carpeta de Mind para ver el detalle, o "mind reparar" si cerró Mind de forma abrupta.',
      };
      writeMessage({ jsonrpc: '2.0', id: message.id, result: { ...toolResult(report), isError: true } });
      return;
    }
    writeMessage(formatError(message.id, rpcError(-32601, 'Método no admitido.')));
  }

  async function forwardMessage(message) {
    if (fatalStartupError) {
      handleFatalFallback(message);
      return;
    }
    if (!isObject(message) || message.jsonrpc !== '2.0') {
      writeMessage(formatError(isObject(message) ? message.id ?? null : null, rpcError(INVALID_REQUEST, 'Mensaje JSON-RPC no válido.')));
      return;
    }

    if (message.method === 'initialize') {
      cachedInitialize = message;
      const attempt = initializeOnCentral(message);
      connecting = attempt.catch(() => {});
      try {
        const reply = await attempt;
        writeMessage(reply);
      } catch (error) {
        log('error', 'Error al despertar Motor Central desde puente stdio', { codigo: error?.code ?? null, error: String(error) });
        fatalStartupError = error;
        process.exitCode = 1;
        handleFatalFallback(message);
      } finally {
        if (connecting) connecting = null;
      }
      return;
    }

    if (message.method === 'notifications/initialized') {
      initializedNotified = true;
    }

    const hasId = Object.hasOwn(message, 'id') && (typeof message.id === 'string' || Number.isInteger(message.id));
    const replyEmptyPing = () => {
      if (hasId) writeMessage({ jsonrpc: '2.0', id: message.id, result: {} });
    };

    // Keepalive MCP pings must never wake up an idle-stopped Motor Central daemon.
    if (message.method === 'ping') {
      if (connecting) await connecting;
      const current = sessionState;
      if (!current) {
        replyEmptyPing();
        return;
      }
      try {
        const res = await httpPostMcp({
          port: current.port,
          token: current.token,
          sessionId: current.sessionId,
          body: message,
        });
        if (!isRetryableFailure(null, res.status)) {
          if (res.body !== null) {
            if (Array.isArray(res.body)) res.body.forEach(writeMessage);
            else writeMessage(res.body);
          } else {
            replyEmptyPing();
          }
          return;
        }
      } catch (error) {
        if (!isRetryableFailure(error, null)) {
          if (hasId) writeMessage(formatError(message.id, error));
          return;
        }
      }
      if (sessionState === current) {
        closeSse();
        sessionState = null;
      }
      replyEmptyPing();
      return;
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (connecting) await connecting;
      const current = sessionState ?? await ensureReconnected(null);
      try {
        const res = await httpPostMcp({
          port: current.port,
          token: current.token,
          sessionId: current.sessionId,
          body: message,
          onSseMessage: (eventMsg) => writeMessage(eventMsg),
        });
        if (isRetryableFailure(null, res.status)) {
          if (attempt === 0 && cachedInitialize) {
            await ensureReconnected(current);
            continue;
          }
        }
        if (res.body !== null) {
          if (Array.isArray(res.body)) res.body.forEach(writeMessage);
          else writeMessage(res.body);
        }
        return;
      } catch (error) {
        if (attempt === 0 && isRetryableFailure(error, null) && cachedInitialize) {
          await ensureReconnected(current);
          continue;
        }
        if (hasId && typeof message.method === 'string') {
          const reply = message.method === 'tools/call'
            ? { jsonrpc: '2.0', id: message.id, result: toolError(error) }
            : formatError(message.id, error);
          writeMessage(reply);
        }
        return;
      }
    }
  }

  const inFlight = new Set();

  function track(promise) {
    inFlight.add(promise);
    promise.finally(() => inFlight.delete(promise));
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
    const items = Array.isArray(message) ? message : [message];
    for (const item of items) {
      track(forwardMessage(item).catch((error) => log('error', 'Fallo en puente MCP', { error: String(error) })));
    }
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
        await Promise.race([Promise.allSettled([...inFlight]), delay(25_000)]);
      }
      closed = true;
      closeSse();
      if (sessionState) {
        const { port, token, sessionId } = sessionState;
        sessionState = null;
        await new Promise((done) => {
          const req = http.request({
            host: '127.0.0.1',
            port,
            method: 'DELETE',
            path: '/mcp',
            headers: {
              Host: `127.0.0.1:${port}`,
              Authorization: `Bearer ${token}`,
              'Mcp-Session-Id': sessionId,
            },
          }, (res) => { res.resume(); done(); });
          const timer = setTimeout(() => { req.destroy(); done(); }, 500);
          timer.unref?.();
          req.on('error', () => { clearTimeout(timer); done(); });
          req.end();
        });
      }
      resolve();
    };
    input.on('end', end);
    input.on('close', end);
    input.on('error', end);
  });
}
