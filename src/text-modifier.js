import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { MotorError } from './errors.js';

const helper = fileURLToPath(new URL('./native_modifier.py', import.meta.url));
export const MAX_MODIFY_BYTES = 1024 * 1024;
const VERSION = /^sha256:([0-9a-f]{64})$/;
const messages = {
  ACCESS_DENIED: 'El sistema denegó la modificación o el archivo es de solo lectura.',
  FILE_NOT_FOUND: 'El archivo o una carpeta de su ruta ya no existe.',
  FILE_IN_USE: 'Otro programa tiene el archivo abierto para escribir.',
  UNSAFE_PATH: 'La ruta contiene un enlace, un componente inseguro o un archivo no regular.',
  FILE_TOO_LARGE: 'El archivo actual supera el límite de 1 MiB.',
  TEXT_UNREADABLE: 'El archivo actual no es texto UTF-8 válido sin NUL.',
  VERSION_CONFLICT: 'El archivo cambió desde la versión indicada; no se modifica.',
  METADATA_NOT_PRESERVABLE: 'El archivo tiene permisos, flujos o atributos que no se pueden conservar con seguridad.',
  INVALID_TEXT: 'El contenido debe ser texto UTF-8 válido sin NUL.',
  TEXT_TOO_LARGE: 'El contenido supera el límite de 1 MiB.',
  NO_SPACE: 'No hay espacio suficiente para preparar la modificación.',
  MODIFY_FAILED: 'No se pudo modificar el archivo.',
  MODIFY_UNCONFIRMED: 'Se publicó el contenido, pero no se pudo confirmar qué archivo sustituyó.',
  SAFE_OPEN_UNAVAILABLE: 'La modificación segura no está disponible en este entorno.',
};

/**
 * Versión de un texto: SHA-256 de sus bytes UTF-8. Coincide con la del archivo
 * cuando content es exactamente lo que devolvió readTextFile (BOM incluido).
 * @param {string} content
 */
export function textVersion(content) {
  if (typeof content !== 'string' || !content.isWellFormed()) {
    throw new MotorError('INVALID_TEXT', messages.INVALID_TEXT);
  }
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
}

function relativeName(value) {
  // Misma sintaxis que la lectura: sin absolutas, ADS, dispositivos ni alias Win32.
  if (typeof value !== 'string' || value.length > 4096 || value.split('/').some(
    (part) => !part || part === '.' || part === '..' || /[\\:\x00-\x1f<>"|?*]/u.test(part)
      || /[. ]$/u.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part),
  )) throw new MotorError('INVALID_MODIFY_PATH', 'Indica un archivo relativo, con / entre componentes y sin alias especiales.');
  return value;
}

function encodeText(content) {
  if (typeof content !== 'string' || !content.isWellFormed() || content.includes('\0')) {
    throw new MotorError('INVALID_TEXT', messages.INVALID_TEXT);
  }
  const bytes = Buffer.from(content, 'utf8');
  if (bytes.length > MAX_MODIFY_BYTES) throw new MotorError('TEXT_TOO_LARGE', messages.TEXT_TOO_LARGE);
  return bytes;
}

function expectedDigest(version) {
  const match = typeof version === 'string' ? VERSION.exec(version) : null;
  if (!match) throw new MotorError('INVALID_VERSION', 'Indica la versión esperada como "sha256:<64 hex>".');
  return match[1];
}

