import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { getVerifiedOffer, downloadUpdate, installDownloaded } from './auto-update.js';
import { releaseOf, compareReleases } from './package-descriptor.js';
import { productPaths, productRuntime } from './layout.js';
import { readManifestFile, hashFile } from './product-files.js';
import { identifyCurrentProcess, acquireOwnerFileLock } from './process-identity.js';
import { launchIndependent } from './independent-launch.js';
import { checkHealthyConnector, postRpc, stopCentralMotor, ensureCentralMotor } from './connector.js';
import { updateMind } from './commands/actualizar.js';
import { recoverUpdateTransaction } from './update-transaction.js';
import { readUpdateState, writeUpdateState, updateStatePaths, classifyUpdateError } from './update-state.js';
import { readHandoff, writeHandoff, handoffDirectory, ensureHandoffDirectory, handoffOwner, cleanupHandoffRunner, cleanupHandoffRunners, BLOCKING_PHASES } from './update-handoff-state.js';
import { verifyInstalledBase } from './update-verifier.js';
import { readBaseMarker } from './base-format.js';

const fail = (code, message) => Object.assign(new Error(message), { code });
const terminal = record => ['completada', 'fallida'].includes(record?.phase);
const lockPath = root => path.join(root, 'Sistema', 'Actualizaciones', 'relevo.lock');
const stamp = now => new Date(now()).toISOString();
async function waitForAdoption({ root, id, child, previousOwner, timeoutMs = 15_000 }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await readHandoff(root);
    if (!current || current.id !== id) throw fail('UPDATE_HANDOFF_CHANGED', 'El relevo cambió antes de arrancar.');
    if (current.owner?.instanceToken !== previousOwner.instanceToken || terminal(current)) return current;
    if (child.exited?.() !== null) throw fail('UPDATE_HANDOFF_START_FAILED', 'El relevista terminó antes de tomar el trabajo.');
    await delay(50);
  }
  throw fail('UPDATE_HANDOFF_START_TIMEOUT', 'El relevista no confirmó su inicio; vuelve a aplicar la entrega.');
}
async function verifiedCommit(root, record) {
  const current = await readManifestFile(root);
  if (!current || compareReleases(current, record.release) !== 0
      || record.verification?.ok !== true
      || JSON.stringify(record.verification.release) !== JSON.stringify(record.release)
      || record.verification.baseDirectory !== record.baseDirectory
      || record.verification.baseId !== record.baseIdentity
      || !record.expectedManifestSha256) return false;
  return await hashFile(productPaths(root, current).manifestFile) === record.expectedManifestSha256;
}
function assertOffer(offer, expected) {
  if (JSON.stringify(releaseOf(offer.feed)) !== JSON.stringify(expected.expectedRelease)
      || (offer.feed.manifestSha256 ?? null) !== (expected.expectedManifestSha256 ?? null)
      || offer.selected.sha256 !== expected.expectedPackageSha256) throw fail('UPDATE_OFFER_CHANGED', 'La entrega cambió después de la aprobación. Vuelve a consultarla.');
}
async function reconcileUpdateState(root, record, committed, pythonExecutable) {
  const paths = updateStatePaths(root);
  const release = await acquireOwnerFileLock(paths.lock, { pythonExecutable, timeoutMs: 5_000 });
  try {
    const state = await readUpdateState(root) ?? {};
    let cleanupError = null;
    if (committed) {
      for (const suffix of ['', '.parcial']) {
        try { await fs.rm(path.join(paths.downloads, record.expectedPackageSha256 + '.zip' + suffix), { force: true }); }
        catch (error) { cleanupError = error; }
      }
    }
    const error = cleanupError ?? record.error;
    const details = error ? classifyUpdateError(error) : null;
    await writeUpdateState(root, { ...state,
      phase: committed ? cleanupError ? 'limpieza-pendiente' : 'actualizada' : state.envelope ? 'disponible' : 'fallida',
      ...(committed ? { installedRelease: record.release, release: null, envelope: null, novedades: null,
        package: cleanupError ? state.package : null } : {}), attempts: 0,
      lastError: error ? { code: details.code, kind: details.kind, message: error.message, retryable: details.retryable, at: new Date().toISOString() } : null,
      nextCheckAt: committed ? new Date(Date.now() + 6 * 60 * 60_000).toISOString() : null,
      updatedAt: new Date().toISOString() });
  } finally { await release(); }
}
async function copyRunner(root, id, current, pythonExecutable) {
  const directory = await ensureHandoffDirectory(root, id), motor = path.join(directory, 'Motor');
  const own = fileURLToPath(new URL('..', import.meta.url));
  for (const part of ['src', 'bin']) await fs.cp(path.join(own, part), path.join(motor, part), { recursive: true, errorOnExist: true });
  await fs.copyFile(path.join(own, 'package.json'), path.join(motor, 'package.json'));
  const node = path.join(directory, 'Node', process.platform === 'win32' ? 'node.exe' : 'bin/node');
  await fs.mkdir(path.dirname(node), { recursive: true }); await fs.copyFile(process.execPath, node); await fs.chmod(node, 0o755);
  const py = pythonExecutable ?? productRuntime(root, current).pythonExecutable;
  if (!path.isAbsolute(py)) throw fail('UPDATE_PYTHON_PATH', 'El relevo requiere el Python incluido.');
  const pyRoot = process.platform === 'win32' ? path.dirname(py) : path.dirname(path.dirname(py));
  await fs.cp(pyRoot, path.join(directory, 'Python'), { recursive: true });
  return { node, runner: path.join(motor, 'bin', 'update-handoff.js') };
}
export function runnerPython(root, id) {
  return path.join(handoffDirectory(root, id), 'Python', process.platform === 'win32' ? 'python.exe' : 'bin/python3');
}
/** Empieza una tarea independiente. La aprobación ya se ligó a la identidad y los hashes. */
export async function requestUpdate({ layout, expectedRelease, expectedManifestSha256, expectedPackageSha256,
  launch = launchIndependent, prepareRunner = copyRunner, waitForWorker = waitForAdoption, now = Date.now } = {}) {
  if (!layout?.product || !layout.root) throw fail('NOT_PRODUCT', 'Esta copia no recibe actualizaciones.');
  const root = await fs.realpath(layout.root);
  const offer = await getVerifiedOffer({ root });
  const expected = { expectedRelease, expectedManifestSha256, expectedPackageSha256 }; assertOffer(offer, expected);
  const releaseLock = await acquireOwnerFileLock(lockPath(root), { pythonExecutable: layout.pythonExecutable, timeoutMs: 0 });
  let record, unlocked = false;
  const unlock = async () => { if (!unlocked) { unlocked = true; await releaseLock(); } };
  try {
    await cleanupHandoffRunners(root);
    const previous = await readHandoff(root);
    await cleanupHandoffRunner(root, previous);
    if (previous && !terminal(previous)) {
      const owner = await handoffOwner(previous, layout.pythonExecutable);
      if (owner !== 'stale') return { estado: 'en-curso', fase: previous.phase, version: previous.release?.mindVersion, id: previous.id };
      if (BLOCKING_PHASES.has(previous.phase)) throw fail('UPDATE_RECOVERY_REQUIRED', 'La operación anterior debe recuperarse antes de aplicar otra entrega.');
      const interrupted = { ...previous, phase: 'fallida', error: { code: 'UPDATE_INTERRUPTED', message: 'El relevista anterior terminó antes de aplicar.' } };
      await writeHandoff(root, interrupted);
      await cleanupHandoffRunner(root, interrupted);
    }
    const id = randomUUID();
    record = { id, phase: 'iniciando', release: releaseOf(offer.feed), ...expected, baseDirectory: await fs.realpath(layout.baseDirectory),
      owner: await identifyCurrentProcess({ pythonExecutable: layout.pythonExecutable }), createdAt: stamp(now), updatedAt: stamp(now), reported: {} };
    await writeHandoff(root, record);
    const runner = await prepareRunner(root, id, offer.current, layout.pythonExecutable);
    const childEnv = { ...process.env, NODE_OPTIONS: '', MIND_PYTHON: runnerPython(root, id) };
    delete childEnv.MIND_CONEXION; delete childEnv.MIND_BRIDGE_RELAYED; delete childEnv.UV_THREADPOOL_SIZE;
    const child = await launch({ executable: runner.node, args: [runner.runner, root, id], cwd: handoffDirectory(root, id), env: childEnv });
    record = { ...record, launch: { pid: child.pid, mecanismo: child.mecanismo, independencia: child.independencia, aviso: child.aviso ?? null } };
    // El trabajador toma relevo.lock después de que este solicitante lo libere.
    await writeHandoff(root, record);
    await unlock();
    const adopted = await waitForWorker({ root, id, child, previousOwner: record.owner });
    return { estado: terminal(adopted) ? adopted.phase : 'en-curso', fase: adopted.phase, version: record.release.mindVersion, id,
      independencia: child.independencia, ...(child.aviso ? { aviso: child.aviso } : {}),
      indicacion: 'La actualización se prepara con Mind funcionando. Se aplicará cuando todos los chats estén en quietud; consulta actualizacion_consultar para ver el resultado.' };
  } catch (error) {
    if (record) {
      // Si el worker ya tomó la propiedad, no se pisa su progreso con el registro inicial.
      let finishLock;
      try {
        if (unlocked) finishLock = await acquireOwnerFileLock(lockPath(root), { pythonExecutable: layout.pythonExecutable, timeoutMs: 1_000 });
        const latest = await readHandoff(root);
        if (latest?.id === record.id && latest.phase === 'iniciando' && latest.owner?.instanceToken === record.owner.instanceToken)
          await writeHandoff(root, { ...latest, phase: 'fallida', error: { code: error.code ?? 'UPDATE_HANDOFF_FAILED', message: error.message }, finishedAt: stamp(now) });
      } finally { await finishLock?.(); }
    }
    throw error;
  } finally { await unlock(); }
}
async function currentLayout(root, baseDirectory) {
  const manifest = await readManifestFile(root), runtime = productRuntime(root, manifest), paths = productPaths(root, manifest);
  return { product: true, root, manifest, ...paths, runtime, baseDirectory, pythonExecutable: runtime.pythonExecutable, protectedDirectories: [paths.programDirectory, paths.componentsDirectory] };
}
/** Descarga/prepara vivo, espera quietud, sustituye y verifica; siempre se ejecuta desde su copia independiente. */
export async function runHandoff({ root, id, recoverOnly = false, now = Date.now, pollMs = 500,
  hooks = {}, download = downloadUpdate, prepare = updateMind, install = installDownloaded,
  verify = verifyInstalledBase, healthy = checkHealthyConnector, rpc = postRpc, stop = stopCentralMotor, restart = ensureCentralMotor } = {}) {
  root = await fs.realpath(root);
  const pythonExecutable = runnerPython(root, id);
  const releaseLock = await acquireOwnerFileLock(lockPath(root), { pythonExecutable, timeoutMs: 15_000 });
  let record = await readHandoff(root);
  if (!record || record.id !== id || terminal(record)) { await releaseLock(); return { status: 'sin-operacion' }; }
  const save = async patch => { record = { ...record, ...patch, updatedAt: stamp(now) }; await writeHandoff(root, record); await hooks.afterPhase?.(record.phase, record); };
  let stopped = false;
  try {
    if (recoverOnly) {
      const owner = await handoffOwner(record, pythonExecutable);
      if (owner !== 'stale') throw fail('UPDATE_OWNER_ACTIVE', 'El relevista sigue activo o no se puede verificar.');
      await recoverUpdateTransaction(root, { pythonExecutable });
      const committed = await verifiedCommit(root, record);
      const current = await readManifestFile(root);
      if (!committed && compareReleases(current, record.release) >= 0)
        throw fail('UPDATE_INSTALLATION_UNVERIFIED', 'La entrega instalada no puede acreditarse con la verificación y huella aprobadas; se conserva la barrera de recuperación.');
      await reconcileUpdateState(root, record, committed, pythonExecutable);
      await save({ phase: committed ? 'completada' : 'fallida', finishedAt: stamp(now),
        error: committed ? null : { code: 'UPDATE_INTERRUPTED', message: 'La actualización se interrumpió; se recuperó la instalación anterior.' },
        result: committed ? { status: 'actualizada', recovered: true } : { status: 'recuperada' } });
      return { status: committed ? 'actualizada' : 'recuperada' };
    }
    await save({ owner: await identifyCurrentProcess({ pythonExecutable }), phase: 'descargando' });
    const baseMarker = await readBaseMarker(record.baseDirectory);
    if (!baseMarker) throw fail('UPDATE_BASE_UNKNOWN', 'No se puede comprobar la identidad de la Base.');
    await save({ baseIdentity: baseMarker.baseId });
    let offer = await getVerifiedOffer({ root }); assertOffer(offer, record);
    const downloaded = await download({ root });
    if (downloaded.status !== 'descargada') throw fail(downloaded.code ?? 'UPDATE_DOWNLOAD_FAILED', downloaded.reason ?? 'La descarga no terminó; puede reanudarse.');
    await save({ phase: 'preparando' });
    offer = await getVerifiedOffer({ root }); assertOffer(offer, record);
    const common = { root, source: offer.source, baseDirectory: record.baseDirectory, pythonExecutable,
      expectedRelease: record.release, expectedManifestSha256: record.expectedManifestSha256 };
    const prepared = await prepare({ ...common, prepareOnly: true });
    if (prepared.status !== 'preparada') throw fail('UPDATE_PREPARE_FAILED', 'El paquete no quedó preparado.');
    await save({ phase: 'espera-quietud' });
    for (;;) {
      const connection = await healthy(record.baseDirectory);
      if (connection) {
        const quiet = await rpc({ port: connection.state.port, token: connection.token, payload: { accion: 'quietud' } });
        if (!quiet.quieto) { await delay(pollMs); continue; }
      }
      await save({ phase: 'aplicando' });
      if (connection) {
        const clean = await stop(record.baseDirectory, { onlyIfQuiet: true, onlyIfIdle: true, reason: 'actualizacion', timeoutMs: 10_000 });
        if (!clean) { await save({ phase: 'espera-quietud' }); await delay(pollMs); continue; }
      }
      stopped = true; break;
    }
    const result = await install({ root, baseDirectory: record.baseDirectory,
      install: async () => prepare({ ...common, assistedVerification: true,
        verifyInstalled: async (target, incoming, context) => {
          const verificationToken = randomBytes(32).toString('hex');
          await save({ phase: 'verificando', verificationToken });
          const proof = await verify({ root: target, manifest: incoming, baseDirectory: context.baseDirectory,
            handoffId: id, verificationToken, parent: record.owner, pythonExecutable, expectedBaseId: record.baseIdentity });
          await save({ verification: proof });
        } }),
    });
    if (result.status !== 'actualizada') throw fail(result.code ?? 'UPDATE_INSTALL_FAILED', result.reason ?? 'La instalación no se confirmó.');
    await save({ phase: 'completada', result, error: null, verificationToken: null, finishedAt: stamp(now) });
    // Se confirma tras servir la Base real; el Motor normal se enciende con la barrera ya retirada.
    await restart({ layout: await currentLayout(root, record.baseDirectory) });
    return result;
  } catch (error) {
    if (recoverOnly) throw error;
    let recoveryError = null;
    try { await recoverUpdateTransaction(root, { pythonExecutable }); } catch (e) { recoveryError = e; }
    if (recoveryError) {
      // No se levanta la barrera si quedan grupos parciales o Base sin restaurar.
      await save({ error: { code: recoveryError.code ?? 'UPDATE_RECOVERY_BLOCKED', message: recoveryError.message } });
      throw recoveryError;
    }
    const committed = await verifiedCommit(root, record);
    await reconcileUpdateState(root, { ...record, error }, committed, pythonExecutable);
    await save({ phase: committed ? 'completada' : 'fallida', error: { code: error.code ?? 'UPDATE_HANDOFF_FAILED', message: error.message }, verificationToken: null, finishedAt: stamp(now) });
    if (stopped) await restart({ layout: await currentLayout(root, record.baseDirectory) }).catch(() => {});
    return { status: committed ? 'actualizada' : 'fallida', code: error.code, message: error.message, ...(committed ? { restartPending: true } : {}) };
  } finally { await releaseLock(); }
}
/** Acta visible en la primera llamada de cada conexión después del relevo. */
export async function takeUpdateReport({ layout, conexion = null, now = Date.now } = {}) {
  if (!layout?.product || !layout.root) return null;
  const root = layout.root, record = await readHandoff(root);
  if (!terminal(record)) return null;
  const release = await acquireOwnerFileLock(lockPath(root), { pythonExecutable: layout.pythonExecutable, timeoutMs: 5_000 }).catch(() => null);
  if (!release) return null;
  try {
    const latest = await readHandoff(root); if (!terminal(latest)) return null;
    const slot = conexion ?? 'sin-conexion';
    if (latest.reported?.[slot]) return null;
    const reported = { ...(latest.reported ?? {}), [slot]: stamp(now) };
    // Acotado para que el registro nunca crezca sin límite.
    const entries = Object.entries(reported).slice(-256);
    await writeHandoff(root, { ...latest, reported: Object.fromEntries(entries) });
    return { estado: latest.phase, version: latest.release.mindVersion, id: latest.id,
      texto: latest.phase === 'completada' ? `Mind se actualizó a ${latest.release.mindVersion}; el Motor nuevo comprobó la Base real.${latest.error ? ' El reinicio sigue pendiente: ' + latest.error.message : ''}`
        : `La actualización de Mind no se completó: ${latest.error?.message ?? 'consulta el estado'}`,
      error: latest.error ?? null, verificacion: latest.verification ?? null };
  } finally { await release(); }
}
export async function describeHandoff(layout) {
  if (!layout?.product) return null;
  const record = await readHandoff(layout.root); if (!record) return null;
  return { id: record.id, fase: record.phase, version: record.release?.mindVersion ?? null, error: record.error ?? null,
    resultado: record.result ?? null, verificacion: record.verification ?? null, lanzamiento: record.launch ?? null };
}
