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
import { createConversationTransferTools } from './conversation-transfer.js';
import { createDestinationTools } from './destinos.js';
import { createConversationTools } from './conversaciones.js';
import { createOrganizeTools } from './organizar.js';
import { createPropertyTools } from './propiedades.js';
import { createIndexTools } from './indices.js';
import { createBackupTools } from './respaldo.js';
import { createFunctionTools } from './funciones.js';

export const TOOL_FACTORIES = Object.freeze([
  createDestinationTools,
  createConversationTransferTools,
  createConversationTools, // Conversaciones como elementos e índice de información importante.
  createOrganizeTools, // Función 03: organizar y papelera.
  createPropertyTools, // Función 02: propiedades.
  createIndexTools, // Función 01: índices personalizados en CSV.
  createBackupTools, // Respaldo cifrado (crear; configurar y restaurar son del usuario).
  createFunctionTools, // Función 04: funciones y automatizaciones.
]);
