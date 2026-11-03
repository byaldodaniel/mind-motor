import { MotorError } from '../errors.js';
import { only, text, strings, schema, FOLDER_REF } from './helpers.js';
import { createCustomIndexes, CUSTOM_INDEX_FIELDS } from '../custom-index.js';

/**
 * Índices personalizados en CSV (Función 01), para el agente. Crear o cambiar
 * uno requiere "encontrar" en la carpeta indexada y "escribir" en la carpeta
 * donde se guarda el CSV; se comprueban de nuevo en cada actualización.
 */

const FIELDS_DESCRIPTION = `Columnas, en orden: ${CUSTOM_INDEX_FIELDS.join(', ')} o propiedad:<clave>.`;
const FILTERS = {
  dentro_de: { type: 'string', description: 'Subcarpeta relativa que se indexa; por defecto, toda la carpeta.' },
  tipos: { type: 'array', items: { type: 'string', enum: ['archivo', 'carpeta'] }, description: 'Por defecto, solo archivos.' },
  extensiones: { type: 'array', items: { type: 'string' } },
  propiedades: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean'] }, description: 'Solo elementos con estas propiedades.' },
};

const DEFINITIONS = [
  {
    name: 'indices_personalizados',
    title: 'Índices personalizados',
    description: 'Lista los índices personalizados en CSV: qué indexan, sus columnas, dónde está el CSV, cómo se actualiza y su último resultado.',
    inputSchema: schema({}),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'crear_indice',
    title: 'Crear índice personalizado (CSV)',
    description: 'Crea un índice personalizado y escribe su CSV (UTF-8) en una carpeta autorizada, sin reemplazar ningún archivo. Requiere "encontrar" en la carpeta indexada y "escribir" donde se guarda el CSV.',
    inputSchema: schema({
      nombre: { type: 'string' },
      carpeta: { ...FOLDER_REF, description: 'Carpeta que se indexa.' },
      ...FILTERS,
      campos: { type: 'array', items: { type: 'string' }, description: FIELDS_DESCRIPTION },
      carpeta_csv: { ...FOLDER_REF, description: 'Carpeta donde se guarda el CSV; por defecto, la indexada.' },
      ruta_csv: { type: 'string', description: 'Ruta relativa del CSV, terminada en .csv.' },
      actualizar: { type: 'string', enum: ['manual', 'al_cambiar'], description: 'manual: con "actualizar_indice"; al_cambiar: también cuando cambie la carpeta durante una sesión. Para horarios, usa una función programada.' },
    }, ['nombre', 'campos', 'ruta_csv']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'actualizar_indice',
    title: 'Actualizar índice personalizado',
    description: 'Regenera ahora el CSV de un índice personalizado. Si el CSV se editó fuera de Mind, no lo sobrescribe.',
    inputSchema: schema({ id: { type: 'string' } }, ['id']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'modificar_indice',
    title: 'Modificar índice personalizado',
    description: 'Cambia el nombre, las columnas, los filtros o el modo de actualización y regenera el CSV con el esquema nuevo.',
    inputSchema: schema({
      id: { type: 'string' }, nombre: { type: 'string' }, ...FILTERS,
      campos: { type: 'array', items: { type: 'string' }, description: FIELDS_DESCRIPTION },
      actualizar: { type: 'string', enum: ['manual', 'al_cambiar'] },
    }, ['id']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'retirar_indice',
    title: 'Retirar índice personalizado',
    description: 'Retira la definición del índice. El CSV es un archivo del usuario y se queda donde está.',
    inputSchema: schema({ id: { type: 'string' } }, ['id']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

function filtersIn(args) {
  const filters = {};
  if (args.dentro_de !== undefined) filters.prefix = text(args.dentro_de, 'dentro_de').replace(/\/+$/u, '');
  if (args.tipos !== undefined) filters.types = strings(args.tipos, 'tipos', { max: 2 }).map((type) => ({ archivo: 'file', carpeta: 'directory' }[type] ?? type));
  if (args.extensiones !== undefined) filters.extensions = strings(args.extensiones, 'extensiones', { max: 64, itemMax: 33 });
  if (args.propiedades !== undefined) filters.properties = args.propiedades;
  return filters;
}

function out(definition, csv = null) {
  return {
    id: definition.id, nombre: definition.name, campos: definition.fields, actualizar: definition.update,
    carpeta: definition.source.folderId, dentro_de: definition.filters.prefix, tipos: definition.filters.types,
    extensiones: definition.filters.extensions, propiedades: definition.filters.properties,
    carpeta_csv: definition.destination.folderId, ruta_csv: definition.destination.relativePath,
    ...(csv ? { csv } : {}),
    ultima_actualizacion: definition.lastRun ? {
      fecha: definition.lastRun.at, estado: definition.lastRun.status, filas: definition.lastRun.rows ?? null, error: definition.lastRun.error ?? null,
    } : null,
  };
}

export function createIndexTools({ session }) {
  const indexes = createCustomIndexes({ session });
  const regenerate = async (id) => {
    const result = await indexes.regenerate(id);
    return { estado: result.status, filas: result.rows, csv: result.csv };
  };
  const handlers = {
    async indices_personalizados(args) {
      only(args, []);
      const list = await indexes.list();
      return { total: list.length, indices: list.map((item) => ({ ...out(item, item.csv), problemas: item.problems })) };
    },

    async crear_indice(args, { resolveFolder, requireAccess, source }) {
      only(args, ['nombre', 'carpeta', 'dentro_de', 'tipos', 'extensiones', 'propiedades', 'campos', 'carpeta_csv', 'ruta_csv', 'actualizar']);
      const folder = await resolveFolder(args.carpeta);
      const target = args.carpeta_csv === undefined ? folder : await resolveFolder(args.carpeta_csv);
      await requireAccess(folder, 'encontrar');
      await requireAccess(target, 'escribir');
      const definition = await indexes.create({
        name: text(args.nombre, 'nombre', { max: 120 }), sourceFolderId: folder.id, destinationFolderId: target.id,
        relativePath: text(args.ruta_csv, 'ruta_csv'), fields: args.campos, filters: filtersIn(args), update: args.actualizar,
      });
      await session.audit('indice-personalizado-creado', { indice: definition.id, carpeta: folder.id, destino: target.id, ruta: definition.destination.relativePath, cliente: source });
      try {
        return { ...out(definition), ...(await regenerate(definition.id)) };
      } catch (error) {
        // La definición queda registrada con su error; el agente puede corregirla o retirarla.
        return { ...out(await indexes.get(definition.id)), estado: 'error', error: { codigo: error.code ?? null, mensaje: error.message } };
      }
    },

    async actualizar_indice(args) {
      only(args, ['id']);
      const id = text(args.id, 'id', { max: 20 });
      await indexes.get(id);
      return { id, ...(await regenerate(id)) };
    },

    async modificar_indice(args, { requireAccess, source }) {
      only(args, ['id', 'nombre', 'dentro_de', 'tipos', 'extensiones', 'propiedades', 'campos', 'actualizar']);
      const id = text(args.id, 'id', { max: 20 });
      const current = await indexes.get(id);
      const folder = await session.motor.getAuthorizedFolder(current.source.folderId);
      const target = await session.motor.getAuthorizedFolder(current.destination.folderId);
      if (!folder || !target) throw new MotorError('FOLDER_NOT_AUTHORIZED', 'Una de las carpetas del índice ya no está autorizada.');
      await requireAccess(folder, 'encontrar');
      await requireAccess(target, 'escribir');
      const changes = { filters: filtersIn(args) };
      if (args.nombre !== undefined) changes.name = text(args.nombre, 'nombre', { max: 120 });
      if (args.campos !== undefined) changes.fields = args.campos;
      if (args.actualizar !== undefined) changes.update = args.actualizar;
      const definition = await indexes.update(id, changes);
      await session.audit('indice-personalizado-modificado', { indice: id, cliente: source });
      return { ...out(definition), ...(await regenerate(id)) };
    },

    async retirar_indice(args, { source }) {
      only(args, ['id']);
      const id = text(args.id, 'id', { max: 20 });
      const definition = await indexes.get(id);
      await indexes.remove(id);
      await session.audit('indice-personalizado-retirado', { indice: id, cliente: source });
      return { estado: 'retirado', id, nota: `El CSV (${definition.destination.relativePath}) se conserva donde está.` };
    },
  };
  return DEFINITIONS.map((definition) => ({ definition, handler: handlers[definition.name] }));
}
