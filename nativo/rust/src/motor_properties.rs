use std::{collections::BTreeMap, sync::LazyLock};

use regex::Regex;
use serde::{ser::SerializeMap, Serialize, Serializer};
use serde_json::{json, Map, Value};
use unicode_normalization::UnicodeNormalization;

use crate::{
    motor_destinations::{confirm_scope, file_fault},
    motor_files::{absolute_path, ensure_folder_index, iso_to_millis, read_base_stored},
    motor_native::{digest, invalid, only, Fault},
    motor_owner::timestamp,
    motor_permissions::{self as access, Folder},
    text_write,
};

const MAX_BYTES: usize = 8 * 1024 * 1024;
const MAX_ENTRIES: usize = 100_000;
const MAX_SAFE: u64 = (1 << 53) - 1;
static BAD_KEY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\p{Cc}\p{Cf}\p{Co}\p{Zl}\p{Zp}]").unwrap());

type Values = Map<String, Value>;

#[derive(Clone, serde::Deserialize, Serialize)]
pub(crate) struct Entry {
    path: String,
    identity: Option<String>,
    #[serde(serialize_with = "serialize_properties")]
    properties: Values,
}

// r3 compara el orden UTF-16 de las claves al abrir el registro.
fn serialize_properties<S: Serializer>(properties: &Values, serializer: S) -> Result<S::Ok, S::Error> {
    let mut map = serializer.serialize_map(Some(properties.len()))?;
    let mut pairs: Vec<_> = properties.iter().collect();
    pairs.sort_by(|(a, _), (b, _)| a.encode_utf16().cmp(b.encode_utf16()));
    for (key, value) in pairs { map.serialize_entry(key, value)?; }
    map.end()
}

#[derive(Default)]
struct Store {
    generation: u64,
    entries: BTreeMap<String, Entry>,
    previous: Option<Vec<u8>>,
}

fn filename(folder: &Folder) -> String { format!("folder-properties-{}.json", folder.id) }

fn corrupt() -> Fault {
    Fault::new("PROPERTIES_CORRUPT", "Las propiedades guardadas no tienen el formato esperado.")
}

