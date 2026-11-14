import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { baseIdOf, writeJsonAtomic } from './connector.js';

/**
 * Conexiones de los chats con Mind.
 *
 * Cada chat tiene un identificador de conexión estable mientras su cliente siga
 * abierto: lo genera el puente al arrancar y lo envía en cada `initialize`, así que
 * sobrevive al autoapagado y al reencendido del Motor. Un cliente que habla HTTP
 * directo no tiene puente: su conexión es la sesión MCP.
 *
 * Dos fuentes, porque el Motor puede estar apagado mientras los chats siguen abiertos:
 * - Presencia: cada puente deja un archivo con su PID fuera de la Base
 *   (`Sistema/Estado/conexiones`) y lo retira al cerrarse. Un archivo cuyo PID ya no
 *   existe es de un puente que murió sin despedirse y se descarta.
 * - Registro del Motor: qué conexiones tienen sesión, si están trabajando, si esperan
 *   al usuario en un formulario y cuándo hicieron su última petición real.
 */

export const CONNECTION_ID = /^[a-f0-9-]{36}$/u;
const CLIENT_TEXT = /^[\p{L}\p{N} ._\-()/+]{1,80}$/u;
export const QUIET_MS = 30_000;

export function newConnectionId() {
  return randomUUID();
}

/** Texto de cliente seguro para mostrar (nombre y versión que declara el propio cliente). */
export function clientLabel(clientInfo) {
  const name = typeof clientInfo?.name === 'string' && CLIENT_TEXT.test(clientInfo.name) ? clientInfo.name : null;
  const version = typeof clientInfo?.version === 'string' && CLIENT_TEXT.test(clientInfo.version) ? clientInfo.version : null;
  return { nombre: name, version };
}

export function connectionsDirectory(layout) {
  if (layout?.product && layout.installationStateDirectory) return path.join(layout.installationStateDirectory, 'conexiones');
  return path.join(os.tmpdir(), `mind-conexiones-${baseIdOf(layout.baseDirectory)}`);
}

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}

/**
 * Presencia de un puente. Nunca falla: si no se puede escribir, el puente funciona
 * igual y solo deja de verse con el Motor apagado.
 */
export async function announcePresence({ layout, id, cwd = null, pid = process.pid, now = () => new Date() }) {
  const directory = connectionsDirectory(layout);
  const file = path.join(directory, `conexion-${id}.json`);
  const record = { format: 'mind-conexion', version: 1, id, pid, host: os.hostname(), desde: now().toISOString(), carpeta: cwd, cliente: null };
  const write = async () => {
    try {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await writeJsonAtomic(file, record);
    } catch {}
  };
  await write();
  return {
    file,
    async update(patch) { Object.assign(record, patch); await write(); },
    async remove() { await fs.rm(file, { force: true }).catch(() => {}); },
  };
}

