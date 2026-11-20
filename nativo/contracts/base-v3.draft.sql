-- DRAFT, NOT IMPLEMENTED. Never execute against a user's Base.
-- Proposed mind-catalog-v3 schema revision 3, 2026-11-16.
-- Global Base format and PRAGMA user_version are distinct concepts (both 3 here).
PRAGMA foreign_keys=ON;
BEGIN;
CREATE TABLE IF NOT EXISTS catalog_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;
INSERT OR IGNORE INTO catalog_meta VALUES
 ('contract','mind-catalog-v3-draft-3'),('schema_revision','3'),
 ('base_format','3'),('status','draft-unimplemented');

-- Administrative references only; no row grants filesystem permissions.
CREATE TABLE IF NOT EXISTS scopes(
 scope_id TEXT PRIMARY KEY,physical_root TEXT NOT NULL,authorization_generation TEXT,
 case_policy TEXT NOT NULL CHECK(case_policy IN ('sensitive','insensitive','unknown')),
 state TEXT NOT NULL CHECK(state IN ('pending','available','unavailable','revoked')),
 snapshot_generation INTEGER NOT NULL DEFAULT 0 CHECK(snapshot_generation>=0),
 last_verified_at TEXT,last_error_code TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS entries(
 entry_id INTEGER PRIMARY KEY,scope_id TEXT NOT NULL REFERENCES scopes(scope_id),
 authorization_generation TEXT,parent_id INTEGER,
 relative_path TEXT NOT NULL,path_key TEXT NOT NULL,name TEXT NOT NULL,
 entry_type TEXT NOT NULL CHECK(entry_type IN ('file','directory','link','other','unknown')),
 identity TEXT,size INTEGER CHECK(size IS NULL OR size>=0),
 created_at TEXT,modified_at TEXT,changed_at TEXT,content_fingerprint TEXT,content_generation INTEGER NOT NULL DEFAULT 0,
 entry_state TEXT NOT NULL CHECK(entry_state IN ('indexed','not-listed','unverified','removed')),
 reason TEXT,seen_generation INTEGER NOT NULL DEFAULT 0 CHECK(seen_generation>=0),
 removed_at TEXT,UNIQUE(scope_id,path_key),UNIQUE(scope_id,entry_id),
 FOREIGN KEY(scope_id,parent_id) REFERENCES entries(scope_id,entry_id)
) STRICT;
CREATE INDEX IF NOT EXISTS entries_by_parent ON entries(scope_id,parent_id,path_key,entry_id);
CREATE INDEX IF NOT EXISTS entries_by_identity ON entries(scope_id,identity) WHERE identity IS NOT NULL;
CREATE INDEX IF NOT EXISTS entries_by_modified ON entries(scope_id,modified_at,entry_id);

CREATE TABLE IF NOT EXISTS directory_scans(
 scan_id TEXT PRIMARY KEY,scope_id TEXT NOT NULL REFERENCES scopes(scope_id),
 authorization_generation TEXT,directory_id INTEGER NOT NULL,
 directory_identity TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('queued','running','partial','complete','failed','cancelled')),
 started_at TEXT,finished_at TEXT,observed_count INTEGER NOT NULL DEFAULT 0,error_code TEXT,
 FOREIGN KEY(scope_id,directory_id) REFERENCES entries(scope_id,entry_id)
) STRICT;
CREATE TABLE IF NOT EXISTS scan_staging(
 scan_id TEXT NOT NULL REFERENCES directory_scans(scan_id) ON DELETE CASCADE,
 name_key TEXT NOT NULL,payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
 PRIMARY KEY(scan_id,name_key)
) STRICT;
CREATE TABLE IF NOT EXISTS jobs(
 job_id TEXT PRIMARY KEY,scope_id TEXT NOT NULL REFERENCES scopes(scope_id),
 authorization_generation TEXT,directory_id INTEGER,
 kind TEXT NOT NULL CHECK(kind IN ('scan','extract','reconcile','purge')),
 dedupe_key TEXT NOT NULL,priority INTEGER NOT NULL CHECK(priority BETWEEN 1 AND 3),
 state TEXT NOT NULL CHECK(state IN ('queued','running','retry','complete','cancelled','failed')),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),not_before_ms INTEGER NOT NULL DEFAULT 0,
 owner_instance TEXT,lease_deadline_ms INTEGER,expected_identity TEXT,
 requested_at TEXT NOT NULL,error_code TEXT,
 FOREIGN KEY(scope_id,directory_id) REFERENCES entries(scope_id,entry_id)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS jobs_active_dedup ON jobs(scope_id,dedupe_key)
 WHERE state IN ('queued','running','retry');