fn invalid_properties(message: &'static str) -> Fault { Fault::new("INVALID_PROPERTIES", message) }

fn size_limit(message: &'static str) -> Fault { Fault::new("PROPERTIES_LIMIT_EXCEEDED", message) }

fn key(value: &str) -> Result<String, Fault> {
    let name: String = value.nfc().collect();
    if name.is_empty() || name.chars().count() > 64 || name.trim() != name || name == "__proto__" || BAD_KEY.is_match(&name) {
        return Err(invalid_properties("La clave debe tener de 1 a 64 caracteres sin espacios en los extremos ni caracteres de control."));
    }
    Ok(name)
}

pub(crate) fn scalar(value: &Value) -> bool { value.is_string() || value.is_number() || value.is_boolean() }

pub(crate) fn parse_map(value: &Value, max: usize, allow_empty: bool) -> Result<Values, Fault> {
    let object = value.as_object().filter(|map| map.len() <= max && (allow_empty || !map.is_empty()))
        .ok_or_else(|| invalid_properties("Indica un objeto de propiedades dentro de los límites admitidos."))?;
    let mut output = Map::new();
    for (name, value) in object {
        let normalized = key(name)?;
        let valid = scalar(value) && value.as_str().is_none_or(|text| {
            text.chars().count() <= 1024 && !text.chars().any(|c| matches!(c, '\0'..='\u{8}' | '\u{b}' | '\u{c}' | '\u{e}'..='\u{1f}' | '\u{7f}'))
        });
        if !valid { return Err(invalid_properties("Cada valor debe ser texto de hasta 1024 caracteres, número o booleano.")); }
        let value = if value.as_f64() == Some(0.0) { json!(0) } else { value.clone() };
        if output.insert(normalized, value).is_some() {
            return Err(invalid_properties("Dos claves coinciden después de normalizarlas."));
        }
    }
    Ok(output)
}

fn same_value(left: &Value, right: &Value) -> bool {
    if let (Some(left), Some(right)) = (left.as_f64(), right.as_f64()) { left == right } else { left == right }
}

pub(crate) fn matches(properties: Option<&Values>, wanted: &Values) -> bool {
    wanted.iter().all(|(name, expected)| properties.and_then(|props| props.get(name)).is_some_and(|actual| {
        if let (Some(actual), Some(expected)) = (actual.as_str(), expected.as_str()) {
            crate::motor_native::fold(actual) == crate::motor_native::fold(expected)
        } else {
            same_value(actual, expected)
        }
    }))
}

fn valid_path(path: &str) -> bool {
    path.encode_utf16().count() <= 4096 && !path.contains('\0')
        && path.split('/').all(|part| !matches!(part, "" | "." | ".."))
}

fn identity(value: &str) -> bool {
    let mut parts = value.split(':');
    matches!(parts.next(), Some("posix" | "nt")) && parts.by_ref().take(2).filter(|part| {
        !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit())
    }).count() == 2 && parts.next().is_none()
}

fn load(base: &str, folder: &Folder) -> Result<Store, Fault> {
    let Some((record, bytes)) = read_base_stored(base, &filename(folder))? else { return Ok(Store::default()); };
    let version = record["version"].as_u64().filter(|&v| v == 1 || v == 2).ok_or_else(corrupt)?;
    let bound = record.get("authorizationGeneration").ok_or_else(corrupt)?;
    let generation = record["generation"].as_u64().filter(|g| (1..=MAX_SAFE).contains(g)).ok_or_else(corrupt)?;
    if record.as_object().is_none_or(|fields| fields.len() != 7)
        || record["format"] != "mind-folder-properties" || record["folderId"] != folder.id
        || (!bound.is_null() && !bound.as_str().is_some_and(|value| value.len() == 36
            && value.bytes().all(|b| b == b'-' || b.is_ascii_digit() || (b'a'..=b'f').contains(&b))))
        || record["updatedAt"].as_str().and_then(iso_to_millis).is_none()
    { return Err(corrupt()); }
    let rows = record["entries"].as_array().filter(|rows| rows.len() <= MAX_ENTRIES).ok_or_else(corrupt)?;
    let mut entries = BTreeMap::new();
    let mut last: Option<&str> = None;
    for row in rows {
        let path = row["path"].as_str().filter(|path| valid_path(path)).ok_or_else(corrupt)?;
        if row.as_object().is_none_or(|map| map.len() != if version == 1 { 2 } else { 3 })
            || last.is_some_and(|previous| previous.encode_utf16().cmp(path.encode_utf16()).is_ge())
        { return Err(corrupt()); }
        let stored_id = if version == 2 {
            match row.get("identity") {
                Some(Value::Null) => None,
                Some(Value::String(string)) if identity(string) => Some(string.clone()),
                _ => return Err(corrupt()),
            }
        } else { None };
        let properties = parse_map(&row["properties"], 64, false).map_err(|_| corrupt())?;
        if row["properties"].as_object().is_none_or(|map| map.keys().any(|key| !properties.contains_key(key))) {
            return Err(corrupt());
        }
        entries.insert(path.to_owned(), Entry { path: path.to_owned(), identity: stored_id, properties });
        last = Some(path);
    }
    if bound.as_str() != folder.generation.as_deref() {
        return Ok(Store { previous: Some(bytes), ..Store::default() });
    }
    Ok(Store { generation, entries, previous: Some(bytes) })
}

fn save(
    base: &str, folder: &Folder, store: &Store, confirm: impl FnOnce() -> Result<(), &'static str>,
) -> Result<(), Fault> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Record<'a> {
        format: &'static str,
        version: u8,
        folder_id: &'a str,
        authorization_generation: Option<&'a str>,
        generation: u64,
        updated_at: String,
        entries: Vec<&'a Entry>,
    }
    if store.entries.len() > MAX_ENTRIES || store.generation >= MAX_SAFE {
        return Err(size_limit("Las propiedades de esta carpeta superan el máximo permitido."));
    }
    let mut entries: Vec<_> = store.entries.values().collect();
    entries.sort_by(|left, right| left.path.encode_utf16().cmp(right.path.encode_utf16()));
    let record = Record {
        format: "mind-folder-properties", version: 2, folder_id: &folder.id,
        authorization_generation: folder.generation.as_deref(), generation: store.generation + 1,
        updated_at: timestamp().ok_or_else(|| file_fault("CLOCK_UNAVAILABLE"))?, entries,
    };
    let mut bytes = serde_json::to_vec(&record).map_err(|_| file_fault("WRITE_FAILED"))?;
    if bytes.len() >= MAX_BYTES { return Err(size_limit("Las propiedades superan 8 MiB en esta carpeta.")); }
    bytes.push(b'\n');
    let expected = store.previous.as_deref().map(digest);
    text_write::write_bytes(base, &filename(folder), &bytes, MAX_BYTES, expected.as_deref(), confirm)
        .map(|_| ()).map_err(file_fault)
}

