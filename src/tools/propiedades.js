import { MotorError } from '../errors.js';
import { only, text, absolute, schema, FOLDER_REF, RELATIVE_PATH } from './helpers.js';

/**
 * Propiedades (Función 02): datos que el usuario o el agente asocian a un
 * archivo o carpeta (estado, cliente, etiqueta…), guardados en la Base y
 * ligados a la autorización de la carpeta. Consultarlas requiere "encontrar";
 * asignarlas o quitarlas, "escribir". Acompañan al elemento cuando se mueve o
 * renombra con Mind y se buscan con "buscar" (parámetro propiedades).
 */

const VALUE = { type: ['string', 'number', 'boolean'] };

const DEFINITIONS = [
  {
    name: 'propiedades',
    title: 'Consultar propiedades',
    description: 'Devuelve las propiedades guardadas por Mind para un archivo o carpeta. Para buscar por propiedades usa "buscar" con el parámetro propiedades. Requiere "encontrar".',
    inputSchema: schema({ carpeta: FOLDER_REF, ruta: RELATIVE_PATH }, ['ruta']),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'asignar_propiedades',
    title: 'Asignar propiedades',
    description: 'Asigna o quita propiedades de un archivo o carpeta del índice (texto de hasta 1024 caracteres, número o booleano; hasta 64 por elemento). No modifica el archivo. Requiere "escribir".',
    inputSchema: schema({
      carpeta: FOLDER_REF, ruta: RELATIVE_PATH,
      asignar: { type: 'object', additionalProperties: VALUE, description: 'Por ejemplo {"estado": "revisado", "importe": 4250}.' },
      quitar: { type: 'array', items: { type: 'string' }, description: 'Claves que se eliminan.' },
    }, ['ruta']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

export function createPropertyTools({ session }) {
  const handlers = {
    async propiedades(args, { resolveFolder, requireAccess }) {
      only(args, ['carpeta', 'ruta']);
      const folder = await resolveFolder(args.carpeta);
      await requireAccess(folder, 'encontrar');
      const relativePath = text(args.ruta, 'ruta');
      const properties = await session.motor.getProperties(folder.id, relativePath);
      return { carpeta: folder.id, ruta: relativePath, ruta_absoluta: absolute(folder.path, relativePath), propiedades: properties };
    },

    async asignar_propiedades(args, { resolveFolder, requireAccess, source }) {
      only(args, ['carpeta', 'ruta', 'asignar', 'quitar']);
      const folder = await resolveFolder(args.carpeta);
      await requireAccess(folder, 'escribir');
      const relativePath = text(args.ruta, 'ruta');
      if (args.asignar === undefined && args.quitar === undefined) {
        throw new MotorError('INVALID_ARGUMENTS', 'Indica asignar, quitar o ambos.');
      }
      await session.ensureIndex(folder.id, { timeoutMs: 30_000 });
      const result = await session.motor.setProperties(folder.id, relativePath, {
        ...(args.asignar !== undefined ? { set: args.asignar } : {}),
        ...(args.quitar !== undefined ? { remove: args.quitar } : {}),
      });
      await session.audit('propiedades-asignadas', {
        carpeta: folder.id, ruta: relativePath, claves: Object.keys(args.asignar ?? {}), quitadas: args.quitar ?? [], cliente: source,
      });
      return { estado: 'guardado', carpeta: folder.id, ruta: relativePath, propiedades: result.properties };
    },
  };
  return DEFINITIONS.map((definition) => ({ definition, handler: handlers[definition.name] }));
}