CREATE INDEX IF NOT EXISTS jobs_ready ON jobs(state,not_before_ms,priority,requested_at);

CREATE TABLE IF NOT EXISTS blocks(
 block_id TEXT PRIMARY KEY,scope_id TEXT NOT NULL,entry_id INTEGER NOT NULL,
 source_fingerprint TEXT NOT NULL,source_generation INTEGER NOT NULL,
 extractor_version TEXT NOT NULL,rule_version TEXT NOT NULL,stable_anchor TEXT NOT NULL,
 start_line INTEGER NOT NULL CHECK(start_line>=1),end_line INTEGER NOT NULL CHECK(end_line>=start_line),
 title TEXT,excerpt TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('open','closed','ambiguous','excluded')),
 FOREIGN KEY(scope_id,entry_id) REFERENCES entries(scope_id,entry_id),
 UNIQUE(entry_id,source_generation,stable_anchor),UNIQUE(scope_id,entry_id,block_id)
) STRICT;
CREATE INDEX IF NOT EXISTS blocks_entry ON blocks(entry_id,source_generation);
CREATE TABLE IF NOT EXISTS property_definitions(
 property_id TEXT PRIMARY KEY,user_key TEXT NOT NULL,key_normalized TEXT NOT NULL UNIQUE,
 value_type TEXT NOT NULL CHECK(value_type IN ('string','number','boolean','tag')),
 normalization TEXT NOT NULL,definition_revision INTEGER NOT NULL CHECK(definition_revision>=1)
) STRICT;
CREATE TABLE IF NOT EXISTS property_aliases(
 alias_key TEXT NOT NULL,property_id TEXT NOT NULL REFERENCES property_definitions(property_id),
 canonical_value TEXT NOT NULL,rule_revision INTEGER NOT NULL,PRIMARY KEY(alias_key,property_id)
) STRICT;
CREATE TABLE IF NOT EXISTS property_values(
 value_id INTEGER PRIMARY KEY,scope_id TEXT NOT NULL,entry_id INTEGER NOT NULL,
 block_id TEXT REFERENCES blocks(block_id) ON DELETE CASCADE,
 property_id TEXT NOT NULL REFERENCES property_definitions(property_id),
 source TEXT NOT NULL CHECK(source IN ('assigned','extracted')),
 entry_identity TEXT NOT NULL,authorization_generation TEXT,
 original_json TEXT NOT NULL CHECK(json_valid(original_json)),
 value_kind TEXT NOT NULL CHECK(value_kind IN ('string','number','boolean','tag')),
 text_key TEXT,number_value REAL,boolean_value INTEGER CHECK(boolean_value IN (0,1)),
 source_revision TEXT NOT NULL,value_key TEXT NOT NULL,
 FOREIGN KEY(scope_id,entry_id) REFERENCES entries(scope_id,entry_id),
 FOREIGN KEY(scope_id,entry_id,block_id) REFERENCES blocks(scope_id,entry_id,block_id),
 CHECK((value_kind IN ('string','tag') AND text_key IS NOT NULL AND number_value IS NULL AND boolean_value IS NULL)
    OR (value_kind='number' AND text_key IS NULL AND number_value IS NOT NULL AND boolean_value IS NULL)
    OR (value_kind='boolean' AND text_key IS NULL AND number_value IS NULL AND boolean_value IS NOT NULL)),
 CHECK((source='assigned' AND block_id IS NULL) OR (source='extracted' AND block_id IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS property_value_dedup
 ON property_values(scope_id,entry_id,coalesce(block_id,''),property_id,source,value_key);
CREATE INDEX IF NOT EXISTS values_by_text ON property_values(property_id,text_key,scope_id,entry_id);
CREATE INDEX IF NOT EXISTS values_by_number ON property_values(property_id,number_value,scope_id,entry_id);
CREATE INDEX IF NOT EXISTS values_by_boolean ON property_values(property_id,boolean_value,scope_id,entry_id);
CREATE INDEX IF NOT EXISTS values_by_entry ON property_values(scope_id,entry_id,property_id);
-- Existing conversation-index.sqlite remains separate, with its existing schema.
PRAGMA user_version=3;
COMMIT;
