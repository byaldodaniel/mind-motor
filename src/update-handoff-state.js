import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { inspectProcessOwners } from './process-identity.js';
import { ensureUpdateDirectory } from './update-state.js';

export const BLOCKING_PHASES = new Set(['aplicando', 'verificando']);
export const HANDOFF_PHASES = new Set(['iniciando', 'descargando', 'preparando', 'espera-quietud', ...BLOCKING_PHASES, 'completada', 'fallida']);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const fail = (code, message) => Object.assign(new Error(message), { code });
export const handoffPath = root => path.join(root, 'Sistema', 'Actualizaciones', 'relevo.json');
export function handoffDirectory(root, id) {
  if (!UUID.test(id ?? '')) throw fail('UPDATE_HANDOFF_INVALID', 'Identificador de relevo no válido.');
  return path.join(root, 'Sistema', 'Actualizaciones', 'Relevos', id);
}
export async function ensureHandoffDirectory(root, id) {
  await ensureUpdateDirectory(root, true);
  let directory = path.join(await fs.realpath(root), 'Sistema', 'Actualizaciones');
  handoffDirectory(root, id);
  for (const part of ['Relevos', id]) {
    directory = path.join(directory, part);
    const info = await fs.lstat(directory).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (info && (!info.isDirectory() || info.isSymbolicLink())) throw fail('UPDATE_PATH_LINK', 'El destino del relevista no es una carpeta normal.');
    if (!info) await fs.mkdir(directory, { mode: 0o700 });
  }
  return directory;
}

export async function checkedHandoffFile(root, file) {
  // Compara primero rutas léxicas del mismo origen: TEMP puede usar el alias
  // Windows ALDODA~1, mientras realpath devuelve Aldo Daniel. Después recorre la
  // raíz física sin seguir ningún enlace interior.
  const relative = path.relative(path.resolve(root), path.resolve(file));
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw fail('UPDATE_PATH_INVALID', 'La ruta del relevo sale de Mind.');
  let current = await fs.realpath(root);
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    const info = await fs.lstat(current);
    if (info.isSymbolicLink()) throw fail('UPDATE_PATH_LINK', 'El relevo contiene un enlace.');
  }
  if (!(await fs.lstat(current)).isFile()) throw fail('UPDATE_HANDOFF_INVALID', 'Falta un archivo regular del relevo.');
  return current;
}
export async function readHandoff(root) {
  await ensureUpdateDirectory(root);
  const file = handoffPath(root);
  let info;
  try { info = await fs.lstat(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  if (!info.isFile() || info.isSymbolicLink() || info.size > 128 * 1024) throw fail('UPDATE_HANDOFF_INVALID', 'El registro del relevo no es válido; se conserva.');
  let value;
  try { value = JSON.parse(await fs.readFile(file, 'utf8')); } catch { throw fail('UPDATE_HANDOFF_INVALID', 'El registro del relevo no se puede leer; se conserva.'); }
  if (value?.format !== 'mind-update-handoff' || value.version !== 1 || !UUID.test(value.id ?? '') || !HANDOFF_PHASES.has(value.phase)) throw fail('UPDATE_HANDOFF_INVALID', 'El registro del relevo no corresponde a una operación conocida.');
  return value;
}
export async function writeHandoff(root, value) {
  if (!UUID.test(value.id ?? '') || !HANDOFF_PHASES.has(value.phase)) throw fail('UPDATE_HANDOFF_INVALID', 'Estado de relevo no válido.');
  await ensureUpdateDirectory(root, true);
  const file = handoffPath(root), temporary = file + '.' + randomUUID() + '.tmp';
  const handle = await fs.open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify({ ...value, format: 'mind-update-handoff', version: 1 }) + '\n'); await handle.sync(); }
  finally { await handle.close(); }
  try { await fs.rename(temporary, file); } catch (e) { await fs.rm(temporary, { force: true }); throw e; }
  // Cada snapshot conserva su último dueño y fase aun después de empezar otro relevo.
  const directory = handoffDirectory(root, value.id);
  const info = await fs.lstat(directory).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
  if (info?.isDirectory() && !info.isSymbolicLink()) {
    await ensureHandoffDirectory(root, value.id);
    const mirror = path.join(directory, 'registro.json'), temp = mirror + '.' + randomUUID() + '.tmp';
    await fs.writeFile(temp, JSON.stringify({ ...value, format: 'mind-update-handoff', version: 1 }) + '\n', { flag: 'wx', mode: 0o600 });
    await fs.rename(temp, mirror);
  }
}
export async function handoffOwner(record, pythonExecutable) {
  if (typeof record?.owner?.processBirth !== 'string' || !record.owner.processBirth
      || typeof record.owner.instanceToken !== 'string' || !record.owner.instanceToken) return 'unknown';
  const [owner] = await inspectProcessOwners([record?.owner], { pythonExecutable });
  return owner?.state ?? 'unknown';
}
async function recoverWithRunner(root, record) {
  const directory = handoffDirectory(root, record.id);
  const node = await checkedHandoffFile(root, path.join(directory, 'Node', process.platform === 'win32' ? 'node.exe' : 'bin/node'));
  const runner = await checkedHandoffFile(root, path.join(directory, 'Motor', 'bin', 'update-handoff.js'));
  return new Promise((resolve, reject) => {
    const child = spawn(node, [runner, root, record.id, '--recover'], { stdio: 'ignore', windowsHide: true, env: { ...process.env, NODE_OPTIONS: '' } });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(fail('UPDATE_RECOVERY_BLOCKED', 'La recuperación del relevo sigue pendiente; se conservan sus archivos.')));
  });
}
/** Retira sólo un snapshot terminal cuyo propietario ya terminó; el acta permanece. */
export async function cleanupHandoffRunner(root, record) {
  if (!record || !['completada', 'fallida'].includes(record.phase)) return false;
  try {
    const directory = handoffDirectory(root, record.id);
    const python = await checkedHandoffFile(root, path.join(directory, 'Python', process.platform === 'win32' ? 'python.exe' : 'bin/python3'));
    if (await handoffOwner(record, python) !== 'stale') return false;
    // Cada componente del destino se comprobó sin enlaces al validar Python.
    // El destino es siempre el directorio de un UUID dentro de Relevos.
    if (!(await fs.lstat(directory)).isDirectory() || (await fs.lstat(directory)).isSymbolicLink()) return false;
    await fs.rm(directory, { recursive: true, force: true });
    return true;
  } catch { return false; }
}

