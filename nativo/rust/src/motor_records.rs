use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    motor_native::Fault,
    motor_owner::timestamp,
    motor_permissions::{continuity_access, read_file, read_json},
    text_write::write_bytes,
};

const FORMAT: &str = "mind-continuity-entry";
pub(crate) const MAX_RECORD: usize = 2 * 1024 * 1024;
const MAX_CONTENT: usize = 256 * 1024;
const MAX_REVISION: u64 = (1 << 53) - 1;
const FIELDS: &[&str] = &[
    "format", "version", "id", "revision", "createdAt", "updatedAt",
    "source", "kind", "content", "references",
];

pub(crate) fn call(
    base: &str, name: &str, args: &Map<String, Value>,
    confirm_owner: impl Fn() -> Result<(), &'static str>,
) -> Result<Value, Fault> {
    let updating = match name {
        "guardar" => false,
        "actualizar" => true,
        _ => return Err(Fault::new("UNKNOWN_TOOL", "Herramienta de continuidad no disponible.")),
    };
    if args.get("en").is_some_and(|value| value != "continuidad")
        || args.keys().any(|key| {
            !["en", "tipo", "contenido", "referencias"].contains(&key.as_str())
                && !(updating && ["id", "revision"].contains(&key.as_str()))
        })
    {
        return Err(invalid("La llamada incluye argumentos de continuidad no admitidos."));
    }
    require_access(base, updating)?;
    let now = timestamp().ok_or_else(|| Fault::new("CLOCK_UNAVAILABLE", "No se pudo leer la hora."))?;

    let (id, mut record, expected) = if updating {
        if !["tipo", "contenido", "referencias"].iter().any(|key| args.contains_key(*key)) {
            return Err(Fault::new("INVALID_CONTINUITY_FIELD", "Indica al menos un campo a actualizar."));
        }
        let id = args.get("id").and_then(Value::as_str).filter(|id| is_id(id))
            .ok_or_else(|| Fault::new("INVALID_CONTINUITY_ID", "El identificador de continuidad no es válido."))?;
        let revision = args.get("revision").and_then(valid_revision)
            .ok_or_else(|| invalid("revision debe ser un entero positivo."))?;
        let name = filename(id);
        let bytes = read_file(base, &name, MAX_RECORD)?.ok_or_else(|| {
            Fault::new("CONTINUITY_NOT_FOUND", "No existe un registro de continuidad con ese identificador.")
        })?;
        let mut record: Value = serde_json::from_slice(&bytes)
            .map_err(|_| Fault::new("RECORD_CORRUPT", "El registro técnico no contiene JSON válido."))?;
        validate_record(&record, id)?;
        if record["revision"] != revision || revision == MAX_REVISION {
            return Err(revision_conflict());
        }
        record["revision"] = json!(revision + 1);
        if record["updatedAt"].as_str().is_some_and(|previous| previous < now.as_str()) {
            record["updatedAt"] = json!(now);
        }
        let digest = format!("{:x}", Sha256::digest(&bytes));
        (id.to_owned(), record, Some(digest))
    } else {
        if !args.contains_key("contenido") {
            return Err(invalid("Falta contenido."));
        }
        let id = Uuid::new_v4().to_string();
        let record = json!({
            "format": FORMAT, "version": 1, "id": id, "revision": 1,
            "createdAt": now, "updatedAt": now, "source": "Mind nativo",
            "kind": null, "content": null, "references": [],
        });
        (id, record, None)
    };
    if let Some(value) = args.get("tipo") {
        label(value, 200)?;
        record["kind"] = value.clone();
    }
    if let Some(value) = args.get("contenido") {
        validate_content(value)?;
        record["content"] = value.clone();
    }
    if let Some(value) = args.get("referencias") {
        let references = parse_references(value, true)?;
        for reference in &references {
            let Some(target) = reference["entry"].as_str() else { continue };
            if target == id {
                return Err(reference_error("Un registro no puede referirse a sí mismo."));
            }
            let existing = read_json(base, &filename(target))?.ok_or_else(|| {
                Fault::new("CONTINUITY_REFERENCE_NOT_FOUND", "La referencia apunta a un registro inexistente.")
            })?;
            validate_record(&existing, target)?;
        }
        record["references"] = json!(references);
    }

    let mut data = serde_json::to_vec(&record).map_err(|_| {
        Fault::new("WRITE_FAILED", "No se pudo preparar el registro.")
    })?;
    data.push(b'\n');
    write_bytes(base, &filename(&id), &data, MAX_RECORD, expected.as_deref(), || {
        confirm_owner()?;
        require_access(base, updating).map_err(|error| error.code)
    }).map_err(|code| {
        if code == "VERSION_CONFLICT" { revision_conflict() }
        else { Fault::new(code, "No se pudo guardar el registro de continuidad.") }
    })?;

    let references: Vec<Value> = record["references"].as_array().into_iter().flatten().map(|reference| {
        let mut item = if let Some(id) = reference["entry"].as_str() {
            json!({"registro": id})
        } else {
            json!({"ubicacion": reference["locator"]})
        };
        if let Some(relation) = reference["relation"].as_str() {
            item["relacion"] = json!(relation);
        }
        item
    }).collect();
    Ok(json!({
        "estado": if updating { "actualizado" } else { "registrado" },
        "registro": {
            "id": id, "revision": record["revision"], "creado": record["createdAt"],
            "actualizado": record["updatedAt"], "origen": record["source"], "tipo": record["kind"],
            "contenido": record["content"], "referencias": references,
        },
    }))
}

