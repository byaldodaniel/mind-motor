import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { MotorError } from './errors.js';
import { readJson, writeJson, removeJson } from './storage.js';
import { contains } from './paths.js';
import { ACCESS_LEVELS, CONTINUITY_LEVELS, ACCESS_PRESETS, PRESET_LABELS, minimumPreset, normalizeAccess, describeAccess } from './access-policy.js';

/**
 * Consentimiento del usuario para lo que los agentes pueden hacer mediante Mind.
 *
 * La autorización nunca se basa en lo que el agente afirme. Hay dos canales:
 *
 * 1. Formulario del cliente (elicitación MCP): Mind pide al programa cliente
 *    (por ejemplo, Claude Code) que muestre un formulario al usuario. La
 *    respuesta la produce la interfaz del cliente, no el modelo.
 * 2. Consola de Mind: si el cliente no admite formularios, la solicitud queda
 *    pendiente en la Base y el usuario la aprueba ejecutando `mind autorizar`
 *    en un terminal interactivo.
 *
 * Límite honesto: un agente con acceso libre a un terminal, ejecutándose con
 * los permisos del usuario, puede eludir cualquier mecanismo en ese mismo
 * usuario (incluida la Base). Mind no es un aislamiento del sistema operativo;
 * sus garantías cubren lo que los agentes hacen a través de Mind.
 */

const LABELS = Object.freeze({
  encontrar: 'Encontrar archivos por nombre, ruta, propiedades y fechas',
  leer: 'Leer el contenido de los archivos de texto',
  escribir: 'Crear archivos nuevos y modificar archivos de texto existentes',
  organizar: 'Crear carpetas y mover o renombrar archivos y carpetas (sin reemplazar ni borrar)',
});
const CONTINUITY_LABELS = Object.freeze({
  leer: 'Consultar decisiones, resultados y contexto registrados por otros agentes o sesiones',
  registrar: 'Registrar decisiones, resultados y contexto para continuar después',
});
const REQUEST_TTL_MS = 24 * 3_600_000;
const REQUEST_FILE = /^consent-request-([a-f0-9-]{36})\.json$/;

/** Texto proporcionado por el agente: se muestra entre comillas, en una línea y acotado. */
export function untrustedText(value, max = 300) {
  if (typeof value !== 'string') return '';
  const flat = value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu, ' ')
    .replace(/\s+/gu, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function clientName(clientInfo) {
  const name = untrustedText(clientInfo?.title ?? clientInfo?.name ?? '', 80);
  const version = untrustedText(clientInfo?.version ?? '', 32);
  return name ? `${name}${version ? ` ${version}` : ''}` : 'un agente sin identificar';
}

/**
 * Comprueba una carpeta candidata ANTES de pedir el consentimiento, sin
 * registrarla ni enumerar su contenido. Rechaza raíces del sistema, la carpeta
 * personal completa y cualquier ubicación que contenga o esté dentro de Mind.
 * @returns {Promise<string>} Ruta física.
 */
export async function validateCandidateFolder(folderPath, { protectedDirectories = [], baseDirectory, motorDirectory, userDataDirectory }) {
  if (typeof folderPath !== 'string' || folderPath.includes('\0') || !path.isAbsolute(folderPath)) {
    throw new MotorError('INVALID_FOLDER_PATH', 'Indica la ruta absoluta de una carpeta existente.');
  }
  let canonical;
  try {
    canonical = await fs.realpath(folderPath);
    if (!(await fs.stat(canonical)).isDirectory()) throw new MotorError('NOT_A_FOLDER', 'La ubicación debe ser una carpeta.');
  } catch (error) {
    if (error instanceof MotorError) throw error;
    throw new MotorError('FOLDER_UNAVAILABLE', 'La carpeta no existe o no es accesible.');
  }
  if (path.dirname(canonical) === canonical) {
    throw new MotorError('FOLDER_TOO_BROAD', 'No se puede autorizar la raíz de un disco. Elige una carpeta concreta.');
  }
  const home = await fs.realpath(os.homedir()).catch(() => os.homedir());
  if (path.relative(home, canonical) === '' || contains(canonical, home)) {
    throw new MotorError('FOLDER_TOO_BROAD', 'No se puede autorizar la carpeta personal completa ni una que la contenga. Elige una carpeta concreta.');
  }
  for (const internal of [baseDirectory,motorDirectory].filter(Boolean)) {
    if(contains(internal,canonical)||contains(canonical,internal))throw new MotorError('FOLDER_OVERLAPS_INTERNAL','Motor y Base permanecen protegidos.');
  }
  const userData=userDataDirectory ? await fs.realpath(userDataDirectory).catch(()=>null) : null;
  for (const internal of protectedDirectories.filter(Boolean)) {
    if(userData && contains(internal,userData) && contains(userData,canonical))continue;
    if (contains(internal, canonical) || contains(canonical, internal)) {
      throw new MotorError('FOLDER_OVERLAPS_INTERNAL', 'La carpeta no puede contener ni estar dentro de la carpeta de Mind.');
    }
  }
  return canonical;
}

/** Versión exacta de una función cuya activación automática se solicita. */
function validAutomation(value) {
  return value && typeof value === 'object' && typeof value.functionId === 'string'
    && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value.functionId)
    && typeof value.generation === 'string' && /^[a-f0-9-]{36}$/.test(value.generation)
    && typeof value.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(value.fingerprint);
}

