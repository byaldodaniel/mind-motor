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
import { createCustomIndexExtension } from './custom-index.js';
import { createAutomationExtension } from './automations/scheduler.js';

export const SESSION_EXTENSIONS = Object.freeze([
  // Función 01: índices personalizados que se actualizan al cambiar su carpeta.
  createCustomIndexExtension,
  // Función 04: turnos por horario y por evento mientras hay una sesión con observación.
  createAutomationExtension,
]);
