import path from 'node:path';
import { MotorError } from './errors.js';
import { textVersion } from './text-modifier.js';
import { formatContinuityMarkdown } from './continuity.js';
import { ACCESS_LEVELS, CONTINUITY_LEVELS, ACCESS_PRESETS, normalizeAccess, describeAccess, presetName } from './access-policy.js';
import { createConsent, validateCandidateFolder, untrustedText } from './consent.js';

/**
 * Herramientas que Mind ofrece a un agente conectado. Esta capa es el
 * anfitrión de confianza: conserva el Motor administrativo y, en cada
 * operación, comprueba la decisión del usuario sobre la carpeta antes de
 * conceder al agente un permiso de un solo intento ligado a su identidad
 * opaca. El agente nunca recibe el Motor, ni permisos reutilizables.
 */

export const AGENT_INSTRUCTIONS = `Mind es un motor local que te permite trabajar con la información del usuario a su manera: encontrar, leer, crear, modificar y organizar archivos en las carpetas que el usuario autorice, y conservar continuidad entre sesiones y agentes.

Úsalo cuando aporte valor; si otra herramienta basta, puedes usarla, respetando siempre las autorizaciones del usuario (usar otra herramienta no amplía tus permisos).

Flujo recomendado:
1. Llama a "estado" para ver las carpetas autorizadas, sus permisos y el estado de sus índices.
2. Si el usuario quiere trabajar con una carpeta no autorizada, usa "solicitar_acceso" con su ruta absoluta y los permisos mínimos necesarios. El usuario decide en un formulario o en la consola de Mind; nunca afirmes que autorizó algo por él.
3. Usa "buscar" y "explorar" (índices persistentes, sin recorrer el disco) antes de leer. Lee con "leer"; la respuesta incluye la versión necesaria para "modificar".
4. Para cambios puntuales usa "editar"; para crear, "crear". Mind no sobrescribe ni borra sin control de versión.
5. Registra decisiones y resultados relevantes con "continuidad_registrar" y consulta trabajos anteriores con "continuidad_consultar".

Los resultados incluyen rutas absolutas para que puedas aprovecharlos directamente.`;

const FOLDER_ID = /^[a-f0-9]{64}$/;
const TYPE_IN = Object.freeze({ archivo: 'file', carpeta: 'directory', enlace: 'link', otro: 'other' });
const TYPE_OUT = Object.freeze({ file: 'archivo', directory: 'carpeta', link: 'enlace', other: 'otro', unknown: 'desconocido' });
const MATCH_IN = Object.freeze({ contiene: 'contains', empieza: 'prefix', exacto: 'exact' });
const SORT_IN = Object.freeze({ relevancia: 'relevance', ruta: 'path', modificado: 'modified', tamano: 'size' });
const MAX_EDITS = 50;

function invalid(message) {
  return new MotorError('INVALID_ARGUMENTS', message);
}

function only(args, allowed) {
  const unknown = Object.keys(args).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw invalid(`Parámetros desconocidos: ${unknown.map((key) => key.slice(0, 40)).join(', ')}.`);
}

function text(value, name, { optional = false, max = 4096, allowEmpty = false } = {}) {
  if (value === undefined && optional) return undefined;
  if (typeof value !== 'string' || (!allowEmpty && value === '') || value.length > max) {
    throw invalid(`${name} debe ser texto${allowEmpty ? '' : ' no vacío'} de hasta ${max} caracteres.`);
  }
  return value;
}

function integer(value, name, { optional = true, min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined && optional) return undefined;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw invalid(`${name} debe ser un entero entre ${min} y ${max}.`);
  return value;
}

function bool(value, name) {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw invalid(`${name} debe ser booleano.`);
  return value;
}

function strings(value, name, { max = 32, itemMax = 256 } = {}) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > max
      || !value.every((item) => typeof item === 'string' && item.length > 0 && item.length <= itemMax)) {
    throw invalid(`${name} debe ser una lista de 1 a ${max} textos.`);
  }
  return value;
}

function absolute(root, relativePath) {
  return relativePath === '' ? root : path.join(root, ...relativePath.split('/'));
}

function iso(value) {
  return value ?? null;
}

function lineCount(content) {
  if (content === '') return 0;
  return content.split('\n').length - (content.endsWith('\n') ? 1 : 0);
}

function countOccurrences(haystack, needle) {
  let count = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) count += 1;
  return count;
}

function entryOut(folder, entry) {
  return {
    carpeta: folder.id,
    ruta: entry.path,
    nombre: entry.path.slice(entry.path.lastIndexOf('/') + 1),
    tipo: TYPE_OUT[entry.type] ?? entry.type,
    bytes: entry.size,
    modificado: iso(entry.modifiedAt),
    creado: iso(entry.createdAt),
    estado: entry.state === 'indexed' ? 'indexado' : entry.state === 'not-listed' ? 'sin-listar' : 'sin-verificar',
    ...(entry.reason ? { motivo: entry.reason } : {}),
    ruta_absoluta: absolute(folder.path, entry.path),
  };
}

function continuityOut(entry) {
  return {
    id: entry.id,
    revision: entry.revision,
    creado: entry.createdAt,
    actualizado: entry.updatedAt,
    origen: entry.source,
    tipo: entry.kind,
    contenido: entry.content,
    referencias: entry.references.map((reference) => ({
      ...(reference.entry ? { registro: reference.entry } : { ubicacion: reference.locator }),
      ...(reference.relation ? { relacion: reference.relation } : {}),
    })),
  };
}

