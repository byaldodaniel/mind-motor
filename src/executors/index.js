import { MotorError } from '../errors.js';
import { createNativeExecutors } from './native.js';
import { createBackupExecutors } from '../backup.js';
import { createCustomIndexExecutors } from '../custom-index.js';

/**
 * Catálogo de ejecutores de confianza del Motor, por área. Es el único origen
 * de código ejecutable para las funciones: una definición JSON solo nombra un
 * ejecutor de esta lista y le pasa datos.
 *
 * Cada fábrica recibe la sesión del anfitrión (src/session.js) y devuelve
 * `{ nombre: ejecutor }` con el contrato de src/function-runner.js:
 *
 *   validateInput(input, definition)  obligatorio, síncrono; solo true acepta
 *   run({ input, definition, capabilities, signal })
 *   acceptsDefinition(definition)     opcional, al vincular
 *   timeoutMs, maxResultBytes, capabilities
 *
 * La entrada la construye Mind en cada ejecución: { funcion, origen, fecha,
 * cambios? } (véase src/executors/common.js, validHostInput). El resultado debe
 * ser un resumen sin contenido; si el ejecutor escribe archivos, los indica en
 * `archivos: [{ carpeta, ruta, ... }]` para que una automatización por evento no
 * se dispare con sus propias escrituras.
 *
 * Metadatos opcionales que usa el anfitrión (no el ejecutor de funciones):
 *   etiqueta, descripcion, parametros      texto para el agente y el usuario
 *   validarDefinicion(definition)          lanza INVALID_FUNCTION_DEFINITION con un mensaje claro
 *   requisitos(definition)                 { carpetas: [{ id, permisos, uso }], continuidad: [] }
 *                                          (consentimiento y vínculo a la generación de cada carpeta)
 *   describir(definition)                  líneas adicionales para el consentimiento
 *
 * Cada ejecutor comprueba al ejecutar los permisos del usuario por carpeta
 * (session.policy) y escribe en originales solo con los permisos de un solo
 * intento del Motor.
 *
 * Pendientes de conectar por el desarrollador principal (otras áreas):
 *   createBackupExecutors(session)       → 'respaldo'
 *   createCustomIndexExecutors(session)  → 'indice-csv'
 * Para conectarlas: importar su fábrica y añadirla a EXECUTOR_FACTORIES.
 */
export const EXECUTOR_FACTORIES = Object.freeze([
  createNativeExecutors,
  createBackupExecutors, // 'respaldo'
  createCustomIndexExecutors, // 'indice-csv'
]);

/**
 * Catálogo combinado y fijo para una sesión. Un nombre repetido entre áreas es
 * un error de programación: no se sustituye en silencio.
 * @param {object} session
 * @param {ReadonlyArray<(session: object) => object>} [factories]
 */
export function createExecutorCatalog(session, factories = EXECUTOR_FACTORIES) {
  const catalog = Object.create(null);
  for (const factory of factories) {
    const executors = factory(session);
    if (!executors || typeof executors !== 'object' || Array.isArray(executors)) {
      throw new MotorError('INVALID_EXECUTOR', 'Una fábrica de ejecutores no devolvió un catálogo válido.');
    }
    for (const [name, executor] of Object.entries(executors)) {
      if (Object.hasOwn(catalog, name)) throw new MotorError('DUPLICATE_EXECUTOR', `Ejecutor duplicado en el catálogo: ${name.slice(0, 64)}.`);
      catalog[name] = executor;
    }
  }
  return Object.freeze(catalog);
}
