import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { MotorError } from './errors.js';

const active = new Map();
const recent = [];
const MAX_RECENT = 32;
export const DEFAULT_PROCESS_TIMEOUT_MS = 120_000;

/**
 * Only child handles created here can be stopped; process names/PIDs are never kill targets.
 * `persistent` marks a resident helper (such as the index scanner) that has no overall
 * deadline: its owner applies per-request deadlines and stops it when idle.
 */
export function spawnSupervised(program, args, {
  signal, timeoutMs = DEFAULT_PROCESS_TIMEOUT_MS, kind = 'helper', persistent = false,
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 1_800_000) {
    throw new MotorError('INVALID_PROCESS_TIMEOUT', 'El tiempo máximo debe estar entre 1 y 1800000 ms.');
  }
  if (signal?.aborted) throw new MotorError('PROCESS_CANCELLED', 'La operación se canceló.');
  const child = spawn(program, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false });
  const record = {
    id: randomUUID(), pid: child.pid ?? null, parentPid: process.pid, kind,
    startedAt: new Date().toISOString(), timeoutMs: persistent ? null : timeoutMs, persistent, state: 'starting',
  };
  let failure = null;
  let finished = false;
  let forceTimer;
  let deadline;
  const stop = (error = new MotorError('PROCESS_CANCELLED', 'La operación se canceló.')) => {
    if (finished) return;
    failure ??= error;
    record.state = 'stopping';
    record.reason = failure.code ?? 'PROCESS_FAILED';
    child.kill();
    forceTimer ??= setTimeout(() => { if (!finished) child.kill('SIGKILL'); }, 1000);
    forceTimer.unref?.();
  };
  const abort = () => stop();
  const completed = new Promise((resolve) => {
    child.once('spawn', () => { if (!failure) record.state = 'running'; });
    child.once('error', (cause) => {
      failure ??= new MotorError('PROCESS_START_FAILED', 'No se pudo iniciar el auxiliar.', { cause });
    });
    child.once('close', (code, exitSignal) => {
      finished = true;
      clearTimeout(deadline);
      clearTimeout(forceTimer);
      signal?.removeEventListener('abort', abort);
      active.delete(record.id);
      record.state = failure ? 'stopped' : code === 0 ? 'completed' : 'failed';
      record.reason = failure?.code ?? null;
      record.endedAt = new Date().toISOString();
      record.exitCode = code;
      record.exitSignal = exitSignal;
      recent.push({ ...record });
      if (recent.length > MAX_RECENT) recent.shift();
      resolve({ code, signal: exitSignal, error: failure });
    });
  });
  active.set(record.id, { record, stop, completed });
  if (!persistent) {
    deadline = setTimeout(() => stop(new MotorError('PROCESS_TIMEOUT', 'El auxiliar excedió el tiempo permitido.')), timeoutMs);
    deadline.unref?.();
  }
  signal?.addEventListener('abort', abort, { once: true });
  // Abort could occur while creating the child; do not lose that cancellation.
  if (signal?.aborted) abort();
  return Object.freeze({ child, completed, stop, id: record.id });
}

/** Small diagnostic inventory, deliberately omitting command arguments and file contents. */
export function processDiagnostics() {
  return { ownerPid: process.pid, active: [...active.values()].map(({ record }) => ({ ...record })), recent: recent.map((item) => ({ ...item })) };
}

export async function stopSupervisedProcesses({ kind } = {}) {
  const selected = [...active.values()].filter((item) => kind === undefined || item.record.kind === kind);
  for (const item of selected) item.stop();
  await Promise.all(selected.map((item) => item.completed));
}
