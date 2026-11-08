import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MotorError } from './errors.js';

export const MOTOR_DIRECTORY = fileURLToPath(new URL('..', import.meta.url));
export const PRODUCT_MANIFEST = 'mind-producto.json';

/** Rutas estables; los datos persistentes nunca forman parte del programa sustituible. */
export function productPaths(root, manifest) {
  const modern = (manifest?.layoutVersion ?? 1) >= 2;
  const systemDirectory = modern ? path.join(root, 'Sistema') : root;
  const programDirectory = modern ? path.join(systemDirectory, 'Programa') : root;
  const componentsDirectory = modern ? path.join(systemDirectory, 'Componentes') : path.join(root, 'Runtime');
  const updateDirectory = modern ? path.join(systemDirectory, 'Actualizaciones') : root;
  return {
    systemDirectory, programDirectory, componentsDirectory, updateDirectory, updatesDirectory: updateDirectory,
    motorDirectory: path.join(programDirectory, 'Motor'),
    baseDirectory: path.join(systemDirectory, 'Base'),
    installationStateDirectory: modern ? path.join(systemDirectory, 'Estado') : path.join(root, '.mind-producto'),
    licensesDirectory: path.join(systemDirectory, modern ? 'Licencias' : 'LICENCIAS'),
    launcherDirectory: systemDirectory,
    manifestFile: path.join(systemDirectory, PRODUCT_MANIFEST),
    semanticDirectory: modern ? path.join(componentsDirectory, 'Semantica') : path.join(root, 'Motor', '.cache', 'semantic'),
    userDataDirectory: path.join(root, 'Conversaciones'),
    entrypoint: path.join(programDirectory, 'Motor', 'bin', 'mind.js'),
    agentEntrypoint: modern ? path.join(systemDirectory,'arranque.cjs') : path.join(programDirectory,'Motor','bin','mind.js'),
  };
}
export const productDirectories = productPaths;

async function readManifest(file) {
  let text;
  try { text = await fs.readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  let data;
  try { data = JSON.parse(text); }
  catch (cause) { throw new MotorError('PRODUCT_MANIFEST_INVALID', 'El manifiesto del paquete de Mind no es JSON válido.', { cause }); }
  if (!data || data.format !== 'mind-product' || data.version !== 1 || typeof data.mindVersion !== 'string') {
    throw new MotorError('PRODUCT_MANIFEST_INVALID', 'El manifiesto del paquete de Mind no tiene el formato esperado.');
  }
  if (data.layoutVersion !== undefined && ![1,2].includes(data.layoutVersion)) throw new MotorError('PRODUCT_MANIFEST_INVALID','La estructura de esta copia de Mind no está admitida.');
  return data;
}

/** Los ejecutores conservan rutas por destino y están listos al extraer el ZIP. */
export function productRuntime(root, manifest, platform = process.platform, arch = process.arch) {
  const target = `${platform}-${arch}`;
  const universal = Array.isArray(manifest?.targets);
  if (universal && !manifest.targets.includes(target)) throw new MotorError('PLATFORM_UNSUPPORTED', `Este paquete de Mind no incluye ${target}.`);
  const windows = platform === 'win32';
  if ((manifest?.layoutVersion ?? 1) >= 2) {
    const { componentsDirectory } = productPaths(root, manifest);
    const nodeDirectory = path.join(componentsDirectory, 'Node', target);
    const pythonDirectory = path.join(componentsDirectory, 'Python', target);
    return { directory: componentsDirectory, directories: [nodeDirectory, pythonDirectory], nodeDirectory, pythonDirectory,
      nodeExecutable: path.join(nodeDirectory, windows ? 'node.exe' : 'bin/node'),
      pythonExecutable: path.join(pythonDirectory, windows ? 'python.exe' : 'bin/python3') };
  }
  const directory = universal && !windows ? path.join(root, 'Runtime', target) : path.join(root, 'Runtime');
  return { directory, directories: [directory], nodeDirectory: path.join(directory, 'node'), pythonDirectory: path.join(directory, 'python'),
    nodeExecutable: path.join(directory, 'node', windows ? 'node.exe' : 'bin/node'),
    pythonExecutable: path.join(directory, 'python', windows ? 'python.exe' : 'bin/python3') };
}

/** Identifica tanto el layout histórico como Sistema/Programa/Motor sin crear datos. */
export async function productInstallation() {
  const motorDirectory = await fs.realpath(MOTOR_DIRECTORY);
  if (path.basename(motorDirectory) !== 'Motor') return { motorDirectory, manifest: null, root: null };
  if (path.basename(path.dirname(motorDirectory)) === 'Programa' && path.basename(path.resolve(motorDirectory, '../..')) === 'Sistema') {
    const root = path.resolve(motorDirectory, '../../..');
    const manifest = await readManifest(path.join(root, 'Sistema', PRODUCT_MANIFEST));
    if (manifest && (manifest.layoutVersion ?? 1) >= 2) return { motorDirectory, manifest, root };
  }
  const root = path.dirname(motorDirectory);
  const manifest = await readManifest(path.join(root, PRODUCT_MANIFEST));
  return { motorDirectory, manifest, root: manifest ? root : null };
}

async function exists(target) { try { await fs.access(target); return true; } catch { return false; } }

export async function resolveLayout({ base, env = process.env } = {}) {
  const { motorDirectory, manifest, root } = await productInstallation();
  const product = root !== null;
  const paths = product ? productPaths(root, manifest) : null;
  let defaultBaseDirectory=paths?.baseDirectory;
  // A legacy external Base alias or an explicitly retained Base remains usable.
  if(product&&(manifest.layoutVersion??1)>=2&&!base&&!env.MIND_BASE&&!(await exists(defaultBaseDirectory))&&await exists(path.join(root,'Base'))){
    await fs.rename(path.join(root,'Base'),defaultBaseDirectory).catch(()=>{});
    if(!(await exists(defaultBaseDirectory)))defaultBaseDirectory=path.join(root,'Base');
  }
  let baseDirectory = base ?? env.MIND_BASE ?? defaultBaseDirectory ?? null;
  if (baseDirectory === null) throw new MotorError('BASE_REQUIRED', 'En desarrollo indica la Base con --base <ruta-absoluta> o MIND_BASE.');
  if (typeof baseDirectory !== 'string' || !path.isAbsolute(baseDirectory)) throw new MotorError('INVALID_BASE', 'La ruta de la Base debe ser absoluta.');
  baseDirectory = path.normalize(baseDirectory);
  const runtime = product ? productRuntime(root, manifest) : null;
  let pythonExecutable = env.MIND_PYTHON ?? null;
  if (pythonExecutable === null && runtime) {
    if (!(await exists(runtime.pythonExecutable))) throw new MotorError('RUNTIME_MISSING', 'Falta el intérprete incluido de Python. Vuelve a extraer el paquete de Mind.');
    pythonExecutable = runtime.pythonExecutable;
  }
  pythonExecutable ??= process.platform === 'win32' ? 'python' : 'python3';
  return Object.freeze({ ...paths, product, manifest, root, motorDirectory, baseDirectory, runtime, pythonExecutable,
    protectedDirectories: product ? [root] : [], userDataDirectory: paths?.userDataDirectory ?? null });
}