fn invalid(message: &'static str) -> Fault {
    Fault::new("INVALID_ARGUMENTS", message)
}

fn reference_error(message: &'static str) -> Fault {
    Fault::new("INVALID_CONTINUITY_REFERENCE", message)
}

fn revision_conflict() -> Fault {
    Fault::new("CONTINUITY_REVISION_CONFLICT", "El registro cambió desde la revisión indicada.")
}

fn require_access(base: &str, updating: bool) -> Result<(), Fault> {
    let access = continuity_access(base)?;
    if !access.contains(&"registrar") || (updating && !access.contains(&"leer")) {
        return Err(Fault::new("ACCESS_NOT_GRANTED", "Se necesita el permiso vigente de continuidad."));
    }
    Ok(())
}

fn is_id(value: &str) -> bool {
    Uuid::parse_str(value).is_ok_and(|uuid| uuid.to_string() == value)
}

pub(crate) fn filename(id: &str) -> String {
    format!("continuity-{id}.json")
}

fn valid_revision(value: &Value) -> Option<u64> {
    value.as_u64().filter(|revision| (1..=MAX_REVISION).contains(revision))
}

fn label(value: &Value, limit: usize) -> Result<Option<&str>, Fault> {
    if value.is_null() {
        return Ok(None);
    }
    value.as_str().filter(|text| {
        !text.is_empty() && text.encode_utf16().count() <= limit
            && !text.bytes().any(|byte| byte <= 31 || byte == 127)
    }).map(Some).ok_or_else(|| {
        Fault::new("INVALID_CONTINUITY_FIELD", "La etiqueta debe ser texto no vacío y sin controles.")
    })
}

fn validate_content(value: &Value) -> Result<(), Fault> {
    fn check(value: &Value, depth: usize) -> bool {
        depth <= 32 && match value {
            Value::Array(items) => items.iter().all(|item| check(item, depth + 1)),
            Value::Object(fields) => fields.values().all(|item| check(item, depth + 1)),
            _ => true,
        }
    }
    if !check(value, 0) {
        return Err(Fault::new("INVALID_CONTINUITY_CONTENT", "El contenido supera la profundidad admitida."));
    }
    if serde_json::to_vec(value).is_ok_and(|bytes| bytes.len() <= MAX_CONTENT) {
        return Ok(());
    }
    Err(Fault::new("CONTINUITY_TOO_LARGE", "El contenido supera el tamaño admitido."))
}

pub(crate) fn parse_references(value: &Value, tool: bool) -> Result<Vec<Value>, Fault> {
    let (entry, locator, relation) = if tool {
        ("registro", "ubicacion", "relacion")
    } else {
        ("entry", "locator", "relation")
    };
    let items = value.as_array().ok_or_else(|| reference_error("Las referencias deben ser una lista."))?;
    let mut references = Vec::new();
    for item in items {
        let fields = item.as_object().filter(|fields| {
            fields.keys().all(|key| [entry, locator, relation].contains(&key.as_str()))
        }).ok_or_else(|| reference_error("Cada referencia debe ser un objeto válido."))?;
        let mut normalized = match (fields.get(entry), fields.get(locator)) {
            (Some(value), None) => {
                let id = value.as_str().filter(|id| is_id(id))
                    .ok_or_else(|| reference_error("La referencia no tiene un ID válido."))?;
                json!({ "entry": id })
            }
            (None, Some(value)) => {
                let location = label(value, 2048).ok().flatten()
                    .ok_or_else(|| reference_error("La referencia no tiene una ubicación válida."))?;
                json!({ "locator": location })
            }
            _ => return Err(reference_error("Cada referencia indica registro o ubicación.")),
        };
        if let Some(relation) = fields.get(relation) {
            if let Some(relation) = label(relation, 200)? {
                normalized["relation"] = json!(relation);
            }
        }
        if !references.contains(&normalized) {
            references.push(normalized);
        }
        if references.len() > 100 {
            return Err(reference_error("Se admiten como máximo 100 referencias."));
        }
    }
    Ok(references)
}

