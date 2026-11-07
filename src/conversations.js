import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MotorError } from './errors.js';
import { withIndexLock } from './index-lock.js';
import { requestSignal } from './request-context.js';

export const CONVERSATION_INDEX = 'conversation-index.sqlite';
const FORMAT = 'mind-conversation';
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const FILENAME = /^continuity-([a-f0-9-]{36})\.json$/;
const fail = (code, message) => { throw new MotorError(code, message); };

function text(value, field, { max = 200, nullable = false } = {}) {
  if (nullable && (value === null || value === undefined)) return null;
  if (typeof value !== 'string' || !value.trim() || !value.isWellFormed()
      || value.includes('\0') || Buffer.byteLength(value, 'utf8') > max) {
    fail('INVALID_CONVERSATION', `El campo ${field} debe ser texto no vacío de hasta ${max} bytes.`);
  }
  return value;
}
function id(value) {
  if (typeof value !== 'string' || !ID.test(value)) fail('INVALID_CONVERSATION_ID', 'Identificador de conversación no válido.');
  return value;
}
const fold = value => value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
function content(input) {
  return {
    format: FORMAT, version: 1,
    title: text(input.title, 'title'),
    important: text(input.important, 'important', { max: 64 * 1024 }),
    project: text(input.project, 'project', { nullable: true }),
    agent: text(input.agent, 'agent', { nullable: true }),
    externalId: text(input.externalId, 'externalId', { nullable: true, max: 512 }),
  };
}
function asConversation(entry) {
  if (!entry || entry.kind !== 'conversacion' || entry.content?.format !== FORMAT) return null;
  if (entry.content.version !== 1) fail('CONVERSATION_UNSUPPORTED_VERSION', 'Formato de conversación no compatible.');
  // Valida también los registros importados o modificados por continuidad.
  const normalized = content(entry.content);
  return { id: entry.id, revision: entry.revision, createdAt: entry.createdAt,
    updatedAt: entry.updatedAt, ...normalized, references: entry.references };
}

/**
 * Conversaciones sobre la continuidad del mismo motor. Los JSON son la fuente;
 * SQLite es un índice derivado que se abre y cierra en cada búsqueda.
 * No lee originales ni historiales, no crea carpetas de trabajo ni procesos.
 */
