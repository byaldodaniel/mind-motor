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
  respaldo: {
    load: () => import('./respaldo.js'),
    ayuda: 'respaldo configurar|crear|estado|verificar|restaurar  Respaldos cifrados de la Base y su recuperación.',
  },
  // Hito B: `actualizar` (src/commands/actualizar.js) se registrará aquí cuando
  // esté probado de extremo a extremo. No se ofrece en el primer producto.
});
