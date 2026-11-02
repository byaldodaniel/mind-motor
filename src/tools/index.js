/**
 * Registro de herramientas de agente por área. Cada módulo exporta una fábrica
 * `({ session, connection, log }) => [{ definition, handler }]`.
 *
 * `handler(args, context)` recibe, además de los argumentos (datos no
 * confiables), un contexto del anfitrión: requester (identidad opaca del
 * agente), consent (formularios de consentimiento), resolveFolder,
 * requireAccess(folder, ...niveles), requireContinuity(...niveles), source
 * (origen declarado del cliente) y readFile(folder, ruta).
 *
 * Para añadir un área: importar su fábrica y agregarla a la lista.
 */
import { createOrganizeTools } from './organizar.js';

export const TOOL_FACTORIES = Object.freeze([
  createOrganizeTools, // Función 03: organizar y papelera.
]);