/** Borrado: carpeta y ruta; vaciado: carpeta e id de la papelera. */
function validOperation(kind, operation) {
  return operation && typeof operation === 'object' && typeof operation.folderId === 'string' && /^[a-f0-9]{64}$/.test(operation.folderId)
    && (kind === 'borrado'
      ? typeof operation.relativePath === 'string' && operation.relativePath.length > 0 && operation.relativePath.length <= 4096
      : typeof operation.trashId === 'string' && /^\d{8}T\d{6}Z-[a-f0-9]{12}$/.test(operation.trashId));
}

/** Solicitudes pendientes de aprobación en la consola de Mind (canal 2). */
export function createConsentRequests(baseDirectory) {
  const filename = (id) => {
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new MotorError('INVALID_REQUEST_ID', 'Identificador de solicitud no válido.');
    return path.join(baseDirectory, `consent-request-${id}.json`);
  };

  function valid(data) {
    return data && data.format === 'mind-consent-request' && data.version === 1
      && ['carpeta', 'continuidad', 'automatizacion', 'borrado', 'vaciado'].includes(data.kind) && typeof data.createdAt === 'string'
      && typeof data.expiresAt === 'string' && Array.isArray(data.requested)
      && (data.kind !== 'carpeta' || (typeof data.path === 'string' && path.isAbsolute(data.path)))
      && (data.kind !== 'automatizacion' || validAutomation(data.automation))
      && (!['borrado', 'vaciado'].includes(data.kind) || validOperation(data.kind, data.operation));
  }

  return Object.freeze({
    async create({ kind, path: folderPath = null, requested, reason, client, automation = null, operation = null }) {
      const id = randomUUID();
      const now = Date.now();
      const record = {
        format: 'mind-consent-request', version: 1, id, kind, path: folderPath,
        requested, reason: untrustedText(reason), client: untrustedText(client, 120),
        createdAt: new Date(now).toISOString(), expiresAt: new Date(now + REQUEST_TTL_MS).toISOString(),
        // Automatización: solo la versión exacta solicitada; la consola recalcula la descripción.
        ...(kind === 'automatizacion' ? { automation: {
          functionId: automation?.functionId, generation: automation?.generation, fingerprint: automation?.fingerprint,
        } } : {}),
      };
      if (['borrado', 'vaciado'].includes(kind)) {
        record.operation = { folderId: operation?.folderId, relativePath: operation?.relativePath ?? null, trashId: operation?.trashId ?? null };
      }
      if ((kind === 'automatizacion' || ['borrado', 'vaciado'].includes(kind)) && !valid(record)) {
        throw new MotorError('INVALID_REQUEST', 'La solicitud no es válida.');
      }
      await writeJson(filename(id), record);
      return record;
    },

    async list() {
      const now = Date.now();
      const result = [];
      for (const entry of (await fs.readdir(baseDirectory)).sort()) {
        const match = REQUEST_FILE.exec(entry);
        if (!match) continue;
        const stored = await readJson(path.join(baseDirectory, entry)).catch(() => null);
        if (!stored || !valid(stored.data) || Date.parse(stored.data.expiresAt) < now) {
          // Caducada o ilegible: no se presenta al usuario.
          await removeJson(path.join(baseDirectory, entry)).catch(() => {});
          continue;
        }
        result.push(stored.data);
      }
      return result.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    },

    remove: (id) => removeJson(filename(id)),
  });
}

/**
 * @param {{ connection: object, requests: ReturnType<typeof createConsentRequests> }} options
 */
