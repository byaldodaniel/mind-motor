use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use unicode_normalization::{char::is_combining_mark, UnicodeNormalization};
use uuid::Uuid;

use crate::{
    motor_consent,
    motor_native::Fault,
    motor_owner::timestamp,
    motor_properties,
    motor_permissions::{self as access, Folder, Scope},
    motor_workspace::{relative_parts, same_path},
    office_read,
    organize::{self, Expected},
    scan, text_write,
};

const MAX_TEXT: usize = 1024 * 1024;
const MAX_INDEX_BYTES: usize = 8 * 1024 * 1024;
const MOVE_JOURNAL: &str = "conversation-relocation.json";
const MAX_INDEX_ENTRIES: usize = 100_000;
const INDEX_REFRESH_INTERVAL: Duration = Duration::from_secs(1);
const MAX_RECENT_SCANS: usize = 64;
const MAX_TRASH_ENTRIES: usize = 10_000;
const MAX_REMOVED_ENTRIES: usize = 10_000;
const RETENTION_MS: i64 = 30 * 24 * 3_600_000;
const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;
const MAX_EDITS: usize = 50;
const MAX_RESTORE_NAMES: usize = 32;

struct RecentScan {
    base: String,
    scope: Folder,
    checked: Instant,
    temporary_index: Option<Value>,
}

static RECENT_SCANS: Mutex<Vec<RecentScan>> = Mutex::new(Vec::new());

const MAX_PENDING_DIFFS: usize = 256;

#[derive(Clone)]
pub(crate) struct IndexDiff {
    pub(crate) folder_id: String,
    pub(crate) seq: u64,
    pub(crate) added: Vec<String>,
    pub(crate) modified: Vec<String>,
    pub(crate) removed: Vec<String>,
}

static NEXT_DIFF_SEQ: AtomicU64 = AtomicU64::new(1);
static PENDING_DIFFS: Mutex<Vec<(String, IndexDiff)>> = Mutex::new(Vec::new());

pub(crate) fn current_diff_seq() -> u64 {
    NEXT_DIFF_SEQ.load(Ordering::Acquire).saturating_sub(1)
}

fn push_diff(base: &str, diff: IndexDiff) {
    if let Ok(mut queue) = PENDING_DIFFS.lock() {
        if queue.len() >= MAX_PENDING_DIFFS {
            let overflow = queue.len() + 1 - MAX_PENDING_DIFFS;
            queue.drain(0..overflow);
        }
        queue.push((base.to_owned(), diff));
    }
}

pub(crate) fn drain_index_diffs(base: &str) -> Vec<IndexDiff> {
    let Ok(mut queue) = PENDING_DIFFS.lock() else {
        return Vec::new();
    };
    let mut drained = Vec::new();
    let mut kept = Vec::new();
    for (entry_base, diff) in queue.drain(..) {
        if entry_base == base {
            drained.push(diff);
        } else {
            kept.push((entry_base, diff));
        }
    }
    *queue = kept;
    drained
}

fn forget_scan(base: &str, folder: &Folder) {
    if let Ok(mut scans) = RECENT_SCANS.lock() {
        scans.retain(|scan| scan.base != base || scan.scope.id != folder.id);
    }
}

fn remember_scan(base: &str, folder: &Folder, index: Option<&Value>) {
    if let Ok(mut scans) = RECENT_SCANS.lock() {
        scans.retain(|scan| scan.checked.elapsed() < INDEX_REFRESH_INTERVAL);
        if scans.len() >= MAX_RECENT_SCANS {
            scans.remove(0);
        }
        scans.push(RecentScan {
            base: base.to_owned(),
            scope: folder.clone(),
            checked: Instant::now(),
            temporary_index: index.cloned(),
        });
    }
}

fn invalid(message: &str) -> Fault {
    Fault::new("INVALID_ARGUMENTS", message)
}

fn unsupported(message: &str) -> Fault {
    Fault::new("NOT_YET_PORTED", message)
}

fn optional<'a>(args: &'a Map<String, Value>, key: &str) -> Result<Option<&'a str>, Fault> {
    args.get(key)
        .map(|value| value.as_str().ok_or_else(|| invalid("Se esperaba un argumento de texto.")))
        .transpose()
}

fn limit(args: &Map<String, Value>, key: &str, min: u64, max: u64) -> Result<Option<u64>, Fault> {
    args.get(key)
        .map(|value| {
            value
                .as_u64()
                .filter(|number| (min..=max).contains(number))
                .ok_or_else(|| invalid("El límite numérico no es válido."))
        })
        .transpose()
}

fn only(args: &Map<String, Value>, fields: &[&str]) -> Result<(), Fault> {
    if args.keys().all(|key| fields.contains(&key.as_str())) {
        Ok(())
    } else {
        Err(invalid("La solicitud contiene argumentos no reconocidos."))
    }
}

fn fold(text: &str) -> String {
    text.nfd()
        .filter(|ch| !is_combining_mark(*ch))
        .flat_map(char::to_lowercase)
        .collect()
}

fn fold_path(text: &str) -> String {
    if cfg!(any(windows, target_os = "macos")) {
        text.to_lowercase()
    } else {
        text.to_owned()
    }
}

pub(crate) fn absolute_path(root: &str, relative: &str) -> PathBuf {
    let mut path = PathBuf::from(root);
    if !relative.is_empty() {
        for component in relative.split('/') {
            path.push(component);
        }
    }
    path
}

fn absolute(scope: &Scope) -> PathBuf {
    absolute_path(&scope.root, &scope.relative)
}

fn version(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

fn line_count(content: &str) -> usize {
    if content.is_empty() {
        0
    } else {
        content.split('\n').count() - usize::from(content.ends_with('\n'))
    }
}

fn type_out(kind: &str) -> &str {
    match kind {
        "file" => "archivo",
        "directory" => "carpeta",
        "link" => "enlace",
        "other" => "otro",
        "unknown" => "desconocido",
        other => other,
    }
}

fn type_in(kind: &str) -> Option<&'static str> {
    match kind {
        "archivo" => Some("file"),
        "carpeta" => Some("directory"),
        "enlace" => Some("link"),
        "otro" => Some("other"),
        _ => None,
    }
}

pub(crate) fn millis_to_iso(ms: i64) -> Option<String> {
    if !(0..=253_402_300_799_999).contains(&ms) {
        return None;
    }
    let days = ms.div_euclid(86_400_000);
    let day_ms = ms.rem_euclid(86_400_000);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };
    let hour = day_ms / 3_600_000;
    let minute = (day_ms % 3_600_000) / 60_000;
    let second = (day_ms % 60_000) / 1_000;
    let millis = day_ms % 1_000;
    Some(format!(
        "{year:04}-{m:02}-{d:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z"
    ))
}

pub(crate) fn iso_to_millis(text: &str) -> Option<i64> {
    let text = text.trim();
    let (date_part, time_part) = match text.split_once('T') {
        Some((d, t)) => (d, Some(t.strip_suffix('Z')?)),
        None => (text, None),
    };
    let mut d_parts = date_part.split('-');
    let year: i64 = d_parts.next()?.parse().ok()?;
    let month: i64 = d_parts.next()?.parse().ok()?;
    let day: i64 = d_parts.next()?.parse().ok()?;
    if d_parts.next().is_some() || !(1970..=9999).contains(&year) || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let y = year - i64::from(month <= 2);
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = if month > 2 { month - 3 } else { month + 9 };
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let (hour, minute, second, millis) = if let Some(time_str) = time_part {
        let mut t_parts = time_str.split(':');
        let h: i64 = t_parts.next()?.parse().ok()?;
        let m: i64 = t_parts.next()?.parse().ok()?;
        let sec_part = t_parts.next()?;
        if t_parts.next().is_some() || !(0..=23).contains(&h) || !(0..=59).contains(&m) {
            return None;
        }
        let (s, ms) = match sec_part.split_once('.') {
            Some((s_str, ms_str)) => {
                if ms_str.len() != 3 || !ms_str.bytes().all(|b| b.is_ascii_digit()) {
                    return None;
                }
                (s_str.parse::<i64>().ok()?, ms_str.parse::<i64>().ok()?)
            }
            None => (sec_part.parse::<i64>().ok()?, 0),
        };
        if !(0..=59).contains(&s) {
            return None;
        }
        (h, m, s, ms)
    } else {
        (0, 0, 0, 0)
    };
    Some(days * 86_400_000 + hour * 3_600_000 + minute * 60_000 + second * 1_000 + millis)
}

fn now_iso() -> Result<String, Fault> {
    timestamp().ok_or_else(|| Fault::new("CLOCK_UNAVAILABLE", "No se pudo consultar la hora del sistema."))
}

pub(crate) fn write_base_json(
    base: &str, name: &str, value: &Value, previous: Option<&[u8]>,
    confirm_owner: impl FnOnce() -> Result<(), &'static str>,
) -> Result<(), Fault> {
    let mut bytes = serde_json::to_vec_pretty(value)
        .map_err(|_| Fault::new("WRITE_FAILED", "No se pudo serializar el registro técnico."))?;
    bytes.push(b'\n');
    let expected = previous.map(|data| format!("{:x}", Sha256::digest(data)));
    text_write::write_bytes(base, name, &bytes, MAX_INDEX_BYTES, expected.as_deref(), confirm_owner)
        .map(|_| ())
        .map_err(|code| Fault::new(code, "No se pudo guardar el registro técnico en la Base."))
}

pub(crate) fn read_base_stored(base: &str, name: &str) -> Result<Option<(Value, Vec<u8>)>, Fault> {
    let Some(bytes) = access::read_file(base, name, MAX_INDEX_BYTES)? else {
        return Ok(None);
    };
    let value = serde_json::from_slice(&bytes)
        .map_err(|_| Fault::new("RECORD_CORRUPT", "El registro técnico no contiene JSON válido."))?;
    Ok(Some((value, bytes)))
}

fn verify(base: &str, scope: &Scope, required: &[&str]) -> Result<(), Fault> {
    if access::resolve_file(base, Some(&scope.id), &scope.relative, required)? != *scope {
        return Err(Fault::new(
            "ACCESS_NOT_GRANTED",
            "La autorización de la carpeta cambió durante la operación.",
        ));
    }
    Ok(())
}

fn validate_relative_path(relative: &str, code: &'static str) -> Result<Vec<String>, Fault> {
    if relative.is_empty() || relative.encode_utf16().count() > 4096 {
        return Err(Fault::new(code, "Indica una ruta relativa válida."));
    }
    let parts: Vec<String> = relative.split('/').map(str::to_owned).collect();
    if !parts.iter().all(|part| scan::reader_component(part)) {
        return Err(Fault::new(code, "La ruta relativa contiene componentes inseguros."));
    }
    Ok(parts)
}

fn guard_organize_path(folder: &Folder, relative: &str, container: bool) -> Result<Vec<String>, Fault> {
    let parts = validate_relative_path(relative, "INVALID_ORGANIZE_PATH")?;
    let refs: Vec<&str> = parts.iter().map(String::as_str).collect();
    if access::excluded(folder, &refs) || (container && access::contains_excluded(folder, &refs)) {
        return Err(Fault::new("PATH_EXCLUDED", "El usuario excluyó esa ubicación del acceso de Mind."));
    }
    Ok(parts)
}

fn index_file(id: &str) -> String {
    format!("folder-index-{id}.json")
}

fn trash_file(id: &str) -> String {
    format!("trash-{id}.json")
}

fn removed_file(id: &str) -> String {
    format!("folder-removed-{id}.json")
}

fn valid_persisted_index(data: &Value, folder: &Folder) -> bool {
    data["format"] == "mind-folder-index"
        && matches!(data["version"].as_u64(), Some(2 | 3))
        && data["scopeId"].as_str() == Some(folder.id.as_str())
        && data["root"].as_str().is_some_and(|root| same_path(&folder.root, Path::new(root)))
        && data["generation"].as_u64().is_some_and(|g| g >= 1)
        && data["createdAt"].as_str().and_then(iso_to_millis).is_some()
        && data["updatedAt"].as_str().and_then(iso_to_millis).is_some()
        && data["entries"].is_array()
        && data["issues"].is_array()
        && data["authorizationGeneration"].as_str() == folder.generation.as_deref()
}

pub(crate) fn load_persisted_index(base: &str, folder: &Folder) -> Result<Option<(Value, Vec<u8>)>, Fault> {
    let Some((data, bytes)) = read_base_stored(base, &index_file(&folder.id))? else {
        return Ok(None);
    };
    if data["format"] != "mind-folder-index"
        || !matches!(data["version"].as_u64(), Some(1..=3))
        || data["scopeId"].as_str() != Some(folder.id.as_str())
        || !data["entries"].is_array()
        || !data["issues"].is_array()
    {
        return Err(Fault::new("INDEX_CORRUPT", "El índice guardado no tiene el formato esperado."));
    }
    if !valid_persisted_index(&data, folder) {
        return Ok(None);
    }
    Ok(Some((data, bytes)))
}

pub(crate) fn index_summary(base: &str, folder: &Folder) -> Value {
    match load_persisted_index(base, folder) {
        Ok(Some((index, _))) => {
            let entries = index["entries"].as_array().map(Vec::len).unwrap_or(0);
            let files = index["entries"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|entry| entry["type"] == "file")
                .count();
            let complete = index["issues"].as_array().is_some_and(Vec::is_empty)
                && index["entries"]
                    .as_array()
                    .is_some_and(|list| list.iter().all(|entry| entry["state"] == "indexed"));
            json!({
                "estado": "vigente",
                "entradas": entries,
                "archivos": files,
                "actualizado": index["updatedAt"],
                "completo": complete,
            })
        }
        Ok(None) => json!({"estado": "sin-indice"}),
        Err(error) => json!({"estado": "no-disponible", "codigo": error.code}),
    }
}

fn index_entry(path: &str, kind: &str, metadata: &Value) -> Value {
    let time = |key: &str| metadata[key].as_i64().and_then(millis_to_iso);
    json!({
        "path": path, "type": kind, "state": "indexed", "reason": Value::Null,
        "size": if kind == "file" { json!(metadata["size"].as_u64().unwrap_or(0)) } else { Value::Null },
        "modifiedAt": time("modifiedMs"), "changedAt": time("changedMs"),
        "createdAt": metadata["createdMs"].as_i64().filter(|ms| *ms > 0).and_then(millis_to_iso),
        "identity": metadata["identity"].as_str(),
    })
}