fn index_identity(entry: &Value) -> Option<&str> {
    if entry["state"] != "indexed" { return None; }
    entry["identity"].as_str().filter(|value| identity(value))
}

fn entry_for<'a>(store: &'a Store, indexed: &Value) -> Option<&'a Entry> {
    let actual = index_identity(indexed)?;
    store.entries.get(indexed["path"].as_str()?).filter(|entry| entry.identity.as_deref() == Some(actual))
}

pub(crate) fn indexed(
    base: &str, folder: &Folder, index: &Value,
) -> Result<BTreeMap<String, Values>, Fault> {
    let store = load(base, folder)?;
    Ok(index["entries"].as_array().into_iter().flatten()
        .filter_map(|indexed| {
            let entry = entry_for(&store, indexed)?;
            (!access::excluded(folder, &entry.path.split('/').collect::<Vec<_>>()))
                .then(|| (entry.path.clone(), entry.properties.clone()))
        }).collect())
}

pub(crate) fn snapshot(base: &str, folder: &Folder, path: &str, index: &[Value]) -> Result<Vec<Entry>, Fault> {
    let store = load(base, folder)?;
    Ok(index.iter().filter_map(|indexed| {
        let entry = entry_for(&store, indexed)?;
        let suffix = if entry.path == path { "" } else { entry.path.strip_prefix(path)?.strip_prefix('/')? };
        if access::excluded(folder, &entry.path.split('/').collect::<Vec<_>>()) { return None; }
        Some(Entry { path: suffix.into(), ..entry.clone() })
    }).collect())
}

fn subpath(root: &str, tail: &str) -> Option<String> {
    match tail {
        "" => Some(root.to_owned()),
        tail if valid_path(tail) => Some(format!("{root}/{tail}")),
        _ => None,
    }
}

fn confirm_organize(
    base: &str, folder: &Folder, owner: &impl Fn() -> Result<(), &'static str>,
) -> Result<(), &'static str> {
    owner()?;
    let current = access::resolve_folder(base, Some(&folder.id), &["organizar"]).map_err(|error| error.code)?;
    if current != *folder { return Err("ACCESS_NOT_GRANTED"); }
    Ok(())
}

pub(crate) fn restore(
    base: &str, folder: &Folder, target: &str, items: &[Entry], index: &Value,
    owner: &impl Fn() -> Result<(), &'static str>,
) -> Result<usize, Fault> {
    if items.is_empty() { return Ok(0); }
    let mut store = load(base, folder)?;
    let identities: BTreeMap<_, _> = index["entries"].as_array().into_iter().flatten()
        .filter_map(|entry| Some((entry["path"].as_str()?, index_identity(entry)?))).collect();
    let mut count = 0;
    for item in items {
        let Some(path) = subpath(target, &item.path) else { continue; };
        if access::excluded(folder, &path.split('/').collect::<Vec<_>>()) { continue; }
        let Some(&actual) = identities.get(path.as_str()) else { continue; };
        if item.identity.as_deref() != Some(actual)
            || store.entries.get(&path).is_some_and(|entry| entry.identity.as_deref() == Some(actual))
        { continue; }
        let properties = parse_map(&json!(item.properties), 64, false)?;
        store.entries.insert(path.clone(), Entry { path, properties, identity: Some(actual.to_owned()) });
        count += 1;
    }
    if count > 0 { save(base, folder, &store, || confirm_organize(base, folder, owner))?; }
    Ok(count)
}

pub(crate) fn forget(
    base: &str, folder: &Folder, source: &str, items: &[Entry], owner: &impl Fn() -> Result<(), &'static str>,
) -> Result<(), Fault> {
    if items.is_empty() { return Ok(()); }
    let mut store = load(base, folder)?;
    let before = store.entries.len();
    for item in items {
        let Some(path) = subpath(source, &item.path) else { continue; };
        if store.entries.get(&path).is_some_and(|entry| entry.identity == item.identity) {
            store.entries.remove(&path);
        }
    }
    if store.entries.len() != before { save(base, folder, &store, || confirm_organize(base, folder, owner))?; }
    Ok(())
}

