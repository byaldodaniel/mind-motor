import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { MotorError } from './errors.js';
import { prepareBaseFormat } from './base-format.js';

export const CATALOG_FILENAME = 'catalog.sqlite';

const DEFAULT_TAG_ALIASES = [
  ['pendiente', 'pendiente'],
  ['pendientes', 'pendiente'],
  ['tarea', 'pendiente'],
  ['tareas', 'pendiente'],
  ['actividad', 'pendiente'],
  ['actividades', 'pendiente'],
  ['todo', 'pendiente'],
  ['todos', 'pendiente'],
  ['accion', 'pendiente'],
  ['acciones', 'pendiente'],
  ['idea', 'idea'],
  ['ideas', 'idea'],
  ['decision', 'decision'],
  ['decisiones', 'decision'],
  ['bloqueo', 'bloqueo'],
  ['bloqueos', 'bloqueo'],
  ['bloqueado', 'bloqueo'],
  ['urgente', 'urgente'],
  ['urgentes', 'urgente'],
];

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS folder_scopes (
  scope_id TEXT PRIMARY KEY,
  root TEXT NOT NULL,
  authorization_generation TEXT,
  generation INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  issues_json TEXT NOT NULL DEFAULT '[]',
  revision TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS folder_entries (
  scope_id TEXT NOT NULL,
  path TEXT NOT NULL,
  type TEXT NOT NULL,
  size INTEGER,
  modified_at TEXT,
  changed_at TEXT,
  created_at TEXT,
  identity TEXT,
  state TEXT NOT NULL,
  reason TEXT,
  PRIMARY KEY (scope_id, path)
);

CREATE TABLE IF NOT EXISTS document_marks (
  scope_id TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  block_index INTEGER NOT NULL,
  heading TEXT,
  line_number INTEGER NOT NULL,
  block_type TEXT NOT NULL,
  tag TEXT NOT NULL,
  raw_tag TEXT NOT NULL,
  status TEXT NOT NULL,
  excerpt TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope_id, relative_path, block_index, tag)
);

CREATE INDEX IF NOT EXISTS idx_document_marks_tag_status
  ON document_marks(tag, status, scope_id, relative_path);

