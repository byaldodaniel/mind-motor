import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { spawn } from 'node:child_process';
import { productInstallation, productPaths, productRuntime, MOTOR_DIRECTORY } from './layout.js';
import { readManifestFile, validUniversalTargets, supportsProductTarget, hashFile } from './product-files.js';
import { releaseOf, compareReleases } from './package-descriptor.js';
import { readUpdateState, writeUpdateState, updateStatePaths, classifyUpdateError, ensureUpdateDirectory } from './update-state.js';
import { acquireOwnerFileLock } from './process-identity.js';
import { validateNovedades } from './release-notes.js';
import { waitForHandoff } from './update-handoff-state.js';

const MAX_FEED = 128 * 1024;
const MAX_PACKAGE = 512 * 1024 * 1024;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const WAIT_INTERVAL_MS = 30_000;
const fail = (code, message) => Object.assign(new Error(message), { code });
export { readUpdateState } from './update-state.js';
export { validateNovedades } from './release-notes.js';

export function githubDownload(value, repository) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password
      || !url.pathname.startsWith(`/${repository}/releases/`) || url.search || url.hash) {
    throw fail('UPDATE_CHANNEL_INVALID', 'La descarga no pertenece al canal de Mind.');
  }
  return url.href;
}

async function download(url, { fetcher, signal, limit, file }) {
  const response = await fetcher(url, { signal, redirect: 'follow', headers: { 'User-Agent': 'Mind-updater' } });
  if (!response.ok || !response.body) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
  if (Number(response.headers.get('content-length')) > limit) throw fail('UPDATE_PACKAGE_ALTERED', 'Descarga demasiado grande.');
  const chunks = [], hash = createHash('sha256');
  let bytes = 0;
  const handle = file ? await fs.open(file, 'wx', 0o600) : null;
  try {
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > limit) throw fail('UPDATE_PACKAGE_ALTERED', 'Descarga demasiado grande.');
      hash.update(chunk);
      if (handle) {
        let offset = 0;
        while (offset < chunk.byteLength) offset += (await handle.write(chunk, offset)).bytesWritten;
      } else chunks.push(Buffer.from(chunk));
    }
    if (handle) await handle.sync();
  } finally { await handle?.close(); }
  return { bytes, sha256: hash.digest('hex'), text: file ? null : Buffer.concat(chunks).toString('utf8') };
}

export function verifyFeed(envelope, publicKey) {
  if (typeof envelope?.payload !== 'string' || typeof envelope.signature !== 'string') throw fail('UPDATE_SIGNATURE_INVALID', 'Canal sin firma.');
  const payload = Buffer.from(envelope.payload, 'base64');
  const key = createPublicKey(publicKey);
  if (key.asymmetricKeyType !== 'ed25519' || !verify(null, payload, key, Buffer.from(envelope.signature, 'base64'))) {
    throw fail('UPDATE_SIGNATURE_INVALID', 'Firma de actualización incorrecta.');
  }
  const feed = JSON.parse(payload.toString('utf8'));
  if (feed.format !== 'mind-update' || ![1, 2].includes(feed.version) || !Array.isArray(feed.packages)) throw fail('UPDATE_CHANNEL_INVALID', 'Canal no válido.');
  releaseOf(feed);
  if (feed.version === 2 && (feed.layoutVersion !== 2 || feed.updateProtocolVersion !== 2
      || !Number.isSafeInteger(feed.packageRevision) || feed.packageRevision < 1 || !/^[a-f0-9]{64}$/u.test(feed.manifestSha256))) {
    throw fail('UPDATE_PROTOCOL_INVALID', 'El canal no identifica una entrega corregida válida.');
  }
  // Las novedades son opcionales en el canal (compatibilidad); si vienen, deben ser válidas o el canal se rechaza.
  return { ...feed, novedades: feed.novedades == null ? null : validateNovedades(feed.novedades) };
}

