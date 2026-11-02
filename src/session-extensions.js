import { createAutomationExtension } from './automations/scheduler.js';

/**
 * Extensiones de la sesión por área (por ejemplo, automatizaciones o
 * regeneración de índices personalizados). Cada entrada es una fábrica
 * `(session) => ({ start?: () => Promise<void>, close?: () => Promise<void> })`.
 * start se llama al empezar la sesión (después de la sincronización inicial) y
 * close al cerrarla, en orden inverso. Ninguna extensión puede mantener vivo el
 * proceso: los temporizadores deben usar unref() y liberarse en close.
 *
 * Para añadir un área: importar su fábrica y agregarla a la lista.
 */
export const SESSION_EXTENSIONS = Object.freeze([
  // Función 04: programador de automatizaciones (solo en sesiones con observación).
  createAutomationExtension,
]);
