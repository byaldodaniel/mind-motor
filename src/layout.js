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
 *     Runtime/node, Runtime/python
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

function bundledPython(root) {
  return process.platform === 'win32'
    ? path.join(root, 'Runtime', 'python', 'python.exe')
    : path.join(root, 'Runtime', 'python', 'bin', 'python3');
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
  const motorDirectory = await fs.realpath(MOTOR_DIRECTORY);
  const candidateRoot = path.dirname(motorDirectory);
  const manifest = path.basename(motorDirectory) === 'Motor' ? await readManifest(candidateRoot) : null;
  const product = manifest !== null;
  const root = product ? candidateRoot : null;

  let baseDirectory = base ?? env.MIND_BASE ?? (product ? path.join(root, 'Base') : null);
  if (baseDirectory === null) {
    throw new MotorError('BASE_REQUIRED', 'En desarrollo indica la Base con --base <ruta-absoluta> o MIND_BASE.');
  }
  if (typeof baseDirectory !== 'string' || !path.isAbsolute(baseDirectory)) {
    throw new MotorError('INVALID_BASE', 'La ruta de la Base debe ser absoluta.');
  }
  baseDirectory = path.normalize(baseDirectory);

  let pythonExecutable = env.MIND_PYTHON ?? null;
  if (pythonExecutable === null && product) {
    const bundled = bundledPython(root);
    if (!(await exists(bundled))) {
      throw new MotorError('RUNTIME_MISSING', 'Falta el intérprete incluido en Runtime/python. Vuelve a extraer el paquete de Mind.');
    }
    pythonExecutable = bundled;
  }
  pythonExecutable ??= process.platform === 'win32' ? 'python' : 'python3';

  return Object.freeze({
    product,
    manifest,
    root,
    motorDirectory,
    baseDirectory,
    pythonExecutable,
    // En el producto ninguna carpeta autorizada puede solaparse con la carpeta
    // de Mind: incluye iniciadores y runtimes que se ejecutan con confianza.
    protectedDirectories: product ? [root] : [],
  });
}
