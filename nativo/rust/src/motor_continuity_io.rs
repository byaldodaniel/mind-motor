use std::collections::{BTreeSet, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::{json, value::RawValue, Map, Value};

use crate::{
    motor_native::{invalid, is_id, only, Fault},
    motor_owner::timestamp,
    motor_permissions::{self as access, read_file},
    motor_records::{self, filename, validate_record, valid_timestamp, MAX_RECORD},
    text_write::write_bytes,
};

const FORMAT: &str = "mind-continuity-export";
const LIMIT: usize = 1000;
const MAX_PACKAGE: usize = 64 * 1024 * 1024;

#[derive(Deserialize)]
struct RawRecord {
    content: Box<RawValue>,
}

#[derive(Deserialize)]
struct RawPackage {
    entries: Vec<RawRecord>,
}

struct Record {
    data: Value,
    content: Box<RawValue>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Package<'a> {
    format: &'a str,
    version: u8,
    exported_at: String,
    entries: Vec<Entry<'a>>,
    missing: BTreeSet<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Entry<'a> {
    format: &'static str,
    version: u8,
    id: &'a Value,
    revision: &'a Value,
    created_at: &'a Value,
    updated_at: &'a Value,
    source: &'a Value,
    kind: &'a Value,
    content: &'a RawValue,
    references: &'a Value,
}

impl<'a> From<&'a Record> for Entry<'a> {
    fn from(record: &'a Record) -> Self {
        let data = &record.data;
        Self {
            format: "mind-continuity-entry", version: 1, id: &data["id"],
            revision: &data["revision"], created_at: &data["createdAt"],
            updated_at: &data["updatedAt"], source: &data["source"], kind: &data["kind"],
            content: &record.content, references: &data["references"],
        }
    }
}

fn require(base: &str, permission: &str) -> Result<(), Fault> {
    if !access::continuity_access(base)?.contains(&permission) {
        return Err(Fault::new("ACCESS_NOT_GRANTED", "Se necesita el permiso vigente de continuidad."));
    }
    Ok(())
}

fn load(base: &str, id: &str) -> Result<Option<Record>, Fault> {
    let Some(bytes) = read_file(base, &filename(id), MAX_RECORD)? else { return Ok(None); };
    let corrupt = |_| Fault::new("CONTINUITY_CORRUPT", "El registro técnico no contiene JSON válido.");
    let mut data: Value = serde_json::from_slice(&bytes).map_err(corrupt)?;
    validate_record(&data, id)?;
    data["references"] = json!(motor_records::parse_references(&data["references"], false)?);
    let RawRecord { content } = serde_json::from_slice(&bytes).map_err(corrupt)?;
    Ok(Some(Record { data, content }))
}

fn package_invalid() -> Fault {
    Fault::new("CONTINUITY_EXPORT_INVALID", "El paquete de continuidad no tiene el formato esperado.")
}

pub(crate) fn list(base: &str) -> Result<BTreeSet<String>, Fault> {
    let read_error = || Fault::new("READ_FAILED", "No se pudieron enumerar los registros de continuidad.");
    let mut ids = BTreeSet::new();
    for entry in std::fs::read_dir(base).map_err(|_| read_error())? {
        let entry = entry.map_err(|_| read_error())?;
        let name = entry.file_name();
        if let Some(id) = name.to_str().and_then(|name| name.strip_prefix("continuity-"))
            .and_then(|name| name.strip_suffix(".json")).filter(|id| is_id(id))
        {
            ids.insert(id.to_owned());
        }
    }
    Ok(ids)
}

fn too_many() -> Fault {
    Fault::new("CONTINUITY_TOO_LARGE", "La exportación supera el número de registros admitido.")
}