function selectedPackage(feed, current, repository) {
  if (!supportsProductTarget(current)) throw fail('UPDATE_PLATFORM_MISMATCH', 'La edición instalada no admite este equipo.');
  const universal = feed.packages.find(p => p?.targets !== undefined);
  if ((current.targets && !universal) || (universal && (feed.packages.length !== 1 || !validUniversalTargets(universal.targets) || universal.platform !== 'win32' || universal.arch !== 'x64'))) {
    throw fail('UPDATE_PLATFORM_MISMATCH', 'El canal debe ofrecer un único ZIP universal completo.');
  }
  const matching = feed.packages.filter(p => supportsProductTarget(p));
  if (matching.length !== 1) throw fail('UPDATE_PLATFORM_MISMATCH', 'Falta un paquete único para este equipo.');
  const selected = matching[0], url = githubDownload(selected.url, repository);
  if (universal && !new URL(url).pathname.toLowerCase().endsWith('.zip')) throw fail('UPDATE_CHANNEL_INVALID', 'El paquete universal debe ser ZIP.');
  if (!/^[a-f0-9]{64}$/u.test(selected.sha256) || !Number.isSafeInteger(selected.bytes) || selected.bytes < 1 || selected.bytes > MAX_PACKAGE) {
    throw fail('UPDATE_PACKAGE_ALTERED', 'Tamaño o huella del paquete no válidos.');
  }
  return { ...selected, url };
}

const IN_FLIGHT = ['descargando', 'descargada', 'instalando', 'espera-sesiones', 'espera-verificacion'];
const SHA = /^[a-f0-9]{64}$/u;
const LOCK_CODES = ['LOCK_BUSY', 'LOCK_TIMEOUT', 'LOCK_HELD', 'UPDATE_IN_PROGRESS', 'INSTALLATION_BUSY'];

function packagePath(paths, selected) {
  const tar = /\.(?:tar\.gz|tgz)$/iu.test(new URL(selected.url).pathname);
  return path.join(paths.downloads, selected.sha256 + (tar ? '.tar.gz' : '.zip'));
}

// Las versiones anteriores guardaban también los TAR en la caché con sufijo .zip.
async function resumePackagePath(paths, selected) {
  const file = packagePath(paths, selected);
  if (file.endsWith('.tar.gz')) {
    for (const suffix of ['', '.parcial']) {
      const destination = file + suffix;
      try { await fs.lstat(destination); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        try { await fs.rename(path.join(paths.downloads, selected.sha256 + '.zip' + suffix), destination); }
        catch (missing) { if (missing.code !== 'ENOENT') throw missing; }
      }
    }
  }
  return file;
}

export async function removeDownload(paths, sha256) {
  if (!SHA.test(sha256 ?? '')) return;
  for (const suffix of ['.zip', '.zip.parcial', '.tar.gz', '.tar.gz.parcial']) {
    await fs.rm(path.join(paths.downloads, sha256 + suffix), { force: true });
  }
}

/**
 * Marco común de las tres etapas: resuelve la copia, toma el bloqueo, lee el estado y traduce los fallos.
 * `body` recibe el contexto; `failPhase(state)` decide la fase que queda tras un fallo
 * (por defecto, la vigente; `fallida` si no había estado).
 */
async function withUpdate({ root, now = Date.now, random = Math.random, acquireLock = acquireOwnerFileLock, report = () => {} }, body, failPhase) {
  root ??= (await productInstallation()).root;
  if (!root) return { status: 'no-configurado' };
  let releaseLock, state;
  const paths = updateStatePaths(root);
  const stamp = () => new Date(now()).toISOString();
  const save = async patch => { state = { ...state, ...patch, updatedAt: stamp() }; await writeUpdateState(root, state); };
  try {
    const current = await readManifestFile(root);
    if (!current) return { status: 'no-configurado' };
    const product = productPaths(root, current);
    const channel = JSON.parse(await fs.readFile(path.join(product.motorDirectory, 'src', 'update-channel.json'), 'utf8'));
    if (!channel.publicKey) return { status: 'no-configurado' };
    await ensureUpdateDirectory(root, true);
    releaseLock = await acquireLock(paths.lock, { pythonExecutable: productRuntime(root, current).pythonExecutable, timeoutMs: 0 });
    state = await readUpdateState(root) ?? {};
    return await body({ root, current, product, channel, paths, stamp, save, report, now, get state() { return state; } });
  } catch (error) {
    if (error.code === 'UPDATE_ROLLBACK_FAILED') throw error;
    if (LOCK_CODES.includes(error.code)) return { status: 'aplazada', phase: 'otra-operacion', reason: error.message, code: error.code };
    if (error.code === 'ENOENT' && !releaseLock) return { status: 'no-configurado' };
    if (error.code === 'UPDATE_STATE_INVALID') return { status: 'aplazada', phase: 'estado-no-verificable', code: error.code, reason: error.message };
    const details = classifyUpdateError(error);
    const sessions = ['sesiones', 'sesiones-no-verificables'].includes(details.kind);
    const attempts = (state?.attempts ?? 0) + 1;
    const delay = sessions ? WAIT_INTERVAL_MS : details.retryable ? Math.min(60 * 60 * 1000, 30_000 * 2 ** Math.min(attempts - 1, 7)) * (1 + random() * 0.2) : CHECK_INTERVAL_MS;
    const phase = sessions ? details.kind === 'sesiones' ? 'espera-sesiones' : 'espera-verificacion' : (failPhase?.(state) ?? state?.phase ?? 'fallida');
    if (releaseLock) await writeUpdateState(root, { ...state, phase, attempts, stagePath: error.stagePath ?? state?.stagePath,
      lastError: { code: details.code, kind: details.kind, retryable: details.retryable, message: error.message, at: new Date(now()).toISOString() },
      nextCheckAt: new Date(now() + delay).toISOString(), updatedAt: new Date(now()).toISOString() });
    report(`Actualización pendiente (${details.kind}): ${error.message}`);
    return { status: 'aplazada', phase, reason: error.message, code: details.code, kind: details.kind };
  } finally { await releaseLock?.(); }
}

