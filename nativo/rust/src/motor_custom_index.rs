use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use uuid::Uuid;

use crate::{
    motor_consent::remove_base_file,
    motor_destinations::{confirm_scope, file_fault},
    motor_files::{absolute_path, read_base_stored, reconcile_folder_index, refresh_index_after_write, write_base_json, IndexChange, IndexDiff},
    motor_native::{digest, invalid, only, Fault},
    motor_owner::timestamp,
    motor_permissions::{self as access, Folder},
    motor_properties, text_write,
};

const MAX_INDEXES: usize = 200;
const MAX_ROWS: usize = 200_000;
const MAX_CSV: usize = 16 * 1024 * 1024;
const CSV_FIELDS: &[&str] = &["ruta", "nombre", "extension", "carpeta", "tipo", "bytes", "modificado", "creado", "ruta_absoluta"];

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Binding {
    folder_id: String,
    generation: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Destination {
    #[serde(flatten)]
    binding: Binding,
    relative_path: String,
}

#[derive(Clone, Deserialize, Serialize)]
struct Filters {
    prefix: Option<String>,
    types: Vec<String>,
    extensions: Option<Vec<String>>,
    properties: Option<Map<String, Value>>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Definition {
    format: String,
    version: u8,
    id: String,
    name: String,
    fields: Vec<String>,
    update: String,
    filters: Filters,
    source: Binding,
    destination: Destination,
    created_at: String,
    updated_at: String,
    last_run: Option<Value>,
}

impl Binding {
    fn new(folder: &Folder) -> Self {
        Self { folder_id: folder.id.clone(), generation: folder.generation.clone() }
    }

    fn matches(&self, folder: &Folder) -> bool {
        self.folder_id == folder.id && self.generation == folder.generation
    }
}

pub(crate) fn valid_id(id: &str) -> bool {
    id.strip_prefix("idx-").is_some_and(|suffix| suffix.len() == 12 && access::lower_hex(suffix))
}

fn filename(id: &str) -> String { format!("custom-index-{id}.json") }

fn missing() -> Fault { Fault::new("CUSTOM_INDEX_NOT_FOUND", "Ese índice personalizado no existe.") }

fn invalid_index(message: &'static str) -> Fault { Fault::new("INVALID_CUSTOM_INDEX", message) }

fn ids(base: &str) -> Result<Vec<String>, Fault> {
    let mut ids = Vec::new();
    for entry in std::fs::read_dir(base).map_err(|_| file_fault("READ_FAILED"))? {
        let entry = entry.map_err(|_| file_fault("READ_FAILED"))?;
        if let Some(id) = entry.file_name().to_str().and_then(|name| name.strip_prefix("custom-index-"))
            .and_then(|name| name.strip_suffix(".json")).filter(|id| valid_id(id))
        { ids.push(id.to_owned()); }
    }
    ids.sort();
    Ok(ids)
}

fn load(base: &str, id: &str) -> Result<(Definition, Vec<u8>), Fault> {
    if !valid_id(id) { return Err(missing()); }
    let (value, bytes) = read_base_stored(base, &filename(id))?.ok_or_else(missing)?;
    let corrupt = || Fault::new("CUSTOM_INDEX_CORRUPT", "La definición del índice personalizado no tiene el formato esperado.");
    let definition: Definition = serde_json::from_value(value).map_err(|_| corrupt())?;
    if definition.format != "mind-custom-index" || definition.version != 1 || definition.id != id
        || !definition.fields.iter().all(|field| valid_field(field)) || definition.fields.is_empty()
    { return Err(corrupt()); }
    Ok((definition, bytes))
}

fn store(base: &str, definition: &Definition, previous: Option<&[u8]>, owner: &impl Fn() -> Result<(), &'static str>) -> Result<(), Fault> {
    write_base_json(base, &filename(&definition.id), &json!(definition), previous, owner)
}

fn valid_field(field: &str) -> bool {
    CSV_FIELDS.contains(&field) || field.strip_prefix("propiedad:").is_some_and(|key| {
        (1..=64).contains(&key.chars().count()) && !key.chars().any(|ch| ch <= '\u{1f}' || matches!(ch, '\u{2028}' | '\u{2029}'))
    })
}

fn optional<'a>(args: &'a Map<String, Value>, key: &str, limit: usize) -> Result<Option<&'a str>, Fault> {
    args.get(key).map(|value| value.as_str().filter(|v| !v.is_empty() && v.encode_utf16().count() <= limit)
        .ok_or_else(|| invalid("Indica texto válido en los argumentos del índice."))).transpose()
}

fn name(args: &Map<String, Value>, previous: Option<&str>) -> Result<String, Fault> {
    optional(args, "nombre", 120)?.or(previous).map(str::trim)
        .filter(|v| !v.is_empty() && !v.chars().any(|ch| ch <= '\u{1f}')).map(str::to_owned)
        .ok_or_else(|| invalid_index("El nombre debe ser texto de 1 a 120 caracteres."))
}

fn fields(args: &Map<String, Value>, previous: Option<&[String]>) -> Result<Vec<String>, Fault> {
    let fields = match args.get("campos") {
        None => previous.map(<[String]>::to_vec).ok_or_else(|| invalid_index("Indica los campos del CSV."))?,
        Some(value) => value.as_array().filter(|a| (1..=64).contains(&a.len()))
            .ok_or_else(|| invalid_index("Indica entre 1 y 64 campos."))?
            .iter().map(|value| value.as_str().filter(|f| valid_field(f)).map(str::to_owned)
                .ok_or_else(|| invalid_index("Usa un campo del índice o propiedad:<clave>."))).collect::<Result<Vec<_>, _>>()?,
    };
    if fields.iter().collect::<BTreeSet<_>>().len() != fields.len() { return Err(invalid_index("Los campos no pueden repetirse.")); }
    Ok(fields)
}

fn update(args: &Map<String, Value>, previous: &str) -> Result<String, Fault> {
    optional(args, "actualizar", 32)?.or(Some(previous)).filter(|mode| matches!(*mode, "manual" | "al_cambiar"))
        .map(str::to_owned).ok_or_else(|| invalid_index("actualizar debe ser manual o al_cambiar."))
}

fn filters(args: &Map<String, Value>, previous: Option<&Filters>) -> Result<Filters, Fault> {
    let mut filters = previous.cloned().unwrap_or(Filters {
        prefix: None, types: vec!["file".into()], extensions: None, properties: None,
    });
    if let Some(prefix) = optional(args, "dentro_de", 4096)? {
        let prefix = prefix.trim_end_matches('/');
        if !valid_relative(prefix) { return Err(invalid_index("La subcarpeta debe ser relativa.")); }
        filters.prefix = Some(prefix.to_owned());
    }
    if let Some(value) = args.get("tipos") {
        let values = value.as_array().filter(|a| (1..=2).contains(&a.len())).ok_or_else(|| invalid("tipos debe contener de 1 a 2 textos."))?;
        let mut types: Vec<String> = Vec::new();
        for value in values {
            let kind = match value.as_str() {
                Some("archivo" | "file") => "file",
                Some("carpeta" | "directory") => "directory",
                _ => return Err(invalid_index("Tipos no válidos.")),
            };
            if !types.iter().any(|item| item == kind) { types.push(kind.to_owned()); }
        }
        filters.types = types;
    }
    if let Some(value) = args.get("extensiones") {
        let values = value.as_array().filter(|a| (1..=64).contains(&a.len()))
            .ok_or_else(|| invalid("extensiones debe contener de 1 a 64 textos."))?;
        filters.extensions = Some(values.iter().map(|value| value.as_str().map(|text| text.strip_prefix('.').unwrap_or(text))
            .filter(|text| (1..=32).contains(&text.chars().count()) && !text.contains(['.', '/', '\\']))
            .map(str::to_lowercase).ok_or_else(|| invalid_index("Extensiones no válidas."))).collect::<Result<_, _>>()?);
    }
    if let Some(value) = args.get("propiedades") {
        filters.properties = if value.is_null() { None } else {
            let map = value.as_object().filter(|map| map.len() <= 16 && map.values().all(motor_properties::scalar))
                .ok_or_else(|| invalid_index("El filtro de propiedades debe contener texto, números o booleanos."))?;
            Some(map.clone())
        };
    }
    Ok(filters)
}

fn valid_relative(path: &str) -> bool {
    !path.contains('\0') && path.split('/').all(|part| !matches!(part, "" | "." | ".."))
}

fn bindings(base: &str, definition: &Definition) -> Result<(Option<Folder>, Option<Folder>, Vec<&'static str>), Fault> {
    let all = access::folders(base)?;
    let source = all.iter().find(|folder| folder.id == definition.source.folder_id);
    let destination = all.iter().find(|folder| folder.id == definition.destination.binding.folder_id);
    let mut problems = Vec::new();
    match source {
        Some(folder) if definition.source.matches(folder) => {
            if !access::folder_access(base, folder)?.contains(&"encontrar") {
                problems.push("falta el permiso \"encontrar\" en la carpeta indexada");
            }
        }
        _ => problems.push("la carpeta indexada ya no está autorizada como cuando se creó el índice"),
    }
    match destination {
        Some(folder) if definition.destination.binding.matches(folder) => {
            if !access::folder_access(base, folder)?.contains(&"escribir") {
                problems.push("falta el permiso \"escribir\" en la carpeta del CSV");
            }
        }
        _ => problems.push("la carpeta del CSV ya no está autorizada como cuando se creó el índice"),
    }
    Ok((source.cloned(), destination.cloned(), problems))
}

fn public(definition: &Definition, csv: Option<&Path>) -> Value {
    let last = definition.last_run.as_ref().map(|run| json!({
        "fecha": run["at"], "estado": run["status"], "filas": run["rows"], "error": run["error"],
    }));
    let mut data = json!({
        "id": definition.id, "nombre": definition.name, "campos": definition.fields, "actualizar": definition.update,
        "carpeta": definition.source.folder_id, "dentro_de": definition.filters.prefix, "tipos": definition.filters.types,
        "extensiones": definition.filters.extensions, "propiedades": definition.filters.properties,
        "carpeta_csv": definition.destination.binding.folder_id, "ruta_csv": definition.destination.relative_path,
        "ultima_actualizacion": last,
    });
    if let Some(csv) = csv { data["csv"] = json!(csv); }
    data
}

pub(crate) fn call(
    base: &str, operation: &str, args: &Map<String, Value>, owner: impl Fn() -> Result<(), &'static str>,
) -> Result<Value, Fault> {
    if operation == "indices_personalizados" {
        only(args, &[])?;
        let mut found = Vec::new();
        for id in ids(base)? {
            let Ok((definition, _)) = load(base, &id) else { continue };
            let (_, destination, problems) = bindings(base, &definition)?;
            let path = destination.map(|folder| absolute_path(&folder.root, &definition.destination.relative_path));
            let mut item = public(&definition, path.as_deref());
            item["problemas"] = json!(problems);
            found.push(item);
        }
        return Ok(json!({"total": found.len(), "indices": found}));
    }
    if operation == "crear_indice" {
        only(args, &["nombre", "carpeta", "dentro_de", "tipos", "extensiones", "propiedades", "campos", "carpeta_csv", "ruta_csv", "actualizar"])?;
        let source = access::resolve_folder(base, optional(args, "carpeta", 4096)?, &["encontrar"])?;
        let destination = access::resolve_folder(base, optional(args, "carpeta_csv", 4096)?.or(Some(&source.id)), &["escribir"])?;
        let relative_path = optional(args, "ruta_csv", 4096)?.filter(|path| path.to_lowercase().ends_with(".csv") && valid_relative(path))
            .ok_or_else(|| invalid_index("La ruta del CSV debe ser relativa y terminar en .csv."))?;
        if ids(base)?.len() >= MAX_INDEXES { return Err(Fault::new("CUSTOM_INDEX_LIMIT", "Se admiten 200 índices personalizados.")); }
        let identifier = Uuid::new_v4().simple().to_string();
        let now = timestamp().ok_or_else(|| file_fault("CLOCK_UNAVAILABLE"))?;
        let definition = Definition {
            format: "mind-custom-index".into(), version: 1, id: format!("idx-{}", &identifier[..12]), name: name(args, None)?,
            fields: fields(args, None)?, update: update(args, "manual")?, filters: filters(args, None)?,
            source: Binding::new(&source), destination: Destination { binding: Binding::new(&destination), relative_path: relative_path.into() },
            created_at: now.clone(), updated_at: now, last_run: None,
        };
        store(base, &definition, None, &owner)?;
        return match regenerate(base, &definition.id, &owner) {
            Ok(outcome) => Ok(merge(public(&definition, None), outcome)),
            Err(error) => {
                let (saved, _) = load(base, &definition.id)?;
                Ok(merge(public(&saved, None), json!({"estado":"error","error":{"codigo":error.code,"mensaje":error.message}})))
            }
        };
    }
    let id = optional(args, "id", 20)?.ok_or_else(|| invalid("Indica id."))?;
    match operation {
        "actualizar_indice" => {
            only(args, &["id"])?;
            regenerate(base, id, &owner)
        }
        "modificar_indice" => {
            only(args, &["id", "nombre", "dentro_de", "tipos", "extensiones", "propiedades", "campos", "actualizar"])?;
            let (mut definition, bytes) = load(base, id)?;
            access::resolve_folder(base, Some(&definition.source.folder_id), &["encontrar"])?;
            access::resolve_folder(base, Some(&definition.destination.binding.folder_id), &["escribir"])?;
            definition.name = name(args, Some(&definition.name))?;
            definition.fields = fields(args, Some(&definition.fields))?;
            definition.update = update(args, &definition.update)?;
            definition.filters = filters(args, Some(&definition.filters))?;
            definition.updated_at = timestamp().ok_or_else(|| file_fault("CLOCK_UNAVAILABLE"))?;
            store(base, &definition, Some(&bytes), &owner)?;
            Ok(merge(public(&definition, None), regenerate(base, id, &owner)?))
        }
        "retirar_indice" => {
            only(args, &["id"])?;
            let (definition, _) = load(base, id)?;
            remove_base_file(base, &filename(id), owner)?;
            Ok(json!({"estado": "retirado", "id": id, "nota": format!("El CSV ({}) se conserva donde está.", definition.destination.relative_path)}))
        }
        _ => Err(Fault::new("UNKNOWN_TOOL", "Operación de índice desconocida.")),
    }
}

fn merge(mut detail: Value, outcome: Value) -> Value {
    if let (Some(detail), Value::Object(outcome)) = (detail.as_object_mut(), outcome) { detail.extend(outcome); }
    detail
}

pub(crate) fn regenerate(base: &str, id: &str, owner: &impl Fn() -> Result<(), &'static str>) -> Result<Value, Fault> {
    let (mut definition, previous) = load(base, id)?;
    let outcome = (|| {
        let (source, destination, problems) = bindings(base, &definition)?;
        match (source, destination, problems.is_empty()) {
            (Some(source), Some(destination), true) => generate(base, &definition, &source, &destination, owner),
            _ => Err(Fault::new("CUSTOM_INDEX_INVALID", format!("No se puede actualizar el índice: {}.", problems.join("; ")))),
        }
    })();
    let now = timestamp().ok_or_else(|| file_fault("CLOCK_UNAVAILABLE"))?;
    match &outcome {
        Ok((status, rows, version, _)) => {
            let _ = status;
            definition.last_run = Some(json!({"at":now,"status":"ok","rows":rows,"version":version,"error":null}));
        }
        Err(error) => {
            let mut run = definition.last_run.take().unwrap_or_else(|| json!({}));
            run["at"] = json!(now);
            run["status"] = json!("error");
            run["error"] = json!(error.code);
            definition.last_run = Some(run);
        }
    }
    store(base, &definition, Some(&previous), owner)?;
    outcome.map(|(status, rows, _, csv)| json!({"id":id,"estado":status,"filas":rows,"csv":csv}))
}

fn generate(
    base: &str, definition: &Definition, source: &Folder, destination: &Folder, owner: &impl Fn() -> Result<(), &'static str>,
) -> Result<(&'static str, usize, String, std::path::PathBuf), Fault> {
    let scope = access::resolve_file(base, Some(&destination.id), &definition.destination.relative_path, &["escribir"])?;
    let index = reconcile_folder_index(base, source, owner)?;
    let properties = motor_properties::indexed(base, source, &index)?;
    let (csv, rows) = render(definition, source, &index, &properties)?;
    let hash = digest(csv.as_bytes());
    let version = format!("sha256:{hash}");
    let confirm = || {
        owner()?;
        let current = access::resolve_folder(base, Some(&source.id), &["encontrar"]).map_err(|error| error.code)?;
        if current != *source { return Err("CUSTOM_INDEX_INVALID"); }
        confirm_scope(base, &scope, &["escribir"])
    };
    let initial = definition.last_run.as_ref().and_then(|run| run["version"].as_str());
    let status = if let Some(last) = initial {
        let expected = last.strip_prefix("sha256:").filter(|value| value.len() == 64 && access::lower_hex(value))
            .ok_or_else(|| Fault::new("CUSTOM_INDEX_CORRUPT", "La última versión del CSV no es válida."))?;
        let update = if expected == hash {
            match access::read_file(&scope.root, &scope.relative, MAX_CSV)? {
                Some(data) if digest(&data) == expected => confirm().map(|_| "sin-cambios"),
                Some(_) => Err("VERSION_CONFLICT"),
                None => Err("FILE_NOT_FOUND"),
            }
        } else {
            text_write::write_bytes(&scope.root, &scope.relative, csv.as_bytes(), MAX_CSV, Some(expected), confirm)
                .map(|_| "actualizado")
        };
        match update {
            Ok(status) => status,
            Err("FILE_NOT_FOUND") => create_file(&scope, &csv, confirm)?,
            Err("VERSION_CONFLICT") => return Err(Fault::new("CUSTOM_INDEX_MODIFIED_OUTSIDE", "El CSV cambió fuera de Mind y se conserva intacto.")),
            Err(code) => return Err(file_fault(code)),
        }
    } else {
        create_file(&scope, &csv, confirm)?
    };
    if status != "sin-cambios" {
        let change = if status == "creado" { IndexChange::CreateFile } else { IndexChange::ModifyFile };
        let _ = refresh_index_after_write(base, &scope, change, owner);
    }
    Ok((status, rows, version, absolute_path(&destination.root, &scope.relative)))
}

fn create_file(scope: &access::Scope, content: &str, confirm: impl FnOnce() -> Result<(), &'static str>) -> Result<&'static str, Fault> {
    match text_write::write_bytes(&scope.root, &scope.relative, content.as_bytes(), MAX_CSV, None, confirm) {
        Ok(_) => Ok("creado"),
        Err("FILE_EXISTS") => Err(Fault::new("CUSTOM_INDEX_DESTINATION_EXISTS", "Ya existe un archivo con ese nombre y Mind no lo reemplaza.")),
        Err(code) => Err(file_fault(code)),
    }
}

fn render(
    definition: &Definition, source: &Folder, index: &Value, properties: &BTreeMap<String, Map<String, Value>>,
) -> Result<(String, usize), Fault> {
    let filters = &definition.filters;
    let mut selected = Vec::new();
    for entry in index["entries"].as_array().into_iter().flatten() {
        let Some(path) = entry["path"].as_str() else { continue };
        let Some(kind) = entry["type"].as_str() else { continue };
        if (source.id == definition.destination.binding.folder_id && path == definition.destination.relative_path)
            || !filters.types.iter().any(|value| value == kind) || access::excluded(source, &path.split('/').collect::<Vec<_>>())
            || filters.prefix.as_deref().is_some_and(|prefix| path != prefix && !path.strip_prefix(prefix).is_some_and(|tail| tail.starts_with('/')))
            || filters.extensions.as_ref().is_some_and(|ext| !ext.contains(&extension(path, kind)))
            || filters.properties.as_ref().is_some_and(|wanted| !motor_properties::matches(properties.get(path), wanted))
        { continue; }
        selected.push((path, kind, entry));
    }
    if selected.len() > MAX_ROWS { return Err(too_large()); }
    // SQLite y el JS de r3 ordenan aquí por bytes UTF-8, no por el nombre visible.
    selected.sort_by_key(|(path, _, _)| *path);
    let mut csv = String::from("\u{feff}");
    for (i, field) in definition.fields.iter().enumerate() {
        if i > 0 { csv.push(','); }
        cell(&mut csv, &json!(field));
    }
    csv.push_str("\r\n");
    for (path, kind, entry) in &selected {
        for (i, field) in definition.fields.iter().enumerate() {
            if i > 0 { csv.push(','); }
            let value = match field.as_str() {
                "ruta" => json!(path),
                "nombre" => json!(path.rsplit('/').next().unwrap_or(path)),
                "extension" => json!(extension(path, kind)),
                "carpeta" => json!(path.rsplit_once('/').map_or("", |(parent, _)| parent)),
                "tipo" => json!(if *kind == "file" { "archivo" } else { "carpeta" }),
                "bytes" => entry["size"].clone(),
                "modificado" => entry["modifiedAt"].clone(),
                "creado" => entry["createdAt"].clone(),
                "ruta_absoluta" => json!(absolute_path(&source.root, path)),
                property => property.strip_prefix("propiedad:").and_then(|key| properties.get(*path)?.get(key)).cloned().unwrap_or(Value::Null),
            };
            cell(&mut csv, &value);
            if csv.len() > MAX_CSV { return Err(too_large()); }
        }
        csv.push_str("\r\n");
        if csv.len() > MAX_CSV { return Err(too_large()); }
    }
    Ok((csv, selected.len()))
}

fn extension(path: &str, kind: &str) -> String {
    if kind != "file" { return String::new(); }
    path.rsplit('/').next().and_then(|name| name.rsplit_once('.')).filter(|(before, _)| !before.is_empty())
        .map(|(_, suffix)| suffix.to_lowercase()).unwrap_or_default()
}

fn cell(csv: &mut String, value: &Value) {
    let text = match value {
        Value::Null => return,
        Value::String(text) => text.clone(),
        Value::Number(number) => number.as_f64().map(|n| n.to_string()).unwrap_or_default(),
        other => other.to_string(),
    };
    let escape = text.contains(['"', ',', '\r', '\n']);
    if escape { csv.push('"'); }
    if value.is_string() && text.starts_with(['=', '+', '-', '@', '\t', '\r']) { csv.push('\''); }
    for ch in text.chars() {
        if ch == '"' { csv.push('"'); }
        csv.push(ch);
    }
    if escape { csv.push('"'); }
}

fn too_large() -> Fault { Fault::new("CUSTOM_INDEX_TOO_LARGE", "Acota los filtros para que el CSV no supere 200 000 filas ni 16 MiB.") }

#[derive(Default)]
pub(crate) struct Automatic {
    pending: BTreeMap<String, Instant>,
}

pub(crate) struct Watch {
    definition: Definition,
}

impl Watch {
    pub(crate) fn folder_id(&self) -> &str { &self.definition.source.folder_id }
}

pub(crate) fn watches(base: &str) -> Result<Vec<Watch>, Fault> {
    let mut watches = Vec::new();
    for id in ids(base)? {
        let Ok((definition, _)) = load(base, &id) else { continue };
        if definition.update == "al_cambiar" && bindings(base, &definition)?.2.is_empty() {
            watches.push(Watch { definition });
        }
    }
    Ok(watches)
}

impl Automatic {
    pub(crate) fn clear(&mut self) { self.pending.clear(); }

    pub(crate) fn poll(
        &mut self, base: &str, watches: &[Watch], diffs: &[IndexDiff], owner: &impl Fn() -> Result<(), &'static str>,
    ) {
        let now = Instant::now();
        self.pending.retain(|id, _| watches.iter().any(|watch| &watch.definition.id == id));
        for watch in watches {
            let definition = &watch.definition;
            let changed = diffs.iter().filter(|diff| diff.folder_id == definition.source.folder_id)
                .flat_map(|diff| diff.added.iter().chain(&diff.modified).chain(&diff.removed))
                .any(|path| !watches.iter().any(|candidate| {
                    candidate.definition.destination.binding.folder_id == definition.source.folder_id
                        && candidate.definition.destination.relative_path == *path
                }));
            if changed { self.pending.insert(definition.id.clone(), now + Duration::from_millis(1500)); }
        }
        let due: Vec<_> = self.pending.iter().filter(|(_, deadline)| **deadline <= now).map(|(id, _)| id.clone()).collect();
        for id in due {
            self.pending.remove(&id);
            let _ = regenerate(base, &id, owner);
        }
    }
}
