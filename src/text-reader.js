import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MotorError } from './errors.js';
import { isExcluded } from './paths.js';

const helper = fileURLToPath(new URL('./native_reader.py', import.meta.url));
export const MAX_TEXT_BYTES = 1024 * 1024;
const messages = {
  ACCESS_DENIED: 'El sistema denegó la lectura.',
  FILE_NOT_FOUND: 'El archivo o una carpeta de su ruta ya no existe.',
  UNSAFE_PATH: 'La ruta contiene un enlace, un componente inseguro o un archivo no regular.',
  FILE_TOO_LARGE: 'El archivo supera el límite de 1 MiB.',
  READ_FAILED: 'No se pudo leer el archivo completo.',
  SAFE_OPEN_UNAVAILABLE: 'La apertura segura no está disponible en este entorno.',
};

function relativeName(value) {
  // Una sintaxis común evita rutas absolutas, ADS, dispositivos y alias Win32.
  if (typeof value !== 'string' || value.length > 4096 || value.split('/').some(
    (part) => !part || part === '.' || part === '..' || /[\\:\x00-\x1f<>"|?*]/u.test(part)
      || /[. ]$/u.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part),
  )) throw new MotorError('INVALID_READ_PATH', 'Indica un archivo relativo, con / entre componentes y sin alias especiales.');
  return value;
}

/** Protocolo: abre sin leer, avisa READY, espera R y lee por el mismo descriptor. */
export function readNative({ root, relativePath, pythonExecutable, confirm }) {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonExecutable, ['-I', '-B', helper, '--parent-pid', String(process.pid)], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    const chunks = [];
    let size = 0;
    let diagnostic = '';
    let confirmation;
    let failure;
    let closed = false;
    let sent = false;
    const fail = (error) => { failure ??= error; child.kill(); };
    const timer = setTimeout(() => fail(new MotorError('READ_FAILED', 'La lectura excedió el tiempo permitido.')), 10_000);
    child.on('error', (cause) => fail(new MotorError('SAFE_OPEN_UNAVAILABLE', messages.SAFE_OPEN_UNAVAILABLE, { cause })));
    child.stdin.on('error', () => {}); // Un rechazo nativo puede cerrar antes de recibir R.
    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_TEXT_BYTES) fail(new MotorError('FILE_TOO_LARGE', messages.FILE_TOO_LARGE));
      else chunks.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      diagnostic += chunk.toString('utf8');
      diagnostic = diagnostic.replace(/\r\n/g, '\n');
      if (diagnostic.length > 256) return fail(new MotorError('READ_FAILED', messages.READ_FAILED));
      if (diagnostic.startsWith('READY\n') && !confirmation) {
        confirmation = Promise.resolve().then(confirm).then(() => {
          if (failure || closed) return;
          sent = true;
          child.stdin.end('R');
        }).catch(fail);
      }
    });
    child.on('close', (code) => {
      closed = true;
      clearTimeout(timer);
      if (failure) return reject(failure);
      if (code !== 0 || !sent) {
        const nativeCode = diagnostic.replace('READY\n', '').trim();
        const errorCode = Object.hasOwn(messages, nativeCode) ? nativeCode : 'READ_FAILED';
        return reject(new MotorError(errorCode, messages[errorCode]));
      }
      try {
        const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));
        if (content.includes('\0')) throw new Error('NUL');
        resolve(content);
      } catch (cause) {
        reject(new MotorError('TEXT_UNREADABLE', 'El contenido no es texto UTF-8 válido sin NUL.', { cause }));
      }
    });
    child.stdin.write(`${JSON.stringify({ root, relativePath })}\n`);
  });
}

/** Solo el anfitrión de confianza recibe estas operaciones administrativas. */
export function createTextReader({ loadAuthorizedFolder, pythonExecutable = process.platform === 'win32' ? 'python' : 'python3' }) {
  const grants = new WeakMap();
  const denied = () => new MotorError('READ_NOT_AUTHORIZED', 'No existe un permiso vigente para este solicitante y esta lectura.');
  const excluded = () => new MotorError('PATH_EXCLUDED', 'El usuario excluyó esa ubicación del acceso de Mind.');
  async function folderFor(id) {
    const folder = await loadAuthorizedFolder(id);
    if (!folder) throw new MotorError('FOLDER_NOT_AUTHORIZED', 'La carpeta ya no está registrada.');
    return folder;
  }
  return {
    async grantTextRead({ requester, folderId, relativePath } = {}) {
      if (!requester || typeof requester !== 'object') throw new MotorError('INVALID_REQUESTER', 'El anfitrión debe proporcionar la identidad opaca del solicitante.');
      const name = relativeName(relativePath);
      const folder = await folderFor(folderId);
      if (isExcluded(folder.exclusions, name)) throw excluded();
      const authorization = Object.freeze(Object.create(null));
      grants.set(authorization, { requester, folderId, generation: folder.generation, relativePath: name, used: false, revoked: false });
      return authorization;
    },

    revokeTextRead(authorization) {
      const grant = grants.get(authorization);
      if (!grant || grant.used || grant.revoked) return false;
      grant.revoked = true;
      return true;
    },

    async readTextFile({ requester, authorization } = {}) {
      const grant = grants.get(authorization);
      if (!grant || grant.requester !== requester || grant.used || grant.revoked) throw denied();
      grant.used = true; // Un solo intento; se consume antes de cualquier await.
      const folder = await folderFor(grant.folderId);
      if (folder.generation !== grant.generation) throw denied();
      if (isExcluded(folder.exclusions, grant.relativePath)) throw excluded();
      const content = await readNative({
        root: folder.path, relativePath: grant.relativePath, pythonExecutable,
        confirm: async () => {
          const current = await folderFor(grant.folderId);
          if (current.generation !== grant.generation) throw denied();
          if (isExcluded(current.exclusions, grant.relativePath)) throw excluded();
        },
      });
      return { folderId: grant.folderId, relativePath: grant.relativePath, content };
    },
  };
}