pub(crate) fn rebind(
    base: &str, scope: &access::Scope, report: &text_write::Report, owner: &impl Fn() -> Result<(), &'static str>,
) -> Result<(), Fault> {
    let Some((previous, current)) = report.replaced_identity() else { return Ok(()); };
    let folder = access::resolve_folder(base, Some(&scope.id), &["escribir"])?;
    confirm_scope(base, scope, &["escribir"]).map_err(file_fault)?;
    let mut store = load(base, &folder)?;
    if let Some(entry) = store.entries.get_mut(&scope.relative).filter(|entry| entry.identity.as_deref() == Some(previous)) {
        entry.identity = Some(current.to_owned());
        save(base, &folder, &store, || {
            owner()?;
            confirm_scope(base, scope, &["escribir"])
        })?;
    }
    Ok(())
}

pub(crate) fn call(
    base: &str, modifying: bool, args: &Map<String, Value>, owner: impl Fn() -> Result<(), &'static str>,
) -> Result<Value, Fault> {
    only(args, if modifying { &["carpeta", "ruta", "asignar", "quitar"] } else { &["carpeta", "ruta"] })?;
    let reference = args.get("carpeta").map(|value| value.as_str().ok_or_else(|| invalid("Indica una carpeta."))).transpose()?;
    let required = if modifying { &["escribir"][..] } else { &["encontrar"][..] };
    let folder = access::resolve_folder(base, reference, required)?;
    let path = args.get("ruta").and_then(Value::as_str).filter(|path| valid_path(path))
        .ok_or_else(|| Fault::new("INVALID_PROPERTY_PATH", "Indica una ruta relativa con / entre componentes."))?;
    let scope = access::resolve_file(base, Some(&folder.id), path, required)?;
    let index = ensure_folder_index(base, &folder, &owner)?;
    let entry = index["entries"].as_array().into_iter().flatten().find(|entry| entry["path"] == path);
    let mut store = load(base, &folder)?;
    let before = entry.and_then(|entry| entry_for(&store, entry)).map(|entry| entry.properties.clone()).unwrap_or_default();
    if !modifying {
        confirm_scope(base, &scope, required).map_err(file_fault)?;
        return Ok(json!({
            "carpeta": folder.id, "ruta": path, "ruta_absoluta": absolute_path(&folder.root, path), "propiedades": before,
        }));
    }
    if !args.contains_key("asignar") && !args.contains_key("quitar") {
        return Err(invalid("Indica asignar, quitar o ambos."));
    }
    let set = args.get("asignar").map(|value| parse_map(value, 64, true)).transpose()?.unwrap_or_default();
    let remove = args.get("quitar").map(|value| {
        value.as_array().filter(|list| list.len() <= 64)
            .ok_or_else(|| invalid_properties("quitar debe ser una lista de hasta 64 claves."))?
            .iter().map(|item| key(item.as_str().ok_or_else(|| invalid_properties("Indica claves de texto."))?))
            .collect::<Result<Vec<_>, Fault>>()
    }).transpose()?.unwrap_or_default();
    if (set.is_empty() && remove.is_empty()) || remove.iter().any(|name| set.contains_key(name)) {
        return Err(invalid_properties("Indica claves distintas para asignar o quitar."));
    }
    let actual = if set.is_empty() {
        entry.and_then(index_identity)
    } else {
        Some(index_identity(entry.ok_or_else(|| Fault::new("PATH_NOT_INDEXED", "La ruta no figura en el índice vigente."))?)
            .ok_or_else(|| Fault::new("ENTRY_IDENTITY_UNAVAILABLE", "Se necesita una identidad verificada para asignar propiedades."))?)
    };
    let mut after = before.clone();
    for name in remove { after.remove(&name); }
    after.extend(set);
    if after.len() > 64 { return Err(size_limit("Una entrada admite como máximo 64 propiedades.")); }
    if before.len() != after.len() || !before.iter().all(|(key, value)| after.get(key).is_some_and(|other| same_value(value, other))) {
        if after.is_empty() { store.entries.remove(path); }
        else { store.entries.insert(path.to_owned(), Entry { path: path.to_owned(), identity: actual.map(str::to_owned), properties: after.clone() }); }
        save(base, &folder, &store, || { owner()?; confirm_scope(base, &scope, required) })?;
    }
    Ok(json!({"estado": "guardado", "carpeta": folder.id, "ruta": path, "propiedades": after}))
}