/** Verifica el sobre firmado guardado y devuelve la oferta; nunca confía en datos del estado sin firma. */
function offerFrom(state, { current, channel }) {
  if (!state.envelope) throw fail('UPDATE_STATE_INVALID', 'No hay una actualización descubierta.');
  const feed = verifyFeed(state.envelope, channel.publicKey);
  if ((current.updateProtocolVersion ?? 1) >= 2 && feed.version !== 2) throw fail('UPDATE_PROTOCOL_INVALID', 'Esta copia requiere el canal v2.');
  if (compareReleases(feed, current) <= 0) throw fail('UPDATE_NOT_AVAILABLE', 'La entrega ya está instalada.');
  return { feed, selected: selectedPackage(feed, current, channel.repository) };
}

const cachedResult = state => {
  const phase = state.phase;
  if (['al-dia', 'actualizada'].includes(phase)) return { status: 'al-dia', phase, nextCheckAt: state.nextCheckAt, cached: true };
  if (phase === 'disponible' && !state.lastError) return { status: 'disponible', phase, ...state.release, novedades: state.novedades ?? null, nextCheckAt: state.nextCheckAt, cached: true };
  return { status: 'aplazada', phase, reason: state.lastError?.message, code: state.lastError?.code, kind: state.lastError?.kind, nextCheckAt: state.nextCheckAt, cached: true };
};

