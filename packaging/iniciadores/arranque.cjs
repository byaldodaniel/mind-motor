'use strict';
// Stable launcher: it must remain outside the program groups being replaced.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const MUTATING_PHASES = new Set(['snapshotting', 'snapshotted', 'restoring-base', 'aside', 'placing', 'base', 'verifying']);
const STABLE_PHASES = new Set(['prepared', 'committed', 'cleanup-pending', 'rolled-back']);
const HANDOFF_PHASES = new Set(['iniciando', 'descargando', 'preparando', 'espera-quietud', 'aplicando', 'verificando', 'completada', 'fallida']);
const BLOCKING_HANDOFF_PHASES = new Set(['aplicando', 'verificando']);
const HANDOFF_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
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

// Esta lectura mínima vive fuera de Programa: nunca importa un grupo que el
// relevista pueda estar renombrando. El helper se carga desde su snapshot estable.
function readHandoffMarker(root, system) {
  const file = path.join(system, 'Actualizaciones', 'relevo.json');
  let info;
  try { info = fs.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  checkedPath(root, file);
  if (info.size > 128 * 1024) throw makeError('UPDATE_HANDOFF_INVALID', 'La marca del relevo es demasiado grande; se conserva.');
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw makeError('UPDATE_HANDOFF_INVALID', 'La marca del relevo no es válida; se conserva.'); }
  if (!value || value.format !== 'mind-update-handoff' || value.version !== 1
      || !HANDOFF_ID.test(value.id) || !HANDOFF_PHASES.has(value.phase)) {
    throw makeError('UPDATE_HANDOFF_INVALID', 'La marca del relevo no corresponde a una operación admitida; se conserva.');
  }
  return value;
}

async function waitForBootstrapHandoff(root, system) {
  const marker = readHandoffMarker(root, system);
  if (!marker || !BLOCKING_HANDOFF_PHASES.has(marker.phase)) return { waited: false };
  const worker = path.join(system, 'Actualizaciones', 'Relevos', marker.id);
  const helper = checkedPath(root, path.join(worker, 'Motor', 'src', 'update-handoff-state.js'));
  const python = checkedPath(root, path.join(worker, 'Python', ...(process.platform === 'win32' ? ['python.exe'] : ['bin', 'python3'])));
  const loaded = await import(pathToFileURL(helper).href);
  if (typeof loaded.waitForHandoff !== 'function') throw makeError('UPDATE_HANDOFF_INVALID', 'Falta el esperador estable del relevo.');
  await loaded.waitForHandoff({ root, pythonExecutable: python });
  const current = readHandoffMarker(root, system);
  if (current && BLOCKING_HANDOFF_PHASES.has(current.phase)) throw makeError('UPDATE_HANDOFF_BLOCKED', 'El relevo todavía está cambiando Mind; no se inicia un programa parcial.');
  return { waited: true };
}

function executeUpdatedProgram(node, launcher, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(node, [launcher, ...args], {
      stdio: 'inherit', windowsHide: true, env: { ...process.env, NODE_OPTIONS: '' },
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (signal) reject(makeError('UPDATE_RELAY_INTERRUPTED', 'El programa actualizado se cerró antes de terminar.'));
      else resolve(code ?? 1);
    });
  });
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

async function bootstrap({ systemDirectory = __dirname, runRecovery = executeRecovery, importProgram = file => import(pathToFileURL(file).href), runUpdated = executeUpdatedProgram } = {}) {
  // Puente de un chat: un solo hilo de libuv (el programa lo confirma; ver lightenBridge).
  // Se fija aquí, antes de cualquier operación asíncrona de archivos.
  const args = process.argv.slice(2);
  const command = args.find((value, index) => !value.startsWith('--') && !['--base', '--carpeta'].includes(args[index - 1]));
  if (command === 'mcp' && !args.includes('--direct') && !process.env.UV_THREADPOOL_SIZE) {
    process.env.UV_THREADPOOL_SIZE = '1';
    process.env.MIND_PUENTE_LIGERO = '1';
  }
  const system = fs.realpathSync(systemDirectory);
  const root = fs.realpathSync(path.dirname(system));
  await waitForBootstrapHandoff(root, system);
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
  await waitForBootstrapHandoff(root, system);
  try {
    const entry = checkedPath(root, path.join(system, 'Programa', 'Motor', 'bin', 'mind.js'));
    checkedPath(root, path.join(system, 'mind-producto.json'));
    // Normal startup imports the program into this process, not another Node per chat.
    return await importProgram(entry);
  } catch (error) {
    if (['ERR_MODULE_NOT_FOUND', 'ENOENT'].includes(error.code)) {
      const waited = await waitForBootstrapHandoff(root, system);
      if (waited.waited) {
        // Un import fallido queda cacheado por Node. El proceso nuevo carga sólo
        // módulos de la entrega verificada y conserva los argumentos del cliente.
        const node = checkedPath(root, path.join(system, 'Componentes', 'Node', process.platform + '-' + process.arch,
          ...(process.platform === 'win32' ? ['node.exe'] : ['bin', 'node'])));
        const launcher = checkedPath(root, path.join(system, 'arranque.cjs'));
        const code = await runUpdated(node, launcher, args);
        process.exitCode = code;
        return code;
      }
      const current = readJournal(root, system);
      let preparing = false;
      try { fs.lstatSync(path.join(system, 'Actualizaciones', 'preparacion.lock')); preparing = true; }
      catch (probeError) { if (probeError.code !== 'ENOENT') throw probeError; }
      if (preparing || current && MUTATING_PHASES.has(current.phase)) {
        throw makeError('INSTALLATION_BUSY', 'Mind está cambiando el programa; vuelve a iniciar cuando termine la actualización.');
      }
    }
    throw error;
  }
}

module.exports = { bootstrap, readJournal, readHandoffMarker, waitForBootstrapHandoff };

if (require.main === module) {
  bootstrap().catch(error => {
    process.stderr.write(JSON.stringify({ code: error.code || 'UPDATE_BOOTSTRAP_FAILED', message: error.message }) + '\n');
    process.exitCode = 1;
  });
}
