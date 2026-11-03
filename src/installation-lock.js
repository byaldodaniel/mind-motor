import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { MotorError } from './errors.js';

/** Coordina la creación de sesiones con la sustitución de los archivos del producto. */
export async function lockInstallation(root) {
  const file = path.join(root, '.mind-arranque.lock');
  const token = randomUUID();
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      await fs.writeFile(file, JSON.stringify({ token, pid: process.pid, host: os.hostname() }), { flag: 'wx', mode: 0o600 });
      return async () => {
        const current = JSON.parse(await fs.readFile(file, 'utf8'));
        if (current.token === token) await fs.unlink(file);
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner;
      try { owner = JSON.parse(await fs.readFile(file, 'utf8')); } catch { /* No borrar un bloqueo que aún se está escribiendo. */ }
      if (owner?.host === os.hostname() && Number.isSafeInteger(owner.pid)) {
        try { process.kill(owner.pid, 0); } catch (failure) {
          if (failure.code === 'ESRCH') { await fs.unlink(file); continue; }
        }
      }
      await delay(25);
    }
  }
  throw new MotorError('INSTALLATION_BUSY', 'Mind está ocupado. Vuelve a intentarlo.');
}