/** Solo descubre: descarga el canal firmado `stable.json`, lo verifica y decide. Nunca descarga el paquete. */
export async function discoverUpdate({ root, fetcher = fetch, now = Date.now, random = Math.random, force = false, acquireLock = acquireOwnerFileLock, report = () => {} } = {}) {
  return withUpdate({ root, now, random, acquireLock, report }, async ctx => {
    const { current, product, channel, paths, stamp, save } = ctx;
    const state = ctx.state;
    if (!force && state.nextCheckAt && Date.parse(state.nextCheckAt) > now()) return cachedResult(state);
    if (state.phase === 'limpieza-pendiente' && state.installedRelease) {
      const recovered = await recoverBeforeStartup(ctx.root, current);
      if (recovered.status === 'limpieza-pendiente' || recovered.status === 'otra-operacion') return { status: 'al-dia', phase: 'limpieza-pendiente', cleanupPending: true };
      await removeDownload(paths, state.package?.sha256);
      await save({ phase: 'actualizada', envelope: null, package: null, novedades: null, lastError: null, nextCheckAt: new Date(now() + CHECK_INTERVAL_MS).toISOString() });
      return { status: 'al-dia', ...releaseOf(current) };
    }
    // Una operación en curso (descarga, instalación o espera de sesiones) no se pisa con un nuevo descubrimiento.
    if (IN_FLIGHT.includes(state.phase)) return { status: 'en-curso', phase: state.phase, ...state.release };
    const result = await download(githubDownload(channel.url, channel.repository), { fetcher, signal: AbortSignal.timeout(5000), limit: MAX_FEED });
    const envelope = JSON.parse(result.text);
    const feed = verifyFeed(envelope, channel.publicKey);
    if ((current.updateProtocolVersion ?? 1) >= 2 && feed.version !== 2) throw fail('UPDATE_PROTOCOL_INVALID', 'Esta copia requiere el canal de actualización v2.');
    const selected = selectedPackage(feed, current, channel.repository);
    const order = compareReleases(feed, current);
    const next = new Date(now() + CHECK_INTERVAL_MS).toISOString();
    if (order <= 0) {
      if (order === 0 && feed.version === 2 && await hashFile(product.manifestFile) !== feed.manifestSha256) {
        throw fail('UPDATE_MANIFEST_ALTERED', 'El canal ofrece otro manifiesto con la misma versión y revisión.');
      }
      await removeDownload(paths, state.package?.sha256);
      await save({ phase: 'al-dia', envelope: null, package: null, release: null, novedades: null, lastError: null, attempts: 0, lastCheckedAt: stamp(), nextCheckAt: next });
      return { status: 'al-dia', ...releaseOf(current) };
    }
    if (feed.version === 2 && (current.updateProtocolVersion ?? 1) < 2) {
      await save({ phase: 'requiere-reparacion', release: releaseOf(feed), novedades: null, envelope: null, package: null, lastCheckedAt: stamp(),
        lastError: { code: 'UPDATE_REPAIR_REQUIRED', kind: 'compatibilidad', retryable: false, message: 'Esta copia necesita la reparación oficial antes de cambiar de estructura.', at: stamp() }, nextCheckAt: next });
      return { status: 'requiere-reparacion', ...releaseOf(feed) };
    }
    if (state.package?.sha256 && state.package.sha256 !== selected.sha256) await removeDownload(paths, state.package.sha256);
    const offered = { url: selected.url, bytes: selected.bytes, sha256: selected.sha256 };
    await save({ phase: 'disponible', release: releaseOf(feed), novedades: feed.novedades, envelope, package: offered, lastError: null, attempts: 0, lastCheckedAt: stamp(), nextCheckAt: next });
    return { status: 'disponible', phase: 'disponible', ...releaseOf(feed), novedades: feed.novedades, package: offered };
  }, state => state?.phase ?? 'fallida');
}

