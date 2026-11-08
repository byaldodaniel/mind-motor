import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { spawn } from 'node:child_process';
import { productInstallation, productPaths, productRuntime } from './layout.js';
import { readManifestFile, validUniversalTargets, supportsProductTarget, hashFile } from './product-files.js';
import { releaseOf, compareReleases } from './package-descriptor.js';
import { readUpdateState, writeUpdateState, updateStatePaths, classifyUpdateError, ensureUpdateDirectory } from './update-state.js';
import { acquireOwnerFileLock } from './process-identity.js';

const MAX_FEED = 128 * 1024;
const MAX_PACKAGE = 512 * 1024 * 1024;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const WAIT_INTERVAL_MS = 30_000;
const fail = (code, message) => Object.assign(new Error(message), { code });
export { readUpdateState } from './update-state.js';

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
  return feed;
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

/** One persistent operation per installation. A pending package is reused, never downloaded once per chat. */
export async function checkForUpdate({ root, fetcher = fetch, install = installPackage, baseDirectory, report = () => {},
  now = Date.now, random = Math.random, force = false, acquireLock = acquireOwnerFileLock } = {}) {
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
    if (!force && state.nextCheckAt && Date.parse(state.nextCheckAt) > now()) {
      return { status: ['al-dia', 'actualizada'].includes(state.phase) ? 'al-dia' : 'aplazada', phase: state.phase, reason: state.reason, nextCheckAt: state.nextCheckAt, cached: true };
    }
    if (state.phase === 'limpieza-pendiente' && state.installedRelease) {
      const recovered = await recoverBeforeStartup(root, current);
      if (recovered.status === 'limpieza-pendiente' || recovered.status === 'otra-operacion') return { status: 'al-dia', phase: 'limpieza-pendiente', cleanupPending: true };
      if (/^[a-f0-9]{64}$/u.test(state.packageSha256 ?? '')) await fs.rm(path.join(paths.downloads, `${state.packageSha256}.zip`), { force: true });
      await save({ phase: 'actualizada', envelope: null, source: null, reason: null, code: null, nextCheckAt: new Date(now() + CHECK_INTERVAL_MS).toISOString() });
      return { status: 'al-dia', ...releaseOf(current) };
    }
    const pending = ['preparada', 'espera-sesiones', 'espera-verificacion', 'instalando'].includes(state.phase) && state.envelope;
    let envelope = pending ? state.envelope : null;
    if (!envelope) {
      await save({ phase: 'comprobando', reason: null, code: null });
      const result = await download(githubDownload(channel.url, channel.repository), { fetcher, signal: AbortSignal.timeout(5000), limit: MAX_FEED });
      envelope = JSON.parse(result.text);
    }
    const feed = verifyFeed(envelope, channel.publicKey);
    if ((current.updateProtocolVersion ?? 1) >= 2 && feed.version !== 2) throw fail('UPDATE_PROTOCOL_INVALID', 'Esta copia requiere el canal de actualización v2.');
    const selected = selectedPackage(feed, current, channel.repository);
    const order = compareReleases(feed, current);
    if (order <= 0) {
      if (order === 0 && feed.version === 2 && await hashFile(product.manifestFile) !== feed.manifestSha256) {
        throw fail('UPDATE_MANIFEST_ALTERED', 'El canal ofrece otro manifiesto con la misma versión y revisión.');
      }
      if (/^[a-f0-9]{64}$/u.test(state.packageSha256 ?? '')) {
        const previous = path.join(paths.downloads, `${state.packageSha256}.zip`);
        await fs.rm(previous, { force: true });
        await fs.rm(previous + '.parcial', { force: true });
      }
      await save({ phase: 'al-dia', envelope: null, source: null, reason: null, code: null, attempts: 0, lastCheckedAt: stamp(), nextCheckAt: new Date(now() + CHECK_INTERVAL_MS).toISOString() });
      return { status: 'al-dia', ...releaseOf(current) };
    }
    if (feed.version === 2 && (current.updateProtocolVersion ?? 1) < 2) {
      await save({ phase: 'requiere-reparacion', release: releaseOf(feed), envelope: null, reason: 'Esta copia necesita la reparación oficial antes de cambiar de estructura.', nextCheckAt: new Date(now() + CHECK_INTERVAL_MS).toISOString() });
      return { status: 'requiere-reparacion', ...releaseOf(feed) };
    }
    const source = path.join(paths.downloads, `${selected.sha256}.zip`), partial = `${source}.parcial`;
    if (/^[a-f0-9]{64}$/u.test(state.packageSha256 ?? '') && state.packageSha256 !== selected.sha256) {
      const previous = path.join(paths.downloads, `${state.packageSha256}.zip`);
      await fs.rm(previous, { force: true });
      await fs.rm(previous + '.parcial', { force: true });
    }
    await save({ phase: 'disponible', release: releaseOf(feed), envelope, packageSha256: selected.sha256, source, lastCheckedAt: stamp(), nextCheckAt: null });
    await fs.mkdir(paths.downloads, { recursive: true });
    let downloaded = false;
    try { const info = await fs.lstat(source); downloaded = info.isFile() && info.size === selected.bytes && await hashFile(source) === selected.sha256; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!downloaded) {
      const disk = await fs.statfs(paths.downloads);
      if (disk.bavail * disk.bsize < selected.bytes) throw fail('ENOSPC', 'No hay espacio para descargar la actualización.');
      await fs.rm(partial, { force: true });
      await save({ phase: 'descargando' });
      report(`Descargando Mind ${feed.mindVersion}…`);
      const result = await download(selected.url, { fetcher, file: partial, signal: AbortSignal.timeout(Math.max(120_000, Math.ceil(selected.bytes / (512 * 1024) * 1000))), limit: selected.bytes });
      if (result.bytes !== selected.bytes || result.sha256 !== selected.sha256) {
        await fs.rm(partial, { force: true });
        throw fail('UPDATE_PACKAGE_ALTERED', 'El paquete descargado no coincide con el canal firmado.');
      }
      await fs.rm(source, { force: true });
      await fs.rename(partial, source);
    }
    await save({ phase: 'preparada', nextCheckAt: null });
    await save({ phase: 'instalando' });
    const installed = await install({ root, source, version: feed.mindVersion, baseDirectory,
      revision: feed.packageRevision ?? 0, expectedRelease: releaseOf(feed), expectedManifestSha256: feed.manifestSha256 });
    let cleanupError = null;
    try { await fs.rm(source, { force: true }); } catch (error) { cleanupError = error; }
    const cleanupPending = installed?.cleanupPending === true || cleanupError !== null;
    await save({ phase: cleanupPending ? 'limpieza-pendiente' : 'actualizada', envelope: null, source: cleanupError ? source : null,
      reason: cleanupError?.message ?? null, code: cleanupError?.code ?? null, attempts: 0,
      installedRelease: releaseOf(feed), installedPackageSha256: selected.sha256, nextCheckAt: new Date(now() + (cleanupPending ? WAIT_INTERVAL_MS : CHECK_INTERVAL_MS)).toISOString() });
    report(`Mind se actualizó a ${feed.mindVersion}.`);
    return { status: 'actualizada', version: feed.mindVersion, cleanupPending, ...releaseOf(feed) };
  } catch (error) {
    if (error.code === 'UPDATE_ROLLBACK_FAILED') throw error;
    if (['LOCK_BUSY', 'LOCK_TIMEOUT', 'LOCK_HELD', 'UPDATE_IN_PROGRESS', 'INSTALLATION_BUSY'].includes(error.code)) return { status: 'aplazada', phase: 'otra-operacion', reason: error.message, code: error.code };
    if (error.code === 'ENOENT' && !releaseLock) return { status: 'no-configurado' };
    if (error.code === 'UPDATE_STATE_INVALID') return { status: 'aplazada', phase: 'estado-no-verificable', code: error.code, reason: error.message };
    const details = classifyUpdateError(error);
    const sessions = ['sesiones', 'sesiones-no-verificables'].includes(details.kind);
    const attempts = (state?.attempts ?? 0) + 1;
    const delay = sessions ? WAIT_INTERVAL_MS : details.retryable ? Math.min(60 * 60 * 1000, 30_000 * 2 ** Math.min(attempts - 1, 7)) * (1 + random() * 0.2) : CHECK_INTERVAL_MS;
    const phase = sessions ? details.kind === 'sesiones' ? 'espera-sesiones' : 'espera-verificacion' : 'fallida';
    if (releaseLock) await save({ phase, reason: error.message, code: details.code, kind: details.kind, attempts,
      retryable: details.retryable, stagePath: error.stagePath ?? state?.stagePath, nextCheckAt: new Date(now() + delay).toISOString() });
    report(`Actualización pendiente (${details.kind}): ${error.message}`);
    return { status: 'aplazada', phase, reason: error.message, code: details.code, kind: details.kind };
  } finally { await releaseLock?.(); }
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

