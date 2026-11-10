import { identifyCurrentProcess, inspectProcessOwners } from './process-identity.js';
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
async function abandoned(filename, { pythonExecutable, ownerInspector = inspectProcessOwners } = {}) {
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
    const [status] = await ownerInspector([{ ...owner, host: owner.host ?? os.hostname() }], { pythonExecutable });
    return status.state === 'stale' ? info : null;
  }
  // Empty/corrupt coordination never proves abandonment, regardless of age.

  return null;
}

/**
 * Serializa la recuperación con una barrera que también respetan quienes
 * adquieren el bloqueo. Se vuelve a examinar el dueño dentro de esa barrera:
 * una observación anterior podría pertenecer a un bloqueo ya reemplazado.
 * La barrera no se recupera automáticamente; si su dueño termina aquí se
 * necesita revisión manual con todas las sesiones cerradas.
 */
async function recover(filename, identityOptions) {
  const barrier = `${filename}.recovery`;
  try {
    await fs.mkdir(barrier, { mode: 0o700 });
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
  const owned = await fs.lstat(barrier, { bigint: true });
  try {
    const examined = await abandoned(filename, identityOptions);
    if (!examined) return false;
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
  } finally {
    const current = await fs.lstat(barrier, { bigint: true });
    if (!current.isDirectory() || current.dev !== owned.dev || current.ino !== owned.ino) {
      throw new MotorError('INDEX_LOCK_LOST', 'La barrera de recuperación cambió; no se elimina una barrera ajena.');
    }
    await fs.rmdir(barrier);
  }
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
 * confirma que terminó o que su identidad nativa ya no corresponde. Un dueño
 * indeterminado conserva el bloqueo y requiere la recuperación guiada `mind reparar`.
 * Nunca se recupera por antigüedad un bloqueo con dueño vivo ni uno de otro equipo.
 *
 * lockName permite que otros datos de la Base ligados a un id (propiedades,
 * índices personalizados) usen su propio archivo `<lockName>-<id>.lock` con la
 * misma espera y la misma política de recuperación.
 */
export async function withIndexLock(baseDirectory, scopeId, task, lockName = INDEX_LOCK_NAME, { timeoutMs = WAIT_MS, signal, pythonExecutable, ownerInspector = inspectProcessOwners } = {}) {
  if (typeof lockName !== 'string' || !LOCK_NAME.test(lockName)
      || (lockName !== INDEX_LOCK_NAME && (typeof scopeId !== 'string' || !LOCK_ID.test(scopeId)))) {
    throw new MotorError('INVALID_LOCK_NAME', 'El nombre del bloqueo no es válido.');
  }
  const ownerIdentity = await identifyCurrentProcess({ pythonExecutable });
  const filename = path.join(baseDirectory, `${lockName}-${scopeId}.lock`);
  const started = performance.now();
  const deadline = started + timeoutMs;
  let handle;
  let inspectedAt = started;
  async function waitForRecovery() {
    for (;;) {
      signal?.throwIfAborted();
      try { await fs.lstat(`${filename}.recovery`); }
      catch (error) { if (error.code === 'ENOENT') return; throw error; }
      if (performance.now() >= deadline) {
        throw new MotorError('INDEX_LOCK_TIMEOUT', 'La recuperación de la coordinación sigue ocupada. Si persiste tras cerrar todos los agentes, revisa la barrera .recovery antes de retirarla manualmente.');
      }
      await delay(Math.min(RETRY_MS, Math.max(1, deadline - performance.now())), undefined, { signal });
    }
  }
  for (;;) {
    signal?.throwIfAborted();
    await waitForRecovery();
    try {
      handle = await fs.open(filename, 'wx', 0o600);
      break;
    } catch (error) {
      // Windows puede devolver EPERM mientras otro proceso termina de desvincular el bloqueo.
      // Solo reintentar la creación exclusiva, con el mismo plazo; nunca conceder permisos.
      if (error.code !== 'EEXIST' && !(process.platform === 'win32' && error.code === 'EPERM')) throw error;
      const now = performance.now();
      if (now - inspectedAt >= INSPECT_EVERY_MS) {
        inspectedAt = now;
        const examined = await abandoned(filename, { pythonExecutable, ownerInspector });
        if (examined && await recover(filename, { pythonExecutable, ownerInspector })) continue;
      }
      if (now >= deadline) {
        throw new MotorError('INDEX_LOCK_TIMEOUT', lockName === INDEX_LOCK_NAME
          ? 'El índice está bloqueado por otro proceso de Mind. Si cerraste todos los agentes y persiste, ejecuta "mind reparar".'
          : 'Otro proceso de Mind está actualizando estos datos. Si persiste con los agentes cerrados, revisa el diagnóstico de coordinación.');
      }
      await delay(Math.min(RETRY_MS, Math.max(1, deadline - performance.now())), undefined, { signal });
    }
  }
  let owned;
  async function requireOwnedLock() {
    const current = await fs.lstat(filename, { bigint: true }).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!owned || !current?.isFile() || current.dev !== owned.dev || current.ino !== owned.ino) {
      throw new MotorError('INDEX_LOCK_LOST', 'El archivo de coordinación cambió; no se usa ni se elimina un bloqueo ajeno.');
    }
  }
  try {
    owned = await handle.stat({ bigint: true });
    await handle.writeFile(JSON.stringify({
      version: 2, owner: randomUUID(), ...ownerIdentity, createdAt: new Date().toISOString(),
    }) + '\n');
    // The barrier may have appeared between the first check and open('wx').
    // Publish our live owner before waiting, but never enter the task through
    // the temporary filename gap left by a recovery in progress.
    await waitForRecovery();
    await requireOwnedLock();
    signal?.throwIfAborted();
    return await task();
  } finally {
    try {
      // Nunca borrar un archivo distinto del creado por este propietario.
      await requireOwnedLock();
      await handle.close();
      handle = null;
      await fs.unlink(filename);
    } finally {
      await handle?.close();
    }
  }
}
