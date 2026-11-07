import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export async function copySemanticBundle(destination, { source = fileURLToPath(new URL('../.cache/semantic/', import.meta.url)), manifestSha256 } = {}) {
  const raw = await fs.readFile(path.join(source, 'manifest.json'));
  if (createHash('sha256').update(raw).digest('hex') !== manifestSha256) throw new Error('Componente semántico no coincide con la configuración versionada. Ejecuta scripts/preparar-semantica.mjs.');
  const manifest = JSON.parse(raw);
  for (const file of manifest.files) {
    const absolute = path.resolve(source, file.path);
    const target = path.resolve(destination, file.path);
    if (!absolute.startsWith(path.resolve(source) + path.sep) || !target.startsWith(path.resolve(destination) + path.sep)) throw new Error('Ruta semántica fuera del paquete.');
    const info = await fs.lstat(absolute);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Componente semántico no regular.');
    const data = await fs.readFile(absolute);
    if (createHash('sha256').update(data).digest('hex') !== file.sha256) throw new Error('Componente semántico alterado: ' + file.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, data, { flag: 'wx', mode: 0o644 });
  }
  await fs.writeFile(path.join(destination, 'manifest.json'), raw, { flag: 'wx', mode: 0o644 });
}