/** Reanuda una oferta firmada, incluso tras cortar descarga/instalación; nunca instala. */
export async function downloadUpdate({ root, fetcher = fetch, now = Date.now, random = Math.random, acquireLock = acquireOwnerFileLock, report = () => {}, signal } = {}) {
  return withUpdate({ root, now, random, acquireLock, report }, async ctx => {
    const { paths, save } = ctx, state = ctx.state;
    if (!['disponible', 'descargada', 'descargando', 'espera-sesiones', 'espera-verificacion', 'instalando', 'fallida'].includes(state.phase)) return { status: 'fase-incorrecta', phase: state.phase ?? null };
    const { feed, selected } = offerFrom(state, ctx);
    const source = await resumePackagePath(paths, selected), partial = `${source}.parcial`;
    await fs.mkdir(paths.downloads, { recursive: true });
    try {
      const info = await fs.lstat(source);
      if (info.isFile() && info.size === selected.bytes && await hashFile(source) === selected.sha256) {
        if (state.phase !== 'descargada') await save({ phase: 'descargada', lastError: null, nextCheckAt: null });
        return { status: 'descargada', phase: 'descargada', ...releaseOf(feed) };
      }
      await fs.rm(source, { force: true });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    let offset = 0;
    try {
      const info = await fs.lstat(partial);
      offset = info.isFile() ? info.size : 0;
      if (!info.isFile() || offset > selected.bytes) { await fs.rm(partial, { force: true }); offset = 0; }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const disk = await fs.statfs(paths.downloads);
    if (disk.bavail * disk.bsize < selected.bytes - offset) throw fail('ENOSPC', 'No hay espacio para descargar la actualización.');
    await save({ phase: 'descargando', nextCheckAt: null });
    report(`Descargando Mind ${feed.mindVersion}…`);
    const timeout = AbortSignal.timeout(Math.max(120_000, Math.ceil(selected.bytes / (512 * 1024) * 1000)));
    if (offset < selected.bytes) {
      const headers = { 'User-Agent': 'Mind-updater', ...(offset > 0 ? { Range: `bytes=${offset}-` } : {}) };
      const response = await fetcher(selected.url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout, redirect: 'follow', headers });
      if (response.status === 416) { await fs.rm(partial, { force: true }); throw Object.assign(new Error('HTTP 416'), { status: 416 }); }
      if (!response.ok || !response.body) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
      const resumed = offset > 0 && response.status === 206;
      if (resumed) {
        const range = /^bytes (\d+)-/u.exec(response.headers.get('content-range') ?? '');
        if (range && Number(range[1]) !== offset) { await fs.rm(partial, { force: true }); throw fail('UPDATE_PACKAGE_ALTERED', 'El servidor devolvió un tramo distinto del pedido.'); }
      } else offset = 0;
      if (Number(response.headers.get('content-length')) > selected.bytes - offset) throw fail('UPDATE_PACKAGE_ALTERED', 'Descarga demasiado grande.');
      const handle = await fs.open(partial, resumed ? 'a' : 'w', 0o600);
      let bytes = offset;
      try {
        for await (const chunk of response.body) {
          bytes += chunk.byteLength;
          if (bytes > selected.bytes) { await handle.close().catch(() => {}); await fs.rm(partial, { force: true }); throw fail('UPDATE_PACKAGE_ALTERED', 'Descarga demasiado grande.'); }
          let written = 0;
          while (written < chunk.byteLength) written += (await handle.write(chunk, written)).bytesWritten;
        }
        await handle.sync();
      } finally { await handle.close().catch(() => {}); }
    }
    const info = await fs.lstat(partial);
    if (info.size !== selected.bytes || await hashFile(partial) !== selected.sha256) {
      await fs.rm(partial, { force: true });
      throw fail('UPDATE_PACKAGE_ALTERED', 'El paquete descargado no coincide con el canal firmado.');
    }
    await fs.rename(partial, source);
    await save({ phase: 'descargada', lastError: null, attempts: 0, nextCheckAt: null });
    return { status: 'descargada', phase: 'descargada', ...releaseOf(feed) };
  }, state => ['disponible', 'descargada', 'descargando'].includes(state?.phase) ? 'disponible' : (state?.phase ?? 'fallida'));
}

/** Instala el paquete ya descargado y verificado (fase `descargada`, o su espera de sesiones/verificación). */
export async function installDownloaded({ root, install = installPackage, baseDirectory, now = Date.now, random = Math.random, acquireLock = acquireOwnerFileLock, report = () => {} } = {}) {
  return withUpdate({ root, now, random, acquireLock, report }, async ctx => {
    const { paths, save } = ctx, state = ctx.state;
    if (!['descargada', 'espera-sesiones', 'espera-verificacion', 'instalando'].includes(state.phase)) return { status: 'fase-incorrecta', phase: state.phase ?? null };
    const { feed, selected } = offerFrom(state, ctx);
    const source = await resumePackagePath(paths, selected);
    let intact = false;
    try { const info = await fs.lstat(source); intact = info.isFile() && info.size === selected.bytes && await hashFile(source) === selected.sha256; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!intact) {
      await fs.rm(source, { force: true });
      await save({ phase: 'disponible', lastError: { code: 'UPDATE_PACKAGE_MISSING', kind: 'integridad', retryable: false, message: 'El paquete descargado falta o no coincide; hay que descargarlo de nuevo.', at: ctx.stamp() }, nextCheckAt: null });
      return { status: 'aplazada', phase: 'disponible', code: 'UPDATE_PACKAGE_MISSING', kind: 'integridad' };
    }
    await save({ phase: 'instalando', nextCheckAt: null });
    const installed = await install({ root: ctx.root, source, version: feed.mindVersion, baseDirectory,
      revision: feed.packageRevision ?? 0, expectedRelease: releaseOf(feed), expectedManifestSha256: feed.manifestSha256 });
    let cleanupError = null;
    try { await fs.rm(source, { force: true }); } catch (error) { cleanupError = error; }
    const cleanupPending = installed?.cleanupPending === true || cleanupError !== null;
    await save({ phase: cleanupPending ? 'limpieza-pendiente' : 'actualizada', envelope: null, release: null, novedades: null, package: cleanupError ? state.package : null,
      lastError: cleanupError ? { code: cleanupError.code ?? 'UPDATE_CLEANUP_PENDING', kind: 'actualizador', retryable: true, message: cleanupError.message, at: ctx.stamp() } : null,
      attempts: 0, installedRelease: releaseOf(feed), nextCheckAt: new Date(now() + (cleanupPending ? WAIT_INTERVAL_MS : CHECK_INTERVAL_MS)).toISOString() });
    report(`Mind se actualizó a ${feed.mindVersion}.`);
    return { status: 'actualizada', version: feed.mindVersion, cleanupPending, ...releaseOf(feed) };
  }, () => 'fallida');
}

/** Composición histórica: descubrir, descargar e instalar. Mind ya no la invoca por su cuenta. */
export async function checkForUpdate({ root, fetcher = fetch, install = installPackage, baseDirectory, report = () => {},
  now = Date.now, random = Math.random, force = false, acquireLock = acquireOwnerFileLock } = {}) {
  root ??= (await productInstallation()).root;
  if (!root) return { status: 'no-configurado' };
  const common = { root, now, random, acquireLock, report };
  let result = await discoverUpdate({ ...common, fetcher, force });
  if (result.status === 'en-curso') {
    if (result.phase === 'descargando') return { status: 'aplazada', phase: 'descargando', cached: true };
    result = { status: 'descargada' };
  } else if (result.status === 'disponible') result = await downloadUpdate({ ...common, fetcher });
  else return result;
  if (result.status !== 'descargada') return result;
  return installDownloaded({ ...common, install, baseDirectory });
}

async function installPackage({ root, source, version, baseDirectory, revision, expectedRelease, expectedManifestSha256 }) {
  const current = await readManifestFile(root);
  return new Promise((resolve, reject) => {
    const worker = spawn(process.execPath, [path.join(productPaths(root, current).motorDirectory, 'bin', 'install-update.js'),
      root, source, version, baseDirectory ?? '', String(revision ?? 0), JSON.stringify(expectedRelease), expectedManifestSha256 ?? ''], {
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, NODE_OPTIONS: '' },
    });
    let errorText = '', outputText = '';
    worker.stdout.on('data', chunk => { outputText = (outputText + chunk).slice(-8192); });
    worker.stderr.on('data', chunk => { errorText = (errorText + chunk).slice(-8192); });
    worker.on('error', reject);
    worker.on('exit', code => {
      if (code === 0) {
        try { return resolve(JSON.parse(outputText)); } catch { return resolve({}); }
      }
      let details;
      try { details = JSON.parse(errorText); } catch {}
      reject(Object.assign(new Error(details?.message ?? errorText ?? `Actualizador: ${code}`), details ?? {}));
    });
  });
}

