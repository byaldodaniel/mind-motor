import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { withIndexLock, processAlive } from './index-lock.js';
import { MotorError } from './errors.js';

const HOST = os.hostname();
const WAIT_LIMIT_MS = 300_000;
const states = new Map();
const cpuTimes = () => os.cpus().reduce((sum, cpu) => ({
  idle: sum.idle + cpu.times.idle,
  total: sum.total + Object.values(cpu.times).reduce((a, b) => a + b, 0),
}), { idle: 0, total: 0 });

/** Admission of heavy indexing only; never stops or changes other applications. */
export function createResourceGovernor(baseDirectory, { sample, waitLimitMs = WAIT_LIMIT_MS } = {}) {
  const directory = path.join(baseDirectory, 'resource-queue');
  const key = path.resolve(baseDirectory);
  let state = states.get(key);
  if (!state) {
    state = { previous: cpuTimes(), at: 0, cpuPercent: null, pressured: false, reason: null, active: null, completed: 0 };
    states.set(key, state);
  }
  function pressure() {
    if (sample) return sample();
    const now = Date.now();
    if (now - state.at >= 1000) {
      const current = cpuTimes();
      const elapsed = current.total - state.previous.total;
      if (elapsed > 0) state.cpuPercent = Math.max(0, Math.min(100, 100 * (1 - (current.idle - state.previous.idle) / elapsed)));
      state.previous = current;
      state.at = now;
    }
    const free = os.freemem();
    const low = Math.max(256 * 1024 ** 2, os.totalmem() * 0.08);
    if (free < low || state.cpuPercent >= 85) state.pressured = true;
    else if (free > low * 1.5 && state.cpuPercent < 65) state.pressured = false;
    state.reason = state.pressured ? (free < low * 1.5 ? 'memoria' : 'cpu') : null;
    return { pressured: state.pressured, reason: state.reason, cpuPercent: state.cpuPercent, freeBytes: free, totalBytes: os.totalmem() };
  }
  async function tickets() {
    const names = await fs.readdir(directory).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    const items = [];
    for (const name of names) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
      let item;
      try { item = JSON.parse(await fs.readFile(path.join(directory, name), 'utf8')); } catch { continue; }
      if (item.id + '.json' !== name || !Number.isSafeInteger(item.pid) || !Number.isFinite(item.createdAt)) continue;
      if (item.host === HOST && (!processAlive(item.pid) || Date.now() - item.createdAt > WAIT_LIMIT_MS)) {
        // Each name is a unique request, never a reusable lock or a foreign process.
        await fs.unlink(path.join(directory, name)).catch(() => {});
        continue;
      }
      if (item.scopeId && /^[a-f0-9]{64}$/.test(item.scopeId)) {
        try {
          const promotion = JSON.parse(await fs.readFile(path.join(directory, `priority-${item.scopeId}.json`), 'utf8'));
          if (promotion.until > Date.now()) item.priority = 'interactive';
        } catch { /* No interactive request waiting for this scope. */ }
      }
      items.push(item);
    }
    // Age a waiting background request after 30 seconds; the global lock still
    // protects active work even when its request lifetime expires.
    const allowAging = !pressure().pressured;
    const rank = item => item.priority === 'interactive' || (allowAging && Date.now() - item.createdAt > 30_000) ? 0 : 1;
    return items.sort((a, b) => rank(a) - rank(b)
      || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }
  return {
    async promote(scopeId, timeoutMs = 60_000) {
      if (!/^[a-f0-9]{64}$/.test(scopeId)) throw new MotorError('INVALID_SCOPE_ID', 'Ámbito no válido.');
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const file = path.join(directory, `priority-${scopeId}.json`);
      await withIndexLock(baseDirectory, scopeId, async () => {
        let prior = 0;
        try { prior = JSON.parse(await fs.readFile(file, 'utf8')).until ?? 0; } catch {}
        await fs.writeFile(file, JSON.stringify({ until: Math.max(prior, Date.now() + Math.min(timeoutMs, WAIT_LIMIT_MS)) }), { mode: 0o600 });
      }, 'resource-priority');
    },
    async run(task, { signal, priority = 'interactive', scopeId } = {}) {
      signal?.throwIfAborted();
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const ticket = { id: randomUUID(), pid: process.pid, host: HOST, createdAt: Date.now(), priority, scopeId };
      const file = path.join(directory, ticket.id + '.json');
      await fs.writeFile(file, JSON.stringify(ticket), { flag: 'wx', mode: 0o600 });
      try {
        for (;;) {
          signal?.throwIfAborted();
          if (Date.now() - ticket.createdAt > waitLimitMs) throw new MotorError('RESOURCE_BUSY', 'El trabajo quedó aplazado por carga del equipo; se conserva el índice anterior.');
          const queue = await tickets();
          const load = pressure();
          if (queue[0]?.id === ticket.id && (queue[0].priority !== 'background' || !load.pressured)) {
            let admitted = false;
            try {
              const outcome = await withIndexLock(baseDirectory, 'global', async () => {
                // Recheck priority after acquiring the cross-process budget.
                if ((await tickets())[0]?.id !== ticket.id) return { admitted: false };
                admitted = true;
                state.active = { ...ticket, startedAt: Date.now() };
                try { const value = await task(); state.completed++; return { admitted: true, value }; }
                finally { state.active = null; }
              }, 'resource-work', { timeoutMs: 100, signal });
              if (outcome.admitted) return outcome.value;
            } catch (error) { if (admitted || error.code !== 'INDEX_LOCK_TIMEOUT') throw error; }
          }
          // Deferred background work must not keep a closed client alive.
          await delay(100, undefined, { signal, ref: priority !== 'background' });
        }
      } finally { await fs.unlink(file).catch(() => {}); }
    },
    async status() {
      return { maxRecorridosSimultaneos: 1, ...pressure(), tareaLocal: state.active,
        cola: (await tickets()).map(({ id, pid, priority, createdAt, scopeId }) => ({ id, pid, priority, createdAt, scopeId })),
        completadosEnEsteProceso: state.completed, memoriaProceso: process.memoryUsage() };
    },
  };
}