fn scan_folder_tree(folder: &Folder, prefix: &str, depth: usize) -> Result<(Vec<Value>, Vec<Value>), Fault> {
    let mut entries = Vec::new();
    let mut issues = Vec::new();
    // Walk only the named ancestors until the requested directory is reached.
    // Use the names returned by the scanner so aliases cannot bypass exclusions.
    let mut reached = prefix.is_empty();
    let mut queue = VecDeque::from([(String::new(), 0usize)]);
    while let Some((rel, level)) = queue.pop_front() {
        let inside = reached;
        let remaining = MAX_INDEX_ENTRIES.saturating_sub(entries.len()).max(1);
        match scan::scan_directory(&folder.root, &rel, remaining + 1) {
            Ok((items, complete)) => {
                if !complete {
                    return Err(Fault::new("INDEX_LIMIT_EXCEEDED", "El recorrido de la carpeta superó el límite del índice."));
                }
                for item in items {
                    let Some(name) = item["name"].as_str() else { continue };
                    if !scan::reader_component(name) {
                        continue;
                    }
                    let path = if rel.is_empty() {
                        name.to_owned()
                    } else {
                        format!("{rel}/{name}")
                    };
                    let parts: Vec<&str> = path.split('/').collect();
                    if access::excluded(folder, &parts) {
                        continue;
                    }
                    let kind = item["type"].as_str().unwrap_or("other");
                    if !inside {
                        if kind == "directory" && (path == prefix || prefix.strip_prefix(&path).is_some_and(|tail| tail.starts_with('/'))) {
                            reached = path == prefix;
                            queue.push_back((path, 0));
                        }
                        continue;
                    }
                    if entries.len() >= MAX_INDEX_ENTRIES {
                        return Err(Fault::new(
                            "INDEX_LIMIT_EXCEEDED",
                            "La carpeta supera el límite de entradas indexables.",
                        ));
                    }
                    entries.push(index_entry(&path, kind, &item));
                    if kind == "directory" && level + 1 < depth {
                        queue.push_back((path, level + 1));
                    }
                }
            }
            Err(scan::ScanError(code, _)) => {
                if rel.is_empty() || !inside || rel == prefix {
                    return Err(Fault::new(code, "La carpeta solicitada no existe o no es accesible."));
                }
                if let Some(dir_entry) = entries.iter_mut().find(|e| e["path"].as_str() == Some(rel.as_str())) {
                    dir_entry["state"] = json!("not-listed");
                    dir_entry["reason"] = json!(code);
                }
                issues.push(json!({"code": code, "path": rel}));
            }
        }
    }
    if !reached {
        return Err(Fault::new("PATH_NOT_INDEXED", "La subcarpeta no figura como carpeta accesible."));
    }
    entries.sort_by(|left, right| {
        let a = left["path"].as_str().unwrap_or_default();
        let b = right["path"].as_str().unwrap_or_default();
        a.encode_utf16().cmp(b.encode_utf16())
    });
    issues.sort_by(|left, right| {
        let a = left["path"].as_str().unwrap_or_default();
        let b = right["path"].as_str().unwrap_or_default();
        a.encode_utf16().cmp(b.encode_utf16())
    });
    Ok((entries, issues))
}

fn record_removed_entries(
    base: &str, folder: &Folder, removed_entries: &[Value], by: &str,
    confirm_owner: impl Fn() -> Result<(), &'static str>,
) -> Result<usize, Fault> {
    if removed_entries.is_empty() {
        return Ok(0);
    }
    let is_registered = access::registered_folders(base)?.iter().any(|f| f.id == folder.id);
    if !is_registered {
        return Ok(0);
    }
    let removed_at = now_iso()?;
    let now_ms = iso_to_millis(&removed_at).unwrap_or(0);
    let mut fresh = Vec::new();
    let mut replaced = BTreeSet::new();
    for entry in removed_entries {
        let Some(path) = entry["path"].as_str() else { continue };
        let parts: Vec<&str> = path.split('/').collect();
        if access::excluded(folder, &parts) {
            continue;
        }
        replaced.insert(path.to_owned());
        fresh.push(json!({
            "path": path,
            "type": entry["type"],
            "size": entry["size"],
            "modifiedAt": entry["modifiedAt"],
            "removedAt": removed_at,
            "by": by,
        }));
    }
    if fresh.is_empty() {
        return Ok(0);
    }
    let file = removed_file(&folder.id);
    let previous = read_base_stored(base, &file)?;
    let mut known: Vec<Value> = previous
        .as_ref()
        .filter(|(data, _)| {
            data["format"] == "mind-folder-removed"
                && data["version"] == 1
                && data["generation"].as_str() == folder.generation.as_deref()
        })
        .and_then(|(data, _)| data["entries"].as_array().cloned())
        .unwrap_or_default()
        .into_iter()
        .filter(|item| {
            let Some(path) = item["path"].as_str() else { return false };
            if replaced.contains(path) {
                return false;
            }
            item["removedAt"]
                .as_str()
                .and_then(iso_to_millis)
                .is_some_and(|t| now_ms - t <= RETENTION_MS)
        })
        .collect();
    let count = fresh.len();
    known.extend(fresh);
    known.sort_by(|a, b| a["removedAt"].as_str().cmp(&b["removedAt"].as_str()));
    if known.len() > MAX_REMOVED_ENTRIES {
        let drop_count = known.len() - MAX_REMOVED_ENTRIES;
        known.drain(0..drop_count);
    }
    let record = json!({
        "format": "mind-folder-removed",
        "version": 1,
        "folderId": folder.id,
        "generation": folder.generation,
        "entries": known,
    });
    write_base_json(base, &file, &record, previous.as_ref().map(|(_, b)| b.as_slice()), confirm_owner)?;
    Ok(count)
}

fn missing_index_entries(
    folder: &Folder, previous: &Value, entries: &[Value], issues: &[Value],
) -> (Vec<Value>, Vec<Value>) {
    let current: BTreeSet<&str> = entries.iter().filter_map(|entry| entry["path"].as_str()).collect();
    let blocked: BTreeMap<&str, &str> = issues.iter()
        .filter_map(|issue| Some((issue["path"].as_str()?, issue["code"].as_str()?)))
        .collect();
    let mut carried = Vec::new();
    let mut disappeared = Vec::new();
    for entry in previous["entries"].as_array().into_iter().flatten() {
        let Some(path) = entry["path"].as_str() else { continue };
        if current.contains(path) || access::excluded(folder, &path.split('/').collect::<Vec<_>>()) {
            continue;
        }
        if let Some((_, reason)) = path.match_indices('/').rev()
            .find_map(|(end, _)| blocked.get_key_value(&path[..end]))
        {
            // Una carpeta sin listar no demuestra que sus archivos se borraron.
            let mut entry = entry.clone();
            entry["state"] = json!("unverified");
            entry["reason"] = json!(reason);
            carried.push(entry);
        } else {
            disappeared.push(entry.clone());
        }
    }
    (carried, disappeared)
}

fn reconcile_index_detailed(
    base: &str, folder: &Folder, track_external: bool,
    confirm_owner: impl Fn() -> Result<(), &'static str>,
) -> Result<(Value, Value), Fault> {
    forget_scan(base, folder);
    let now = now_iso()?;
    let is_registered = access::registered_folders(base)?.iter().any(|f| f.id == folder.id);
    let previous = if is_registered {
        read_base_stored(base, &index_file(&folder.id))?
    } else {
        None
    };
    let same_gen_prev = previous
        .as_ref()
        .filter(|(data, _)| valid_persisted_index(data, folder))
        .map(|(data, _)| data);
    let (mut entries, issues) = scan_folder_tree(folder, "", usize::MAX)?;
    let (stats, pending_diff) = if let Some(prev_data) = same_gen_prev {
        let (carried, disappeared) = missing_index_entries(folder, prev_data, &entries, &issues);
        if !carried.is_empty() {
            if entries.len() + carried.len() > MAX_INDEX_ENTRIES {
                return Err(Fault::new("INDEX_LIMIT_EXCEEDED", "La carpeta supera el límite de entradas indexables."));
            }
            entries.extend(carried);
            entries.sort_by(|left, right| {
                let a = left["path"].as_str().unwrap_or_default();
                let b = right["path"].as_str().unwrap_or_default();
                a.encode_utf16().cmp(b.encode_utf16())
            });
        }
        let mut prev_map: BTreeMap<&str, &Value> = BTreeMap::new();
        for item in prev_data["entries"].as_array().into_iter().flatten() {
            if let Some(p) = item["path"].as_str() {
                prev_map.insert(p, item);
            }
        }
        let mut added_paths = Vec::new();
        let mut modified_paths = Vec::new();
        for entry in &entries {
            let Some(p) = entry["path"].as_str() else { continue };
            match prev_map.get(p) {
                None => added_paths.push(p.to_owned()),
                Some(prev) if *prev != entry => modified_paths.push(p.to_owned()),
                Some(_) => {}
            }
        }
        let removed_paths: Vec<String> = disappeared
            .iter()
            .filter_map(|item| item["path"].as_str().map(str::to_owned))
            .collect();
        let added = added_paths.len();
        let modified = modified_paths.len();
        let removed = disappeared.len();
        if track_external && !disappeared.is_empty() {
            record_removed_entries(base, folder, &disappeared, "externo", &confirm_owner)?;
        }
        let stats = json!({
            "modo": "reconciliacion",
            "entradas": entries.len(),
            "agregados": added,
            "modificados": modified,
            "eliminados": removed,
        });
        if prev_data["entries"] == json!(entries) && prev_data["issues"] == json!(issues) {
            remember_scan(base, folder, None);
            return Ok((prev_data.clone(), stats));
        }
        let diff = if is_registered
            && (!added_paths.is_empty() || !modified_paths.is_empty() || !removed_paths.is_empty())
        {
            Some(IndexDiff {
                folder_id: folder.id.clone(),
                seq: NEXT_DIFF_SEQ.fetch_add(1, Ordering::AcqRel),
                added: added_paths,
                modified: modified_paths,
                removed: removed_paths,
            })
        } else {
            None
        };
        (stats, diff)
    } else {
        (
            json!({
                "modo": "inicial",
                "entradas": entries.len(),
                "agregados": Value::Null,
                "modificados": Value::Null,
                "eliminados": Value::Null,
            }),
            None,
        )
    };
    let generation = same_gen_prev
        .and_then(|d| d["generation"].as_u64())
        .unwrap_or(0)
        .saturating_add(1);
    let created_at = same_gen_prev
        .and_then(|d| d["createdAt"].as_str())
        .unwrap_or(&now)
        .to_owned();
    let record = json!({
        "authorizationGeneration": folder.generation,
        "createdAt": created_at,
        "entries": entries,
        "format": "mind-folder-index",
        "generation": generation,
        "issues": issues,
        "root": folder.root,
        "scopeId": folder.id,
        "updatedAt": now,
        "version": 3,
    });
    if is_registered {
        write_base_json(
            base,
            &index_file(&folder.id),
            &record,
            previous.as_ref().map(|(_, b)| b.as_slice()),
            &confirm_owner,
        )?;
    }
    if let Some(diff) = pending_diff {
        push_diff(base, diff);
    }
    remember_scan(base, folder, (!is_registered).then_some(&record));
    Ok((record, stats))
}

fn reconcile_folder_index_inner(
    base: &str, folder: &Folder, track_external: bool,
    confirm_owner: impl Fn() -> Result<(), &'static str>,
) -> Result<Value, Fault> {
    reconcile_index_detailed(base, folder, track_external, confirm_owner).map(|(record, _)| record)
}

pub(crate) fn reconcile_folder_index(
    base: &str, folder: &Folder,
    confirm_owner: impl Fn() -> Result<(), &'static str>,
) -> Result<Value, Fault> {
    reconcile_folder_index_inner(base, folder, true, confirm_owner)
}

pub(crate) fn index_folder_with_stats(
    base: &str, folder: &Folder,
    confirm_owner: impl Fn() -> Result<(), &'static str>,
) -> Result<Value, Fault> {
    let (_record, stats) = reconcile_index_detailed(base, folder, true, confirm_owner)?;
    Ok(json!({
        "carpeta": folder.id,
        "estado": "reconciliada",
        "modo": stats["modo"],
        "entradas": stats["entradas"],
        "agregados": stats["agregados"],
        "modificados": stats["modificados"],
        "eliminados": stats["eliminados"],
    }))
}

pub(crate) fn reconcile_index_by_id(
    base: &str, folder_id: &str,
    confirm_owner: impl Fn() -> Result<(), &'static str>,
) -> Result<Value, Fault> {
    let folder = access::folders(base)?
        .into_iter()
        .find(|f| f.id == folder_id)
        .ok_or_else(|| Fault::new("FOLDER_NOT_AUTHORIZED", "La carpeta no está autorizada."))?;
    reconcile_folder_index(base, &folder, confirm_owner)
}

#[derive(Clone, Copy, PartialEq)]
pub(crate) enum IndexChange {
    CreateDirectory,
    CreateFile,
    ModifyFile,
    ObserveFile,
}

pub(crate) fn refresh_index_after_write(
    base: &str, scope: &Scope, change: IndexChange,
    confirm_owner: impl Fn() -> Result<(), &'static str>,
) -> Result<bool, Fault> {
    let required: &[&str] = match change {
        IndexChange::CreateDirectory => &["organizar"],
        IndexChange::ObserveFile => &["escribir", "encontrar"],
        _ => &["escribir"],
    };
    let folder = access::resolve_folder(base, Some(&scope.id), required)?;
    // A known write is not a full scan. The next search must still discover external changes.
    forget_scan(base, &folder);
    let uncertain = || Fault::new("INDEX_NEEDS_RECONCILIATION", "La entrada requiere una reconciliación del índice.");
    if folder.root != scope.root || folder.generation != scope.generation { return Err(uncertain()); }
    if !access::registered_folders(base)?.contains(&folder) { return Ok(false); }
    let Some((mut index, previous)) = load_persisted_index(base, &folder)? else { return Ok(false); };
    let generation = index["generation"].as_u64().filter(|n| *n < MAX_SAFE_INTEGER).ok_or_else(uncertain)?;
    let entries = index["entries"].as_array_mut().ok_or_else(uncertain)?;
    // Older persisted indexes also use JavaScript's UTF-16 ordering. A corrupt or unsorted
    // list cannot be patched safely: preserve it until an explicit reconciliation.
    let mut previous_path: Option<&str> = None;
    for entry in entries.iter() {
        let path = entry["path"].as_str().filter(|path| !path.is_empty()).ok_or_else(uncertain)?;
        if previous_path.is_some_and(|p| !p.encode_utf16().cmp(path.encode_utf16()).is_lt()) {
            return Err(uncertain());
        }
        previous_path = Some(path);
    }
    let locate = |path: &str| entries.binary_search_by(|entry| {
        entry["path"].as_str().unwrap_or_default().encode_utf16().cmp(path.encode_utf16())
    });
    let path = scope.relative.as_str();
    for (end, _) in path.match_indices('/') {
        let parent = locate(&path[..end]).ok().map(|pos| &entries[pos]).ok_or_else(uncertain)?;
        if parent["type"] != "directory" || parent["state"] != "indexed" { return Err(uncertain()); }
    }
    let directory = change == IndexChange::CreateDirectory;
    let kind = if directory { "directory" } else { "file" };
    verify(base, scope, required)?;
    let metadata = organize::index_metadata(&scope.root, path, directory)
        .map_err(|code| Fault::new(code, "No se pudieron verificar los metadatos de la entrada publicada."))?;
    let next = index_entry(path, kind, &metadata);
    let added = match locate(path) {
        Ok(pos) => {
            if entries[pos] == next { return Ok(true); }
            if matches!(change, IndexChange::CreateFile | IndexChange::CreateDirectory)
                || entries[pos]["type"] != kind || entries[pos]["state"] != "indexed" { return Err(uncertain()); }
            entries[pos] = next;
            false
        }
        Err(pos) => {
            if change == IndexChange::ModifyFile || entries.len() >= MAX_INDEX_ENTRIES { return Err(uncertain()); }
            entries.insert(pos, next);
            true
        }
    };
    index["generation"] = json!(generation + 1);
    // updatedAt records the last full scan, including external arrivals and deletions.
    write_base_json(base, &index_file(&folder.id), &index, Some(&previous), || {
        confirm_owner()?;
        verify(base, scope, required).map_err(|error| error.code)
    })?;
    forget_scan(base, &folder);
    push_diff(base, IndexDiff {
        folder_id: folder.id, seq: NEXT_DIFF_SEQ.fetch_add(1, Ordering::AcqRel),
        added: if added { vec![path.to_owned()] } else { Vec::new() },
        modified: if added { Vec::new() } else { vec![path.to_owned()] },
        removed: Vec::new(),
    });
    Ok(true)
}

