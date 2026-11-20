import { spawnFileHelper } from './native-file-helper.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MotorError } from './errors.js';
import { isExcluded, containsExcluded, TRASH_DIRECTORY } from './paths.js';
import { newTrashId, validateTrashId } from './trash.js';
import { untrustedText } from './consent.js';

/**
 * Organización de carpetas autorizadas (docs/FUNCION_03_ORGANIZAR.md): crear
 * carpetas, mover o renombrar y la papelera de Mind (borrar, restaurar y
 * vaciar). Mismo modelo que la lectura y la creación: solo el anfitrión de
 * confianza concede; cada permiso es de un solo intento, vive en el WeakMap de
 * su operación, se liga a la identidad opaca del solicitante y a la generación
 * de la carpeta, y se consume antes de cualquier await. El registro se vuelve a
 * consultar con los handles ya adquiridos, justo antes de modificar nada.
 */

const helper = fileURLToPath(new URL('./native_organizer.py', import.meta.url));
const FOLD_CASE = process.platform === 'win32' || process.platform === 'darwin';
const MAX_TRASH_ENTRIES = 10_000;
const MAX_RESTORE_NAMES = 20;

const messages = {
  ACCESS_DENIED: 'El sistema denegó la operación.',
  FILE_EXISTS: 'Ya existe un elemento con ese nombre; no se reemplaza.',
  PARENT_NOT_FOUND: 'La carpeta de destino no existe.',
  FILE_NOT_FOUND: 'El elemento o una carpeta de su ruta ya no existe.',
  UNSAFE_PATH: 'La ruta contiene un enlace, un punto de reanálisis, un objeto especial o un archivo con varios enlaces, o sale del volumen autorizado.',
  INVALID_MOVE: 'No se puede mover una carpeta dentro de sí misma ni sobre su propia ruta.',
  FILE_IN_USE: 'Otro programa u otra operación de Mind está usando ese elemento.',
  NO_SPACE: 'No hay espacio suficiente.',
  ENTRY_CHANGED: 'El elemento cambió desde que se comprobó; no se ha tocado. Vuelve a consultarlo.',
  CROSS_DEVICE: 'Las dos carpetas están en volúmenes distintos: mover sería copiar. Crea el archivo en el destino y borra el original.',
  TRASH_ENTRY_MISSING: 'La entrada ya no está en la papelera de Mind.',
  SAFE_OPEN_UNAVAILABLE: 'La operación segura no está disponible en este entorno o sistema de archivos.',
};

const OPERATIONS = {
  mkdir: { failed: 'CREATE_FOLDER_FAILED', unconfirmed: 'CREATE_FOLDER_UNCONFIRMED', timeoutMs: 10_000, what: 'crear la carpeta' },
  move: { failed: 'MOVE_FAILED', unconfirmed: 'MOVE_UNCONFIRMED', timeoutMs: 10_000, what: 'mover' },
  trash: { failed: 'DELETE_FAILED', unconfirmed: 'DELETE_UNCONFIRMED', timeoutMs: 30_000, what: 'mover a la papelera' },
  restore: { failed: 'RESTORE_FAILED', unconfirmed: 'RESTORE_UNCONFIRMED', timeoutMs: 10_000, what: 'restaurar' },
  purge: { failed: 'PURGE_FAILED', unconfirmed: 'PURGE_UNCONFIRMED', timeoutMs: 120_000, what: 'vaciar' },
};

const fold = (value) => (FOLD_CASE ? value.toLowerCase() : value);

/** Una ruta física contiene a la otra (o son la misma), comparando como el sistema. */
function overlapping(a, b) {
  const left = fold(path.resolve(a));
  const right = fold(path.resolve(b));
  return left === right || left.startsWith(`${right}${path.sep}`) || right.startsWith(`${left}${path.sep}`);
}

function relativeName(value) {
  // Misma sintaxis que lectura y creación: sin absolutas, ADS, dispositivos ni alias Win32.
  if (typeof value !== 'string' || value.length > 4096 || value.split('/').some(
    (part) => !part || part === '.' || part === '..' || /[\\:\x00-\x1f<>"|?*]/u.test(part)
      || /[. ]$/u.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part),
  )) throw new MotorError('INVALID_ORGANIZE_PATH', 'Indica una ruta relativa, con / entre componentes y sin alias especiales.');
  return value;
}

