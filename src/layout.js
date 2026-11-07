import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MotorError } from './errors.js';

/**
 * Estructura de la carpeta portable de Mind (véase docs/PRODUCTO.md):
 *
 *   Mind/
 *     mind, mind.cmd          iniciadores
 *     mind-producto.json      manifiesto del paquete (marca el modo producto)
 *     Motor/                  este código; se sustituye al actualizar
 *     Runtime/                 ejecutores nativos incluidos
 *     Base/                   datos persistentes; se crea en el primer uso y nunca
 *                             forma parte del paquete
 *
 * En desarrollo (sin manifiesto) no hay Base predeterminada: se indica con
 * --base o MIND_BASE, igual que en la CLI del núcleo.
 */

export const MOTOR_DIRECTORY = fileURLToPath(new URL('..', import.meta.url));
export const PRODUCT_MANIFEST = 'mind-producto.json';

async function readManifest(root) {
  let text;
  try {
    text = await fs.readFile(path.join(root, PRODUCT_MANIFEST), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (cause) {
    throw new MotorError('PRODUCT_MANIFEST_INVALID', 'El manifiesto del paquete de Mind no es JSON válido.', { cause });
  }
  if (!data || typeof data !== 'object' || data.format !== 'mind-product' || data.version !== 1
      || typeof data.mindVersion !== 'string') {
    throw new MotorError('PRODUCT_MANIFEST_INVALID', 'El manifiesto del paquete de Mind no tiene el formato esperado.');
  }
  return data;
}

/** Ubicaciones de los ejecutores del producto para el destino que lo inicia. */
export function productRuntime(root, manifest, platform = process.platform, arch = process.arch) {
  const target = `${platform}-${arch}`;
  const universal = Array.isArray(manifest?.targets);
  if (universal && !manifest.targets.includes(target)) {
    throw new MotorError('PLATFORM_UNSUPPORTED', `Este paquete de Mind no incluye ${target}.`);
  }
  const directory = universal && platform !== 'win32' ? path.join(root, 'Runtime', target) : path.join(root, 'Runtime');
  const windows = platform === 'win32';
  return {
    directory,
    nodeExecutable: path.join(directory, 'node', windows ? 'node.exe' : 'bin/node'),
    pythonExecutable: path.join(directory, 'python', windows ? 'python.exe' : 'bin/python3'),
  };
}

/** Identifica el producto sin crear su Base ni abrir una sesión. */
export async function productInstallation() {
  const motorDirectory = await fs.realpath(MOTOR_DIRECTORY);
  const candidateRoot = path.dirname(motorDirectory);
  const manifest = path.basename(motorDirectory) === 'Motor' ? await readManifest(candidateRoot) : null;
  return { motorDirectory, manifest, root: manifest ? candidateRoot : null };
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resuelve las rutas de la instalación. Las rutas de entorno solo eligen
 * ubicaciones; no conceden permisos sobre carpetas del usuario.
 * @param {{ base?: string, env?: NodeJS.ProcessEnv }} [options]
 */
export async function resolveLayout({ base, env = process.env } = {}) {
  const { motorDirectory, manifest, root } = await productInstallation();
  const product = root !== null;

  let baseDirectory = base ?? env.MIND_BASE ?? (product ? path.join(root, 'Base') : null);
  if (baseDirectory === null) {
    throw new MotorError('BASE_REQUIRED', 'En desarrollo indica la Base con --base <ruta-absoluta> o MIND_BASE.');
  }
  if (typeof baseDirectory !== 'string' || !path.isAbsolute(baseDirectory)) {
    throw new MotorError('INVALID_BASE', 'La ruta de la Base debe ser absoluta.');
  }
  baseDirectory = path.normalize(baseDirectory);

  const runtime = product ? productRuntime(root, manifest) : null;
  let pythonExecutable = env.MIND_PYTHON ?? null;
  if (pythonExecutable === null && runtime) {
    if (!(await exists(runtime.pythonExecutable))) {
      throw new MotorError('RUNTIME_MISSING', 'Falta el intérprete incluido de Python. Vuelve a extraer el paquete de Mind.');
    }
    pythonExecutable = runtime.pythonExecutable;
  }
  pythonExecutable ??= process.platform === 'win32' ? 'python' : 'python3';

  return Object.freeze({
    product,
    manifest,
    root,
    motorDirectory,
    baseDirectory,
    runtime,
    pythonExecutable,
    // En el producto ninguna carpeta autorizada puede solaparse con la carpeta
    // de Mind: incluye iniciadores y runtimes que se ejecutan con confianza.
    protectedDirectories: product ? [root] : [],
    userDataDirectory: product ? path.join(root,'Conversaciones') : null,
  });
}