pub(crate) fn ensure_folder_index(
    base: &str, folder: &Folder,
    confirm_owner: impl Fn() -> Result<(), &'static str>,
) -> Result<Value, Fault> {
    // Agrupa consultas consecutivas aunque comprobar el disco no haya
    // cambiado el índice persistido. La autorización debe seguir vigente.
    let recent = RECENT_SCANS.lock().ok().and_then(|mut scans| {
        scans.retain(|scan| scan.checked.elapsed() < INDEX_REFRESH_INTERVAL);
        scans.iter()
            .find(|scan| scan.base == base && scan.scope == *folder)
            .map(|scan| scan.temporary_index.clone())
    });
    match recent {
        Some(Some(index)) => return Ok(index),
        Some(None) => {
            if let Some((index, _)) = load_persisted_index(base, folder)? {
                return Ok(index);
            }
        }
        None => {}
    }
    reconcile_folder_index(base, folder, confirm_owner)
}

pub(crate) fn prune_excluded_from_index(
    base: &str, folder: &Folder,
    confirm_owner: impl Fn() -> Result<(), &'static str>,
) -> Result<usize, Fault> {
    let Some((mut data, prev_bytes)) = load_persisted_index(base, folder)? else {
        return Ok(0);
    };
    let before = data["entries"].as_array().map(Vec::len).unwrap_or(0);
    let filtered_entries: Vec<Value> = data["entries"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|entry| {
            entry["path"].as_str().is_some_and(|path| {
                let parts: Vec<&str> = path.split('/').collect();
                !access::excluded(folder, &parts)
            })
        })
        .cloned()
        .collect();
    let removed = before.saturating_sub(filtered_entries.len());
    if removed == 0 {
        return Ok(0);
    }
    let filtered_issues: Vec<Value> = data["issues"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|issue| {
            issue["path"].as_str().is_some_and(|path| {
                if path.is_empty() {
                    return true;
                }
                let parts: Vec<&str> = path.split('/').collect();
                !access::excluded(folder, &parts)
            })
        })
        .cloned()
        .collect();
    let next_gen = data["generation"].as_u64().unwrap_or(1).saturating_add(1);
    data["entries"] = json!(filtered_entries);
    data["issues"] = json!(filtered_issues);
    data["generation"] = json!(next_gen);
    data["updatedAt"] = json!(now_iso()?);
    write_base_json(base, &index_file(&folder.id), &data, Some(&prev_bytes), confirm_owner)?;
    Ok(removed)
}

fn entry_out(folder: &Folder, entry: &Value) -> Value {
    let path = entry["path"].as_str().unwrap_or_default();
    let name = path.rsplit_once('/').map(|(_, n)| n).unwrap_or(path);
    let state = match entry["state"].as_str() {
        Some("indexed") => "indexado",
        Some("not-listed") => "sin-listar",
        _ => "sin-verificar",
    };
    let mut out = json!({
        "carpeta": folder.id,
        "ruta": path,
        "nombre": name,
        "tipo": type_out(entry["type"].as_str().unwrap_or("other")),
        "bytes": entry["size"],
        "modificado": entry["modifiedAt"],
        "creado": entry["createdAt"],
        "estado": state,
        "ruta_absoluta": absolute_path(&folder.root, path),
    });
    if let Some(reason) = entry["reason"].as_str() {
        out["motivo"] = json!(reason);
    }
    out
}

fn heading_key(value: &str) -> String {
    let trimmed = value.trim_start().trim_start_matches('#').trim_start();
    trimmed
        .nfd()
        .filter(|ch| !is_combining_mark(*ch) && !matches!(*ch, '*' | '_' | '`'))
        .flat_map(char::to_lowercase)
        .collect::<String>()
        .trim()
        .to_owned()
}

fn markdown_headings<'a>(content: &'a str) -> (Vec<&'a str>, Vec<Value>) {
    let lines: Vec<&'a str> = content.split('\n').map(|line| line.strip_suffix('\r').unwrap_or(line)).collect();
    let mut headings = Vec::new();
    let mut fence: Option<&str> = None;
    for (idx, line) in lines.iter().enumerate() {
        let trimmed_start = line.trim_start();
        let marker = if trimmed_start.starts_with("```") {
            Some("```")
        } else if trimmed_start.starts_with("~~~") {
            Some("~~~")
        } else {
            None
        };
        if let Some(m) = marker {
            if fence == Some(m) {
                fence = None;
            } else if fence.is_none() {
                fence = Some(m);
            }
            continue;
        }
        if fence.is_some() {
            continue;
        }
        let hashes = line.bytes().take_while(|b| *b == b'#').count();
        if (1..=6).contains(&hashes) {
            let rest = &line[hashes..];
            if rest.starts_with(char::is_whitespace) {
                let title = rest.trim().trim_end_matches('#').trim();
                if !title.is_empty() {
                    headings.push(json!({
                        "nivel": hashes,
                        "titulo": title,
                        "linea": idx + 1,
                    }));
                }
            }
        }
    }
    (lines, headings)
}

fn apply_section(mut meta: Value, content: &str, seccion: &str) -> Value {
    let (lines, headings) = markdown_headings(content);
    if seccion.trim() == "?" {
        meta["indice"] = json!(headings);
        return meta;
    }
    let key = heading_key(seccion);
    let found_idx = headings
        .iter()
        .position(|h| h["titulo"].as_str().is_some_and(|t| heading_key(t) == key))
        .or_else(|| {
            headings
                .iter()
                .position(|h| h["titulo"].as_str().is_some_and(|t| heading_key(t).contains(&key)))
        });
    let Some(idx) = found_idx else {
        meta["encontrado"] = json!(false);
        meta["seccion_pedida"] = json!(seccion);
        meta["indice"] = json!(headings);
        return meta;
    };
    let found = &headings[idx];
    let start_line = found["linea"].as_u64().unwrap_or(1) as usize;
    let level = found["nivel"].as_u64().unwrap_or(1);
    let end_line = headings[idx + 1..]
        .iter()
        .find(|h| h["nivel"].as_u64().unwrap_or(1) <= level)
        .and_then(|h| h["linea"].as_u64())
        .map(|line| (line as usize).saturating_sub(1))
        .unwrap_or(lines.len());
    let section_text = lines[start_line.saturating_sub(1)..end_line.min(lines.len())].join("\n");
    meta["seccion"] = json!({
        "titulo": found["titulo"],
        "nivel": found["nivel"],
        "desde_linea": start_line,
        "hasta_linea": end_line,
    });
    meta["contenido"] = json!(section_text);
    meta
}

fn read(base: &str, args: &Map<String, Value>, folder: Option<&str>, relative: &str) -> Result<Value, Fault> {
    only(args, &["carpeta", "ruta", "seccion", "desde_linea", "lineas"])?;
    let seccion = optional(args, "seccion")?;
    let from = limit(args, "desde_linea", 1, MAX_SAFE_INTEGER)?;
    let count = limit(args, "lineas", 1, MAX_SAFE_INTEGER)?;
    if seccion.is_some() && (from.is_some() || count.is_some()) {
        return Err(invalid("Usa seccion o desde_linea/lineas, no ambos."));
    }
    let scope = access::resolve_file(base, folder, relative, &["leer"])?;
    let extension = Path::new(relative)
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let slice_lines = |text: &str| -> String {
        if from.is_some() || count.is_some() {
            let start = usize::try_from(from.unwrap_or(1) - 1).unwrap_or(usize::MAX);
            let take = count.and_then(|c| usize::try_from(c).ok()).unwrap_or(usize::MAX);
            text.split('\n').skip(start).take(take).collect::<Vec<_>>().join("\n")
        } else {
            text.to_owned()
        }
    };
    if matches!(extension.as_str(), "docx" | "xlsx" | "pptx" | "odt" | "ods" | "odp") {
        let (text, truncated, bytes) = office_read::extract_document(
            &scope.root,
            &scope.relative,
            &extension,
            || verify(base, &scope, &["leer"]).map_err(|e| e.code),
        )
        .map_err(|code| Fault::new(code, "No se pudo extraer el texto del documento de oficina."))?;
        let mut meta = json!({
            "carpeta": scope.id,
            "ruta": scope.relative,
            "ruta_absoluta": absolute(&scope),
            "formato": extension,
            "bytes": bytes,
            "lineas": line_count(&text),
            "truncado": truncated,
            "nota": "Texto extraído para leer. Mind no modifica este formato; para cambiarlo usa la aplicación correspondiente.",
        });
        if let Some(sec) = seccion {
            return Ok(apply_section(meta, &text, sec));
        }
        let shown = slice_lines(&text);
        meta["contenido"] = json!(shown);
        return Ok(meta);
    }

    let bytes = access::read_file(&scope.root, &scope.relative, MAX_TEXT)?
        .ok_or_else(|| Fault::new("FILE_NOT_FOUND", "No se encontró el archivo."))?;
    let content = std::str::from_utf8(&bytes)
        .ok()
        .filter(|text| !text.contains('\0'))
        .ok_or_else(|| Fault::new("TEXT_UNREADABLE", "El archivo no contiene texto UTF-8 válido."))?;
    verify(base, &scope, &["leer"])?;
    let lines = line_count(content);
    let mut meta = json!({
        "carpeta": scope.id,
        "ruta": scope.relative,
        "ruta_absoluta": absolute(&scope),
        "version": version(&bytes),
        "bytes": bytes.len(),
        "lineas": lines,
    });
    if let Some(sec) = seccion {
        return Ok(apply_section(meta, content, sec));
    }
    let shown = slice_lines(content);
    if shown != content {
        meta["mostrado"] = json!({"desde_linea": from.unwrap_or(1), "lineas": count});
    }
    meta["contenido"] = json!(shown);
    Ok(meta)
}

fn parse_expected_version(raw: &str) -> Result<&str, Fault> {
    raw.strip_prefix("sha256:")
        .filter(|digest| digest.len() == 64 && digest.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
        .ok_or_else(|| Fault::new("INVALID_VERSION", "Indica la versión leída del archivo como sha256:<64 hex>."))
}

fn edit_text(
    base: &str, args: &Map<String, Value>, folder: Option<&str>, relative: &str,
    confirm_owner: impl Fn() -> Result<(), &'static str>,
) -> Result<Value, Fault> {
    only(args, &["carpeta", "ruta", "version", "ediciones"])?;
    let expected_arg = optional(args, "version")?;
    if let Some(v) = expected_arg {
        parse_expected_version(v)?;
    }
    let edits = args
        .get("ediciones")
        .and_then(Value::as_array)
        .filter(|list| (1..=MAX_EDITS).contains(&list.len()))
        .ok_or_else(|| invalid("ediciones debe ser una lista de 1 a 50 reemplazos."))?;
    let scope = access::resolve_file(base, folder, relative, &["leer", "escribir"])?;
    let bytes = access::read_file(&scope.root, &scope.relative, MAX_TEXT)?
        .ok_or_else(|| Fault::new("FILE_NOT_FOUND", "No se encontró el archivo."))?;
    let content = std::str::from_utf8(&bytes)
        .ok()
        .filter(|text| !text.contains('\0'))
        .ok_or_else(|| Fault::new("TEXT_UNREADABLE", "El archivo no contiene texto UTF-8 válido."))?;
    let current_version = version(&bytes);
    if let Some(expected) = expected_arg {
        if expected != current_version {
            return Err(Fault::new(
                "VERSION_CONFLICT",
                "El archivo cambió desde la versión indicada; no se modifica.",
            ));
        }
    }
    let mut next = content.to_owned();
    let mut applied = Vec::with_capacity(edits.len());
    for (idx, item) in edits.iter().enumerate() {
        let obj = item.as_object().ok_or_else(|| invalid("Cada edición debe ser un objeto."))?;
        only(obj, &["buscar", "reemplazar", "todas"])?;
        let find = obj
            .get("buscar")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty() && s.len() <= MAX_TEXT)
            .ok_or_else(|| invalid("buscar debe ser texto no vacío."))?;
        let replace = obj
            .get("reemplazar")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("reemplazar debe ser texto."))?;
        let all = match obj.get("todas") {
            None => false,
            Some(v) => v.as_bool().ok_or_else(|| invalid("todas debe ser booleano."))?,
        };
        let occurrences = next.matches(find).count();
        if occurrences == 0 {
            return Err(Fault::new(
                "EDIT_NOT_FOUND",
                format!("La edición {} no encontró el texto buscado; no se modificó nada.", idx + 1),
            ));
        }
        if occurrences > 1 && !all {
            return Err(Fault::new(
                "EDIT_AMBIGUOUS",
                format!(
                    "La edición {} aparece {occurrences} veces; amplía el texto o usa todas=true.",
                    idx + 1
                ),
            ));
        }
        next = if all {
            next.replace(find, replace)
        } else {
            next.replacen(find, replace, 1)
        };
        applied.push(json!({
            "edicion": idx + 1,
            "reemplazos": if all { occurrences } else { 1 },
        }));
    }
    if next == content {
        verify(base, &scope, &["leer", "escribir"])?;
        return Ok(json!({
            "estado": "sin-cambios",
            "carpeta": scope.id,
            "ruta": scope.relative,
            "version": current_version,
        }));
    }
    let expected_hash = parse_expected_version(&current_version)?;
    let confirm = || {
        verify(base, &scope, &["leer", "escribir"]).map_err(|e| e.code)?;
        confirm_owner()
    };
    let report = text_write::write_bytes(&scope.root, &scope.relative, next.as_bytes(), MAX_TEXT, Some(expected_hash), confirm)
        .map_err(|code| Fault::new(code, "La publicación segura se detuvo. Revisa permisos, destino y versión."))?;
    let _ = motor_properties::rebind(base, &scope, &report, &confirm_owner);
    let index_state = match refresh_index_after_write(base, &scope, IndexChange::ModifyFile, &confirm_owner) {
        Ok(true) => "ok",
        Ok(false) => "not-indexed",
        Err(_) => "needs-reconciliation",
    };
    Ok(json!({
        "estado": "modificado",
        "carpeta": scope.id,
        "ruta": scope.relative,
        "ruta_absoluta": absolute(&scope),
        "ediciones": applied,
        "version_anterior": current_version,
        "version": version(next.as_bytes()),
        "bytes": next.len(),
        "indice": index_state,
    }))
}