pub(crate) fn valid_timestamp(value: &Value) -> bool {
    value.as_str().is_some_and(|text| text.len() == 24
        && text.bytes().enumerate().all(|(offset, byte)| match offset {
            4 | 7 => byte == b'-',
            10 => byte == b'T',
            13 | 16 => byte == b':',
            19 => byte == b'.',
            23 => byte == b'Z',
            _ => byte.is_ascii_digit(),
        }))
}

pub(crate) fn validate_record(record: &Value, id: &str) -> Result<(), Fault> {
    let corrupt = || Fault::new("CONTINUITY_CORRUPT", "El registro de continuidad no tiene el formato esperado.");
    if record["format"] != FORMAT {
        return Err(corrupt());
    }
    if record["version"] != 1 {
        return Err(Fault::new("CONTINUITY_UNSUPPORTED_VERSION", "La versión del registro no es compatible."));
    }
    if !record.as_object().is_some_and(|object| {
        object.len() == FIELDS.len() && FIELDS.iter().all(|key| object.contains_key(*key))
    }) || record["id"] != id || valid_revision(&record["revision"]).is_none()
        || !valid_timestamp(&record["createdAt"]) || !valid_timestamp(&record["updatedAt"])
        || record["updatedAt"].as_str() < record["createdAt"].as_str()
        || label(&record["source"], 200).is_err() || label(&record["kind"], 200).is_err()
        || validate_content(&record["content"]).is_err()
    {
        return Err(corrupt());
    }
    let references = parse_references(&record["references"], false).map_err(|_| corrupt())?;
    if !record["references"].as_array().is_some_and(|stored| references.len() == stored.len()) {
        return Err(corrupt());
    }
    Ok(())
}

pub(crate) fn load_conversation(base: &str, id: &str) -> Result<(Value, Vec<u8>), Fault> {
    let missing = || Fault::new("CONVERSATION_NOT_FOUND", "No existe esa conversación en Mind.");
    let bytes = read_file(base, &filename(id), MAX_RECORD)?.ok_or_else(missing)?;
    let record: Value = serde_json::from_slice(&bytes)
        .map_err(|_| Fault::new("RECORD_CORRUPT", "El registro técnico no contiene JSON válido."))?;
    if record["kind"] != "conversacion" || record["content"]["format"] != "mind-conversation" {
        return Err(missing());
    }
    validate_record(&record, id)?;
    let content = &record["content"];
    if content["version"] != 1 || crate::motor_native::valid_text(&content["title"], 200).is_none()
        || crate::motor_native::valid_text(&content["important"], 64 * 1024).is_none()
    {
        return Err(Fault::new("CONTINUITY_CORRUPT", "El registro de conversación no tiene el formato esperado."));
    }
    Ok((record, bytes))
}

fn load_entry(base: &str, id: &str) -> Result<Value, Fault> {
    if !is_id(id) {
        return Err(Fault::new("INVALID_CONTINUITY_ID", "El identificador de continuidad no es válido."));
    }
    let record = read_json(base, &filename(id))?.ok_or_else(|| {
        Fault::new("CONTINUITY_NOT_FOUND", "No existe un registro de continuidad con ese identificador.")
    })?;
    validate_record(&record, id)?;
    Ok(record)
}

