import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { MotorError } from './errors.js';

export const CONNECTOR_STATE_FILE = 'conector.json';
export const CONNECTOR_SECRET_FILE = 'conector-secreto.json';
export const CONNECTOR_LOCK_FILE = 'conector.lock';
export const CONNECTOR_ERROR_FILE = 'conector-error.json';

const HEALTH_TIMEOUT_MS = 800;
const STARTUP_POLL_MS = 35;

export async function canonicalBaseDirectory(baseDirectory) {
  let cursor = path.resolve(baseDirectory);
  const missing = [];
  while (true) {
    try {
      const real = await fs.realpath(cursor);
      return missing.length > 0 ? path.join(real, ...missing) : real;
    } catch (error) {
      if (error?.code !== 'ENOENT') return path.resolve(baseDirectory);
      const parent = path.dirname(cursor);
      if (parent === cursor) return path.resolve(baseDirectory);
      missing.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

export function baseIdOf(baseDirectory) {
  return createHash('sha256').update(path.resolve(baseDirectory)).digest('hex').slice(0, 16);
}

export function preferredPort(baseId) {
  const numeric = Number.parseInt(String(baseId).slice(0, 8), 16);
  const safe = Number.isFinite(numeric) ? numeric : 0;
  return 49152 + (safe % 15000);
}

export function connectorPaths(baseDirectory) {
  return {
    baseDirectory,
    stateFile: path.join(baseDirectory, CONNECTOR_STATE_FILE),
    secretFile: path.join(baseDirectory, CONNECTOR_SECRET_FILE),
    lockFile: path.join(baseDirectory, CONNECTOR_LOCK_FILE),
    errorFile: path.join(os.tmpdir(), `mind-motor-error-${baseIdOf(baseDirectory)}.json`),
  };
}

async function readRegularJson(filename) {
  try {
    const info = await fs.lstat(filename);
    if (info.isSymbolicLink() || !info.isFile()) return null;
    const text = await fs.readFile(filename, 'utf8');
    if (!text.trim()) return null;
    return JSON.parse(text);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    return null;
  }
}

export async function writeJsonAtomic(filename, value, { mode = 0o600 } = {}) {
  const dir = path.dirname(filename);
  const temp = path.join(dir, `.${path.basename(filename)}.tmp-${process.pid}-${randomUUID()}`);
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  let handle;
  try {
    handle = await fs.open(temp, 'wx', mode);
    await handle.writeFile(payload, 'utf8');
    await handle.sync().catch(() => {});
    await handle.close();
    handle = null;
    await fs.rename(temp, filename);
    await fs.chmod(filename, mode).catch(() => {});
  } catch (error) {
    await handle?.close().catch(() => {});
    await fs.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

/** Lee el secreto persistente del conector local o lo genera de forma atómica y segura. */
export async function readOrCreateSecret(baseDirectory) {
  const { secretFile } = connectorPaths(baseDirectory);
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const existing = await readRegularJson(secretFile);
    if (existing?.version === 1 && typeof existing.token === 'string' && existing.token.length >= 32) {
      return existing.token;
    }
    const token = randomBytes(32).toString('hex');
    const payload = `${JSON.stringify({ version: 1, token, createdAt: new Date().toISOString() }, null, 2)}\n`;
    let handle;
    try {
      handle = await fs.open(secretFile, 'wx', 0o600);
      await handle.writeFile(payload, 'utf8');
      await handle.sync().catch(() => {});
      await handle.close();
      handle = null;
      return token;
    } catch (error) {
      await handle?.close().catch(() => {});
      if (error?.code === 'EEXIST' || (process.platform === 'win32' && error?.code === 'EPERM')) {
        await delay(20);
        continue;
      }
      throw error;
    }
  }
  const finalSecret = await readRegularJson(secretFile);
  if (finalSecret?.version === 1 && typeof finalSecret.token === 'string' && finalSecret.token.length >= 32) {
    return finalSecret.token;
  }
  throw new MotorError('CONNECTOR_SECRET_UNAVAILABLE', 'No se pudo inicializar el secreto local del conector.');
}

export async function readSecret(baseDirectory) {
  const { secretFile } = connectorPaths(baseDirectory);
  const existing = await readRegularJson(secretFile);
  return existing?.version === 1 && typeof existing.token === 'string' && existing.token.length >= 32
    ? existing.token
    : null;
}

export async function readConnectorState(baseDirectory) {
  const { stateFile } = connectorPaths(baseDirectory);
  const parsed = await readRegularJson(stateFile);
  if (!parsed || parsed.version !== 1 || !Number.isInteger(parsed.port) || parsed.port <= 0 || parsed.port > 65535) {
    return null;
  }
  if (typeof parsed.baseId !== 'string' || !parsed.baseId) return null;
  return parsed;
}

export async function writeConnectorState(baseDirectory, state) {
  const { stateFile } = connectorPaths(baseDirectory);
  await writeJsonAtomic(stateFile, { version: 1, ...state });
}

export async function removeConnectorState(baseDirectory) {
  const { stateFile } = connectorPaths(baseDirectory);
  await fs.rm(stateFile, { force: true }).catch(() => {});
}

export function httpRequest({ port, method = 'GET', pathName = '/health', headers = {}, body = null, timeoutMs = 5_000 }) {
  return new Promise((resolve, reject) => {
    const hostHeader = `127.0.0.1:${port}`;
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: pathName,
      headers: {
        Host: hostHeader,
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
      res.on('error', reject);
    });
    const timer = setTimeout(() => {
      req.destroy(Object.assign(new Error('Tiempo agotado.'), { code: 'ETIMEDOUT' }));
    }, timeoutMs);
    timer.unref?.();
    req.on('close', () => clearTimeout(timer));
    req.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    if (body !== null && body !== undefined) req.write(body);
    req.end();
  });
}

/** Comprueba /health sin autenticación; valida que pertenezca exactamente a la Base esperada. */
export async function checkConnectorHealth(port, expectedBaseId, { timeoutMs = HEALTH_TIMEOUT_MS } = {}) {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  try {
    const response = await httpRequest({ port, method: 'GET', pathName: '/health', timeoutMs });
    if (response.status !== 200) return null;
    const parsed = JSON.parse(response.body);
    if (!parsed || parsed.ok !== true || parsed.port !== port) return null;
    if (expectedBaseId && parsed.baseId !== expectedBaseId) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function checkHealthyConnector(baseDirectory) {
  const canonical = await canonicalBaseDirectory(baseDirectory);
  const expectedBaseId = baseIdOf(canonical);
  const state = await readConnectorState(canonical);
  if (!state || state.baseId !== expectedBaseId) return null;
  const health = await checkConnectorHealth(state.port, expectedBaseId);
  if (!health) return null;
  const token = await readSecret(canonical);
  if (!token) return null;
  return {
    baseDirectory: canonical,
    baseId: expectedBaseId,
    state,
    health,
    token,
    url: `http://127.0.0.1:${health.port}`,
  };
}

function defaultEntrypoint(layout) {
  return layout?.entrypoint
    ?? (layout?.motorDirectory ? path.join(layout.motorDirectory, 'bin', 'mind.js') : null)
    ?? fileURLToPath(new URL('../bin/mind.js', import.meta.url));
}

function defaultNodeExecutable(layout) {
  const configured = layout?.runtime?.nodeExecutable;
  if (configured && fsSync.existsSync(configured)) return configured;
  return process.execPath;
}

/**
 * «El primero enciende»: reutiliza el Motor Central vivo en <10 ms o lo despierta en
 * segundo plano sin ventanas y espera hasta que publique su puerto y salud.
 */
export async function ensureCentralMotor({ layout, baseDirectory, startupTimeoutMs = 20_000 } = {}) {
  const targetBase = layout?.baseDirectory ?? baseDirectory;
  if (typeof targetBase !== 'string' || !path.isAbsolute(targetBase)) {
    throw new MotorError('INVALID_BASE', 'La ruta de la Base debe ser absoluta.');
  }
  const existing = await checkHealthyConnector(targetBase);
  if (existing) return { ...existing, spawned: false };

  const nodeExecutable = defaultNodeExecutable(layout);
  const entrypoint = defaultEntrypoint(layout);
  const args = [entrypoint, 'motor', '--base', targetBase];
  const child = spawn(nodeExecutable, args, {
    detached: true,
    windowsHide: true,
    cwd: os.tmpdir(),
    stdio: 'ignore',
    env: { ...process.env },
  });
  let exited = null;
  child.once('error', (error) => {
    exited = { error };
  });
  child.once('exit', (code, signal) => {
    if (!exited) exited = { code, signal };
  });
  child.unref();

  const deadline = Date.now() + startupTimeoutMs;
  while (Date.now() < deadline) {
    const ready = await checkHealthyConnector(targetBase);
    if (ready) return { ...ready, spawned: true };
    if (exited !== null) {
      await delay(25);
      const raceWinner = await checkHealthyConnector(targetBase);
      if (raceWinner) return { ...raceWinner, spawned: false };
      const { errorFile } = connectorPaths(await canonicalBaseDirectory(targetBase));
      const storedError = await readRegularJson(errorFile);
      if (storedError) await fs.rm(errorFile, { force: true }).catch(() => {});
      if (storedError?.code) {
        throw new MotorError(storedError.code, storedError.message ?? 'El Motor Central no pudo iniciar.', storedError.details);
      }
      if (exited.error) {
        throw new MotorError('MOTOR_START_FAILED', `No se pudo lanzar el Motor Central: ${exited.error.message}`);
      }
      throw new MotorError(
        'MOTOR_START_FAILED',
        `El Motor Central no pudo iniciar (${exited.code ?? exited.signal}).`,
      );
    }
    await delay(STARTUP_POLL_MS);
  }
  throw new MotorError('MOTOR_START_TIMEOUT', 'El Motor Central tardó demasiado en responder.');
}

/** Envía una petición RPC autenticada al puerto del Motor Central. */
export async function postRpc({ port, token, payload, timeoutMs = 30_000 }) {
  const body = JSON.stringify(payload);
  const response = await httpRequest({
    port,
    method: 'POST',
    pathName: '/rpc',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(Buffer.byteLength(body, 'utf8')),
    },
    body,
    timeoutMs,
  });
  let parsed = null;
  if (response.body.trim()) {
    try {
      parsed = JSON.parse(response.body);
    } catch {
      parsed = null;
    }
  }
  if (response.status === 401 || response.status === 403) {
    throw Object.assign(new MotorError('RPC_UNAUTHORIZED', 'El Motor Central rechazó las credenciales locales.'), { retryable: true, status: response.status });
  }
  if (response.status === 503 || response.status === 404) {
    throw Object.assign(new MotorError('MOTOR_UNAVAILABLE', 'El Motor Central se está reiniciando o cerrando.'), { retryable: true, status: response.status });
  }
  if (response.status >= 400 || !parsed) {
    const err = parsed?.error;
    if (err?.codigo) throw new MotorError(err.codigo, err.mensaje, err.detalles);
    throw new MotorError('RPC_FAILED', `Error de comunicación con el Motor Central (${response.status}).`);
  }
  if (parsed.ok === false && parsed.error?.codigo) {
    throw new MotorError(parsed.error.codigo, parsed.error.mensaje, parsed.error.detalles);
  }
  return parsed;
}

/** Ejecuta una operación `/rpc`, despertando automáticamente el Motor Central y reintentando una vez si acababa de apagarse. */
export async function callCentralRpc({ layout, baseDirectory, payload, startupTimeoutMs = 20_000, timeoutMs = 30_000 }) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const connection = await ensureCentralMotor({ layout, baseDirectory, startupTimeoutMs });
    try {
      return await postRpc({ port: connection.state.port, token: connection.token, payload, timeoutMs });
    } catch (error) {
      const retryableNetwork = ['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT'].includes(error?.code);
      if (attempt === 0 && (error?.retryable || retryableNetwork)) {
        await delay(50);
        continue;
      }
      throw error;
    }
  }
}

/** Solicita el apagado limpio del Motor Central vivo y espera a que libere sus archivos e índices. */
export async function stopCentralMotor(target = {}, options = {}) {
  const { baseDirectory, timeoutMs = 10_000, onlyIfIdle = false } = typeof target === 'string'
    ? { baseDirectory: target, ...options }
    : target;
  const healthy = await checkHealthyConnector(baseDirectory);
  const canonical = await canonicalBaseDirectory(baseDirectory);
  const { lockFile, stateFile } = connectorPaths(canonical);
  if (!healthy) {
    // Si quedó un conector sin vida sin bloqueo activo, no interrumpe un arranque ajeno.
    return false;
  }
  let response = null;
  try {
    response = await postRpc({
      port: healthy.state.port,
      token: healthy.token,
      payload: onlyIfIdle ? { accion: 'apagar', soloSiInactivo: true } : { accion: 'apagar' },
      timeoutMs: Math.min(timeoutMs, 5_000),
    });
  } catch {
    // Puede cerrar el socket inmediatamente al aceptar apagar.
  }
  if (onlyIfIdle && response?.busy === true) {
    return false;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const alive = await checkConnectorHealth(healthy.state.port, healthy.baseId, { timeoutMs: 300 });
    const hasState = await fs.lstat(stateFile).then(() => true, () => false);
    const hasLock = await fs.lstat(lockFile).then(() => true, () => false);
    let pidAlive = false;
    if (Number.isInteger(healthy.state.pid)) {
      try {
        process.kill(healthy.state.pid, 0);
        pidAlive = true;
      } catch (error) {
        pidAlive = error?.code !== 'ESRCH';
      }
    }
    if (!alive && !hasState && !hasLock && !pidAlive) return true;
    await delay(40);
  }
  return false;
}
