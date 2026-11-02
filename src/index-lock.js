import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { MotorError } from './errors.js';

const WAIT_MS = 2000;
const RETRY_MS = 20;
/** Cada cuánto, mientras se espera, se comprueba si el dueño del bloqueo sigue vivo. */
const INSPECT_EVERY_MS = 100;
/** Un bloqueo vacío (dueño terminado antes de escribirlo) solo se recupera pasado este margen. */
const EMPTY_LOCK_GRACE_MS = 30_000;

/** true si el proceso existe en este equipo; EPERM indica que existe aunque sea de otro usuario. */
export function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/**
 * Devuelve la identidad física del bloqueo si está demostrablemente abandonado:
 * creado en este mismo equipo por un proceso que ya no existe. Ante cualquier
 * duda (otro equipo, proceso vivo o PID reutilizado, contenido ilegible
 * reciente) devuelve null y el bloqueo se respeta.
 */
async function abandoned(filename) {
  let info;
  let text;
  try {
    info = await fs.lstat(filename, { bigint: true });
    if (!info.isFile()) return null;
    text = await fs.readFile(filename, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  let owner = null;
  try {
    owner = JSON.parse(text);
  } catch {
    owner = null;
  }
  if (owner && typeof owner === 'object' && Number.isSafeInteger(owner.pid) && owner.pid > 0) {
    // Los bloqueos anteriores a este cambio no guardaban el equipo; la Base es local.
    if (owner.host !== undefined && owner.host !== os.hostname()) return null;
    return processAlive(owner.pid) ? null : info;
  }
  // Vacío: el dueño terminó entre crear y escribir el archivo. Con margen amplio,
  // porque un dueño vivo lo escribe inmediatamente después de crearlo.
  if (text === '' && Date.now() - Number(info.mtimeMs) > EMPTY_LOCK_GRACE_MS) return info;
  return null;
}

/**
 * Retira un bloqueo abandonado sin poder borrar uno vivo por error: lo aparta
 * con un rename y comprueba que lo apartado es exactamente el archivo
 * examinado. Si no lo es, lo repone solo si el nombre sigue libre.
 */
async function recover(filename, examined) {
  const aside = `${filename}.abandonado-${randomUUID()}`;
  try {
    await fs.rename(filename, aside);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  const moved = await fs.lstat(aside, { bigint: true });
  if (moved.dev !== examined.dev || moved.ino !== examined.ino) {
    await fs.link(aside, filename).catch(() => {});
    await fs.rm(aside, { force: true });
    return false;
  }
  await fs.rm(aside, { force: true });
  return true;
}

/** Nombre de bloqueo por defecto: el de los índices de carpeta. */
export const INDEX_LOCK_NAME = 'folder-index';
const LOCK_NAME = /^[a-z][a-z0-9-]{0,40}$/;
const LOCK_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * Coordinación cooperativa por índice en una Base local de confianza.
 *
 * Recuperación automática aprobada por el usuario (2026-11-01, opción B): un
 * bloqueo se retira solo si fue creado en este mismo equipo y el sistema
 * confirma que su proceso ya no existe. Si el PID se reutilizó, el bloqueo se
 * considera vivo (fallo seguro) y queda la recuperación guiada `mind reparar`.
 * Nunca se recupera por antigüedad un bloqueo con dueño vivo ni uno de otro equipo.
 *
 * lockName permite que otros datos de la Base ligados a un id (propiedades,
 * índices personalizados) usen su propio archivo `<lockName>-<id>.lock` con la
 * misma espera y la misma política de recuperación.
 */
export async function withIndexLock(baseDirectory, scopeId, task, lockName = INDEX_LOCK_NAME) {
  if (typeof lockName !== 'string' || !LOCK_NAME.test(lockName)
      || (lockName !== INDEX_LOCK_NAME && (typeof scopeId !== 'string' || !LOCK_ID.test(scopeId)))) {
    throw new MotorError('INVALID_LOCK_NAME', 'El nombre del bloqueo no es válido.');
  }
  const filename = path.join(baseDirectory, `${lockName}-${scopeId}.lock`);
  const started = performance.now();
  const deadline = started + WAIT_MS;
  let handle;
  let inspectedAt = started;
  for (;;) {
    try {
      handle = await fs.open(filename, 'wx', 0o600);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const now = performance.now();
      if (now - inspectedAt >= INSPECT_EVERY_MS) {
        inspectedAt = now;
        const examined = await abandoned(filename);
        if (examined && await recover(filename, examined)) continue;
      }
      if (now >= deadline) {
        throw new MotorError('INDEX_LOCK_TIMEOUT', lockName === INDEX_LOCK_NAME
          ? 'El índice está bloqueado por otro proceso de Mind. Si cerraste todos los agentes y persiste, ejecuta "mind reparar".'
          : 'Otro proceso de Mind está actualizando estos datos. Si cerraste todos los agentes y persiste, ejecuta "mind reparar".');
      }
      await delay(Math.min(RETRY_MS, Math.max(1, deadline - performance.now())));
    }
  }
  let owned;
  try {
    owned = await handle.stat({ bigint: true });
    await handle.writeFile(JSON.stringify({
      version: 1, owner: randomUUID(), pid: process.pid, host: os.hostname(), createdAt: new Date().toISOString(),
    }) + '\n');
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
