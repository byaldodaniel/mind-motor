import path from 'node:path';
import { MotorError } from './errors.js';
import { untrustedText } from './consent.js';

/**
 * Operaciones de organización del anfitrión de confianza (Función 03), usadas
 * por las herramientas del agente y por la consola de Mind: ejecutan la
 * operación con un permiso de un solo intento del Motor, mantienen el índice,
 * trasladan las propiedades, anotan el rastro de eliminados y registran la
 * auditoría. Nunca deciden por el usuario: el borrado y el vaciado llegan aquí
 * solo después de su confirmación.
 */

const size = (value) => (Number.isSafeInteger(value) ? `${value} bytes` : '');

/** Entrada vigente del índice para una ruta (reconcilia si no figura). */
export async function indexedEntry(session, folderId, relativePath) {
  const find = async () => (await session.motor.readFolderIndex(folderId))?.entries.find((entry) => entry.path === relativePath) ?? null;
  let entry = await find();
  if (!entry) {
    await session.reindex(folderId);
    entry = await find();
  }
  if (!entry) throw new MotorError('FILE_NOT_FOUND', 'Ese elemento no figura en el índice de la carpeta.');
  return entry;
}

/** Entradas del índice bajo una ruta (la propia y, si es carpeta, las descendientes). */
async function entriesUnder(session, folderId, relativePath) {
  const index = await session.motor.readFolderIndex(folderId);
  return new Map((index?.entries ?? []).filter((entry) => entry.path === relativePath || entry.path.startsWith(`${relativePath}/`))
    .map((entry) => [entry.path, entry]));
}

/** Lo que se muestra al usuario antes de borrar (datos del índice, no del agente). */
export function describeDeletion(folder, entry, contained) {
  return [
    `Mover a la papelera de Mind: ${entry.path}`,
    `En la carpeta: ${folder.path}`,
    entry.type === 'directory'
      ? `Tipo: carpeta, con ${contained} elementos dentro`
      : `Tipo: archivo ${size(entry.size)}${entry.modifiedAt ? `, modificado ${entry.modifiedAt}` : ''}`,
    'Se podrá restaurar desde la papelera de Mind (carpeta .papelera-mind dentro de esa carpeta).',
  ];
}

export function describePurge(folder, entry) {
  return [
    `Eliminar DEFINITIVAMENTE de la papelera de Mind: ${entry.path}`,
    `En la carpeta: ${folder.path}`,
    `Borrado el ${entry.deletedAt} (${entry.type === 'directory' ? 'carpeta' : `archivo ${size(entry.size)}`}).`,
    'No se podrá recuperar con Mind.',
  ];
}

export function createFolder(session, { requester, folder, relativePath, source }) {
  return (async () => {
    const authorization = await session.motor.grantCreateFolder({ requester, folderId: folder.id, relativePath });
    const created = await session.motor.createFolder({ requester, authorization });
    await session.reindex(folder.id).catch(() => {});
    await session.audit('carpeta-creada', { carpeta: folder.id, ruta: relativePath, cliente: source });
    return created;
  })();
}

/** Mover o renombrar, dentro de una carpeta o hacia otra autorizada; las propiedades acompañan. */
export async function moveEntry(session, { requester, folder, from, to, target = folder, source }) {
  const crossing = target.id !== folder.id;
  const authorization = await session.motor.grantMove({
    requester, folderId: folder.id, from, to, ...(crossing ? { targetFolderId: target.id } : {}),
  });
  // Las propiedades se retiran antes de mover: una reconciliación intermedia
  // que vea desaparecer el origen no las borra; se reponen en el destino.
  const taken = await session.motor.takeProperties(folder.id, from).catch(() => []);
  let moved;
  try {
    moved = await session.motor.moveWithConversationRelocation({
      from:path.join(folder.path,...from.split('/')),to:path.join(target.path,...to.split('/'))
    },()=>session.motor.moveEntry({ requester, authorization }));
  } catch (error) {
    if (taken.length > 0) await session.motor.putProperties(folder.id, from, taken).catch(() => {});
    throw error;
  }
  // Primero conocer la identidad del destino; después ligar a ella las propiedades.
  await session.reindex(folder.id).catch(() => {});
  if (crossing) await session.reindex(target.id).catch(() => {});
  let properties = { moved: 0 };
  if (taken.length > 0) {
    try {
      const put = await session.motor.putProperties(target.id, to, taken);
      properties = { moved: put.restored };
    } catch (error) {
      properties = { moved: 0, error: error?.code ?? 'PROPERTIES_FAILED' };
    }
  }
  await session.audit('elemento-movido', {
    carpeta: folder.id, destino: target.id, desde: from, hasta: to, tipo: moved.type, cliente: source,
  });
  return { ...moved, properties };
}