pub(crate) fn consult(base: &str, args: &Map<String, Value>) -> Result<Value, Fault> {
    use crate::{motor_files::iso_to_millis, motor_native::{fold, only}, motor_permissions::check_continuity};
    only(args, &["texto", "tipo", "ids", "desde", "relacionados", "limite"])?;
    check_continuity(base, false)?;
    let text = |key: &str, max: usize| {
        args.get(key).map(|value| {
            value.as_str().filter(|text| !text.is_empty() && text.encode_utf16().count() <= max)
                .ok_or_else(|| invalid("Indica un texto válido para consultar continuidad."))
        }).transpose()
    };
    let wanted = text("texto", 256)?.map(fold);
    let kind = text("tipo", 200)?;
    let since = text("desde", 64)?.map(|value| {
        parse_since(value).ok_or_else(|| invalid("desde debe ser una fecha ISO."))
    }).transpose()?;
    let limit = args.get("limite").map(|value| value.as_u64().filter(|limit| (1..=100).contains(limit))
        .ok_or_else(|| invalid("limite debe estar entre 1 y 100."))).transpose()?.unwrap_or(20) as usize;
    let related = args.get("relacionados").and_then(Value::as_bool).unwrap_or(false);
    let requested = args.get("ids");
    let ids: Vec<String> = if let Some(ids) = requested {
        ids.as_array().filter(|ids| (1..=100).contains(&ids.len()))
            .ok_or_else(|| invalid("ids debe ser una lista de 1 a 100 textos."))?
            .iter().map(|item| item.as_str().filter(|item| !item.is_empty() && item.encode_utf16().count() <= 64)
                .map(str::to_owned).ok_or_else(|| invalid("ids debe ser una lista de textos."))).collect::<Result<_, _>>()?
    } else {
        let dir = std::fs::read_dir(base).map_err(|_| Fault::new("READ_FAILED", "No se pudo leer la Base."))?;
        let mut ids = Vec::new();
        for item in dir {
            let item = item.map_err(|_| Fault::new("READ_FAILED", "No se pudo leer la Base."))?;
            if let Some(id) = item.file_name().to_str().and_then(|name| name.strip_prefix("continuity-"))
                .and_then(|name| name.strip_suffix(".json")).filter(|id| is_id(id))
            {
                ids.push(id.to_owned());
            }
        }
        ids.sort();
        ids
    };
    let mut found = Vec::new();
    for id in ids {
        let record = match load_entry(base, &id) {
            Ok(record) => record,
            Err(error) if requested.is_some() => return Err(error),
            Err(_) => continue,
        };
        if kind.is_some_and(|kind| record["kind"] != kind)
            || since.is_some_and(|minimum| record["updatedAt"].as_str().and_then(iso_to_millis).is_some_and(|date| date < minimum))
            || wanted.as_ref().is_some_and(|wanted| {
                !fold(&json!([record["kind"], record["source"], record["content"]]).to_string()).contains(wanted)
            })
        {
            continue;
        }
        found.push(record);
    }
    found.sort_by(|left, right| right["updatedAt"].as_str().cmp(&left["updatedAt"].as_str()));
    let total = found.len();
    found.truncate(limit);
    let mut linked = Vec::new();
    if related {
        let mut seen: std::collections::BTreeSet<_> = found.iter().filter_map(|record| record["id"].as_str()).collect();
        for reference in found.iter().flat_map(|record| record["references"].as_array().into_iter().flatten()) {
            if let Some(id) = reference["entry"].as_str().filter(|id| seen.insert(id)) {
                if let Ok(record) = load_entry(base, id) { linked.push(record); }
            }
        }
    }
    let has_locators = found.iter().chain(&linked).any(|record| {
        record["references"].as_array().into_iter().flatten().any(|reference| reference.get("locator").is_some())
    });
    let indexes = if has_locators { locator_indexes(base)? } else { Vec::new() };
    let mut result = json!({
        "total": total, "mostrados": found.len(),
        "registros": found.iter().map(|record| entry_out(record, &indexes)).collect::<Vec<_>>(),
    });
    if related {
        result["relacionados"] = json!(linked.iter().map(|record| entry_out(record, &indexes)).collect::<Vec<_>>());
    }
    check_continuity(base, false)?;
    Ok(result)
}

fn parse_since(value: &str) -> Option<i64> {
    use crate::motor_files::iso_to_millis;
    if let Some(value) = iso_to_millis(value) { return Some(value); }
    let (date, time) = value.trim().split_once('T')?;
    let (time, offset) = if let Some(time) = time.strip_suffix('Z') {
        (time, 0)
    } else {
        let index = time.find(['+', '-'])?;
        let zone = &time[index + 1..];
        if !zone.is_ascii() { return None; }
        let (hours, minutes) = zone.split_once(':').or_else(|| (zone.len() == 4).then(|| zone.split_at(2)))?;
        let hours = hours.parse::<i64>().ok().filter(|value| (0..24).contains(value))?;
        let minutes = minutes.parse::<i64>().ok().filter(|value| (0..60).contains(value))?;
        let offset = (hours * 60 + minutes) * 60_000 * if time.as_bytes()[index] == b'+' { 1 } else { -1 };
        (&time[..index], offset)
    };
    let (clock, fraction) = time.split_once('.').unwrap_or((time, ""));
    if !fraction.bytes().all(|byte| byte.is_ascii_digit()) { return None; }
    let fraction = &fraction[..fraction.len().min(3)];
    let clock = if clock.matches(':').count() == 1 { format!("{clock}:00") } else { clock.to_owned() };
    iso_to_millis(&format!("{date}T{clock}.{fraction:0<3}Z")).map(|utc| utc - offset)
}

