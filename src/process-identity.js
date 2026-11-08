import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { MotorError } from './errors.js';

const helper = fileURLToPath(new URL('./native_process_identity.py', import.meta.url));
const instanceToken = randomUUID();
const identities = new Map();
const LEGACY_CLOCK_MARGIN_MS = 5000;

async function pythonFor(explicit) {
  if (explicit) return explicit;
  if (process.env.MIND_PYTHON || process.env.MIND_TEST_PYTHON) return process.env.MIND_PYTHON || process.env.MIND_TEST_PYTHON;
  const { productInstallation, productRuntime } = await import('./layout.js');
  const installation = await productInstallation();
  if (installation.root) return productRuntime(installation.root, installation.manifest).pythonExecutable;
  return process.platform === 'win32' ? 'python' : 'python3';
}

/** Read-only native inspection; failed probes never grant permission to recover. */
export async function probeProcesses(pids, { pythonExecutable } = {}) {
  const executable = await pythonFor(pythonExecutable);
  const unique = [...new Set(pids)];
  const output = [];
  for (let offset = 0; offset < unique.length; offset += 256) {
    const batch = unique.slice(offset, offset + 256);
    const result = await new Promise(resolve => {
      let text = '', settled = false, timer;
      const finish = value => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
      const failed = () => batch.map(pid => ({ pid, status: 'unknown', reason: 'identity-unavailable' }));
      let child;
      try { child = spawn(executable, ['-I', '-B', helper], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); }
      catch { finish(failed()); return; }
      timer = setTimeout(() => { child.kill(); finish(failed()); }, 2500);
      child.on('error', () => finish(failed()));
      child.stdin.on('error', () => {});
      child.stderr.resume();
      child.stdout.on('data', chunk => {
        text += chunk.toString('utf8');
        if (text.length > 256 * 1024) { child.kill(); finish(failed()); }
      });
      child.on('close', code => {
        try {
          const value = JSON.parse(text);
          if (code !== 0 || !Array.isArray(value.processes)) return finish(failed());
          finish(value.processes);
        } catch { finish(failed()); }
      });
      child.stdin.end(JSON.stringify({ pids: batch }));
    });
    output.push(...result);
  }
  return output;
}

/** Captured once per runtime. Birth tokens are identities, never expiring leases. */
export async function identifyCurrentProcess({ pythonExecutable } = {}) {
  const key = await pythonFor(pythonExecutable);
  if (!identities.has(key)) {
    const pending = probeProcesses([process.pid], { pythonExecutable: key }).then(([value]) => ({
      pid: process.pid, host: os.hostname(), instanceToken,
      processBirth: value?.status === 'present' ? value.processBirth : null,
      processStartedAt: value?.status === 'present' ? value.processStartedAt ?? null : null,
      executable: value?.status === 'present' ? value.executable ?? process.execPath : process.execPath,
    }));
    identities.set(key, pending);
  }
  return identities.get(key);
}

function legacyForeign(value) {
  if (typeof value.executable !== 'string' || !value.executable) return false;
  const name = path.win32.basename(value.executable.replaceAll('/', '\\')).toLowerCase();
  if (['node', 'node.exe', 'nodejs', 'nodejs.exe'].includes(name)) return false;
  if (Array.isArray(value.argv) && value.argv.some(arg => /(?:^|[\\/])mind\.js$/iu.test(arg))) return false;
  return true;
}

/** Classifies ownership, not mere PID existence. No age or executable name alone proves abandonment. */
export async function inspectProcessOwners(records, { pythonExecutable, probe = probeProcesses } = {}) {
  const pids = records.filter(record => record && Number.isSafeInteger(record.pid) && record.pid > 0
    && record.pid <= 0xffffffff && record.host === os.hostname()
    && !(record.pid === process.pid && record.instanceToken === instanceToken)).map(record => record.pid);
  let observations;
  try { observations = new Map((await probe([...new Set(pids)], { pythonExecutable })).map(value => [value.pid, value])); }
  catch { observations = new Map(); }
  return records.map(record => {
    const result = (state, reason) => ({ ...record, state, reason });
    if (!record || !Number.isSafeInteger(record.pid) || record.pid < 1 || record.pid > 0xffffffff
        || typeof record.host !== 'string') return result('unknown', 'invalid-owner');
    if (record.host !== os.hostname()) return result('unknown', 'other-host');
    if (record.pid === process.pid && record.instanceToken === instanceToken) return result('active', 'own-instance');
    const actual = observations.get(record.pid);
    if (!actual || actual.status === 'unknown') return result('unknown', actual?.reason ?? 'identity-unavailable');
    if (actual.status === 'missing') return result('stale', 'process-exited');
    if (actual.status !== 'present' || typeof actual.processBirth !== 'string') return result('unknown', 'invalid-observation');
    if (typeof record.processBirth === 'string' && record.processBirth) {
      return actual.processBirth === record.processBirth
        ? result('active', 'same-process') : result('stale', 'pid-reused');
    }
    if (record.version >= 2 || !actual.executable) return result('unknown', 'identity-incomplete');
    // Clock changes can make a still-live legacy session look older than its
    // process. Also require an executable incompatible with supported Node hosts.
    const registered = Date.parse(record.startedAt ?? record.createdAt ?? '');
    if (Number.isFinite(registered) && Number.isFinite(actual.processStartedAt)
        && actual.processStartedAt > registered + LEGACY_CLOCK_MARGIN_MS && legacyForeign(actual)) {
      return result('stale', 'legacy-pid-reused');
    }
    return legacyForeign(actual) ? result('unknown', 'legacy-identity-incomplete') : result('active', 'legacy-compatible');
  });
}

