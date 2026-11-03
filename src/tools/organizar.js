import { MotorError } from '../errors.js';
import { only, text, absolute, schema, FOLDER_REF, RELATIVE_PATH, TYPE_OUT } from './helpers.js';
import {
  createFolder, moveEntry, deleteEntry, restoreEntry, purgeEntry, indexedEntry, describeDeletion, describePurge,
} from '../organize-service.js';

/**
 * Función 03 — organizar: herramientas del agente. Todas exigen el permiso
 * "organizar" que el usuario concedió en la carpeta (en el destino también, si
 * es otra). Borrar pide la confirmación del usuario cada vez y vaciar la
 * papelera, una confirmación adicional; sin formulario quedan pendientes para la
 * consola de Mind. El agente nunca recibe el organizador del Motor.
 */

const TRASH_ID = { type: 'string', description: 'Id de la entrada de la papelera (lo devuelve "papelera" o "borrar").' };

const DEFINITIONS = [
  {
    name: 'crear_carpeta',
    title: 'Crear carpeta',
    description: 'Crea una carpeta vacía dentro de una carpeta autorizada. No crea carpetas intermedias ni reemplaza nada. Requiere "organizar".',
    inputSchema: schema({ carpeta: FOLDER_REF, ruta: RELATIVE_PATH }, ['ruta']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'mover',
    title: 'Mover o renombrar',
    description: 'Mueve o renombra un archivo o una carpeta sin reemplazar nunca el destino. Con carpeta_destino lo lleva a otra carpeta autorizada del mismo disco. Las propiedades lo acompañan. Requiere "organizar" en origen y destino.',
    inputSchema: schema({
      carpeta: FOLDER_REF, desde: RELATIVE_PATH, hasta: { ...RELATIVE_PATH, description: 'Ruta nueva, relativa a la carpeta de destino.' },
      carpeta_destino: { ...FOLDER_REF, description: 'Otra carpeta autorizada (id o ruta). Por defecto, la misma.' },
    }, ['desde', 'hasta']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'renombrar',
    title: 'Renombrar',
    description: 'Cambia el nombre de un archivo o una carpeta en su misma ubicación, sin reemplazar nada. Requiere "organizar".',
    inputSchema: schema({ carpeta: FOLDER_REF, ruta: RELATIVE_PATH, nuevo_nombre: { type: 'string', description: 'Nombre nuevo, sin "/".' } }, ['ruta', 'nuevo_nombre']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'borrar',
    title: 'Borrar (a la papelera de Mind)',
    description: 'Mueve un archivo o una carpeta a la papelera de Mind, de donde se puede restaurar. El usuario lo confirma cada vez; si tu cliente no puede mostrarle la confirmación, queda pendiente para "mind autorizar". Requiere "organizar".',
    inputSchema: schema({ carpeta: FOLDER_REF, ruta: RELATIVE_PATH, motivo: { type: 'string', description: 'Por qué, para que el usuario decida.' } }, ['ruta']),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'papelera',
    title: 'Ver la papelera de Mind',
    description: 'Lista lo que está en la papelera de Mind de una carpeta, con su id para restaurarlo. Requiere "encontrar".',
    inputSchema: schema({ carpeta: FOLDER_REF }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'restaurar',
    title: 'Restaurar de la papelera',
    description: 'Devuelve un elemento de la papelera de Mind a su ruta original o, si está ocupada, a "<nombre> (restaurado <fecha>)". Nunca reemplaza. Requiere "organizar".',
    inputSchema: schema({ carpeta: FOLDER_REF, id: TRASH_ID }, ['id']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'vaciar_papelera',
    title: 'Eliminar definitivamente',
    description: 'Elimina para siempre un elemento de la papelera de Mind. El usuario lo confirma dos veces; si tu cliente no puede mostrarlo, queda pendiente para "mind autorizar". Requiere "organizar".',
    inputSchema: schema({ carpeta: FOLDER_REF, id: TRASH_ID, motivo: { type: 'string' } }, ['id']),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
];

const pendingAnswer = (outcome, what) => ({
  estado: 'pendiente',
  solicitud: outcome.request.id,
  que_hacer: `El usuario debe aprobar ${what} en la consola de Mind: "mind autorizar" en la carpeta de Mind (o "Autorizar Mind"). Hasta entonces no se ha tocado nada.`,
  ...(outcome.cancelled ? { nota: 'El formulario se cerró sin responder.' } : {}),
});

function trashOut(folder, entry) {
  return {
    id: entry.id, ruta: entry.path, ruta_original_absoluta: absolute(folder.path, entry.path), tipo: TYPE_OUT[entry.type] ?? entry.type,
    bytes: entry.size, borrado: entry.deletedAt, por: entry.by, motivo: entry.reason ?? null,
    propiedades: Array.isArray(entry.properties) ? entry.properties.length : 0,
  };
}

export function createOrganizeTools({ session, connection }) {
  const handlers = {
    async crear_carpeta(args, { requester, resolveFolder, requireAccess, source }) {
      only(args, ['carpeta', 'ruta']);
      const folder = await resolveFolder(args.carpeta);
      await requireAccess(folder, 'organizar');
      const relativePath = text(args.ruta, 'ruta');
      await createFolder(session, { requester, folder, relativePath, source });
      return { estado: 'creada', carpeta: folder.id, ruta: relativePath, ruta_absoluta: absolute(folder.path, relativePath) };
    },

    async mover(args, { requester, resolveFolder, requireAccess, source }) {
      only(args, ['carpeta', 'desde', 'hasta', 'carpeta_destino']);
      const folder = await resolveFolder(args.carpeta);
      const target = args.carpeta_destino === undefined ? folder : await resolveFolder(args.carpeta_destino);
      await requireAccess(folder, 'organizar');
      if (target.id !== folder.id) await requireAccess(target, 'organizar');
      const from = text(args.desde, 'desde');
      const to = text(args.hasta, 'hasta');
      const moved = await moveEntry(session, { requester, folder, from, to, target, source });
      return {
        estado: 'movido', carpeta: folder.id, carpeta_destino: target.id, desde: from, hasta: to,
        ruta_absoluta: absolute(target.path, to), tipo: TYPE_OUT[moved.type] ?? moved.type,
        propiedades_trasladadas: moved.properties.moved ?? 0,
      };
    },

    async renombrar(args, { requester, resolveFolder, requireAccess, source }) {
      only(args, ['carpeta', 'ruta', 'nuevo_nombre']);
      const folder = await resolveFolder(args.carpeta);
      await requireAccess(folder, 'organizar');
      const from = text(args.ruta, 'ruta');
      const name = text(args.nuevo_nombre, 'nuevo_nombre', { max: 255 });
      if (name.includes('/') || name.includes('\\')) throw new MotorError('INVALID_ARGUMENTS', 'nuevo_nombre no puede contener "/": para cambiar de carpeta usa "mover".');
      const slash = from.lastIndexOf('/');
      const to = `${slash >= 0 ? from.slice(0, slash + 1) : ''}${name}`;
      const moved = await moveEntry(session, { requester, folder, from, to, source });
      return {
        estado: 'renombrado', carpeta: folder.id, desde: from, hasta: to, ruta_absoluta: absolute(folder.path, to),
        tipo: TYPE_OUT[moved.type] ?? moved.type, propiedades_trasladadas: moved.properties.moved ?? 0,
      };
    },

    async borrar(args, { requester, consent, resolveFolder, requireAccess, source }) {
      only(args, ['carpeta', 'ruta', 'motivo']);
      const folder = await resolveFolder(args.carpeta);
      await requireAccess(folder, 'organizar');
      const relativePath = text(args.ruta, 'ruta');
      const reason = text(args.motivo, 'motivo', { optional: true, max: 300 });
      const entry = await indexedEntry(session, folder.id, relativePath);
      const index = await session.motor.readFolderIndex(folder.id);
      const contained = (index?.entries ?? []).filter((item) => item.path.startsWith(`${relativePath}/`)).length;
      const outcome = await consent.askOperation({
        kind: 'borrado', lines: describeDeletion(folder, entry, contained), reason,
        operation: { folderId: folder.id, relativePath }, clientInfo: connection?.clientInfo,
      });
      if (outcome.status === 'pending') return pendingAnswer(outcome, 'el borrado');
      if (outcome.status !== 'approved') return { estado: 'rechazado', nota: 'El usuario no confirmó el borrado: no se tocó nada.' };
      const deleted = await deleteEntry(session, { requester, folder, entry, by: `${source}, confirmado por el usuario`, reason, source });
      return {
        estado: 'en_papelera', carpeta: folder.id, ruta: relativePath, id: deleted.trashId,
        tipo: TYPE_OUT[deleted.type] ?? deleted.type, ubicacion_en_papelera: absolute(folder.path, deleted.trashPath),
        nota: 'Se puede restaurar con "restaurar" y este id.',
      };
    },

    async papelera(args, { resolveFolder, requireAccess }) {
      only(args, ['carpeta']);
      const folder = await resolveFolder(args.carpeta);
      await requireAccess(folder, 'encontrar');
      const entries = await session.motor.listTrash(folder.id);
      return { carpeta: folder.id, total: entries.length, elementos: entries.map((entry) => trashOut(folder, entry)) };
    },

    async restaurar(args, { requester, resolveFolder, requireAccess, source }) {
      only(args, ['carpeta', 'id']);
      const folder = await resolveFolder(args.carpeta);
      await requireAccess(folder, 'organizar');
      const restored = await restoreEntry(session, { requester, folder, trashId: text(args.id, 'id', { max: 40 }), source });
      return {
        estado: 'restaurado', carpeta: folder.id, ruta: restored.relativePath, ruta_absoluta: absolute(folder.path, restored.relativePath),
        renombrado: restored.renamed, ruta_original: restored.originalPath, propiedades_repuestas: restored.properties,
      };
    },

    async vaciar_papelera(args, { requester, consent, resolveFolder, requireAccess, source }) {
      only(args, ['carpeta', 'id', 'motivo']);
      const folder = await resolveFolder(args.carpeta);
      await requireAccess(folder, 'organizar');
      const trashId = text(args.id, 'id', { max: 40 });
      const reason = text(args.motivo, 'motivo', { optional: true, max: 300 });
      const entry = await session.motor.getTrashEntry(folder.id, trashId);
      const outcome = await consent.askOperation({
        kind: 'vaciado', lines: describePurge(folder, entry), reason, typed: 'VACIAR',
        operation: { folderId: folder.id, trashId }, clientInfo: connection?.clientInfo,
      });
      if (outcome.status === 'pending') return pendingAnswer(outcome, 'la eliminación definitiva');
      if (outcome.status !== 'approved') return { estado: 'rechazado', nota: 'El usuario no confirmó la eliminación definitiva: no se tocó nada.' };
      const purged = await purgeEntry(session, { requester, folder, trashId, by: `${source}, confirmado dos veces por el usuario`, source });
      return { estado: 'eliminado', carpeta: folder.id, id: trashId, ruta: entry.path, elementos: purged.removed };
    },
  };
  return DEFINITIONS.map((definition) => ({ definition, handler: handlers[definition.name] }));
}