fn write(
    base: &str, name: &str, args: &Map<String, Value>, folder: Option<&str>, relative: &str,
    confirm_owner: impl Fn() -> Result<(), &'static str>,
) -> Result<Value, Fault> {
    if name == "editar" || (name == "modificar" && args.contains_key("ediciones")) {
        if args.contains_key("contenido") {
            return Err(invalid("Usa ediciones o contenido, no ambos."));
        }
        return edit_text(base, args, folder, relative, confirm_owner);
    }
    let creating = matches!(name, "crear" | "crear_carpeta");
    if creating && ["proyecto", "conversacion", "destino", "tipo"].iter().any(|key| args.contains_key(*key)) {
        return Err(unsupported("La creación por destinos configurados aún depende del Motor r3."));
    }
    if creating && folder.is_none()
        && access::destinations(base, None, None)?["efectivos"]
            .as_object()
            .is_some_and(|values| !values.is_empty())
    {
        return Err(unsupported("La creación por destinos configurados aún depende del Motor r3."));
    }
    let directory = if name == "crear_carpeta" {
        true
    } else if creating {
        match optional(args, "accion")?.unwrap_or("archivo") {
            "archivo" => false,
            "carpeta" => true,
            _ => return Err(invalid("La acción debe ser archivo o carpeta.")),
        }
    } else {
        false
    };
    let required = if directory { ["organizar"] } else { ["escribir"] };
    let scope = access::resolve_file(base, folder, relative, &required)?;
    let confirm = || {
        verify(base, &scope, &required).map_err(|error| error.code)?;
        confirm_owner()
    };
    let filesystem = |code| Fault::new(code, "La publicación segura se detuvo. Revisa permisos, destino y versión.");
    if directory {
        only(args, &["accion", "carpeta", "ruta"])?;
        organize::create_directory(&scope.root, &scope.relative, confirm).map_err(filesystem)?;
        let _ = refresh_index_after_write(base, &scope, IndexChange::CreateDirectory, &confirm_owner);
        return Ok(json!({
            "estado": "creada",
            "carpeta": scope.id,
            "ruta": scope.relative,
            "ruta_absoluta": absolute(&scope),
        }));
    }

    let accepted = if creating {
        ["carpeta", "ruta", "contenido", "accion"]
    } else {
        ["carpeta", "ruta", "contenido", "version"]
    };
    only(args, &accepted)?;
    let content = optional(args, "contenido")?.ok_or_else(|| invalid("Indica el contenido del archivo."))?;
    let expected = if creating {
        None
    } else {
        let original = optional(args, "version").and_then(|v| v.map(parse_expected_version).transpose())?
            .ok_or_else(|| Fault::new("INVALID_VERSION", "Indica la versión leída del archivo."))?;
        Some(original)
    };
    let report = text_write::write_bytes(&scope.root, &scope.relative, content.as_bytes(), MAX_TEXT, expected, confirm)
        .map_err(filesystem)?;
    let _ = motor_properties::rebind(base, &scope, &report, &confirm_owner);
    let index_state = match refresh_index_after_write(base, &scope, if creating { IndexChange::CreateFile } else { IndexChange::ModifyFile }, &confirm_owner) {
        Ok(true) => "ok",
        Ok(false) => "not-indexed",
        Err(_) => "needs-reconciliation",
    };
    let mut result = json!({
        "estado": if creating { "creado" } else { "modificado" },
        "carpeta": scope.id,
        "ruta": scope.relative,
        "ruta_absoluta": absolute(&scope),
        "bytes": content.len(),
        "version": version(content.as_bytes()),
        "indice": index_state,
    });
    if creating {
        result["registro"] = json!({"estado": "sin_conversacion"});
    } else {
        result["version_anterior"] = args["version"].clone();
    }
    Ok(result)
}

pub(crate) fn write_output_text(
    base: &str, folder_id: &str, relative_path: &str, content: &str, mode: &str,
    confirm_owner: impl Fn() -> Result<(), &'static str>,
) -> Result<Value, Fault> {
    let required: &[&str] = if mode == "reemplazar" { &["leer", "escribir"] } else { &["escribir"] };
    let scope = access::resolve_file(base, Some(folder_id), relative_path, required)?;
    let confirm = || {
        verify(base, &scope, required).map_err(|error| error.code)?;
        confirm_owner()
    };
    let bytes = content.as_bytes();
    match text_write::write_bytes(&scope.root, &scope.relative, bytes, MAX_TEXT, None, confirm) {
        Ok(_) => {
            let index_state = match refresh_index_after_write(base, &scope, IndexChange::CreateFile, &confirm_owner) {
                Ok(true) => "updated",
                Ok(false) => "not-indexed",
                Err(_) => "needs-reconciliation",
            };
            return Ok(json!({
                "carpeta": scope.id,
                "ruta": scope.relative,
                "bytes": bytes.len(),
                "accion": "creado",
                "indice": index_state,
            }));
        }
        Err("FILE_EXISTS") if mode == "reemplazar" => {}
        Err(code) => {
            return Err(Fault::new(code, "No se pudo escribir el archivo generado."));
        }
    }
    let current = access::read_file(&scope.root, &scope.relative, MAX_TEXT)?
        .ok_or_else(|| Fault::new("FILE_NOT_FOUND", "No se encontró el archivo existente."))?;
    let current_text = std::str::from_utf8(&current)
        .ok()
        .filter(|text| !text.contains('\0'))
        .ok_or_else(|| Fault::new("TEXT_UNREADABLE", "El archivo existente no contiene texto UTF-8 válido."))?;
    verify(base, &scope, required)?;
    if current_text == content {
        return Ok(json!({
            "carpeta": scope.id,
            "ruta": scope.relative,
            "bytes": bytes.len(),
            "accion": "sin-cambios",
            "indice": "current",
        }));
    }
    let expected = format!("{:x}", Sha256::digest(&current));
    let confirm_mod = || {
        verify(base, &scope, required).map_err(|error| error.code)?;
        confirm_owner()
    };
    text_write::write_bytes(&scope.root, &scope.relative, bytes, MAX_TEXT, Some(&expected), confirm_mod)
        .map_err(|code| Fault::new(code, "No se pudo actualizar el archivo generado."))?;
    let index_state = match refresh_index_after_write(base, &scope, IndexChange::ModifyFile, &confirm_owner) {
        Ok(true) => "updated",
        Ok(false) => "not-indexed",
        Err(_) => "needs-reconciliation",
    };
    Ok(json!({
        "carpeta": scope.id,
        "ruta": scope.relative,
        "bytes": bytes.len(),
        "accion": "reemplazado",
        "indice": index_state,
    }))
}

pub(crate) fn valid_trash_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    bytes.len() == 29
        && bytes[..8].iter().all(u8::is_ascii_digit)
        && bytes[8] == b'T'
        && bytes[9..15].iter().all(u8::is_ascii_digit)
        && bytes[15..17] == *b"Z-"
        && bytes[17..].iter().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(b))
}

fn new_trash_id(now: &str) -> String {
    let random = Uuid::new_v4().simple().to_string();
    format!(
        "{}{}{}{}{}{}Z-{}",
        &now[0..4],
        &now[5..7],
        &now[8..10],
        &now[10..13],
        &now[14..16],
        &now[17..19],
        &random[..12]
    )
}

fn load_trash_entries(base: &str, folder: &Folder) -> Result<(Vec<Value>, Option<Vec<u8>>), Fault> {
    let Some((data, bytes)) = read_base_stored(base, &trash_file(&folder.id))? else {
        return Ok((Vec::new(), None));
    };
    if data["format"] != "mind-trash"
        || data["version"] != 1
        || data["folderId"].as_str() != Some(folder.id.as_str())
        || !data["entries"].is_array()
        || !(data["generation"].is_null() || data["generation"].is_string())
    {
        return Err(Fault::new(
            "TRASH_CORRUPT",
            "El registro de la papelera no tiene el formato esperado.",
        ));
    }
    if data["generation"].as_str() != folder.generation.as_deref() {
        return Ok((Vec::new(), Some(bytes)));
    }
    Ok((data["entries"].as_array().cloned().unwrap_or_default(), Some(bytes)))
}

fn save_trash_entries(
    base: &str, folder: &Folder, entries: &[Value], previous: Option<&[u8]>,
    confirm_owner: impl Fn() -> Result<(), &'static str>,
) -> Result<(), Fault> {
    let file = trash_file(&folder.id);
    if entries.is_empty() {
        motor_consent::remove_base_file(base, &file, confirm_owner)?;
        return Ok(());
    }
    let record = json!({
        "format": "mind-trash",
        "version": 1,
        "folderId": folder.id,
        "generation": folder.generation,
        "entries": entries,
    });
    write_base_json(base, &file, &record, previous, confirm_owner)
}

fn restore_candidates(name: &str, kind: &str, date: &str) -> Vec<String> {
    let dot = if kind == "file" { name.rfind('.') } else { None };
    let (stem, ext) = match dot {
        Some(idx) if idx > 0 => (&name[..idx], &name[idx..]),
        _ => (name, ""),
    };
    let mut names = Vec::with_capacity(MAX_RESTORE_NAMES);
    names.push(name.to_owned());
    let mut copy = 1usize;
    while names.len() < MAX_RESTORE_NAMES {
        if copy == 1 {
            names.push(format!("{stem} (restaurado {date}){ext}"));
        } else {
            names.push(format!("{stem} (restaurado {date} {copy}){ext}"));
        }
        copy += 1;
    }
    names
}

fn organize_error(code: &'static str) -> Fault {
    let message = match code {
        "FILE_NOT_FOUND" => "El archivo o la carpeta de origen no existe.",
        "PARENT_NOT_FOUND" => "La carpeta de destino no existe: créala antes con crear_carpeta.",
        "FILE_EXISTS" => "Ya existe un elemento en el destino; Mind no reemplaza.",
        "FILE_IN_USE" => "Otro programa tiene abierto ese elemento.",
        "ACCESS_DENIED" => "El sistema denegó la operación.",
        "NOT_EMPTY" => "La carpeta no está vacía.",
        "CROSS_DEVICE" => "Origen y destino están en discos distintos.",
        "INVALID_MOVE" => "No se puede mover una carpeta dentro de sí misma ni al mismo lugar.",
        "ENTRY_CHANGED" => "El elemento cambió mientras se preparaba la operación; vuelve a consultarlo.",
        "TRASH_MISSING" => "El elemento ya no está en la carpeta .papelera-mind.",
        "UNSAFE_PATH" => "La ruta contiene un enlace, un componente inseguro o la papelera.",
        "NO_SPACE" => "No hay espacio suficiente.",
        _ => "No se pudo completar la organización.",
    };
    let mapped = if code == "TRASH_MISSING" { "TRASH_ENTRY_MISSING" } else { code };
    Fault::new(mapped, message)
}

fn relocate_path(candidate: &str, from_abs: &Path, to_abs: &Path) -> Option<String> {
    let candidate_path = Path::new(candidate);
    if !candidate_path.is_absolute() {
        return None;
    }
    let rest = relative_parts(from_abs, candidate_path)?;
    let mut mapped = to_abs.to_path_buf();
    for part in rest {
        mapped.push(part);
    }
    let next = mapped.to_str()?;
    (next != candidate).then(|| next.to_owned())
}

fn save_relocated_record(
    base: &str, name: &str, record: &Value, prev_bytes: &[u8], limit: usize, compact: bool,
    confirm_owner: impl FnOnce() -> Result<(), &'static str>,
) -> Result<(), Fault> {
    let mut bytes = if compact {
        serde_json::to_vec(record)
    } else {
        serde_json::to_vec_pretty(record)
    }
    .map_err(|_| Fault::new("WRITE_FAILED", "No se pudo serializar el registro técnico."))?;
    bytes.push(b'\n');
    let expected = format!("{:x}", Sha256::digest(prev_bytes));
    text_write::write_bytes(base, name, &bytes, limit, Some(&expected), confirm_owner)
        .map(|_| ())
        .map_err(|code| Fault::new(code, "No se pudo actualizar el vínculo en la Base."))
}

fn relocate_dest_layer(layer: &mut Value, from_abs: &Path, to_abs: &Path) -> bool {
    let mut changed = false;
    if let Some(dir) = layer.get("carpeta").and_then(Value::as_str).map(str::to_owned) {
        if let Some(mapped) = relocate_path(&dir, from_abs, to_abs) {
            layer["carpeta"] = json!(mapped);
            changed = true;
        }
    }
    if let Some(types) = layer.get_mut("tipos").and_then(Value::as_object_mut) {
        for value in types.values_mut() {
            if let Some(dir) = value.as_str().map(str::to_owned) {
                if let Some(mapped) = relocate_path(&dir, from_abs, to_abs) {
                    *value = json!(mapped);
                    changed = true;
                }
            }
        }
    }
    changed
}

fn relocation_ids(base: &str) -> Result<BTreeSet<String>, Fault> {
    let invalid = || Fault::new("READ_FAILED", "No se pudo enumerar la Base.");
    let mut ids = BTreeSet::new();
    for entry in fs::read_dir(base).map_err(|_| invalid())? {
        let name = entry.map_err(|_| invalid())?.file_name();
        let Some(name) = name.to_str() else { continue };
        let id = name.strip_prefix("continuity-")
            .or_else(|| name.strip_prefix("conversation-results-"))
            .and_then(|rest| rest.strip_suffix(".json"));
        if let Some(id) = id.filter(|id| crate::motor_native::is_id(id)) {
            ids.insert(id.to_owned());
        }
    }
    Ok(ids)
}

