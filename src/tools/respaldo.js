import { MotorError } from '../errors.js';
import { only, schema } from './helpers.js';
import { createConfiguredBackup, readBackupConfig } from '../backup.js';

/**
 * Respaldo para el agente: solo crear un respaldo en el destino que el usuario
 * configuró con "mind respaldo configurar". Configurar, verificar y restaurar
 * son órdenes del usuario. No devuelve el tamaño del respaldo: la Base se
 * comprime antes de cifrarse y un agente que pudiera escribir texto elegido en
 * ella obtendría información por la longitud.
 */
const MIN_INTERVAL_MS = 60_000;

export function createBackupTools({ session }) {
  let last = 0;
  return [{
    definition: {
      name: 'crear_respaldo',
      title: 'Crear respaldo cifrado',
      description: 'Crea un respaldo cifrado de la Base de Mind (índices, permisos, propiedades, continuidad…; no los archivos originales) en la carpeta que el usuario configuró con "mind respaldo configurar". Configurar y restaurar los hace el usuario.',
      inputSchema: schema({}),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async handler(args, { source }) {
      only(args, []);
      if (!(await readBackupConfig(session.motor.baseDirectory))) {
        throw new MotorError('BACKUP_NOT_CONFIGURED', 'Los respaldos no están configurados. El usuario debe ejecutar "mind respaldo configurar <carpeta>" en la carpeta de Mind.');
      }
      if (Date.now() - last < MIN_INTERVAL_MS) throw new MotorError('BACKUP_TOO_FREQUENT', 'Ya se creó un respaldo hace menos de un minuto.');
      last = Date.now();
      const created = await createConfiguredBackup({ baseDirectory: session.motor.baseDirectory });
      await session.audit('respaldo-creado', { archivo: created.name, destino: created.destination, origen: source });
      return { estado: 'creado', archivo: created.name, destino: created.destination, fecha: created.createdAt };
    },
  }];
}