/** Limpia snapshots terminales acreditados, conservando los activos o no verificables. */
export async function cleanupHandoffRunners(root) {
  const directory = path.join(root, 'Sistema', 'Actualizaciones', 'Relevos');
  let entries;
  try {
    const info = await fs.lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) return;
    entries = await fs.readdir(directory);
  } catch { return; }
  for (const id of entries) {
    if (!UUID.test(id)) continue;
    try {
      const file = await checkedHandoffFile(root, path.join(handoffDirectory(root, id), 'registro.json'));
      if ((await fs.stat(file)).size > 128 * 1024) continue;
      const record = JSON.parse(await fs.readFile(file, 'utf8'));
      if (record.id === id && record.format === 'mind-update-handoff' && record.version === 1) await cleanupHandoffRunner(root, record);
    } catch { /* Un snapshot no verificable se conserva. */ }
  }
}

/** Espera al relevista; nunca considera un PID o una fecha prueba de abandono. */
export async function waitForHandoff({ root, pythonExecutable, pollMs = 100, signal, recover = recoverWithRunner } = {}) {
  if (!root) return { waited: false };
  let waited = false;
  for (;;) {
    const record = await readHandoff(root);
    if (!record || !BLOCKING_PHASES.has(record.phase)) {
      await cleanupHandoffRunner(root, record);
      await cleanupHandoffRunners(root);
      return { waited, phase: record?.phase ?? null };
    }
    waited = true;
    // El Python instalado también puede estar apartado durante la sustitución.
    // La copia estable se preparó antes de levantar esta barrera.
    const snapshotPython = await checkedHandoffFile(root, path.join(handoffDirectory(root, record.id), 'Python',
      process.platform === 'win32' ? 'python.exe' : 'bin/python3'));
    const owner = await handoffOwner(record, snapshotPython);
    if (owner === 'unknown') throw fail('UPDATE_OWNER_UNKNOWN', 'No se puede verificar al relevista; se conserva la operación.');
    if (owner === 'stale') { await recover(root, record); continue; }
    await delay(pollMs, undefined, { signal });
  }
}