pub(crate) fn export(base: &str, args: &Map<String, Value>) -> Result<Value, Fault> {
    only(args, &["ids", "formato", "relacionados"])?;
    require(base, "leer")?;
    let format = match args.get("formato") {
        Some(value) if !value.is_null() => value.as_str().filter(|value| matches!(*value, "json" | "markdown"))
            .ok_or_else(|| invalid("formato debe ser json o markdown."))?,
        _ => "json",
    };
    let ids = match args.get("ids") {
        Some(value) => value.as_array().filter(|values| values.len() <= LIMIT)
            .ok_or_else(|| invalid("ids debe ser una lista de hasta 1000 elementos."))?
            .iter().map(|value| value.as_str().filter(|id| !id.is_empty() && id.encode_utf16().count() <= 64)
                .map(str::to_owned).ok_or_else(|| invalid("Cada id debe ser texto de hasta 64 caracteres.")))
            .collect::<Result<Vec<_>, Fault>>()?,
        None => list(base)?.into_iter().take(LIMIT).collect(),
    };
    if ids.is_empty() {
        return Ok(json!({"registros":0,"paquete":null,"nota":"No hay registros de continuidad."}));
    }
    let related = args.get("relacionados").map(|value| value.as_bool()
        .ok_or_else(|| invalid("relacionados debe ser booleano."))).transpose()?.unwrap_or(false);
    let mut seen = HashSet::new();
    let mut records = Vec::new();
    for id in ids {
        if !is_id(&id) {
            return Err(Fault::new("INVALID_CONTINUITY_ID", "El identificador de continuidad no es válido."));
        }
        if seen.insert(id.clone()) {
            records.push(load(base, &id)?.ok_or_else(|| Fault::new(
                "CONTINUITY_NOT_FOUND", "No existe un registro de continuidad con ese identificador.",
            ))?);
        }
    }

    let mut missing = BTreeSet::new();
    let mut index = 0;
    while index < records.len() {
        let targets: Vec<_> = records[index].data["references"].as_array().into_iter().flatten()
            .filter_map(|reference| reference["entry"].as_str().map(str::to_owned)).collect();
        for id in targets {
            if !seen.insert(id.clone()) { continue; }
            match load(base, &id)? {
                Some(record) if related => {
                    if records.len() == LIMIT { return Err(too_many()); }
                    records.push(record);
                }
                None => { missing.insert(id); }
                _ => {}
            }
        }
        index += 1;
    }
    require(base, "leer")?;
    let pack = Package {
        format: FORMAT, version: 1, entries: records.iter().map(Entry::from).collect(),
        exported_at: timestamp().ok_or_else(|| Fault::new("CLOCK_UNAVAILABLE", "No se pudo leer la hora."))?,
        missing,
    };
    let output = if format == "markdown" { markdown(&pack) }
        else { serde_json::to_string_pretty(&pack).map_err(|_| package_invalid())? };
    Ok(json!({"registros":pack.entries.len(),"formato":format,"faltantes":pack.missing,"paquete":output,"__mcpText":output}))
}

pub(crate) fn import(
    base: &str, args: &Map<String, Value>, owner: impl Fn() -> Result<(), &'static str>,
) -> Result<Value, Fault> {
    only(args, &["paquete"])?;
    require(base, "registrar")?;
    let text = args.get("paquete").and_then(Value::as_str).filter(|text| !text.is_empty() && text.encode_utf16().count() <= MAX_PACKAGE)
        .ok_or_else(|| invalid("Indica el JSON de un paquete de continuidad."))?;
    let pack: Value = serde_json::from_str(text).map_err(|_| package_invalid())?;
    if pack["format"] != FORMAT { return Err(package_invalid()); }
    if pack["version"] != 1 {
        return Err(Fault::new("CONTINUITY_UNSUPPORTED_VERSION", "La versión del paquete de continuidad no es compatible."));
    }
    let Some(entries) = pack["entries"].as_array().filter(|entries| entries.len() <= LIMIT) else { return Err(package_invalid()); };
    let Some(missing) = pack["missing"].as_array() else { return Err(package_invalid()); };
    if !valid_timestamp(&pack["exportedAt"]) || pack.as_object().is_none_or(|fields| fields.len() != 5) {
        return Err(package_invalid());
    }
    let mut ids = HashSet::new();
    let mut imports = Vec::new();
    let mut unchanged = Vec::new();
    let raw: RawPackage = serde_json::from_str(text).map_err(|_| package_invalid())?;
    for (value, raw) in entries.iter().zip(raw.entries) {
        let id = value["id"].as_str().filter(|id| is_id(id)).ok_or_else(package_invalid)?;
        if !ids.insert(id) { return Err(package_invalid()); }
        validate_record(value, id).map_err(|error| {
            if error.code == "CONTINUITY_UNSUPPORTED_VERSION" { error } else { package_invalid() }
        })?;
        let mut record = value.clone();
        record["references"] = json!(motor_records::parse_references(&record["references"], false)?);
        let content = compact(raw.content.get()).map_err(|_| package_invalid())?;
        imports.push((id, Record { data: record, content }));
    }
    if missing.iter().any(|value| {
        value.as_str().is_none_or(|id| !is_id(id) || ids.contains(id))
    }) { return Err(package_invalid()); }

    let mut pending = Vec::new();
    let conflict = || Fault::new("CONTINUITY_CONFLICT", "La Base ya contiene una versión distinta de un registro del paquete.");
    for (id, record) in imports {
        match load(base, id)? {
            None => pending.push((id, record)),
            Some(existing) if same_data(&existing.data, &record.data) => unchanged.push(id),
            Some(_) => return Err(conflict()),
        }
    }
    let mut imported = Vec::new();
    for (id, record) in pending {
        let mut bytes = serde_json::to_vec(&Entry::from(&record)).map_err(|_| package_invalid())?;
        bytes.push(b'\n');
        write_bytes(base, &filename(id), &bytes, MAX_RECORD, None, || {
            owner()?;
            require(base, "registrar").map_err(|error| error.code)
        }).map_err(|code| if code == "FILE_EXISTS" { conflict() }
            else { Fault::new(code, "No se pudo importar el registro de continuidad.") })?;
        imported.push(id);
    }
    Ok(json!({"estado":"importado","importados":imported,"sin_cambios":unchanged}))
}