/** Borrado confirmado por el usuario: a la papelera de Mind, con sus propiedades. */
export async function deleteEntry(session, { requester, folder, entry, by, reason = null, source }) {
  const previous = await entriesUnder(session, folder.id, entry.path);
  const properties = await session.motor.takeProperties(folder.id, entry.path).catch(() => []);
  let deleted;
  try {
    const authorization = await session.motor.grantDelete({
      requester, folderId: folder.id, relativePath: entry.path,
      expected: { type: entry.type, size: entry.size, modifiedAt: entry.modifiedAt, entries: entry.type === 'directory' ? previous.size - 1 : null },
      by, reason, properties,
    });
    deleted = await session.motor.deleteEntry({ requester, authorization });
  } catch (error) {
    if (properties.length > 0) await session.motor.putProperties(folder.id, entry.path, properties).catch(() => {});
    throw error;
  }
  await session.reindex(folder.id).catch(() => {});
  await session.removals.record(folder.id, [...previous.keys()], previous, { by: `papelera de Mind (${deleted.trashId})` }).catch(() => {});
  await session.audit('elemento-a-papelera', {
    carpeta: folder.id, ruta: entry.path, tipo: deleted.type, papelera: deleted.trashId, sha256: deleted.entry.sha256, por: by, cliente: source,
  });
  return deleted;
}

export async function restoreEntry(session, { requester, folder, trashId, source }) {
  const stored = await session.motor.getTrashEntry(folder.id, trashId);
  const authorization = await session.motor.grantRestore({ requester, folderId: folder.id, trashId });
  const restored = await session.motor.restoreEntry({ requester, authorization });
  await session.reindex(folder.id).catch(() => {});
  let properties = 0;
  if (Array.isArray(stored.properties) && stored.properties.length > 0) {
    properties = (await session.motor.putProperties(folder.id, restored.relativePath, stored.properties).catch(() => ({ restored: 0 }))).restored;
  }
  await session.audit('elemento-restaurado', {
    carpeta: folder.id, papelera: trashId, ruta: restored.relativePath, renombrado: restored.renamed, cliente: source,
  });
  return { ...restored, properties };
}

/** Vaciado confirmado dos veces por el usuario: borrado definitivo de una entrada. */
export async function purgeEntry(session, { requester, folder, trashId, by, source }) {
  const authorization = await session.motor.grantPurge({ requester, folderId: folder.id, trashId });
  const purged = await session.motor.purgeEntry({ requester, authorization });
  await session.audit('papelera-vaciada', {
    carpeta: folder.id, papelera: trashId, ruta: purged.entry.path, elementos: purged.removed, por: by, cliente: source,
  });
  return purged;
}

/**
 * Consola: el usuario revisa un borrado o un vaciado que un agente dejó
 * pendiente. Mind vuelve a describir el elemento con sus propios datos.
 * @returns {Promise<{ done: boolean }>}
 */
export async function reviewOperationRequest({ session, prompt, request }) {
  const operation = request.operation;
  const folder = await session.motor.getAuthorizedFolder(operation.folderId);
  if (!folder) {
    prompt.write('La carpeta ya no está autorizada: se descarta la solicitud.');
    return { done: false };
  }
  const requester = Object.freeze({ cliente: 'consola de Mind' });
  const by = `consola de Mind (solicitado por ${untrustedText(request.client, 120) || 'un agente'})`;
  try {
    if (request.kind === 'borrado') {
      const entry = await indexedEntry(session, folder.id, operation.relativePath);
      const contained = (await entriesUnder(session, folder.id, entry.path)).size - 1;
      for (const line of describeDeletion(folder, entry, contained)) prompt.write(line);
      if (!(await prompt.yes('¿Mover a la papelera?', false))) {
        prompt.write('Rechazado.');
        return { done: false };
      }
      const deleted = await deleteEntry(session, { requester, folder, entry, by, reason: request.reason, source: 'consola' });
      if (deleted.trash?.status === 'unrecorded') {
        const trashPath = path.join(folder.path, ...deleted.trashPath.split('/'));
        prompt.write(`Movido a .papelera-mind (${trashPath}), pero no se pudo guardar su registro en la Base (${deleted.trash?.code ?? 'TRASH_RECORD_FAILED'}).`);
      } else {
        prompt.write(`Movido a la papelera de Mind (${deleted.trashId}).`);
      }
      return { done: true };
    }
    const entry = await session.motor.getTrashEntry(folder.id, operation.trashId);
    for (const line of describePurge(folder, entry)) prompt.write(line);
    if (!(await prompt.yes('¿Eliminar definitivamente?', false))) {
      prompt.write('Rechazado.');
      return { done: false };
    }
    const typed = (await prompt.ask('Confirmación adicional: escribe VACIAR para eliminarlo para siempre: ')).trim();
    if (typed.toUpperCase() !== 'VACIAR') {
      prompt.write('No se escribió VACIAR: no se elimina nada.');
      return { done: false };
    }
    await purgeEntry(session, { requester, folder, trashId: operation.trashId, by, source: 'consola' });
    prompt.write('Eliminado definitivamente.');
    return { done: true };
  } catch (error) {
    prompt.write(`No se pudo completar: ${error.message}`);
    return { done: false };
  }
}