async function recoverBeforeStartup(root, manifest) {
  if (!(await fs.lstat(path.join(root,'Sistema','Actualizaciones','transaccion.json')).catch(e=>{if(e.code==='ENOENT')return null;throw e;}))) return {status:'sin-operacion'};
  const { lock } = updateStatePaths(root);
  const preparation = path.join(path.dirname(lock), 'preparacion.lock');
  await ensureUpdateDirectory(root, true);
  let release;
  try {
    release = await acquireOwnerFileLock(preparation, { pythonExecutable: productRuntime(root, manifest).pythonExecutable, timeoutMs: 0 });
    const { recoverUpdateTransaction } = await import('./update-transaction.js');
    return await recoverUpdateTransaction(root, { pythonExecutable: productRuntime(root, manifest).pythonExecutable, leaseHeld: true });
  } catch (error) {
    if (['LOCK_BUSY', 'LOCK_OWNER_UNKNOWN', 'PROCESS_IDENTITY_UNKNOWN'].includes(error.code)) return { status: 'otra-operacion' };
    if (error.code === 'UPDATE_CLEANUP_PENDING') return { status: 'limpieza-pendiente' };
    throw error;
  } finally { await release?.(); }
}

/**
 * El puente de un chat casi no toca el disco: le basta un hilo de libuv. Node crea 4 la
 * primera vez que hace una operación de archivos asíncrona y en Windows cada uno
 * reserva unos 8 MB privados; con un hilo, un puente baja de ~60 a ~30 MB. Debe
 * fijarse antes de la primera operación asíncrona. No se hereda al Motor ni a otros
 * procesos que lance el puente (ver `daemonEnvironment`).
 */