fn relocate_linked_paths(
    base: &str, from_abs: &Path, to_abs: &Path, ids: &[String],
    confirm_owner: Option<&dyn Fn() -> Result<(), &'static str>>,
) -> Result<(), Fault> {
    let now = now_iso()?;
    for id in ids {
        let name = format!("continuity-{id}.json");
        let Some((mut record, prev_bytes)) = read_base_stored(base, &name)? else { continue };
        crate::motor_records::validate_record(&record, id)?;
        let mut refs_changed = false;
        if let Some(items) = record["references"].as_array_mut() {
            for item in items.iter_mut() {
                if let Some(locator) = item["locator"].as_str().map(str::to_owned) {
                    if let Some(mapped) = relocate_path(&locator, from_abs, to_abs) {
                        item["locator"] = json!(mapped);
                        refs_changed = true;
                    }
                }
            }
            if refs_changed {
                let mut deduped = Vec::with_capacity(items.len());
                for item in items.drain(..) {
                    if !deduped.contains(&item) {
                        deduped.push(item);
                    }
                }
                *items = deduped;
            }
        }
        let mut content_changed = false;
        if record["kind"] == "conversacion" && record["content"]["format"] == "mind-conversation" {
            if let Some(file) = record["content"]["file"].as_str().map(str::to_owned) {
                if let Some(mapped) = relocate_path(&file, from_abs, to_abs) {
                    record["content"]["file"] = json!(mapped);
                    content_changed = true;
                }
            }
            if let Some(mb_file) = record["content"]["markdownBase"]["file"].as_str().map(str::to_owned) {
                if let Some(mapped) = relocate_path(&mb_file, from_abs, to_abs) {
                    record["content"]["markdownBase"]["file"] = json!(mapped);
                    content_changed = true;
                }
            }
            if let Some(dir) = record["content"]["preferences"]["directory"].as_str().map(str::to_owned) {
                if let Some(mapped) = relocate_path(&dir, from_abs, to_abs) {
                    record["content"]["preferences"]["directory"] = json!(mapped);
                    content_changed = true;
                }
            }
        }
        if refs_changed || content_changed {
            let rev = record["revision"]
                .as_u64()
                .filter(|&r| r >= 1 && r < MAX_SAFE_INTEGER)
                .ok_or_else(|| Fault::new("CONTINUITY_REVISION_CONFLICT", "No se pudo incrementar la revisión."))?;
            record["revision"] = json!(rev + 1);
            let next_updated = record["updatedAt"].as_str().unwrap_or(&now).max(now.as_str()).to_owned();
            record["updatedAt"] = json!(next_updated);
            crate::motor_records::validate_record(&record, id)?;
            if let Some(confirm) = confirm_owner {
                save_relocated_record(base, &name, &record, &prev_bytes, 2 * 1024 * 1024, true, confirm)?;
            }
        }
    }

    for id in ids {
        let name = format!("conversation-results-{id}.json");
        let Some((mut record, prev_bytes)) = read_base_stored(base, &name)? else { continue };
        if record["format"] != "mind-conversation-results" || record["version"] != 1 {
            return Err(Fault::new("RESULTS_CORRUPT", "Registro de resultados no compatible."));
        }
        let Some(rev) = record["revision"].as_u64().filter(|&r| r >= 1 && r < MAX_SAFE_INTEGER) else {
            return Err(Fault::new("RESULTS_CORRUPT", "Registro de resultados no compatible."));
        };
        let Some(items) = record["results"].as_array_mut() else {
            return Err(Fault::new("RESULTS_CORRUPT", "Registro de resultados no compatible."));
        };
        let mut changed = false;
        for item in items.iter_mut() {
            if let Some(file) = item["path"].as_str().map(str::to_owned) {
                if let Some(mapped) = relocate_path(&file, from_abs, to_abs) {
                    item["path"] = json!(mapped);
                    changed = true;
                }
            }
        }
        if changed {
            record["revision"] = json!(rev + 1);
            if let Some(confirm) = confirm_owner {
                save_relocated_record(base, &name, &record, &prev_bytes, 2 * 1024 * 1024, true, confirm)?;
            }
        }
    }

    if let Some((mut dests, prev_bytes)) = read_base_stored(base, "work-destinations.json")? {
        if dests["format"] != "mind-work-destinations" || dests["version"] != 1 {
            return Err(Fault::new("INVALID_DESTINATIONS", "La configuración de destinos es incompatible."));
        }
        let rev = dests["revision"]
            .as_u64()
            .filter(|&r| r >= 1 && r < MAX_SAFE_INTEGER)
            .ok_or_else(|| Fault::new("INVALID_DESTINATIONS", "La configuración de destinos es incompatible."))?;
        let mut changed = relocate_dest_layer(&mut dests["general"], from_abs, to_abs);
        if let Some(projects) = dests["proyectos"].as_object_mut() {
            for layer in projects.values_mut() {
                changed |= relocate_dest_layer(layer, from_abs, to_abs);
            }
        }
        if let Some(conversations) = dests["conversaciones"].as_object_mut() {
            for layer in conversations.values_mut() {
                changed |= relocate_dest_layer(layer, from_abs, to_abs);
            }
        }
        if changed {
            dests["revision"] = json!(rev + 1);
            if let Some(confirm) = confirm_owner {
                save_relocated_record(base, "work-destinations.json", &dests, &prev_bytes, MAX_INDEX_BYTES, false, confirm)?;
            }
        }
    }

    if let Some((mut prefs, prev_bytes)) = read_base_stored(base, "conversation-preferences.json")? {
        if prefs["format"] != "mind-conversation-preferences" || prefs["version"] != 1 {
            return Err(Fault::new("INVALID_CONVERSATION_PREFERENCES", "Las preferencias de conversación son incompatibles."));
        }
        let rev = prefs["revision"]
            .as_u64()
            .filter(|&r| r >= 1 && r < MAX_SAFE_INTEGER)
            .ok_or_else(|| Fault::new("INVALID_CONVERSATION_PREFERENCES", "Las preferencias de conversación son incompatibles."))?;
        if let Some(dir) = prefs["preferences"]["directory"].as_str().map(str::to_owned) {
            if let Some(mapped) = relocate_path(&dir, from_abs, to_abs) {
                prefs["preferences"]["directory"] = json!(mapped);
                prefs["revision"] = json!(rev + 1);
                if let Some(confirm) = confirm_owner {
                    save_relocated_record(base, "conversation-preferences.json", &prefs, &prev_bytes, MAX_INDEX_BYTES, false, confirm)?;
                }
            }
        }
    }

    Ok(())
}

fn relocation_error() -> Fault {
    Fault::new("CONVERSATION_RELOCATION_CORRUPT", "El diario de traslado no tiene el formato esperado.")
}

// También lo lee r3. La fase preparada distingue un movimiento interrumpido
// de un archivo distinto que luego haya aparecido en el destino.
fn finish_move(base: &str, confirm_owner: impl Fn() -> Result<(), &'static str>) -> Result<(), Fault> {
    let Some((journal, _)) = read_base_stored(base, MOVE_JOURNAL)? else { return Ok(()) };
    if journal["format"] != "mind-conversation-relocation" || journal["version"] != 1 {
        return Err(relocation_error());
    }
    if journal["kind"] == "metadata" {
        crate::motor_conversations::apply_metadata(base, &journal, &confirm_owner)?;
        motor_consent::remove_base_file(base, MOVE_JOURNAL, confirm_owner)?;
        return Ok(());
    }
    if journal["kind"] != "move" { return Err(relocation_error()); }
    let path = |key: &str| journal[key].as_str().map(Path::new)
        .filter(|path| path.is_absolute()).ok_or_else(relocation_error);
    let from = path("from")?;
    let to = path("to")?;
    let ids = journal["ids"].as_array().ok_or_else(relocation_error)?
        .iter()
        .map(|id| id.as_str().filter(|id| crate::motor_native::is_id(id))
            .map(str::to_owned).ok_or_else(relocation_error))
        .collect::<Result<Vec<_>, _>>()?;
    match journal["phase"].as_str() {
        Some("moved") => {}
        Some("prepared") => {
            let identity = &journal["identity"];
            if !["dev", "ino"].iter().all(|key| {
                identity[*key].as_str().is_some_and(|id| id.parse::<u64>().is_ok())
            }) {
                return Err(relocation_error());
            }
            let source = organize::location_identity(from).map_err(organize_error)?;
            let same_location = relative_parts(from, to).is_some_and(|parts| parts.is_empty());
            if !same_location && source.as_ref() == Some(identity) {
                // Se guardó la intención y el original sigue en su lugar.
                motor_consent::remove_base_file(base, MOVE_JOURNAL, &confirm_owner)?;
                return Ok(());
            }
            let target = organize::location_identity(to).map_err(organize_error)?;
            if (!same_location && source.is_some()) || target.as_ref() != Some(identity) {
                return Err(Fault::new("MOVE_UNCONFIRMED", "No se pudo verificar el resultado del traslado."));
            }
        }
        _ => return Err(relocation_error()),
    }
    relocate_linked_paths(base, from, to, &ids, Some(&confirm_owner))?;
    motor_consent::remove_base_file(base, MOVE_JOURNAL, confirm_owner)?;
    Ok(())
}

pub(crate) fn recover_move(base: &str, confirm_owner: impl Fn() -> Result<(), &'static str>) -> Result<(), Fault> {
    finish_move(base, confirm_owner).map_err(|error| Fault::new(
        "CONVERSATION_RELOCATION_PENDING",
        &format!("Mind conserva el traslado pendiente de completar. {}", error.message),
    ))
}

fn move_or_rename(
    base: &str, args: &Map<String, Value>, renaming: bool,
    confirm_owner: impl Fn() -> Result<(), &'static str>,
) -> Result<Value, Fault> {
    let (from, to, target_ref) = if renaming {
        only(args, &["accion", "carpeta", "ruta", "nuevo_nombre"])?;
        let from = optional(args, "ruta")?.ok_or_else(|| invalid("Indica la ruta a renombrar."))?;
        let new_name = optional(args, "nuevo_nombre")?
            .filter(|s| !s.is_empty() && s.encode_utf16().count() <= 255)
            .ok_or_else(|| invalid("Indica nuevo_nombre."))?;
        if new_name.contains('/') || new_name.contains('\\') {
            return Err(invalid("nuevo_nombre no puede contener \"/\": para cambiar de carpeta usa \"mover\"."));
        }
        let to = match from.rsplit_once('/') {
            Some((parent, _)) => format!("{parent}/{new_name}"),
            None => new_name.to_owned(),
        };
        (from.to_owned(), to, None)
    } else {
        only(args, &["accion", "carpeta", "desde", "hasta", "carpeta_destino"])?;
        let from = optional(args, "desde")?.ok_or_else(|| invalid("Indica desde."))?.to_owned();
        let to = optional(args, "hasta")?.ok_or_else(|| invalid("Indica hasta."))?.to_owned();
        let target_ref = optional(args, "carpeta_destino")?;
        (from, to, target_ref)
    };
    let source = access::resolve_folder(base, optional(args, "carpeta")?, &["organizar"])?;
    let target = match target_ref {
        Some(reference) => access::resolve_folder(base, Some(reference), &["organizar"])?,
        None => source.clone(),
    };
    let crossing = target.id != source.id;
    guard_organize_path(&source, &from, true)?;
    guard_organize_path(&target, &to, true)?;
    if !crossing {
        if from == to || fold_path(&to).starts_with(&format!("{}/", fold_path(&from))) {
            return Err(organize_error("INVALID_MOVE"));
        }
    } else if relative_parts(Path::new(&source.root), Path::new(&target.root)).is_some()
        || relative_parts(Path::new(&target.root), Path::new(&source.root)).is_some()
    {
        return Err(Fault::new(
            "INVALID_MOVE",
            "Una de las carpetas contiene a la otra: mueve dentro de la carpeta que las contiene.",
        ));
    }
    let confirm = || {
        let cur_src = access::resolve_folder(base, Some(&source.id), &["organizar"]).map_err(|e| e.code)?;
        if cur_src.generation != source.generation {
            return Err("MOVE_NOT_AUTHORIZED");
        }
        guard_organize_path(&cur_src, &from, true).map_err(|e| e.code)?;
        if crossing {
            let cur_dst = access::resolve_folder(base, Some(&target.id), &["organizar"]).map_err(|e| e.code)?;
            if cur_dst.generation != target.generation {
                return Err("MOVE_NOT_AUTHORIZED");
            }
            guard_organize_path(&cur_dst, &to, true).map_err(|e| e.code)?;
        } else {
            guard_organize_path(&cur_src, &to, true).map_err(|e| e.code)?;
        }
        confirm_owner()
    };
    recover_move(base, &confirm_owner)?;
    let properties = ensure_folder_index(base, &source, &confirm_owner).and_then(|index| {
        motor_properties::snapshot(base, &source, &from, index["entries"].as_array().map_or(&[], Vec::as_slice))
    }).unwrap_or_default();
    let from_abs = absolute_path(&source.root, &from);
    let to_abs = absolute_path(&target.root, &to);
    let ids = relocation_ids(base)?.into_iter().collect::<Vec<_>>();
    // Los metadatos que ya estén dañados se detectan con el original en su sitio.
    relocate_linked_paths(base, &from_abs, &to_abs, &ids, None)?;
    let mut journal = json!({
        "format": "mind-conversation-relocation", "version": 1,
        "kind": "move", "phase": "prepared", "from": from_abs, "to": to_abs, "ids": ids,
    });
    let mut saved = false;
    let result = organize::move_entry(&source.root, &from, &to, crossing.then(|| target.root.clone()), |identity| {
        journal["identity"] = identity;
        write_base_json(base, MOVE_JOURNAL, &journal, None, &confirm).map_err(|error| error.code)?;
        saved = true;
        confirm()
    });
    let moved = match result {
        Ok(value) => value,
        Err(error) => {
            if saved {
                let _ = finish_move(base, &confirm_owner);
            }
            return Err(organize_error(error));
        }
    };
    let finish = (|| -> Result<(), Fault> {
        let (current, bytes) = read_base_stored(base, MOVE_JOURNAL)?.ok_or_else(relocation_error)?;
        if current != journal {
            return Err(relocation_error());
        }
        journal["phase"] = json!("moved");
        write_base_json(base, MOVE_JOURNAL, &journal, Some(&bytes), &confirm_owner)?;
        finish_move(base, &confirm_owner)
    })();
    let source_index = reconcile_folder_index_inner(base, &source, false, &confirm_owner);
    let target_index = if crossing { reconcile_folder_index_inner(base, &target, false, &confirm_owner) } else { source_index };
    let transferred = target_index.and_then(|index| {
        let count = motor_properties::restore(base, &target, &to, &properties, &index, &confirm_owner)?;
        let _ = motor_properties::forget(base, &source, &from, &properties, &confirm_owner);
        Ok(count)
    }).unwrap_or(0);
    let continuity = match finish {
        Ok(()) => json!({"estado": "actualizada"}),
        Err(error) => json!({
            "estado": "pendiente",
            "codigo": error.code,
            "nota": "El movimiento físico se completó; Mind conserva el traslado para completar sus rutas al retomar.",
        }),
    };
    let kind = type_out(moved["type"].as_str().unwrap_or("file"));
    if renaming {
        Ok(json!({
            "estado": "renombrado",
            "carpeta": source.id,
            "desde": from,
            "hasta": to,
            "ruta_absoluta": absolute_path(&source.root, &to),
            "tipo": kind,
            "propiedades_trasladadas": transferred,
            "continuidad": continuity,
        }))
    } else {
        Ok(json!({
            "estado": "movido",
            "carpeta": source.id,
            "carpeta_destino": target.id,
            "desde": from,
            "hasta": to,
            "ruta_absoluta": absolute_path(&target.root, &to),
            "tipo": kind,
            "propiedades_trasladadas": transferred,
            "continuidad": continuity,
        }))
    }
}