function referencesIn(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw invalid('referencias debe ser una lista.');
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw invalid('Cada referencia debe ser un objeto.');
    only(item, ['registro', 'ubicacion', 'relacion']);
    const reference = Object.hasOwn(item, 'registro') ? { entry: item.registro } : { locator: item.ubicacion };
    if (item.relacion !== undefined) reference.relation = item.relacion;
    return reference;
  });
}

function schema(properties, required = []) {
  return { type: 'object', properties, required, additionalProperties: false };
}

const FOLDER_REF = { type: 'string', description: 'Id de la carpeta autorizada (lo devuelve "estado") o su ruta absoluta registrada. Opcional si solo hay una carpeta.' };
const RELATIVE_PATH = { type: 'string', description: 'Ruta relativa dentro de la carpeta, con "/" entre componentes (por ejemplo "notas/idea.md").' };

export const TOOL_DEFINITIONS = Object.freeze([
  {
    name: 'estado',
    title: 'Estado de Mind',
    description: 'Muestra la sesión de Mind: carpetas autorizadas con sus permisos e índices, permisos de continuidad, solicitudes pendientes y cómo se pide el consentimiento al usuario. Llámala primero.',
    inputSchema: schema({}),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'solicitar_acceso',
    title: 'Solicitar acceso del usuario',
    description: 'Pide al usuario que autorice una carpeta (o la continuidad) para los agentes. El usuario decide en un formulario de tu cliente o en la consola de Mind; esta herramienta nunca concede nada por sí sola. Pide solo los permisos necesarios.',
    inputSchema: schema({
      ruta: { type: 'string', description: 'Ruta absoluta de una carpeta existente del usuario. El acceso cubre todo lo que contiene.' },
      acceso: { type: 'string', enum: Object.keys(ACCESS_PRESETS), description: 'Nivel mínimo necesario: encontrar (solo metadatos), leer, o completo (leer, crear, modificar, organizar).' },
      permisos: { type: 'array', items: { type: 'string', enum: ACCESS_LEVELS }, description: 'Alternativa a acceso, por permisos: encontrar, leer, escribir, organizar.' },
      continuidad: { type: 'array', items: { type: 'string', enum: CONTINUITY_LEVELS }, description: 'Para la continuidad entre agentes: leer, registrar. Úsalo en lugar de ruta.' },
      motivo: { type: 'string', description: 'Motivo breve que verá el usuario.' },
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'retirar_acceso',
    title: 'Retirar acceso',
    description: 'Reduce o retira permisos de una carpeta. Retirar "encontrar" (o usar todo=true) retira la carpeta de Mind y elimina su índice; los originales no se tocan.',
    inputSchema: schema({
      carpeta: FOLDER_REF,
      permisos: { type: 'array', items: { type: 'string', enum: ACCESS_LEVELS } },
      todo: { type: 'boolean' },
    }, ['carpeta']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'buscar',
    title: 'Buscar archivos',
    description: 'Busca en los índices persistentes de Mind por nombre o ruta, con filtros de tipo, extensión, subcarpeta, tamaño y fecha. No recorre el disco ni abre contenido. Requiere el permiso "encontrar".',
    inputSchema: schema({
      consulta: { type: 'string', description: 'Texto buscado; sin distinguir mayúsculas ni tildes. Vacío: todo.' },
      carpetas: { type: 'array', items: { type: 'string' }, description: 'Ids o rutas de carpetas; por defecto, todas las que permiten encontrar.' },
      modo: { type: 'string', enum: Object.keys(MATCH_IN) },
      campo: { type: 'string', enum: ['nombre', 'ruta'] },
      tipos: { type: 'array', items: { type: 'string', enum: Object.keys(TYPE_IN) }, description: 'Por defecto, solo archivos.' },
      extensiones: { type: 'array', items: { type: 'string' }, description: 'Por ejemplo [".md", "txt"].' },
      dentro_de: { type: 'string', description: 'Subcarpeta relativa donde buscar.' },
      tamano_min: { type: 'integer', minimum: 0 },
      tamano_max: { type: 'integer', minimum: 0 },
      modificado_desde: { type: 'string', description: 'Fecha ISO 8601, inclusiva.' },
      modificado_hasta: { type: 'string', description: 'Fecha ISO 8601, exclusiva.' },
      orden: { type: 'string', enum: Object.keys(SORT_IN) },
      limite: { type: 'integer', minimum: 1, maximum: 500 },
      desde: { type: 'integer', minimum: 0, description: 'Desplazamiento para paginar.' },
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'explorar',
    title: 'Explorar carpeta',
    description: 'Lista el contenido de una carpeta autorizada (o de una subcarpeta) desde su índice, hasta la profundidad indicada. Requiere "encontrar".',
    inputSchema: schema({
      carpeta: FOLDER_REF,
      ruta: { type: 'string', description: 'Subcarpeta relativa; vacía para la raíz.' },
      profundidad: { type: 'integer', minimum: 1, maximum: 8 },
      limite: { type: 'integer', minimum: 1, maximum: 1000 },
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'leer',
    title: 'Leer un archivo de texto',
    description: 'Lee un archivo de texto UTF-8 (hasta 1 MiB) de una carpeta autorizada. Devuelve el contenido y su versión (necesaria para modificar). Requiere "leer".',
    inputSchema: schema({
      carpeta: FOLDER_REF,
      ruta: RELATIVE_PATH,
      desde_linea: { type: 'integer', minimum: 1, description: 'Primera línea a mostrar (opcional).' },
      lineas: { type: 'integer', minimum: 1, description: 'Número de líneas a mostrar (opcional).' },
    }, ['ruta']),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'crear',
    title: 'Crear un archivo de texto',
    description: 'Crea un archivo de texto nuevo (UTF-8, hasta 1 MiB) en una carpeta autorizada. Nunca sobrescribe: si existe, falla con FILE_EXISTS. Las carpetas padre deben existir. Requiere "escribir".',
    inputSchema: schema({ carpeta: FOLDER_REF, ruta: RELATIVE_PATH, contenido: { type: 'string' } }, ['ruta', 'contenido']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'modificar',
    title: 'Reemplazar el contenido de un archivo',
    description: 'Sustituye el contenido completo de un archivo de texto existente si sigue en la versión indicada (la que devolvió "leer"). Si cambió, falla con VERSION_CONFLICT y no escribe. Requiere "escribir".',
    inputSchema: schema({
      carpeta: FOLDER_REF, ruta: RELATIVE_PATH,
      version: { type: 'string', description: 'Versión leída: "sha256:<64 hex>".' },
      contenido: { type: 'string' },
    }, ['ruta', 'version', 'contenido']),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'editar',
    title: 'Editar fragmentos de un archivo',
    description: 'Aplica reemplazos exactos de texto a un archivo existente: cada "buscar" debe aparecer una sola vez (o usa todas=true). Si se indica version y el archivo cambió, falla sin escribir. Requiere "leer" y "escribir".',
    inputSchema: schema({
      carpeta: FOLDER_REF, ruta: RELATIVE_PATH,
      version: { type: 'string', description: 'Opcional: versión esperada "sha256:<64 hex>".' },
      ediciones: {
        type: 'array', minItems: 1, maxItems: MAX_EDITS,
        items: schema({ buscar: { type: 'string' }, reemplazar: { type: 'string' }, todas: { type: 'boolean' } }, ['buscar', 'reemplazar']),
      },
    }, ['ruta', 'ediciones']),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'continuidad_registrar',
    title: 'Registrar continuidad',
    description: 'Guarda en la Base una decisión, resultado, conocimiento, referencia o contexto para que otra sesión u otro agente continúe el trabajo. El origen lo fija Mind según el cliente conectado. Requiere permiso de continuidad "registrar".',
    inputSchema: schema({
      tipo: { type: 'string', description: 'Etiqueta libre: decisión, resultado, conocimiento, preferencia, contexto…' },
      contenido: { description: 'Datos JSON: texto u objeto.' },
      referencias: {
        type: 'array',
        items: schema({ registro: { type: 'string' }, ubicacion: { type: 'string' }, relacion: { type: 'string' } }),
        description: 'Relaciones con otros registros (registro) o con archivos/URL (ubicacion).',
      },
    }, ['contenido']),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'continuidad_consultar',
    title: 'Consultar continuidad',
    description: 'Recupera registros de continuidad (de esta u otras sesiones y agentes), filtrando por texto, tipo, ids o fecha. Requiere permiso de continuidad "leer".',
    inputSchema: schema({
      texto: { type: 'string' }, tipo: { type: 'string' },
      ids: { type: 'array', items: { type: 'string' } },
      desde: { type: 'string', description: 'Fecha ISO: solo registros actualizados desde entonces.' },
      relacionados: { type: 'boolean', description: 'Incluir también los registros referenciados.' },
      limite: { type: 'integer', minimum: 1, maximum: 100 },
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'continuidad_actualizar',
    title: 'Actualizar continuidad',
    description: 'Actualiza un registro de continuidad si sigue en la revisión indicada. Requiere "leer" y "registrar".',
    inputSchema: schema({
      id: { type: 'string' }, revision: { type: 'integer', minimum: 1 },
      tipo: { type: 'string' }, contenido: {},
      referencias: { type: 'array', items: schema({ registro: { type: 'string' }, ubicacion: { type: 'string' }, relacion: { type: 'string' } }) },
    }, ['id', 'revision']),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'continuidad_exportar',
    title: 'Exportar continuidad',
    description: 'Exporta registros de continuidad en un paquete portable (JSON) o en Markdown, para otra aplicación o Base. Requiere "leer".',
    inputSchema: schema({
      ids: { type: 'array', items: { type: 'string' }, description: 'Por defecto, todos (hasta 1000).' },
      formato: { type: 'string', enum: ['json', 'markdown'] },
      relacionados: { type: 'boolean' },
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'continuidad_importar',
    title: 'Importar continuidad',
    description: 'Incorpora un paquete de continuidad (formato mind-continuity-export) sin sobrescribir registros distintos. Requiere "registrar".',
    inputSchema: schema({ paquete: { type: 'string', description: 'El JSON del paquete exportado.' } }, ['paquete']),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
]);

/**
 * @param {{ session: object, connection: object, log?: Function, extraTools?: object[] }} options
 */
export function createAgentTools({ session, connection, log = () => {}, extraTools = [] }) {
  const { motor, policy } = session;
  // Identidad opaca del agente conectado: los permisos del Motor se ligan a este objeto.
  const requester = Object.freeze({ cliente: untrustedText(connection?.clientInfo?.name ?? 'desconocido', 80) });
  const consent = createConsent({ connection, requests: session.requests });
  const source = (() => {
    const name = untrustedText(connection?.clientInfo?.title ?? connection?.clientInfo?.name ?? '', 80);
    const version = untrustedText(connection?.clientInfo?.version ?? '', 32);
    return name ? `${name}${version ? ` ${version}` : ''} (declarado por el cliente)` : 'agente sin identificar';
  })();

  async function folders() {
    return motor.listAuthorizedFolders();
  }

  async function resolveFolder(reference) {
    const list = await folders();
    if (reference === undefined) {
      if (list.length === 1) return list[0];
      throw invalid(list.length === 0
        ? 'No hay carpetas autorizadas. Usa "solicitar_acceso" con la ruta que el usuario quiera usar.'
        : 'Indica la carpeta (id o ruta): hay varias autorizadas. Consulta "estado".');
    }
    text(reference, 'carpeta');
    const found = FOLDER_ID.test(reference)
      ? list.find((folder) => folder.id === reference)
      : list.find((folder) => (process.platform === 'win32'
        ? folder.path.toLowerCase() === path.normalize(reference).toLowerCase()
        : folder.path === path.normalize(reference)));
    if (!found) throw new MotorError('FOLDER_NOT_AUTHORIZED', 'La carpeta no está autorizada en Mind. Usa "solicitar_acceso".');
    return found;
  }

  async function requireAccess(folder, ...levels) {
    const decision = await policy.get(folder.id);
    for (const level of levels) {
      if (!decision?.access[level]) {
        throw new MotorError('ACCESS_NOT_GRANTED', `El usuario no concedió el permiso "${level}" en esta carpeta. Pídelo con "solicitar_acceso".`);
      }
    }
    return decision;
  }

  async function requireContinuity(...levels) {
    const decision = await policy.getContinuity();
    for (const level of levels) {
      if (!decision[level]) {
        throw new MotorError('ACCESS_NOT_GRANTED', `El usuario no concedió "${level}" sobre la continuidad. Pídelo con "solicitar_acceso" y el parámetro continuidad.`);
      }
    }
    return decision;
  }

  async function readFile(folder, relativePath) {
    const authorization = await motor.grantTextRead({ requester, folderId: folder.id, relativePath });
    const read = await motor.readTextFile({ requester, authorization });
    return { content: read.content, version: textVersion(read.content) };
  }

  async function indexSummary(folder) {
    try {
      const index = await motor.readFolderIndex(folder.id);
      if (!index) return { estado: 'sin-indice' };
      return {
        estado: 'vigente',
        entradas: index.entries.length,
        archivos: index.entries.filter((entry) => entry.type === 'file').length,
        actualizado: index.updatedAt,
        completo: index.issues.length === 0 && index.entries.every((entry) => entry.state === 'indexed'),
      };
    } catch (error) {
      return { estado: 'no-disponible', codigo: error?.code ?? 'INDEX_UNAVAILABLE' };
    }
  }

  function pendingAnswer(answer) {
    return {
      estado: 'pendiente',
      solicitud: answer.request.id,
      instrucciones: `${answer.cancelled
        ? 'El formulario de autorización se canceló o tu cliente no pudo mostrarlo.'
        : 'Tu cliente no muestra formularios de autorización.'} La solicitud quedó pendiente: pide al usuario que, si quiere concederla, abra la carpeta de Mind y ejecute "mind autorizar" (o abra "Autorizar Mind"). Después consulta "estado". No la des por aprobada.`,
    };
  }

  const handlers = {
    async estado(args) {
      only(args, []);
      await session.sync().catch(() => {});
      const list = await folders();
      const carpetas = [];
      for (const folder of list) {
        const decision = await policy.get(folder.id);
        carpetas.push({
          id: folder.id,
          ruta: folder.path,
          nombre: path.basename(folder.path),
          acceso: decision ? presetName(decision.access) : 'ninguno',
          permisos: decision ? describeAccess(decision.access) : [],
          ...(decision ? {} : { aviso: 'Registrada sin permisos para agentes: solicita acceso.' }),
          indice: await indexSummary(folder),
          ...session.folderStatus(folder.id),
        });
      }
      const continuity = await policy.getContinuity();
      const pending = await session.requests.list();
      return {
        mind: { motor: session.motorVersion, base: motor.baseDirectory, producto: session.layout.product },
        sesion: { observacion: session.observing() ? 'activa' : 'bajo-demanda', cliente: source },
        consentimiento: consent.channel() === 'formulario-del-cliente'
          ? 'Tu cliente muestra formularios de autorización al usuario.'
          : 'Tu cliente no admite formularios: las solicitudes quedan pendientes y el usuario las aprueba con "mind autorizar" en la carpeta de Mind.',
        carpetas,
        continuidad: { permisos: describeAccess(continuity, CONTINUITY_LEVELS) },
        solicitudes_pendientes: pending.map((request) => ({
          id: request.id, tipo: request.kind, ruta: request.path, permisos: request.requested, creada: request.createdAt,
        })),
        ...(list.length === 0 ? { siguiente_paso: 'Pregunta al usuario qué carpeta quiere usar y llama a "solicitar_acceso".' } : {}),
      };
    },

    async solicitar_acceso(args) {
      only(args, ['ruta', 'acceso', 'permisos', 'continuidad', 'motivo']);
      const reason = text(args.motivo, 'motivo', { optional: true, max: 1000 });
      if (args.continuidad !== undefined) {
        if (args.ruta !== undefined || args.permisos !== undefined || args.acceso !== undefined) {
          throw invalid('Usa continuidad o ruta con acceso, no ambos.');
        }
        const requested = normalizeAccess(args.continuidad, CONTINUITY_LEVELS);
        const current = await policy.getContinuity();
        if (CONTINUITY_LEVELS.every((level) => !requested[level] || current[level])) {
          return { estado: 'ya-autorizado', continuidad: describeAccess(current, CONTINUITY_LEVELS) };
        }
        const answer = await consent.askContinuity({ requested, current, reason, clientInfo: connection?.clientInfo });
        if (answer.status === 'pending') return pendingAnswer(answer);
        if (answer.status !== 'approved') return { estado: answer.status === 'declined' ? 'rechazado' : 'cancelado' };
        const saved = await policy.setContinuity(describeAccess(answer.access, CONTINUITY_LEVELS), { channel: answer.channel });
        await session.audit('continuidad-autorizada', { permisos: describeAccess(saved, CONTINUITY_LEVELS), canal: answer.channel, cliente: source });
        return { estado: 'autorizado', continuidad: describeAccess(saved, CONTINUITY_LEVELS) };
      }
      const folderPath = text(args.ruta, 'ruta');
      if (args.acceso !== undefined && args.permisos !== undefined) throw invalid('Usa acceso o permisos, no ambos.');
      if (args.acceso !== undefined && !Object.hasOwn(ACCESS_PRESETS, args.acceso)) throw invalid('acceso debe ser encontrar, leer o completo.');
      const requested = normalizeAccess(args.acceso !== undefined ? ACCESS_PRESETS[args.acceso] : args.permisos ?? ['encontrar']);
      requested.encontrar = true;
      const canonical = await validateCandidateFolder(folderPath, {
        protectedDirectories: session.layout.protectedDirectories,
        baseDirectory: motor.baseDirectory,
        motorDirectory: session.layout.motorDirectory,
      });
      const existing = (await folders()).find((folder) => folder.path === canonical);
      const current = existing ? (await policy.get(existing.id))?.access ?? null : null;
      if (existing && current && ACCESS_LEVELS.every((level) => !requested[level] || current[level])) {
        return { estado: 'ya-autorizado', carpeta: { id: existing.id, ruta: existing.path, permisos: describeAccess(current) } };
      }
      const answer = await consent.askFolder({ folderPath: canonical, requested, current, reason, clientInfo: connection?.clientInfo });
      if (answer.status === 'pending') return pendingAnswer(answer);
      if (answer.status !== 'approved') return { estado: answer.status === 'declined' ? 'rechazado' : 'cancelado' };
      const folder = existing ?? await motor.authorizeFolder(canonical);
      const saved = await policy.set(folder.id, answer.access, { channel: answer.channel });
      await session.audit('carpeta-autorizada', { carpeta: folder.id, ruta: folder.path, permisos: describeAccess(saved.access), canal: answer.channel, cliente: source });
      const index = await session.ensureIndex(folder.id, { timeoutMs: 30_000 }).catch((error) => ({ status: 'error', code: error?.code }));
      return {
        estado: 'autorizado',
        carpeta: { id: folder.id, ruta: folder.path, permisos: describeAccess(saved.access) },
        indice: index.status === 'reconciling' ? { estado: 'indexando', nota: 'La indexación inicial continúa; "estado" muestra el avance.' } : await indexSummary(folder),
      };
    },

    async retirar_acceso(args) {
      only(args, ['carpeta', 'permisos', 'todo']);
      const folder = await resolveFolder(args.carpeta);
      const all = bool(args.todo, 'todo') === true;
      const removing = args.permisos === undefined ? null : normalizeAccess(args.permisos);
      if (!all && !removing) throw invalid('Indica los permisos a retirar o todo=true.');
      if (all || removing.encontrar) {
        await motor.revokeFolder(folder.id);
        await policy.remove(folder.id);
        await session.forget(folder.id);
        await session.audit('carpeta-retirada', { carpeta: folder.id, ruta: folder.path, cliente: source });
        return { estado: 'retirada', carpeta: folder.id, nota: 'Se retiró la autorización y su índice. Los archivos originales no se modificaron.' };
      }
      const decision = await policy.get(folder.id);
      const access = { ...(decision?.access ?? normalizeAccess([])) };
      for (const level of ACCESS_LEVELS) if (removing[level]) access[level] = false;
      const saved = await policy.set(folder.id, access, { channel: decision?.channel ?? 'administracion-local' });
      await session.audit('permisos-reducidos', { carpeta: folder.id, permisos: describeAccess(saved.access), cliente: source });
      return { estado: 'actualizado', carpeta: folder.id, permisos: describeAccess(saved.access) };
    },

    async buscar(args) {
      only(args, ['consulta', 'carpetas', 'modo', 'campo', 'tipos', 'extensiones', 'dentro_de', 'tamano_min', 'tamano_max',
        'modificado_desde', 'modificado_hasta', 'orden', 'limite', 'desde']);
      const list = await folders();
      let selected;
      if (args.carpetas !== undefined) {
        selected = [];
        for (const reference of strings(args.carpetas, 'carpetas', { max: 64, itemMax: 4096 })) {
          const folder = await resolveFolder(reference);
          await requireAccess(folder, 'encontrar');
          selected.push(folder);
        }
      } else {
        selected = [];
        for (const folder of list) if ((await policy.get(folder.id))?.access.encontrar) selected.push(folder);
        if (selected.length === 0) {
          throw new MotorError('ACCESS_NOT_GRANTED', 'No hay carpetas con permiso para encontrar. Usa "solicitar_acceso".');
        }
      }
      for (const folder of selected) await session.ensureIndex(folder.id, { timeoutMs: 30_000 });
      const request = { folderIds: selected.map((folder) => folder.id) };
      if (args.consulta !== undefined) request.query = text(args.consulta, 'consulta', { max: 256, allowEmpty: true });
      if (args.modo !== undefined) request.match = MATCH_IN[args.modo] ?? (() => { throw invalid('modo no válido.'); })();
      if (args.campo !== undefined) request.field = { nombre: 'name', ruta: 'path' }[args.campo] ?? (() => { throw invalid('campo no válido.'); })();
      if (args.tipos !== undefined) request.types = strings(args.tipos, 'tipos', { max: 4 }).map((type) => TYPE_IN[type] ?? (() => { throw invalid('tipo no válido.'); })());
      if (args.extensiones !== undefined) request.extensions = strings(args.extensiones, 'extensiones', { itemMax: 33 });
      if (args.dentro_de !== undefined) request.pathPrefix = text(args.dentro_de, 'dentro_de').replace(/\/+$/u, '');
      if (args.tamano_min !== undefined) request.minSize = integer(args.tamano_min, 'tamano_min');
      if (args.tamano_max !== undefined) request.maxSize = integer(args.tamano_max, 'tamano_max');
      if (args.modificado_desde !== undefined) request.modifiedAfter = text(args.modificado_desde, 'modificado_desde', { max: 64 });
      if (args.modificado_hasta !== undefined) request.modifiedBefore = text(args.modificado_hasta, 'modificado_hasta', { max: 64 });
      if (args.orden !== undefined) request.sort = SORT_IN[args.orden] ?? (() => { throw invalid('orden no válido.'); })();
      request.limit = integer(args.limite, 'limite', { min: 1, max: 500 }) ?? 50;
      if (args.desde !== undefined) request.offset = integer(args.desde, 'desde');
      const found = await motor.searchFiles(request);
      const byId = new Map(selected.map((folder) => [folder.id, folder]));
      return {
        total: found.total,
        mostrados: found.results.length,
        desde: found.offset,
        truncado: found.truncated,
        resultados: found.results.map((result) => {
          const folder = byId.get(result.folderId);
          return entryOut(folder, {
            path: result.relativePath, type: result.type, size: result.size, modifiedAt: result.modifiedAt,
            createdAt: result.createdAt, state: result.status === 'indexed' ? 'indexed' : 'unverified', reason: result.reason,
          });
        }),
        carpetas: found.scopes.map((scope) => ({
          carpeta: scope.folderId, estado: scope.status, indexado: scope.indexedAt, completo: scope.complete,
          ...(scope.code ? { codigo: scope.code } : {}),
        })),
      };
    },

    async explorar(args) {
      only(args, ['carpeta', 'ruta', 'profundidad', 'limite']);
      const folder = await resolveFolder(args.carpeta);
      await requireAccess(folder, 'encontrar');
      const prefix = (text(args.ruta, 'ruta', { optional: true, allowEmpty: true }) ?? '').replace(/^\/+|\/+$/gu, '');
      const depth = integer(args.profundidad, 'profundidad', { min: 1, max: 8 }) ?? 1;
      const limit = integer(args.limite, 'limite', { min: 1, max: 1000 }) ?? 200;
      const ensured = await session.ensureIndex(folder.id, { timeoutMs: 30_000 });
      const index = await motor.readFolderIndex(folder.id);
      if (!index) return { carpeta: folder.id, estado: ensured.status === 'reconciling' ? 'indexando' : 'sin-indice', entradas: [] };
      const base = prefix === '' ? 0 : prefix.split('/').length;
      if (prefix !== '' && !index.entries.some((entry) => entry.path === prefix && entry.type === 'directory')) {
        throw new MotorError('PATH_NOT_INDEXED', 'La subcarpeta no figura en el índice como carpeta.');
      }
      const matching = index.entries.filter((entry) => (prefix === '' || entry.path.startsWith(`${prefix}/`))
        && entry.path.split('/').length - base <= depth);
      return {
        carpeta: folder.id,
        ruta: prefix,
        ruta_absoluta: absolute(folder.path, prefix),
        indexado: index.updatedAt,
        total: matching.length,
        truncado: matching.length > limit,
        entradas: matching.slice(0, limit).map((entry) => entryOut(folder, entry)),
      };
    },

    async leer(args) {
      only(args, ['carpeta', 'ruta', 'desde_linea', 'lineas']);
      const folder = await resolveFolder(args.carpeta);
      await requireAccess(folder, 'leer');
      const relativePath = text(args.ruta, 'ruta');
      const from = integer(args.desde_linea, 'desde_linea', { min: 1 });
      const count = integer(args.lineas, 'lineas', { min: 1 });
      const { content, version } = await readFile(folder, relativePath);
      const total = lineCount(content);
      let shown = content;
      if (from !== undefined || count !== undefined) {
        const lines = content.split('\n');
        const start = (from ?? 1) - 1;
        shown = lines.slice(start, count === undefined ? undefined : start + count).join('\n');
      }
      const metadata = {
        carpeta: folder.id, ruta: relativePath, ruta_absoluta: absolute(folder.path, relativePath),
        version, bytes: Buffer.byteLength(content, 'utf8'), lineas: total,
        ...(shown !== content ? { mostrado: { desde_linea: from ?? 1, lineas: count ?? null } } : {}),
      };
      // El contenido va en los dos canales: Claude Code entrega al modelo los datos
      // estructurados y otros clientes, el bloque de texto (comprobado con un agente real).
      return {
        ...metadata,
        contenido: shown,
        __mcpText: `${JSON.stringify(metadata)}\n--- contenido ---\n${shown}`,
      };
    },

    async crear(args) {
      only(args, ['carpeta', 'ruta', 'contenido']);
      const folder = await resolveFolder(args.carpeta);
      await requireAccess(folder, 'escribir');
      const relativePath = text(args.ruta, 'ruta');
      if (typeof args.contenido !== 'string') throw invalid('contenido debe ser texto.');
      const authorization = await motor.grantTextCreate({ requester, folderId: folder.id, relativePath });
      const created = await motor.createTextFile({ requester, authorization, content: args.contenido });
      await session.audit('archivo-creado', { carpeta: folder.id, ruta: relativePath, bytes: created.size, cliente: source });
      return {
        estado: 'creado', carpeta: folder.id, ruta: relativePath, ruta_absoluta: absolute(folder.path, relativePath),
        bytes: created.size, version: textVersion(args.contenido), indice: created.index.status,
      };
    },

    async modificar(args) {
      only(args, ['carpeta', 'ruta', 'version', 'contenido']);
      const folder = await resolveFolder(args.carpeta);
      await requireAccess(folder, 'escribir');
      const relativePath = text(args.ruta, 'ruta');
      if (typeof args.contenido !== 'string') throw invalid('contenido debe ser texto.');
      const authorization = await motor.grantTextModify({ requester, folderId: folder.id, relativePath });
      const modified = await motor.modifyTextFile({
        requester, authorization, expectedVersion: text(args.version, 'version', { max: 80 }), content: args.contenido,
      });
      await session.audit('archivo-modificado', { carpeta: folder.id, ruta: relativePath, anterior: modified.previousVersion, nueva: modified.version, cliente: source });
      return {
        estado: 'modificado', carpeta: folder.id, ruta: relativePath, ruta_absoluta: absolute(folder.path, relativePath),
        bytes: modified.size, version_anterior: modified.previousVersion, version: modified.version, indice: modified.index.status,
      };
    },

    async editar(args) {
      only(args, ['carpeta', 'ruta', 'version', 'ediciones']);
      const folder = await resolveFolder(args.carpeta);
      await requireAccess(folder, 'leer', 'escribir');
      const relativePath = text(args.ruta, 'ruta');
      const expected = text(args.version, 'version', { optional: true, max: 80 });
      if (!Array.isArray(args.ediciones) || args.ediciones.length === 0 || args.ediciones.length > MAX_EDITS) {
        throw invalid(`ediciones debe ser una lista de 1 a ${MAX_EDITS} reemplazos.`);
      }
      const { content, version } = await readFile(folder, relativePath);
      if (expected !== undefined && expected !== version) {
        throw new MotorError('VERSION_CONFLICT', 'El archivo cambió desde la versión indicada; no se modifica.');
      }
      let next = content;
      const applied = [];
      for (const [position, edit] of args.ediciones.entries()) {
        if (!edit || typeof edit !== 'object' || Array.isArray(edit)) throw invalid('Cada edición debe ser un objeto.');
        only(edit, ['buscar', 'reemplazar', 'todas']);
        const find = text(edit.buscar, `ediciones[${position}].buscar`, { max: 1024 * 1024 });
        if (typeof edit.reemplazar !== 'string') throw invalid(`ediciones[${position}].reemplazar debe ser texto.`);
        const occurrences = countOccurrences(next, find);
        if (occurrences === 0) {
          throw new MotorError('EDIT_NOT_FOUND', `La edición ${position + 1} no encontró el texto buscado; no se modificó nada.`);
        }
        if (occurrences > 1 && edit.todas !== true) {
          throw new MotorError('EDIT_AMBIGUOUS', `La edición ${position + 1} aparece ${occurrences} veces; amplía el texto o usa todas=true. No se modificó nada.`);
        }
        next = edit.todas === true ? next.split(find).join(edit.reemplazar) : next.replace(find, () => edit.reemplazar);
        applied.push({ edicion: position + 1, reemplazos: edit.todas === true ? occurrences : 1 });
      }
      if (next === content) return { estado: 'sin-cambios', carpeta: folder.id, ruta: relativePath, version };
      const authorization = await motor.grantTextModify({ requester, folderId: folder.id, relativePath });
      // La versión leída protege frente a cambios entre la lectura y la escritura.
      const modified = await motor.modifyTextFile({ requester, authorization, expectedVersion: version, content: next });
      await session.audit('archivo-editado', { carpeta: folder.id, ruta: relativePath, anterior: version, nueva: modified.version, cliente: source });
      return {
        estado: 'modificado', carpeta: folder.id, ruta: relativePath, ruta_absoluta: absolute(folder.path, relativePath),
        ediciones: applied, version_anterior: version, version: modified.version, bytes: modified.size, indice: modified.index.status,
      };
    },

    async continuidad_registrar(args) {
      only(args, ['tipo', 'contenido', 'referencias']);
      await requireContinuity('registrar');
      if (!Object.hasOwn(args, 'contenido')) throw invalid('Falta contenido.');
      const entry = await motor.recordContinuity({
        content: args.contenido,
        ...(args.tipo !== undefined ? { kind: args.tipo } : {}),
        source,
        ...(args.referencias !== undefined ? { references: referencesIn(args.referencias) } : {}),
      });
      return { estado: 'registrado', registro: continuityOut(entry) };
    },

    async continuidad_consultar(args) {
      only(args, ['texto', 'tipo', 'ids', 'desde', 'relacionados', 'limite']);
      await requireContinuity('leer');
      const needle = text(args.texto, 'texto', { optional: true, max: 256 });
      const kind = text(args.tipo, 'tipo', { optional: true, max: 200 });
      const since = args.desde === undefined ? null : Date.parse(text(args.desde, 'desde', { max: 64 }));
      if (since !== null && !Number.isFinite(since)) throw invalid('desde debe ser una fecha ISO.');
      const limit = integer(args.limite, 'limite', { min: 1, max: 100 }) ?? 20;
      const ids = args.ids === undefined ? await motor.listContinuityIds() : strings(args.ids, 'ids', { max: 100, itemMax: 64 });
      const fold = (value) => value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
      const wanted = needle === undefined ? null : fold(needle);
      const found = [];
      for (const id of ids) {
        const entry = await motor.getContinuity(id).catch((error) => {
          if (args.ids !== undefined) throw error;
          return null;
        });
        if (!entry) continue;
        if (kind !== undefined && entry.kind !== kind) continue;
        if (since !== null && Date.parse(entry.updatedAt) < since) continue;
        if (wanted !== null && !fold(JSON.stringify([entry.kind, entry.source, entry.content])).includes(wanted)) continue;
        found.push(entry);
      }
      found.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
      const page = found.slice(0, limit);
      const related = [];
      if (args.relacionados === true) {
        const seen = new Set(page.map((entry) => entry.id));
        for (const entry of page) {
          for (const reference of entry.references) {
            if (!reference.entry || seen.has(reference.entry)) continue;
            seen.add(reference.entry);
            const target = await motor.getContinuity(reference.entry).catch(() => null);
            if (target) related.push(continuityOut(target));
          }
        }
      }
      return {
        total: found.length, mostrados: page.length,
        registros: page.map(continuityOut),
        ...(args.relacionados === true ? { relacionados: related } : {}),
      };
    },

    async continuidad_actualizar(args) {
      only(args, ['id', 'revision', 'tipo', 'contenido', 'referencias']);
      await requireContinuity('leer', 'registrar');
      const changes = {};
      if (Object.hasOwn(args, 'contenido')) changes.content = args.contenido;
      if (args.tipo !== undefined) changes.kind = args.tipo;
      if (args.referencias !== undefined) changes.references = referencesIn(args.referencias);
      const entry = await motor.updateContinuity(text(args.id, 'id', { max: 64 }), changes,
        { expectedRevision: integer(args.revision, 'revision', { optional: false, min: 1 }) });
      return { estado: 'actualizado', registro: continuityOut(entry) };
    },

    async continuidad_exportar(args) {
      only(args, ['ids', 'formato', 'relacionados']);
      await requireContinuity('leer');
      const format = args.formato ?? 'json';
      if (!['json', 'markdown'].includes(format)) throw invalid('formato debe ser json o markdown.');
      const ids = args.ids === undefined ? (await motor.listContinuityIds()).slice(0, 1000) : strings(args.ids, 'ids', { max: 1000, itemMax: 64 });
      if (ids.length === 0) return { registros: 0, paquete: null, nota: 'No hay registros de continuidad.' };
      const pack = await motor.exportContinuity({ ids, includeReferenced: bool(args.relacionados, 'relacionados') ?? false });
      const output = format === 'markdown' ? formatContinuityMarkdown(pack) : JSON.stringify(pack, null, 2);
      return { registros: pack.entries.length, formato: format, faltantes: pack.missing, paquete: output, __mcpText: output };
    },

    async continuidad_importar(args) {
      only(args, ['paquete']);
      await requireContinuity('registrar');
      const result = await motor.importContinuity(text(args.paquete, 'paquete', { max: 64 * 1024 * 1024 }));
      return { estado: 'importado', importados: result.imported, sin_cambios: result.unchanged };
    },
  };

  for (const tool of extraTools) handlers[tool.definition.name] = tool.handler;
  const definitions = [...TOOL_DEFINITIONS, ...extraTools.map((tool) => tool.definition)];

  return Object.freeze({
    definitions,
    requester,
    async call(name, args, context) {
      const handler = handlers[name];
      if (!handler) throw new MotorError('UNKNOWN_TOOL', 'Herramienta desconocida.');
      return handler(args, { ...context, requester, consent, resolveFolder, requireAccess, requireContinuity, source, readFile });
    },
  });
}
