import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MotorError } from './errors.js';
import { readJson, writeJson } from './storage.js';
import { contains } from './paths.js';
import { createContinuity } from './continuity.js';
import { createWorkDestinations } from './work-destinations.js';
import { createResultRegistry } from './result-registry.js';
import { createResultCopier } from './result-copier.js';
import { createConversations } from './conversations.js';
import { createConversationRelocation } from './conversation-relocation.js';
import { createContinuityAccess } from './continuity-access.js';
import { createFolderRegistry } from './folders.js';
import { createTextReader } from './text-reader.js';
import { createDocumentReader } from './document-reader.js';
import { createFunctionRegistry } from './functions.js';
import { createFunctionRunner } from './function-runner.js';
import { createTextCreator } from './text-creator.js';
import { createTextModifier } from './text-modifier.js';
import { createFolderIndexer } from './indexer.js';
import { createIndexSearch } from './search.js';
import { groupMarksInCatalog } from './marks-extractor.js';
import { createIndexObserver } from './index-observer.js';
import { createPropertyStore } from './properties.js';
import { createOrganizer } from './organizer.js';
import { createTrashRegistry } from './trash.js';
import { readBaseMarker } from './base-format.js';

export { MotorError } from './errors.js';
export { textVersion } from './text-modifier.js';
export { parseContinuityExport, formatContinuityMarkdown } from './continuity.js';

const MOTOR_DIRECTORY = fileURLToPath(new URL('..', import.meta.url));
const VALID_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** @typedef {{ id: string, value: string }} TechnicalRecord */
/**
 * @typedef {{ baseDirectory: string, pythonExecutable?: string, nativeTextReaderExecutable?: string, functionExecutors?: object, protectedDirectories?: string[] }} MotorOptions
 * protectedDirectories: ubicaciones que ninguna carpeta autorizada puede contener ni ocupar.
 * functionExecutors: catálogo explícito de ejecutores de confianza del anfitrión
 * (véase docs/EJECUCION_FUNCIONES.md). Sin él no se puede vincular ninguna función.
 */
