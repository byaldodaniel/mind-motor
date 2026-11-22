use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
    sync::LazyLock,
};

use regex::Regex;
use rusqlite::{params, Connection, OpenFlags};
use serde_json::{json, Map, Value};

use crate::{
    motor_destinations::file_fault,
    motor_files::{absolute_path, ensure_folder_index},
    motor_native::{fold, invalid, only, Fault},
    motor_owner::timestamp,
    motor_permissions::{self as access, Folder},
    motor_properties, scan, text_write,
};

const MAX_DOCUMENT: usize = 512 * 1024;
const DEFAULT_ALIASES: &[(&str, &str)] = &[
    ("pendiente", "pendiente"), ("pendientes", "pendiente"), ("tarea", "pendiente"), ("tareas", "pendiente"),
    ("actividad", "pendiente"), ("actividades", "pendiente"), ("todo", "pendiente"), ("todos", "pendiente"),
    ("accion", "pendiente"), ("acciones", "pendiente"), ("idea", "idea"), ("ideas", "idea"),
    ("decision", "decision"), ("decisiones", "decision"), ("bloqueo", "bloqueo"), ("bloqueos", "bloqueo"),
    ("bloqueado", "bloqueo"), ("urgente", "urgente"), ("urgentes", "urgente"),
];

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS folder_scopes (
  scope_id TEXT PRIMARY KEY, root TEXT NOT NULL, authorization_generation TEXT, generation INTEGER NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, issues_json TEXT NOT NULL DEFAULT '[]', revision TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS folder_entries (
  scope_id TEXT NOT NULL, path TEXT NOT NULL, type TEXT NOT NULL, size INTEGER, modified_at TEXT, changed_at TEXT,
  created_at TEXT, identity TEXT, state TEXT NOT NULL, reason TEXT, PRIMARY KEY (scope_id, path)
);
CREATE TABLE IF NOT EXISTS document_marks (
  scope_id TEXT NOT NULL, relative_path TEXT NOT NULL, block_index INTEGER NOT NULL, heading TEXT,
  line_number INTEGER NOT NULL, block_type TEXT NOT NULL, tag TEXT NOT NULL, raw_tag TEXT NOT NULL,
  status TEXT NOT NULL, excerpt TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (scope_id, relative_path, block_index, tag)
);
CREATE INDEX IF NOT EXISTS idx_document_marks_tag_status ON document_marks(tag, status, scope_id, relative_path);
CREATE TABLE IF NOT EXISTS tag_aliases (alias TEXT PRIMARY KEY, canonical_tag TEXT NOT NULL, user_defined INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS scanned_files (
  scope_id TEXT NOT NULL, relative_path TEXT NOT NULL, fingerprint TEXT NOT NULL, scanned_at TEXT NOT NULL,
  PRIMARY KEY (scope_id, relative_path)
);
"#;

struct Mark {
    block: i64,
    heading: Option<String>,
    line: i64,
    kind: String,
    tag: String,
    raw: String,
    status: String,
    excerpt: String,
}

type Aliases = BTreeMap<String, String>;
type Properties = BTreeMap<String, Map<String, Value>>;

fn normalize(text: &str) -> String {
    fold(text.trim().trim_start_matches('#')).split_whitespace().collect::<Vec<_>>().join("-")
}

fn canonical(value: &str, aliases: &Aliases) -> String {
    let tag = normalize(value);
    aliases.get(&tag).cloned().unwrap_or(tag)
}

fn closed(value: &str) -> bool {
    matches!(value, "cerrado" | "cerrada" | "completado" | "completada" | "hecho" | "hecha" | "resuelto" | "resuelta" | "done")
}

fn db_error(error: rusqlite::Error) -> Fault {
    let code = match error.sqlite_error_code() {
        Some(rusqlite::ErrorCode::DatabaseCorrupt | rusqlite::ErrorCode::NotADatabase) => "INDEX_CORRUPT",
        _ => "INDEX_UNAVAILABLE",
    };
    Fault::new(code, "No se pudo consultar el catálogo de marcas de Mind.")
}

fn open_catalog(base: &str, owner: &impl Fn() -> Result<(), &'static str>) -> Result<Connection, Fault> {
    const NAME: &str = "catalog.sqlite";
    scan::open_directory(base, "").map_err(file_fault)?;
    for name in [NAME, "catalog.sqlite-wal", "catalog.sqlite-shm", "catalog.sqlite-journal"] {
        match scan::open_reader_without_writers(base, name) {
            Ok(_) => (),
            Err("FILE_NOT_FOUND") if name == NAME => {
                match text_write::create_stream(base, name, owner, |_| Ok(0)) {
                    Ok(_) | Err("FILE_EXISTS") => (),
                    Err(code) => return Err(file_fault(code)),
                }
            }
            Err("FILE_NOT_FOUND") => (),
            Err(_) => return Err(Fault::new("INDEX_CORRUPT", "El catálogo SQLite o sus auxiliares no son archivos seguros.")),
        }
    }
    owner().map_err(file_fault)?;
    let flags = OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NOFOLLOW;
    let connection = Connection::open_with_flags(Path::new(base).join(NAME), flags).map_err(db_error)?;
    connection.busy_timeout(std::time::Duration::from_secs(5)).map_err(db_error)?;
    connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;").map_err(db_error)?;
    connection.execute_batch(SCHEMA).map_err(db_error)?;
    Ok(connection)
}

fn update_aliases(connection: &mut Connection, supplied: &Aliases) -> Result<Aliases, Fault> {
    let transaction = connection.transaction().map_err(db_error)?;
    {
        let mut seed = transaction.prepare("INSERT OR IGNORE INTO tag_aliases (alias,canonical_tag,user_defined) VALUES (?1,?2,0)").map_err(db_error)?;
        for (alias, tag) in DEFAULT_ALIASES { seed.execute(params![alias, tag]).map_err(db_error)?; }
        let mut set = transaction.prepare("INSERT OR REPLACE INTO tag_aliases (alias,canonical_tag,user_defined) VALUES (?1,?2,1)").map_err(db_error)?;
        for (alias, tag) in supplied { set.execute(params![alias, tag]).map_err(db_error)?; }
    }
    transaction.commit().map_err(db_error)?;
    let mut select = connection.prepare("SELECT alias, canonical_tag FROM tag_aliases").map_err(db_error)?;
    let rows = select.query_map([], |row| Ok((row.get(0)?, row.get(1)?))).map_err(db_error)?;
    rows.collect::<Result<Aliases, _>>().map_err(db_error)
}

fn with_folder(
    connection: &mut Connection, base: &str, folder: &Folder, index: &Value, aliases: &Aliases,
    owner: &impl Fn() -> Result<(), &'static str>,
) -> Result<(Vec<(String, Mark)>, usize), Fault> {
    let entries = index["entries"].as_array().map(Vec::as_slice).unwrap_or_default();
    let candidates: BTreeMap<_, _> = entries.iter().filter_map(|entry| {
        let path = entry["path"].as_str()?;
        let extension = Path::new(path).extension()?.to_str()?.to_lowercase();
        (entry["type"] == "file" && entry["state"] == "indexed" && matches!(extension.as_str(), "md" | "txt")
            && entry["size"].as_u64().is_some_and(|size| size <= MAX_DOCUMENT as u64)
            && !access::excluded(folder, &path.split('/').collect::<Vec<_>>())).then_some((path, entry))
    }).collect();
    let seen: BTreeMap<String, String> = {
        let mut select = connection.prepare("SELECT relative_path,fingerprint FROM scanned_files WHERE scope_id=?1").map_err(db_error)?;
        let rows = select.query_map(params![folder.id], |row| Ok((row.get(0)?, row.get(1)?))).map_err(db_error)?;
        rows.collect::<Result<_, _>>().map_err(db_error)?
    };
    let mut refreshed = 0;
    let transaction = connection.transaction().map_err(db_error)?;
    let now = timestamp().ok_or_else(|| file_fault("CLOCK_UNAVAILABLE"))?;
    {
        let mut delete_marks = transaction.prepare("DELETE FROM document_marks WHERE scope_id=?1 AND relative_path=?2").map_err(db_error)?;
        let mut delete_scan = transaction.prepare("DELETE FROM scanned_files WHERE scope_id=?1 AND relative_path=?2").map_err(db_error)?;
        let mut insert_mark = transaction.prepare("INSERT OR REPLACE INTO document_marks
            (scope_id,relative_path,block_index,heading,line_number,block_type,tag,raw_tag,status,excerpt,updated_at)
            VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)").map_err(db_error)?;
        let mut insert_scan = transaction.prepare("INSERT OR REPLACE INTO scanned_files
            (scope_id,relative_path,fingerprint,scanned_at) VALUES (?1,?2,?3,?4)").map_err(db_error)?;
        for old in seen.keys().filter(|path| !candidates.contains_key(path.as_str())) {
            delete_marks.execute(params![folder.id, old]).map_err(db_error)?;
            delete_scan.execute(params![folder.id, old]).map_err(db_error)?;
        }
        for (path, entry) in &candidates {
            let fingerprint = format!("{}:{}:{}", entry["size"].as_u64().unwrap_or_default(),
                entry["modifiedAt"].as_str().unwrap_or_default(), entry["identity"].as_str().unwrap_or_default());
            if seen.get(*path) == Some(&fingerprint) { continue; }
            delete_marks.execute(params![folder.id, path]).map_err(db_error)?;
            delete_scan.execute(params![folder.id, path]).map_err(db_error)?;
            let Ok(scope) = access::resolve_file(base, Some(&folder.id), path, &["leer"]) else { continue };
            if scope.generation != folder.generation { continue; }
            let Ok(Some(data)) = access::read_file(&scope.root, &scope.relative, MAX_DOCUMENT) else { continue };
            refreshed += 1;
            for mark in extract(&String::from_utf8_lossy(&data), aliases) {
                insert_mark.execute(params![folder.id, path, mark.block, mark.heading, mark.line, mark.kind,
                    mark.tag, mark.raw, mark.status, mark.excerpt, now]).map_err(db_error)?;
            }
            insert_scan.execute(params![folder.id, path, fingerprint, now]).map_err(db_error)?;
        }
    }
    let current = access::resolve_folder(base, Some(&folder.id), &["leer"])?;
    if current != *folder { return Err(file_fault("ACCESS_NOT_GRANTED")); }
    owner().map_err(file_fault)?;
    transaction.commit().map_err(db_error)?;
    let mut select = connection.prepare("SELECT relative_path,block_index,heading,line_number,block_type,tag,raw_tag,status,excerpt
        FROM document_marks WHERE scope_id=?1 ORDER BY relative_path,line_number,block_index,tag").map_err(db_error)?;
    let rows = select.query_map(params![folder.id], |row| Ok((row.get::<_, String>(0)?, Mark {
        block: row.get(1)?, heading: row.get(2)?, line: row.get(3)?, kind: row.get(4)?, tag: row.get(5)?,
        raw: row.get(6)?, status: row.get(7)?, excerpt: row.get(8)?,
    }))).map_err(db_error)?;
    let rows = rows.collect::<Result<Vec<_>, _>>().map_err(db_error)?;
    Ok((rows.into_iter().filter(|(path, _)| candidates.contains_key(path.as_str())).collect(), refreshed))
}

pub(crate) fn group(
    base: &str, args: &Map<String, Value>, owner: impl Fn() -> Result<(), &'static str>,
) -> Result<Value, Fault> {
    only(args, &["etiqueta", "estado", "agrupar_por", "carpetas", "propiedades", "alias"])?;
    let selected = select_folders(base, args.get("carpetas"))?;
    let label = text(args.get("etiqueta"), 64, true)?.map(str::trim).filter(|value| !value.is_empty());
    let status = text(args.get("estado"), 32, false)?.unwrap_or("abierto");
    if !matches!(status, "abierto" | "cerrado" | "todos") { return Err(invalid("estado debe ser abierto, cerrado o todos.")); }
    let by = text(args.get("agrupar_por"), 32, false)?.unwrap_or("proyecto");
    if !matches!(by, "proyecto" | "carpeta" | "archivo" | "etiqueta") { return Err(invalid("agrupar_por debe ser proyecto, carpeta, archivo o etiqueta.")); }
    let wanted = args.get("propiedades").map(|value| value.as_object()
        .ok_or_else(|| invalid("propiedades debe ser un objeto."))).transpose()?.cloned().unwrap_or_default();
    let aliases = parse_aliases(args.get("alias"))?;

    let mut connection = open_catalog(base, &owner)?;
    let aliases = update_aliases(&mut connection, &aliases)?;
    let target = label.map(|tag| canonical(tag, &aliases)).filter(|tag| !tag.is_empty());
    let mut items = Vec::new();
    let mut inferred = Vec::new();
    let mut coverage = Vec::new();
    let mut scanned = 0;
    let mut consulted = 0;
    let allows = |tag: &str, state: &str| {
        (status == "todos" || status == state) && target.as_deref().is_none_or(|target| target == tag)
    };
    // SQLite ordena las marcas por carpeta, ruta, línea y bloque en r3.
    let mut scopes = Vec::new();
    for folder in selected {
        match ensure_folder_index(base, &folder, &owner) {
            Ok(index) => {
                coverage.push(json!({"carpeta":folder.id,"ruta":folder.root,"estado":"buscada","indexado":index["updatedAt"]}));
                scopes.push((folder, index));
            }
            Err(error) => coverage.push(json!({"carpeta":folder.id,"ruta":folder.root,"estado":"no-disponible","codigo":error.code})),
        }
    }
    scopes.sort_by(|(a, _), (b, _)| a.id.cmp(&b.id));
    for (folder, index) in scopes {
        let (marks, count) = with_folder(&mut connection, base, &folder, &index, &aliases, &owner)?;
        consulted += 1;
        scanned += count;
        let properties = motor_properties::indexed(base, &folder, &index).unwrap_or_default();
        let projects = Projects::new(&folder, &index);
        let mut marked = BTreeSet::new();
        for (path, mark) in marks {
            let tag = if mark.raw == "task-list" { canonical(&mark.tag, &aliases) } else { canonical(&mark.raw, &aliases) };
            let props = properties.get(&path);
            if !allows(&tag, &mark.status) || !motor_properties::matches(props, &wanted) { continue; }
            marked.insert((path.clone(), tag.clone()));
            items.push(item(&folder, &projects, &path, &tag, mark, props));
        }
        property_marks(&folder, &projects, &properties, &wanted, &aliases, &marked, &allows, &mut inferred);
    }
    items.extend(inferred);
    let total = items.len();
    let groups = group_items(items, by);
    Ok(json!({
        "etiqueta_consultada":label,"etiqueta_canonica":target,"estado":status,"agrupar_por":by,
        "total":total,"grupos":groups,
        "cobertura":{"carpetas_consultadas":consulted,"archivos_escaneados_ahora":scanned,"carpetas":coverage},
    }))
}

fn text(value: Option<&Value>, limit: usize, empty: bool) -> Result<Option<&str>, Fault> {
    value.map(|value| value.as_str().filter(|text| (empty || !text.is_empty()) && text.encode_utf16().count() <= limit)
        .ok_or_else(|| invalid("Indica texto válido para agrupar."))).transpose()
}

fn select_folders(base: &str, value: Option<&Value>) -> Result<Vec<Folder>, Fault> {
    let mut selected = Vec::new();
    if let Some(value) = value {
        let list = value.as_array().filter(|list| (1..=64).contains(&list.len())).ok_or_else(|| invalid("carpetas debe ser una lista de 1 a 64 textos."))?;
        for reference in list {
            selected.push(access::resolve_folder(base, text(Some(reference), 4096, false)?, &["leer"])?);
        }
    } else {
        for folder in access::folders(base)? {
            if access::folder_access(base, &folder)?.contains(&"leer") { selected.push(folder); }
        }
    }
    if selected.is_empty() { return Err(Fault::new("ACCESS_NOT_GRANTED", "No hay carpetas con permiso para leer.")); }
    Ok(selected)
}

fn parse_aliases(value: Option<&Value>) -> Result<Aliases, Fault> {
    let mut aliases = Aliases::new();
    if let Some(value) = value {
        let map = value.as_object().ok_or_else(|| invalid("alias debe ser un objeto."))?;
        for (key, value) in map {
            let canonical = text(Some(value), 64, false)?.filter(|value| !value.trim().is_empty())
                .ok_or_else(|| invalid("Cada alias debe indicar una etiqueta canónica."))?;
            if key.trim().is_empty() || key.encode_utf16().count() > 64 { return Err(invalid("Cada alias debe ser texto corto.")); }
            let key = normalize(key);
            let canonical = normalize(canonical);
            if !key.is_empty() && !canonical.is_empty() { aliases.insert(key, canonical); }
        }
    }
    Ok(aliases)
}

struct Projects {
    root: String,
    prefixes: Vec<(String, String)>,
}

impl Projects {
    fn new(folder: &Folder, index: &Value) -> Self {
        let root = Path::new(&folder.root).file_name().and_then(|name| name.to_str()).unwrap_or(&folder.root).to_owned();
        let mut prefixes: Vec<_> = index["entries"].as_array().into_iter().flatten()
            .filter(|entry| entry["type"] == "file").filter_map(|entry| {
                let path = entry["path"].as_str()?;
                let (dir, basename) = path.rsplit_once('/').unwrap_or(("", path));
                if !basename.eq_ignore_ascii_case("proyecto.md") || access::excluded(folder, &path.split('/').collect::<Vec<_>>()) {
                    return None;
                }
                Some((dir.to_owned(), if dir.is_empty() { root.clone() } else { dir.rsplit('/').next()?.to_owned() }))
            }).collect();
        prefixes.sort_by_key(|(prefix, _)| std::cmp::Reverse(prefix.encode_utf16().count()));
        Self { root, prefixes }
    }

    fn project<'a>(&'a self, path: &'a str) -> &'a str {
        self.prefixes.iter().find(|(prefix, _)| prefix.is_empty() || prefix == path
            || path.strip_prefix(prefix).is_some_and(|rest| rest.starts_with('/')))
            .map(|(_, name)| name.as_str()).unwrap_or_else(|| path.split_once('/').map_or(&self.root, |(dir, _)| dir))
    }
}

fn item(folder: &Folder, projects: &Projects, path: &str, tag: &str, mark: Mark, props: Option<&Map<String, Value>>) -> Value {
    let mut out = json!({
        "carpeta":folder.id,"carpeta_nombre":projects.root,"proyecto":projects.project(path),"ruta":path,
        "ruta_absoluta":absolute_path(&folder.root,path),"linea":mark.line,"tipo_bloque":mark.kind,
        "etiqueta":tag,"marca_original":mark.raw,"estado":mark.status,"extracto":mark.excerpt,
    });
    if let Some(heading) = mark.heading.filter(|heading| !heading.is_empty()) { out["seccion"] = json!(heading); }
    if let Some(props) = props { out["propiedades"] = json!(props); }
    out
}

fn property_marks(
    folder: &Folder, projects: &Projects, properties: &Properties, wanted: &Map<String, Value>, aliases: &Aliases,
    marked: &BTreeSet<(String, String)>, allows: &impl Fn(&str, &str) -> bool, output: &mut Vec<Value>,
) {
    for (path, props) in properties {
        if !motor_properties::matches(Some(props), wanted) { continue; }
        let mut tags = Vec::new();
        for (key, value) in props {
            let tag = if value == true {
                Some(canonical(key, aliases))
            } else if matches!(fold(key).as_str(), "etiqueta" | "etiquetas" | "tag" | "tags" | "tipo" | "estado") {
                value.as_str().map(|value| canonical(value, aliases)).filter(|tag| !closed(tag))
            } else { None };
            if let Some(tag) = tag.filter(|tag| !tag.is_empty() && !tags.contains(tag)) { tags.push(tag); }
        }
        let status = if props.get("estado").and_then(Value::as_str).is_some_and(|v| closed(&fold(v))) { "cerrado" } else { "abierto" };
        for tag in tags {
            if !allows(&tag, status) || marked.contains(&(path.clone(), tag.clone())) { continue; }
            let text: Vec<_> = props.iter().map(|(k, v)| format!("{k}={}", v.as_str().map_or_else(|| v.to_string(), str::to_owned))).collect();
            let mark = Mark { block: 0, heading: None, line: 0, kind: "propiedad".into(), tag: tag.clone(), raw: "propiedad".into(),
                status: status.into(), excerpt: format!("{path} ({})", text.join(", ")) };
            output.push(item(folder, projects, path, &tag, mark, Some(props)));
        }
    }
}

fn group_items(items: Vec<Value>, by: &str) -> Vec<Value> {
    let key = match by { "carpeta" => "carpeta_nombre", "archivo" => "ruta_absoluta", "etiqueta" => "etiqueta", _ => "proyecto" };
    let mut groups: BTreeMap<String, (usize, Vec<Value>)> = BTreeMap::new();
    for item in items {
        let name = item[key].as_str().unwrap_or_default().to_owned();
        let (closed, items) = groups.entry(name).or_default();
        if item["estado"] == "cerrado" { *closed += 1; }
        items.push(item);
    }
    let mut groups: Vec<_> = groups.into_iter().collect();
    groups.sort_by(|(a, (_, aa)), (b, (_, bb))| bb.len().cmp(&aa.len()).then_with(|| fold(a).cmp(&fold(b))).then_with(|| a.cmp(b)));
    groups.into_iter().map(|(name, (closed, items))| json!({
        "grupo":name,"total":items.len(),"abiertos":items.len()-closed,"cerrados":closed,"elementos":items,
    })).collect()
}


macro_rules! pattern {
    ($name:ident, $regex:literal) => {
        static $name: LazyLock<Regex> = LazyLock::new(|| Regex::new($regex).expect("valid mark pattern"));
    };
}
pattern!(FENCE, r"^\s*([~]{3,}|[\x60]{3,})");
pattern!(HEADING, r"^#{1,6}\s+(.+?)\s*#*$");
pattern!(LIST, r"^(\s*)(?:[-*+]|[0-9]+\.)\s+(.*)$");
pattern!(TASK, r"^\[[ xX]\](?:\s+|$)");
pattern!(DONE_TASK, r"^\[[xX]\]");
pattern!(STATUS, r"(?i)(?:^|\b)(?:\*\*)?(?:estado|status)(?:\*\*)?:\s*([a-záéíóúñ_-]+)");
pattern!(CLOSED_TAG, r"(?i)(?:^|\s)#(?:cerrad[oa]|hech[oa]|completad[oa]|resuelt[oa]|done)");
pattern!(HASH, r"(?:^|[\s\x60(\[{\-])#([\p{L}][\p{L}\p{N}_-]{1,63})");
pattern!(PROPERTY, r"(?i)^\s*(?:[-*+]\s*)?(?:\*\*)?(?:etiquetas?|tags?|tipo|categor[ií]a|estado)(?:\*\*)?:\s*(.+)$");
pattern!(PROPERTY_TAG, r"^[\p{L}][\p{L}\p{N}_\s-]{0,40}$");
pattern!(COMMA_EXAMPLE, r"\((?:[^()]*#[\p{L}\p{N}_-]+[^()]*,)+[^()]*\)");
pattern!(NAMED_EXAMPLE, r"(?i)\((?:por\s+ejemplo|p\.?\s*ej\.?|ej\.?|como|such as|e\.g\.)\s*[^()]*#[\p{L}\p{N}_-]+[^()]*\)");
pattern!(INLINE_EXAMPLES, r"\x60#[\p{L}\p{N}_-]+\x60\s*,\s*\x60#[\p{L}\p{N}_-]+\x60(?:\s*,\s*\x60#[\p{L}\p{N}_-]+\x60)*");
pattern!(CODE, r"\x60([^\x60]*)\x60");
pattern!(BOLD, r"\*\*([^*]+)\*\*");
pattern!(STRIKE, r"~~([^~]+)~~");

fn clean_inline(text: &str) -> String {
    let text = CODE.replace_all(text, "$1");
    let text = BOLD.replace_all(&text, "$1");
    let text = STRIKE.replace_all(&text, "$1");
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn next_char(text: &str, end: usize, punctuation: &str) -> bool {
    text[end..].chars().next().is_none_or(|ch| ch.is_whitespace() || punctuation.contains(ch))
}

fn block_status(lines: &[&str], stripped: &str) -> &'static str {
    if DONE_TASK.is_match(stripped) { return "cerrado"; }
    let first = TASK.replace(stripped, "");
    let first = first.trim();
    if first.strip_prefix("~~").and_then(|value| value.strip_suffix("~~")).is_some_and(|text| !text.is_empty()) {
        return "cerrado";
    }
    let text = lines.join(" ");
    if CLOSED_TAG.find_iter(&text).any(|mark| next_char(&text, mark.end(), "\x60,.;:)!"))
        || STATUS.captures(&text).is_some_and(|parts| closed(&fold(&parts[1])))
    { "cerrado" } else { "abierto" }
}

fn block_tags(lines: &[&str], checkbox: bool, aliases: &Aliases) -> Vec<(String, String)> {
    let mut tags = Vec::new();
    let mut seen = BTreeSet::new();
    let mut push = |text: &str| {
        let raw = text.trim().trim_start_matches('#');
        let normal = normalize(raw);
        if normal.is_empty() || closed(&normal) { return; }
        let tag = canonical(&normal, aliases);
        if !tag.is_empty() && seen.insert(tag.clone()) { tags.push((tag, format!("#{raw}"))); }
    };
    for line in lines {
        let line = COMMA_EXAMPLE.replace_all(line, " ");
        let line = NAMED_EXAMPLE.replace_all(&line, " ");
        let line = INLINE_EXAMPLES.replace_all(&line, " ");
        for item in HASH.captures_iter(&line) {
            let word = item.get(1).expect("hash token");
            if next_char(&line, word.end(), "\x60)]},.;:!?") { push(word.as_str()); }
        }
        if let Some(item) = PROPERTY.captures(&line) {
            for value in item[1].split([',', ';']) {
                let text = value.trim().trim_start_matches('#').replace(['*', '\x60'], "");
                let text = text.trim();
                let normalized = fold(text);
                if !closed(&normalized) && !matches!(normalized.as_str(), "abierto" | "abierta" | "en curso")
                    && PROPERTY_TAG.is_match(text) { push(text); }
            }
        }
    }
    if checkbox && !seen.contains("pendiente") { tags.push(("pendiente".into(), "task-list".into())); }
    tags
}

fn excerpt(text: &str) -> String {
    let text = clean_inline(text);
    let mut len = 0;
    text.chars().take_while(|ch| { len += ch.len_utf16(); len <= 240 }).collect()
}

fn extract(text: &str, aliases: &Aliases) -> Vec<Mark> {
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let lines: Vec<_> = normalized.split('\n').collect();
    let mut index = 0;
    let mut block = 0;
    let mut section = None;
    let mut fence = None;
    let mut marks = Vec::new();
    while index < lines.len() {
        let first = lines[index];
        if let Some(marker) = FENCE.captures(first).and_then(|parts| parts[1].chars().next()) {
            match fence {
                None => fence = Some(marker),
                Some(current) if current == marker => fence = None,
                _ => {}
            }
            index += 1;
            continue;
        }
        if fence.is_some() || first.trim().is_empty() {
            index += 1;
            continue;
        }
        let start = index;
        index += 1;
        let heading = HEADING.captures(first.trim()).map(|parts| clean_inline(&parts[1]));
        let list = if heading.is_none() { LIST.captures(first) } else { None };
        let first_list_text = list.as_ref().and_then(|parts| parts.get(2)).map(|part| part.as_str());
        let stripped = first_list_text.unwrap_or(first);
        let kind = if heading.is_some() { "heading" } else if list.is_some() { "list-item" } else { "paragraph" };
        if heading.is_none() {
            let indent = list.as_ref().map(|parts| parts[1].encode_utf16().count());
            while let Some(next) = lines.get(index) {
                if next.trim().is_empty() || FENCE.is_match(next) || HEADING.is_match(next.trim()) { break; }
                if LIST.captures(next).is_some_and(|parts| indent.is_none_or(|indent| parts[1].encode_utf16().count() <= indent)) { break; }
                index += 1;
            }
        }
        let slice = &lines[start..index];
        let tags = block_tags(slice, first_list_text.is_some_and(|text| TASK.is_match(text)), aliases);
        if !tags.is_empty() {
            let status = block_status(slice, stripped);
            let shown = if let Some(heading) = &heading {
                excerpt(heading)
            } else if first_list_text.is_some() {
                let mut text = TASK.replace(stripped, "").into_owned();
                for next in &slice[1..] { text.push(' '); text.push_str(next.trim()); }
                excerpt(&text)
            } else {
                excerpt(&slice.join(" "))
            };
            for (tag, raw) in tags {
                marks.push(Mark { block, heading: section.clone(), line: (start + 1) as i64, kind: kind.into(),
                    tag, raw, status: status.into(), excerpt: shown.clone() });
            }
            block += 1;
        }
        if heading.is_some() { section = heading; }
    }
    marks
}