function iso(milliseconds) {
  if (!Number.isSafeInteger(milliseconds)) return null;
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** Protocolo: abre y verifica la versión sin escribir, avisa READY, espera W y publica. */
export function modifyNative({ root, relativePath, expected, bytes, pythonExecutable, confirm }) {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonExecutable, ['-I', '-B', helper], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    let output = '';
    let diagnostic = '';
    let confirmation;
    let failure;
    const fail = (error) => { failure ??= error; child.kill(); };
    const timer = setTimeout(() => fail(new MotorError('MODIFY_FAILED', 'La modificación excedió el tiempo permitido.')), 10_000);
    child.on('error', (cause) => fail(new MotorError('SAFE_OPEN_UNAVAILABLE', messages.SAFE_OPEN_UNAVAILABLE, { cause })));
    child.stdin.on('error', () => {}); // Un rechazo nativo puede cerrar antes de recibir W.
    child.stdout.on('data', (chunk) => {
      output += chunk.toString('utf8');
      if (output.length > 4096) fail(new MotorError('MODIFY_FAILED', messages.MODIFY_FAILED));
    });
    child.stderr.on('data', (chunk) => {
      diagnostic += chunk.toString('utf8');
      diagnostic = diagnostic.replace(/\r\n/g, '\n');
      if (diagnostic.length > 256) return fail(new MotorError('MODIFY_FAILED', messages.MODIFY_FAILED));
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
        const errorCode = Object.hasOwn(messages, nativeCode) ? nativeCode : 'MODIFY_FAILED';
        return reject(new MotorError(errorCode, messages[errorCode]));
      }
      try {
        const result = JSON.parse(output);
        if (!Number.isSafeInteger(result.size) || result.size !== bytes.length) throw new Error('size');
        resolve(result);
      } catch (cause) {
        reject(new MotorError('MODIFY_UNCONFIRMED', messages.MODIFY_UNCONFIRMED, { cause }));
      }
    });
    child.stdin.write(`${JSON.stringify({ root, relativePath, expected, content: bytes.toString('base64') })}\n`);
  });
}

/**
 * Modificación de un archivo de texto existente. Solo el anfitrión de confianza
 * recibe grantTextModify/revokeTextModify; al agente se le entrega una función
 * ligada a su identidad que llama a modifyTextFile.
 */
export function createTextModifier({ loadAuthorizedFolder, pythonExecutable = process.platform === 'win32' ? 'python' : 'python3' }) {
  // Mapa propio: los permisos de lectura o creación nunca autorizan modificar.
  const grants = new WeakMap();
  const denied = () => new MotorError('MODIFY_NOT_AUTHORIZED', 'No existe un permiso vigente para este solicitante y esta modificación.');
  async function folderFor(id) {
    const folder = await loadAuthorizedFolder(id);
    if (!folder) throw new MotorError('FOLDER_NOT_AUTHORIZED', 'La carpeta ya no está registrada.');
    return folder;
  }
  return {
    async grantTextModify({ requester, folderId, relativePath } = {}) {
      if (!requester || typeof requester !== 'object') throw new MotorError('INVALID_REQUESTER', 'El anfitrión debe proporcionar la identidad opaca del solicitante.');
      const name = relativeName(relativePath);
      const folder = await folderFor(folderId);
      const authorization = Object.freeze(Object.create(null));
      grants.set(authorization, {
        requester, folderId, generation: folder.generation, relativePath: name, used: false, revoked: false,
      });
      return authorization;
    },

    revokeTextModify(authorization) {
      const grant = grants.get(authorization);
      if (!grant || grant.used || grant.revoked) return false;
      grant.revoked = true;
      return true;
    },

    /**
     * @param {{ requester: object, authorization: object, expectedVersion: string, content: string }} request
     * @returns {Promise<{ folderId: string, relativePath: string, size: number, previousVersion: string,
     *   version: string, indexEntry: import('./index-scan.js').IndexEntry }>}
     */
    async modifyTextFile({ requester, authorization, expectedVersion, content } = {}) {
      const grant = grants.get(authorization);
      if (!grant || grant.requester !== requester || grant.used || grant.revoked) throw denied();
      grant.used = true; // Un solo intento; se consume antes de cualquier await o validación.
      const expected = expectedDigest(expectedVersion);
      const bytes = encodeText(content);
      const folder = await folderFor(grant.folderId);
      if (folder.generation !== grant.generation) throw denied();
      const result = await modifyNative({
        root: folder.path, relativePath: grant.relativePath, expected, bytes, pythonExecutable,
        confirm: async () => {
          const current = await folderFor(grant.folderId);
          if (current.generation !== grant.generation) throw denied();
        },
      });
      return {
        folderId: grant.folderId,
        relativePath: grant.relativePath,
        size: result.size,
        previousVersion: expectedVersion,
        version: textVersion(content),
        // Entrada con la forma del índice para que la integración la reemplace sin recorrer.
        indexEntry: {
          path: grant.relativePath, type: 'file', size: result.size, state: 'indexed', reason: null,
          modifiedAt: iso(result.modifiedMs), changedAt: iso(result.changedMs), createdAt: iso(result.createdMs),
        },
      };
    },
  };
}