/**
 * @typedef {object} Motor
 * @property {string} baseDirectory Ruta física de la Base externa existente.
 * @property {(id: string, value: string) => Promise<TechnicalRecord>} writeRecord
 * @property {(id: string) => Promise<TechnicalRecord | null>} readRecord
 * @property {(folderPath: string) => Promise<import('./folders.js').AuthorizedFolder>} authorizeFolder
 * @property {() => Promise<import('./folders.js').AuthorizedFolder[]>} listAuthorizedFolders
 * @property {(id: string) => Promise<boolean>} revokeFolder
 * @property {(id: string) => Promise<{id: string, path: string, generation: string | null} | null>} getAuthorizedFolder Solo anfitrión.
 * @property {(id: string, targetPath: string) => Promise<{folderId: string, path: string}>} checkFolderScope
 * @property {(request: {requester: object, folderId: string, relativePath: string}) => Promise<object>} grantTextRead Solo anfitrión administrativo.
 * @property {(authorization: object) => boolean} revokeTextRead Solo antes del intento.
 * @property {(request: {requester: object, authorization: object}) => Promise<{folderId: string, relativePath: string, content: string}>} readTextFile
 * @property {(id: string, definition: object) => Promise<{id: string, definition: object}>} createFunction Solo anfitrión administrativo.
 * @property {(id: string) => Promise<{id: string, definition: object} | null>} getFunction Solo anfitrión administrativo.
 * @property {() => Promise<{id: string, definition: object}[]>} listFunctions Solo anfitrión administrativo.
 * @property {(id: string, definition: object) => Promise<{id: string, definition: object}>} updateFunction Solo anfitrión administrativo.
 * @property {(id: string) => Promise<boolean>} retireFunction Solo anfitrión administrativo.
 * @property {(request: {functionId: string, executor: string}) => Promise<object>} bindFunction Solo anfitrión: autoriza la definición actual con un ejecutor del catálogo.
 * @property {(binding: object) => boolean} unbindFunction Solo anfitrión.
 * @property {(request: {binding: object, input?: unknown, capabilities?: object}) => Promise<{functionId: string, executor: string, result: unknown}>} runFunction Solo anfitrión: una invocación manual.
 * @property {(folderId: string) => Promise<import('./indexer.js').IndexResult>} indexFolder Solo administración local.
 * @property {(folderId: string) => Promise<import('./index-store.js').FolderIndex | null>} readFolderIndex Solo administración local.
 * @property {(request: import('./search.js').SearchRequest) => Promise<object>} searchFiles Solo anfitrión, sobre ámbitos que él autoriza.
 * @property {(folderId: string, relativePath: string, changes: {set?: object, remove?: string[]}) => Promise<{folderId: string, relativePath: string, properties: object, generation: number | null}>} setProperties Solo anfitrión.
 * @property {(folderId: string, relativePath: string) => Promise<object>} getProperties Solo anfitrión.
 * @property {(folderId: string) => Promise<import('./properties.js').FolderProperties | null>} readFolderProperties Solo anfitrión.
 * @property {(folderId: string, from: string, to: string) => Promise<{moved: number, discarded: number, generation: number | null}>} renameProperties Solo anfitrión: lo llama quien mueve entradas.
 * @property {(folderId: string) => Promise<boolean>} removeFolderProperties Solo anfitrión.
 * @property {(request: {content: unknown, kind?: string, source?: string, references?: object[]}) => Promise<import('./continuity.js').ContinuityEntry>} recordContinuity Solo anfitrión administrativo.
 * @property {(id: string) => Promise<import('./continuity.js').ContinuityEntry | null>} getContinuity Solo anfitrión administrativo.
 * @property {(id: string, changes: object, options?: {expectedRevision?: number}) => Promise<import('./continuity.js').ContinuityEntry>} updateContinuity Solo anfitrión administrativo.
 * @property {(id: string, references: object[], options?: {expectedRevision?: number}) => Promise<import('./continuity.js').ContinuityEntry>} relateContinuity Solo anfitrión administrativo.
 * @property {(id: string, options?: {expectedRevision?: number}) => Promise<boolean>} retireContinuity Solo anfitrión administrativo.
 * @property {() => Promise<string[]>} listContinuityIds Solo anfitrión administrativo.
 * @property {(request: {ids: string[], includeReferenced?: boolean}) => Promise<object>} exportContinuity Solo anfitrión administrativo.
 * @property {(input: string | object) => Promise<{imported: string[], unchanged: string[]}>} importContinuity Solo anfitrión administrativo.
 * @property {(request: {requester: object, ids?: string[], includeReferenced?: boolean, allowRecord?: boolean, source?: string | null}) => Promise<object>} grantContinuityAccess Solo anfitrión administrativo.
 * @property {(authorization: object) => {ids: string[], allowRecord: boolean, source: string | null, revoked: boolean} | null} describeContinuityAccess Solo anfitrión administrativo.
 * @property {(authorization: object) => boolean} revokeContinuityAccess Solo anfitrión administrativo.
 * @property {(request: {requester: object, authorization: object}) => {readContext: Function, recordResult: Function}} bindContinuityAgent Vista que el anfitrión entrega al agente.
 * @property {(request: {requester: object, folderId: string, relativePath: string}) => Promise<object>} grantTextCreate Solo anfitrión administrativo.
 * @property {(authorization: object) => boolean} revokeTextCreate Solo antes del intento.
 * @property {(request: {requester: object, authorization: object, content: string}) => Promise<CreatedTextFile>} createTextFile
 * @property {(request: {requester: object, folderId: string, relativePath: string}) => Promise<object>} grantTextModify Solo anfitrión administrativo.
 * @property {(authorization: object) => boolean} revokeTextModify Solo antes del intento.
 * @property {(request: {requester: object, authorization: object, expectedVersion: string, content: string}) => Promise<ModifiedTextFile>} modifyTextFile
 * @property {(options?: object) => ReturnType<typeof import('./index-observer.js').createIndexObserver>} openIndexObserver Capacidad opcional de la sesión del anfitrión.
 */
/**
 * @typedef {object} CreatedTextFile
 * @property {string} folderId
 * @property {string} relativePath
 * @property {number} size
 * @property {import('./index-scan.js').IndexEntry} indexEntry Metadatos leídos del archivo creado.
 * @property {{ status: 'updated' | 'current' | 'not-indexed' | 'needs-reconciliation', generation: number | null, code: string | null }} index
 */
