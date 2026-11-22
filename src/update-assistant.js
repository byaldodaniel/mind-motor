import fs from 'node:fs/promises';
import path from 'node:path';
import { productPaths } from './layout.js';
import { readManifestFile } from './product-files.js';
import { releaseOf, compareReleases } from './package-descriptor.js';
import { readUpdateState } from './update-state.js';
import { BASE_MARKER } from './base-format.js';
import { writeJsonAtomic } from './connector.js';
import { MotorError } from './errors.js';

/**
 * Actualización asistida: lo que el agente cuenta al usuario y lo que el usuario
 * decide. Mind descubre una entrega; aquí se decide si avisar en esta conversación,
 * se describe la entrega cruzando lo que declara (firmado) con lo que hay en este
 * equipo, y se guarda «recuérdamelo después». Instalar exige la aprobación expresa
 * del usuario (otra pieza).
 */

const NOTICE_PHASES = new Set(['disponible', 'descargando', 'descargada']);
const NO_CONNECTION_REPEAT_MS = 12 * 60 * 60_000;
const NOTICE_MEMORY_MS = 30 * 24 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
export const POSTPONE_DAYS = Object.freeze([1, 3, 7]);
const SECURITY_MAX_DAYS = 1;

const releaseKey = (release) => `${release.mindVersion}-r${release.packageRevision}`;

export function decisionsFile(layout) {
  return path.join(layout.installationStateDirectory ?? productPaths(layout.root, layout.manifest).installationStateDirectory, 'actualizacion-decisiones.json');
}

async function readDecisions(layout) {
  try {
    const value = JSON.parse(await fs.readFile(decisionsFile(layout), 'utf8'));
    if (value?.format === 'mind-actualizacion-decisiones' && value.version === 1) {
      return { pospuesta: value.pospuesta ?? null, avisadas: value.avisadas && typeof value.avisadas === 'object' ? value.avisadas : {} };
    }
  } catch {}
  // Un archivo ausente o dañado no impide trabajar: como mucho se repite un aviso.
  return { pospuesta: null, avisadas: {} };
}

// El Motor es un solo proceso: una cadena basta para no pisar escrituras propias.
let chain = Promise.resolve();
function withDecisions(layout, change) {
  const run = chain.then(async () => {
    const decisions = await readDecisions(layout);
    const result = await change(decisions);
    await fs.mkdir(path.dirname(decisionsFile(layout)), { recursive: true });
    await writeJsonAtomic(decisionsFile(layout), { format: 'mind-actualizacion-decisiones', version: 1, ...decisions });
    return result;
  });
  chain = run.catch(() => {});
  return run;
}

/** Entrega disponible y más nueva que la instalada, o null. Nunca lanza. */
async function availableRelease(layout, getOffer) {
  if (!layout?.product || !layout.root) return null;
  let state, installed;
  try {
    state = await readUpdateState(layout.root);
    installed = layout.manifest ?? await readManifestFile(layout.root);
  } catch { return null; }
  if (!state || !NOTICE_PHASES.has(state.phase) || !state.release || !installed) return null;
  try { if (compareReleases(state.release, installed) <= 0) return null; } catch { return null; }
  if (getOffer) {
    try {
      const { feed, selected } = await getOffer();
      return { state: { ...state, package: selected }, installed, release: releaseOf(feed), novedades: feed.novedades ?? null };
    } catch { return null; }
  }
  return { state, installed, release: releaseOf(state.release), novedades: state.novedades ?? null };
}

export function noticeText(release, novedades) {
  const name = typeof novedades?.nombre === 'string' && novedades.nombre.trim() ? ` (${novedades.nombre.trim()})` : '';
  return `Hay una nueva versión de Mind (${release.mindVersion})${name}`;
}

/**
 * Aviso para la primera consulta de una conversación. Una vez por conversación y
 * entrega; sin identificador de conversación (consola, agentes sin puente), como
 * mucho cada 12 h. «Recuérdamelo después» lo calla en todas hasta la fecha elegida.
 * Devuelve null si no corresponde avisar. Nunca lanza: un fallo aquí no puede
 * estropear la respuesta normal al usuario.
 */
export async function takeNotice({ layout, conexion = null, now = Date.now, getOffer } = {}) {
  try {
    const found = await availableRelease(layout, getOffer);
    if (!found) return null;
    const key = releaseKey(found.release);
    return await withDecisions(layout, (decisions) => {
      const at = now();
      for (const [id, entry] of Object.entries(decisions.avisadas)) if (!(at - Date.parse(entry?.at) < NOTICE_MEMORY_MS)) delete decisions.avisadas[id];
      const postponed = decisions.pospuesta;
      if (postponed?.entrega === key && Date.parse(postponed.hasta) > at) return null;
      const slot = conexion ?? 'sin-conexion';
      const previous = decisions.avisadas[slot];
      if (previous?.entrega === key && (conexion || at - Date.parse(previous.at) < NO_CONNECTION_REPEAT_MS)) return null;
      decisions.avisadas[slot] = { entrega: key, at: new Date(at).toISOString() };
      const novedades = found.novedades;
      return {
        texto: noticeText(found.release, novedades),
        version: found.release.mindVersion,
        revision: found.release.packageRevision,
        nombre: novedades?.nombre ?? null,
        importancia: novedades?.importancia ?? 'normal',
        indicacion: 'Responde primero a lo que pidió el usuario. Al final añade este aviso en una línea, tal cual, y ofrece en pocas palabras contar qué cambia, recordárselo después o aplicarla. No la apliques ni la descargues sin que el usuario lo pida expresamente.',
      };
    });
  } catch {
    return null;
  }
}