export function createConsent({ connection, requests }) {
  const form = () => connection?.supportsFormElicitation?.() === true;

  async function elicit(message, properties, required) {
    const params = {
      ...(connection.protocolVersion === '2025-11-25' ? { mode: 'form' } : {}),
      message,
      requestedSchema: { type: 'object', properties, required },
    };
    let response;
    try {
      response = await connection.request('elicitation/create', params);
    } catch (error) {
      if (error?.code === 'SESSION_CLOSED') throw error;
      throw new MotorError('CONSENT_UNAVAILABLE', 'El cliente no pudo mostrar el formulario de autorización al usuario.', { cause: error });
    }
    if (!response || typeof response !== 'object') {
      throw new MotorError('CONSENT_UNAVAILABLE', 'El cliente devolvió una respuesta de autorización no válida.');
    }
    return response;
  }

  return Object.freeze({
    channel: () => (form() ? 'formulario-del-cliente' : 'consola'),

    /**
     * @param {{ folderPath: string, requested: object, current?: object | null, reason?: string, clientInfo?: object }} request
     * @returns {Promise<{ status: 'approved', access: object, channel: string } | { status: 'declined' | 'cancelled' } | { status: 'pending', request: object }>}
     */
    async askFolder({ folderPath, requested, current = null, reason, clientInfo }) {
      const wanted = normalizeAccess(requested);
      wanted.encontrar = true; // Autorizar una carpeta implica indexarla para encontrar.
      const already = current ?? {};
      const asked = ACCESS_LEVELS.filter((level) => wanted[level] && !already[level]);
      const who = clientName(clientInfo);
      const why = untrustedText(reason);
      if (!form()) {
        const record = await requests.create({
          kind: 'carpeta', path: folderPath, requested: describeAccess(wanted), reason, client: who,
        });
        return { status: 'pending', request: record };
      }
      const suggested = minimumPreset(wanted);
      const lines = [
        `${who} solicita, mediante Mind, acceso a esta carpeta y a todo lo que contiene:`,
        folderPath,
        '',
        `Acceso solicitado: ${PRESET_LABELS[suggested]}.`,
        ...(why ? [`Motivo indicado por el agente (no verificado): «${why}»`] : []),
        '',
        'Mind no copia los originales ni sigue enlaces que salgan de la carpeta. Puedes retirar el acceso cuando quieras. Autoriza solo si reconoces esta solicitud.',
      ];
      const presets = Object.keys(ACCESS_PRESETS);
      // 2025-11-25 usa oneOf con títulos; las versiones anteriores, enum con enumNames.
      const choice = connection.protocolVersion === '2025-11-25'
        ? { type: 'string', title: 'Acceso', oneOf: presets.map((name) => ({ const: name, title: PRESET_LABELS[name] })), default: suggested }
        : { type: 'string', title: 'Acceso', enum: presets, enumNames: presets.map((name) => PRESET_LABELS[name]), default: suggested };
      const exclude = {
        type: 'string', title: 'Excluir subcarpetas (opcional)',
        description: 'Rutas dentro de la carpeta, separadas por comas; por ejemplo: Privado, Finanzas/2025',
        default: '',
      };
      const response = await elicit(lines.join('\n'), { acceso: choice, excluir: exclude }, ['acceso']);
      if (response.action === 'decline') return { status: 'declined' };
      if (response.action !== 'accept') {
        // Cancelado: el usuario cerró el formulario o el cliente no pudo mostrarlo
        // (por ejemplo, en modo sin interfaz). Queda pendiente para la consola.
        const record = await requests.create({
          kind: 'carpeta', path: folderPath, requested: describeAccess(wanted), reason, client: who,
        });
        return { status: 'pending', request: record, cancelled: true };
      }
      const chosen = response.content?.acceso;
      if (typeof chosen !== 'string' || !Object.hasOwn(ACCESS_PRESETS, chosen)) return { status: 'declined' };
      // Lo ya concedido se conserva; reducir permisos se hace explícitamente al retirar.
      const access = normalizeAccess([...describeAccess(already), ...ACCESS_PRESETS[chosen]]);
      const excluded = typeof response.content?.excluir === 'string'
        ? response.content.excluir.split(',').map((item) => item.trim()).filter(Boolean) : [];
      return { status: 'approved', access, exclusions: excluded, channel: 'formulario-del-cliente' };
    },

    async askContinuity({ requested, current, reason, clientInfo }) {
      const wanted = normalizeAccess(requested, CONTINUITY_LEVELS);
      const asked = CONTINUITY_LEVELS.filter((level) => wanted[level] && !current?.[level]);
      const who = clientName(clientInfo);
      if (!form()) {
        const record = await requests.create({ kind: 'continuidad', requested: asked, reason, client: who });
        return { status: 'pending', request: record };
      }
      const why = untrustedText(reason);
      const message = [
        `${who} solicita acceso a la continuidad de Mind: los registros de decisiones, resultados y contexto que los agentes guardan en la Base para continuar trabajos entre sesiones y herramientas.`,
        ...(why ? [`Motivo indicado por el agente (no verificado): «${why}»`] : []),
      ].join('\n');
      const properties = {};
      for (const level of asked) properties[level] = { type: 'boolean', title: CONTINUITY_LABELS[level], default: true };
      const response = await elicit(message, properties, []);
      if (response.action === 'decline') return { status: 'declined' };
      if (response.action !== 'accept') {
        const record = await requests.create({ kind: 'continuidad', requested: asked, reason, client: who });
        return { status: 'pending', request: record, cancelled: true };
      }
      const access = { leer: current?.leer === true, registrar: current?.registrar === true };
      for (const level of asked) if (response.content?.[level] === true) access[level] = true;
      if (asked.every((level) => !access[level])) return { status: 'declined' };
      return { status: 'approved', access, channel: 'formulario-del-cliente' };
    },

    /**
     * Activación automática de una función. lines: descripción construida por
     * Mind (lo aportado por el agente ya va acotado y entre comillas). La
     * aprobación vale solo para la versión exacta indicada en automation.
     * @param {{ automation: { functionId: string, generation: string, fingerprint: string }, lines: string[], reason?: string, clientInfo?: object }} request
     */
    async askAutomation({ automation, lines, reason, clientInfo }) {
      const who = clientName(clientInfo);
      const pending = async (cancelled) => {
        const record = await requests.create({ kind: 'automatizacion', requested: ['activar'], reason, client: who, automation });
        return { status: 'pending', request: record, ...(cancelled ? { cancelled: true } : {}) };
      };
      if (!form()) return pending(false);
      const why = untrustedText(reason);
      const message = [
        `${who} solicita, mediante Mind, activar una automatización que se ejecutará sin que lo pidas cada vez:`,
        '',
        ...lines,
        ...(why ? ['', `Motivo indicado por el agente (no verificado): «${why}»`] : []),
        '',
        'Usará los permisos que ya concediste en cada carpeta. Si la definición cambia, esta autorización caduca. Puedes desactivarla cuando quieras. Autoriza solo si reconoces esta solicitud.',
      ].join('\n');
      const response = await elicit(message, {
        activar: { type: 'boolean', title: 'Activar esta automatización', default: false },
      }, ['activar']);
      if (response.action === 'decline') return { status: 'declined' };
      if (response.action !== 'accept') return pending(true);
      return response.content?.activar === true ? { status: 'approved', channel: 'formulario-del-cliente' } : { status: 'declined' };
    },

    /**
     * Confirmación de una operación sobre originales que el usuario aprueba cada
     * vez: borrado (a la papelera de Mind) o vaciado definitivo, que pide además
     * escribir una palabra. Sin formulario, o si el usuario lo cierra, queda
     * pendiente para la consola. lines los construye Mind con sus propios datos.
     * @param {{ kind: 'borrado' | 'vaciado', lines: string[], operation: object, reason?: string, clientInfo?: object, typed?: string | null }} request
     */
    async askOperation({ kind, lines, operation, reason, clientInfo, typed = null }) {
      const who = clientName(clientInfo);
      const pending = async (cancelled) => {
        const record = await requests.create({ kind, requested: [kind], reason, client: who, operation });
        return { status: 'pending', request: record, ...(cancelled ? { cancelled: true } : {}) };
      };
      if (!form()) return pending(false);
      const why = untrustedText(reason);
      const message = [
        `${who} solicita, mediante Mind:`, '', ...lines,
        ...(why ? ['', `Motivo indicado por el agente (no verificado): «${why}»`] : []),
        '', 'Confirma solo si reconoces esta solicitud.',
      ].join('\n');
      const first = await elicit(message, {
        confirmar: { type: 'boolean', title: kind === 'vaciado' ? 'Eliminar definitivamente' : 'Mover a la papelera de Mind', default: false },
      }, ['confirmar']);
      if (first.action === 'decline') return { status: 'declined' };
      if (first.action !== 'accept') return pending(true);
      if (first.content?.confirmar !== true) return { status: 'declined' };
      if (typed) {
        const second = await elicit(`Confirmación adicional: esto no se puede deshacer. Escribe ${typed} para continuar.`, {
          texto: { type: 'string', title: `Escribe ${typed}`, maxLength: 20 },
        }, ['texto']);
        if (second.action === 'decline') return { status: 'declined' };
        if (second.action !== 'accept') return pending(true);
        if (String(second.content?.texto ?? '').trim().toUpperCase() !== typed) return { status: 'declined' };
      }
      return { status: 'approved', channel: 'formulario-del-cliente' };
    },

    /** Confirmación puntual de una operación que el usuario debe aprobar expresamente. */
    async confirm({ message, title = 'Confirmar' }) {
      if (!form()) return { status: 'unavailable' };
      const response = await elicit(message, { confirmar: { type: 'boolean', title, default: false } }, ['confirmar']);
      return response.action === 'accept' && response.content?.confirmar === true ? { status: 'approved' } : { status: 'declined' };
    },
  });
}

export const ACCESS_LABELS = LABELS;
export const CONTINUITY_ACCESS_LABELS = CONTINUITY_LABELS;