/**
 * @typedef {object} ModifiedTextFile
 * @property {string} folderId
 * @property {string} relativePath
 * @property {number} size
 * @property {string} previousVersion Versión verificada antes de publicar.
 * @property {string} version Versión del contenido publicado; sirve para la siguiente modificación.
 * @property {import('./index-scan.js').IndexEntry} indexEntry Metadatos leídos del archivo publicado.
 * @property {{ status: 'updated' | 'current' | 'not-indexed' | 'needs-reconciliation', generation: number | null, code: string | null }} index
 */

function validateId(id) {
  if (typeof id !== 'string' || !VALID_ID.test(id)) {
    throw new MotorError('INVALID_ID', 'El identificador debe tener de 1 a 64 caracteres: minúsculas ASCII, números, guion o guion bajo; comenzar con letra o número.');
  }
}

/**
 * Abre una Base existente; no crea directorios ni mantiene recursos abiertos.
 * @param {MotorOptions} options
 * @returns {Promise<Motor>}
 */
export async function openMotor({ baseDirectory, pythonExecutable, nativeTextReaderExecutable, nativeFilesExecutable, functionExecutors = {}, protectedDirectories = [], signal, resourceSample, semanticEncoder, nativeMeaningExecutable, userDataDirectory, backgroundGate = null } = {}) {
  if (typeof baseDirectory !== 'string' || !path.isAbsolute(baseDirectory)) {
    throw new MotorError('INVALID_BASE', 'Indica una ruta absoluta a una Base existente.');
  }
  let base;
  try {
    base = await realpath(baseDirectory);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new MotorError('BASE_NOT_FOUND', 'La Base debe existir antes de abrir el Motor.', { cause: error });
    }
    throw error;
  }
  if (!(await lstat(base)).isDirectory()) {
    throw new MotorError('INVALID_BASE', 'La Base debe ser un directorio.');
  }
  const motor = await realpath(MOTOR_DIRECTORY);
  if (contains(motor, base) || contains(base, motor)) {
    throw new MotorError('BASE_OVERLAPS_MOTOR', 'Motor y Base deben ser directorios independientes, sin contenerse.');
  }
  // El núcleo no crea una marca al consultar, pero respeta la protección global
  // de una Base de producto o de una Base del núcleo que ya fue migrada.
  await readBaseMarker(base);

  function filename(id) {
    validateId(id);
    // El prefijo evita nombres reservados de Windows, incluso para id="con".
    return path.join(base, `record-${id}.json`);
  }

  if (!Array.isArray(protectedDirectories)
      || !protectedDirectories.every((item) => typeof item === 'string' && path.isAbsolute(item))) {
    throw new MotorError('INVALID_PROTECTED_DIRECTORIES', 'Las ubicaciones protegidas deben ser rutas absolutas.');
  }
  const protectedPhysical = await Promise.all(protectedDirectories.map((item) => realpath(item)));
  // setExclusions solo se usa bajo la coordinación del índice (setFolderExclusions).
  const { loadAuthorizedFolder, setExclusions, ...folders } = createFolderRegistry(base, motor, protectedPhysical, userDataDirectory ? await realpath(userDataDirectory) : null);
  // Continuidad sobre esta misma Base; los permisos de agentes viven solo en esta instancia.
  const continuity = createContinuity({ baseDirectory: base });
  const continuityAccess = createContinuityAccess(continuity);
  const conversations = createConversations({ baseDirectory: base, continuity, semanticEncoder, nativeMeaningExecutable, backgroundGate });
  const indexer = createFolderIndexer({
    baseDirectory: base,
    pythonExecutable,
    signal,
    resourceSample,
    backgroundGate,
    resolveScope: async (id) => {
      const folder = await loadAuthorizedFolder(id);
      if (!folder) throw new MotorError('FOLDER_NOT_AUTHORIZED', 'La carpeta no está autorizada o fue retirada.');
      return folder;
    },
  });
  // Definiciones como datos en la Base; el código ejecutable solo llega del catálogo del anfitrión.
  const functions = createFunctionRegistry({ baseDirectory: base });
  const runner = createFunctionRunner({ functions, executors: functionExecutors });
  // Propiedades de entradas (Función 02): en la Base, ligadas a la generación de la autorización.
  const properties = createPropertyStore({
    baseDirectory: base, loadAuthorizedFolder, readFolderIndex: indexer.readFolderIndex,
  });
  // Organización (Función 03): carpetas, mover y papelera de Mind, con permisos de un solo intento.
  const trash = createTrashRegistry({ baseDirectory: base, loadAuthorizedFolder });
  const organizer = createOrganizer({ loadAuthorizedFolder, pythonExecutable, trash, nativeFilesExecutable });
  const workDestinations = createWorkDestinations(base);
  const resultRegistry = createResultRegistry(base);
  const relocation=createConversationRelocation({baseDirectory:base,continuity,conversations,results:resultRegistry,destinations:workDestinations});
  const coordinated=operation=>(...args)=>relocation.withState(()=>operation(...args));
  const resultCopier = createResultCopier({loadAuthorizedFolder,pythonExecutable,nativeFilesExecutable});
  const creator = createTextCreator({ loadAuthorizedFolder, pythonExecutable, nativeFilesExecutable });
  const modifier = createTextModifier({ loadAuthorizedFolder, pythonExecutable, nativeFilesExecutable });
  /** Observadores abiertos en esta instancia; solo existen si el anfitrión los abre. */
  const observers = new Set();

  async function stopObservation(id) {
    // La reconciliación pedida falla con FOLDER_NOT_AUTHORIZED y el observador se detiene como 'revoked'.
    await Promise.allSettled([...observers].filter((observer) => observer.status(id))
      .map((observer) => observer.reconcile(id)));
  }

  const api = Object.freeze({
    baseDirectory: base,
    ...folders,
    /**
     * Solo anfitrión: registro completo de una carpeta, con su generación, para
     * ligar a ella decisiones del usuario (por ejemplo, la política de acceso de agentes).
     * @returns {Promise<{ id: string, path: string, generation: string | null } | null>}
     */
    getAuthorizedFolder: (id) => loadAuthorizedFolder(id),
    authorizeSessionFolder: folders.authorizeSessionFolder,
    releaseSessionFolder: async (id) => {
      const removed = folders.releaseSessionFolder(id);
      if (removed) await stopObservation(id).catch(() => {});
      return removed;
    },

    /**
     * Solo anfitrión: subcarpetas que el usuario excluye del ámbito. Mind no las
     * recorre, no las indexa y no permite leerlas ni escribirlas. Se retiran del
     * índice vigente en el acto.
     * @param {string} id
     * @param {string[]} exclusions Rutas relativas con "/".
     */
    async setFolderExclusions(id, exclusions) {
      return indexer.applyExclusions(id, () => setExclusions(id, exclusions));
    },
    ...createTextReader({ loadAuthorizedFolder, pythonExecutable, nativeTextReaderExecutable }),
    // Texto de documentos de oficina (docx, xlsx, pptx, odt, ods, odp), con permisos propios.
    ...createDocumentReader({ loadAuthorizedFolder, pythonExecutable, nativeFilesExecutable }),
    // Funciones: administración y ejecución manual del anfitrión. getFunctionVersion
    // queda interno del ejecutor; no se entregan a agentes.
    createFunction: functions.createFunction,
    getFunction: functions.getFunction,
    listFunctions: functions.listFunctions,
    updateFunction: functions.updateFunction,
    retireFunction: functions.retireFunction,
    bindFunction: runner.bindFunction,
    unbindFunction: runner.unbindFunction,
    runFunction: runner.runFunction,
    indexFolder: indexer.indexFolder,
    resourceStatus: indexer.resourceStatus,
    prioritizeIndex: indexer.prioritizeIndex,
    readFolderIndex: indexer.readFolderIndex,
    ...createIndexSearch({
      readFolderIndex: indexer.readFolderIndex, loadAuthorizedFolder, readFolderProperties: properties.readFolderProperties,
    }),
    async groupMarks({ folderIds, scopes, tag = null, status = 'abierto', groupBy = 'proyecto', propertyFilter = null, customAliases = null, coverageFolders = [] } = {}) {
      let resolvedScopes = scopes;
      if (!resolvedScopes) {
        const list = folderIds ?? (await folders.listAuthorizedFolders()).map((item) => item.id);
        resolvedScopes = [];
        for (const id of list) {
          const folder = await loadAuthorizedFolder(id).catch(() => null);
          if (!folder) continue;
          const index = await indexer.readFolderIndex(id).catch(() => null);
          if (index) resolvedScopes.push({ folder, index });
        }
      }
      return groupMarksInCatalog({
        baseDirectory: base,
        scopes: resolvedScopes,
        readFolderProperties: properties.readFolderProperties,
        tag,
        status,
        groupBy,
        propertyFilter,
        customAliases,
        coverageFolders,
      });
    },
    // Propiedades: operaciones del anfitrión. Los agentes las usan a través de sus herramientas.
    setProperties: properties.setProperties,
    getProperties: properties.getProperties,
    readFolderProperties: properties.readFolderProperties,
    renameProperties: properties.renameProperties,
    takeProperties: properties.takeProperties,
    putProperties: properties.putProperties,
    dropProperties: properties.dropProperties,
    removeFolderProperties: properties.removeFolderProperties,
    // Organización: solo anfitrión. Cada operación exige un permiso concedido por él.
    ...organizer,
    listTrash: trash.list,
    getTrashEntry: trash.get,
    // Continuidad: administración del anfitrión. El agente recibe solo la vista
    // { readContext, recordResult } de bindContinuityAgent, nunca estas operaciones.
    recordContinuity: coordinated(continuity.recordContinuity),
    getContinuity: coordinated(continuity.getContinuity),
    updateContinuity: coordinated(continuity.updateContinuity),
    relateContinuity: coordinated(continuity.relateContinuity),
    retireContinuity: coordinated(continuity.retireContinuity),
    // Liberación de caché en reposo ligero.
    clearCache: indexer.clearCache,
    listContinuityIds: coordinated(continuity.listContinuityIds),
    exportContinuity: coordinated(continuity.exportContinuity),
    importContinuity: coordinated(continuity.importContinuity),
    // Conversaciones: administración del mismo motor, con permisos en las herramientas.
    ...conversations,
    ...Object.fromEntries(['getConversation','saveConversation','searchConversations','getConversationPreferences','configureConversationPreferences']
      .map(name=>[name,coordinated(conversations[name])])),
    getWorkDestinations: coordinated(workDestinations.get),
    configureWorkDestinations: coordinated(workDestinations.configure),
    workDestinationDirectories: coordinated(workDestinations.directories),
    readConversationResults: coordinated(resultRegistry.read),
    rememberConversationResult: coordinated(resultRegistry.remember),
    replaceConversationResults: coordinated(resultRegistry.replace),
    moveWithConversationRelocation: relocation.move,
    relocateConversationMetadata: relocation.metadata,
    resumeConversationRelocation: relocation.recover,
    grantResultCopy: resultCopier.grantResultCopy,
    grantResultVerification: resultCopier.grantResultVerification,
    verifyResultFile: resultCopier.verifyResultFile,
    async copyResultFile(request) {
      const copied=await resultCopier.copyResultFile(request);
      const iso=value=>Number.isSafeInteger(value)?new Date(value).toISOString():null;
      let index;
      try { index=await indexer.recordCreatedFile(copied.folderId,{
        path:copied.relativePath,type:'file',size:copied.size,state:'indexed',reason:null,
        modifiedAt:iso(copied.modifiedMs),changedAt:iso(copied.changedMs),createdAt:iso(copied.createdMs),identity:copied.identity??null
      }); } catch(error) {index={status:'needs-reconciliation',code:error.code??'INDEX_UPDATE_FAILED'};}
      return {...copied,index};
    },
    grantContinuityAccess: continuityAccess.grantContinuityAccess,
    describeContinuityAccess: continuityAccess.describeContinuityAccess,
    revokeContinuityAccess: continuityAccess.revokeContinuityAccess,
    bindContinuityAgent: continuityAccess.bindContinuityAgent,
    grantTextCreate: creator.grantTextCreate,
    revokeTextCreate: creator.revokeTextCreate,

    async createTextFile(request) {
      const created = await creator.createTextFile(request);
      let index;
      try {
        index = await indexer.recordCreatedFile(created.folderId, created.indexEntry);
      } catch (error) {
        // El archivo ya existe: un fallo del índice no anula la creación ni publica datos dudosos.
        index = { status: 'needs-reconciliation', generation: null, code: error?.code ?? 'INDEX_UPDATE_FAILED' };
      }
      return { ...created, index };
    },

    grantTextModify: modifier.grantTextModify,
    revokeTextModify: modifier.revokeTextModify,

    async modifyTextFile(request) {
      const modified = await modifier.modifyTextFile(request);
      let index;
      try {
        index = await indexer.recordModifiedFile(modified.folderId, modified.indexEntry);
      } catch (error) {
        // El cambio ya está publicado: un fallo del índice no lo anula ni publica datos dudosos.
        index = { status: 'needs-reconciliation', generation: null, code: error?.code ?? 'INDEX_UPDATE_FAILED' };
      }
      try {
        await properties.rebindModifiedProperties(modified.folderId, modified.relativePath,
          modified.previousIdentity, modified.indexEntry.identity);
      } catch (error) {
        index = { ...index, status: 'needs-reconciliation', code: error?.code ?? 'PROPERTIES_UPDATE_FAILED' };
      }
      return { ...modified, index };
    },

    async revokeFolder(id) {
      // Coordinado con publicaciones (#18). Dentro del bloqueo se revoca antes de
      // limpiar; un fallo de limpieza no restaura la autoridad ya retirada.
      let attempted = false;
      let failure = null;
      try {
        return await indexer.removeFolderIndex(id, () => {
          attempted = true;
          return folders.revokeFolder(id);
        });
      } catch (error) {
        // Conserva el error público de validación del registro, sin hacer E/S.
        if (error.code === 'INVALID_SCOPE_ID') return folders.revokeFolder(id);
        failure = error;
        throw error;
      } finally {
        // Fuera del bloqueo: la reconciliación que detiene la observación también lo pide.
        // Se detiene aunque falle la limpieza, solo si la retirada llegó a ejecutarse.
        if (attempted) {
          try {
            // Después del registro y del índice, con su propio bloqueo: una escritura de
            // propiedades en curso termina antes y ninguna posterior supera la revalidación.
            await properties.removeFolderProperties(id);
            // El registro de la papelera describe originales: se retira con la autorización.
            await trash.removeFolder(id);
          } catch (error) {
            if (!failure) failure = error;
          } finally {
            await stopObservation(id);
          }
          // El primer fallo de limpieza se informa; la carpeta sigue retirada.
          if (failure) throw failure;
        }
      }
    },

    /**
     * Abre la observación de índices para la sesión del anfitrión. Es opcional:
     * sin llamarla no hay observaciones ni temporizadores. Nada mantiene vivo el
     * proceso; close() libera todo. No se entrega a agentes.
     * @param {{ onReport?: Function, strategy?: 'recursive' | 'directories' }} [options]
     */
    openIndexObserver(options = {}) {
      // El observador solo actúa a través de este Motor; no admite otro.
      const observer = createIndexObserver({ ...options, motor: api });
      observers.add(observer);
      return Object.freeze({
        ...observer,
        async close() {
          try {
            await observer.close();
          } finally {
            observers.delete(observer);
          }
        },
      });
    },

    async writeRecord(id, value) {
      const target = filename(id);
      if (typeof value !== 'string') {
        throw new MotorError('INVALID_VALUE', 'El valor de un registro técnico debe ser texto.');
      }
      const record = { format: 'mind-technical-record', version: 1, id, value };
      await writeJson(target, record);
      return { id, value };
    },

    async readRecord(id) {
      const target = filename(id);
      const stored = await readJson(target);
      if (stored === null) return null;
      const record = stored.data;
      if (!record || typeof record !== 'object' || Array.isArray(record)
          || Object.keys(record).length !== 4
          || record.format !== 'mind-technical-record' || record.version !== 1
          || record.id !== id || typeof record.value !== 'string') {
        throw new MotorError('RECORD_CORRUPT', 'El registro técnico no tiene el formato esperado.');
      }
      return { id: record.id, value: record.value };
    },
  });
  return api;
}
