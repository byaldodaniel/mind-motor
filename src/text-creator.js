import { spawnFileHelper } from './native-file-helper.js';
import { fileURLToPath } from 'node:url';
import { MotorError } from './errors.js';
import { isExcluded } from './paths.js';
import { DEFAULT_TEXT_BYTES, describeBytes, textLimit } from './text-limits.js';

const helper = fileURLToPath(new URL('./native_writer.py', import.meta.url));
/** Límite predeterminado; el anfitrión puede ampliarlo con maxBytes al conceder (hasta 16 MiB). */
export const MAX_CREATE_BYTES = DEFAULT_TEXT_BYTES;
const messages = {
  ACCESS_DENIED: 'El sistema denegó la creación.',
  FILE_EXISTS: 'Ya existe un elemento con ese nombre; no se sobrescribe.',
  PARENT_NOT_FOUND: 'Una carpeta de la ruta no existe.',
  UNSAFE_PATH: 'La ruta contiene un enlace, un componente inseguro o sale del volumen autorizado.',
  NO_SPACE: 'No hay espacio suficiente para crear el archivo.',
  INVALID_TEXT: 'El contenido debe ser texto UTF-8 válido sin NUL.',
  TEXT_TOO_LARGE: 'El contenido supera el límite de 1 MiB.',
  CREATE_FAILED: 'No se pudo crear el archivo.',
  CREATE_UNCONFIRMED: 'No se pudo confirmar el resultado de la creación; revisa la carpeta antes de repetirla.',
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

function tooLarge(limit) {
  return new MotorError('TEXT_TOO_LARGE', limit === DEFAULT_TEXT_BYTES ? messages.TEXT_TOO_LARGE
    : `El contenido supera el límite de ${describeBytes(limit)}.`);
}

function encodeText(content, limit = DEFAULT_TEXT_BYTES) {
  if (typeof content !== 'string' || !content.isWellFormed() || content.includes('\0')) {
    throw new MotorError('INVALID_TEXT', messages.INVALID_TEXT);
  }
  // Sin convertir textos que ya superan el límite: cada unidad UTF-16 ocupa al menos un byte.
  if (content.length > limit) throw tooLarge(limit);
  const bytes = Buffer.from(content, 'utf8');
  if (bytes.length > limit) throw tooLarge(limit);
  return bytes;
}

function iso(milliseconds) {
  if (!Number.isSafeInteger(milliseconds)) return null;
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/**
 * Protocolo: adquiere el padre sin crear nada, avisa READY, espera W y crea.
 * maxBytes solo viaja al auxiliar si difiere del predeterminado; el auxiliar
 * aplica el mínimo con su propio máximo.
 */
export function createNative({ root, relativePath, bytes, pythonExecutable, nativeFilesExecutable, confirm, maxBytes = DEFAULT_TEXT_BYTES }) {
  return new Promise((resolve, reject) => {
    const child = spawnFileHelper({
      pythonExecutable, script: helper, nativeFilesExecutable, operation: 'crear-texto', writes: true,
    });
    let output = '';
    let diagnostic = '';
    let confirmation;
    let failure;
    let closed = false;
    let sent = false;
    const fail = (error) => { failure ??= error; child.kill(); };
    const timer = setTimeout(() => fail(sent
      ? new MotorError('CREATE_UNCONFIRMED', messages.CREATE_UNCONFIRMED)
      : new MotorError('CREATE_FAILED', 'La creación excedió el tiempo permitido.')), 10_000);
    child.on('error', (cause) => fail(new MotorError('SAFE_OPEN_UNAVAILABLE', messages.SAFE_OPEN_UNAVAILABLE, { cause })));
    child.stdin.on('error', () => {}); // Un rechazo nativo puede cerrar antes de recibir W.
    child.stdout.on('data', (chunk) => {
      output += chunk.toString('utf8');
      if (output.length > 4096) fail(new MotorError(sent ? 'CREATE_UNCONFIRMED' : 'CREATE_FAILED',
        sent ? messages.CREATE_UNCONFIRMED : messages.CREATE_FAILED));
    });
    child.stderr.on('data', (chunk) => {
      diagnostic += chunk.toString('utf8');
      diagnostic = diagnostic.replace(/\r\n/g, '\n');
      if (diagnostic.length > 256) return fail(new MotorError(sent ? 'CREATE_UNCONFIRMED' : 'CREATE_FAILED',
        sent ? messages.CREATE_UNCONFIRMED : messages.CREATE_FAILED));
      if (diagnostic.startsWith('READY\n') && !confirmation) {
        confirmation = Promise.resolve().then(confirm).then(() => {
          if (failure || closed) return;
          sent = true;
          child.stdin.end('W');
        }).catch(fail);
      }
    });
    child.on('close', (code) => {
      closed = true;
      clearTimeout(timer);
      if (failure) return reject(failure);
      if (code !== 0 || !sent) {
        const nativeCode = diagnostic.replace('READY\n', '').trim();
        const errorCode = Object.hasOwn(messages, nativeCode) ? nativeCode : sent ? 'CREATE_UNCONFIRMED' : 'CREATE_FAILED';
        return reject(errorCode === 'TEXT_TOO_LARGE' ? tooLarge(maxBytes) : new MotorError(errorCode, messages[errorCode]));
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
    child.stdin.write(`${JSON.stringify({
      root, relativePath, content: bytes.toString('base64'),
      ...(maxBytes !== DEFAULT_TEXT_BYTES ? { maxBytes } : {}),
    })}\n`);
  });
}

/**
 * Creación de un archivo de texto nuevo. Solo el anfitrión de confianza recibe
 * grantTextCreate/revokeTextCreate; al agente se le entrega una función ligada a
 * su identidad que llama a createTextFile.
 */
export function createTextCreator({ loadAuthorizedFolder, pythonExecutable = process.platform === 'win32' ? 'python' : 'python3', nativeFilesExecutable }) {
  // Distinto del WeakMap de lectura: un permiso de lectura nunca autoriza crear.
  const grants = new WeakMap();
  const denied = () => new MotorError('CREATE_NOT_AUTHORIZED', 'No existe un permiso vigente para este solicitante y esta creación.');
  const excluded = () => new MotorError('PATH_EXCLUDED', 'El usuario excluyó esa ubicación del acceso de Mind.');
  async function folderFor(id) {
    const folder = await loadAuthorizedFolder(id);
    if (!folder) throw new MotorError('FOLDER_NOT_AUTHORIZED', 'La carpeta ya no está registrada.');
    return folder;
  }
  return {
    /**
     * Solo anfitrión. maxBytes (opcional, también solo del anfitrión) amplía el
     * límite de 1 MiB de este permiso hasta un máximo absoluto de 16 MiB.
     */
    async grantTextCreate({ requester, folderId, relativePath, maxBytes } = {}) {
      if (!requester || typeof requester !== 'object') throw new MotorError('INVALID_REQUESTER', 'El anfitrión debe proporcionar la identidad opaca del solicitante.');
      const name = relativeName(relativePath);
      const limit = textLimit(maxBytes);
      const folder = await folderFor(folderId);
      if (isExcluded(folder.exclusions, name)) throw excluded();
      const authorization = Object.freeze(Object.create(null));
      grants.set(authorization, {
        requester, folderId, generation: folder.generation, relativePath: name, maxBytes: limit, used: false, revoked: false,
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
      const bytes = encodeText(content, grant.maxBytes);
      const folder = await folderFor(grant.folderId);
      if (folder.generation !== grant.generation) throw denied();
      if (isExcluded(folder.exclusions, grant.relativePath)) throw excluded();
      const result = await createNative({
        root: folder.path, relativePath: grant.relativePath, bytes, pythonExecutable, nativeFilesExecutable, maxBytes: grant.maxBytes,
        confirm: async () => {
          const current = await folderFor(grant.folderId);
          if (current.generation !== grant.generation) throw denied();
          if (isExcluded(current.exclusions, grant.relativePath)) throw excluded();
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
          identity: result.identity ?? null,
        },
      };
    },
  };
}
