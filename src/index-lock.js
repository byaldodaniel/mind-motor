import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { MotorError } from './errors.js';

const WAIT_MS = 2000;
const RETRY_MS = 20;

/**
 * Coordinación cooperativa por índice en una Base local de confianza.
 * No se recuperan bloqueos por edad ni PID: un abandono exige detener todos
 * los procesos de esa Base antes de que el operador retire el archivo.
 */
export async function withIndexLock(baseDirectory, scopeId, task) {
  const filename = path.join(baseDirectory, `folder-index-${scopeId}.lock`);
  const deadline = performance.now() + WAIT_MS;
  let handle;
  for (;;) {
    try {
      handle = await fs.open(filename, 'wx', 0o600);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (performance.now() >= deadline) {
        throw new MotorError('INDEX_LOCK_TIMEOUT', 'El índice está bloqueado. No se eliminó el bloqueo; si quedó abandonado, detén todos los procesos de la Base antes de retirarlo.');
      }
      await delay(Math.min(RETRY_MS, Math.max(1, deadline - performance.now())));
    }
  }
  let owned;
  try {
    owned = await handle.stat({ bigint: true });
    await handle.writeFile(JSON.stringify({ version: 1, owner: randomUUID(), pid: process.pid, createdAt: new Date().toISOString() }) + '\n');
    return await task();
  } finally {
    try {
      // Nunca borrar un archivo distinto del creado por este propietario.
      const current = await fs.lstat(filename, { bigint: true });
      if (!owned || !current.isFile() || current.dev !== owned.dev || current.ino !== owned.ino) {
        throw new MotorError('INDEX_LOCK_LOST', 'El archivo de coordinación cambió; no se elimina un bloqueo ajeno.');
      }
      await handle.close();
      handle = null;
      await fs.unlink(filename);
    } finally {
      await handle?.close();
    }
  }
}