fn list_trash(base: &str, args: &Map<String, Value>) -> Result<Value, Fault> {
    only(args, &["accion", "carpeta"])?;
    let folder = access::resolve_folder(base, optional(args, "carpeta")?, &["encontrar"])?;
    let (mut entries, _) = load_trash_entries(base, &folder)?;
    entries.reverse();
    let elementos: Vec<Value> = entries
        .into_iter()
        .map(|entry| {
            let path = entry["path"].as_str().unwrap_or_default();
            let props = entry["properties"].as_array().map(Vec::len).unwrap_or(0);
            json!({
                "id": entry["id"],
                "ruta": path,
                "ruta_original_absoluta": absolute_path(&folder.root, path),
                "tipo": type_out(entry["type"].as_str().unwrap_or("file")),
                "bytes": entry["size"],
                "borrado": entry["deletedAt"],
                "por": entry["by"],
                "motivo": entry.get("reason").cloned().unwrap_or(Value::Null),
                "propiedades": props,
            })
        })
        .collect();
    Ok(json!({
        "carpeta": folder.id,
        "total": elementos.len(),
        "elementos": elementos,
    }))
}

fn restore_trash(
    base: &str, args: &Map<String, Value>,
    confirm_owner: impl Fn() -> Result<(), &'static str>,
) -> Result<Value, Fault> {
    only(args, &["accion", "carpeta", "id"])?;
    let folder = access::resolve_folder(base, optional(args, "carpeta")?, &["organizar"])?;
    let trash_id = optional(args, "id")?
        .filter(|id| valid_trash_id(id))
        .ok_or_else(|| Fault::new("INVALID_TRASH_ID", "El identificador de la papelera no es válido."))?;
    let (entries, prev_bytes) = load_trash_entries(base, &folder)?;
    let stored = entries
        .iter()
        .find(|item| item["id"].as_str() == Some(trash_id))
        .cloned()
        .ok_or_else(|| Fault::new("TRASH_ENTRY_NOT_FOUND", "Esa entrada no está en la papelera de Mind de esta carpeta."))?;
    let original_path = stored["path"].as_str().unwrap_or_default().to_owned();
    let entry_type = stored["type"].as_str().unwrap_or("file");
    let mut parts: Vec<String> = original_path.split('/').map(str::to_owned).collect();
    let name = parts.pop().ok_or_else(|| organize_error("UNSAFE_PATH"))?;
    let prefix = if parts.is_empty() {
        String::new()
    } else {
        format!("{}/", parts.join("/"))
    };
    let now = now_iso()?;
    let all_candidates = restore_candidates(&name, entry_type, &now[..10]);
    let allowed: Vec<String> = all_candidates
        .iter()
        .filter(|candidate| {
            let full = format!("{prefix}{candidate}");
            guard_organize_path(&folder, &full, true).is_ok()
        })
        .cloned()
        .collect();
    if allowed.is_empty() {
        return Err(Fault::new("PATH_EXCLUDED", "El usuario excluyó esa ubicación del acceso de Mind."));
    }
    let confirm = || {
        let cur = access::resolve_folder(base, Some(&folder.id), &["organizar"]).map_err(|e| e.code)?;
        if cur.generation != folder.generation {
            return Err("RESTORE_NOT_AUTHORIZED");
        }
        confirm_owner()
    };
    let restored = match organize::restore_entry(&folder.root, trash_id, &name, parts, allowed, confirm) {
        Ok(value) => value,
        Err("TRASH_MISSING") => {
            let next: Vec<Value> = entries.into_iter().filter(|item| item["id"].as_str() != Some(trash_id)).collect();
            let _ = save_trash_entries(base, &folder, &next, prev_bytes.as_deref(), &confirm_owner);
            return Err(organize_error("TRASH_MISSING"));
        }
        Err(code) => return Err(organize_error(code)),
    };
    let chosen_name = restored["name"].as_str().unwrap_or(&name);
    let restored_path = format!("{prefix}{chosen_name}");
    let next: Vec<Value> = entries.into_iter().filter(|item| item["id"].as_str() != Some(trash_id)).collect();
    let _ = save_trash_entries(base, &folder, &next, prev_bytes.as_deref(), &confirm_owner);
    let properties = stored.get("properties").and_then(|value| {
        serde_json::from_value::<Vec<motor_properties::Entry>>(value.clone()).ok()
    }).unwrap_or_default();
    let restored_count = reconcile_folder_index(base, &folder, &confirm_owner).and_then(|index| {
        motor_properties::restore(base, &folder, &restored_path, &properties, &index, &confirm_owner)
    }).unwrap_or(0);
    Ok(json!({
        "estado": "restaurado",
        "carpeta": folder.id,
        "ruta": restored_path,
        "ruta_absoluta": absolute_path(&folder.root, &restored_path),
        "renombrado": restored_path != original_path,
        "ruta_original": original_path,
        "propiedades_repuestas": restored_count,
    }))
}

pub(crate) struct OrganizeConfirmation {
    kind: &'static str,
    folder: Folder,
    target_path: String,
    trash_id: Option<String>,
    entry: Value,
    contained: usize,
    client: String,
    reason: String,
    lines: Vec<String>,
}

pub(crate) enum OrganizePrepared {
    Immediate(Value),
    Confirm(OrganizeConfirmation),
}

pub(crate) enum OrganizeDecision<'a> {
    FromForms { first: Option<&'a Value>, second: Option<&'a Value> },
    Pending { cancelled: bool },
}

fn describe_deletion(folder: &Folder, entry: &Value, contained: usize) -> Vec<String> {
    let path = entry["path"].as_str().unwrap_or_default();
    let detail = if entry["type"] == "directory" {
        format!("Tipo: carpeta, con {contained} elementos dentro")
    } else {
        let size = entry["size"].as_u64().map(|s| format!("{s} bytes")).unwrap_or_default();
        let modified = entry["modifiedAt"]
            .as_str()
            .map(|m| format!(", modificado {m}"))
            .unwrap_or_default();
        format!("Tipo: archivo {size}{modified}")
    };
    vec![
        format!("Mover a la papelera de Mind: {path}"),
        format!("En la carpeta: {}", folder.root),
        detail,
        "Se podrá restaurar desde la papelera de Mind (carpeta .papelera-mind dentro de esa carpeta).".to_owned(),
    ]
}

fn describe_purge(folder: &Folder, entry: &Value) -> Vec<String> {
    let path = entry["path"].as_str().unwrap_or_default();
    let deleted_at = entry["deletedAt"].as_str().unwrap_or_default();
    let kind_desc = if entry["type"] == "directory" {
        "carpeta".to_owned()
    } else {
        let size = entry["size"].as_u64().map(|s| format!("{s} bytes")).unwrap_or_default();
        format!("archivo {size}")
    };
    vec![
        format!("Eliminar DEFINITIVAMENTE de la papelera de Mind: {path}"),
        format!("En la carpeta: {}", folder.root),
        format!("Borrado el {deleted_at} ({kind_desc})."),
        "No se podrá recuperar con Mind.".to_owned(),
    ]
}

impl OrganizeConfirmation {
    pub(crate) fn requires_second_form(&self) -> bool {
        self.kind == "vaciado"
    }

    pub(crate) fn first_form(&self, protocol: &str) -> Value {
        let mut lines = vec![format!("{} solicita, mediante Mind:", self.client), String::new()];
        lines.extend(self.lines.iter().cloned());
        if !self.reason.is_empty() {
            lines.push(String::new());
            lines.push(format!("Motivo indicado por el agente (no verificado): «{}»", self.reason));
        }
        lines.push(String::new());
        lines.push("Confirma solo si reconoces esta solicitud.".to_owned());
        let title = if self.kind == "vaciado" {
            "Eliminar definitivamente"
        } else {
            "Mover a la papelera de Mind"
        };
        let mut params = json!({
            "message": lines.join("\n"),
            "requestedSchema": {
                "type": "object",
                "properties": {
                    "confirmar": { "type": "boolean", "title": title, "default": false }
                },
                "required": ["confirmar"]
            }
        });
        if protocol == "2025-11-25" {
            params["mode"] = json!("form");
        }
        params
    }

    pub(crate) fn second_form(&self, protocol: &str) -> Value {
        let mut params = json!({
            "message": "Confirmación adicional: esto no se puede deshacer. Escribe VACIAR para continuar.",
            "requestedSchema": {
                "type": "object",
                "properties": {
                    "texto": { "type": "string", "title": "Escribe VACIAR", "maxLength": 20 }
                },
                "required": ["texto"]
            }
        });
        if protocol == "2025-11-25" {
            params["mode"] = json!("form");
        }
        params
    }

    fn declined_reply(&self) -> Value {
        if self.kind == "vaciado" {
            json!({
                "estado": "rechazado",
                "nota": "El usuario no confirmó la eliminación definitiva: no se tocó nada.",
            })
        } else {
            json!({
                "estado": "rechazado",
                "nota": "El usuario no confirmó el borrado: no se tocó nada.",
            })
        }
    }
}

fn find_indexed_entry(
    base: &str, folder: &Folder, relative_path: &str,
    confirm_owner: impl Fn() -> Result<(), &'static str>,
) -> Result<(Value, Vec<Value>), Fault> {
    let index = ensure_folder_index(base, folder, &confirm_owner)?;
    if let Some(entries) = index["entries"].as_array() {
        if let Some(found) = entries.iter().find(|e| e["path"].as_str() == Some(relative_path)) {
            return Ok((found.clone(), entries.clone()));
        }
    }
    let refreshed = reconcile_folder_index(base, folder, &confirm_owner)?;
    if let Some(entries) = refreshed["entries"].as_array() {
        if let Some(found) = entries.iter().find(|e| e["path"].as_str() == Some(relative_path)) {
            return Ok((found.clone(), entries.clone()));
        }
    }
    Err(Fault::new("FILE_NOT_FOUND", "Ese elemento no figura en el índice de la carpeta."))
}

pub(crate) fn prepare_organize(
    base: &str, args: &Map<String, Value>, client: Option<&Value>,
    confirm_owner: impl Fn() -> Result<(), &'static str>,
) -> Result<OrganizePrepared, Fault> {
    let action = optional(args, "accion")?.ok_or_else(|| invalid("Indica la acción de organizar."))?;
    match action {
        "mover" => move_or_rename(base, args, false, confirm_owner).map(OrganizePrepared::Immediate),
        "renombrar" => move_or_rename(base, args, true, confirm_owner).map(OrganizePrepared::Immediate),
        "papelera" => list_trash(base, args).map(OrganizePrepared::Immediate),
        "restaurar" => restore_trash(base, args, confirm_owner).map(OrganizePrepared::Immediate),
        "borrar" => {
            only(args, &["accion", "carpeta", "ruta", "motivo"])?;
            let folder = access::resolve_folder(base, optional(args, "carpeta")?, &["organizar"])?;
            let relative_path = optional(args, "ruta")?.ok_or_else(|| invalid("Indica la ruta a borrar."))?;
            guard_organize_path(&folder, relative_path, true)?;
            let reason = match optional(args, "motivo")? {
                None => String::new(),
                Some(v) if v.encode_utf16().count() <= 300 => motor_consent::clean_text(v, 300),
                Some(_) => return Err(invalid("motivo debe ser texto de hasta 300 caracteres.")),
            };
            let (entry, all_entries) = find_indexed_entry(base, &folder, relative_path, &confirm_owner)?;
            let prefix = format!("{relative_path}/");
            let contained = all_entries
                .iter()
                .filter(|item| item["path"].as_str().is_some_and(|p| p.starts_with(&prefix)))
                .count();
            let lines = describe_deletion(&folder, &entry, contained);
            let client_label = motor_consent::format_client_name(client);
            Ok(OrganizePrepared::Confirm(OrganizeConfirmation {
                kind: "borrado",
                folder,
                target_path: relative_path.to_owned(),
                trash_id: None,
                entry,
                contained,
                client: client_label,
                reason,
                lines,
            }))
        }
        "vaciar_papelera" => {
            only(args, &["accion", "carpeta", "id", "motivo"])?;
            let folder = access::resolve_folder(base, optional(args, "carpeta")?, &["organizar"])?;
            let trash_id = optional(args, "id")?
                .filter(|id| valid_trash_id(id))
                .ok_or_else(|| Fault::new("INVALID_TRASH_ID", "El identificador de la papelera no es válido."))?;
            let reason = match optional(args, "motivo")? {
                None => String::new(),
                Some(v) if v.encode_utf16().count() <= 300 => motor_consent::clean_text(v, 300),
                Some(_) => return Err(invalid("motivo debe ser texto de hasta 300 caracteres.")),
            };
            let (entries, _) = load_trash_entries(base, &folder)?;
            let entry = entries
                .into_iter()
                .find(|item| item["id"].as_str() == Some(trash_id))
                .ok_or_else(|| Fault::new("TRASH_ENTRY_NOT_FOUND", "Esa entrada no está en la papelera de Mind de esta carpeta."))?;
            let lines = describe_purge(&folder, &entry);
            let client_label = motor_consent::format_client_name(client);
            Ok(OrganizePrepared::Confirm(OrganizeConfirmation {
                kind: "vaciado",
                folder,
                target_path: entry["path"].as_str().unwrap_or_default().to_owned(),
                trash_id: Some(trash_id.to_owned()),
                entry,
                contained: 0,
                client: client_label,
                reason,
                lines,
            }))
        }
        _ => Err(invalid("accion debe ser mover, renombrar, borrar, papelera, restaurar o vaciar_papelera.")),
    }
}

