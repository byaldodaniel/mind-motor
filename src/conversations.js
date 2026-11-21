import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MotorError } from './errors.js';
import { withIndexLock } from './index-lock.js';
import { requestSignal } from './request-context.js';
import { createConversationPreferences, retention, describeRetention } from './conversation-preferences.js';
import { createSemanticEncoder } from './semantic-encoder.js';
import { semanticSearch, fuseResults, prepareConversationVectors, nativeMeaningSearch,
  NATIVE_MEANING_MODEL, MAX_MEANING_DOCUMENTS, MAX_MEANING_BYTES } from './conversation-search.js';

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

function loadMeaningCorpus(db, project) {
  const scope = project === undefined ? '' : ' WHERE project_key=?';
  const args = project === undefined ? [] : [fold(project)];
  const { entries, bytes } = db.prepare('SELECT count(*) AS entries, coalesce(sum(length(CAST(important AS BLOB))),0) AS bytes FROM conversations' + scope).get(...args);
  if (entries > MAX_MEANING_DOCUMENTS || bytes > MAX_MEANING_BYTES) return null;
  return db.prepare('SELECT id,revision,updated,title,project,important FROM conversations' + scope + ' ORDER BY id').all(...args);
}
function content(input) {
  const markdownBase = input.markdownBase;
  const validMarkdownBase = typeof input.file === 'string' && markdownBase?.file === input.file
    && (markdownBase.version === null || typeof markdownBase.version === 'string' && /^sha256:[a-f0-9]{64}$/.test(markdownBase.version));
  return {
    format: FORMAT, version: 1,
    title: text(input.title, 'title'),
    important: text(input.important, 'important', { max: 64 * 1024 }),
    project: text(input.project, 'project', { nullable: true }),
    agent: text(input.agent, 'agent', { nullable: true }),
    ...(input.file === undefined ? {} : { file: text(input.file, 'file', {max:4096}) }),
    ...(validMarkdownBase ? { markdownBase: { file: input.file, version: markdownBase.version } } : {}),
    externalId: text(input.externalId, 'externalId', { nullable: true, max: 512 }),
    ...(input.preferences == null ? {} : { preferences: retention(input.preferences) }),
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
 * No lee originales ni historiales ni crea carpetas de trabajo.
 * Inferencia local bajo demanda en un worker que se libera tras inactividad.
 */
export function createConversations({ baseDirectory, continuity, semanticEncoder = createSemanticEncoder(), nativeMeaningExecutable, backgroundGate = null }) {
  const preferences = createConversationPreferences(baseDirectory);
  const experimental = nativeMeaningExecutable !== undefined;
  let preparing;
  let warming;
  let preparationError;
  let closing = false;
  function startPreparation() {
    if (preparing || closing) return;
    preparing = (async () => {
      const db = await openIndex();
      try {
        return await prepareConversationVectors(db, semanticEncoder, async (row, values) => {
          await withIndexLock(baseDirectory, 'all', async () => {
            if (closing) return;
            // Inferencia fuera del bloqueo. Comprobar la fuente antes de publicar
            // para no revivir un registro editado o retirado mientras se calculaba.
            const source = await continuity.getContinuity(row.id);
            const current = db.prepare('SELECT revision FROM conversations WHERE id=?').get(row.id);
            if (!source || source.revision !== Number(row.revision) || !current || Number(current.revision) !== Number(row.revision)) return;
            db.exec('SAVEPOINT vector_document');
            try {
              db.prepare('DELETE FROM conversation_vectors WHERE id=?').run(row.id);
              const insert = db.prepare('INSERT OR REPLACE INTO conversation_vectors VALUES (?,?,?,?,?)');
              for (const value of values) insert.run(...value);
              db.exec('RELEASE vector_document');
            } catch (error) { db.exec('ROLLBACK TO vector_document; RELEASE vector_document'); throw error; }
          }, 'conversation-index', { timeoutMs: 5000 });
        }, { backgroundGate });
      } finally { db.close(); }
    })().then(value => { preparationError = null; return value; }).catch(error => { preparationError = error.code ?? 'SEMANTIC_FAILED'; return 0; }).finally(() => { preparing = null; });
  }
  async function prepareConversationSearch() {
    if (experimental) return { error: null };
    for (let attempt = 0; attempt < 5; attempt++) {
      const result = await searchConversations({ query: 'preparar' });
      if (result.semantic.pending === 0) { await warming; return { error: preparationError ?? null }; }
      if (result.semantic.status === 'no_disponible') return { error: 'SEMANTIC_UNAVAILABLE' };
      await preparing;
      if (preparationError) return { error: preparationError };
    }
    return { error: 'CONVERSATION_INDEX_CHANGED' };
  }
  async function getConversationPreferences(conversationId) {
    const global = await preferences.read();
    const conversation = conversationId === undefined ? null : await getConversation(conversationId);
    const override = conversation?.preferences ?? null;
    return { revision: global.revision, conversationRevision: conversation?.revision ?? null,
      override, inherited: override === null, effective: describeRetention(override ?? global.preferences),
      global: global.preferences };
  }
  async function configureConversationPreferences({ id: conversationId, expectedRevision, preferences: value }) {
    if (conversationId === undefined) {
      await preferences.write(value, expectedRevision);
      return getConversationPreferences();
    }
    return preferences.lock(async () => {
      const before = await getConversation(conversationId);
      const normalized = value === null ? null : retention(value);
      const next = { ...before, preferences: normalized };
      await continuity.updateContinuity(before.id, { content: content(next) }, { expectedRevision });
      return getConversationPreferences(before.id);
    });
  }
  async function getConversation(value) {
    const entry = await continuity.getContinuity(id(value));
    const conversation = asConversation(entry);
    if (!conversation) fail('CONVERSATION_NOT_FOUND', 'No existe esa conversación en Mind.');
    return conversation;
  }

  async function saveConversationUnlocked(input, { confirm, markdownBase } = {}) {
    const allowed = ['id', 'expectedRevision', 'title', 'important', 'project', 'agent', 'externalId', 'references', 'source', 'preferences', 'explicit', 'file'];
    if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some(key => !allowed.includes(key))) fail('INVALID_CONVERSATION', 'Campos de conversación no válidos.');
    if (input.explicit !== undefined && typeof input.explicit !== 'boolean') fail('INVALID_CONVERSATION', 'explicit debe ser booleano.');
    const beforePolicy = input.id === undefined ? null : await getConversation(input.id);
    const effective = input.preferences == null ? (beforePolicy?.preferences ?? (await preferences.read()).preferences) : retention(input.preferences);
    // Una escritura de contenido no puede cambiar silenciosamente su política.
    const prior = beforePolicy?.preferences ?? (await preferences.read()).preferences;
    if ((effective.mode === 'manual' || prior.mode === 'manual') && input.explicit !== true) {
      fail('CONVERSATION_MANUAL_ONLY', 'El usuario eligió guardar solo cuando lo indique. No se registró contenido.');
    }
    if (input.id === undefined) {
      if (input.expectedRevision !== undefined) fail('INVALID_CONVERSATION', 'Una conversación nueva no indica revisión previa.');
      const entry = await continuity.recordContinuity({
        kind: 'conversacion', content: content({ ...input, markdownBase }), source: input.source,
        references: input.references,
      }, { confirm });
      return asConversation(entry);
    }
    const before = await getConversation(input.id);
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
      fail('INVALID_CONVERSATION', 'Para actualizar indica la revisión leída.');
    }
    // La lectura-modificación del JSON se coordina en continuidad, incluyendo
    // las escrituras hechas por las herramientas genéricas de continuidad.
    const fields = ['title', 'important', 'project', 'agent', 'externalId', 'preferences', 'file'];
    const next = content({
      ...Object.fromEntries(fields.map(key => [key, Object.hasOwn(input, key) ? input[key] : before[key]])),
      markdownBase,
    });
    const entry = await continuity.updateContinuity(input.id, {
      content: next, ...(input.references !== undefined ? { references: input.references } : {}),
    }, { expectedRevision: input.expectedRevision, confirm });
    return asConversation(entry);
  }

  const saveConversation = (input, options) => preferences.lock(() => saveConversationUnlocked(input, options));

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
      if (![0,1,2].includes(version)) fail('CONVERSATION_INDEX_VERSION', 'El índice requiere una versión de Mind compatible.');
      db.exec(`CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL);
        CREATE VIRTUAL TABLE IF NOT EXISTS conversations USING fts5(
          id UNINDEXED, revision UNINDEXED, updated UNINDEXED,
          title, important, project, agent, project_key UNINDEXED,
          tokenize='unicode61 remove_diacritics 2');
        CREATE TABLE IF NOT EXISTS conversation_vectors (
          id TEXT NOT NULL, part INTEGER NOT NULL, model TEXT NOT NULL, vector BLOB NOT NULL, excerpt TEXT NOT NULL,
          PRIMARY KEY(id,part,model));
        PRAGMA user_version=2;`);
      return db;
    } catch (error) { db.close(); throw error; }
  }

  async function searchConversations({ query = '', project, limit = 20, mode = 'hibrida' } = {}) {
    if (!['hibrida','palabras'].includes(mode) || typeof query !== 'string' || query.length > 256 || !query.isWellFormed()
        || query.includes('\0') || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
      fail('INVALID_CONVERSATION_QUERY', 'Consulta de hasta 256 caracteres y límite de 1 a 50.');
    }
    if (project !== undefined) text(project, 'project');
    const terms = query.match(/[\p{L}\p{N}]+/gu) ?? [];
    if (query.trim() && terms.length === 0) fail('INVALID_CONVERSATION_QUERY', 'La consulta debe contener palabras o números.');
    const expression = terms.map(term => '"' + term + '"').join(' AND ');
    const signal = requestSignal();
    const testMeaning = experimental && mode === 'hibrida' && Boolean(expression);
    const synced = await withIndexLock(baseDirectory, 'all', async () => {
      const db = await openIndex();
      try {
        db.exec('BEGIN');
        const known = new Map(db.prepare('SELECT id,fingerprint FROM files').all().map(row => [row.id, row.fingerprint]));
        const names = await fs.readdir(baseDirectory);
        const present = new Set();
        let read = 0;
        let omitted = 0;
        const deleteText = db.prepare('DELETE FROM conversations WHERE id=?');
        const deleteVectors = db.prepare('DELETE FROM conversation_vectors WHERE id=?');
        const drop = { run(value) { deleteText.run(value); deleteVectors.run(value); } };
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
          FROM conversations${where} ORDER BY ${expression ? 'rank,' : ''} updated DESC,id LIMIT ?`).all(...args, mode === 'hibrida' ? 200 : limit);
        const pending = experimental ? 0 : db.prepare('SELECT count(*) AS n FROM conversations WHERE id NOT IN (SELECT id FROM conversation_vectors WHERE model=?)').get(semanticEncoder.model).n;
        const indexed = experimental ? 0 : db.prepare('SELECT count(*) AS n FROM conversation_vectors WHERE model=?').get(semanticEncoder.model).n;
        const corpus = testMeaning ? loadMeaningCorpus(db, project) : null;
        db.exec('COMMIT');
        return { rows, total, presentCount: present.size, read, omitted, pending, indexed, corpus };
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch {}
        throw error;
      } finally { db.close(); }
    }, 'conversation-index', { signal, timeoutMs: 5000 });

    let selected = synced.rows;
    let totalResults = synced.total;
    const semantic = { status: 'no_solicitada', embedded: 0, model: experimental ? NATIVE_MEANING_MODEL : semanticEncoder.model };
    if (testMeaning) {
      try {
        if (synced.corpus === null) throw new Error('La Base supera el alcance del buscador de prueba.');
        const documents = synced.corpus.map(({ id, important }) => ({ id, important }));
        const found = await nativeMeaningSearch(nativeMeaningExecutable, { query, documents, limit, signal });
        semantic.status = 'activa';
        const exactCode = /^(?=.*[0-9])[A-Za-z0-9][A-Za-z0-9./_-]*$/u.test(query.trim());
        if (!exactCode || !synced.rows.length) {
          const sources = new Map(synced.corpus.map(({ important: _, ...row }) => [row.id, row]));
          selected = found.matches.map(match => ({ ...sources.get(match.id), ...match, match: 'significado' }));
          totalResults = found.total;
        }
      } catch (error) {
        if (signal?.aborted) throw error;
        semantic.status = 'fallo';
      }
    } else if (mode === 'hibrida' && expression) {
      const db = await openIndex();
      try {
        if (!(await semanticEncoder.available())) semantic.status = 'no_disponible';
        else {
          semantic.pending = synced.pending;
          semantic.status = synced.pending ? 'preparando' : 'activa';
          const ready = semanticEncoder.isReady?.() !== false;
          const found = synced.indexed && ready ? await semanticSearch(db, semanticEncoder, { query, projectKey: project === undefined ? undefined : fold(project), signal }) : { matches: [], embedded: 0 };
          if (synced.indexed && !ready) {
            semantic.status = 'cargando';
            if (!warming && !preparing && !closing) {
              warming = semanticEncoder.embed([query], { kind: 'query' }).then(() => { preparationError = null; })
                .catch(error => { preparationError = error.code ?? 'SEMANTIC_FAILED'; }).finally(() => { warming = null; });
            }
          }
          if (synced.pending) startPreparation();
          if (preparationError) semantic.status = 'fallo';
          const fused = fuseResults(synced.rows, found.matches, { exactIdentifiers: /\d/.test(query) || /[/\\.]/.test(query) });
          selected = fused.slice(0, limit).map(row => {
            const metadata = db.prepare('SELECT revision,updated,title,project FROM conversations WHERE id=?').get(row.id);
            return { ...metadata, ...row };
          });
          totalResults = fused.length;
        }
      } catch (error) {
        if (signal?.aborted) throw error;
        semantic.status = 'fallo';
      } finally { db.close(); }
    }
    return { total: totalResults, semantic, results: selected.slice(0, limit).map(row => ({ id: row.id, revision: Number(row.revision),
      title: row.title, project: row.project || null, updatedAt: row.updated,
      excerpt: row.excerpt.slice(0, 500), match: row.match ?? 'palabras' })),
      index: { examined: synced.presentCount, read: synced.read, omitted: synced.omitted } };
  }
  return Object.freeze({ getConversation, saveConversation, searchConversations,
    getConversationPreferences, configureConversationPreferences,
    prepareConversationSearch,
    relocateConversationPreferenceDirectories: preferences.relocate,
    unloadConversationSearch: () => semanticEncoder.unload?.(),
    /** Hay una preparación o un calentamiento semántico en curso: descargar ahora lo abortaría. */
    isConversationSearchBusy: () => Boolean(preparing || warming),
    async closeConversationSearch() { closing = true; await semanticEncoder.close(); await preparing; await warming; } });
}