async function baseFormat(baseDirectory) {
  try {
    const marker = JSON.parse(await fs.readFile(path.join(baseDirectory, BASE_MARKER), 'utf8'));
    return Number.isSafeInteger(marker?.data?.version ?? marker?.version) ? (marker.data?.version ?? marker.version) : null;
  } catch { return null; }
}

/** Para `actualizacion_consultar`: lo declarado por la entrega frente a lo comprobado aquí. */
export async function describeUpdate({ layout, statfs = fs.statfs, now = Date.now, getOffer } = {}) {
  if (!layout?.product || !layout.root) {
    return { estado: 'no-aplica', motivo: 'Esta copia de Mind no es una instalación (desarrollo); no recibe actualizaciones.' };
  }
  const installed = layout.manifest ?? await readManifestFile(layout.root);
  const state = await readUpdateState(layout.root).catch((error) => ({ phase: 'estado-no-verificable', lastError: { code: error.code ?? 'UPDATE_STATE_INVALID' } }));
  const decisions = await readDecisions(layout);
  const result = {
    instalada: releaseOf(installed),
    fase: state?.phase ?? 'sin-comprobar',
    ultima_comprobacion: state?.lastCheckedAt ?? null,
    ultimo_error: state?.lastError ? { codigo: state.lastError.code ?? null, tipo: state.lastError.kind ?? null, mensaje: state.lastError.message ?? null } : null,
    disponible: null,
  };
  result.aplicacion = await (await import('./update-handoff.js')).describeHandoff(layout);
  const found = await availableRelease(layout, getOffer);
  if (!found) {
    result.resumen = state?.phase === 'al-dia' ? 'Mind está al día.' : 'No hay una entrega nueva disponible ahora.';
    return result;
  }
  const n = found.novedades;
  const checked = n?.comprobado ?? {};
  const key = releaseKey(found.release);
  result.disponible = {
    ...found.release,
    aviso: noticeText(found.release, n),
    nombre: n?.nombre ?? null, resumen: n?.resumen ?? null, cambios: n?.cambios ?? [], importancia: n?.importancia ?? 'normal',
    impacto_declarado: n?.impacto_datos ?? null,
    firma: 'Ed25519 verificada al descubrirla; se vuelve a verificar con el paquete antes de instalar.',
  };
  // Cruce con este equipo: formato de la Base y espacio.
  const current = await baseFormat(layout.baseDirectory);
  const incoming = Number.isSafeInteger(checked.baseFormatVersion) ? checked.baseFormatVersion : null;
  const base = {
    formato_actual: current, formato_entrega: incoming,
    efecto: current === null || incoming === null ? 'desconocido' : incoming === current ? 'sin-cambios' : incoming > current ? 'migracion' : 'incompatible',
    ubicacion: layout.baseDirectory,
  };
  const needed = (Number(checked.paqueteBytes) || 0) + (Number(checked.programaBytes) || 0) + 64 * 1024 * 1024;
  let free = null;
  try { const disk = await statfs(layout.root); free = Number(disk.bavail) * Number(disk.bsize); } catch {}
  result.comprobado_en_este_equipo = {
    base,
    espacio: { libre_bytes: free, necesario_bytes: checked.paqueteBytes ? needed : null, suficiente: free === null || !checked.paqueteBytes ? null : free >= needed },
    descarga_bytes: checked.paqueteBytes ?? found.state.package?.bytes ?? null,
    grupos_que_cambian: checked.gruposCambiados ?? null,
    se_conservan: ['Base', 'Conversaciones', 'carpetas autorizadas y sus permisos', 'destinos', 'funciones', 'conexiones de los agentes'],
  };
  const postponed = decisions.pospuesta?.entrega === key && Date.parse(decisions.pospuesta.hasta) > now() ? decisions.pospuesta.hasta : null;
  result.pospuesta_hasta = postponed;
  result.resumen = `${noticeText(found.release, n)}. ${n?.resumen ?? ''}`.trim();
  result.indicacion = 'Explica la entrega con estos datos; distingue lo declarado por la entrega de lo comprobado en este equipo. Solo el usuario decide aplicarla o posponerla.';
  return result;
}

/** «Recuérdamelo después»: calla el aviso de esta entrega en todas las conversaciones hasta la fecha. */
export async function postponeUpdate({ layout, dias = 1, now = Date.now, getOffer } = {}) {
  const found = await availableRelease(layout, getOffer);
  if (!found) throw new MotorError('UPDATE_NOT_AVAILABLE', 'No hay una entrega nueva que posponer.');
  if (!POSTPONE_DAYS.includes(dias)) throw new MotorError('INVALID_ARGUMENTS', `dias debe ser ${POSTPONE_DAYS.join(', ')}.`);
  const security = found.novedades?.importancia === 'seguridad';
  const effective = security ? Math.min(dias, SECURITY_MAX_DAYS) : dias;
  const hasta = new Date(now() + effective * DAY_MS).toISOString();
  await withDecisions(layout, (decisions) => {
    decisions.pospuesta = { entrega: releaseKey(found.release), hasta, decidido: new Date(now()).toISOString() };
    // Al vencer, cada conversación vuelve a recibir el aviso una vez.
    decisions.avisadas = {};
  });
  return {
    estado: 'pospuesta', version: found.release.mindVersion, hasta,
    ...(security && effective < dias ? { nota: 'Es una entrega de seguridad: Mind la vuelve a recordar en un día como máximo.' } : {}),
    indicacion: 'Confirma al usuario hasta cuándo no se le volverá a avisar. Puede aplicarla antes si lo pide.',
  };
}