fn execute_delete(
    base: &str, folder: &Folder, relative_path: &str, expected_entry: &Value, contained: Option<usize>,
    by: &str, reason: Option<&str>, confirm_owner: impl Fn() -> Result<(), &'static str>,
) -> Result<Value, Fault> {
    guard_organize_path(folder, relative_path, true)?;
    let (entries, prev_trash_bytes) = load_trash_entries(base, folder)?;
    if entries.len() >= MAX_TRASH_ENTRIES {
        return Err(Fault::new(
            "TRASH_LIMIT_EXCEEDED",
            "La papelera de esta carpeta alcanzó el límite de entradas: vacíala antes de borrar más.",
        ));
    }
    let prev_index = load_persisted_index(base, folder)?.map(|(d, _)| d);
    let prefix = format!("{relative_path}/");
    let previous_under: Vec<Value> = prev_index
        .as_ref()
        .and_then(|d| d["entries"].as_array())
        .into_iter()
        .flatten()
        .filter(|e| e["path"].as_str().is_some_and(|p| p == relative_path || p.starts_with(&prefix)))
        .cloned()
        .collect();

    let now = now_iso()?;
    let trash_id = new_trash_id(&now);
    let expect_kind = expected_entry["type"].as_str().map(str::to_owned);
    let expect = expect_kind.as_ref().map(|k| Expected {
        kind: Some(k.clone()),
        size: if k == "file" { expected_entry["size"].as_u64() } else { None },
        modified_ms: if k == "file" {
            expected_entry["modifiedAt"].as_str().and_then(iso_to_millis)
        } else {
            None
        },
    });
    let confirm = || {
        let cur = access::resolve_folder(base, Some(&folder.id), &["organizar"]).map_err(|e| e.code)?;
        if cur.generation != folder.generation {
            return Err("DELETE_NOT_AUTHORIZED");
        }
        guard_organize_path(&cur, relative_path, true).map_err(|e| e.code)?;
        confirm_owner()
    };
    let filename = relative_path.rsplit('/').next().ok_or_else(|| organize_error("UNSAFE_PATH"))?;
    let trash_path = format!(".papelera-mind/{trash_id}/{filename}");
    let properties = motor_properties::snapshot(base, folder, relative_path, &previous_under).unwrap_or_default();
    let mut saved_record = None;
    let mut registration_failure = None;
    let moved = organize::trash_entry(&folder.root, relative_path, &trash_id, expect, |metadata| {
        let kind = metadata["type"].as_str().unwrap_or("file");
        let mut record = json!({
            "id": trash_id,
            "path": relative_path,
            "type": kind,
            "size": metadata["size"],
            "modifiedAt": metadata["modifiedMs"].as_i64().and_then(millis_to_iso),
            "changedAt": metadata["changedMs"].as_i64().and_then(millis_to_iso),
            "createdAt": metadata["createdMs"].as_i64().filter(|ms| *ms > 0).and_then(millis_to_iso),
            "deletedAt": now,
            "by": by,
            "sha256": metadata["sha256"],
            "entries": (kind == "directory")
                .then(|| contained.unwrap_or_else(|| previous_under.len().saturating_sub(1))),
            "reason": reason.filter(|r| !r.is_empty()),
        });
        if !properties.is_empty() { record["properties"] = json!(properties); }
        let mut next_trash = entries;
        next_trash.push(record.clone());
        // Cualquier archivo que llegue a la papelera ya tiene el registro que
        // necesita r3 para restaurarlo. Un fallo de publicación deja el original.
        if let Err(error) = save_trash_entries(base, folder, &next_trash, prev_trash_bytes.as_deref(), &confirm) {
            let code = error.code;
            registration_failure = Some(error);
            return Err(code);
        }
        saved_record = Some(record);
        confirm()
    });
    if let Err(code) = moved {
        if let Some(error) = registration_failure {
            return Err(Fault::new(error.code, "No se pudo guardar el registro de papelera. El original sigue en su ubicación."));
        }
        if saved_record.is_some()
            && matches!(organize::location_identity(&absolute_path(&folder.root, &trash_path)), Ok(None))
        {
            // El intento no dejó nada en la papelera. Conservamos cualquier
            // registro previo, y solo retiramos el id reservado para este intento.
            if let Ok((mut current, bytes)) = load_trash_entries(base, folder) {
                current.retain(|entry| entry["id"] != trash_id);
                let _ = save_trash_entries(base, folder, &current, bytes.as_deref(), &confirm_owner);
            }
        }
        return Err(organize_error(code));
    }
    let record = saved_record.ok_or_else(|| organize_error("UNCONFIRMED"))?;
    let kind = record["type"].as_str().unwrap_or("file");
    let _ = motor_properties::forget(base, folder, relative_path, &properties, &confirm_owner);
    let _ = reconcile_folder_index_inner(base, folder, false, &confirm_owner);
    let removed_to_log = if previous_under.is_empty() {
        vec![json!({
            "path": relative_path,
            "type": kind,
            "size": record["size"],
            "modifiedAt": record["modifiedAt"],
        })]
    } else {
        previous_under
    };
    let _ = record_removed_entries(
        base,
        folder,
        &removed_to_log,
        &format!("papelera de Mind ({trash_id})"),
        &confirm_owner,
    );
    Ok(json!({
        "folderId": folder.id,
        "relativePath": relative_path,
        "type": kind,
        "trashId": trash_id,
        "trashPath": trash_path,
        "entry": record,
        "trash": {"status": "recorded", "code": Value::Null},
    }))
}

fn execute_purge(
    base: &str, folder: &Folder, trash_id: &str,
    confirm_owner: impl Fn() -> Result<(), &'static str>,
) -> Result<Value, Fault> {
    if !valid_trash_id(trash_id) {
        return Err(Fault::new("INVALID_TRASH_ID", "El identificador de la papelera no es válido."));
    }
    let (entries, prev_bytes) = load_trash_entries(base, folder)?;
    let entry = entries
        .iter()
        .find(|item| item["id"].as_str() == Some(trash_id))
        .cloned()
        .ok_or_else(|| Fault::new("TRASH_ENTRY_NOT_FOUND", "Esa entrada no está en la papelera de Mind de esta carpeta."))?;
    let confirm = || {
        let cur = access::resolve_folder(base, Some(&folder.id), &["organizar"]).map_err(|e| e.code)?;
        if cur.generation != folder.generation {
            return Err("PURGE_NOT_AUTHORIZED");
        }
        confirm_owner()
    };
    let removed = match organize::purge_entry(&folder.root, trash_id, confirm) {
        Ok(val) => val["removed"].as_u64().unwrap_or(0),
        Err("TRASH_MISSING") => 0,
        Err(code) => return Err(organize_error(code)),
    };
    let next: Vec<Value> = entries.into_iter().filter(|item| item["id"].as_str() != Some(trash_id)).collect();
    let _ = save_trash_entries(base, folder, &next, prev_bytes.as_deref(), &confirm_owner);
    Ok(json!({
        "folderId": folder.id,
        "trashId": trash_id,
        "removed": removed,
        "entry": entry,
    }))
}

pub(crate) fn finish_organize(
    base: &str, confirmation: OrganizeConfirmation, decision: OrganizeDecision<'_>,
    confirm_owner: impl Fn() -> Result<(), &'static str>,
) -> Result<Value, Fault> {
    let pending = |cancelled: bool| {
        let operation = json!({
            "folderId": confirmation.folder.id,
            "relativePath": if confirmation.kind == "borrado" { json!(confirmation.target_path) } else { Value::Null },
            "trashId": confirmation.trash_id,
        });
        motor_consent::save_operation_pending(
            base,
            confirmation.kind,
            operation,
            &confirmation.client,
            &confirmation.reason,
            cancelled,
            &confirm_owner,
        )
    };
    match decision {
        OrganizeDecision::Pending { cancelled } => return pending(cancelled),
        OrganizeDecision::FromForms { first, second } => {
            let Some(first) = first else {
                return pending(false);
            };
            if !first.is_object() {
                return Err(Fault::new("CONSENT_UNAVAILABLE", "El cliente devolvió una respuesta de confirmación no válida."));
            }
            match first["action"].as_str() {
                Some("decline") => return Ok(confirmation.declined_reply()),
                Some("accept") if first["content"]["confirmar"] == true => {}
                Some("accept") => return Ok(confirmation.declined_reply()),
                _ => return pending(true),
            }
            if confirmation.requires_second_form() {
                let Some(second) = second else {
                    return pending(true);
                };
                if !second.is_object() {
                    return Err(Fault::new("CONSENT_UNAVAILABLE", "El cliente devolvió una respuesta de confirmación no válida."));
                }
                match second["action"].as_str() {
                    Some("decline") => return Ok(confirmation.declined_reply()),
                    Some("accept") => {
                        let typed = second["content"]["texto"].as_str().unwrap_or("").trim();
                        if !typed.eq_ignore_ascii_case("VACIAR") {
                            return Ok(confirmation.declined_reply());
                        }
                    }
                    _ => return pending(true),
                }
            }
        }
    }

    let current_folder = access::resolve_folder(base, Some(&confirmation.folder.id), &["organizar"])?;
    if current_folder.generation != confirmation.folder.generation {
        return Err(Fault::new(
            "ACCESS_CHANGED",
            "La autorización de la carpeta cambió mientras se esperaba la confirmación.",
        ));
    }
    let source = if confirmation.client.is_empty() || confirmation.client == "un agente sin identificar" {
        "agente sin identificar".to_owned()
    } else {
        format!("{} (declarado por el cliente)", confirmation.client)
    };
    if confirmation.kind == "borrado" {
        let by = format!("{source}, confirmado por el usuario");
        let deleted = execute_delete(
            base,
            &current_folder,
            &confirmation.target_path,
            &confirmation.entry,
            Some(confirmation.contained),
            &by,
            Some(&confirmation.reason),
            confirm_owner,
        )?;
        let trash_id = deleted["trashId"].as_str().unwrap_or_default();
        let trash_path = deleted["trashPath"].as_str().unwrap_or_default();
        Ok(json!({
            "estado": "en_papelera",
            "carpeta": current_folder.id,
            "ruta": confirmation.target_path,
            "id": trash_id,
            "tipo": type_out(deleted["type"].as_str().unwrap_or("file")),
            "ubicacion_en_papelera": absolute_path(&current_folder.root, trash_path),
            "papelera": {"estado": "registrado", "codigo": Value::Null},
            "nota": "Se puede restaurar con \"restaurar\" y este id.",
        }))
    } else {
        let trash_id = confirmation.trash_id.as_deref().unwrap_or_default();
        let purged = execute_purge(base, &current_folder, trash_id, confirm_owner)?;
        Ok(json!({
            "estado": "eliminado",
            "carpeta": current_folder.id,
            "id": trash_id,
            "ruta": purged["entry"]["path"],
            "elementos": purged["removed"],
        }))
    }
}

pub(crate) fn console_read_index(base: &str, folder_id: &str) -> Result<Option<Value>, Fault> {
    let Some(folder) = access::registered_folders(base)?.into_iter().find(|f| f.id == folder_id) else {
        return Ok(None);
    };
    Ok(load_persisted_index(base, &folder)?.map(|(data, _)| data))
}

pub(crate) fn console_get_trash(base: &str, folder_id: &str, trash_id: &str) -> Result<Value, Fault> {
    if !valid_trash_id(trash_id) {
        return Err(Fault::new("INVALID_TRASH_ID", "El identificador de la papelera no es válido."));
    }
    let folder = access::registered_folders(base)?
        .into_iter()
        .find(|f| f.id == folder_id)
        .ok_or_else(|| Fault::new("FOLDER_NOT_AUTHORIZED", "La carpeta no está autorizada o fue retirada."))?;
    let (entries, _) = load_trash_entries(base, &folder)?;
    let mut entry = entries
        .into_iter()
        .find(|item| item["id"].as_str() == Some(trash_id))
        .ok_or_else(|| Fault::new("TRASH_ENTRY_NOT_FOUND", "Esa entrada no está en la papelera de Mind de esta carpeta."))?;
    entry["generation"] = json!(folder.generation);
    Ok(entry)
}

pub(crate) fn console_delete_entry(
    base: &str, payload: &Value,
    confirm_owner: impl Fn() -> Result<(), &'static str>,
) -> Result<Value, Fault> {
    let folder_id = payload["id"].as_str().ok_or_else(|| invalid("Falta el identificador de carpeta."))?;
    let relative_path = payload["ruta"].as_str().ok_or_else(|| invalid("Falta la ruta relativa."))?;
    let folder = access::registered_folders(base)?
        .into_iter()
        .find(|f| f.id == folder_id)
        .ok_or_else(|| Fault::new("FOLDER_NOT_AUTHORIZED", "La carpeta no está autorizada o fue retirada."))?;
    let expected = &payload["esperado"];
    let contained = expected["entries"].as_u64().and_then(|n| usize::try_from(n).ok());
    let by = payload["por"].as_str().unwrap_or("consola de Mind");
    let reason = payload["motivo"].as_str();
    let deleted = execute_delete(base, &folder, relative_path, expected, contained, by, reason, confirm_owner)?;
    Ok(json!({"ok": true, "borrado": deleted}))
}

pub(crate) fn console_purge_entry(
    base: &str, payload: &Value,
    confirm_owner: impl Fn() -> Result<(), &'static str>,
) -> Result<Value, Fault> {
    let folder_id = payload["id"].as_str().ok_or_else(|| invalid("Falta el identificador de carpeta."))?;
    let trash_id = payload["papelera"].as_str().ok_or_else(|| invalid("Falta el identificador de papelera."))?;
    let folder = access::registered_folders(base)?
        .into_iter()
        .find(|f| f.id == folder_id)
        .ok_or_else(|| Fault::new("FOLDER_NOT_AUTHORIZED", "La carpeta no está autorizada o fue retirada."))?;
    let purged = execute_purge(base, &folder, trash_id, confirm_owner)?;
    Ok(json!({"ok": true, "vaciado": purged}))
}

fn rank_query(text: &str, needle: &str, mode: &str) -> Option<u8> {
    if needle.is_empty() {
        return Some(2);
    }
    if text == needle {
        return Some(0);
    }
    if mode == "exact" {
        return None;
    }
    if text.starts_with(needle) {
        return Some(1);
    }
    if mode == "prefix" {
        return None;
    }
    text.contains(needle).then_some(2)
}

