import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { MotorError } from './errors.js';
import { FOLD_CASE } from './paths.js';
import { classifyToolPriority, QUEUE_PRIORITY } from './smart-queue.js';

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

/**
 * Identidad de una Base a partir de su ruta. Normaliza a NFC en todos los sistemas
 * (macOS entrega nombres en NFD) y distingue mayúsculas solo donde el sistema lo hace.
 */
export function baseIdOf(baseDirectory) {
  const resolved = path.resolve(baseDirectory).normalize('NFC');
  const folded = FOLD_CASE ? resolved.toLowerCase() : resolved;
  return createHash('sha256').update(folded).digest('hex').slice(0, 16);
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
  };
}

const STARTUP_ERROR_NAME = /^mind-motor-error-[0-9a-f-]{36}\.json$/;

/**
 * Archivo por el que un Motor Central recién lanzado cuenta a quien lo lanzó por qué
 * no pudo iniciar. El nombre es aleatorio en cada lanzamiento: en un directorio
 * temporal compartido nadie más puede precrearlo ni adivinarlo.
 */
export function newStartupErrorFile() {
  return path.join(os.tmpdir(), `mind-motor-error-${randomUUID()}.json`);
}

/** Solo se acepta un nombre generado por `newStartupErrorFile` dentro del directorio temporal. */
export function validStartupErrorFile(candidate) {
  return typeof candidate === 'string' && path.isAbsolute(candidate)
    && STARTUP_ERROR_NAME.test(path.basename(candidate))
    && path.resolve(path.dirname(candidate)) === path.resolve(os.tmpdir());
}

