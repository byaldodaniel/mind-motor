'use strict';
// Stable launcher: it must remain outside the program groups being replaced.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const MUTATING_PHASES = new Set(['aside', 'placing', 'base', 'verifying']);
const STABLE_PHASES = new Set(['prepared', 'committed', 'cleanup-pending', 'rolled-back']);
const makeError = (code, message) => Object.assign(new Error(message), { code });

function checkedPath(root, target) {
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw makeError('UPDATE_BOOTSTRAP_INVALID', 'La recuperación sale de My Mind.');
  }
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const info = fs.lstatSync(current);
    if (info.isSymbolicLink()) throw makeError('UPDATE_BOOTSTRAP_LINK', 'La recuperación contiene un enlace; no se ejecuta.');
  }
  if (!fs.lstatSync(target).isFile()) throw makeError('UPDATE_BOOTSTRAP_INVALID', 'Falta un archivo regular de arranque.');
  return target;
}

function readJournal(root, system) {
  const file = path.join(system, 'Actualizaciones', 'transaccion.json');
  let info;
  try { info = fs.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  checkedPath(root, file);
  if (info.size > 32 * 1024 * 1024) throw makeError('UPDATE_JOURNAL_INVALID', 'El diario de actualización es demasiado grande.');
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw makeError('UPDATE_JOURNAL_INVALID', 'El diario de actualización no es válido; se conserva.'); }
  if (!value || value.format !== 'mind-update-transaction' || value.version !== 1
      || value.work !== 'Sistema/Actualizaciones/Trabajo/actual' || !Array.isArray(value.operations)
      || !(MUTATING_PHASES.has(value.phase) || STABLE_PHASES.has(value.phase))) {
    throw makeError('UPDATE_JOURNAL_INVALID', 'El diario de actualización no corresponde a una operación admitida.');
  }
  return value;
}

function executeRecovery(node, runner, root, python) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(node, [runner, root, '--python', python], {
        stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true,
        env: { ...process.env, NODE_OPTIONS: '' },
      });
    } catch (error) { reject(error); return; }
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0 && !signal) resolve();
      else reject(makeError('UPDATE_RECOVERY_BLOCKED', 'La recuperación no terminó; no se inicia un programa parcial.'));
    });
  });
}

async function bootstrap({ systemDirectory = __dirname, runRecovery = executeRecovery, importProgram = file => import(pathToFileURL(file).href) } = {}) {
  const system = fs.realpathSync(systemDirectory);
  const root = fs.realpathSync(path.dirname(system));
  const journal = readJournal(root, system);
  if (journal && MUTATING_PHASES.has(journal.phase)) {
    const worker = path.join(system, 'Actualizaciones', 'Trabajo', 'actual', 'recuperador');
    const windows = process.platform === 'win32';
    const node = checkedPath(root, path.join(worker, 'Node', ...(windows ? ['node.exe'] : ['bin', 'node'])));
    const python = checkedPath(root, path.join(worker, 'Python', ...(windows ? ['python.exe'] : ['bin', 'python3'])));
    const runner = checkedPath(root, path.join(worker, 'Motor', 'bin', 'recuperar-actualizacion.js'));
    await runRecovery(node, runner, root, python);
    const after = readJournal(root, system);
    if (after && MUTATING_PHASES.has(after.phase)) {
      throw makeError('UPDATE_RECOVERY_BLOCKED', 'La sustitución sigue incompleta; se conserva la recuperación.');
    }
  }
  const entry = checkedPath(root, path.join(system, 'Programa', 'Motor', 'bin', 'mind.js'));
  checkedPath(root, path.join(system, 'mind-producto.json'));
  // Normal startup imports the program into this process, not another Node per chat.
  return importProgram(entry);
}

module.exports = { bootstrap, readJournal };

if (require.main === module) {
  bootstrap().catch(error => {
    process.stderr.write(JSON.stringify({ code: error.code || 'UPDATE_BOOTSTRAP_FAILED', message: error.message }) + '\n');
    process.exitCode = 1;
  });
}