CREATE TABLE IF NOT EXISTS tag_aliases (
  alias TEXT PRIMARY KEY,
  canonical_tag TEXT NOT NULL,
  user_defined INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS scanned_files (
  scope_id TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  scanned_at TEXT NOT NULL,
  PRIMARY KEY (scope_id, relative_path)
);
`;

export function escapeLike(value) {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

function mapSqliteError(error) {
  if (error instanceof MotorError) return error;
  const message = `${error?.code ?? ''} ${error?.message ?? ''}`.toLowerCase();
  if (message.includes('corrupt') || message.includes('malformed') || message.includes('not a database') || message.includes('notadb')) {
    return new MotorError('INDEX_CORRUPT', 'El catálogo de índices está dañado.', { cause: error });
  }
  return error;
}

async function inspectCatalogPath(baseDirectory, { requireDirectory = false } = {}) {
  const dirInfo = await fs.lstat(baseDirectory).catch((error) => (error.code === 'ENOENT' ? null : Promise.reject(error)));
  if (!dirInfo) {
    if (requireDirectory) await fs.mkdir(baseDirectory, { recursive: true });
    else return { dirExists: false, fileExists: false };
  } else if (!dirInfo.isDirectory() || dirInfo.isSymbolicLink()) {
    throw new MotorError('INDEX_CORRUPT', 'La carpeta Base no es un directorio seguro.');
  }

  const catalogFile = path.join(baseDirectory, CATALOG_FILENAME);
  const fileInfo = await fs.lstat(catalogFile).catch((error) => (error.code === 'ENOENT' ? null : Promise.reject(error)));
  if (fileInfo && (!fileInfo.isFile() || fileInfo.isSymbolicLink() || fileInfo.nlink !== 1)) {
    throw new MotorError('INDEX_CORRUPT', 'El catálogo SQLite no es un archivo regular seguro.');
  }
  return { dirExists: true, fileExists: Boolean(fileInfo), catalogFile };
}

function ensureSchema(db) {
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec(SCHEMA_SQL);
  const seed = db.prepare('INSERT OR IGNORE INTO tag_aliases (alias, canonical_tag, user_defined) VALUES (?, ?, 0)');
  for (const [alias, canonical] of DEFAULT_TAG_ALIASES) seed.run(alias, canonical);
}

/** Opens `catalog.sqlite` safely, initializes schema when requested, and always closes the handle. */
export async function withCatalog(baseDirectory, { write = false, create = false } = {}, fn) {
  const status = await inspectCatalogPath(baseDirectory, { requireDirectory: create });
  if (!status.fileExists && !create) return null;

  const db = new DatabaseSync(status.catalogFile);
  try {
    db.exec('PRAGMA busy_timeout = 5000;');
    if (write || create) {
      ensureSchema(db);
    } else {
      const hasTable = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'folder_scopes'").get();
      if (!hasTable) return null;
    }
    return await fn(db);
  } catch (error) {
    throw mapSqliteError(error);
  } finally {
    db.close();
  }
}

function runTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE;');
  try {
    const result = fn();
    db.exec('COMMIT;');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK;'); } catch { /* rollback best-effort */ }
    throw error;
  }
}

function parseIssues(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw || '[]');
  } catch (cause) {
    throw new MotorError('INDEX_CORRUPT', 'Lista de incidencias corrupta en el catálogo.', { cause });
  }
  if (!Array.isArray(parsed)) throw new MotorError('INDEX_CORRUPT', 'Lista de incidencias corrupta en el catálogo.');
  return parsed;
}

function sortEntries(entries) {
  let ordered = true;
  for (let i = 1; i < entries.length; i++) {
    if (entries[i].path < entries[i - 1].path) {
      ordered = false;
      break;
    }
  }
  if (!ordered) entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return entries;
}

export async function getScopeMetaFromCatalog(baseDirectory, scopeId) {
  return withCatalog(baseDirectory, { write: false, create: false }, (db) => {
    const row = db.prepare(
      'SELECT scope_id, root, authorization_generation, generation, created_at, updated_at, revision FROM folder_scopes WHERE scope_id = ?'
    ).get(scopeId);
    if (!row) return null;
    return {
      scopeId: row.scope_id,
      root: row.root,
      authorizationGeneration: row.authorization_generation ?? null,
      generation: row.generation,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      revision: row.revision ?? '',
    };
  });
}

export async function loadScopeIndexFromCatalog(baseDirectory, scopeId) {
  return withCatalog(baseDirectory, { write: false, create: false }, (db) => {
    const scope = db.prepare(
      'SELECT scope_id, root, authorization_generation, generation, created_at, updated_at, issues_json, revision FROM folder_scopes WHERE scope_id = ?'
    ).get(scopeId);
    if (!scope) return null;

    const rows = db.prepare(
      'SELECT path, type, size, modified_at, changed_at, created_at, identity, state, reason FROM folder_entries WHERE scope_id = ?'
    ).all(scopeId);

    const entries = sortEntries(rows.map((row) => ({
      path: row.path,
      type: row.type,
      size: row.size ?? null,
      modifiedAt: row.modified_at ?? null,
      changedAt: row.changed_at ?? null,
      createdAt: row.created_at ?? null,
      identity: row.identity ?? null,
      state: row.state,
      reason: row.reason ?? null,
    })));

    return {
      scopeId: scope.scope_id,
      root: scope.root,
      authorizationGeneration: scope.authorization_generation ?? null,
      generation: scope.generation,
      createdAt: scope.created_at,
      updatedAt: scope.updated_at,
      issues: parseIssues(scope.issues_json),
      entries,
      revision: scope.revision ?? '',
    };
  });
}

export async function saveScopeIndexToCatalog(baseDirectory, index) {
  await prepareBaseFormat(baseDirectory, 3);
  const revision = randomUUID();
  await withCatalog(baseDirectory, { write: true, create: true }, (db) => {
    runTransaction(db, () => {
      db.prepare(`
        INSERT OR REPLACE INTO folder_scopes
          (scope_id, root, authorization_generation, generation, created_at, updated_at, issues_json, revision)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        index.scopeId,
        index.root,
        index.authorizationGeneration ?? null,
        index.generation,
        index.createdAt,
        index.updatedAt,
        JSON.stringify(index.issues ?? []),
        revision,
      );

      db.prepare('DELETE FROM folder_entries WHERE scope_id = ?').run(index.scopeId);
      const insert = db.prepare(`
        INSERT INTO folder_entries
          (scope_id, path, type, size, modified_at, changed_at, created_at, identity, state, reason)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const entry of index.entries) {
        insert.run(
          index.scopeId,
          entry.path,
          entry.type,
          entry.size ?? null,
          entry.modifiedAt ?? null,
          entry.changedAt ?? null,
          entry.createdAt ?? null,
          entry.identity ?? null,
          entry.state,
          entry.reason ?? null,
        );
      }
    });
  });
  return revision;
}

export async function saveScopeBranchToCatalog(baseDirectory, branch) {
  await prepareBaseFormat(baseDirectory, 3);
  const revision = randomUUID();
  await withCatalog(baseDirectory, { write: true, create: true }, (db) => {
    runTransaction(db, () => {
      const updated = db.prepare(`
        UPDATE folder_scopes
        SET root = ?, authorization_generation = ?, generation = ?, updated_at = ?, issues_json = ?, revision = ?
        WHERE scope_id = ?
      `).run(
        branch.root,
        branch.authorizationGeneration ?? null,
        branch.generation,
        branch.updatedAt,
        JSON.stringify(branch.issues ?? []),
        revision,
        branch.scopeId,
      );
      if (!updated.changes) {
        throw new MotorError('INDEX_MISSING', 'No existe índice base para actualización parcial.');
      }

      const deleteSubtree = db.prepare("DELETE FROM folder_entries WHERE scope_id = ? AND (path = ? OR path LIKE ? ESCAPE '\\')");
      const deleteMarkSubtree = db.prepare("DELETE FROM document_marks WHERE scope_id = ? AND (relative_path = ? OR relative_path LIKE ? ESCAPE '\\')");
      const deleteScannedSubtree = db.prepare("DELETE FROM scanned_files WHERE scope_id = ? AND (relative_path = ? OR relative_path LIKE ? ESCAPE '\\')");

      for (const prefix of branch.prefixes ?? []) {
        const pattern = `${escapeLike(prefix)}/%`;
        deleteSubtree.run(branch.scopeId, prefix, pattern);
        deleteMarkSubtree.run(branch.scopeId, prefix, pattern);
        deleteScannedSubtree.run(branch.scopeId, prefix, pattern);
      }

      const deleteExact = db.prepare('DELETE FROM folder_entries WHERE scope_id = ? AND path = ?');
      const deleteMarkExact = db.prepare('DELETE FROM document_marks WHERE scope_id = ? AND relative_path = ?');
      const deleteScannedExact = db.prepare('DELETE FROM scanned_files WHERE scope_id = ? AND relative_path = ?');

      for (const relativePath of branch.removedExact ?? []) {
        deleteExact.run(branch.scopeId, relativePath);
        deleteMarkExact.run(branch.scopeId, relativePath);
        deleteScannedExact.run(branch.scopeId, relativePath);
      }

      const upsert = db.prepare(`
        INSERT OR REPLACE INTO folder_entries
          (scope_id, path, type, size, modified_at, changed_at, created_at, identity, state, reason)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const entry of branch.upserts ?? []) {
        upsert.run(
          branch.scopeId,
          entry.path,
          entry.type,
          entry.size ?? null,
          entry.modifiedAt ?? null,
          entry.changedAt ?? null,
          entry.createdAt ?? null,
          entry.identity ?? null,
          entry.state,
          entry.reason ?? null,
        );
      }
    });
  });
  return revision;
}

export async function removeScopeFromCatalog(baseDirectory, scopeId) {
  let removed = false;
  await withCatalog(baseDirectory, { write: true, create: false }, (db) => {
    runTransaction(db, () => {
      db.prepare('DELETE FROM folder_entries WHERE scope_id = ?').run(scopeId);
      db.prepare('DELETE FROM document_marks WHERE scope_id = ?').run(scopeId);
      db.prepare('DELETE FROM scanned_files WHERE scope_id = ?').run(scopeId);
      const info = db.prepare('DELETE FROM folder_scopes WHERE scope_id = ?').run(scopeId);
      removed = info.changes > 0;
    });
  });
  return removed;
}