export function createConversations({ baseDirectory, continuity }) {
  async function getConversation(value) {
    const entry = await continuity.getContinuity(id(value));
    const conversation = asConversation(entry);
    if (!conversation) fail('CONVERSATION_NOT_FOUND', 'No existe esa conversación en Mind.');
    return conversation;
  }

  async function saveConversation(input) {
    const allowed = ['id', 'expectedRevision', 'title', 'important', 'project', 'agent', 'externalId', 'references', 'source'];
    if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some(key => !allowed.includes(key))) fail('INVALID_CONVERSATION', 'Campos de conversación no válidos.');
    if (input.id === undefined) {
      if (input.expectedRevision !== undefined) fail('INVALID_CONVERSATION', 'Una conversación nueva no indica revisión previa.');
      const entry = await continuity.recordContinuity({
        kind: 'conversacion', content: content(input), source: input.source,
        references: input.references,
      });
      return asConversation(entry);
    }
    const before = await getConversation(input.id);
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
      fail('INVALID_CONVERSATION', 'Para actualizar indica la revisión leída.');
    }
    // La lectura-modificación del JSON se coordina en continuidad, incluyendo
    // las escrituras hechas por las herramientas genéricas de continuidad.
    const next = content(Object.fromEntries(['title', 'important', 'project', 'agent', 'externalId']
      .map(key => [key, Object.hasOwn(input, key) ? input[key] : before[key]])));
    const entry = await continuity.updateContinuity(input.id, {
      content: next, ...(input.references !== undefined ? { references: input.references } : {}),
    }, { expectedRevision: input.expectedRevision });
    return asConversation(entry);
  }

  async function openIndex() {
    const filename = path.join(baseDirectory, CONVERSATION_INDEX);
    // La Base es técnica y de confianza. Nunca abrir SQLite a través de un
    // enlace ni sobre un archivo enlazado físicamente a otro destino.
    try {
      const handle = await fs.open(filename, 'wx', 0o600);
      await handle.close();
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const info = await fs.lstat(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
      fail('CONVERSATION_INDEX_UNSAFE', 'El índice de conversaciones debe ser un archivo técnico regular sin enlaces.');
    }
    const db = new DatabaseSync(filename, { enableForeignKeyConstraints: true });
    try {
      const version = db.prepare('PRAGMA user_version').get().user_version;
      if (version !== 0 && version !== 1) fail('CONVERSATION_INDEX_VERSION', 'El índice requiere una versión de Mind compatible.');
      db.exec(`CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL);
        CREATE VIRTUAL TABLE IF NOT EXISTS conversations USING fts5(
          id UNINDEXED, revision UNINDEXED, updated UNINDEXED,
          title, important, project, agent, project_key UNINDEXED,
          tokenize='unicode61 remove_diacritics 2');
        PRAGMA user_version=1;`);
      return db;
    } catch (error) { db.close(); throw error; }
  }

  async function searchConversations({ query = '', project, limit = 20 } = {}) {
    if (typeof query !== 'string' || query.length > 256 || !query.isWellFormed()
        || query.includes('\0') || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
      fail('INVALID_CONVERSATION_QUERY', 'Consulta de hasta 256 caracteres y límite de 1 a 50.');
    }
    if (project !== undefined) text(project, 'project');
    const terms = query.match(/[\p{L}\p{N}]+/gu) ?? [];
    if (query.trim() && terms.length === 0) fail('INVALID_CONVERSATION_QUERY', 'La consulta debe contener palabras o números.');
    const expression = terms.map(term => '"' + term + '"').join(' AND ');
    const signal = requestSignal();
    return withIndexLock(baseDirectory, 'all', async () => {
      const db = await openIndex();
      try {
        db.exec('BEGIN');
        const known = new Map(db.prepare('SELECT id,fingerprint FROM files').all().map(row => [row.id, row.fingerprint]));
        const names = await fs.readdir(baseDirectory);
        const present = new Set();
        let read = 0;
        let omitted = 0;
        const drop = db.prepare('DELETE FROM conversations WHERE id=?');
        const remember = db.prepare('INSERT OR REPLACE INTO files VALUES (?,?)');
        const insert = db.prepare('INSERT INTO conversations VALUES (?,?,?,?,?,?,?,?)');
        for (const name of names) {
          signal?.throwIfAborted();
          const match = FILENAME.exec(name);
          if (!match || !ID.test(match[1])) continue;
          const entryId = match[1];
          present.add(entryId);
          try {
            const info = await fs.lstat(path.join(baseDirectory, name), { bigint: true });
            if (!info.isFile() || info.isSymbolicLink()) throw new Error('non-regular');
            const fingerprint = [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':');
            if (known.get(entryId) === fingerprint) continue;
            const entry = await continuity.getContinuity(entryId);
            read++;
            const conversation = asConversation(entry);
            drop.run(entryId);
            if (conversation) insert.run(conversation.id, conversation.revision, conversation.updatedAt,
              conversation.title, conversation.important, conversation.project ?? '',
              conversation.agent ?? '', fold(conversation.project ?? ''));
            remember.run(entryId, fingerprint);
          } catch (error) {
            // Un registro corrupto no debe seguir apareciendo con contenido
            // antiguo. No se cachea el fallo: se vuelve a examinar al consultar.
            if (signal?.aborted) throw error;
            if (['EACCES', 'EPERM', 'EIO', 'ENOSPC'].includes(error.code)) throw error;
            if (error.code?.startsWith('ERR_SQLITE')) throw error;
            drop.run(entryId);
            db.prepare('DELETE FROM files WHERE id=?').run(entryId);
            omitted++;
          }
        }
        for (const entryId of known.keys()) {
          if (!present.has(entryId)) {
            drop.run(entryId);
            db.prepare('DELETE FROM files WHERE id=?').run(entryId);
          }
        }
        signal?.throwIfAborted();
        const clauses = [];
        const args = [];
        if (expression) { clauses.push('conversations MATCH ?'); args.push(expression); }
        if (project !== undefined) { clauses.push('project_key=?'); args.push(fold(project)); }
        const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';
        const total = db.prepare('SELECT count(*) AS total FROM conversations' + where).get(...args).total;
        const excerpt = expression ? "snippet(conversations,4,'','',' … ',32)" : 'substr(important,1,300)';
        const rows = db.prepare(`SELECT id,revision,updated,title,project,${excerpt} AS excerpt
          FROM conversations${where} ORDER BY ${expression ? 'rank,' : ''} updated DESC,id LIMIT ?`).all(...args, limit);
        db.exec('COMMIT');
        return { total, results: rows.map(row => ({ id: row.id, revision: Number(row.revision),
          title: row.title, project: row.project || null, updatedAt: row.updated,
          excerpt: row.excerpt.slice(0, 500) })),
          index: { examined: present.size, read, omitted } };
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch {}
        throw error;
      } finally { db.close(); }
    }, 'conversation-index', { signal });
  }
  return Object.freeze({ getConversation, saveConversation, searchConversations });
}