/** Puentes abiertos según su presencia. Retira los de puentes que ya no existen. */
export async function listPresence(layout, { prune = true } = {}) {
  const directory = connectionsDirectory(layout);
  let names;
  try { names = await fs.readdir(directory); }
  catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
  const found = [];
  for (const name of names) {
    const match = /^conexion-([a-f0-9-]{36})\.json$/u.exec(name);
    if (!match) continue;
    const file = path.join(directory, name);
    let record;
    try {
      const info = await fs.lstat(file);
      if (!info.isFile()) continue;
      record = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch { continue; }
    if (record?.format !== 'mind-conexion' || record.id !== match[1] || !Number.isSafeInteger(record.pid)) continue;
    if (record.host === os.hostname() && !alive(record.pid)) {
      if (prune) await fs.rm(file, { force: true }).catch(() => {});
      continue;
    }
    found.push(record);
  }
  return found;
}

/**
 * Registro del Motor. Una entrada por sesión MCP; varias sesiones del mismo puente
 * (tras un reinicio del Motor) comparten identificador de conexión.
 */
export function createConnectionRegistry({ now = Date.now } = {}) {
  const sessions = new Map();

  return {
    open(sessionId, { conexion = null, transporte, carpeta = null }) {
      sessions.set(sessionId, {
        sesion: sessionId, conexion: CONNECTION_ID.test(conexion ?? '') ? conexion : null, transporte, carpeta,
        cliente: { nombre: null, version: null }, raices: null, desde: now(), ultimaPeticion: null, enCurso: 0, formularios: 0,
      });
    },
    identify(sessionId, clientInfo, capabilities = null) {
      const entry = sessions.get(sessionId);
      if (!entry) return;
      entry.cliente = clientLabel(clientInfo);
      // Si el cliente anuncia sus raíces, Mind puede conocer la carpeta del chat sin
      // puente (requisito para conectar ese cliente por HTTP directo).
      entry.raices = capabilities && typeof capabilities === 'object' ? Boolean(capabilities.roots) : null;
    },
    /** Una petición real (no `ping`). Devuelve la función que la cierra. */
    begin(sessionId) {
      const entry = sessions.get(sessionId);
      if (!entry) return () => {};
      entry.enCurso += 1;
      entry.ultimaPeticion = now();
      let done = false;
      return () => {
        if (done) return;
        done = true;
        entry.enCurso = Math.max(0, entry.enCurso - 1);
        entry.ultimaPeticion = now();
      };
    },
    /** Un formulario que espera respuesta del usuario en ese chat. */
    asking(sessionId) {
      const entry = sessions.get(sessionId);
      if (!entry) return () => {};
      entry.formularios += 1;
      let done = false;
      return () => { if (!done) { done = true; entry.formularios = Math.max(0, entry.formularios - 1); } };
    },
    close(sessionId) {
      sessions.delete(sessionId);
    },
    /**
     * Estado de cada conexión, agrupando las sesiones del mismo puente. `asking` es la
     * sesión que pregunta: su propia petición en curso no cuenta como trabajo.
     */
    list({ asking = null } = {}) {
      const byConnection = new Map();
      for (const original of sessions.values()) {
        const entry = original.sesion === asking ? { ...original, enCurso: Math.max(0, original.enCurso - 1) } : original;
        const key = entry.conexion ?? `sesion:${entry.sesion}`;
        const current = byConnection.get(key);
        if (!current) { byConnection.set(key, { ...entry }); continue; }
        current.enCurso += entry.enCurso;
        current.formularios += entry.formularios;
        current.ultimaPeticion = Math.max(current.ultimaPeticion ?? 0, entry.ultimaPeticion ?? 0) || null;
        current.desde = Math.min(current.desde, entry.desde);
        if (!current.cliente.nombre) current.cliente = entry.cliente;
      }
      return [...byConnection.values()];
    },
  };
}

/** Qué hace cada conexión, en palabras. */
export function describeActivity(entry, { at = Date.now(), quietMs = QUIET_MS } = {}) {
  if (entry.formularios > 0) return 'esperando-al-usuario';
  if (entry.enCurso > 0) return 'trabajando';
  if (entry.ultimaPeticion && at - entry.ultimaPeticion < quietMs) return 'activa';
  return 'inactiva';
}

/**
 * Regla de quietud para sustituir el programa: nadie trabajando, ningún formulario
 * esperando al usuario y ninguna petición real en los últimos `quietMs`. Si no se
 * cumple, dice qué chat la impide; quien actualiza espera, nunca fuerza.
 */
export function quietness(entries, { at = Date.now(), quietMs = QUIET_MS, activeWork = 0 } = {}) {
  const blocking = [];
  for (const entry of entries) {
    const activity = describeActivity(entry, { at, quietMs });
    if (activity !== 'inactiva') blocking.push({ conexion: entry.conexion, cliente: entry.cliente, carpeta: entry.carpeta, actividad: activity,
      ...(activity === 'activa' ? { libre_en_ms: quietMs - (at - entry.ultimaPeticion) } : {}) });
  }
  if (activeWork > 0 && blocking.length === 0) blocking.push({ conexion: null, cliente: { nombre: 'consola o agente sin MCP', version: null }, carpeta: null, actividad: 'trabajando' });
  return { quieto: blocking.length === 0, impiden: blocking };
}

/** Une presencia de puentes y registro del Motor en una lista para `estado`. */
export function connectionSummary(entries, presence, { at = Date.now(), quietMs = QUIET_MS } = {}) {
  const seen = new Set();
  const list = entries.map((entry) => {
    if (entry.conexion) seen.add(entry.conexion);
    return {
      conexion: entry.conexion, cliente: entry.cliente, transporte: entry.transporte, carpeta: entry.carpeta,
      anuncia_raices: entry.raices ?? null,
      actividad: describeActivity(entry, { at, quietMs }),
      desde: new Date(entry.desde).toISOString(),
      ultima_peticion: entry.ultimaPeticion ? new Date(entry.ultimaPeticion).toISOString() : null,
    };
  });
  for (const record of presence) {
    if (seen.has(record.id)) continue;
    list.push({ conexion: record.id, cliente: record.cliente ?? { nombre: null, version: null }, transporte: 'puente', carpeta: record.carpeta ?? null, anuncia_raices: null,
      actividad: 'sin-sesion', desde: record.desde ?? null, ultima_peticion: null });
  }
  return list;
}
