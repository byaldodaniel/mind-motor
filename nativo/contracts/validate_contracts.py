"""Validate proposed SQL only in SQLite :memory:, never open a real Base."""
import hashlib, json, sqlite3, sys
from pathlib import Path
root = Path(__file__).resolve().parent.parent
source = root / "contracts" / "base-v3.draft.sql"
sql = source.read_text(encoding="utf-8")
db = sqlite3.connect(":memory:")
db.execute("PRAGMA foreign_keys=ON")
results = []
def check(name, action):
    try:
        action()
        results.append({"name": name, "status": "pass"})
    except Exception as exc:
        results.append({"name": name, "status": "fail", "error": str(exc)})
def eq(actual, expected):
    assert actual == expected, (actual, expected)
def reject(statement, params=()):
    db.execute("SAVEPOINT rejected_fixture")
    try:
        db.execute(statement, params)
    except sqlite3.IntegrityError:
        db.execute("ROLLBACK TO rejected_fixture")
        db.execute("RELEASE rejected_fixture")
        return
    db.execute("ROLLBACK TO rejected_fixture")
    db.execute("RELEASE rejected_fixture")
    raise AssertionError("Expected IntegrityError")
def install():
    db.executescript(sql)
    eq(db.execute("PRAGMA user_version").fetchone()[0], 3)
    eq(db.execute("PRAGMA integrity_check").fetchone()[0], "ok")
check("create_schema_sqlite_memory_user_version_3", install)
for sid, gen in [("a","ga"),("b","gb")]:
    db.execute("INSERT INTO scopes(scope_id,physical_root,authorization_generation,case_policy,state) VALUES(?,?,?,?,?)",
               (sid, "/synthetic/"+sid, gen, "sensitive","available"))
for eid,sid,pid,name,kind,gen in [(1,"a",None,"","directory","ga"),(2,"b",None,"","directory","gb"),
                                  (10,"a",1,"task.md","file","ga"),(20,"b",2,"private.md","file","gb")]:
    db.execute("INSERT INTO entries(entry_id,scope_id,parent_id,relative_path,path_key,name,entry_type,identity,entry_state,authorization_generation) VALUES(?,?,?,?,?,?,?,?,?,?)",
               (eid,sid,pid,name,name,name,kind,"posix:1:"+str(eid),"indexed",gen))
db.execute("INSERT INTO property_definitions VALUES('p','estado','estado','string','nfc-casefold-v1',1)")
for sid,eid,gen in [("a",10,"ga"),("b",20,"gb")]:
    db.execute("""INSERT INTO property_values(scope_id,entry_id,property_id,source,entry_identity,authorization_generation,
                  original_json,value_kind,text_key,source_revision,value_key)
                  VALUES(?,?,'p','assigned',?,?,'"open"','string','open','r1','string:open')""",
               (sid,eid,"posix:1:"+str(eid),gen))
db.execute("UPDATE entries SET content_fingerprint='fixture-sha',content_generation=1 WHERE entry_id=10")
db.execute("INSERT INTO blocks(block_id,scope_id,entry_id,source_fingerprint,source_generation,extractor_version,rule_version,stable_anchor,start_line,end_line,excerpt,status) VALUES('blk','a',10,'fixture-sha',1,'1','1','anchor',1,1,'synthetic','open')")
db.execute("INSERT INTO property_values(scope_id,entry_id,block_id,property_id,source,entry_identity,authorization_generation,original_json,value_kind,text_key,source_revision,value_key) VALUES('a',10,'blk','p','extracted','posix:1:10','ga','\"open\"','string','open','r1','string:open')")
db.commit()
def repeat():
    before = db.execute("SELECT count(*) FROM entries").fetchone()[0]
    db.executescript(sql)
    eq(db.execute("SELECT count(*) FROM entries").fetchone()[0],before)
    eq(db.execute("SELECT count(*) FROM property_values").fetchone()[0],3)
    eq(db.execute("PRAGMA foreign_key_check").fetchall(),[])
check("repeat_draft_schema_preserves_rows_and_properties", repeat)
check("parent_must_belong_to_same_scope", lambda: reject(
    "INSERT INTO entries(scope_id,parent_id,relative_path,path_key,name,entry_type,entry_state) VALUES('a',2,'bad','bad','bad','file','indexed')"))
check("path_unique_inside_scope", lambda: reject(
    "INSERT INTO entries(scope_id,parent_id,relative_path,path_key,name,entry_type,entry_state) VALUES('a',1,'task.md','task.md','task.md','file','indexed')"))
check("job_directory_must_belong_to_same_scope", lambda: reject(
    "INSERT INTO jobs(job_id,scope_id,directory_id,kind,dedupe_key,priority,state,requested_at) VALUES('bad','a',2,'scan','scan:2',3,'queued','2026-01-01T00:00:00Z')"))
check("scan_directory_must_belong_to_same_scope", lambda: reject(
    "INSERT INTO directory_scans(scan_id,scope_id,directory_id,directory_identity,state) VALUES('bad','a',2,'posix:1:2','queued')"))