/** Deja el motivo de un fallo de inicio para el proceso que lanzó el Motor; nunca lanza. */
export async function writeStartupError(errorFile, error) {
  if (!validStartupErrorFile(errorFile) || !(error instanceof MotorError)) return;
  await writeJsonAtomic(errorFile, {
    code: error.code,
    message: error.message,
    ...(error.details ? { details: error.details } : {}),
    at: new Date().toISOString(),
  }).catch(() => {});
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

/**
 * Lee el secreto persistente del conector o lo genera. Solo debe llamarlo el Motor
 * Central con `conector.lock` tomado: ese bloqueo garantiza un único escritor, por
 * lo que un archivo ausente, vacío o dañado (lo que deja un corte de energía) se
 * sustituye de forma atómica en lugar de dejar a Mind sin poder arrancar.
 */
export async function readOrCreateSecret(baseDirectory) {
  const { secretFile } = connectorPaths(baseDirectory);
  const existing = await readSecret(baseDirectory);
  if (existing) return existing;
  const token = randomBytes(32).toString('hex');
  try {
    // Un enlace o un directorio con ese nombre no se sigue ni se sobrescribe.
    const info = await fs.lstat(secretFile).catch((error) => { if (error?.code === 'ENOENT') return null; throw error; });
    if (info && !info.isFile()) throw new Error('El secreto del conector no es un archivo normal.');
    await writeJsonAtomic(secretFile, { version: 1, token, createdAt: new Date().toISOString() });
  } catch (error) {
    throw new MotorError('CONNECTOR_SECRET_UNAVAILABLE', 'No se pudo inicializar el secreto local del conector.', { causa: String(error?.code ?? error?.message ?? error) });
  }
  return token;
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

/** Petición HTTP al Motor Central local. `timeoutMs` 0 o no finito: sin límite. */
export function httpRequest({ port, method = 'GET', pathName = '/health', headers = {}, body = null, timeoutMs = 5_000 }) {
  return new Promise((resolve, reject) => {
    const hostHeader = `127.0.0.1:${port}`;
    const req = http.request({
      // Conexión nueva por petición: una conexión reutilizada que el Motor ya cerró
      // fallaría como si el Motor hubiera muerto a mitad de la operación.
      agent: false,
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
    const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? setTimeout(() => {
        req.destroy(Object.assign(new Error('Tiempo agotado.'), { code: 'ETIMEDOUT' }));
      }, timeoutMs)
      : null;
    timer?.unref?.();
    req.on('close', () => clearTimeout(timer));
    req.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    if (body !== null && body !== undefined) req.write(body);
    req.end();
  });
}

export const HEALTH_NONCE_PATTERN = /^[a-f0-9]{32,128}$/;

/**
 * Prueba de identidad del Motor Central: HMAC del secreto local sobre un valor
 * aleatorio del cliente, la Base y el puerto. Quien no conoce el secreto no puede
 * responderla, y la de otro puerto no sirve en este.
 */
export function healthProof(token, nonce, baseId, port) {
  return createHmac('sha256', token).update(`mind-health-v1\n${nonce}\n${baseId}\n${port}`).digest('hex');
}

/**
 * Comprueba /health (sin autenticación) y que pertenezca a la Base esperada.
 * Con `token`, exige además la prueba de identidad: el secreto nunca se envía a
 * un puerto que no haya demostrado conocerlo (un `conector.json` obsoleto puede
 * apuntar a un puerto que ahora ocupa otro programa).
 */
export async function checkConnectorHealth(port, expectedBaseId, { timeoutMs = HEALTH_TIMEOUT_MS, token } = {}) {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  try {
    const nonce = token ? randomBytes(16).toString('hex') : null;
    const response = await httpRequest({ port, method: 'GET', pathName: nonce ? `/health?nonce=${nonce}` : '/health', timeoutMs });
    if (response.status !== 200) return null;
    const parsed = JSON.parse(response.body);
    if (!parsed || parsed.ok !== true || parsed.port !== port) return null;
    if (expectedBaseId && parsed.baseId !== expectedBaseId) return null;
    if (token) {
      if (typeof parsed.proof !== 'string') return null;
      const expected = Buffer.from(healthProof(token, nonce, parsed.baseId, port), 'utf8');
      const received = Buffer.from(parsed.proof, 'utf8');
      if (expected.length !== received.length || !timingSafeEqual(expected, received)) return null;
    }
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
  const token = await readSecret(canonical);
  if (!token) return null;
  const health = await checkConnectorHealth(state.port, expectedBaseId, { token });
  if (!health) return null;
  return {
    baseDirectory: canonical,
    baseId: expectedBaseId,
    state,
    health,
    token,
    url: `http://127.0.0.1:${health.port}`,
  };
}

/**
 * Entorno del Motor Central. Hereda el de quien lo enciende, sin lo que solo
 * concernía a ese proceso: opciones de depuración de Node o la marca de un puente
 * relevo. El Motor sirve a todos los chats, no solo al primero.
 */
function daemonEnvironment(errorFile) {
  const env = { ...process.env, NODE_OPTIONS: '', MIND_MOTOR_ERROR_FILE: errorFile };
  delete env.MIND_BRIDGE_RELAYED;
  return env;
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
  const errorFile = newStartupErrorFile();
  const child = spawn(nodeExecutable, args, {
    detached: true,
    windowsHide: true,
    cwd: os.tmpdir(),
    stdio: 'ignore',
    env: daemonEnvironment(errorFile),
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
  try {
    while (Date.now() < deadline) {
      const ready = await checkHealthyConnector(targetBase);
      if (ready) return { ...ready, spawned: true };
      if (exited !== null) {
        await delay(25);
        const raceWinner = await checkHealthyConnector(targetBase);
        if (raceWinner) return { ...raceWinner, spawned: false };
        const storedError = await readRegularJson(errorFile);
        if (typeof storedError?.code === 'string') {
          throw new MotorError(storedError.code, String(storedError.message ?? 'El Motor Central no pudo iniciar.'), storedError.details);
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
  } finally {
    await fs.rm(errorFile, { force: true }).catch(() => {});
  }
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

/** Una operación `/rpc` que puede repetirse sin efecto: consultas y herramientas de solo lectura. */
function isRepeatableRpc(payload) {
  if (payload?.accion === 'inicio' || payload?.accion === 'estado' || payload?.accion === 'ping') return true;
  return payload?.accion === 'herramienta' && typeof payload.tool === 'string'
    && classifyToolPriority(payload.tool, payload.args ?? {}) === QUEUE_PRIORITY.READ;
}

/**
 * Ejecuta una operación `/rpc`, despertando el Motor Central si hace falta.
 *
 * Sin límite de tiempo por defecto: una herramienta puede tardar lo que tarde su
 * trabajo (copiar un video, cifrar un respaldo) y abandonar la espera no la detiene.
 * Solo se reintenta cuando repetir no puede ejecutar dos veces la operación: el
 * Motor no llegó a recibirla (conexión rechazada), la rechazó sin procesarla
 * (se estaba apagando, credenciales de un Motor anterior) o es de solo lectura.
 */
export async function callCentralRpc({ layout, baseDirectory, payload, startupTimeoutMs = 20_000, timeoutMs = 0 }) {
  for (let attempt = 0; ; attempt += 1) {
    const connection = await ensureCentralMotor({ layout, baseDirectory, startupTimeoutMs });
    try {
      return await postRpc({ port: connection.state.port, token: connection.token, payload, timeoutMs });
    } catch (error) {
      const notDelivered = error?.retryable === true || error?.code === 'ECONNREFUSED';
      const interrupted = ['ECONNRESET', 'EPIPE', 'ECONNABORTED', 'ETIMEDOUT'].includes(error?.code);
      if (attempt === 0 && (notDelivered || (interrupted && isRepeatableRpc(payload)))) {
        await delay(50);
        continue;
      }
      if (interrupted) {
        throw new MotorError('MOTOR_CONNECTION_LOST',
          'Se perdió la conexión con el Motor Central antes de recibir la respuesta. No se sabe si la operación terminó: compruébalo antes de repetirla.',
          { causa: error.code });
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
