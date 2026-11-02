import path from 'node:path';
import { MotorError } from '../errors.js';
import { formatContinuityMarkdown } from '../continuity.js';
import { untrustedText } from '../consent.js';
import {
  expectParameters, folderIdList, integerValue, existingMode, destinationValue, checkTemplate,
  definitionError, validHostInput, requireFolderAccess, requireContinuityAccess, writeOutput, writeLevels,
  templateVariables, renderTemplate, renderPath, markdownText, localStamp, humanSize, TEMPLATE_VARIABLES,
} from './common.js';

/**
 * Ejecutores nativos de Mind sobre capacidades existentes del Motor. Cada uno:
 * - valida su definición (acceptsDefinition) y la entrada del anfitrión;
 * - comprueba en el momento de ejecutar los permisos que el usuario dio por
 *   carpeta (session.policy), también en ejecuciones automáticas;
 * - escribe en originales solo con permisos de un solo intento del Motor
 *   (grantTextCreate / grantTextModify), nunca por rutas directas;
 * - devuelve un resumen sin contenido (rutas, tamaños y recuentos).
 *
 * Metadatos adicionales (no forman parte del contrato de function-runner): etiqueta,
 * descripcion, parametros, validarDefinicion, requisitos y describir. Los usa el
 * anfitrión para validar con mensajes claros y para el consentimiento del usuario.
 */

const DAY_MS = 86_400_000;

function destinationRequirement(destination, mode, use) {
  return { id: destination.carpeta, permisos: writeLevels(mode), uso: `${use} «${untrustedText(destination.ruta, 200)}»${mode === 'reemplazar' ? ' (si existe, lo reemplaza)' : ' (nunca sobrescribe)'}` };
}

/** Une los requisitos de varias carpetas cuando una aparece dos veces (por ejemplo, origen y destino). */
function mergeRequirements(items) {
  const byId = new Map();
  for (const item of items) {
    const known = byId.get(item.id);
    if (!known) byId.set(item.id, { ...item, permisos: [...item.permisos] });
    else {
      known.permisos = [...new Set([...known.permisos, ...item.permisos])];
      known.uso = `${known.uso}; ${item.uso}`;
    }
  }
  return [...byId.values()];
}

/** Garantiza que validateInput/acceptsDefinition solo devuelven true o lanzan. */
function accepts(validate) {
  return (definition) => {
    validate(definition);
    return true;
  };
}

function relativeTime(entry) {
  const times = [entry.modifiedAt, entry.createdAt].map((value) => (value ? Date.parse(value) : Number.NaN)).filter(Number.isFinite);
  return times.length === 0 ? null : Math.max(...times);
}

