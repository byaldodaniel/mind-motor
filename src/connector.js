import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { MotorError } from './errors.js';
import { contains, FOLD_CASE } from './paths.js';
import { classifyToolPriority, QUEUE_PRIORITY } from './smart-queue.js';
import { launchIndependent } from './independent-launch.js';
import { predatesSystemBoot, systemBootTime, parseOwnerRecord, inspectProcessOwners } from './process-identity.js';
import { waitForHandoff } from './update-handoff-state.js';
import { productPaths, productRuntime, usesNativeMotor } from './layout.js';
import { readManifestFile } from './product-files.js';
import { MOTOR_VERSION } from './version.js';

export const CONNECTOR_STATE_FILE = 'conector.json';
export const CONNECTOR_SECRET_FILE = 'conector-secreto.json';
export const CONNECTOR_CONSOLE_FILE = 'conector-consola.json';
export const CONNECTOR_LOCK_FILE = 'conector.lock';
export const CONNECTOR_ERROR_FILE = 'conector-error.json';

export function restoreLockPath(baseDirectory) {
  return `${path.resolve(baseDirectory)}.restauracion.lock`;
}

export async function assertNotRestoring(baseDirectory, { pythonExecutable } = {}) {
  const canonical = await canonicalBaseDirectory(baseDirectory);
  const lockPath = restoreLockPath(canonical);
  let info;
  try {
    info = await fs.lstat(lockPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw new MotorError('BASE_RESTORING', 'La Base se está restaurando; espera a que termine.');
  }
  if (!info.isFile()) {
    throw new MotorError('BASE_RESTORING', 'La Base se está restaurando; espera a que termine.');
  }
  let parsed = null;
  try {
    parsed = parseOwnerRecord(await fs.readFile(lockPath, 'utf8'));
  } catch {
    parsed = null;
  }
  if (parsed) {
    try {
      const [owner] = await inspectProcessOwners([parsed], { pythonExecutable });
      if (owner?.state === 'stale') return;
    } catch {}
  }
  throw new MotorError('BASE_RESTORING', 'La Base se está restaurando; espera a que termine.');
}

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
    consoleFile: path.join(baseDirectory, CONNECTOR_CONSOLE_FILE),
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
    const delaysMs = [15, 30, 60, 120, 240];
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.rename(temp, filename);
        break;
      } catch (error) {
        if (!['EPERM', 'EBUSY', 'EACCES'].includes(error?.code) || attempt >= delaysMs.length) throw error;
        await delay(delaysMs[attempt]);
      }
    }
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

async function readTokenFile(filename) {
  const existing = await readRegularJson(filename);
  return existing?.version === 1 && typeof existing.token === 'string' && existing.token.length >= 32
    ? existing.token
    : null;
}

export async function readSecret(baseDirectory) {
  return await readTokenFile(connectorPaths(baseDirectory).secretFile);
}

