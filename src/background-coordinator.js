import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readJson, writeJson, removeJson } from './storage.js';
import { withIndexLock, processAlive } from './index-lock.js';
import { MotorError } from './errors.js';

/** One background owner per local Base. A live PID is never evicted by age.
 * The short interprocess lock serializes acquisition/release; the durable
 * record also distinguishes sessions living in the same process.
 */
export function createBackgroundLease(baseDirectory, sessionId) {
  const filename = path.join(baseDirectory, 'background-owner.json');
  const token = randomUUID();
  let owned = false;
  let owner = null;
  const locked = (task) => withIndexLock(baseDirectory, 'owner', task, 'background');

  function validate(record) {
    if (!record || record.format !== 'mind-background-owner' || record.version !== 1
        || !Number.isSafeInteger(record.pid) || record.pid < 1
        || typeof record.host !== 'string' || typeof record.sessionId !== 'string'
        || typeof record.token !== 'string') {
      throw new MotorError('BACKGROUND_OWNER_INVALID', 'El registro del coordinador de fondo no es válido.');
    }
    return record;
  }

  return Object.freeze({
    async acquire() {
      if (owned) return true;
      return locked(async () => {
        const stored = await readJson(filename);
        owner = stored ? validate(stored.data) : null;
        if (owner && (owner.host !== os.hostname() || processAlive(owner.pid))) return false;
        owner = { format: 'mind-background-owner', version: 1, token, sessionId,
          pid: process.pid, host: os.hostname(), startedAt: new Date().toISOString() };
        await writeJson(filename, owner);
        owned = true;
        return true;
      });
    },
    async release() {
      if (!owned) return;
      await locked(async () => {
        const stored = await readJson(filename);
        if (stored?.data?.token === token) await removeJson(filename);
        owned = false;
        owner = null;
      });
    },
    status() {
      return { role: owned ? 'owner' : 'follower', ownerPid: owner?.pid ?? null,
        ownerSessionId: owner?.sessionId ?? null, ownerHost: owner?.host ?? null };
    },
  });
}