export async function launch(args) {
  const before = await productInstallation();
  if (before.root) await recoverBeforeStartup(before.root, before.manifest);
  const filtered = [];
  for (let index = 0; index < args.length; index++) {
    if (['--base', '--carpeta'].includes(args[index])) { index++; continue; }
    filtered.push(args[index]);
  }
  const command = filtered[0];
  if (!process.env.MIND_UPDATE_RESTART && !['version', '--version', 'actualizar', 'corregir', 'preparar', 'ayuda', '--help', '-h'].includes(command ?? args[0])) {
    const baseIndex = args.lastIndexOf('--base');
    const result = await checkForUpdate({ baseDirectory: baseIndex >= 0 ? args[baseIndex + 1] : undefined, report: message => process.stderr.write(`${message}\n`) });
    if (result.status === 'actualizada') {
      const { root, manifest } = await productInstallation();
      const { nodeExecutable } = productRuntime(root, manifest);
      return new Promise((resolve, reject) => {
        const child = spawn(nodeExecutable, [productPaths(root, manifest).entrypoint, ...args], {
          stdio: 'inherit', windowsHide: true, env: { ...process.env, NODE_OPTIONS: '', MIND_UPDATE_RESTART: '1' },
        });
        child.on('error', reject);
        child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
      });
    }
  }
  delete process.env.MIND_UPDATE_RESTART;
  const { main } = await import('./product-cli.js');
  return main(args);
}