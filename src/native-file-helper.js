import { spawn } from 'node:child_process';
import path from 'node:path';
import { MotorError } from './errors.js';

/** The host supplies the executable. User operations supply only the request on stdin. */
export function spawnFileHelper({ pythonExecutable, script, nativeFilesExecutable, operation, writes = false }) {
  const parent = ['--parent-pid', String(process.pid)];
  if (nativeFilesExecutable !== undefined
      && (typeof nativeFilesExecutable !== 'string' || !path.isAbsolute(nativeFilesExecutable))) {
    throw new MotorError('SAFE_OPEN_UNAVAILABLE', 'El auxiliar seguro requiere una ruta absoluta.');
  }
  const command = nativeFilesExecutable ?? pythonExecutable;
  const args = nativeFilesExecutable === undefined ? ['-I', '-B', script, ...parent] : [operation, ...parent];
  // Accepted mutations have bounded time to publish if the parent exits on Windows.
  const child = spawn(command, args, {
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: writes && process.platform === 'win32',
  });
  child.stdout.setEncoding('utf8');
  return child;
}
