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

export const UPDATE_PHASES = ['al-dia', 'disponible', 'descargando', 'descargada', 'instalando', 'actualizada', 'limpieza-pendiente',
  'requiere-reparacion', 'fallida', 'espera-sesiones', 'espera-verificacion'];
const LEGACY_KEYS = ['reason', 'code', 'kind', 'retryable', 'source', 'packageSha256', 'installedPackageSha256'];

/** Convierte en memoria un estado versión 1 (fase mezclada con el último error) a la versión 2. */
function upgradeState(value) {
  const { reason, code, kind, retryable, source, packageSha256, installedPackageSha256, ...rest } = value;
  let phase = rest.phase;
  if (phase === 'comprobando') phase = rest.envelope ? 'disponible' : 'al-dia';
  else if (phase === 'preparada') phase = 'descargada';
  if (!UPDATE_PHASES.includes(phase)) phase = rest.envelope ? 'disponible' : 'al-dia';
  const sha = packageSha256 ?? installedPackageSha256;
  const hasError = Boolean(kind || code || reason);
  return { ...rest, format: 'mind-update-state', version: 2, phase,
    package: rest.package ?? (/^[a-f0-9]{64}$/u.test(sha ?? '') ? { url: null, bytes: null, sha256: sha } : null),
    lastError: hasError ? { code: code ?? null, kind: kind ?? null, retryable: retryable === true, message: reason ?? null, at: rest.updatedAt ?? null } : null };
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
    if (value?.format !== 'mind-update-state' || ![1, 2].includes(value.version)) throw Object.assign(new Error('El estado de actualización no es válido.'), { code: 'UPDATE_STATE_INVALID' });
    return value.version === 1 ? upgradeState(value) : { ...value, lastError: value.lastError ?? null };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function writeUpdateState(root, value) {
  const { directory, file } = updateStatePaths(root);
  await ensureUpdateDirectory(root, true);
  const clean = { ...value };
  for (const key of LEGACY_KEYS) delete clean[key];
  clean.lastError ??= null;
  const temporary = path.join(directory, `.estado-${randomUUID()}.tmp`);
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify({ ...clean, format: 'mind-update-state', version: 2 }) + '\n');
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
  if (/SIGNATURE|ALTERED|HASH|DESCRIPTOR|MANIFEST|NOTES/u.test(code)) return { code, kind: 'integridad', retryable: false };
  if (/INCOMPATIBLE|MISMATCH|PLATFORM|PROTOCOL|RELEASE_INVALID/u.test(code)) return { code, kind: 'compatibilidad', retryable: false };
  return { code, kind: 'actualizador', retryable: false };
}