export async function readConsoleToken(baseDirectory) {
  return await readTokenFile(connectorPaths(baseDirectory).consoleFile);
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
  delete env.MIND_CONEXION;
  // El puente se aligera con un solo hilo de libuv; el Motor trabaja con disco en paralelo.
  if (env.MIND_PUENTE_LIGERO === '1') { delete env.UV_THREADPOOL_SIZE; delete env.MIND_PUENTE_LIGERO; }
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

async function nativeMotorCommand(layout, baseDirectory, nativeExecutable) {
  const configured = nativeExecutable ?? process.env.MIND_MOTOR_NATIVO_EXE ?? layout?.runtime?.nativeExecutable;
  if (!configured || !path.isAbsolute(configured)) {
    throw new MotorError('NATIVE_MOTOR_EXECUTABLE_REQUIRED', 'Indica una ruta absoluta al Motor Rust en MIND_MOTOR_NATIVO_EXE.');
  }
  const executable = await fs.realpath(configured).catch(() => null);
  const file = executable ? await fs.stat(executable).catch(() => null) : null;
  if (!file?.isFile()) {
    throw new MotorError('NATIVE_MOTOR_EXECUTABLE_UNAVAILABLE', 'El ejecutable configurado del Motor Rust no está disponible.');
  }
  const base = await canonicalBaseDirectory(baseDirectory);
  const motorDirectory = layout?.manifest?.runtime !== 'rust' && layout?.motorDirectory ? await canonicalBaseDirectory(layout.motorDirectory) : null;
  if (motorDirectory && contains(motorDirectory, base)) {
    throw new MotorError('BASE_OVERLAPS_MOTOR', 'La Base no puede estar dentro del Motor.');
  }
  const args = ['motor', '--base', base, '--conector'];
  if (motorDirectory) args.push('--directorio-motor', motorDirectory);
  if (layout?.root) {
    const { releaseQuarantine } = await import('./quarantine.js');
    const quarantine = await releaseQuarantine(layout);
    if (quarantine.aviso) process.stderr.write('Aviso: ' + quarantine.aviso + '\n');
    args.push('--raiz-instalacion', await canonicalBaseDirectory(layout.root));
    if (layout.userDataDirectory) {
      const { ensureUserDataDirectory } = await import('./user-data-directory.js');
      await ensureUserDataDirectory(layout);
      args.push('--datos-usuario', await canonicalBaseDirectory(layout.userDataDirectory));
    }
  }
  return { executable, args };
}

/**
 * «El primero enciende»: reutiliza el Motor Central vivo en <10 ms o lo despierta en
 * segundo plano sin ventanas y espera hasta que publique su puerto y salud.
 */
export async function ensureCentralMotor({ layout, baseDirectory, startupTimeoutMs = 20_000, launch = launchIndependent, waitForUpdate = waitForHandoff, nativeExecutable } = {}) {
  const targetBase = layout?.baseDirectory ?? baseDirectory;
  if (typeof targetBase !== 'string' || !path.isAbsolute(targetBase)) {
    throw new MotorError('INVALID_BASE', 'La ruta de la Base debe ser absoluta.');
  }
  await assertNotRestoring(targetBase, { pythonExecutable: layout?.pythonExecutable });
  const useNative = () => Boolean(nativeExecutable) || process.env.MIND_MOTOR_NATIVO === '1'
    || usesNativeMotor(layout?.manifest);
  const check = async () => {
    const ready = await checkHealthyConnector(targetBase);
    if (useNative() && ready && ready.health.backend !== 'rust') {
      throw new MotorError('NATIVE_MOTOR_BUSY', 'La Base sigue abierta con el Motor anterior. Ciérralo antes de arrancar Rust.');
    }
    return ready;
  };
  // Un relevo que sustituye/verifica el programa es el único que puede encender
  // el candidato. Los puentes y la consola esperan sin crear un Motor competidor.
  async function waitForProgram() {
    if (!layout?.root) return false;
    const result = await waitForUpdate({ root: layout.root, pythonExecutable: layout.pythonExecutable });
    if (result?.waited) {
      const manifest = await readManifestFile(layout.root);
      if (!manifest) throw new MotorError('PRODUCT_MANIFEST_INVALID', 'Falta el manifiesto después de actualizar Mind.');
      layout = { ...layout, ...productPaths(layout.root, manifest), manifest, runtime: productRuntime(layout.root, manifest) };
      layout.pythonExecutable = layout.runtime.pythonExecutable;
    }
    return result?.waited === true;
  }
  await waitForProgram();
  const existing = await check();
  if (existing) return { ...existing, spawned: false };
  // La quietud pudo empezar durante la comprobación HTTP anterior.
  if (await waitForProgram()) {
    const ready = await check();
    if (ready) return { ...ready, spawned: false };
  }

  const native = useNative();
  const command = native ? await nativeMotorCommand(layout, targetBase, nativeExecutable) : {
    executable: defaultNodeExecutable(layout),
    args: [defaultEntrypoint(layout), 'motor', '--base', targetBase],
  };
  const errorFile = newStartupErrorFile();
  // El Motor sirve a todos los chats: no debe morir cuando se cierra el cliente que
  // lo encendió (en Windows, el Job Object del cliente lo arrastraría).
  const motorEnvironment = daemonEnvironment(errorFile);
  // Un relevista usa Python de su snapshot. El Motor normal debe conservar el
  // ejecutor de la instalación que seguirá existiendo tras limpiar ese snapshot.
  if (layout?.pythonExecutable) motorEnvironment.MIND_PYTHON = layout.pythonExecutable;
  if (native) {
    motorEnvironment.MIND_MOTOR_NATIVO_VERSION = layout?.manifest?.mindVersion ?? MOTOR_VERSION;
    motorEnvironment.MIND_MOTOR_NATIVO_REVISION = String(layout?.manifest?.packageRevision ?? 0);
  }
  const launched = await launch({
    ...command,
    cwd: os.tmpdir(),
    env: motorEnvironment,
  });

  const deadline = Date.now() + startupTimeoutMs;
  try {
    while (Date.now() < deadline) {
      const ready = await check();
      if (ready) return { ...ready, spawned: true, launch: { mecanismo: launched.mecanismo, independencia: launched.independencia, aviso: launched.aviso ?? null } };
      const exited = launched.exited();
      if (exited !== null) {
        await delay(25);
        const raceWinner = await check();
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
          `El Motor Central no pudo iniciar (${exited.code ?? exited.signal ?? 'terminó al arrancar'}).`,
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
export async function postRpc({ port, token, payload, timeoutMs = 30_000, headers = {} }) {
  const body = JSON.stringify(payload);
  const response = await httpRequest({
    port,
    method: 'POST',
    pathName: '/rpc',
    headers: {
      ...headers,
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
export async function callCentralRpc({ layout, baseDirectory, payload, startupTimeoutMs = 20_000, timeoutMs = 0, console = false }) {
  for (let attempt = 0; ; attempt += 1) {
    const connection = await ensureCentralMotor({ layout, baseDirectory, startupTimeoutMs });
    let headers;
    if (console) {
      const consoleToken = await readConsoleToken(connection.baseDirectory ?? baseDirectory);
      if (!consoleToken) {
        throw new MotorError('CONSOLE_CREDENTIAL_UNAVAILABLE', 'El Motor activo no ofrece credencial de consola.');
      }
      headers = { 'X-Mind-Consola': consoleToken };
    }
    try {
      return await postRpc({ port: connection.state.port, token: connection.token, payload, timeoutMs, headers });
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
  const { baseDirectory, timeoutMs = 10_000, onlyIfIdle = false, onlyIfQuiet = false, reason = null } = typeof target === 'string'
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
      payload: {
        accion: 'apagar',
        ...(onlyIfIdle ? { soloSiInactivo: true } : {}),
        ...(onlyIfQuiet ? { soloSiQuieto: true } : {}),
        ...(reason ? { motivo: reason } : {}),
      },
      timeoutMs: Math.min(timeoutMs, 5_000),
    });
  } catch {
    // Puede cerrar el socket inmediatamente al aceptar apagar.
  }
  if ((onlyIfIdle || onlyIfQuiet) && response?.busy === true) {
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

const STALE_TEMP_PATTERN = /^\.(?:mind-|conector\.json\.tmp-|mind-connection-).+\.tmp(?:-[0-9a-f-]+)?$/iu;
const QUEUE_TICKET_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.json$/iu;
const QUEUE_PRIORITY_PATTERN = /^priority-[a-f0-9]{64}\.json$/iu;

/**
 * Limpia archivos temporales abandonados en la Base y tickets/prioridades vencidos
 * o dañados anteriores al arranque en `resource-queue/`. No toca archivos activos.
 */
export async function cleanStaleBaseTemporaries(baseDirectory, { maxAgeMs = 3_600_000, now = Date.now(), bootTime = systemBootTime({ now }) } = {}) {
  let removedTempFiles = 0;
  let removedQueueItems = 0;
  const entries = await fs.readdir(baseDirectory).catch(() => []);
  for (const name of entries) {
    if (!STALE_TEMP_PATTERN.test(name)) continue;
    const target = path.join(baseDirectory, name);
    try {
      const info = await fs.lstat(target);
      if (info.isSymbolicLink() || !info.isFile()) continue;
      if (predatesSystemBoot(info, { bootTime }) || info.mtimeMs < now - maxAgeMs) {
        await fs.rm(target, { force: true });
        removedTempFiles += 1;
      }
    } catch {}
  }

  const queueDir = path.join(baseDirectory, 'resource-queue');
  const queueEntries = await fs.readdir(queueDir).catch(() => []);
  for (const name of queueEntries) {
    const target = path.join(queueDir, name);
    try {
      const info = await fs.lstat(target);
      if (info.isSymbolicLink() || !info.isFile()) continue;
      if (QUEUE_TICKET_PATTERN.test(name)) {
        const raw = await fs.readFile(target, 'utf8').catch(() => null);
        let corrupt = raw === null || raw.trim() === '' || raw.includes('\0');
        if (!corrupt) {
          try { JSON.parse(raw); } catch { corrupt = true; }
        }
        if ((corrupt && predatesSystemBoot(info, { bootTime })) || info.mtimeMs < now - maxAgeMs) {
          await fs.rm(target, { force: true });
          removedQueueItems += 1;
        }
      } else if (QUEUE_PRIORITY_PATTERN.test(name)) {
        const raw = await fs.readFile(target, 'utf8').catch(() => null);
        let remove = false;
        if (raw === null || raw.trim() === '' || raw.includes('\0')) {
          remove = predatesSystemBoot(info, { bootTime });
        } else {
          try {
            const parsed = JSON.parse(raw);
            if (!Number.isFinite(parsed?.until) || parsed.until < now) remove = true;
          } catch {
            remove = predatesSystemBoot(info, { bootTime });
          }
        }
        if (remove) {
          await fs.rm(target, { force: true });
          removedQueueItems += 1;
        }
      }
    } catch {}
  }

  return { removedTempFiles, removedQueueItems };
}