pub(crate) fn search_files(
    base: &str, args: &Map<String, Value>,
    confirm_owner: impl Fn() -> Result<(), &'static str>,
) -> Result<Value, Fault> {
    let wanted = args.get("propiedades").map(|value| {
        if !value.is_object() { return Err(invalid("propiedades debe ser un objeto { clave: valor }.")); }
        crate::motor_properties::parse_map(value, 16, false)
            .map_err(|error| Fault::new("INVALID_SEARCH", error.message))
    }).transpose()?;
    only(
        args,
        &[
            "en", "consulta", "carpetas", "carpeta", "modo", "campo", "tipos", "extensiones",
            "dentro_de", "tamano_min", "tamano_max", "modificado_desde", "modificado_hasta",
            "orden", "limite", "desde", "propiedades",
        ],
    )?;
    let selected = if let Some(list) = args.get("carpetas") {
        let refs = list
            .as_array()
            .filter(|a| !a.is_empty() && a.len() <= 64)
            .ok_or_else(|| invalid("carpetas debe ser una lista de 1 a 64 carpetas."))?;
        let mut folders = Vec::with_capacity(refs.len());
        for item in refs {
            let reference = item.as_str().filter(|s| !s.is_empty()).ok_or_else(|| invalid("Cada carpeta debe ser texto."))?;
            folders.push(access::resolve_folder(base, Some(reference), &["encontrar"])?);
        }
        folders
    } else if let Some(reference) = optional(args, "carpeta")? {
        vec![access::resolve_folder(base, Some(reference), &["encontrar"])?]
    } else {
        let mut findable = Vec::new();
        for folder in access::folders(base)? {
            if access::folder_access(base, &folder)?.contains(&"encontrar") {
                findable.push(folder);
            }
        }
        if findable.is_empty() {
            return Err(Fault::new(
                "ACCESS_NOT_GRANTED",
                "No hay carpetas con permiso para encontrar. Usa \"solicitar_acceso\".",
            ));
        }
        findable
    };

    let query = match optional(args, "consulta")? {
        None => String::new(),
        Some(q) if q.len() <= 256 && !q.contains('\0') => fold(q),
        Some(_) => return Err(invalid("consulta debe ser texto de hasta 256 caracteres.")),
    };
    let mode = match optional(args, "modo")?.unwrap_or("contiene") {
        "contiene" => "contains",
        "empieza" => "prefix",
        "exacto" => "exact",
        _ => return Err(invalid("modo no válido.")),
    };
    let field = match optional(args, "campo")?.unwrap_or("nombre") {
        "nombre" => "name",
        "ruta" => "path",
        _ => return Err(invalid("campo no válido.")),
    };
    let sort = match optional(args, "orden")?.unwrap_or("relevancia") {
        "relevancia" => "relevance",
        "ruta" => "path",
        "modificado" => "modified",
        "tamano" => "size",
        _ => return Err(invalid("orden no válido.")),
    };
    let types: BTreeSet<&str> = match args.get("tipos") {
        None => BTreeSet::from(["file"]),
        Some(val) => {
            let arr = val
                .as_array()
                .filter(|a| !a.is_empty() && a.len() <= 4)
                .ok_or_else(|| invalid("tipos debe ser una lista de 1 a 4 tipos."))?;
            let mut set = BTreeSet::new();
            for item in arr {
                let mapped = item.as_str().and_then(type_in).ok_or_else(|| invalid("tipo no válido."))?;
                set.insert(mapped);
            }
            set
        }
    };
    let extensions: Option<BTreeSet<String>> = match args.get("extensiones") {
        None => None,
        Some(val) => {
            let arr = val
                .as_array()
                .filter(|a| !a.is_empty() && a.len() <= 32)
                .ok_or_else(|| invalid("extensiones no es válido."))?;
            let mut set = BTreeSet::new();
            for item in arr {
                let raw = item
                    .as_str()
                    .filter(|s| !s.is_empty() && s.len() <= 33 && !s.contains(['/', '\\', '\0']))
                    .ok_or_else(|| invalid("extensiones no es válido."))?;
                let normalized = if raw.starts_with('.') {
                    fold(raw)
                } else {
                    fold(&format!(".{raw}"))
                };
                set.insert(normalized);
            }
            Some(set)
        }
    };
    let path_prefix = match optional(args, "dentro_de")? {
        None => None,
        Some(p) => {
            let trimmed = p.trim_end_matches('/');
            validate_relative_path(trimmed, "INVALID_SEARCH")?;
            Some(format!("{trimmed}/"))
        }
    };
    let min_size = limit(args, "tamano_min", 0, MAX_SAFE_INTEGER)?;
    let max_size = limit(args, "tamano_max", 0, MAX_SAFE_INTEGER)?;
    let modified_after = match optional(args, "modificado_desde")? {
        None => None,
        Some(s) => Some(iso_to_millis(s).ok_or_else(|| invalid("modificado_desde debe ser una fecha ISO."))?),
    };
    let modified_before = match optional(args, "modificado_hasta")? {
        None => None,
        Some(s) => Some(iso_to_millis(s).ok_or_else(|| invalid("modificado_hasta debe ser una fecha ISO."))?),
    };
    let max_results = limit(args, "limite", 1, 500)?.unwrap_or(50) as usize;
    let offset = limit(args, "desde", 0, MAX_SAFE_INTEGER)?.unwrap_or(0) as usize;

    struct Hit {
        rank: u8,
        key: String,
        rel_path: String,
        folder_id: String,
        modified_ms: i64,
        size: i64,
        output: Value,
    }

    let mut hits: Vec<Hit> = Vec::new();
    let mut scopes: Vec<Value> = Vec::with_capacity(selected.len());
    for folder in &selected {
        match ensure_folder_index(base, folder, &confirm_owner) {
            Ok(index) => {
                let complete = index["issues"].as_array().is_some_and(Vec::is_empty)
                    && index["entries"]
                        .as_array()
                        .is_some_and(|list| list.iter().all(|e| e["state"] == "indexed"));
                let mut scope = json!({
                    "carpeta": folder.id,
                    "estado": "searched",
                    "indexado": index["updatedAt"],
                    "completo": complete,
                });
                let properties = match crate::motor_properties::indexed(base, folder, &index) {
                    Ok(properties) => properties,
                    Err(error) if matches!(error.code, "PROPERTIES_CORRUPT" | "RECORD_CORRUPT" | "RECORD_LINK" | "UNSAFE_PATH") => {
                        scope["codigo"] = json!(error.code);
                        if wanted.is_some() {
                            scope["estado"] = json!("index-unavailable");
                            scope["indexado"] = Value::Null;
                            scope["completo"] = Value::Null;
                            scopes.push(scope);
                            continue;
                        }
                        BTreeMap::new()
                    }
                    Err(error) => return Err(error),
                };
                scopes.push(scope);
                for entry in index["entries"].as_array().into_iter().flatten() {
                    let Some(rel_path) = entry["path"].as_str() else { continue };
                    let parts: Vec<&str> = rel_path.split('/').collect();
                    if access::excluded(folder, &parts) {
                        continue;
                    }
                    let kind = entry["type"].as_str().unwrap_or("other");
                    if !types.contains(kind) {
                        continue;
                    }
                    if let Some(prefix) = &path_prefix {
                        if !rel_path.starts_with(prefix) {
                            continue;
                        }
                    }
                    let name = rel_path.rsplit_once('/').map(|(_, n)| n).unwrap_or(rel_path);
                    if let Some(exts) = &extensions {
                        let Some(dot) = name.rfind('.').filter(|idx| *idx > 0) else { continue };
                        if !exts.contains(&fold(&name[dot..])) {
                            continue;
                        }
                    }
                    let entry_size = entry["size"].as_u64();
                    if let Some(min) = min_size {
                        if !entry_size.is_some_and(|s| s >= min) {
                            continue;
                        }
                    }
                    if let Some(max) = max_size {
                        if !entry_size.is_some_and(|s| s <= max) {
                            continue;
                        }
                    }
                    let modified_ms = entry["modifiedAt"].as_str().and_then(iso_to_millis);
                    if modified_after.is_some() || modified_before.is_some() {
                        let Some(m_ms) = modified_ms else { continue };
                        if modified_after.is_some_and(|after| m_ms < after) {
                            continue;
                        }
                        if modified_before.is_some_and(|before| m_ms >= before) {
                            continue;
                        }
                    }
                    let target = if field == "name" { fold(name) } else { fold(rel_path) };
                    let Some(rank) = rank_query(&target, &query, mode) else { continue };
                    let metadata = properties.get(rel_path);
                    if wanted.as_ref().is_some_and(|wanted| !crate::motor_properties::matches(metadata, wanted)) {
                        continue;
                    }
                    let mut output = entry_out(folder, entry);
                    if let Some(metadata) = metadata { output["propiedades"] = json!(metadata); }
                    hits.push(Hit {
                        rank,
                        key: fold(name),
                        rel_path: rel_path.to_owned(),
                        folder_id: folder.id.clone(),
                        modified_ms: modified_ms.unwrap_or(i64::MIN),
                        size: entry_size.and_then(|s| i64::try_from(s).ok()).unwrap_or(-1),
                        output,
                    });
                }
            }
            Err(error) => {
                scopes.push(json!({
                    "carpeta": folder.id,
                    "estado": "no-disponible",
                    "indexado": Value::Null,
                    "completo": Value::Null,
                    "codigo": error.code,
                }));
            }
        }
    }

    let cmp_utf16 = |a: &str, b: &str| a.encode_utf16().cmp(b.encode_utf16());
    let tail_cmp = |a: &Hit, b: &Hit| {
        cmp_utf16(&a.key, &b.key)
            .then_with(|| cmp_utf16(&a.rel_path, &b.rel_path))
            .then_with(|| cmp_utf16(&a.folder_id, &b.folder_id))
    };
    hits.sort_by(|a, b| match sort {
        "path" => cmp_utf16(&a.rel_path, &b.rel_path).then_with(|| cmp_utf16(&a.folder_id, &b.folder_id)),
        "modified" => b.modified_ms.cmp(&a.modified_ms).then_with(|| tail_cmp(a, b)),
        "size" => b.size.cmp(&a.size).then_with(|| tail_cmp(a, b)),
        _ => a.rank.cmp(&b.rank).then_with(|| tail_cmp(a, b)),
    });
    let total = hits.len();
    let page: Vec<Value> = hits.into_iter().skip(offset).take(max_results).map(|h| h.output).collect();
    Ok(json!({
        "total": total,
        "mostrados": page.len(),
        "desde": offset,
        "truncado": offset + page.len() < total,
        "resultados": page,
        "carpetas": scopes,
    }))
}

pub(crate) fn explore_folder(
    base: &str, args: &Map<String, Value>,
    confirm_owner: impl Fn() -> Result<(), &'static str>,
) -> Result<Value, Fault> {
    only(args, &["en", "carpeta", "ruta", "profundidad", "limite"])?;
    let folder = access::resolve_folder(base, optional(args, "carpeta")?, &["encontrar"])?;
    let prefix = optional(args, "ruta")?.unwrap_or("").trim_matches('/').to_owned();
    let depth = limit(args, "profundidad", 1, 8)?.unwrap_or(1) as usize;
    let max_entries = limit(args, "limite", 1, 1000)?.unwrap_or(200) as usize;
    let (entries, _) = match scan_folder_tree(&folder, &prefix, depth) {
        Ok(result) => result,
        Err(error) if error.code == "PATH_NOT_INDEXED" => return Err(error),
        Err(error) => {
            return Ok(json!({
                "carpeta": folder.id, "estado": "no-disponible",
                "codigo": error.code, "entradas": [],
            }));
        }
    };
    confirm_owner().map_err(|code| Fault::new(code, "Cambió el propietario de la Base."))?;
    if access::resolve_folder(base, Some(&folder.id), &["encontrar"])? != folder {
        return Err(Fault::new("ACCESS_NOT_GRANTED", "La autorización de la carpeta cambió durante la consulta."));
    }
    let total = entries.len();
    let shown: Vec<Value> = entries.iter().take(max_entries).map(|entry| entry_out(&folder, entry)).collect();
    Ok(json!({
        "carpeta": folder.id,
        "ruta": prefix,
        "ruta_absoluta": absolute_path(&folder.root, &prefix),
        "indexado": now_iso()?,
        "total": total,
        "truncado": total > max_entries,
        "entradas": shown,
    }))
}

pub(crate) fn list_removed_for_folder(
    base: &str, folder: &Folder, since_ms: Option<i64>, now_ms: i64, existing: &BTreeSet<&str>,
) -> Vec<Value> {
    let Some((data, _)) = read_base_stored(base, &removed_file(&folder.id)).ok().flatten() else {
        return Vec::new();
    };
    if data["format"] != "mind-folder-removed"
        || data["version"] != 1
        || data["generation"].as_str() != folder.generation.as_deref()
    {
        return Vec::new();
    }
    let mut results = Vec::new();
    for entry in data["entries"].as_array().into_iter().flatten().rev() {
        let Some(path) = entry["path"].as_str() else { continue };
        if existing.contains(path) {
            continue;
        }
        let parts: Vec<&str> = path.split('/').collect();
        if access::excluded(folder, &parts) {
            continue;
        }
        let Some(removed_ms) = entry["removedAt"].as_str().and_then(iso_to_millis) else {
            continue;
        };
        if now_ms - removed_ms > RETENTION_MS {
            continue;
        }
        if since_ms.is_some_and(|since| removed_ms < since) {
            continue;
        }
        let name = path.rsplit_once('/').map(|(_, n)| n).unwrap_or(path);
        results.push(json!({
            "carpeta": folder.id,
            "ruta": path,
            "nombre": name,
            "tipo": type_out(entry["type"].as_str().unwrap_or("file")),
            "bytes": entry["size"],
            "modificado": entry["modifiedAt"],
            "eliminado": entry["removedAt"],
            "por": entry["by"],
            "ruta_absoluta": absolute_path(&folder.root, path),
        }));
    }
    results
}

pub(crate) fn list_removed(
    base: &str, args: &Map<String, Value>,
    confirm_owner: impl Fn() -> Result<(), &'static str>,
) -> Result<Value, Fault> {
    only(args, &["en", "carpeta", "desde", "limite"])?;
    let since_ms = match optional(args, "desde")? {
        None => None,
        Some(s) => Some(iso_to_millis(s).ok_or_else(|| invalid("desde debe ser una fecha ISO."))?),
    };
    let max_entries = limit(args, "limite", 1, 500)?.unwrap_or(100) as usize;
    let selected = if let Some(reference) = optional(args, "carpeta")? {
        vec![access::resolve_folder(base, Some(reference), &["encontrar"])?]
    } else {
        let mut list = Vec::new();
        for folder in access::folders(base)? {
            if access::folder_access(base, &folder)?.contains(&"encontrar") {
                list.push(folder);
            }
        }
        list
    };
    let now_ms = now_iso().ok().and_then(|s| iso_to_millis(&s)).unwrap_or(0);
    let mut results: Vec<Value> = Vec::new();
    for folder in &selected {
        let index = ensure_folder_index(base, folder, &confirm_owner).ok();
        let existing: BTreeSet<&str> = index
            .as_ref()
            .and_then(|d| d["entries"].as_array())
            .into_iter()
            .flatten()
            .filter_map(|e| e["path"].as_str())
            .collect();
        results.extend(list_removed_for_folder(base, folder, since_ms, now_ms, &existing));
    }
    results.sort_by(|a, b| b["eliminado"].as_str().cmp(&a["eliminado"].as_str()));
    let total = results.len();
    let shown: Vec<Value> = results.into_iter().take(max_entries).collect();
    Ok(json!({
        "total": total,
        "mostrados": shown.len(),
        "eliminados": shown,
        "nota": "Solo metadatos. Mind no guarda copias: para recuperar el contenido de algo borrado fuera de Mind, usa la papelera del sistema o un respaldo.",
    }))
}

fn with_action(args: &Map<String, Value>, action: &str) -> Result<Map<String, Value>, Fault> {
    let mut copy = args.clone();
    if copy.insert("accion".into(), json!(action)).is_some() {
        return Err(invalid("La llamada incluye argumentos no admitidos."));
    }
    Ok(copy)
}

pub(crate) fn call(
    base: &str, name: &str, args: &Map<String, Value>,
    confirm_owner: impl Fn() -> Result<(), &'static str>,
) -> Result<Value, Fault> {
    match name {
        "leer" => {
            let folder = optional(args, "carpeta")?;
            let relative = optional(args, "ruta")?.ok_or_else(|| invalid("Indica la ruta relativa del archivo."))?;
            read(base, args, folder, relative)
        }
        "crear" | "crear_carpeta" | "modificar" | "editar" => {
            let folder = optional(args, "carpeta")?;
            let relative = optional(args, "ruta")?.ok_or_else(|| invalid("Indica la ruta relativa del archivo."))?;
            write(base, name, args, folder, relative, confirm_owner)
        }
        "organizar" => match prepare_organize(base, args, None, &confirm_owner)? {
            OrganizePrepared::Immediate(value) => Ok(value),
            OrganizePrepared::Confirm(confirmation) => {
                finish_organize(base, confirmation, OrganizeDecision::Pending { cancelled: false }, confirm_owner)
            }
        },
        "mover" | "renombrar" | "papelera" | "restaurar" | "borrar" | "vaciar_papelera" => {
            let mapped = with_action(args, name)?;
            call(base, "organizar", &mapped, confirm_owner)
        }
        "buscar_archivos" => search_files(base, args, confirm_owner),
        "explorar" => explore_folder(base, args, confirm_owner),
        "eliminados" => list_removed(base, args, confirm_owner),
        _ => Err(Fault::new("UNKNOWN_TOOL", "Herramienta de archivos desconocida.")),
    }
}