export function lightenBridge(args, env = process.env) {
  const command = args.find((value, index) => !value.startsWith('--') && !['--base', '--carpeta'].includes(args[index - 1]));
  if (command !== 'mcp' || args.includes('--direct') || env.UV_THREADPOOL_SIZE) return false;
  env.UV_THREADPOOL_SIZE = '1';
  env.MIND_PUENTE_LIGERO = '1';
  return true;
}

/** Reconoce el layout sin abrir Programa: puede estar apartado por el relevista. */
export function installationRootFromMotorDirectory(motorDirectory) {
  if (path.basename(motorDirectory).toLowerCase() !== 'motor'
      || path.basename(path.dirname(motorDirectory)).toLowerCase() !== 'programa'
      || path.basename(path.resolve(motorDirectory, '../..')).toLowerCase() !== 'sistema') return null;
  return path.resolve(motorDirectory, '../../..');
}

export async function launch(args) {
  lightenBridge(args);
  const startupRoot = installationRootFromMotorDirectory(MOTOR_DIRECTORY);
  const beforeImport = startupRoot ? await waitForHandoff({ root: startupRoot }) : { waited: false };
  const before = await productInstallation();
  if (beforeImport.waited && before.root) return relayUpdatedProgram(before.root, before.manifest, args);
  if (before.root) {
    const waited = await waitForHandoff({ root: before.root, pythonExecutable: productRuntime(before.root, before.manifest).pythonExecutable });
    if (waited?.waited) {
      const current = await readManifestFile(before.root);
      if (!current) throw fail('PRODUCT_MANIFEST_INVALID', 'Falta el manifiesto después de actualizar Mind.');
      if (compareReleases(current, before.manifest) !== 0) {
        // Este proceso ya cargó módulos del programa anterior. El iniciador estable
        // abre el programa recién verificado conservando argumentos y stdio.
        return relayUpdatedProgram(before.root, current, args);
      }
    }
    await recoverBeforeStartup(before.root, before.manifest);
  }
  // Mind nunca descarga ni instala por su cuenta: solo descubre; la instalación la aprueba el usuario.
  delete process.env.MIND_UPDATE_RESTART;
  const { main } = await import('./product-cli.js');
  return main(args);
}

/** Oferta vigente comprobada desde su sobre firmado, para ligar el consentimiento a sus bytes. */
export async function getVerifiedOffer({ root } = {}) {
  root ??= (await productInstallation()).root;
  if (!root) throw fail('UPDATE_NOT_AVAILABLE', 'Esta copia no recibe actualizaciones.');
  const current = await readManifestFile(root);
  if (!current) throw fail('NOT_PRODUCT', 'No es una instalación de Mind.');
  const product = productPaths(root, current);
  const channel = JSON.parse(await fs.readFile(path.join(product.motorDirectory, 'src', 'update-channel.json'), 'utf8'));
  const state = await readUpdateState(root);
  if (!state || !['disponible', 'descargando', 'descargada', 'espera-sesiones', 'espera-verificacion', 'instalando', 'fallida'].includes(state.phase)) {
    throw fail('UPDATE_NOT_AVAILABLE', 'No hay una entrega nueva disponible.');
  }
  const { feed, selected } = offerFrom(state, { current, channel });
  if (compareReleases(feed, current) <= 0) throw fail('UPDATE_NOT_AVAILABLE', 'La entrega ya está instalada.');
  if ((current.updateProtocolVersion ?? 1) >= 2 && feed.version !== 2) throw fail('UPDATE_PROTOCOL_INVALID', 'Esta copia requiere el canal v2.');
  return { feed, selected, current, source: packagePath(updateStatePaths(root), selected) };
}

/** Reabre una consola/puente que empezó a cargar justo antes de la sustitución. */
export function relayUpdatedProgram(root, manifest, args, { spawnProgram = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const runtime = productRuntime(root, manifest), paths = productPaths(root, manifest);
    const child = spawnProgram(runtime.nodeExecutable, [paths.agentEntrypoint, ...args], {
      stdio: 'inherit', windowsHide: true, env: { ...process.env, NODE_OPTIONS: '' },
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (signal) reject(fail('UPDATE_RELAY_INTERRUPTED', 'El programa actualizado se cerró antes de terminar.'));
      else resolve(code ?? 1);
    });
  });
}