async function exists(filename) {
  return fs.lstat(filename).then(() => true, error => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
}

/** A recovery barrier is respected by all acquisitions of these owner files. */
export async function recoverAbandonedOwnerFile(filename, { pythonExecutable, inspect = inspectProcessOwners } = {}) {
  const barrier = filename + '.recovery';
  try { await fs.mkdir(barrier, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') return false; throw error; }
  const barrierInfo = await fs.lstat(barrier, { bigint: true });
  try {
    let examined, record;
    try {
      examined = await fs.lstat(filename, { bigint: true });
      if (!examined.isFile()) return false;
      record = JSON.parse(await fs.readFile(filename, 'utf8'));
    } catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return false; throw error; }
    const [owner] = await inspect([record], { pythonExecutable });
    if (owner?.state !== 'stale') return false;
    const current = await fs.lstat(filename, { bigint: true }).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!current || current.dev !== examined.dev || current.ino !== examined.ino
        || current.size !== examined.size || current.mtimeNs !== examined.mtimeNs) return false;
    const aside = filename + '.abandonado-' + randomUUID();
    await fs.rename(filename, aside);
    const moved = await fs.lstat(aside, { bigint: true });
    if (moved.dev !== examined.dev || moved.ino !== examined.ino) {
      await fs.link(aside, filename).catch(() => {});
      throw new MotorError('OWNER_LOCK_CHANGED', 'Cambió el propietario; se conserva el registro apartado para revisión.');
    }
    await fs.rm(aside);
    return true;
  } finally {
    const current = await fs.lstat(barrier, { bigint: true });
    if (current.dev !== barrierInfo.dev || current.ino !== barrierInfo.ino) {
      throw new MotorError('OWNER_LOCK_CHANGED', 'La barrera de recuperación cambió; no se elimina una barrera ajena.');
    }
    await fs.rmdir(barrier);
  }
}

/** One native owner lock; no age expiry and no process termination. */
export async function acquireOwnerFileLock(filename, { pythonExecutable, timeoutMs = 0, inspect = inspectProcessOwners } = {}) {
  const deadline = Date.now() + timeoutMs;
  const identity = await identifyCurrentProcess({ pythonExecutable });
  const token = randomUUID();
  const barrier = filename + '.recovery';
  let unknown = false;
  let lastRecord = null, inspectedAt = 0;
  for (;;) {
    if (!(await exists(barrier))) {
      let handle;
      try { handle = await fs.open(filename, 'wx', 0o600); }
      catch (error) { if (error.code !== 'EEXIST' && !(process.platform === 'win32' && error.code === 'EPERM')) throw error; }
      if (handle) {
        const owned = await handle.stat({ bigint: true });
        const requireOwned = async () => {
          const current = await fs.lstat(filename, { bigint: true }).catch(error => {
            if (error.code === 'ENOENT') return null;
            throw error;
          });
          if (!current?.isFile() || current.dev !== owned.dev || current.ino !== owned.ino) {
            throw new MotorError('OWNER_LOCK_CHANGED', 'El archivo de coordinación cambió; se conserva el dueño actual.');
          }
        };
        try {
          await handle.writeFile(JSON.stringify({ version: 2, token, ...identity, startedAt: new Date().toISOString() }) + '\n');
          while (await exists(barrier)) {
            if (Date.now() >= deadline) throw new MotorError('LOCK_BUSY', 'La recuperación de Mind está en curso.');
            await delay(20);
          }
          await requireOwned();
          await handle.close();
          handle = null;
          let released = false;
          return async () => {
            if (released) return;
            await requireOwned();
            const stored = JSON.parse(await fs.readFile(filename, 'utf8'));
            if (stored.token !== token) throw new MotorError('OWNER_LOCK_CHANGED', 'El bloqueo ya pertenece a otra operación.');
            await fs.unlink(filename);
            released = true;
          };
        } catch (error) {
          await handle?.close();
          await requireOwned().then(() => fs.unlink(filename)).catch(() => {});
          throw error;
        }
      }
      try {
        const text = await fs.readFile(filename, 'utf8');
        const stored = JSON.parse(text);
        // Cache may only postpone acquisition. Recovery always inspects freshly.
        if (text !== lastRecord || Date.now() - inspectedAt >= 500) {
          const [owner] = await inspect([stored], { pythonExecutable });
          unknown = owner.state === 'unknown';
          lastRecord = text;
          inspectedAt = Date.now();
          if (owner.state === 'stale' && await recoverAbandonedOwnerFile(filename, { pythonExecutable, inspect })) continue;
        }
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        if (error instanceof SyntaxError) unknown = true;
        else throw error;
      }
    }
    if (Date.now() >= deadline) throw new MotorError(unknown ? 'PROCESS_IDENTITY_UNKNOWN' : 'LOCK_BUSY',
      unknown ? 'No se pudo comprobar el propietario de la coordinación de Mind.' : 'Mind está ocupado.');
    await delay(Math.min(25, Math.max(1, deadline - Date.now())));
  }
}
