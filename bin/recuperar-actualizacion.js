#!/usr/bin/env node
// Recovery-only entry point used by the stable bootstrap and its trusted snapshot.
import fs from 'node:fs/promises';
import path from 'node:path';
import { recoverUpdateTransaction } from '../src/update-transaction.js';

function fail(code, message) { return Object.assign(new Error(message), { code }); }
async function productReady(root) {
  for (const file of [
    path.join(root, 'Sistema', 'mind-producto.json'),
    path.join(root, 'Sistema', 'Programa', 'Motor', 'bin', 'mind.js'),
  ]) {
    const info = await fs.lstat(file).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink()) return false;
  }
  return true;
}

try {
  const args = process.argv.slice(2);
  if (args.length !== 3 || args[1] !== '--python' || !path.isAbsolute(args[0]) || !path.isAbsolute(args[2])) {
    throw fail('UPDATE_RECOVERY_ARGUMENTS', 'La recuperación requiere My Mind y su Python incluido.');
  }
  const root = await fs.realpath(args[0]);
  try {
    await recoverUpdateTransaction(root, { pythonExecutable: args[2] });
  } catch (error) {
    // The worker executable may still prevent removal of its own recovery tree.
    // A completed rollback can start the restored program; cleanup is retried only
    // after this worker exits. The bootstrap never deletes recovery payload itself.
    if (error.code !== 'UPDATE_CLEANUP_PENDING' || !(await productReady(root))) throw error;
  }
  if (!(await productReady(root))) throw fail('UPDATE_RECOVERY_INCOMPLETE', 'La recuperación no dejó un programa completo para iniciar.');
} catch (error) {
  process.stderr.write(JSON.stringify({ code: error.code || 'UPDATE_RECOVERY_FAILED', message: error.message }) + '\n');
  process.exitCode = 1;
}
