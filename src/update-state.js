import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function updateStatePaths(root) {
  const directory = path.join(root, 'Sistema', 'Actualizaciones');
  return { directory, file: path.join(directory, 'estado.json'), lock: path.join(directory, 'consulta.lock'), downloads: path.join(directory, 'descargas') };
}

export async function ensureUpdateDirectory(root, create = false) {
  let current = await fs.realpath(root);
  for (const name of ['Sistema', 'Actualizaciones']) {
    current = path.join(current, name);
    let info;
    try { info = await fs.lstat(current); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (info && (!info.isDirectory() || info.isSymbolicLink())) throw Object.assign(new Error('Una ruta de actualización no es una carpeta normal.'), { code: 'UPDATE_PATH_LINK' });
    if (!info) { if (!create) return; await fs.mkdir(current); }
  }
}

export async function readUpdateState(root) {
  await ensureUpdateDirectory(root);
  const { file } = updateStatePaths(root);
  try {
    const info = await fs.lstat(file);
    if (!info.isFile() || info.size > 512 * 1024) throw Object.assign(new Error('El estado de actualización no es válido.'), { code: 'UPDATE_STATE_INVALID' });
    let value;
    try { value = JSON.parse(await fs.readFile(file, 'utf8')); }
    catch (error) { throw Object.assign(new Error('El estado de actualizacion no se puede interpretar.'), { code: 'UPDATE_STATE_INVALID', cause: error }); }
    if (value.format !== 'mind-update-state' || value.version !== 1) throw Object.assign(new Error('El estado de actualización no es válido.'), { code: 'UPDATE_STATE_INVALID' });
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function writeUpdateState(root, value) {
  const { directory, file } = updateStatePaths(root);
  await ensureUpdateDirectory(root, true);
  const temporary = path.join(directory, `.estado-${randomUUID()}.tmp`);
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify({ ...value, format: 'mind-update-state', version: 1 }) + '\n');
    await handle.sync();
  } finally { await handle.close(); }
  try { await fs.rename(temporary, file); }
  catch (error) { await fs.rm(temporary, { force: true }).catch(() => {}); throw error; }
}

export function classifyUpdateError(error) {
  const code = error?.cause?.code ?? error?.code ?? 'UPDATE_FAILED';
  if (['EACCES', 'EPERM'].includes(code)) return { code, kind: 'permisos', retryable: false };
  if (['ENOTFOUND', 'EAI_AGAIN'].includes(code)) return { code, kind: 'dns', retryable: true };
  if (['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)
      || ['TimeoutError', 'AbortError'].includes(error?.name)) return { code, kind: 'conexion', retryable: true };
  if (['ENOSPC','UPDATE_DISK_SPACE'].includes(code)) return { code, kind: 'espacio', retryable: false };
  if (['MIND_IN_USE', 'SESSION_IDENTITY_UNKNOWN', 'PROCESS_IDENTITY_UNKNOWN'].includes(code)) return { code, kind: code === 'MIND_IN_USE' ? 'sesiones' : 'sesiones-no-verificables', retryable: true };
  if (error?.status) return { code: `HTTP_${error.status}`, kind: 'http', retryable: error.status === 429 || error.status >= 500 };
  if (/SIGNATURE|ALTERED|HASH|DESCRIPTOR|MANIFEST/u.test(code)) return { code, kind: 'integridad', retryable: false };
  if (/INCOMPATIBLE|MISMATCH|PLATFORM|PROTOCOL|RELEASE_INVALID/u.test(code)) return { code, kind: 'compatibilidad', retryable: false };
  return { code, kind: 'actualizador', retryable: false };
}