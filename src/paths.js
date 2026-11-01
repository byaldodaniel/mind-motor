import path from 'node:path';

export function contains(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..'
    && !relative.startsWith(`..${path.sep}`));
}

export function samePath(first, second) {
  return path.relative(first, second) === '';
}
