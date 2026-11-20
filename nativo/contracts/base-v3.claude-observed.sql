-- OBSERVED SOURCE SNAPSHOT, NOT A MIGRATION OR EXECUTABLE INTEGRATION CONTRACT.
-- Source: C:\Users\Aldo Daniel\Desktop\Mind - Desarrollo\Motor\src\sqlite-catalog.js
-- Captured UTC: 2026-11-16T06:03:29.663Z
-- Captured America/Lima: 2026-11-16 01:03:29 -05:00
-- Source SHA-256: c6b754f109a89d11e6fba79633ca5c655e174a13b297725156af3361706b68a4
-- base-format.js SHA-256: d9ce5f95ac0e19020a79dd6d5bd74acf2f72079d2407fbf9a99ffc9aedb54d82
-- Exact text of SCHEMA_SQL; no normalization or fixes to its statements.
-- Source declares global BASE_FORMAT_VERSION=3. This DDL does not set PRAGMA user_version.
-- Runtime pragmas WAL/synchronous/busy_timeout and seeded aliases are outside this literal.
-- This file was not executed and does not describe the user's installed Base.

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
