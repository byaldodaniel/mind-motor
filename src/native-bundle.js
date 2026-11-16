import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

async function hashAndSize(file) {
  const data = await fsp.readFile(file);
  return {
    bytes: data.byteLength,
    sha256: crypto.createHash('sha256').update(data).digest('hex'),
  };
}

/**
 * Copia y verifica el binario nativo de una plataforma al directorio de staging del paquete.
 */
export async function stageNativeTarget(stage, id, nativeConfig, cacheRoot, modes) {
  const entry = nativeConfig?.plataformas?.[id];
  if (!entry) return null;

  const source = path.join(cacheRoot, id, entry.archivo);
  const { bytes, sha256 } = await hashAndSize(source).catch((error) => {
    throw new Error(`Falta el binario nativo para ${id} en ${source}: ${error.message}`);
  });
  if (bytes !== entry.bytes || sha256 !== entry.sha256) {
    throw new Error(`El binario nativo de ${id} no coincide con packaging/nativo.json (${bytes} B, ${sha256}).`);
  }

  const destination = path.join(stage, ...entry.ruta.split('/'));
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  const mode = id.startsWith('win32-') ? 0o644 : 0o755;
  await fsp.copyFile(source, destination);
  await fsp.chmod(destination, mode).catch(() => {});
  if (modes) modes.set(entry.ruta, mode);

  return {
    name: 'nativo',
    version: `${entry.motor} ${entry.version}`,
    source: entry.motor,
    sha256: entry.sha256,
    target: id,
  };
}