function renderReport({ sections, at, since, days, limit }) {
  const lines = [
    '# Informe de cambios',
    '',
    `Generado por Mind el ${localStamp(at)} (hora local). Periodo: últimos ${days} día${days === 1 ? '' : 's'}, desde ${localStamp(since)}.`,
    'Solo metadatos del índice (nombres, rutas, fechas y tamaños); Mind no copia el contenido.',
    '',
  ];
  for (const { folder, changed, removed } of sections) {
    lines.push(`## ${markdownText(path.basename(folder.path))}`, '', `Carpeta: ${markdownText(folder.path)}`, '');
    lines.push(`### Nuevos o modificados (${changed.length})`, '');
    if (changed.length === 0) lines.push('Sin cambios en el periodo.');
    for (const entry of changed.slice(0, limit)) {
      lines.push(`- ${markdownText(entry.path)} — ${localStamp(relativeTime(entry))}${Number.isSafeInteger(entry.size) ? ` · ${humanSize(entry.size)}` : ''}`);
    }
    if (changed.length > limit) lines.push(`- … y ${changed.length - limit} más`);
    lines.push('', `### Eliminados (${removed.length})`, '');
    if (removed.length === 0) lines.push('Nada eliminado en el periodo.');
    for (const entry of removed.slice(0, limit)) {
      lines.push(`- ${markdownText(entry.path)} — detectado ${localStamp(Date.parse(entry.removedAt))}${entry.by && entry.by !== 'externo' ? ` (por ${markdownText(entry.by)})` : ''}`);
    }
    if (removed.length > limit) lines.push(`- … y ${removed.length - limit} más`);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

/** @param {object} session Sesión del anfitrión (src/session.js). */
export function createNativeExecutors(session) {
  const { motor } = session;

  // ------------------------------------------------------------------ indexar
  const indexDefinition = (definition) => {
    const parameters = expectParameters(definition, 'indexar', ['carpetas'], ['carpetas']);
    folderIdList(parameters.carpetas, 'parametros.carpetas', 32);
    return parameters;
  };

  // ---------------------------------------------------- exportar-continuidad
  const exportDefinition = (definition) => {
    const parameters = expectParameters(definition, 'exportar-continuidad',
      ['destino', 'formato', 'tipo', 'relacionados', 'si_existe'], ['destino']);
    destinationValue(parameters.destino, 'parametros.destino');
    if (parameters.formato !== undefined && !['json', 'markdown'].includes(parameters.formato)) {
      throw definitionError('parametros.formato debe ser json o markdown.');
    }
    if (parameters.tipo !== undefined && (typeof parameters.tipo !== 'string' || parameters.tipo === '' || parameters.tipo.length > 200)) {
      throw definitionError('parametros.tipo debe ser texto de 1 a 200 caracteres.');
    }
    if (parameters.relacionados !== undefined && typeof parameters.relacionados !== 'boolean') {
      throw definitionError('parametros.relacionados debe ser booleano.');
    }
    existingMode(parameters.si_existe);
    return parameters;
  };

  // --------------------------------------------------------- informe-cambios
  const reportDefinition = (definition) => {
    const parameters = expectParameters(definition, 'informe-cambios',
      ['carpetas', 'destino', 'dias', 'maximo', 'si_existe'], ['carpetas', 'destino']);
    folderIdList(parameters.carpetas, 'parametros.carpetas', 16);
    destinationValue(parameters.destino, 'parametros.destino');
    integerValue(parameters.dias, 'parametros.dias', { min: 1, max: 90, fallback: 7 });
    integerValue(parameters.maximo, 'parametros.maximo', { min: 1, max: 5000, fallback: 500 });
    existingMode(parameters.si_existe);
    return parameters;
  };

  // --------------------------------------------------------- plantilla-texto
  const templateDefinition = (definition) => {
    const parameters = expectParameters(definition, 'plantilla-texto', ['destino', 'plantilla', 'si_existe'], ['destino', 'plantilla']);
    destinationValue(parameters.destino, 'parametros.destino');
    checkTemplate(parameters.plantilla, 'parametros.plantilla');
    existingMode(parameters.si_existe);
    return parameters;
  };

  return {
    indexar: {
      etiqueta: 'Reconciliar el índice de carpetas',
      descripcion: 'Actualiza el índice de metadatos de las carpetas indicadas con lo que cambió en el disco. No abre el contenido de los archivos.',
      parametros: { carpetas: 'lista de ids de carpetas (permiso "encontrar" en cada una)' },
      timeoutMs: 60_000,
      validarDefinicion: indexDefinition,
      acceptsDefinition: accepts(indexDefinition),
      requisitos: (definition) => ({
        carpetas: definition.parametros.carpetas.map((id) => ({ id, permisos: ['encontrar'], uso: 'reconcilia su índice (solo metadatos)' })),
        continuidad: [],
      }),
      validateInput: validHostInput,
      async run({ definition }) {
        const results = [];
        let failure = null;
        for (const id of definition.parametros.carpetas) {
          try {
            await requireFolderAccess(session, id, ['encontrar']);
            const previous = await motor.readFolderIndex(id).catch(() => null);
            const indexed = await motor.indexFolder(id);
            const removed = indexed.changes?.removed ?? [];
            // Mantiene el rastro de eliminados como la reconciliación de la sesión.
            if (removed.length > 0 && previous) {
              await session.removals.record(id, removed, new Map(previous.entries.map((entry) => [entry.path, entry])));
            }
            results.push({
              carpeta: id, estado: 'reconciliada', modo: indexed.mode === 'initial' ? 'inicial' : 'reconciliacion',
              entradas: indexed.totals.entries, agregados: indexed.changes?.added.length ?? null,
              modificados: indexed.changes?.modified.length ?? null, eliminados: indexed.changes?.removed.length ?? null,
            });
          } catch (error) {
            failure ??= error;
            results.push({ carpeta: id, estado: 'fallida', codigo: error?.code ?? 'INDEX_FAILED' });
          }
        }
        if (results.every((item) => item.estado === 'fallida')) throw failure;
        return { carpetas: results, archivos: [] };
      },
    },

    'exportar-continuidad': {
      etiqueta: 'Exportar la continuidad a un archivo',
      descripcion: 'Escribe los registros de continuidad (decisiones, resultados, contexto) en un paquete JSON o Markdown dentro de una carpeta autorizada.',
      parametros: {
        destino: '{ carpeta: id, ruta: "Continuidad/{fecha}.md" } (permiso "escribir")',
        formato: '"markdown" (por defecto) o "json" (paquete mind-continuity-export, reimportable)',
        tipo: 'opcional: solo registros de ese tipo',
        relacionados: 'opcional: incluir también los registros referenciados',
        si_existe: '"error" (por defecto, nunca sobrescribe) o "reemplazar" (requiere además "leer")',
      },
      timeoutMs: 60_000,
      validarDefinicion: exportDefinition,
      acceptsDefinition: accepts(exportDefinition),
      requisitos: (definition) => {
        const parameters = definition.parametros;
        const mode = existingMode(parameters.si_existe);
        return {
          carpetas: [destinationRequirement(parameters.destino, mode, 'escribe el paquete')],
          continuidad: ['leer'],
        };
      },
      validateInput: validHostInput,
      async run({ input, definition }) {
        const parameters = definition.parametros;
        const mode = existingMode(parameters.si_existe);
        await requireContinuityAccess(session, ['leer']);
        await requireFolderAccess(session, parameters.destino.carpeta, writeLevels(mode));
        let ids = await motor.listContinuityIds();
        if (parameters.tipo !== undefined) {
          const selected = [];
          for (const id of ids) {
            const entry = await motor.getContinuity(id).catch(() => null);
            if (entry?.kind === parameters.tipo) selected.push(id);
          }
          ids = selected;
        }
        if (ids.length === 0) return { registros: 0, faltantes: 0, archivos: [] };
        if (ids.length > 1000) throw new MotorError('CONTINUITY_TOO_LARGE', 'Hay más de 1000 registros: filtra por tipo.');
        const pack = await motor.exportContinuity({ ids, includeReferenced: parameters.relacionados === true });
        const content = parameters.formato === 'json' ? `${JSON.stringify(pack, null, 2)}\n` : formatContinuityMarkdown(pack);
        const written = await writeOutput(session, {
          folderId: parameters.destino.carpeta, relativePath: renderPath(parameters.destino.ruta, templateVariables(input)),
          content, mode, context: input,
        });
        return { registros: pack.entries.length, faltantes: pack.missing.length, archivos: [written] };
      },
    },

    'informe-cambios': {
      etiqueta: 'Informe de cambios recientes',
      descripcion: 'Escribe un resumen Markdown de lo nuevo, modificado y eliminado recientemente en las carpetas indicadas, a partir del índice y del rastro de eliminados. Solo metadatos.',
      parametros: {
        carpetas: 'lista de ids de carpetas a resumir (permiso "encontrar")',
        destino: '{ carpeta: id, ruta: "Informes/cambios-{fecha}.md" } (permiso "escribir")',
        dias: 'periodo en días, de 1 a 90 (7 por defecto)',
        maximo: 'máximo de archivos por sección, de 1 a 5000 (500 por defecto)',
        si_existe: '"error" (por defecto) o "reemplazar" (requiere además "leer")',
      },
      timeoutMs: 60_000,
      validarDefinicion: reportDefinition,
      acceptsDefinition: accepts(reportDefinition),
      requisitos: (definition) => {
        const parameters = definition.parametros;
        const mode = existingMode(parameters.si_existe);
        return {
          carpetas: mergeRequirements([
            ...parameters.carpetas.map((id) => ({ id, permisos: ['encontrar'], uso: 'resume sus cambios (solo metadatos)' })),
            destinationRequirement(parameters.destino, mode, 'escribe el informe'),
          ]),
          continuidad: [],
        };
      },
      validateInput: validHostInput,
      async run({ input, definition }) {
        const parameters = definition.parametros;
        const mode = existingMode(parameters.si_existe);
        const days = parameters.dias ?? 7;
        const limit = parameters.maximo ?? 500;
        const at = Date.parse(input.fecha);
        const since = at - days * DAY_MS;
        const relativePath = renderPath(parameters.destino.ruta, templateVariables(input));
        await requireFolderAccess(session, parameters.destino.carpeta, writeLevels(mode));
        const sections = [];
        let changedTotal = 0;
        let removedTotal = 0;
        for (const id of parameters.carpetas) {
          const folder = await requireFolderAccess(session, id, ['encontrar']);
          // Índice coherente: sin observación, reconcilia ahora (como "eliminados").
          await session.ensureIndex(id, { timeoutMs: 30_000 });
          await session.settled(id);
          const index = await motor.readFolderIndex(id);
          const entries = index?.entries ?? [];
          const existing = new Set(entries.map((entry) => entry.path));
          const changed = entries
            .filter((entry) => entry.type === 'file' && (relativeTime(entry) ?? -Infinity) >= since
              && !(id === parameters.destino.carpeta && entry.path === relativePath))
            .sort((a, b) => relativeTime(b) - relativeTime(a) || (a.path < b.path ? -1 : 1));
          const removed = await session.removals.list(id, { since, existing });
          changedTotal += changed.length;
          removedTotal += removed.length;
          sections.push({ folder, changed, removed });
        }
        const written = await writeOutput(session, {
          folderId: parameters.destino.carpeta, relativePath,
          content: renderReport({ sections, at, since, days, limit }), mode, context: input,
        });
        return { carpetas: sections.length, modificados: changedTotal, eliminados: removedTotal, archivos: [written] };
      },
    },

    'plantilla-texto': {
      etiqueta: 'Crear un texto a partir de una plantilla',
      descripcion: 'Crea un archivo de texto con una plantilla y variables simples. Nunca evalúa código.',
      parametros: {
        destino: '{ carpeta: id, ruta: "Diario/{fecha}.md" } (permiso "escribir")',
        plantilla: `texto con variables entre llaves: ${Object.keys(TEMPLATE_VARIABLES).map((name) => `{${name}}`).join(', ')}; {{ y }} para llaves literales`,
        si_existe: '"error" (por defecto, nunca sobrescribe) o "reemplazar" (requiere además "leer")',
      },
      timeoutMs: 30_000,
      validarDefinicion: templateDefinition,
      acceptsDefinition: accepts(templateDefinition),
      requisitos: (definition) => {
        const parameters = definition.parametros;
        return { carpetas: [destinationRequirement(parameters.destino, existingMode(parameters.si_existe), 'crea el archivo')], continuidad: [] };
      },
      describir: (definition) => [`Texto de la plantilla (indicado por el agente, no verificado): «${untrustedText(definition.parametros.plantilla, 240)}»`],
      validateInput: validHostInput,
      async run({ input, definition }) {
        const parameters = definition.parametros;
        const variables = templateVariables(input);
        const written = await writeOutput(session, {
          folderId: parameters.destino.carpeta, relativePath: renderPath(parameters.destino.ruta, variables),
          content: renderTemplate(parameters.plantilla, variables), mode: existingMode(parameters.si_existe), context: input,
        });
        return { archivos: [written] };
      },
    },
  };
}
