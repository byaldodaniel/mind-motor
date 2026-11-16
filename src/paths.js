import path from 'node:path';

export function contains(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..'
    && !relative.startsWith(`..${path.sep}`));
}

export function samePath(first, second) {
  return path.relative(first, second) === '';
}

/**
 * Carpeta de trabajo del proceso, o null si ya no existe. En macOS y Linux la
 * carpeta desde la que se inició un programa puede borrarse mientras sigue en
 * marcha, y `process.cwd()` lanza entonces un error.
 */
export function currentDirectory() {
  try {
    return process.cwd();
  } catch {
    return null;
  }
}

export const FOLD_CASE = process.platform === 'win32' || process.platform === 'darwin';

/**
 * Papelera de Mind en la raíz de cada carpeta autorizada (docs/FUNCION_03_ORGANIZAR.md).
 * Es una exclusión implícita: no se indexa, no se encuentra y las operaciones
 * normales de los agentes no la abren; solo la gestiona el organizador.
 */
export const TRASH_DIRECTORY = '.papelera-mind';
export const IMPLICIT_EXCLUSIONS = new Set([TRASH_DIRECTORY, '.codex', '.claude', '.gemini', '.git', 'node_modules']);

/** true si relativePath es la papelera de Mind o está dentro de ella. */
export function isTrashPath(relativePath) {
  if (typeof relativePath !== 'string') return false;
  const first = relativePath.split('/', 1)[0];
  return (FOLD_CASE ? first.toLowerCase() : first) === TRASH_DIRECTORY;
}

/** true si relativePath pertenece a una exclusión implícita o explícita ("/" como separador). */
export function isExcluded(exclusions, relativePath) {
  if (typeof relativePath === 'string' && relativePath !== '') {
    for (const part of relativePath.split('/')) {
      if (IMPLICIT_EXCLUSIONS.has(FOLD_CASE ? part.toLowerCase() : part)) return true;
    }
  }
  if (!Array.isArray(exclusions) || exclusions.length === 0) return false;
  const target = FOLD_CASE ? relativePath.toLowerCase() : relativePath;
  return exclusions.some((item) => {
    const excluded = FOLD_CASE ? item.toLowerCase() : item;
    return target === excluded || target.startsWith(`${excluded}/`);
  });
}

/** true si alguna exclusión queda dentro de relativePath: moverlo o borrarlo la tocaría. */
export function containsExcluded(exclusions, relativePath) {
  if (!Array.isArray(exclusions) || exclusions.length === 0) return false;
  const target = FOLD_CASE ? relativePath.toLowerCase() : relativePath;
  return exclusions.some((item) => (FOLD_CASE ? item.toLowerCase() : item).startsWith(`${target}/`));
}

/** Valida y normaliza exclusiones: rutas relativas con "/", sin "." ni "..", sin duplicados. */
export function normalizeExclusions(value) {
  if (!Array.isArray(value) || value.length > 64) return null;
  const result = [];
  for (const raw of value) {
    if (typeof raw !== 'string') return null;
    const item = raw.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (item === '' || item.length > 1024 || item.includes('\0')
        || item.split('/').some((part) => part === '' || part === '.' || part === '..')) return null;
    if (!result.some((known) => (FOLD_CASE ? known.toLowerCase() === item.toLowerCase() : known === item))) result.push(item);
  }
  return result.sort();
}
