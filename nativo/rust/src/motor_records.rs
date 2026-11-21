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
const MAX_RECORD: usize = 2 * 1024 * 1024;
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

fn filename(id: &str) -> String {
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

fn parse_references(value: &Value, tool: bool) -> Result<Vec<Value>, Fault> {
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

pub(crate) fn validate_record(record: &Value, id: &str) -> Result<(), Fault> {
    fn valid_timestamp(value: &Value) -> bool {
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
