import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { productPaths, productRuntime } from './layout.js';
import { releaseOf } from './package-descriptor.js';

const fail = (code, message) => Object.assign(new Error(message), { code });
/** Ejecuta el programa instalado con SU Node y una Base real, sin habilitar tráfico de clientes. */
export async function verifyInstalledBase({ root, manifest, baseDirectory, handoffId, verificationToken, parent, pythonExecutable, expectedBaseId,
  timeoutMs = 60_000 } = {}) {
  const runtime = productRuntime(root, manifest), product = productPaths(root, manifest);
  const child = spawn(runtime.nodeExecutable, [path.join(product.motorDirectory, 'bin', 'verify-update.js')], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_OPTIONS: '', MIND_UPDATE_VERIFY: JSON.stringify({ root, baseDirectory, handoffId, verificationToken,
      parent, pythonExecutable, expectedBaseId, release: releaseOf(manifest), timeoutMs }), MIND_PYTHON: pythonExecutable },
  });
  return new Promise((resolve, reject) => {
    let output = '', errors = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs + 5_000);
    child.stdout.on('data', chunk => { output = (output + chunk).slice(-32768); });
    child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-4096); });
    child.once('error', error => { clearTimeout(timer); reject(fail('UPDATE_CHECK_FAILED', error.message)); });
    child.once('close', code => {
      clearTimeout(timer);
      let value; try { value = JSON.parse(output); } catch {}
      if (timedOut || code !== 0 || value?.ok !== true || value.baseDirectory !== baseDirectory
          || value.baseId !== expectedBaseId
          || JSON.stringify(value.release) !== JSON.stringify(releaseOf(manifest))) {
        reject(fail('UPDATE_CHECK_FAILED', `El Motor nuevo no pudo servir la Base real: ${value?.error ?? errors ?? code}`));
      } else resolve(value);
    });
  });
}