struct LocatorIndex {
    folder: crate::motor_permissions::Folder,
    findable: bool,
    indexed: bool,
    existing: std::collections::BTreeSet<String>,
    removed: std::collections::BTreeMap<String, Value>,
}

fn locator_indexes(base: &str) -> Result<Vec<LocatorIndex>, Fault> {
    use crate::{motor_files, motor_permissions as access};
    let now = timestamp().as_deref().and_then(motor_files::iso_to_millis).unwrap_or_default();
    let mut indexes = Vec::new();
    for folder in access::folders(base)? {
        let findable = access::folder_access(base, &folder)?.contains(&"encontrar");
        if !findable {
            indexes.push(LocatorIndex { folder, findable, indexed: false, existing: Default::default(), removed: Default::default() });
            continue;
        }
        let index = motor_files::load_persisted_index(base, &folder).ok().flatten().map(|(data, _)| data);
        let existing: std::collections::BTreeSet<_> = index.as_ref().into_iter()
            .flat_map(|index| index["entries"].as_array().into_iter().flatten())
            .filter_map(|entry| entry["path"].as_str())
            .filter(|path| !access::excluded(&folder, &path.split('/').collect::<Vec<_>>())).collect();
        let removed = motor_files::list_removed_for_folder(base, &folder, None, now, &existing)
            .into_iter().filter_map(|entry| Some((entry["ruta"].as_str()?.to_owned(), entry["eliminado"].clone()))).collect();
        indexes.push(LocatorIndex { folder, findable, indexed: index.is_some(), removed, existing: existing.into_iter().map(str::to_owned).collect() });
    }
    Ok(indexes)
}

fn entry_out(record: &Value, indexes: &[LocatorIndex]) -> Value {
    let refs: Vec<_> = record["references"].as_array().into_iter().flatten().map(|reference| {
        let mut output = if let Some(id) = reference.get("entry") {
            json!({"registro": id})
        } else {
            let mut output = json!({"ubicacion": reference["locator"]});
            if let Some(locator) = reference["locator"].as_str().filter(|path| !is_web_locator(path)) {
                let path = std::path::Path::new(locator);
                let relative = locator.replace('\\', "/");
                let mut candidates: Vec<_> = indexes.iter().filter_map(|index| {
                    let name = if path.is_absolute() {
                        let parts = crate::motor_workspace::relative_parts(std::path::Path::new(&index.folder.root), path)?;
                        parts.join("/")
                    } else {
                        relative.strip_prefix("./").unwrap_or(&relative).trim_start_matches('/').to_owned()
                    };
                    Some((index, name))
                }).collect();
                if path.is_absolute() {
                    // The most specific registered folder owns this location, including when access was revoked.
                    candidates.sort_by_key(|(index, _)| std::cmp::Reverse(index.folder.root.len()));
                    candidates.truncate(1);
                }
                let resolved = candidates.len() == 1;
                candidates.retain(|(index, name)| index.findable && !name.is_empty()
                    && !crate::motor_permissions::excluded(&index.folder, &name.split('/').collect::<Vec<_>>()));
                if candidates.iter().any(|(index, name)| index.existing.contains(name)
                    || (resolved && !index.indexed && crate::scan::entry_exists(&index.folder.root, name))) {
                    output["estado"] = json!("existe");
                } else if let Some(removed) = candidates.iter().find_map(|(index, name)| index.removed.get(name)) {
                    output["estado"] = json!("eliminado");
                    output["eliminado"] = removed.clone();
                } else {
                    output["estado"] = json!("desconocido");
                }
            }
            output
        };
        if let Some(relation) = reference.get("relation") { output["relacion"] = relation.clone(); }
        output
    }).collect();
    json!({
        "id": record["id"], "revision": record["revision"], "creado": record["createdAt"],
        "actualizado": record["updatedAt"], "origen": record["source"], "tipo": record["kind"],
        "contenido": record["content"], "referencias": refs,
    })
}

fn is_web_locator(value: &str) -> bool {
    value.split_once("://").is_some_and(|(scheme, _)| {
        scheme.as_bytes().first().is_some_and(u8::is_ascii_alphabetic)
            && scheme.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'.' | b'-'))
    })
}
