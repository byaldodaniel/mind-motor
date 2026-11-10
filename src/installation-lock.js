import path from 'node:path';
import { acquireOwnerFileLock } from './process-identity.js';
import { MotorError } from './errors.js';

/** Shared gate for publishing sessions and substituting product files. */
export async function lockInstallation(root, options = {}) {
  try {
    return await acquireOwnerFileLock(path.join(root, '.mind-arranque.lock'), { timeoutMs: 5000, ...options });
  } catch (error) {
    if (['LOCK_BUSY', 'PROCESS_IDENTITY_UNKNOWN'].includes(error.code)) {
      throw new MotorError('INSTALLATION_BUSY', 'Mind está ocupado o no se pudo comprobar su propietario.', { cause: error });
    }
    throw error;
  }
}
