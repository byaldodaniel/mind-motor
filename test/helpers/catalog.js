import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CATALOG_FILENAME } from '../../src/sqlite-catalog.js';

// Acceso de prueba al catálogo de índices (`catalog.sqlite`), que sustituyó a
// los archivos `folder-index-<id>.json`. Solo lee, salvo `alterCatalog`, que
// existe para inyectar daños en Bases ficticias.

export const catalogFile = (base) => path.join(base, CATALOG_FILENAME);
const CATALOG_FILES = ['', '-wal', '-shm', '-journal'];

async function exists(filename) {
  return fs.lstat(filename).then(() => true, (error) => (error.code === 'ENOENT' ? false : Promise.reject(error)));
}

/** Abre el catálogo existente; nunca lo crea. */
async function withDatabase(base, task) {
  if (!(await exists(catalogFile(base)))) return null;
  const db = new DatabaseSync(catalogFile(base));
  try {
    db.exec('PRAGMA busy_timeout = 5000;');
    const ready = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'folder_scopes'").get();
    return ready ? task(db) : null;
  } finally {
    db.close();
  }
}

/** Ámbitos con índice publicado en el catálogo, ordenados. */
export async function catalogScopeIds(base) {
  const ids = await withDatabase(base, (db) => db.prepare('SELECT scope_id FROM folder_scopes ORDER BY scope_id').all()
    .map((row) => row.scope_id));
  return ids ?? [];
}

/**
 * Estado completo publicado de un ámbito (fila del ámbito y todas sus entradas),
 * serializado de forma determinista para comparar "antes" y "después".
 * null si el ámbito no tiene índice.
 */
export async function catalogScope(base, scopeId) {
  const state = await withDatabase(base, (db) => {
    const scope = db.prepare('SELECT * FROM folder_scopes WHERE scope_id = ?').get(scopeId);
    if (!scope) return null;
    const entries = db.prepare('SELECT * FROM folder_entries WHERE scope_id = ? ORDER BY path').all(scopeId);
    return JSON.stringify({ scope: { ...scope }, entries: entries.map((row) => ({ ...row })) });
  });
  return state ?? null;
}

/** Fila del ámbito tal como está publicada (authorizationGeneration incluida). */
export async function catalogScopeRow(base, scopeId) {
  const state = await catalogScope(base, scopeId);
  return state === null ? null : JSON.parse(state).scope;
}

/**
 * Todo lo que el catálogo guarda en disco (archivo principal y diario WAL),
 * para comprobar que un texto no se persistió en ninguna tabla ni página.
 */
export async function catalogBytes(base) {
  const parts = [];
  for (const suffix of CATALOG_FILES) {
    const filename = `${catalogFile(base)}${suffix}`;
    if (await exists(filename)) parts.push(await fs.readFile(filename));
  }
  return Buffer.concat(parts).toString('utf8');
}

/** Retira el catálogo completo de una Base ficticia. */
export async function removeCatalog(base) {
  for (const suffix of CATALOG_FILES) await fs.rm(`${catalogFile(base)}${suffix}`, { force: true, recursive: true });
}

/** Ejecuta SQL de daño controlado sobre el catálogo de una Base ficticia. */
export async function alterCatalog(base, sql, ...params) {
  const done = await withDatabase(base, (db) => {
    db.prepare(sql).run(...params);
    return true;
  });
  if (!done) throw new Error('No hay catálogo que alterar.');
}

/**
 * Vuelve a escribir en el catálogo un estado capturado con `catalogScope`, como
 * lo haría una publicación tardía de otro proceso o una restauración de copia.
 */
export async function publishCatalogScope(base, state) {
  const { scope, entries } = JSON.parse(state);
  const done = await withDatabase(base, (db) => {
    db.exec('BEGIN IMMEDIATE;');
    try {
      const columns = (row) => Object.keys(row);
      const insert = (table, row) => db.prepare(`INSERT OR REPLACE INTO ${table} (${columns(row).join(', ')}) VALUES (${columns(row).map(() => '?').join(', ')})`)
        .run(...Object.values(row));
      db.prepare('DELETE FROM folder_entries WHERE scope_id = ?').run(scope.scope_id);
      insert('folder_scopes', scope);
      for (const row of entries) insert('folder_entries', row);
      db.exec('COMMIT;');
    } catch (error) {
      db.exec('ROLLBACK;');
      throw error;
    }
    return true;
  });
  if (!done) throw new Error('No hay catálogo donde publicar.');
}

/** Archivos JSON de índice del formato anterior que siguieran en la Base. */
export async function legacyIndexFiles(base) {
  return (await fs.readdir(base)).filter((name) => name.startsWith('folder-index-') && name.endsWith('.json'));
}