check("property_boolean_cannot_be_text_value", lambda: reject(
    """INSERT INTO property_values(scope_id,entry_id,property_id,source,entry_identity,original_json,value_kind,text_key,source_revision,value_key)
    VALUES('a',10,'p','assigned','posix:1:10','true','boolean','true','r1','bad')"""))
db.execute("INSERT INTO jobs(job_id,scope_id,directory_id,kind,dedupe_key,priority,state,requested_at) VALUES('j1','a',1,'scan','scan:1',3,'queued','2026-01-01T00:00:00Z')")
check("only_one_active_job_per_dedup_key", lambda: reject(
    "INSERT INTO jobs(job_id,scope_id,directory_id,kind,dedupe_key,priority,state,requested_at) VALUES('j2','a',1,'scan','scan:1',2,'retry','2026-01-01T00:00:00Z')"))
query = """WITH allowed(scope_id,auth_generation,can_read) AS (VALUES(?,?,?))
SELECT p.text_key,COUNT(*) FROM property_values p
JOIN allowed a ON a.scope_id=p.scope_id
JOIN scopes s ON s.scope_id=a.scope_id AND s.authorization_generation=a.auth_generation AND s.state='available'
JOIN entries e ON e.scope_id=p.scope_id AND e.entry_id=p.entry_id
 AND e.authorization_generation=a.auth_generation AND e.identity=p.entry_identity AND e.entry_state='indexed'
WHERE p.property_id='p' AND p.authorization_generation=a.auth_generation
AND (p.source='assigned' OR (a.can_read=1 AND EXISTS(
 SELECT 1 FROM blocks b WHERE b.block_id=p.block_id AND b.scope_id=p.scope_id AND b.entry_id=p.entry_id
 AND b.source_generation=e.content_generation AND b.source_fingerprint=e.content_fingerprint AND b.status='open')))
GROUP BY p.text_key"""
check("allowlist_applied_before_group_counts_no_other_scope_leak",
      lambda: eq(db.execute(query,("a","ga",0)).fetchall(),[("open",1)]))
check("wrong_authorization_generation_returns_no_counts",
      lambda: eq(db.execute(query,("a","outdated",0)).fetchall(),[]))
check("content_marks_require_read_permission_before_counts",
      lambda: eq(db.execute(query,("a","ga",1)).fetchall(),[("open",2)]))
def stale_content():
    db.execute("UPDATE entries SET content_generation=2 WHERE entry_id=10")
    eq(db.execute(query,("a","ga",1)).fetchall(),[("open",1)])
    db.execute("UPDATE entries SET content_generation=1 WHERE entry_id=10")
check("stale_source_version_not_counted",stale_content)
def revoked():
    db.execute("UPDATE scopes SET state='revoked' WHERE scope_id='a'")
    eq(db.execute(query,("a","ga",0)).fetchall(),[])
    db.execute("UPDATE scopes SET state='available' WHERE scope_id='a'")
check("revoked_scope_returns_no_counts", revoked)
def replaced():
    db.execute("UPDATE entries SET identity='posix:1:999' WHERE entry_id=10")
    eq(db.execute(query,("a","ga",0)).fetchall(),[])
    db.execute("UPDATE entries SET identity='posix:1:10' WHERE entry_id=10")
check("replaced_file_does_not_inherit_assigned_property", replaced)
def schemas_parse():
    for path in sorted((root/"contracts").glob("*.schema.json")):
        data=json.loads(path.read_text(encoding="utf-8"))
        assert data["$schema"]=="https://json-schema.org/draft/2020-12/schema"
        assert "$id" in data
check("json_schema_documents_parse",schemas_parse)
check("final_integrity_and_foreign_keys",lambda:(eq(db.execute("PRAGMA integrity_check").fetchone()[0],"ok"),
                                               eq(db.execute("PRAGMA foreign_key_check").fetchall(),[])))
report={"format":"mind-contract-tests","version":1,"date":"2026-11-16","database":":memory:",
        "sqliteVersion":sqlite3.sqlite_version,"pythonVersion":sys.version.split()[0],
        "schemaSha256":hashlib.sha256(source.read_bytes()).hexdigest(),
        "scope":"proposed schema fixture only; no Mind runtime, Base files or real migration",
        "notProven":["2-to-3 real migration/rollback","production ACL enforcement","performance","JSON Schema full validator conformance"],
        "passed":sum(x["status"]=="pass" for x in results),"failed":sum(x["status"]=="fail" for x in results),"tests":results}
db.close()
target=root/"evidence"/"contract-tests.json"
target.parent.mkdir(exist_ok=True)
target.write_text(json.dumps(report,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
print(json.dumps({"passed":report["passed"],"failed":report["failed"],"sqlite":sqlite3.sqlite_version,"file":str(target)},ensure_ascii=False))
raise SystemExit(1 if report["failed"] else 0)
