import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MotorError } from './errors.js';
import { isExcluded } from './paths.js';

const helper = fileURLToPath(new URL('./native_extract.py', import.meta.url));
export const DOCUMENT_FORMATS = Object.freeze(['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp']);
const messages = {
  ACCESS_DENIED: 'El sistema denegó la lectura.',
  FILE_NOT_FOUND: 'El archivo o una carpeta de su ruta ya no existe.',
  UNSAFE_PATH: 'La ruta contiene un enlace, un componente inseguro o un archivo no regular.',
  FILE_TOO_LARGE: 'El documento supera el límite de 16 MiB.',
  READ_FAILED: 'No se pudo leer el documento.',
  SAFE_OPEN_UNAVAILABLE: 'La apertura segura no está disponible en este entorno.',
  UNSUPPORTED_FORMAT: 'Formato no admitido para extraer texto.',
  DOCUMENT_INVALID: 'El documento está dañado o no tiene el formato que indica su extensión.',
  DOCUMENT_ENCRYPTED: 'El documento está cifrado; Mind no lo abre.',
  DOCUMENT_TOO_COMPLEX: 'El documento supera los límites de seguridad (miembros, tamaño descomprimido o compresión).',
  DOCUMENT_UNSAFE: 'El documento contiene declaraciones XML (DTD o entidades) que Mind no procesa.',
};

function relativeName(value) {
  if (typeof value !== 'string' || value.length > 4096 || value.split('/').some(
    (part) => !part || part === '.' || part === '..' || /[\\:\x00-\x1f<>"|?*]/u.test(part)
      || /[. ]$/u.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part),
  )) throw new MotorError('INVALID_READ_PATH', 'Indica un archivo relativo, con / entre componentes y sin alias especiales.');
  return value;
}

/** Formato por extensión; null si no es un documento admitido. */
export function documentFormat(relativePath) {
  const match = /\.([A-Za-z0-9]{3,4})$/u.exec(relativePath ?? '');
  const format = match ? match[1].toLowerCase() : null;
  return DOCUMENT_FORMATS.includes(format) ? format : null;
}

function extractNative({ root, relativePath, format, pythonExecutable, confirm }) {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonExecutable, ['-I', '-B', helper], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let output = '';
    let diagnostic = '';
    let confirmation;
    let failure;
    const fail = (error) => { failure ??= error; child.kill(); };
    const timer = setTimeout(() => fail(new MotorError('READ_FAILED', 'La extracción excedió el tiempo permitido.')), 30_000);
    child.on('error', (cause) => fail(new MotorError('SAFE_OPEN_UNAVAILABLE', messages.SAFE_OPEN_UNAVAILABLE, { cause })));
    child.stdin.on('error', () => {});
    child.stdout.on('data', (chunk) => {
      output += chunk.toString('utf8');
      if (output.length > 8 * 1024 * 1024) fail(new MotorError('READ_FAILED', messages.READ_FAILED));
    });
    child.stderr.on('data', (chunk) => {
      diagnostic = (diagnostic + chunk.toString('utf8')).replace(/\r\n/g, '\n');
      if (diagnostic.length > 256) return fail(new MotorError('READ_FAILED', messages.READ_FAILED));
      if (diagnostic.startsWith('READY\n') && !confirmation) {
        confirmation = Promise.resolve().then(confirm).then(() => child.stdin.end('R')).catch(fail);
      }
    });
    child.on('close', async (code) => {
      clearTimeout(timer);
      await confirmation;
      if (failure) return reject(failure);
      if (code !== 0 || !confirmation) {
        const nativeCode = diagnostic.replace('READY\n', '').trim();
        const errorCode = Object.hasOwn(messages, nativeCode) ? nativeCode : 'READ_FAILED';
        return reject(new MotorError(errorCode, messages[errorCode]));
      }
      try {
        const result = JSON.parse(output);
        if (typeof result.text !== 'string' || result.format !== format) throw new Error('forma');
        resolve(result);
      } catch (cause) {
        reject(new MotorError('READ_FAILED', messages.READ_FAILED, { cause }));
      }
    });
    child.stdin.write(`${JSON.stringify({ root, relativePath, format })}\n`);
  });
}

/**
 * Lectura del texto de documentos de oficina con el mismo modelo de permisos que
 * la lectura de texto: el anfitrión concede un permiso de un solo intento para
 * un archivo exacto; un permiso de lectura de texto no sirve aquí ni al revés.
 */
export function createDocumentReader({ loadAuthorizedFolder, pythonExecutable = process.platform === 'win32' ? 'python' : 'python3' }) {
  const grants = new WeakMap();
  const denied = () => new MotorError('READ_NOT_AUTHORIZED', 'No existe un permiso vigente para este solicitante y esta lectura.');
  const excluded = () => new MotorError('PATH_EXCLUDED', 'El usuario excluyó esa ubicación del acceso de Mind.');
  async function folderFor(id) {
    const folder = await loadAuthorizedFolder(id);
    if (!folder) throw new MotorError('FOLDER_NOT_AUTHORIZED', 'La carpeta ya no está registrada.');
    return folder;
  }
  return {
    async grantDocumentRead({ requester, folderId, relativePath } = {}) {
      if (!requester || typeof requester !== 'object') throw new MotorError('INVALID_REQUESTER', 'El anfitrión debe proporcionar la identidad opaca del solicitante.');
      const name = relativeName(relativePath);
      if (!documentFormat(name)) throw new MotorError('UNSUPPORTED_FORMAT', messages.UNSUPPORTED_FORMAT);
      const folder = await folderFor(folderId);
      if (isExcluded(folder.exclusions, name)) throw excluded();
      const authorization = Object.freeze(Object.create(null));
      grants.set(authorization, { requester, folderId, generation: folder.generation, relativePath: name, used: false });
      return authorization;
    },

    /** @returns {Promise<{ folderId: string, relativePath: string, format: string, text: string, truncated: boolean, bytes: number }>} */
    async readDocument({ requester, authorization } = {}) {
      const grant = grants.get(authorization);
      if (!grant || grant.requester !== requester || grant.used) throw denied();
      grant.used = true;
      const folder = await folderFor(grant.folderId);
      if (folder.generation !== grant.generation) throw denied();
      if (isExcluded(folder.exclusions, grant.relativePath)) throw excluded();
      const result = await extractNative({
        root: folder.path, relativePath: grant.relativePath, format: documentFormat(grant.relativePath), pythonExecutable,
        confirm: async () => {
          const current = await folderFor(grant.folderId);
          if (current.generation !== grant.generation) throw denied();
          if (isExcluded(current.exclusions, grant.relativePath)) throw excluded();
        },
      });
      return { folderId: grant.folderId, relativePath: grant.relativePath, format: result.format, text: result.text, truncated: result.truncated, bytes: result.bytes };
    },
  };
}
