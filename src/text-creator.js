import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MotorError } from './errors.js';

const helper = fileURLToPath(new URL('./native_writer.py', import.meta.url));
export const MAX_CREATE_BYTES = 1024 * 1024;
const messages = {
  ACCESS_DENIED: 'El sistema denegó la creación.',
  FILE_EXISTS: 'Ya existe un elemento con ese nombre; no se sobrescribe.',
  PARENT_NOT_FOUND: 'Una carpeta de la ruta no existe.',
  UNSAFE_PATH: 'La ruta contiene un enlace, un componente inseguro o sale del volumen autorizado.',
  NO_SPACE: 'No hay espacio suficiente para crear el archivo.',
  INVALID_TEXT: 'El contenido debe ser texto UTF-8 válido sin NUL.',
  TEXT_TOO_LARGE: 'El contenido supera el límite de 1 MiB.',
  CREATE_FAILED: 'No se pudo crear el archivo.',
  SAFE_OPEN_UNAVAILABLE: 'La creación segura no está disponible en este entorno.',
};

function relativeName(value) {
  // Misma sintaxis que la lectura: sin absolutas, ADS, dispositivos ni alias Win32.
  if (typeof value !== 'string' || value.length > 4096 || value.split('/').some(
    (part) => !part || part === '.' || part === '..' || /[\\:\x00-\x1f<>"|?*]/u.test(part)
      || /[. ]$/u.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part),
  )) throw new MotorError('INVALID_CREATE_PATH', 'Indica un archivo relativo, con / entre componentes y sin alias especiales.');
  return value;
}

function encodeText(content) {
  if (typeof content !== 'string' || !content.isWellFormed() || content.includes('\0')) {
    throw new MotorError('INVALID_TEXT', messages.INVALID_TEXT);
  }
  const bytes = Buffer.from(content, 'utf8');
  if (bytes.length > MAX_CREATE_BYTES) throw new MotorError('TEXT_TOO_LARGE', messages.TEXT_TOO_LARGE);
  return bytes;
}

function iso(milliseconds) {
  if (!Number.isSafeInteger(milliseconds)) return null;
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** Protocolo: adquiere el padre sin crear nada, avisa READY, espera W y crea. */
export function createNative({ root, relativePath, bytes, pythonExecutable, confirm }) {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonExecutable, ['-I', '-B', helper], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    let output = '';
    let diagnostic = '';
    let confirmation;
    let failure;
    const fail = (error) => { failure ??= error; child.kill(); };
    const timer = setTimeout(() => fail(new MotorError('CREATE_FAILED', 'La creación excedió el tiempo permitido.')), 10_000);
    child.on('error', (cause) => fail(new MotorError('SAFE_OPEN_UNAVAILABLE', messages.SAFE_OPEN_UNAVAILABLE, { cause })));
    child.stdin.on('error', () => {}); // Un rechazo nativo puede cerrar antes de recibir W.
    child.stdout.on('data', (chunk) => {
      output += chunk.toString('utf8');
      if (output.length > 4096) fail(new MotorError('CREATE_FAILED', messages.CREATE_FAILED));
    });
    child.stderr.on('data', (chunk) => {
      diagnostic += chunk.toString('utf8');
      diagnostic = diagnostic.replace(/\r\n/g, '\n');
      if (diagnostic.length > 256) return fail(new MotorError('CREATE_FAILED', messages.CREATE_FAILED));
      if (diagnostic.startsWith('READY\n') && !confirmation) {
        confirmation = Promise.resolve().then(confirm).then(() => {
          child.stdin.end('W');
        }).catch(fail);
      }
    });
    child.on('close', async (code) => {
      clearTimeout(timer);
      await confirmation;
      if (failure) return reject(failure);
      if (code !== 0 || !confirmation) {
        const nativeCode = diagnostic.replace('READY\n', '').trim();
        const errorCode = Object.hasOwn(messages, nativeCode) ? nativeCode : 'CREATE_FAILED';
        return reject(new MotorError(errorCode, messages[errorCode]));
      }
      try {
        const result = JSON.parse(output);
        if (!Number.isSafeInteger(result.size) || result.size !== bytes.length) throw new Error('size');
        resolve(result);
      } catch (cause) {
        // El archivo puede existir: el auxiliar terminó bien pero su informe no es válido.
        reject(new MotorError('CREATE_UNCONFIRMED', 'No se pudo confirmar el resultado de la creación.', { cause }));
      }
    });
    child.stdin.write(`${JSON.stringify({ root, relativePath, content: bytes.toString('base64') })}\n`);
  });
}

/**
 * Creación de un archivo de texto nuevo. Solo el anfitrión de confianza recibe
 * grantTextCreate/revokeTextCreate; al agente se le entrega una función ligada a
 * su identidad que llama a createTextFile.
 */
export function createTextCreator({ loadAuthorizedFolder, pythonExecutable = process.platform === 'win32' ? 'python' : 'python3' }) {
  // Distinto del WeakMap de lectura: un permiso de lectura nunca autoriza crear.
  const grants = new WeakMap();
  const denied = () => new MotorError('CREATE_NOT_AUTHORIZED', 'No existe un permiso vigente para este solicitante y esta creación.');
  async function folderFor(id) {
    const folder = await loadAuthorizedFolder(id);
    if (!folder) throw new MotorError('FOLDER_NOT_AUTHORIZED', 'La carpeta ya no está registrada.');
    return folder;
  }
  return {
    async grantTextCreate({ requester, folderId, relativePath } = {}) {
      if (!requester || typeof requester !== 'object') throw new MotorError('INVALID_REQUESTER', 'El anfitrión debe proporcionar la identidad opaca del solicitante.');
      const name = relativeName(relativePath);
      const folder = await folderFor(folderId);
      const authorization = Object.freeze(Object.create(null));
      grants.set(authorization, {
        requester, folderId, generation: folder.generation, relativePath: name, used: false, revoked: false,
      });
      return authorization;
    },

    revokeTextCreate(authorization) {
      const grant = grants.get(authorization);
      if (!grant || grant.used || grant.revoked) return false;
      grant.revoked = true;
      return true;
    },

    /**
     * @returns {Promise<{ folderId: string, relativePath: string, size: number,
     *   indexEntry: import('./index-scan.js').IndexEntry }>}
     */
    async createTextFile({ requester, authorization, content } = {}) {
      const grant = grants.get(authorization);
      if (!grant || grant.requester !== requester || grant.used || grant.revoked) throw denied();
      grant.used = true; // Un solo intento; se consume antes de cualquier await o validación.
      const bytes = encodeText(content);
      const folder = await folderFor(grant.folderId);
      if (folder.generation !== grant.generation) throw denied();
      const result = await createNative({
        root: folder.path, relativePath: grant.relativePath, bytes, pythonExecutable,
        confirm: async () => {
          const current = await folderFor(grant.folderId);
          if (current.generation !== grant.generation) throw denied();
        },
      });
      return {
        folderId: grant.folderId,
        relativePath: grant.relativePath,
        size: result.size,
        // Entrada con la forma del índice para que la integración la incorpore sin recorrer.
        indexEntry: {
          path: grant.relativePath, type: 'file', size: result.size, state: 'indexed', reason: null,
          modifiedAt: iso(result.modifiedMs), changedAt: iso(result.changedMs), createdAt: iso(result.createdMs),
        },
      };
    },
  };
}
