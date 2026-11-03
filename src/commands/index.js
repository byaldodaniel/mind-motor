/**
 * Órdenes de consola por área (`mind <orden> ...`). Cada entrada carga un
 * módulo que exporta `run({ parameters, options, layout, withSession, print })`
 * y devuelve el código de salida. Las órdenes que cambian permisos, programan
 * tareas o restauran datos deben exigir un terminal interactivo
 * (requireInteractive de src/console.js).
 *
 * Para añadir una orden: agregar `nombre: { load: () => import('./archivo.js'), ayuda: '...' }`.
 */
export const COMMANDS = Object.freeze({
  actualizar: {
    load: () => import('./actualizar.js'),
    ayuda: 'actualizar <paquete> [--forzar]  Sustituye el Motor y los runtimes por los de un paquete nuevo (.zip, .tar.gz o carpeta) y conserva la Base.',
  },
  programador: {
    load: () => import('./programador.js'),
    ayuda: 'programador instalar|estado|desinstalar  Ejecuta las funciones automáticas autorizadas también con Mind cerrado (programador del sistema).',
  },
  programadas: {
    load: () => import('./programadas.js'),
    ayuda: 'programadas               Ejecuta una vez los turnos vencidos (lo usa el programador del sistema).',
  },
  respaldo: {
    load: () => import('./respaldo.js'),
    ayuda: 'respaldo configurar|crear|estado|verificar|restaurar  Respaldos cifrados de la Base y su recuperación.',
  },
});
