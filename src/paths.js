import path from 'node:path';

export function contains(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..'
    && !relative.startsWith(`..${path.sep}`));
}

export function samePath(first, second) {
  return path.relative(first, second) === '';
}

const FOLD_CASE = process.platform === 'win32' || process.platform === 'darwin';

/** true si relativePath es una exclusión o está dentro de una ("/" como separador). */
export function isExcluded(exclusions, relativePath) {
  if (!Array.isArray(exclusions) || exclusions.length === 0) return false;
  const target = FOLD_CASE ? relativePath.toLowerCase() : relativePath;
  return exclusions.some((item) => {
    const excluded = FOLD_CASE ? item.toLowerCase() : item;
    return target === excluded || target.startsWith(`${excluded}/`);
  });
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