// Conserva el orden de las claves del contenido para que r3 reconozca
// como idéntico un registro cuyo JSON compara después de volver a serializarlo.
fn compact(text: &str) -> serde_json::Result<Box<RawValue>> {
    let mut result = String::with_capacity(text.len());
    let mut quoted = false;
    let mut escaped = false;
    for ch in text.chars() {
        if quoted {
            result.push(ch);
            if escaped { escaped = false; }
            else if ch == '\\' { escaped = true; }
            else if ch == '"' { quoted = false; }
        } else if ch == '"' {
            quoted = true;
            result.push(ch);
        } else if !matches!(ch, ' ' | '\t' | '\r' | '\n') {
            result.push(ch);
        }
    }
    RawValue::from_string(result)
}

fn same_data(old: &Value, new: &Value) -> bool {
    match (old, new) {
        (Value::Number(old), Value::Number(new)) => old.as_f64() == new.as_f64(),
        (Value::Array(old), Value::Array(new)) =>
            old.len() == new.len() && old.iter().zip(new).all(|(a, b)| same_data(a, b)),
        (Value::Object(old), Value::Object(new)) =>
            old.len() == new.len() && old.iter().all(|(key, value)| new.get(key).is_some_and(|new| same_data(value, new))),
        _ => old == new,
    }
}

fn escape(text: &str) -> String {
    let mut result = String::new();
    for ch in text.chars() {
        if "\\`*_[]<>#|".contains(ch) { result.push('\\'); }
        result.push(ch);
    }
    result
}

fn markdown(pack: &Package<'_>) -> String {
    use std::fmt::Write;
    let mut out = format!("# Continuidad exportada de Mind\n\nExportado: {}\n", pack.exported_at);
    for entry in &pack.entries {
        let id = entry.id.as_str().unwrap_or_default();
        let kind = entry.kind.as_str().map_or_else(|| "Registro".into(), escape);
        let _ = write!(out, "\n## {kind} · {id}\n\n- Revisión: {}\n- Creado: {}\n- Actualizado: {}\n",
            entry.revision, entry.created_at.as_str().unwrap_or_default(), entry.updated_at.as_str().unwrap_or_default());
        if let Some(source) = entry.source.as_str() {
            let _ = writeln!(out, "- Origen declarado: {}", escape(source));
        }
        let content: Value = serde_json::from_str(entry.content.get()).unwrap_or_default();
        let content = content.as_str().map_or_else(|| serde_json::to_string_pretty(&content).unwrap_or_default(), str::to_owned);
        let longest = content.split(|ch| ch != '`').map(str::len).max().unwrap_or_default();
        let fence = "`".repeat(3.max(longest + 1));
        let _ = write!(out, "\n{fence}\n{content}\n{fence}\n");
        if let Some(refs) = entry.references.as_array().filter(|refs| !refs.is_empty()) {
            out.push_str("\nReferencias:\n\n");
            for reference in refs {
                let target = reference["entry"].as_str().map_or_else(
                    || escape(reference["locator"].as_str().unwrap_or_default()), |id| format!("registro {id}"),
                );
                let relation = reference["relation"].as_str().map_or_else(String::new, |text| format!("{}: ", escape(text)));
                let _ = writeln!(out, "- {relation}{target}");
            }
        }
    }
    if !pack.missing.is_empty() {
        out.push_str("\n## Referencias no disponibles\n\n");
        for id in &pack.missing { let _ = writeln!(out, "- {id}"); }
    }
    out
}