function iso(milliseconds) {
  if (!Number.isSafeInteger(milliseconds)) return null;
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function nativeError(operation, code) {
  const settings = OPERATIONS[operation];
  if (code === 'UNCONFIRMED') {
    return new MotorError(settings.unconfirmed, `No se pudo confirmar el resultado al ${settings.what}; revisa la carpeta antes de repetirlo.`);
  }
  if (code === 'TRASH_MISSING') return new MotorError('TRASH_ENTRY_MISSING', messages.TRASH_ENTRY_MISSING);
  if (code === 'NOT_EMPTY') return new MotorError(settings.failed, 'Quedó contenido que no se pudo eliminar.');
  if (Object.hasOwn(messages, code)) return new MotorError(code, messages[code]);
  return new MotorError(settings.failed, `No se pudo ${settings.what}.`);
}

/**
 * Protocolo del auxiliar: valida y adquiere sin modificar, avisa READY, espera W
 * (tras revalidar la autorización en confirm) y modifica.
 */
export function runOrganizer({ operation, request, pythonExecutable, nativeFilesExecutable, confirm }) {
  const settings = OPERATIONS[operation];
  return new Promise((resolve, reject) => {
    const child = spawnFileHelper({
      pythonExecutable, script: helper, nativeFilesExecutable, operation: 'organizar-archivo', writes: true,
    });
    let output = '';
    let diagnostic = '';
    let confirmation;
    let failure;
    let sent = false;
    let closed = false;
    const fail = (error) => { failure ??= error; child.kill(); };
    // Tras enviar W el cambio pudo ocurrir: un tiempo agotado ya no es un fallo limpio.
    const timer = setTimeout(() => fail(sent ? nativeError(operation, 'UNCONFIRMED')
      : new MotorError(settings.failed, `La operación excedió el tiempo permitido al ${settings.what}.`)), settings.timeoutMs);
    child.on('error', (cause) => fail(new MotorError('SAFE_OPEN_UNAVAILABLE', messages.SAFE_OPEN_UNAVAILABLE, { cause })));
    child.stdin.on('error', () => {}); // Un rechazo nativo puede cerrar antes de recibir W.
    child.stdout.on('data', (chunk) => {
      output += chunk.toString('utf8');
      if (output.length > 65536) fail(nativeError(operation, 'UNCONFIRMED'));
    });
    child.stderr.on('data', (chunk) => {
      diagnostic += chunk.toString('utf8');
      diagnostic = diagnostic.replace(/\r\n/g, '\n');
      if (diagnostic.length > 256) return fail(nativeError(operation, sent ? 'UNCONFIRMED' : 'FAILED'));
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
      if (code !== 0 || !sent) return reject(nativeError(operation,
        diagnostic.replace('READY\n', '').trim() || (sent ? 'UNCONFIRMED' : 'FAILED')));
      try {
        resolve(JSON.parse(output));
      } catch (cause) {
        reject(Object.assign(nativeError(operation, 'UNCONFIRMED'), { cause }));
      }
    });
    child.stdin.write(`${JSON.stringify(request)}\n`);
  });
}

/** Tabla de permisos de una operación: mapas distintos, nunca intercambiables. */
function grantTable(code, message) {
  const grants = new WeakMap();
  const denied = () => new MotorError(code, message);
  return {
    denied,
    issue(record) {
      const authorization = Object.freeze(Object.create(null));
      grants.set(authorization, { ...record, used: false, revoked: false });
      return authorization;
    },
    revoke(authorization) {
      const grant = grants.get(authorization);
      if (!grant || grant.used || grant.revoked) return false;
      grant.revoked = true;
      return true;
    },
    consume(authorization, requester) {
      const grant = grants.get(authorization);
      if (!grant || grant.requester !== requester || grant.used || grant.revoked) throw denied();
      grant.used = true; // Un solo intento; se consume antes de cualquier await.
      return grant;
    },
  };
}

function requireRequester(requester) {
  if (!requester || typeof requester !== 'object') {
    throw new MotorError('INVALID_REQUESTER', 'El anfitrión debe proporcionar la identidad opaca del solicitante.');
  }
}

/** Entrada con la forma de index-scan.js a partir de los metadatos del handle. */
function indexEntry(relativePath, result, operation) {
  if (!result || !['file', 'directory'].includes(result.type)
      || (result.type === 'file' && (!Number.isSafeInteger(result.size) || result.size < 0))) {
    throw nativeError(operation, 'UNCONFIRMED');
  }
  return {
    path: relativePath, type: result.type, size: result.type === 'file' ? result.size : null,
    state: 'indexed', reason: null,
    modifiedAt: iso(result.modifiedMs), changedAt: iso(result.changedMs), createdAt: iso(result.createdMs),
  };
}

function expectedEntry(expected) {
  if (expected === null || expected === undefined) return null;
  if (typeof expected !== 'object' || !['file', 'directory'].includes(expected.type)
      || !(expected.size === null || expected.size === undefined || (Number.isSafeInteger(expected.size) && expected.size >= 0))
      || !(expected.modifiedAt === null || expected.modifiedAt === undefined || Number.isFinite(Date.parse(expected.modifiedAt)))
      || !(expected.entries === null || expected.entries === undefined || (Number.isSafeInteger(expected.entries) && expected.entries >= 0))) {
    throw new MotorError('INVALID_EXPECTED_ENTRY', 'Lo esperado debe indicar tipo, tamaño, fecha de modificación y entradas válidos.');
  }
  return Object.freeze({
    type: expected.type, size: expected.size ?? null, modifiedAt: expected.modifiedAt ?? null, entries: expected.entries ?? null,
  });
}

/** Nombres para restaurar: el original y "<nombre> (restaurado <fecha>)" antes de la extensión. */
export function restoreNames(name, type, now = new Date()) {
  const date = now.toISOString().slice(0, 10);
  const dot = type === 'file' ? name.lastIndexOf('.') : -1;
  const [stem, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  const names = [name];
  for (let copy = 1; names.length < MAX_RESTORE_NAMES; copy += 1) {
    names.push(`${stem} (restaurado ${date}${copy > 1 ? ` ${copy}` : ''})${extension}`);
  }
  return names;
}

/**
 * @param {{ loadAuthorizedFolder: Function, pythonExecutable?: string, trash?: ReturnType<typeof import('./trash.js').createTrashRegistry> }} options
 * trash: registro de la papelera en la Base; sin él no hay borrado, restauración ni vaciado.
 */
export function createOrganizer({ loadAuthorizedFolder, pythonExecutable = process.platform === 'win32' ? 'python' : 'python3', trash = null, nativeFilesExecutable }) {
  const folders = grantTable('CREATE_FOLDER_NOT_AUTHORIZED', 'No existe un permiso vigente para este solicitante y esta carpeta nueva.');
  const moves = grantTable('MOVE_NOT_AUTHORIZED', 'No existe un permiso vigente para este solicitante y este movimiento.');
  const deletions = grantTable('DELETE_NOT_AUTHORIZED', 'No existe un permiso vigente para este solicitante y este borrado.');
  const restores = grantTable('RESTORE_NOT_AUTHORIZED', 'No existe un permiso vigente para este solicitante y esta restauración.');
  const purges = grantTable('PURGE_NOT_AUTHORIZED', 'No existe un permiso vigente para este solicitante y este vaciado.');
  const excluded = () => new MotorError('PATH_EXCLUDED', 'El usuario excluyó esa ubicación del acceso de Mind.');

  async function folderFor(id) {
    const folder = await loadAuthorizedFolder(id);
    if (!folder) throw new MotorError('FOLDER_NOT_AUTHORIZED', 'La carpeta ya no está registrada.');
    return folder;
  }

  function requireTrash() {
    if (!trash) throw new MotorError('TRASH_UNAVAILABLE', 'La papelera de Mind no está disponible en este organizador.');
    return trash;
  }

  /**
   * Las rutas tocadas no pueden estar excluidas (ni ser la papelera), y lo que
   * se mueve no puede contener una exclusión: moverlo la tocaría y la dejaría
   * fuera de su ruta excluida.
   */
  function guard(folder, touched, containers) {
    if (touched.some((item) => isExcluded(folder.exclusions, item))
        || containers.some((item) => containsExcluded(folder.exclusions, item))) throw excluded();
  }

  /** Revalidación con la carpeta vigente: misma generación y mismas comprobaciones. */
  function revalidator(table, grant, touched, containers) {
    return async () => {
      const current = await folderFor(grant.folderId);
      if (current.generation !== grant.generation) throw table.denied();
      guard(current, touched, containers);
      return current;
    };
  }

  return {
    async grantCreateFolder({ requester, folderId, relativePath } = {}) {
      requireRequester(requester);
      const name = relativeName(relativePath);
      const folder = await folderFor(folderId);
      guard(folder, [name], []);
      return folders.issue({ requester, folderId, generation: folder.generation, relativePath: name });
    },

    revokeCreateFolder: (authorization) => folders.revoke(authorization),

    /** @returns {Promise<{ folderId: string, relativePath: string, indexEntry: object }>} */
    async createFolder({ requester, authorization } = {}) {
      const grant = folders.consume(authorization, requester);
      const revalidate = revalidator(folders, grant, [grant.relativePath], []);
      const folder = await revalidate();
      const result = await runOrganizer({
        operation: 'mkdir', pythonExecutable, nativeFilesExecutable, confirm: revalidate,
        request: { op: 'mkdir', root: folder.path, relativePath: grant.relativePath },
      });
      return { folderId: grant.folderId, relativePath: grant.relativePath, indexEntry: indexEntry(grant.relativePath, result, 'mkdir') };
    },

    /**
     * Mover o renombrar dentro de una carpeta o, con targetFolderId, a otra carpeta
     * autorizada del mismo volumen. Ninguna de las dos puede contener a la otra.
     */
    async grantMove({ requester, folderId, from, to, targetFolderId = null } = {}) {
      requireRequester(requester);
      const source = relativeName(from);
      const target = relativeName(to);
      const crossing = targetFolderId !== null && targetFolderId !== undefined && targetFolderId !== folderId;
      if (!crossing && (source === target || fold(target).startsWith(`${fold(source)}/`))) {
        throw new MotorError('INVALID_MOVE', messages.INVALID_MOVE);
      }
      const folder = await folderFor(folderId);
      if (!crossing) {
        guard(folder, [source, target], [source, target]);
        return moves.issue({ requester, folderId, generation: folder.generation, from: source, to: target, target: null });
      }
      const destination = await folderFor(targetFolderId);
      if (overlapping(folder.path, destination.path)) {
        throw new MotorError('INVALID_MOVE', 'Una de las carpetas contiene a la otra: mueve dentro de la carpeta que las contiene.');
      }
      guard(folder, [source], [source]);
      guard(destination, [target], [target]);
      return moves.issue({
        requester, folderId, generation: folder.generation, from: source, to: target,
        target: { folderId: targetFolderId, generation: destination.generation },
      });
    },

    revokeMove: (authorization) => moves.revoke(authorization),

    /** @returns {Promise<{ folderId: string, targetFolderId: string, from: string, to: string, type: 'file' | 'directory', indexEntry: object }>} */
    async moveEntry({ requester, authorization } = {}) {
      const grant = moves.consume(authorization, requester);
      let revalidate;
      if (!grant.target) {
        revalidate = revalidator(moves, grant, [grant.from, grant.to], [grant.from, grant.to]);
      } else {
        const origin = revalidator(moves, grant, [grant.from], [grant.from]);
        const arrival = revalidator(moves, { folderId: grant.target.folderId, generation: grant.target.generation }, [grant.to], [grant.to]);
        revalidate = async () => {
          const current = await origin();
          const other = await arrival();
          if (overlapping(current.path, other.path)) throw moves.denied();
          return { ...current, targetPath: other.path };
        };
      }
      const folder = await revalidate();
      const result = await runOrganizer({
        operation: 'move', pythonExecutable, nativeFilesExecutable, confirm: revalidate,
        request: { op: 'move', root: folder.path, from: grant.from, to: grant.to, targetRoot: folder.targetPath ?? null },
      });
      const entry = indexEntry(grant.to, result, 'move');
      return {
        folderId: grant.folderId, targetFolderId: grant.target?.folderId ?? grant.folderId,
        from: grant.from, to: grant.to, type: entry.type, indexEntry: entry,
      };
    },

    /**
     * Solo anfitrión, después de la confirmación del usuario. expected fija lo que
     * el usuario vio (tipo y, para archivos, tamaño y fecha de modificación): si
     * cambió, el borrado se rechaza con ENTRY_CHANGED sin tocar nada. by y reason
     * los fija el anfitrión para el registro de la papelera.
     */
    async grantDelete({ requester, folderId, relativePath, expected = null, by = null, reason = null, properties = null } = {}) {
      requireRequester(requester);
      requireTrash();
      const name = relativeName(relativePath);
      const folder = await folderFor(folderId);
      guard(folder, [name], [name]);
      return deletions.issue({
        requester, folderId, generation: folder.generation, relativePath: name, expected: expectedEntry(expected),
        by: untrustedText(by ?? 'anfitrión', 200) || 'anfitrión', reason: untrustedText(reason ?? '', 300) || null,
        properties: Array.isArray(properties) && properties.length > 0 ? properties : null,
      });
    },

    revokeDelete: (authorization) => deletions.revoke(authorization),

    /** Mueve a <raíz>/.papelera-mind/<id>/<nombre> y lo anota en la papelera de la Base. */
    async deleteEntry({ requester, authorization } = {}) {
      const grant = deletions.consume(authorization, requester);
      const registry = requireTrash();
      const revalidate = revalidator(deletions, grant, [grant.relativePath], [grant.relativePath]);
      const folder = await revalidate();
      if ((await registry.list(grant.folderId)).length >= MAX_TRASH_ENTRIES) {
        throw new MotorError('TRASH_LIMIT_EXCEEDED', `La papelera de esta carpeta ya tiene ${MAX_TRASH_ENTRIES} entradas: vacíala antes de borrar más.`);
      }
      const trashId = newTrashId();
      const expected = grant.expected;
      const result = await runOrganizer({
        operation: 'trash', pythonExecutable, nativeFilesExecutable, confirm: revalidate,
        request: {
          op: 'trash', root: folder.path, relativePath: grant.relativePath, trashId,
          expect: expected && {
            type: expected.type,
            ...(expected.type === 'file' ? {
              size: expected.size, modifiedMs: expected.modifiedAt === null ? null : Date.parse(expected.modifiedAt),
            } : {}),
          },
        },
      });
      const entry = indexEntry(grant.relativePath, result, 'trash');
      const sha256 = typeof result.sha256 === 'string' && /^[a-f0-9]{64}$/.test(result.sha256) ? result.sha256 : null;
      const record = {
        id: trashId, path: grant.relativePath, type: entry.type, size: entry.size,
        modifiedAt: entry.modifiedAt, changedAt: entry.changedAt, createdAt: entry.createdAt,
        deletedAt: new Date().toISOString(), by: grant.by, sha256,
        entries: entry.type === 'directory' ? expected?.entries ?? null : null, reason: grant.reason,
        ...(grant.properties ? { properties: grant.properties } : {}),
      };
      let recorded = { status: 'recorded', code: null };
      try {
        // Ligado a la generación del permiso: una autorización posterior no recibe la anotación.
        await registry.add(grant.folderId, grant.generation, record);
      } catch (error) {
        // Ya está en la papelera física: el fallo del registro no anula el movimiento.
        recorded = { status: 'unrecorded', code: error?.code ?? 'TRASH_RECORD_FAILED' };
      }
      const name = grant.relativePath.slice(grant.relativePath.lastIndexOf('/') + 1);
      return {
        folderId: grant.folderId, relativePath: grant.relativePath, type: entry.type,
        trashId, trashPath: `${TRASH_DIRECTORY}/${trashId}/${name}`, entry: record, trash: recorded,
      };
    },

    async grantRestore({ requester, folderId, trashId } = {}) {
      requireRequester(requester);
      validateTrashId(trashId);
      const entry = await requireTrash().get(folderId, trashId);
      return restores.issue({
        requester, folderId, generation: entry.generation, trashId, relativePath: entry.path, type: entry.type,
      });
    },

    revokeRestore: (authorization) => restores.revoke(authorization),

    /** Devuelve la entrada a su ruta o, si está ocupada, a "<nombre> (restaurado <fecha>)"; nunca reemplaza. */
    async restoreEntry({ requester, authorization } = {}) {
      const grant = restores.consume(authorization, requester);
      const registry = requireTrash();
      const parts = grant.relativePath.split('/');
      const name = parts.pop();
      const prefix = parts.length > 0 ? `${parts.join('/')}/` : '';
      const all = restoreNames(name, grant.type);
      const check = revalidator(restores, grant, [], []);
      const allowed = (folder) => all.filter((candidate) => !isExcluded(folder.exclusions, `${prefix}${candidate}`)
        && !containsExcluded(folder.exclusions, `${prefix}${candidate}`));
      const revalidate = async () => {
        const current = await check();
        if (allowed(current).length === 0) throw excluded();
        return current;
      };
      const folder = await revalidate();
      let result;
      try {
        result = await runOrganizer({
          operation: 'restore', pythonExecutable, nativeFilesExecutable, confirm: revalidate,
          request: {
            op: 'restore', root: folder.path, trashId: grant.trashId, name,
            targetParent: parts, candidates: allowed(folder),
          },
        });
      } catch (error) {
        // Ya no existe físicamente: la anotación no describe nada recuperable.
        if (error.code === 'TRASH_ENTRY_MISSING') await registry.remove(grant.folderId, grant.generation, grant.trashId).catch(() => {});
        throw error;
      }
      if (typeof result?.name !== 'string' || !all.includes(result.name)) throw nativeError('restore', 'UNCONFIRMED');
      const relativePath = `${prefix}${result.name}`;
      const entry = indexEntry(relativePath, result, 'restore');
      let recorded = { status: 'removed', code: null };
      try {
        await registry.remove(grant.folderId, grant.generation, grant.trashId);
      } catch (error) {
        recorded = { status: 'stale', code: error?.code ?? 'TRASH_RECORD_FAILED' };
      }
      return {
        folderId: grant.folderId, trashId: grant.trashId, originalPath: grant.relativePath, relativePath,
        renamed: relativePath !== grant.relativePath, type: entry.type, indexEntry: entry, trash: recorded,
      };
    },

    async grantPurge({ requester, folderId, trashId } = {}) {
      requireRequester(requester);
      validateTrashId(trashId);
      const entry = await requireTrash().get(folderId, trashId);
      return purges.issue({ requester, folderId, generation: entry.generation, trashId, entry });
    },

    revokePurge: (authorization) => purges.revoke(authorization),

    /** Borrado definitivo de una entrada de la papelera, por handles y sin seguir enlaces. */
    async purgeEntry({ requester, authorization } = {}) {
      const grant = purges.consume(authorization, requester);
      const registry = requireTrash();
      const revalidate = revalidator(purges, grant, [], []);
      const folder = await revalidate();
      let removed;
      let gone = false;
      try {
        ({ removed } = await runOrganizer({
          operation: 'purge', pythonExecutable, nativeFilesExecutable, confirm: revalidate,
          request: { op: 'purge', root: folder.path, trashId: grant.trashId },
        }));
      } catch (error) {
        if (error.code !== 'TRASH_ENTRY_MISSING') throw error;
        // Ya no existe: el resultado pedido (que no quede nada) ya se cumple.
        gone = true;
        removed = 0;
      }
      if (!Number.isSafeInteger(removed) || removed < 0) throw nativeError('purge', 'UNCONFIRMED');
      let recorded = { status: 'removed', code: null };
      try {
        await registry.remove(grant.folderId, grant.generation, grant.trashId);
      } catch (error) {
        recorded = { status: 'stale', code: error?.code ?? 'TRASH_RECORD_FAILED' };
      }
      return { folderId: grant.folderId, trashId: grant.trashId, removed, alreadyGone: gone, entry: { ...grant.entry }, trash: recorded };
    },
  };
}
