use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque},
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
    sync::Mutex,
};

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    motor_backup,
    motor_consent,
    motor_files::{self, iso_to_millis, millis_to_iso},
    motor_native::Fault,
    motor_owner::timestamp,
    motor_permissions::{
        self as access, check_continuity, continuity_access, folder_access, folders, lower_hex,
        read_file, read_json, registered_folders, Folder,
    },
    text_write,
};

const MAX_DEFINITION_BYTES: usize = 128 * 1024;
const MAX_JSON_BYTES: usize = 2 * 1024 * 1024;
const MAX_SUMMARY_BYTES: usize = 2048;
const MAX_TEMPLATE_CHARS: usize = 64 * 1024;
const HISTORY_LIMIT: usize = 50;
const DAY_MS: i64 = 86_400_000;
const MIN_INTERVAL_MINUTES: i64 = 15;
const MAX_INTERVAL_MINUTES: i64 = 7 * 24 * 60;
const DEFAULT_EVENT_WAIT_SECONDS: i64 = 60;
const DAY_NAMES: [&str; 7] = [
    "domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado",
];
const DEFINITION_KEYS: [&str; 5] = [
    "nombre", "descripcion", "ejecutor", "parametros", "activacion",
];
const EXECUTOR_NAMES: [&str; 6] = [
    "indexar",
    "exportar-continuidad",
    "informe-cambios",
    "plantilla-texto",
    "respaldo",
    "indice-csv",
];

fn invalid_id() -> Fault {
    Fault::new(
        "INVALID_FUNCTION_ID",
        "El identificador de función debe tener de 1 a 64 caracteres: minúsculas ASCII, números, guion o guion bajo; comenzar con letra o número.",
    )
}

fn def_err(msg: impl Into<String>) -> Fault {
    Fault::new("INVALID_FUNCTION_DEFINITION", msg.into())
}

fn act_err(msg: impl Into<String>) -> Fault {
    Fault::new("INVALID_ACTIVATION", msg.into())
}

fn valid_function_id(id: &str) -> bool {
    let b = id.as_bytes();
    (1..=64).contains(&b.len())
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b.iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-' || *c == b'_')
}

fn valid_uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().all(|b| b == b'-' || b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        && Uuid::parse_str(value).is_ok_and(|u| u.to_string() == value)
}

fn valid_folder_id(id: &str) -> bool {
    id.len() == 64 && lower_hex(id)
}

fn is_valid_iso(value: &str) -> bool {
    iso_to_millis(value).is_some()
}

fn def_file(id: &str) -> String {
    format!("function-definition-{id}.json")
}
fn consent_file(id: &str) -> String {
    format!("automation-consent-{id}.json")
}
fn state_file(id: &str) -> String {
    format!("automation-state-{id}.json")
}
fn history_file(id: &str) -> String {
    format!("function-history-{id}.json")
}

fn now_iso() -> Result<String, Fault> {
    timestamp().ok_or_else(|| Fault::new("CLOCK_UNAVAILABLE", "No se pudo leer la hora del sistema."))
}

fn now_ms() -> Result<i64, Fault> {
    let iso = now_iso()?;
    iso_to_millis(&iso).ok_or_else(|| Fault::new("CLOCK_UNAVAILABLE", "No se pudo convertir la hora."))
}

fn write_base_json(
    base: &str,
    name: &str,
    value: &Value,
    expected_bytes: Option<&[u8]>,
    confirm_owner: impl FnOnce() -> Result<(), &'static str>,
) -> Result<(), Fault> {
    let mut bytes = serde_json::to_vec_pretty(value)
        .map_err(|_| Fault::new("WRITE_FAILED", "No se pudo serializar el registro técnico."))?;
    bytes.push(b'\n');
    let expected = expected_bytes.map(|b| format!("{:x}", Sha256::digest(b)));
    text_write::write_bytes(base, name, &bytes, MAX_JSON_BYTES, expected.as_deref(), confirm_owner)
        .map(|_| ())
        .map_err(|code| Fault::new(code, "No se pudo guardar el registro de automatización en la Base."))
}

/// Conserva el orden original de claves cuando un registro fue creado por r3.
fn definition_fingerprint(definition: &Value, raw_file: Option<&[u8]>) -> String {
    if let Some(raw) = raw_file {
        if let Some(compact) = extract_compact_definition(raw) {
            return format!("{:x}", Sha256::digest(compact.as_bytes()));
        }
    }
    let compact = serde_json::to_string(definition).unwrap_or_default();
    format!("{:x}", Sha256::digest(compact.as_bytes()))
}

fn extract_compact_definition(raw: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(raw).ok()?;
    let b = text.as_bytes();
    let mut i = skip_ws(b, 0);
    if *b.get(i)? != b'{' {
        return None;
    }
    i += 1;
    loop {
        i = skip_ws(b, i);
        match *b.get(i)? {
            b'}' => return None,
            b',' => {
                i += 1;
                continue;
            }
            b'"' => {
                let key_start = i;
                let key_end = skip_json_string(b, i)?;
                let key: String = serde_json::from_str(&text[key_start..key_end]).ok()?;
                i = skip_ws(b, key_end);
                if *b.get(i)? != b':' {
                    return None;
                }
                i = skip_ws(b, i + 1);
                let val_start = i;
                let val_end = skip_json_value(b, i)?;
                if key == "definition" {
                    return minify_json_preserve_order(&text[val_start..val_end]);
                }
                i = val_end;
            }
            _ => return None,
        }
    }
}

fn skip_ws(b: &[u8], mut i: usize) -> usize {
    while i < b.len() && matches!(b[i], b' ' | b'\t' | b'\r' | b'\n') {
        i += 1;
    }
    i
}

fn skip_json_string(b: &[u8], mut i: usize) -> Option<usize> {
    if *b.get(i)? != b'"' {
        return None;
    }
    i += 1;
    while i < b.len() {
        match b[i] {
            b'\\' => i += 2,
            b'"' => return Some(i + 1),
            _ => i += 1,
        }
    }
    None
}

fn skip_json_value(b: &[u8], start: usize) -> Option<usize> {
    let i = skip_ws(b, start);
    match *b.get(i)? {
        b'"' => skip_json_string(b, i),
        b'{' | b'[' => {
            let mut depth = 0usize;
            let mut pos = i;
            while pos < b.len() {
                match b[pos] {
                    b'"' => pos = skip_json_string(b, pos)?,
                    b'{' | b'[' => {
                        depth += 1;
                        pos += 1;
                    }
                    b'}' | b']' => {
                        depth -= 1;
                        pos += 1;
                        if depth == 0 {
                            return Some(pos);
                        }
                    }
                    _ => pos += 1,
                }
            }
            None
        }
        _ => {
            let mut pos = i;
            while pos < b.len() && !matches!(b[pos], b',' | b'}' | b']' | b' ' | b'\t' | b'\r' | b'\n') {
                pos += 1;
            }
            (pos > i).then_some(pos)
        }
    }
}

fn minify_json_preserve_order(slice: &str) -> Option<String> {
    let mut out = String::with_capacity(slice.len());
    let b = slice.as_bytes();
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'"' => {
                let end = skip_json_string(b, i)?;
                out.push_str(&slice[i..end]);
                i = end;
            }
            b' ' | b'\t' | b'\r' | b'\n' => i += 1,
            ch => {
                let ch_len = slice[i..].chars().next()?.len_utf8();
                let _ = ch;
                out.push_str(&slice[i..i + ch_len]);
                i += ch_len;
            }
        }
    }
    Some(out)
}

// ---------------------------------------------------------------------------
// Registros de definición, consentimiento, estado e historial
// ---------------------------------------------------------------------------

struct FunctionVersion {
    definition: Value,
    generation: Option<String>,
    fingerprint: String,
}

fn load_function_version(base: &str, id: &str) -> Result<Option<FunctionVersion>, Fault> {
    if !valid_function_id(id) {
        return Err(invalid_id());
    }
    let Some(bytes) = read_file(base, &def_file(id), MAX_JSON_BYTES)? else {
        return Ok(None);
    };
    let data: Value = serde_json::from_slice(&bytes)
        .map_err(|_| Fault::new("FUNCTION_CORRUPT", "El registro de función no tiene el formato esperado."))?;
    let corrupt = || Fault::new("FUNCTION_CORRUPT", "El registro de función no tiene el formato esperado.");
    let Some(obj) = data.as_object() else { return Err(corrupt()) };
    let version = data["version"].as_u64();
    let generation = match (version, obj.len()) {
        (Some(1), 4) => None,
        (Some(2), 5) => {
            let Some(gen) = data["generation"].as_str().filter(|g| valid_uuid(g)) else {
                return Err(corrupt());
            };
            Some(gen.to_owned())
        }
        _ => return Err(corrupt()),
    };
    if data["format"] != "mind-function-definition"
        || data["id"] != id
        || !obj.contains_key("definition")
        || !data["definition"].is_object()
    {
        return Err(corrupt());
    }
    let fp = definition_fingerprint(&data["definition"], Some(&bytes));
    Ok(Some(FunctionVersion {
        definition: data["definition"].clone(),
        generation,
        fingerprint: fp,
    }))
}

fn list_function_ids(base: &str) -> Result<Vec<String>, Fault> {
    let entries = fs::read_dir(base).map_err(|_| Fault::new("READ_FAILED", "No se pudieron listar las funciones."))?;
    let mut ids = Vec::new();
    for entry in entries {
        let name = entry.map_err(|_| Fault::new("READ_FAILED", "No se pudo leer la lista de funciones."))?.file_name();
        let Some(name) = name.to_str() else { continue };
        if name.starts_with("function-definition-") && name.ends_with(".json") {
            let id = &name["function-definition-".len()..name.len() - ".json".len()];
            if !valid_function_id(id) {
                return Err(Fault::new("FUNCTION_CORRUPT", "Nombre de registro de función no válido."));
            }
            ids.push(id.to_owned());
        }
    }
    ids.sort();
    Ok(ids)
}

fn load_consent(base: &str, id: &str) -> Result<Option<(Value, Vec<u8>)>, Fault> {
    let Some(bytes) = read_file(base, &consent_file(id), MAX_JSON_BYTES)? else {
        return Ok(None);
    };
    let data: Value = serde_json::from_slice(&bytes)
        .map_err(|_| Fault::new("AUTOMATION_CORRUPT", "La autorización de la automatización no tiene el formato esperado."))?;
    let corrupt = || Fault::new("AUTOMATION_CORRUPT", "La autorización de la automatización no tiene el formato esperado.");
    let valid_folders = data["folders"].as_object().is_some_and(|map| {
        map.iter().all(|(fid, g)| valid_folder_id(fid) && (g.is_null() || g.as_str().is_some_and(valid_uuid)))
    });
    let valid_channel = matches!(
        data["channel"].as_str(),
        Some("formulario-del-cliente" | "consola" | "administracion-local")
    );
    if !data.is_object()
        || data["format"] != "mind-automation"
        || data["version"] != 1
        || data["functionId"] != id
        || !data["generation"].as_str().is_some_and(valid_uuid)
        || !data["fingerprint"].as_str().is_some_and(|s| s.len() == 64 && lower_hex(s))
        || !data["executor"].as_str().is_some_and(valid_function_id)
        || !valid_folders
        || !data["grantedAt"].as_str().is_some_and(is_valid_iso)
        || !valid_channel
        || !(data["client"].is_null() || data["client"].is_string())
        || !data["enabled"].is_boolean()
        || !(data["disabledAt"].is_null() || data["disabledAt"].as_str().is_some_and(is_valid_iso))
    {
        return Err(corrupt());
    }
    Ok(Some((data, bytes)))
}

fn load_state(base: &str, id: &str) -> Result<Option<(Value, Vec<u8>)>, Fault> {
    let Some(bytes) = read_file(base, &state_file(id), MAX_JSON_BYTES)? else {
        return Ok(None);
    };
    let data: Value = serde_json::from_slice(&bytes)
        .map_err(|_| Fault::new("AUTOMATION_CORRUPT", "La marca de ejecución de la automatización no tiene el formato esperado."))?;
    let corrupt = || Fault::new("AUTOMATION_CORRUPT", "La marca de ejecución de la automatización no tiene el formato esperado.");
    if !data.is_object()
        || data["format"] != "mind-automation-state"
        || data["version"] != 1
        || data["functionId"] != id
        || !(data["lastSlot"].is_null() || data["lastSlot"].as_str().is_some_and(is_valid_iso))
        || !(data["lastRunAt"].is_null() || data["lastRunAt"].as_str().is_some_and(is_valid_iso))
        || !(data["lastStatus"].is_null() || matches!(data["lastStatus"].as_str(), Some("completada" | "fallida")))
        || !(data["lastCode"].is_null() || data["lastCode"].is_string())
    {
        return Err(corrupt());
    }
    Ok(Some((data, bytes)))
}

fn load_history(base: &str, id: &str) -> Result<(Vec<Value>, Option<Vec<u8>>), Fault> {
    let Some(bytes) = read_file(base, &history_file(id), MAX_JSON_BYTES)? else {
        return Ok((Vec::new(), None));
    };
    let data: Value = serde_json::from_slice(&bytes)
        .map_err(|_| Fault::new("AUTOMATION_CORRUPT", "El historial de la automatización no tiene el formato esperado."))?;
    let corrupt = || Fault::new("AUTOMATION_CORRUPT", "El historial de la automatización no tiene el formato esperado.");
    if !data.is_object()
        || data["format"] != "mind-function-history"
        || data["version"] != 1
        || data["functionId"] != id
    {
        return Err(corrupt());
    }
    let Some(entries) = data["entries"].as_array() else {
        return Err(corrupt());
    };
    if !entries.iter().all(|e| e.is_object() && e["fecha"].is_string() && e["estado"].is_string()) {
        return Err(corrupt());
    }
    Ok((entries.clone(), Some(bytes)))
}

fn append_history(
    base: &str,
    id: &str,
    entry: Value,
    confirm_owner: impl Fn() -> Result<(), &'static str>,
) -> Result<(), Fault> {
    let (mut entries, prev) = load_history(base, id)?;
    entries.push(entry);
    if entries.len() > HISTORY_LIMIT {
        let drop = entries.len() - HISTORY_LIMIT;
        entries.drain(0..drop);
    }
    let record = json!({
        "format": "mind-function-history",
        "version": 1,
        "functionId": id,
        "entries": entries,
    });
    write_base_json(base, &history_file(id), &record, prev.as_deref(), confirm_owner)
}

fn list_history_ids(base: &str) -> Result<Vec<String>, Fault> {
    let entries = fs::read_dir(base).map_err(|_| Fault::new("READ_FAILED", "No se pudo leer la Base."))?;
    let mut ids = Vec::new();
    for entry in entries {
        let Ok(entry) = entry else { continue };
        let fname = entry.file_name();
        let Some(name) = fname.to_str() else { continue };
        if name.starts_with("function-history-") && name.ends_with(".json") {
            let id = &name["function-history-".len()..name.len() - ".json".len()];
            if valid_function_id(id) {
                ids.push(id.to_owned());
            }
        }
    }
    ids.sort();
    Ok(ids)
}

// Bloqueo por función compatible con store.js (automation-<id>.lock)
struct FunctionLock {
    path: std::path::PathBuf,
}

impl Drop for FunctionLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

fn try_acquire_lock(base: &str, id: &str) -> Result<Option<FunctionLock>, Fault> {
    if !valid_function_id(id) {
        return Err(invalid_id());
    }
    let path = Path::new(base).join(format!("automation-{id}.lock"));
    let mut opts = OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let Ok(mut file) = opts.open(&path) else {
        return Ok(None);
    };
    let created = now_iso()?;
    let payload = json!({
        "version": 1,
        "owner": Uuid::new_v4().to_string(),
        "pid": std::process::id(),
        "createdAt": created,
    })
    .to_string()
        + "\n";
    if file.write_all(payload.as_bytes()).is_err() {
        let _ = fs::remove_file(&path);
        return Err(Fault::new("LOCK_FAILED", "No se pudo registrar el bloqueo de ejecución."));
    }
    Ok(Some(FunctionLock { path }))
}

// ---------------------------------------------------------------------------
// Activación y calendario (src/automations/schedule.js)
// ---------------------------------------------------------------------------

#[derive(Clone)]
enum Activation {
    Manual,
    Daily { hour: u32, minute: u32 },
    Weekly { day: u32, hour: u32, minute: u32 },
    Interval { minutes: i64 },
    Event {
        folder: String,
        subfolder: Option<String>,
        extensions: Option<Vec<String>>,
        wait_seconds: i64,
    },
}

impl Activation {
    fn is_automatic(&self) -> bool {
        !matches!(self, Activation::Manual)
    }

    fn to_json(&self) -> Value {
        match self {
            Activation::Manual => json!({ "tipo": "manual" }),
            Activation::Daily { hour, minute } => json!({
                "tipo": "horario", "frecuencia": "diaria", "hora": hour, "minuto": minute
            }),
            Activation::Weekly { day, hour, minute } => json!({
                "tipo": "horario", "frecuencia": "semanal", "dia": day, "hora": hour, "minuto": minute
            }),
            Activation::Interval { minutes } => json!({
                "tipo": "horario", "frecuencia": "intervalo", "minutos": minutes
            }),
            Activation::Event { folder, subfolder, extensions, wait_seconds } => json!({
                "tipo": "evento", "carpeta": folder, "subcarpeta": subfolder,
                "extensiones": extensions, "esperaSegundos": wait_seconds
            }),
        }
    }

    fn describe(&self, folder_path: Option<&str>) -> String {
        match self {
            Activation::Manual => "solo manual, cuando se pide".to_owned(),
            Activation::Daily { hour, minute } => {
                format!("cada día a las {:02}:{:02} (hora local de este equipo)", hour, minute)
            }
            Activation::Weekly { day, hour, minute } => {
                let day_name = DAY_NAMES.get(*day as usize).copied().unwrap_or("día");
                format!("cada {day_name} a las {:02}:{:02} (hora local de este equipo)", hour, minute)
            }
            Activation::Interval { minutes } => {
                format!("cada {minutes} minutos, contados desde la autorización")
            }
            Activation::Event { folder, subfolder, extensions, wait_seconds } => {
                let where_desc = match folder_path {
                    Some(p) => p.to_owned(),
                    None => format!("la carpeta {}…", &folder[..12.min(folder.len())]),
                };
                let sub = subfolder
                    .as_ref()
                    .map(|s| format!(", dentro de «{s}»"))
                    .unwrap_or_default();
                let ext = extensions
                    .as_ref()
                    .map(|list| format!(", solo archivos {}", list.join(", ")))
                    .unwrap_or_default();
                format!("cuando cambie algo en {where_desc}{sub}{ext}; agrupa los cambios durante {wait_seconds} s y solo mientras haya una sesión de Mind abierta")
            }
        }
    }
}

fn parse_hour(value: &Value) -> Result<(u32, u32), Fault> {
    let s = value
        .as_str()
        .ok_or_else(|| act_err("activacion.hora debe tener el formato HH:MM (24 horas, hora local)."))?;
    let (h, m) = s
        .split_once(':')
        .filter(|(a, b)| a.len() == 2 && b.len() == 2 && a.bytes().all(|x| x.is_ascii_digit()) && b.bytes().all(|x| x.is_ascii_digit()))
        .ok_or_else(|| act_err("activacion.hora debe tener el formato HH:MM (24 horas, hora local)."))?;
    let hour: u32 = h.parse().map_err(|_| act_err("activacion.hora no es válida."))?;
    let minute: u32 = m.parse().map_err(|_| act_err("activacion.hora no es válida."))?;
    if hour > 23 || minute > 59 {
        return Err(act_err("activacion.hora debe tener el formato HH:MM (24 horas, hora local)."));
    }
    Ok((hour, minute))
}

fn only_obj_keys(obj: &Map<String, Value>, allowed: &[&str], err: fn(String) -> Fault) -> Result<(), Fault> {
    for key in obj.keys() {
        if !allowed.contains(&key.as_str()) {
            let short: String = key.chars().take(40).collect();
            return Err(err(format!(
                "Campo desconocido en activacion: {short}. Admitidos: {}.",
                allowed.join(", ")
            )));
        }
    }
    Ok(())
}

fn normalize_activation(value: Option<&Value>) -> Result<Activation, Fault> {
    let Some(val) = value else {
        return Ok(Activation::Manual);
    };
    let Some(obj) = val.as_object() else {
        return Err(act_err("activacion debe ser un objeto, por ejemplo {\"tipo\":\"manual\"}."));
    };
    match obj.get("tipo").and_then(Value::as_str) {
        Some("manual") => {
            only_obj_keys(obj, &["tipo"], act_err)?;
            Ok(Activation::Manual)
        }
        Some("horario") => match obj.get("frecuencia").and_then(Value::as_str) {
            Some("diaria") => {
                only_obj_keys(obj, &["tipo", "frecuencia", "hora"], act_err)?;
                let (hour, minute) = parse_hour(obj.get("hora").unwrap_or(&Value::Null))?;
                Ok(Activation::Daily { hour, minute })
            }
            Some("semanal") => {
                only_obj_keys(obj, &["tipo", "frecuencia", "dia", "hora"], act_err)?;
                let raw_day = obj
                    .get("dia")
                    .and_then(Value::as_str)
                    .map(|s| s.trim().to_lowercase())
                    .unwrap_or_default();
                let day = match raw_day.as_str() {
                    "domingo" => 0,
                    "lunes" => 1,
                    "martes" => 2,
                    "miércoles" | "miercoles" => 3,
                    "jueves" => 4,
                    "viernes" => 5,
                    "sábado" | "sabado" => 6,
                    _ => {
                        return Err(act_err(
                            "activacion.dia debe ser uno de: lunes, martes, miércoles, jueves, viernes, sábado, domingo.",
                        ));
                    }
                };
                let (hour, minute) = parse_hour(obj.get("hora").unwrap_or(&Value::Null))?;
                Ok(Activation::Weekly { day, hour, minute })
            }
            Some("intervalo") => {
                only_obj_keys(obj, &["tipo", "frecuencia", "minutos"], act_err)?;
                let Some(minutes) = obj.get("minutos").and_then(Value::as_i64) else {
                    return Err(act_err(format!(
                        "activacion.minutos debe ser un entero entre {MIN_INTERVAL_MINUTES} y {MAX_INTERVAL_MINUTES}."
                    )));
                };
                if !(MIN_INTERVAL_MINUTES..=MAX_INTERVAL_MINUTES).contains(&minutes) {
                    return Err(act_err(format!(
                        "activacion.minutos debe ser un entero entre {MIN_INTERVAL_MINUTES} y {MAX_INTERVAL_MINUTES}."
                    )));
                }
                Ok(Activation::Interval { minutes })
            }
            _ => Err(act_err("activacion.frecuencia debe ser diaria, semanal o intervalo.")),
        },
        Some("evento") => {
            only_obj_keys(
                obj,
                &["tipo", "carpeta", "subcarpeta", "extensiones", "espera_segundos"],
                act_err,
            )?;
            let folder = obj
                .get("carpeta")
                .and_then(Value::as_str)
                .filter(|s| valid_folder_id(s))
                .ok_or_else(|| act_err("activacion.carpeta debe ser el id de una carpeta autorizada (lo devuelve \"estado\")."))?
                .to_owned();
            let subfolder = match obj.get("subcarpeta") {
                None => None,
                Some(v) => {
                    let s = v.as_str().map(|s| s.trim_matches('/')).ok_or_else(|| {
                        act_err("activacion.subcarpeta debe ser una ruta relativa dentro de la carpeta, con \"/\" entre componentes.")
                    })?;
                    if s.is_empty()
                        || s.len() > 1024
                        || s.contains('\\')
                        || s.split('/').any(|p| p.is_empty() || p == "." || p == ".." || p.chars().any(char::is_control))
                    {
                        return Err(act_err("activacion.subcarpeta debe ser una ruta relativa dentro de la carpeta, con \"/\" entre componentes."));
                    }
                    Some(s.to_owned())
                }
            };
            let extensions = match obj.get("extensiones") {
                None => None,
                Some(v) => {
                    let arr = v.as_array().filter(|a| !a.is_empty() && a.len() <= 32).ok_or_else(|| {
                        act_err("activacion.extensiones debe ser una lista de 1 a 32 extensiones, por ejemplo [\".md\", \".txt\"].")
                    })?;
                    let mut set = BTreeSet::new();
                    for item in arr {
                        let raw = item.as_str().ok_or_else(|| {
                            act_err("activacion.extensiones debe ser una lista de 1 a 32 extensiones.")
                        })?;
                        let core = raw.strip_prefix('.').unwrap_or(raw);
                        if core.is_empty()
                            || core.len() > 32
                            || core.chars().any(|c| c == '.' || c == '/' || c == '\\' || c.is_whitespace() || c.is_control())
                        {
                            return Err(act_err("activacion.extensiones no es válido."));
                        }
                        set.insert(format!(".{}", core.to_lowercase()));
                    }
                    Some(set.into_iter().collect::<Vec<_>>())
                }
            };
            let wait = match obj.get("espera_segundos") {
                None => DEFAULT_EVENT_WAIT_SECONDS,
                Some(v) => {
                    let w = v.as_i64().filter(|n| (5..=3600).contains(n)).ok_or_else(|| {
                        act_err("activacion.espera_segundos debe ser un entero entre 5 y 3600.")
                    })?;
                    w
                }
            };
            Ok(Activation::Event { folder, subfolder, extensions, wait_seconds: wait })
        }
        _ => Err(act_err("activacion.tipo debe ser manual, horario o evento.")),
    }
}

#[derive(Clone, Copy)]
struct LocalParts {
    year: i32,
    month: u32,
    day: u32,
    weekday: u32, // 0=Sun..6=Sat
    hour: u32,
    minute: u32,
    #[allow(dead_code)]
    second: u32,
}

#[cfg(windows)]
fn local_parts(epoch_ms: i64) -> LocalParts {
    use windows_sys::Win32::Foundation::{FILETIME, SYSTEMTIME};
    #[link(name = "kernel32")]
    extern "system" {
        fn FileTimeToSystemTime(ft: *const FILETIME, st: *mut SYSTEMTIME) -> i32;
        fn SystemTimeToTzSpecificLocalTime(tz: *const std::ffi::c_void, utc: *const SYSTEMTIME, local: *mut SYSTEMTIME) -> i32;
    }
    let ticks = ((epoch_ms.max(0) as u64) + 11_644_473_600_000u64) * 10_000u64;
    let ft = FILETIME { dwLowDateTime: ticks as u32, dwHighDateTime: (ticks >> 32) as u32 };
    let mut utc = SYSTEMTIME::default();
    let mut local = SYSTEMTIME::default();
    unsafe {
        FileTimeToSystemTime(&ft, &mut utc);
        if SystemTimeToTzSpecificLocalTime(std::ptr::null(), &utc, &mut local) == 0 {
            local = utc;
        }
    }
    LocalParts {
        year: local.wYear as i32,
        month: local.wMonth as u32,
        day: local.wDay as u32,
        weekday: local.wDayOfWeek as u32,
        hour: local.wHour as u32,
        minute: local.wMinute as u32,
        second: local.wSecond as u32,
    }
}

#[cfg(windows)]
fn local_slot_ms(year: i32, month: u32, day_offset: i32, day: u32, hour: u32, minute: u32) -> i64 {
    use windows_sys::Win32::Foundation::{FILETIME, SYSTEMTIME};
    #[link(name = "kernel32")]
    extern "system" {
        fn SystemTimeToFileTime(st: *const SYSTEMTIME, ft: *mut FILETIME) -> i32;
        fn TzSpecificLocalTimeToSystemTime(tz: *const std::ffi::c_void, local: *const SYSTEMTIME, utc: *mut SYSTEMTIME) -> i32;
    }
    // Adjust calendar day using UTC civil conversion
    let approx = utc_days_from_civil(year, month, day as i32) + i64::from(day_offset);
    let (y, m, d) = civil_from_utc_days(approx);
    let local = SYSTEMTIME {
        wYear: y as u16,
        wMonth: m as u16,
        wDayOfWeek: 0,
        wDay: d as u16,
        wHour: hour as u16,
        wMinute: minute as u16,
        wSecond: 0,
        wMilliseconds: 0,
    };
    let mut utc = SYSTEMTIME::default();
    let mut ft = FILETIME::default();
    unsafe {
        if TzSpecificLocalTimeToSystemTime(std::ptr::null(), &local, &mut utc) == 0 {
            utc = local;
        }
        SystemTimeToFileTime(&utc, &mut ft);
    }
    let ticks = ((ft.dwHighDateTime as u64) << 32) | (ft.dwLowDateTime as u64);
    (ticks / 10_000).saturating_sub(11_644_473_600_000) as i64
}

#[cfg(unix)]
fn local_parts(epoch_ms: i64) -> LocalParts {
    let secs = epoch_ms.div_euclid(1000) as _;
    let mut tm = std::mem::MaybeUninit::<libc::tm>::uninit();
    unsafe {
        if libc::localtime_r(&secs, tm.as_mut_ptr()).is_null() {
            libc::gmtime_r(&secs, tm.as_mut_ptr());
        }
        let tm = tm.assume_init();
        LocalParts {
            year: tm.tm_year + 1900,
            month: (tm.tm_mon + 1) as u32,
            day: tm.tm_mday as u32,
            weekday: tm.tm_wday as u32,
            hour: tm.tm_hour as u32,
            minute: tm.tm_min as u32,
            second: tm.tm_sec as u32,
        }
    }
}

#[cfg(unix)]
fn local_slot_ms(year: i32, month: u32, day_offset: i32, day: u32, hour: u32, minute: u32) -> i64 {
    let approx = utc_days_from_civil(year, month, day as i32) + i64::from(day_offset);
    let (y, m, d) = civil_from_utc_days(approx);
    let mut tm = libc::tm {
        tm_sec: 0,
        tm_min: minute as libc::c_int,
        tm_hour: hour as libc::c_int,
        tm_mday: d as libc::c_int,
        tm_mon: (m as libc::c_int) - 1,
        tm_year: y - 1900,
        tm_wday: 0,
        tm_yday: 0,
        tm_isdst: -1,
        ..unsafe { std::mem::zeroed() }
    };
    let secs = unsafe { libc::mktime(&mut tm) };
    (secs as i64) * 1000
}

fn utc_days_from_civil(y: i32, m: u32, d: i32) -> i64 {
    let y = i64::from(y) - if m <= 2 { 1 } else { 0 };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = i64::from(if m > 2 { m - 3 } else { m + 9 });
    let doy = (153 * mp + 2) / 5 + i64::from(d) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_utc_days(z: i64) -> (i32, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };
    (year as i32, m as u32, d as u32)
}

fn latest_slot(act: &Activation, anchor_ms: i64, now_ms: i64) -> Option<i64> {
    match act {
        Activation::Interval { minutes } => {
            let step = minutes * 60_000;
            if now_ms < anchor_ms + step {
                return None;
            }
            Some(anchor_ms + ((now_ms - anchor_ms) / step) * step)
        }
        Activation::Daily { hour, minute } => {
            let p = local_parts(now_ms);
            let mut slot = local_slot_ms(p.year, p.month, 0, p.day, *hour, *minute);
            if slot > now_ms {
                slot = local_slot_ms(p.year, p.month, -1, p.day, *hour, *minute);
            }
            Some(slot)
        }
        Activation::Weekly { day, hour, minute } => {
            let p = local_parts(now_ms);
            let back = ((p.weekday as i32) - (*day as i32) + 7) % 7;
            let mut slot = local_slot_ms(p.year, p.month, -back, p.day, *hour, *minute);
            if slot > now_ms {
                slot = local_slot_ms(p.year, p.month, -back - 7, p.day, *hour, *minute);
            }
            Some(slot)
        }
        _ => None,
    }
}

fn next_slot(act: &Activation, anchor_ms: i64, after_ms: i64) -> Option<i64> {
    match act {
        Activation::Interval { minutes } => {
            let step = minutes * 60_000;
            if after_ms < anchor_ms + step {
                return Some(anchor_ms + step);
            }
            Some(anchor_ms + ((after_ms - anchor_ms) / step + 1) * step)
        }
        Activation::Daily { hour, minute } => {
            let p = local_parts(after_ms);
            let mut slot = local_slot_ms(p.year, p.month, 0, p.day, *hour, *minute);
            if slot <= after_ms {
                slot = local_slot_ms(p.year, p.month, 1, p.day, *hour, *minute);
            }
            Some(slot)
        }
        Activation::Weekly { day, hour, minute } => {
            let p = local_parts(after_ms);
            let ahead = ((*day as i32) - (p.weekday as i32) + 7) % 7;
            let mut slot = local_slot_ms(p.year, p.month, ahead, p.day, *hour, *minute);
            if slot <= after_ms {
                slot = local_slot_ms(p.year, p.month, ahead + 7, p.day, *hour, *minute);
            }
            Some(slot)
        }
        _ => None,
    }
}

fn due_slot(act: &Activation, granted_at_ms: i64, last_slot_ms: Option<i64>, now_ms: i64) -> Option<i64> {
    let slot = latest_slot(act, granted_at_ms, now_ms)?;
    let reference = last_slot_ms.map_or(granted_at_ms, |last| granted_at_ms.max(last));
    (slot > reference).then_some(slot)
}

// ---------------------------------------------------------------------------
// Validación y ejecución del catálogo fijo
// ---------------------------------------------------------------------------

struct Requirement {
    id: String,
    levels: Vec<&'static str>,
    use_desc: String,
}

struct Requirements {
    folders: Vec<Requirement>,
    continuity: Vec<&'static str>,
}

fn valid_relative_template_output(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 4096
        && value.split('/').all(|part| {
            if part.is_empty() || part == "." || part == ".." {
                return false;
            }
            if part.chars().any(|c| {
                let code = c as u32;
                code <= 0x1f || matches!(c, '\\' | ':' | '<' | '>' | '"' | '|' | '?' | '*')
            }) {
                return false;
            }
            if part.ends_with(['.', ' ']) {
                return false;
            }
            let stem = part.split('.').next().unwrap_or_default().to_ascii_uppercase();
            !matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
                && !(stem.len() == 4
                    && (stem.starts_with("COM") || stem.starts_with("LPT"))
                    && stem.as_bytes()[3].is_ascii_digit()
                    && stem.as_bytes()[3] != b'0')
        })
}

fn iso_week(year: i32, month: u32, day: u32, weekday: u32) -> i32 {
    let days = utc_days_from_civil(year, month, day as i32);
    let iso_wday = if weekday == 0 { 7 } else { weekday as i64 };
    let thursday = days + 4 - iso_wday;
    let (ty, _, _) = civil_from_utc_days(thursday);
    let jan1 = utc_days_from_civil(ty, 1, 1);
    ((thursday - jan1) / 7 + 1) as i32
}

fn template_vars(epoch_ms: i64, func_id: &str, origin: &str) -> BTreeMap<&'static str, String> {
    let p = local_parts(epoch_ms);
    let mut vars = BTreeMap::new();
    vars.insert("fecha", format!("{:04}-{:02}-{:02}", p.year, p.month, p.day));
    vars.insert("hora", format!("{:02}:{:02}", p.hour, p.minute));
    vars.insert("hora_compacta", format!("{:02}{:02}", p.hour, p.minute));
    vars.insert("anio", format!("{:04}", p.year));
    vars.insert("mes", format!("{:02}", p.month));
    vars.insert("dia", format!("{:02}", p.day));
    vars.insert("dia_semana", DAY_NAMES[p.weekday as usize].to_owned());
    vars.insert("semana", format!("{:02}", iso_week(p.year, p.month, p.day, p.weekday)));
    vars.insert("funcion", func_id.to_owned());
    vars.insert("origen", origin.to_owned());
    vars
}

fn render_template(text: &str, vars: &BTreeMap<&'static str, String>) -> Result<String, Fault> {
    let mut out = String::with_capacity(text.len());
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '{' {
            if chars.get(i + 1) == Some(&'{') {
                out.push('{');
                i += 2;
                continue;
            }
            let mut j = i + 1;
            while j < chars.len() && (chars[j].is_ascii_lowercase() || chars[j] == '_') {
                j += 1;
            }
            if j > i + 1 && chars.get(j) == Some(&'}') {
                let name: String = chars[i + 1..j].iter().collect();
                if let Some(val) = vars.get(name.as_str()) {
                    out.push_str(val);
                    i = j + 1;
                    continue;
                }
                let short: String = name.chars().take(32).collect();
                return Err(def_err(format!(
                    "Variable desconocida: {{{short}}}. Admitidas: fecha, hora, hora_compacta, anio, mes, dia, dia_semana, semana, funcion, origen. Usa {{{{ y }}}} para llaves literales."
                )));
            }
        } else if chars[i] == '}' && chars.get(i + 1) == Some(&'}') {
            out.push('}');
            i += 2;
            continue;
        }
        out.push(chars[i]);
        i += 1;
    }
    Ok(out)
}

fn check_template(value: Option<&Value>, name: &str, max: usize) -> Result<String, Fault> {
    let s = value
        .and_then(Value::as_str)
        .filter(|s| s.chars().count() <= max && !s.contains('\0'))
        .ok_or_else(|| def_err(format!("{name} debe ser texto de hasta {max} caracteres, sin NUL.")))?;
    let sample = template_vars(946_857_600_000, "ejemplo", "manual");
    render_template(s, &sample)?;
    Ok(s.to_owned())
}

fn existing_mode(value: Option<&Value>) -> Result<&'static str, Fault> {
    match value.and_then(Value::as_str) {
        None if value.is_none() => Ok("error"),
        Some("error") => Ok("error"),
        Some("reemplazar") => Ok("reemplazar"),
        _ => Err(def_err("si_existe debe ser \"error\" (no tocar un archivo existente) o \"reemplazar\".")),
    }
}

fn check_destination(value: Option<&Value>, name: &str) -> Result<(String, String), Fault> {
    let obj = value
        .and_then(Value::as_object)
        .ok_or_else(|| def_err(format!("{name} debe ser un objeto {{ carpeta, ruta }}.")))?;
    for key in obj.keys() {
        if key != "carpeta" && key != "ruta" {
            return Err(def_err(format!("Campo desconocido en {name}: {key}.")));
        }
    }
    let folder = obj
        .get("carpeta")
        .and_then(Value::as_str)
        .filter(|s| valid_folder_id(s))
        .ok_or_else(|| def_err(format!("{name}.carpeta debe ser el id de una carpeta autorizada.")))?;
    let ruta = check_template(obj.get("ruta"), &format!("{name}.ruta"), 1024)?;
    let sample = template_vars(946_857_600_000, "ejemplo", "manual");
    let rendered = render_template(&ruta, &sample)?;
    if !valid_relative_template_output(&rendered) {
        return Err(def_err(format!(
            "{name}.ruta debe ser un archivo relativo dentro de la carpeta, con \"/\" entre componentes, sin \"..\" ni caracteres como \\ : * ? \" < > | (usa {{hora_compacta}} en lugar de {{hora}})."
        )));
    }
    Ok((folder.to_owned(), ruta))
}

fn check_folder_list(value: Option<&Value>, name: &str, max: usize) -> Result<Vec<String>, Fault> {
    let arr = value
        .and_then(Value::as_array)
        .filter(|a| !a.is_empty() && a.len() <= max)
        .ok_or_else(|| def_err(format!("{name} debe ser una lista de 1 a {max} ids de carpetas autorizadas.")))?;
    let mut ids = Vec::with_capacity(arr.len());
    let mut seen = HashSet::new();
    for (idx, item) in arr.iter().enumerate() {
        let id = item
            .as_str()
            .filter(|s| valid_folder_id(s))
            .ok_or_else(|| def_err(format!("{name}[{idx}] debe ser el id de una carpeta autorizada.")))?;
        if !seen.insert(id.to_owned()) {
            return Err(def_err(format!("{name} no puede repetir carpetas.")));
        }
        ids.push(id.to_owned());
    }
    Ok(ids)
}

fn expect_params<'a>(
    definition: &'a Value,
    executor: &str,
    allowed: &[&str],
    required: &[&str],
) -> Result<&'a Map<String, Value>, Fault> {
    let params = definition
        .get("parametros")
        .and_then(Value::as_object)
        .ok_or_else(|| def_err("parametros debe ser un objeto."))?;
    for key in params.keys() {
        if !allowed.contains(&key.as_str()) {
            return Err(def_err(format!(
                "Parámetro desconocido para {executor}: {key}. Admitidos: {}.",
                allowed.join(", ")
            )));
        }
    }
    for req in required {
        if !params.contains_key(*req) {
            return Err(def_err(format!("Falta el parámetro {req} de {executor}.")));
        }
    }
    Ok(params)
}

fn check_definition(definition: &Value) -> Result<(String, Activation), Fault> {
    let obj = definition
        .as_object()
        .ok_or_else(|| def_err("La definición debe ser un objeto JSON."))?;
    for key in obj.keys() {
        if !DEFINITION_KEYS.contains(&key.as_str()) {
            return Err(def_err(format!(
                "Campo desconocido en la definición: {key}. Admitidos: {}.",
                DEFINITION_KEYS.join(", ")
            )));
        }
    }
    let bytes = serde_json::to_vec(definition).map_err(|_| def_err("La definición no es JSON válido."))?;
    if bytes.len() > MAX_DEFINITION_BYTES {
        return Err(def_err("La definición supera 128 KiB."));
    }
    if let Some(v) = obj.get("nombre") {
        let ok = v.as_str().is_some_and(|s| !s.is_empty() && s.chars().count() <= 120);
        if !ok {
            return Err(def_err("nombre debe ser texto de 1 a 120 caracteres."));
        }
    }
    if let Some(v) = obj.get("descripcion") {
        let ok = v.as_str().is_some_and(|s| s.chars().count() <= 2000);
        if !ok {
            return Err(def_err("descripcion debe ser texto de hasta 2000 caracteres."));
        }
    }
    let executor = obj
        .get("ejecutor")
        .and_then(Value::as_str)
        .filter(|name| EXECUTOR_NAMES.contains(name))
        .ok_or_else(|| {
            Fault::new(
                "EXECUTOR_NOT_FOUND",
                format!("ejecutor debe ser uno del catálogo de Mind: {}.", EXECUTOR_NAMES.join(", ")),
            )
        })?
        .to_owned();
    let activation = normalize_activation(obj.get("activacion"))?;
    match executor.as_str() {
        "indexar" => {
            let p = expect_params(definition, "indexar", &["carpetas"], &["carpetas"])?;
            check_folder_list(p.get("carpetas"), "parametros.carpetas", 32)?;
        }
        "exportar-continuidad" => {
            let p = expect_params(
                definition,
                "exportar-continuidad",
                &["destino", "formato", "tipo", "relacionados", "si_existe"],
                &["destino"],
            )?;
            check_destination(p.get("destino"), "parametros.destino")?;
            if let Some(v) = p.get("formato") {
                if !matches!(v.as_str(), Some("json" | "markdown")) {
                    return Err(def_err("parametros.formato debe ser json o markdown."));
                }
            }
            if let Some(v) = p.get("tipo") {
                if !v.as_str().is_some_and(|s| !s.is_empty() && s.chars().count() <= 200) {
                    return Err(def_err("parametros.tipo debe ser texto de 1 a 200 caracteres."));
                }
            }
            if let Some(v) = p.get("relacionados") {
                if !v.is_boolean() {
                    return Err(def_err("parametros.relacionados debe ser booleano."));
                }
            }
            existing_mode(p.get("si_existe"))?;
        }
        "informe-cambios" => {
            let p = expect_params(
                definition,
                "informe-cambios",
                &["carpetas", "destino", "dias", "maximo", "si_existe"],
                &["carpetas", "destino"],
            )?;
            check_folder_list(p.get("carpetas"), "parametros.carpetas", 16)?;
            check_destination(p.get("destino"), "parametros.destino")?;
            if let Some(v) = p.get("dias") {
                if !v.as_i64().is_some_and(|n| (1..=90).contains(&n)) {
                    return Err(def_err("parametros.dias debe ser un entero entre 1 y 90."));
                }
            }
            if let Some(v) = p.get("maximo") {
                if !v.as_i64().is_some_and(|n| (1..=5000).contains(&n)) {
                    return Err(def_err("parametros.maximo debe ser un entero entre 1 y 5000."));
                }
            }
            existing_mode(p.get("si_existe"))?;
        }
        "plantilla-texto" => {
            let p = expect_params(
                definition,
                "plantilla-texto",
                &["destino", "plantilla", "si_existe"],
                &["destino", "plantilla"],
            )?;
            check_destination(p.get("destino"), "parametros.destino")?;
            check_template(p.get("plantilla"), "parametros.plantilla", MAX_TEMPLATE_CHARS)?;
            existing_mode(p.get("si_existe"))?;
        }
        "respaldo" => {
            if let Some(p) = obj.get("parametros") {
                let Some(map) = p.as_object() else {
                    return Err(def_err("El ejecutor \"respaldo\" no admite parámetros."));
                };
                if !map.is_empty() {
                    return Err(def_err("El ejecutor \"respaldo\" no admite parámetros."));
                }
            }
        }
        "indice-csv" => {
            let p = expect_params(definition, "indice-csv", &["indice"], &["indice"])?;
            let valid = p.get("indice").and_then(Value::as_str).is_some_and(valid_custom_index_id);
            if !valid {
                return Err(def_err("El ejecutor \"indice-csv\" necesita parametros: { \"indice\": \"<id del índice>\" }."));
            }
        }
        _ => {}
    }
    Ok((executor, activation))
}

fn valid_custom_index_id(id: &str) -> bool {
    id.strip_prefix("idx-")
        .is_some_and(|hex| hex.len() == 12 && lower_hex(hex))
}

fn merge_requirement(list: &mut Vec<Requirement>, id: String, levels: &[&'static str], desc: String) {
    if let Some(existing) = list.iter_mut().find(|r| r.id == id) {
        for lvl in levels {
            if !existing.levels.contains(lvl) {
                existing.levels.push(lvl);
            }
        }
        existing.use_desc = format!("{}; {desc}", existing.use_desc);
    } else {
        list.push(Requirement { id, levels: levels.to_vec(), use_desc: desc });
    }
}

fn requirements_of(base: &str, executor: &str, definition: &Value, activation: &Activation) -> Result<Requirements, Fault> {
    let mut folders_req = Vec::new();
    let mut continuity = Vec::new();
    let p = &definition["parametros"];
    let dest_req = |dest: &Value, mode: &str, verb: &str| {
        let fid = dest["carpeta"].as_str().unwrap_or_default().to_owned();
        let ruta = motor_consent::clean_text(dest["ruta"].as_str().unwrap_or_default(), 200);
        let levels: Vec<&'static str> = if mode == "reemplazar" { vec!["leer", "escribir"] } else { vec!["escribir"] };
        let note = if mode == "reemplazar" { " (si existe, lo reemplaza)" } else { " (nunca sobrescribe)" };
        (fid, levels, format!("{verb} «{ruta}»{note}"))
    };
    match executor {
        "indexar" => {
            for item in p["carpetas"].as_array().into_iter().flatten() {
                if let Some(id) = item.as_str() {
                    merge_requirement(&mut folders_req, id.to_owned(), &["encontrar"], "reconcilia su índice (solo metadatos)".into());
                }
            }
        }
        "exportar-continuidad" => {
            let mode = p["si_existe"].as_str().unwrap_or("error");
            let (id, lvls, desc) = dest_req(&p["destino"], mode, "escribe el paquete");
            merge_requirement(&mut folders_req, id, &lvls, desc);
            continuity.push("leer");
        }
        "informe-cambios" => {
            let mode = p["si_existe"].as_str().unwrap_or("error");
            for item in p["carpetas"].as_array().into_iter().flatten() {
                if let Some(id) = item.as_str() {
                    merge_requirement(&mut folders_req, id.to_owned(), &["encontrar"], "resume sus cambios (solo metadatos)".into());
                }
            }
            let (id, lvls, desc) = dest_req(&p["destino"], mode, "escribe el informe");
            merge_requirement(&mut folders_req, id, &lvls, desc);
        }
        "plantilla-texto" => {
            let mode = p["si_existe"].as_str().unwrap_or("error");
            let (id, lvls, desc) = dest_req(&p["destino"], mode, "crea el archivo");
            merge_requirement(&mut folders_req, id, &lvls, desc);
        }
        "indice-csv" => {
            let idx_id = p["indice"].as_str().unwrap_or_default();
            let stored = read_json(base, &format!("custom-index-{idx_id}.json"))?
                .ok_or_else(|| Fault::new("CUSTOM_INDEX_NOT_FOUND", "Ese índice personalizado no existe."))?;
            let src = stored["source"]["folderId"].as_str().unwrap_or_default().to_owned();
            let dst = stored["destination"]["folderId"].as_str().unwrap_or_default().to_owned();
            let rel = stored["destination"]["relativePath"].as_str().unwrap_or_default();
            let name = stored["name"].as_str().unwrap_or(idx_id);
            merge_requirement(&mut folders_req, src, &["encontrar"], format!("indexar ({name})"));
            merge_requirement(&mut folders_req, dst, &["escribir"], format!("escribir el CSV «{rel}» (nunca sobrescribe cambios ajenos)"));
        }
        _ => {}
    }
    if let Activation::Event { folder, .. } = activation {
        merge_requirement(&mut folders_req, folder.clone(), &["encontrar"], "observa sus cambios para activar la función".into());
    }
    Ok(Requirements { folders: folders_req, continuity })
}

fn missing_permissions(base: &str, reqs: &Requirements) -> Result<Vec<Value>, Fault> {
    let all_folders = folders(base)?;
    let mut missing = Vec::new();
    for item in &reqs.folders {
        let Some(folder) = all_folders.iter().find(|f| f.id == item.id) else {
            missing.push(json!({ "carpeta": item.id, "ruta": Value::Null, "permisos": item.levels }));
            continue;
        };
        let granted = folder_access(base, folder)?;
        let lacking: Vec<&str> = item.levels.iter().copied().filter(|lvl| !granted.contains(lvl)).collect();
        if !lacking.is_empty() {
            missing.push(json!({ "carpeta": item.id, "ruta": folder.root, "permisos": lacking }));
        }
    }
    if !reqs.continuity.is_empty() {
        let cont = continuity_access(base)?;
        let lacking: Vec<&str> = reqs.continuity.iter().copied().filter(|lvl| !cont.contains(lvl)).collect();
        if !lacking.is_empty() {
            missing.push(json!({ "continuidad": lacking }));
        }
    }
    Ok(missing)
}

fn describe_missing(missing: &[Value]) -> String {
    missing
        .iter()
        .map(|item| {
            if let Some(cont) = item.get("continuidad").and_then(Value::as_array) {
                let list: Vec<_> = cont.iter().filter_map(Value::as_str).collect();
                format!("continuidad: {}", list.join(", "))
            } else {
                let id = item["carpeta"].as_str().unwrap_or_default();
                let label = item["ruta"].as_str().map(str::to_owned).unwrap_or_else(|| {
                    format!("carpeta {}… no autorizada", &id[..id.len().min(12)])
                });
                let perms: Vec<_> = item["permisos"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
                format!("{label}: {}", perms.join(", "))
            }
        })
        .collect::<Vec<_>>()
        .join("; ")
}

fn executor_label(name: &str) -> &'static str {
    match name {
        "indexar" => "Reconciliar el índice de carpetas",
        "exportar-continuidad" => "Exportar la continuidad a un archivo",
        "informe-cambios" => "Informe de cambios recientes",
        "plantilla-texto" => "Crear un texto a partir de una plantilla",
        "respaldo" => "Crear un respaldo cifrado de la Base",
        "indice-csv" => "Actualizar un índice personalizado (CSV)",
        _ => "Ejecutor",
    }
}

fn executor_catalog() -> Vec<Value> {
    vec![
        json!({
            "nombre": "indexar",
            "etiqueta": executor_label("indexar"),
            "descripcion": "Actualiza el índice de metadatos de las carpetas indicadas con lo que cambió en el disco. No abre el contenido de los archivos.",
            "parametros": { "carpetas": "lista de ids de carpetas (permiso \"encontrar\" en cada una)" },
        }),
        json!({
            "nombre": "exportar-continuidad",
            "etiqueta": executor_label("exportar-continuidad"),
            "descripcion": "Escribe los registros de continuidad (decisiones, resultados, contexto) en un paquete JSON o Markdown dentro de una carpeta autorizada.",
            "parametros": {
                "destino": "{ carpeta: id, ruta: \"Continuidad/{fecha}.md\" } (permiso \"escribir\")",
                "formato": "\"markdown\" (por defecto) o \"json\" (paquete mind-continuity-export, reimportable)",
                "tipo": "opcional: solo registros de ese tipo",
                "relacionados": "opcional: incluir también los registros referenciados",
                "si_existe": "\"error\" (por defecto, nunca sobrescribe) o \"reemplazar\" (requiere además \"leer\")",
            },
        }),
        json!({
            "nombre": "informe-cambios",
            "etiqueta": executor_label("informe-cambios"),
            "descripcion": "Escribe un resumen Markdown de lo nuevo, modificado y eliminado recientemente en las carpetas indicadas, a partir del índice y del rastro de eliminados. Solo metadatos.",
            "parametros": {
                "carpetas": "lista de ids de carpetas a resumir (permiso \"encontrar\")",
                "destino": "{ carpeta: id, ruta: \"Informes/cambios-{fecha}.md\" } (permiso \"escribir\")",
                "dias": "periodo en días, de 1 a 90 (7 por defecto)",
                "maximo": "máximo de archivos por sección, de 1 a 5000 (500 por defecto)",
                "si_existe": "\"error\" (por defecto) o \"reemplazar\" (requiere además \"leer\")",
            },
        }),
        json!({
            "nombre": "plantilla-texto",
            "etiqueta": executor_label("plantilla-texto"),
            "descripcion": "Crea un archivo de texto con una plantilla y variables simples. Nunca evalúa código.",
            "parametros": {
                "destino": "{ carpeta: id, ruta: \"Diario/{fecha}.md\" } (permiso \"escribir\")",
                "plantilla": "texto con variables entre llaves: fecha, hora, hora_compacta, anio, mes, dia, dia_semana, semana, funcion, origen; {{ y }} para llaves literales",
                "si_existe": "\"error\" (por defecto, nunca sobrescribe) o \"reemplazar\" (requiere además \"leer\")",
            },
        }),
        json!({
            "nombre": "respaldo",
            "etiqueta": executor_label("respaldo"),
            "descripcion": "Crea un respaldo cifrado en la carpeta configurada con \"mind respaldo configurar\". No admite parámetros.",
            "parametros": {},
        }),
        json!({
            "nombre": "indice-csv",
            "etiqueta": executor_label("indice-csv"),
            "descripcion": "Regenera el CSV de un índice personalizado ya creado con \"crear_indice\".",
            "parametros": { "indice": "Id del índice personalizado (idx-…)." },
        }),
    ]
}

fn consent_lines(
    base: &str,
    id: &str,
    definition: &Value,
    executor: &str,
    activation: &Activation,
    reqs: &Requirements,
) -> Result<Vec<String>, Fault> {
    let all = registered_folders(base)?;
    let name = definition["nombre"]
        .as_str()
        .map(|s| motor_consent::clean_text(s, 120))
        .unwrap_or_default();
    let title_line = if name.is_empty() {
        format!("Función «{id}».")
    } else {
        format!("Función «{id}»: «{name}» (nombre indicado por el agente, no verificado).")
    };
    let mut lines = vec![
        title_line,
        format!("Acción: {} (ejecutor de Mind «{executor}»).", executor_label(executor)),
    ];
    let event_path = match activation {
        Activation::Event { folder, .. } => all.iter().find(|f| f.id == *folder).map(|f| f.root.as_str()),
        _ => None,
    };
    lines.push(format!("Cuándo: {}.", activation.describe(event_path)));
    for item in &reqs.folders {
        let label = all
            .iter()
            .find(|f| f.id == item.id)
            .map(|f| f.root.clone())
            .unwrap_or_else(|| format!("{}… (no autorizada)", &item.id[..item.id.len().min(12)]));
        lines.push(format!(
            "Carpeta {label}: {}. Permisos que usa: {}.",
            item.use_desc,
            item.levels.join(", ")
        ));
    }
    if !reqs.continuity.is_empty() {
        lines.push(format!(
            "Continuidad de Mind: {} los registros de decisiones, resultados y contexto.",
            reqs.continuity.join(", ")
        ));
    }
    if executor == "respaldo" {
        lines.push("Crea un respaldo cifrado de la Base en la carpeta de respaldos que configuraste.".to_owned());
    }
    Ok(lines)
}

fn consent_validity<'a>(
    consent: &Value,
    version: Option<&FunctionVersion>,
    registered: &'a [Folder],
) -> Result<(), &'static str> {
    if consent["enabled"] != true {
        return Err("desactivada");
    }
    let Some(version) = version else {
        return Err("funcion-retirada");
    };
    if version.generation.as_deref() != consent["generation"].as_str()
        || version.fingerprint != consent["fingerprint"].as_str().unwrap_or_default()
    {
        return Err("definicion-cambiada");
    }
    for (folder_id, expected_gen) in consent["folders"].as_object().into_iter().flatten() {
        let Some(folder) = registered.iter().find(|f| f.id == *folder_id) else {
            return Err("carpeta-retirada");
        };
        if folder.generation.as_deref() != expected_gen.as_str() {
            return Err("carpeta-reautorizada");
        }
    }
    Ok(())
}

fn pending_automation_requests(base: &str) -> Vec<Value> {
    let Ok(entries) = fs::read_dir(base) else {
        return Vec::new();
    };
    let Ok(now) = now_iso() else {
        return Vec::new();
    };
    let mut list = Vec::new();
    for entry in entries.flatten() {
        let fname = entry.file_name();
        let Some(name) = fname.to_str() else { continue };
        if name.starts_with("consent-request-") && name.ends_with(".json") {
            if let Ok(Some(rec)) = read_json(base, name) {
                if rec["kind"] == "automatizacion"
                    && rec["expiresAt"].as_str().is_some_and(|exp| exp >= now.as_str())
                {
                    list.push(rec);
                }
            }
        }
    }
    list
}

fn status_of(
    base: &str,
    id: &str,
    version: &FunctionVersion,
    registered: &[Folder],
    pending: &[Value],
    now: i64,
) -> Value {
    let checked = check_definition(&version.definition);
    let (executor, activation, problem) = match checked {
        Ok((exec, act)) => (Some(exec), Some(act), None),
        Err(err) => (None, None, Some(err)),
    };
    let consent = match load_consent(base, id) {
        Ok(val) => val.map(|(v, _)| v),
        Err(err) => {
            return json!({
                "id": id,
                "ejecutor": executor,
                "activacion": activation.as_ref().map(Activation::to_json),
                "estado": "no-valida",
                "motivo": err.code,
                "consent": Value::Null,
                "next": Value::Null,
                "problem": err.message,
            });
        }
    };
    let state = match load_state(base, id) {
        Ok(val) => val.map(|(v, _)| v),
        Err(err) => {
            return json!({
                "id": id,
                "ejecutor": executor,
                "activacion": activation.as_ref().map(Activation::to_json),
                "estado": "no-valida",
                "motivo": err.code,
                "consent": consent,
                "next": Value::Null,
                "problem": err.message,
            });
        }
    };
    if let Some(err) = problem {
        return json!({
            "id": id,
            "ejecutor": executor,
            "activacion": Value::Null,
            "estado": "no-valida",
            "motivo": err.code,
            "consent": consent,
            "next": Value::Null,
            "problem": err.message,
        });
    }
    let act = activation.unwrap();
    if !act.is_automatic() {
        return json!({
            "id": id,
            "ejecutor": executor,
            "activacion": act.to_json(),
            "estado": "manual",
            "consent": consent,
            "next": Value::Null,
        });
    }
    let requested = pending.iter().any(|req| {
        req["automation"]["functionId"].as_str() == Some(id)
            && req["automation"]["generation"].as_str() == version.generation.as_deref()
            && req["automation"]["fingerprint"].as_str() == Some(version.fingerprint.as_str())
    });
    let Some(ref consent_val) = consent else {
        return json!({
            "id": id,
            "ejecutor": executor,
            "activacion": act.to_json(),
            "estado": if requested { "pendiente" } else { "sin-autorizar" },
            "consent": Value::Null,
            "next": Value::Null,
        });
    };
    if let Err(reason) = consent_validity(consent_val, Some(version), registered) {
        if reason == "desactivada" {
            return json!({
                "id": id,
                "ejecutor": executor,
                "activacion": act.to_json(),
                "estado": "desactivada",
                "consent": consent,
                "next": Value::Null,
            });
        }
        return json!({
            "id": id,
            "ejecutor": executor,
            "activacion": act.to_json(),
            "estado": if requested { "pendiente" } else { "caducada" },
            "motivo": reason,
            "consent": consent,
            "next": Value::Null,
        });
    }
    let next = if matches!(act, Activation::Daily { .. } | Activation::Weekly { .. } | Activation::Interval { .. }) {
        let granted_ms = consent_val["grantedAt"].as_str().and_then(iso_to_millis).unwrap_or(now);
        next_slot(&act, granted_ms, now).and_then(millis_to_iso)
    } else {
        None
    };
    json!({
        "id": id,
        "ejecutor": executor,
        "activacion": act.to_json(),
        "estado": "activa",
        "consent": consent,
        "state": state,
        "next": next,
    })
}

fn agent_summary(status: &Value) -> Value {
    let consent = &status["consent"];
    let authorized_by = if consent["enabled"] == true && status["estado"] == "activa" {
        consent["channel"].clone()
    } else {
        Value::Null
    };
    let mut out = json!({
        "ejecutor": status["ejecutor"],
        "activacion": status["activacion"],
        "automatica": status["estado"],
        "autorizada_por": authorized_by,
        "proximo_turno": status["next"],
    });
    if let Some(motivo) = status.get("motivo").filter(|v| !v.is_null()) {
        out["motivo"] = motivo.clone();
    }
    if let Some(prob) = status.get("problem").filter(|v| !v.is_null()) {
        out["problema"] = prob.clone();
    }
    out
}

// ---------------------------------------------------------------------------
// Ejecución real de cada ejecutor
// ---------------------------------------------------------------------------

fn run_executor(
    base: &str,
    motor_dir: Option<&Path>,
    id: &str,
    executor: &str,
    definition: &Value,
    origin: &str,
    date_ms: i64,
    date_iso: &str,
    confirm_owner: impl Fn() -> Result<(), &'static str>,
) -> Result<Value, Fault> {
    let params = &definition["parametros"];
    let registered = registered_folders(base)?;
    match executor {
        "indexar" => {
            let mut results = Vec::new();
            let mut first_err: Option<Fault> = None;
            let all = folders(base)?;
            for item in params["carpetas"].as_array().into_iter().flatten() {
                let Some(fid) = item.as_str() else { continue };
                let res = (|| -> Result<Value, Fault> {
                    let Some(folder) = all.iter().find(|f| f.id == fid) else {
                        return Err(Fault::new("FOLDER_NOT_AUTHORIZED", "Una carpeta que usa esta función no está autorizada en Mind."));
                    };
                    if !folder_access(base, folder)?.contains(&"encontrar") {
                        return Err(Fault::new("ACCESS_NOT_GRANTED", "El usuario no concedió el permiso \"encontrar\" en una carpeta que usa esta función."));
                    }
                    motor_files::index_folder_with_stats(base, folder, &confirm_owner)
                })();
                match res {
                    Ok(v) => results.push(v),
                    Err(e) => {
                        let code = e.code;
                        if first_err.is_none() {
                            first_err = Some(e);
                        }
                        results.push(json!({ "carpeta": fid, "estado": "fallida", "codigo": code }));
                    }
                }
            }
            if results.iter().all(|r| r["estado"] == "fallida") {
                return Err(first_err.unwrap_or_else(|| Fault::new("INDEX_FAILED", "No se pudo indexar.")));
            }
            Ok(json!({ "carpetas": results, "archivos": [] }))
        }
        "plantilla-texto" => {
            let mode = params["si_existe"].as_str().unwrap_or("error");
            let dest_fid = params["destino"]["carpeta"].as_str().unwrap_or_default();
            let vars = template_vars(date_ms, id, origin);
            let rel_path = render_template(params["destino"]["ruta"].as_str().unwrap_or_default(), &vars)?;
            if !valid_relative_template_output(&rel_path) {
                return Err(Fault::new("INVALID_OUTPUT_PATH", "La ruta de destino resultante no es válida."));
            }
            let content = render_template(params["plantilla"].as_str().unwrap_or_default(), &vars)?;
            let written = motor_files::write_output_text(base, dest_fid, &rel_path, &content, mode, confirm_owner)?;
            Ok(json!({ "archivos": [written] }))
        }
        "informe-cambios" => {
            let mode = params["si_existe"].as_str().unwrap_or("error");
            let days = params["dias"].as_i64().unwrap_or(7);
            let limit = params["maximo"].as_i64().unwrap_or(500) as usize;
            let dest_fid = params["destino"]["carpeta"].as_str().unwrap_or_default();
            let vars = template_vars(date_ms, id, origin);
            let rel_path = render_template(params["destino"]["ruta"].as_str().unwrap_or_default(), &vars)?;
            if !valid_relative_template_output(&rel_path) {
                return Err(Fault::new("INVALID_OUTPUT_PATH", "La ruta de destino resultante no es válida."));
            }
            let req_dest_levels: &[&str] = if mode == "reemplazar" { &["leer", "escribir"] } else { &["escribir"] };
            let _ = access::resolve_folder(base, Some(dest_fid), req_dest_levels)?;
            let since = date_ms - days * DAY_MS;

            let mut changed_total = 0usize;
            let mut removed_total = 0usize;
            let mut md_lines = vec![
                "# Informe de cambios".to_owned(),
                String::new(),
                format!(
                    "Generado por Mind el {} (hora local). Periodo: últimos {days} día{}, desde {}.",
                    local_stamp(date_ms),
                    if days == 1 { "" } else { "s" },
                    local_stamp(since),
                ),
                "Solo metadatos del índice (nombres, rutas, fechas y tamaños); Mind no copia el contenido.".to_owned(),
                String::new(),
            ];
            for item in params["carpetas"].as_array().into_iter().flatten() {
                let Some(fid) = item.as_str() else { continue };
                let folder = access::resolve_folder(base, Some(fid), &["encontrar"])?;
                let index = motor_files::ensure_folder_index(base, &folder, &confirm_owner)?;
                let entries = index["entries"].as_array().cloned().unwrap_or_default();
                let existing: BTreeSet<&str> = entries.iter().filter_map(|e| e["path"].as_str()).collect();
                let mut changed: Vec<(&Value, i64)> = entries
                    .iter()
                    .filter_map(|e| {
                        if e["type"] != "file" {
                            return None;
                        }
                        let path = e["path"].as_str()?;
                        if fid == dest_fid && path == rel_path {
                            return None;
                        }
                        let t_mod = e["modifiedAt"].as_str().and_then(iso_to_millis);
                        let t_cre = e["createdAt"].as_str().and_then(iso_to_millis);
                        let best = match (t_mod, t_cre) {
                            (Some(a), Some(b)) => Some(a.max(b)),
                            (a, b) => a.or(b),
                        }?;
                        (best >= since).then_some((e, best))
                    })
                    .collect();
                changed.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0["path"].as_str().cmp(&b.0["path"].as_str())));
                let removed = motor_files::list_removed_for_folder(base, &folder, Some(since), date_ms, &existing);
                changed_total += changed.len();
                removed_total += removed.len();
                let folder_name = Path::new(&folder.root)
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or(&folder.root);
                md_lines.push(format!("## {}", md_escape(folder_name)));
                md_lines.push(String::new());
                md_lines.push(format!("Carpeta: {}", md_escape(&folder.root)));
                md_lines.push(String::new());
                md_lines.push(format!("### Nuevos o modificados ({})", changed.len()));
                md_lines.push(String::new());
                if changed.is_empty() {
                    md_lines.push("Sin cambios en el periodo.".to_owned());
                } else {
                    for (entry, t) in changed.iter().take(limit) {
                        let p = entry["path"].as_str().unwrap_or_default();
                        let size_str = entry["size"]
                            .as_u64()
                            .map(|s| format!(" · {}", human_size(s)))
                            .unwrap_or_default();
                        md_lines.push(format!("- {} — {}{}", md_escape(p), local_stamp(*t), size_str));
                    }
                    if changed.len() > limit {
                        md_lines.push(format!("- … y {} más", changed.len() - limit));
                    }
                }
                md_lines.push(String::new());
                md_lines.push(format!("### Eliminados ({})", removed.len()));
                md_lines.push(String::new());
                if removed.is_empty() {
                    md_lines.push("Nada eliminado en el periodo.".to_owned());
                } else {
                    for entry in removed.iter().take(limit) {
                        let p = entry["ruta"].as_str().unwrap_or_default();
                        let det = entry["eliminado"].as_str().and_then(iso_to_millis).map(local_stamp).unwrap_or_default();
                        let by = entry["por"].as_str().filter(|b| *b != "externo").map(|b| format!(" (por {})", md_escape(b))).unwrap_or_default();
                        md_lines.push(format!("- {} — detectado {}{}", md_escape(p), det, by));
                    }
                    if removed.len() > limit {
                        md_lines.push(format!("- … y {} más", removed.len() - limit));
                    }
                }
                md_lines.push(String::new());
            }
            let md = format!("{}\n", md_lines.join("\n"));
            let written = motor_files::write_output_text(base, dest_fid, &rel_path, &md, mode, confirm_owner)?;
            Ok(json!({
                "carpetas": params["carpetas"].as_array().map(Vec::len).unwrap_or(0),
                "modificados": changed_total,
                "eliminados": removed_total,
                "archivos": [written],
            }))
        }
        "exportar-continuidad" => {
            motor_files::recover_move(base, &confirm_owner)?;
            check_continuity(base, false)?;
            let mode = params["si_existe"].as_str().unwrap_or("error");
            let format_kind = params["formato"].as_str().unwrap_or("markdown");
            let wanted_kind = params["tipo"].as_str();
            let include_ref = params["relacionados"].as_bool() == Some(true);
            let dest_fid = params["destino"]["carpeta"].as_str().unwrap_or_default();
            let vars = template_vars(date_ms, id, origin);
            let rel_path = render_template(params["destino"]["ruta"].as_str().unwrap_or_default(), &vars)?;
            if !valid_relative_template_output(&rel_path) {
                return Err(Fault::new("INVALID_OUTPUT_PATH", "La ruta de destino resultante no es válida."));
            }
            let req_dest_levels: &[&str] = if mode == "reemplazar" { &["leer", "escribir"] } else { &["escribir"] };
            let _ = access::resolve_folder(base, Some(dest_fid), req_dest_levels)?;

            let mut selected_ids = Vec::new();
            let mut dir_entries = Vec::new();
            for item in fs::read_dir(base).map_err(|_| Fault::new("READ_FAILED", "No se pudo leer la continuidad."))? {
                let Ok(item) = item else { continue };
                let fname = item.file_name();
                if let Some(name) = fname.to_str() {
                    if let Some(cid) = name.strip_prefix("continuity-").and_then(|s| s.strip_suffix(".json")) {
                        if valid_uuid(cid) {
                            dir_entries.push(cid.to_owned());
                        }
                    }
                }
            }
            dir_entries.sort();
            let mut records_map: BTreeMap<String, Value> = BTreeMap::new();
            for cid in &dir_entries {
                if let Ok(Some(rec)) = read_json(base, &format!("continuity-{cid}.json")) {
                    if wanted_kind.is_none_or(|k| rec["kind"].as_str() == Some(k)) {
                        selected_ids.push(cid.clone());
                    }
                    records_map.insert(cid.clone(), rec);
                }
            }
            if selected_ids.is_empty() {
                return Ok(json!({ "registros": 0, "faltantes": 0, "archivos": [] }));
            }
            if selected_ids.len() > 1000 {
                return Err(Fault::new("CONTINUITY_TOO_LARGE", "Hay más de 1000 registros: filtra por tipo."));
            }
            let mut exported_entries = Vec::new();
            let mut seen_ids = HashSet::new();
            let mut missing_ids = BTreeSet::new();
            let mut queue: VecDeque<String> = selected_ids.into_iter().collect();
            while let Some(cid) = queue.pop_front() {
                if !seen_ids.insert(cid.clone()) {
                    continue;
                }
                let Some(rec) = records_map.get(&cid) else {
                    missing_ids.insert(cid);
                    continue;
                };
                exported_entries.push(rec.clone());
                for r in rec["references"].as_array().into_iter().flatten() {
                    if let Some(target) = r["entry"].as_str() {
                        if !seen_ids.contains(target) {
                            if include_ref {
                                queue.push_back(target.to_owned());
                            } else if !records_map.contains_key(target) {
                                missing_ids.insert(target.to_owned());
                            }
                        }
                    }
                }
            }
            if exported_entries.len() > 1000 {
                return Err(Fault::new("CONTINUITY_TOO_LARGE", "La exportación supera el número de registros admitido."));
            }
            let missing_vec: Vec<String> = missing_ids.into_iter().collect();
            let pack = json!({
                "format": "mind-continuity-export",
                "version": 1,
                "exportedAt": date_iso,
                "entries": exported_entries,
                "missing": missing_vec,
            });
            let content = if format_kind == "json" {
                format!("{}\n", serde_json::to_string_pretty(&pack).unwrap_or_default())
            } else {
                format_continuity_markdown(&pack)
            };
            let written = motor_files::write_output_text(base, dest_fid, &rel_path, &content, mode, confirm_owner)?;
            Ok(json!({
                "registros": pack["entries"].as_array().map(Vec::len).unwrap_or(0),
                "faltantes": pack["missing"].as_array().map(Vec::len).unwrap_or(0),
                "archivos": [written],
            }))
        }
        "respaldo" => {
            let _ = registered;
            motor_backup::create_configured_backup(base, motor_dir, confirm_owner)
        }
        "indice-csv" => {
            let idx_id = params["indice"].as_str().unwrap_or_default();
            let result = crate::motor_custom_index::regenerate(base, idx_id, &confirm_owner)?;
            let stored = read_json(base, &format!("custom-index-{idx_id}.json"))?
                .ok_or_else(|| Fault::new("CUSTOM_INDEX_NOT_FOUND", "Ese índice personalizado no existe."))?;
            Ok(json!({
                "estado": result["estado"], "filas": result["filas"],
                "archivos": [{"carpeta": stored["destination"]["folderId"], "ruta": stored["destination"]["relativePath"]}],
            }))
        }
        _ => Err(Fault::new("EXECUTOR_NOT_FOUND", "Ejecutor desconocido.")),
    }
}

fn md_escape(value: &str) -> String {
    value
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>()
        .chars()
        .flat_map(|c| {
            if matches!(c, '\\' | '`' | '*' | '_' | '[' | ']' | '<' | '>' | '#' | '|' | '~' | '!') {
                vec!['\\', c]
            } else {
                vec![c]
            }
        })
        .collect()
}

fn local_stamp(ms: i64) -> String {
    let p = local_parts(ms);
    format!("{:04}-{:02}-{:02} {:02}:{:02}", p.year, p.month, p.day, p.hour, p.minute)
}

fn human_size(bytes: u64) -> String {
    if bytes < 1024 {
        return format!("{bytes} B");
    }
    let units = ["KB", "MB", "GB", "TB"];
    let mut val = bytes as f64 / 1024.0;
    let mut unit = 0;
    while val >= 1024.0 && unit < units.len() - 1 {
        val /= 1024.0;
        unit += 1;
    }
    format!("{:.1} {}", val, units[unit]).replace('.', ",")
}

fn format_continuity_markdown(pack: &Value) -> String {
    let mut lines = vec![
        "# Continuidad exportada de Mind".to_owned(),
        String::new(),
        format!("Exportado: {}", pack["exportedAt"].as_str().unwrap_or_default()),
        String::new(),
    ];
    for entry in pack["entries"].as_array().into_iter().flatten() {
        let kind = entry["kind"].as_str().map(md_escape).unwrap_or_else(|| "Registro".to_owned());
        let id = entry["id"].as_str().unwrap_or_default();
        lines.push(format!("## {kind} · {id}"));
        lines.push(String::new());
        lines.push(format!("- Revisión: {}", entry["revision"]));
        lines.push(format!("- Creado: {}", entry["createdAt"].as_str().unwrap_or_default()));
        lines.push(format!("- Actualizado: {}", entry["updatedAt"].as_str().unwrap_or_default()));
        if let Some(src) = entry["source"].as_str() {
            lines.push(format!("- Origen declarado: {}", md_escape(src)));
        }
        lines.push(String::new());
        let body = if let Some(s) = entry["content"].as_str() {
            s.to_owned()
        } else {
            serde_json::to_string_pretty(&entry["content"]).unwrap_or_default()
        };
        lines.push(format!("```\n{body}\n```"));
        if let Some(refs) = entry["references"].as_array().filter(|a| !a.is_empty()) {
            lines.push(String::new());
            lines.push("Referencias:".to_owned());
            lines.push(String::new());
            for r in refs {
                let target = if let Some(tid) = r["entry"].as_str() {
                    format!("registro {tid}")
                } else {
                    md_escape(r["locator"].as_str().unwrap_or_default())
                };
                let rel = r["relation"]
                    .as_str()
                    .map(|x| format!("{}: ", md_escape(x)))
                    .unwrap_or_default();
                lines.push(format!("- {rel}{target}"));
            }
        }
        lines.push(String::new());
    }
    if let Some(missing) = pack["missing"].as_array().filter(|a| !a.is_empty()) {
        lines.push("## Referencias no disponibles".to_owned());
        lines.push(String::new());
        for m in missing {
            if let Some(id) = m.as_str() {
                lines.push(format!("- {id}"));
            }
        }
        lines.push(String::new());
    }
    lines.join("\n")
}

// ---------------------------------------------------------------------------
// Operaciones MCP y RPC del servicio de automatizaciones
// ---------------------------------------------------------------------------

pub(crate) struct AutomationPrepared {
    pub(crate) function_id: String,
    pub(crate) generation: String,
    pub(crate) fingerprint: String,
    pub(crate) lines: Vec<String>,
    pub(crate) reason: String,
    pub(crate) client_label: String,
}

impl AutomationPrepared {
    pub(crate) fn form(&self, protocol: &str) -> Value {
        let mut msg = vec![
            format!("{} solicita, mediante Mind, activar una automatización que se ejecutará sin que lo pidas cada vez:", self.client_label),
            String::new(),
        ];
        msg.extend(self.lines.iter().cloned());
        if !self.reason.is_empty() {
            msg.push(String::new());
            msg.push(format!("Motivo indicado por el agente (no verificado): «{}»", self.reason));
        }
        msg.push(String::new());
        msg.push("Usará los permisos que ya concediste en cada carpeta. Si la definición cambia, esta autorización caduca. Puedes desactivarla cuando quieras. Autoriza solo si reconoces esta solicitud.".to_owned());
        let mut params = json!({
            "message": msg.join("\n"),
            "requestedSchema": {
                "type": "object",
                "properties": {
                    "activar": { "type": "boolean", "title": "Activar esta automatización", "default": false }
                },
                "required": ["activar"]
            }
        });
        if protocol == "2025-11-25" {
            params["mode"] = json!("form");
        }
        params
    }
}

fn prepare_inner(base: &str, id: &str) -> Result<(String, String, Vec<String>, Vec<Value>), Fault> {
    let version = load_function_version(base, id)?
        .ok_or_else(|| Fault::new("FUNCTION_NOT_FOUND", "No existe una función con ese identificador."))?;
    let (executor, activation) = check_definition(&version.definition)?;
    let generation = version.generation.ok_or_else(|| {
        Fault::new(
            "FUNCTION_GENERATION_REQUIRED",
            "Actualiza la definición heredada antes de activarla.",
        )
    })?;
    if !activation.is_automatic() {
        return Err(act_err(
            "La definición no tiene activación automática (horario o evento); se ejecuta a mano con \"ejecutar\".",
        ));
    }
    let reqs = requirements_of(base, &executor, &version.definition, &activation)?;
    let missing = missing_permissions(base, &reqs)?;
    let lines = consent_lines(base, id, &version.definition, &executor, &activation, &reqs)?;
    Ok((generation, version.fingerprint, lines, missing))
}

pub(crate) fn prepare_activation(
    base: &str,
    args: &Map<String, Value>,
    client: Option<&Value>,
) -> Result<AutomationPrepared, Fault> {
    only_obj_keys(args, &["id", "motivo"], |m| Fault::new("INVALID_ARGUMENTS", m))?;
    let id = args
        .get("id")
        .and_then(Value::as_str)
        .filter(|s| valid_function_id(s))
        .ok_or_else(invalid_id)?;
    let reason = match args.get("motivo") {
        None => String::new(),
        Some(v) => v
            .as_str()
            .filter(|s| s.chars().count() <= 300)
            .map(|s| motor_consent::clean_text(s, 300))
            .ok_or_else(|| Fault::new("INVALID_ARGUMENTS", "motivo debe ser texto de hasta 300 caracteres."))?,
    };
    let (generation, fingerprint, lines, missing) = prepare_inner(base, id)?;
    if !missing.is_empty() {
        return Err(Fault::new(
            "ACCESS_NOT_GRANTED",
            format!(
                "Antes de activarla faltan permisos del usuario: {}. Pídelos con \"solicitar_acceso\".",
                describe_missing(&missing)
            ),
        ));
    }
    Ok(AutomationPrepared {
        function_id: id.to_owned(),
        generation,
        fingerprint,
        lines,
        reason,
        client_label: motor_consent::format_client_name(client),
    })
}

static EVENT_BASELINES: Mutex<Option<HashMap<(String, String), u64>>> = Mutex::new(None);

fn record_event_baseline(base: &str, id: &str) {
    if let Ok(mut guard) = EVENT_BASELINES.lock() {
        let map = guard.get_or_insert_with(HashMap::new);
        if map.len() >= 1024 {
            map.clear();
        }
        map.insert((base.to_owned(), id.to_owned()), motor_files::current_diff_seq());
    }
}

fn event_baseline(base: &str, id: &str) -> u64 {
    EVENT_BASELINES
        .lock()
        .ok()
        .and_then(|g| g.as_ref().and_then(|m| m.get(&(base.to_owned(), id.to_owned())).copied()))
        .unwrap_or(0)
}

fn clear_event_baseline(base: &str, id: &str) {
    if let Ok(mut guard) = EVENT_BASELINES.lock() {
        if let Some(map) = guard.as_mut() {
            map.remove(&(base.to_owned(), id.to_owned()));
        }
    }
}

fn authorize_inner(
    base: &str,
    id: &str,
    generation: &str,
    fingerprint: &str,
    channel: &str,
    client: Option<&str>,
    confirm_owner: impl Fn() -> Result<(), &'static str>,
) -> Result<Value, Fault> {
    let version = load_function_version(base, id)?
        .ok_or_else(|| Fault::new("FUNCTION_NOT_FOUND", "No existe una función con ese identificador."))?;
    let (executor, activation) = check_definition(&version.definition)?;
    if version.generation.as_deref() != Some(generation) || version.fingerprint != fingerprint {
        return Err(Fault::new(
            "AUTOMATION_CHANGED",
            "La definición cambió desde que se pidió la autorización; hay que solicitarla de nuevo.",
        ));
    }
    if !activation.is_automatic() {
        return Err(act_err("La definición no tiene activación automática."));
    }
    let reqs = requirements_of(base, &executor, &version.definition, &activation)?;
    let missing = missing_permissions(base, &reqs)?;
    if !missing.is_empty() {
        return Err(Fault::new(
            "ACCESS_NOT_GRANTED",
            format!("Faltan permisos para esta automatización: {}.", describe_missing(&missing)),
        ));
    }
    if let Activation::Event { ref folder, .. } = activation {
        let _ = motor_files::reconcile_index_by_id(base, folder, &confirm_owner);
        record_event_baseline(base, id);
    }
    let reg = registered_folders(base)?;
    let mut folder_gens = Map::new();
    for req in &reqs.folders {
        let Some(folder) = reg.iter().find(|f| f.id == req.id) else {
            return Err(Fault::new(
                "FOLDER_NOT_AUTHORIZED",
                "Una carpeta de la automatización ya no está autorizada.",
            ));
        };
        folder_gens.insert(req.id.clone(), json!(folder.generation));
    }
    let prev = load_consent(base, id).ok().flatten().map(|(_, b)| b);
    let record = json!({
        "format": "mind-automation",
        "version": 1,
        "functionId": id,
        "generation": generation,
        "fingerprint": fingerprint,
        "executor": executor,
        "folders": Value::Object(folder_gens),
        "grantedAt": now_iso()?,
        "channel": channel,
        "client": client,
        "enabled": true,
        "disabledAt": Value::Null,
    });
    write_base_json(base, &consent_file(id), &record, prev.as_deref(), &confirm_owner)?;
    let _ = motor_consent::remove_base_file(base, &state_file(id), &confirm_owner);
    let now = now_ms()?;
    let pending = pending_automation_requests(base);
    Ok(status_of(base, id, &version, &reg, &pending, now))
}

pub(crate) fn finish_activation(
    base: &str,
    prepared: AutomationPrepared,
    answer: Option<&Value>,
    client: Option<&Value>,
    confirm_owner: impl Fn() -> Result<(), &'static str>,
) -> Result<Value, Fault> {
    let cancelled = match answer {
        None => false,
        Some(ans) => {
            if !ans.is_object() {
                return Err(Fault::new(
                    "CONSENT_UNAVAILABLE",
                    "El cliente devolvió una respuesta de autorización no válida.",
                ));
            }
            match ans["action"].as_str() {
                Some("decline") => {
                    return Ok(json!({
                        "estado": "rechazado",
                        "nota": "El usuario no autorizó la activación automática.",
                    }));
                }
                Some("accept") => {
                    if ans["content"]["activar"] != true {
                        return Ok(json!({
                            "estado": "rechazado",
                            "nota": "El usuario no autorizó la activación automática.",
                        }));
                    }
                    let client_str = client
                        .and_then(|c| c["name"].as_str().or_else(|| c["title"].as_str()))
                        .map(|s| motor_consent::clean_text(s, 120));
                    let st = authorize_inner(
                        base,
                        &prepared.function_id,
                        &prepared.generation,
                        &prepared.fingerprint,
                        "formulario-del-cliente",
                        client_str.as_deref(),
                        confirm_owner,
                    )?;
                    let mut out = agent_summary(&st);
                    out["estado"] = json!("activada");
                    out["id"] = json!(prepared.function_id);
                    return Ok(out);
                }
                _ => true,
            }
        }
    };
    motor_consent::save_automation_pending(
        base,
        &prepared.function_id,
        &prepared.generation,
        &prepared.fingerprint,
        &prepared.client_label,
        &prepared.reason,
        cancelled,
        confirm_owner,
    )
}

pub(crate) fn console_prepare(base: &str, payload: &Value) -> Result<Value, Fault> {
    let id = payload
        .get("id")
        .and_then(Value::as_str)
        .filter(|s| valid_function_id(s))
        .ok_or_else(invalid_id)?;
    let (generation, fingerprint, lines, missing) = prepare_inner(base, id)?;
    Ok(json!({
        "ok": true,
        "preparacion": {
            "generation": generation,
            "fingerprint": fingerprint,
            "lines": lines,
            "missing": missing,
        },
    }))
}

pub(crate) fn console_authorize(
    base: &str,
    payload: &Value,
    confirm_owner: impl Fn() -> Result<(), &'static str>,
) -> Result<Value, Fault> {
    let id = payload
        .get("id")
        .and_then(Value::as_str)
        .filter(|s| valid_function_id(s))
        .ok_or_else(invalid_id)?;
    let generation = payload
        .get("generation")
        .and_then(Value::as_str)
        .filter(|s| valid_uuid(s))
        .ok_or_else(|| Fault::new("INVALID_ARGUMENTS", "Falta generation válida."))?;
    let fingerprint = payload
        .get("fingerprint")
        .and_then(Value::as_str)
        .filter(|s| s.len() == 64 && lower_hex(s))
        .ok_or_else(|| Fault::new("INVALID_ARGUMENTS", "Falta fingerprint válido."))?;
    let channel = payload
        .get("canal")
        .and_then(Value::as_str)
        .filter(|c| matches!(*c, "consola" | "administracion-local"))
        .unwrap_or("consola");
    let client = payload.get("cliente").and_then(Value::as_str);
    let st = authorize_inner(base, id, generation, fingerprint, channel, client, confirm_owner)?;
    Ok(json!({ "ok": true, "estado": st }))
}

fn execute_one(
    base: &str,
    motor_dir: Option<&Path>,
    id: &str,
    origin: &str,
    slot_ms: Option<i64>,
    automatic: bool,
    confirm_owner: impl Fn() -> Result<(), &'static str>,
) -> Result<Value, Fault> {
    let Some(_lock) = try_acquire_lock(base, id)? else {
        if !automatic {
            return Err(Fault::new(
                "FUNCTION_BUSY",
                "La función se está ejecutando ahora (en esta u otra sesión de Mind, o en el programador del sistema). Vuelve a intentarlo cuando termine.",
            ));
        }
        return Ok(json!({ "estado": "omitida", "motivo": "ocupada" }));
    };
    let registered = registered_folders(base)?;
    if automatic {
        let Ok(Some((consent, _))) = load_consent(base, id) else {
            return Ok(json!({ "estado": "omitida", "motivo": "sin-autorizacion" }));
        };
        let Ok(Some(version)) = load_function_version(base, id) else {
            return Ok(json!({ "estado": "omitida", "motivo": "funcion-retirada" }));
        };
        if let Err(reason) = consent_validity(&consent, Some(&version), &registered) {
            return Ok(json!({ "estado": "omitida", "motivo": reason }));
        }
        if let Ok(Some((st, _))) = load_state(base, id) {
            if let Some(slot) = slot_ms {
                if st["lastSlot"].as_str().and_then(iso_to_millis).is_some_and(|last| last >= slot) {
                    return Ok(json!({ "estado": "omitida", "motivo": "ya-ejecutada" }));
                }
            }
        }
    }
    let started_ms = now_ms()?;
    let date_ms = slot_ms.unwrap_or(started_ms);
    let date_iso = millis_to_iso(date_ms).unwrap_or_else(|| now_iso().unwrap_or_default());
    let started_iso = millis_to_iso(started_ms).unwrap_or_else(|| date_iso.clone());

    let mut executor_name: Option<String> = None;
    let outcome = (|| -> Result<Value, Fault> {
        let version = load_function_version(base, id)?
            .ok_or_else(|| Fault::new("FUNCTION_NOT_FOUND", "No existe una función con ese identificador."))?;
        let (exec, _act) = check_definition(&version.definition)?;
        executor_name = Some(exec.clone());
        run_executor(base, motor_dir, id, &exec, &version.definition, origin, date_ms, &date_iso, &confirm_owner)
    })();

    let finished_ms = now_ms().unwrap_or(started_ms);
    let duration = (finished_ms - started_ms).max(0);
    let (status_str, code, summary_or_msg) = match outcome {
        Ok(res) => {
            let truncated = serde_json::to_vec(&res).is_ok_and(|b| b.len() <= MAX_SUMMARY_BYTES);
            let resumen = if truncated { res } else { json!({ "truncado": true }) };
            ("completada", Value::Null, Ok(resumen))
        }
        Err(err) => ("fallida", json!(err.code), Err(err.message)),
    };

    let mut hist_entry = json!({
        "fecha": started_iso,
        "origen": origin,
        "ejecutor": executor_name,
        "estado": status_str,
        "codigo": code,
        "duracion_ms": duration,
    });
    if let Some(slot) = slot_ms.and_then(millis_to_iso) {
        hist_entry["programada"] = json!(slot);
    }
    if let Ok(ref resumen) = summary_or_msg {
        hist_entry["resumen"] = resumen.clone();
    }
    let _ = append_history(base, id, hist_entry, &confirm_owner);

    if automatic {
        let prev_st = load_state(base, id).ok().flatten();
        let last_slot_out = slot_ms
            .and_then(millis_to_iso)
            .or_else(|| prev_st.as_ref().and_then(|(v, _)| v["lastSlot"].as_str().map(str::to_owned)));
        let next_st = json!({
            "format": "mind-automation-state",
            "version": 1,
            "functionId": id,
            "lastSlot": last_slot_out,
            "lastRunAt": millis_to_iso(finished_ms).unwrap_or(date_iso),
            "lastStatus": status_str,
            "lastCode": code,
        });
        let _ = write_base_json(
            base,
            &state_file(id),
            &next_st,
            prev_st.as_ref().map(|(_, b)| b.as_slice()),
            &confirm_owner,
        );
    }

    let mut out = json!({
        "funcion": id,
        "ejecutor": executor_name,
        "estado": status_str,
        "duracion_ms": duration,
    });
    match summary_or_msg {
        Ok(res) => out["resultado"] = res,
        Err(msg) => {
            out["codigo"] = code;
            out["mensaje"] = json!(msg);
        }
    }
    Ok(out)
}

pub(crate) fn console_run_due(
    base: &str,
    motor_dir: Option<&Path>,
    confirm_owner: impl Fn() -> Result<(), &'static str>,
) -> Result<Value, Fault> {
    let now = now_ms()?;
    let registered = registered_folders(base)?;
    let mut due_list = Vec::new();
    for id in list_function_ids(base)? {
        let Ok(Some((consent, _))) = load_consent(base, &id) else { continue };
        let Ok(Some(version)) = load_function_version(base, &id) else { continue };
        if consent_validity(&consent, Some(&version), &registered).is_err() {
            continue;
        }
        let Ok((_, act)) = check_definition(&version.definition) else { continue };
        if !matches!(act, Activation::Daily { .. } | Activation::Weekly { .. } | Activation::Interval { .. }) {
            continue;
        }
        let granted_ms = consent["grantedAt"].as_str().and_then(iso_to_millis).unwrap_or(now);
        let last_slot_ms = load_state(base, &id)
            .ok()
            .flatten()
            .and_then(|(s, _)| s["lastSlot"].as_str().and_then(iso_to_millis));
        if let Some(slot) = due_slot(&act, granted_ms, last_slot_ms, now) {
            due_list.push((id, slot));
        }
    }
    let mut resultados = Vec::new();
    for (id, slot) in due_list {
        let mut outcome = match execute_one(base, motor_dir, &id, "programada", Some(slot), true, &confirm_owner) {
            Ok(v) => v,
            Err(e) => json!({ "estado": "fallida", "codigo": e.code }),
        };
        outcome["funcion"] = json!(id);
        if let Some(iso) = millis_to_iso(slot) {
            outcome["programada"] = json!(iso);
        }
        resultados.push(outcome);
    }
    Ok(json!({ "ok": true, "resultados": resultados }))
}

struct EventBurst {
    first_at_ms: i64,
    fire_at_ms: i64,
}

// Un intervalo de diffs cubre solo las escrituras de esa ejecución.
struct OwnWrites {
    after: u64,
    through: u64,
    paths: HashSet<(String, String)>,
}

pub(crate) struct AutomationRuntime {
    custom_indexes: crate::motor_custom_index::Automatic,
    started_ms: i64,
    bursts: HashMap<String, EventBurst>,
    own_writes: HashMap<String, OwnWrites>,
}

fn match_event_path(subfolder: Option<&str>, extensions: Option<&[String]>, relative: &str) -> bool {
    if let Some(sub) = subfolder {
        let fold = |s: &str| {
            if cfg!(any(windows, target_os = "macos")) {
                s.to_lowercase()
            } else {
                s.to_owned()
            }
        };
        let r = fold(relative);
        let p = fold(sub);
        if r != p && !r.strip_prefix(&p).is_some_and(|rest| rest.starts_with('/')) {
            return false;
        }
    }
    if let Some(exts) = extensions {
        let lower = relative.to_lowercase();
        if !exts.iter().any(|ext| lower.ends_with(ext) && lower.len() > ext.len()) {
            return false;
        }
    }
    true
}

impl AutomationRuntime {
    pub(crate) fn new() -> Self {
        Self {
            custom_indexes: crate::motor_custom_index::Automatic::default(),
            started_ms: now_ms().unwrap_or(0),
            bursts: HashMap::new(),
            own_writes: HashMap::new(),
        }
    }

    pub(crate) fn clear_bursts(&mut self, base: &str) {
        self.custom_indexes.clear();
        self.bursts.clear();
        self.own_writes.clear();
        let _ = motor_files::drain_index_diffs(base);
    }

    pub(crate) fn poll(
        &mut self,
        base: &str,
        motor_dir: Option<&Path>,
        confirm_owner: impl Fn() -> Result<(), &'static str>,
    ) -> Result<(), Fault> {
        let now = now_ms()?;
        let registered = registered_folders(base)?;
        let mut scheduled_due = Vec::new();
        let mut active_events = Vec::new();
        let mut watched_folders = BTreeSet::new();

        for id in list_function_ids(base)? {
            let Ok(Some((consent, _))) = load_consent(base, &id) else {
                clear_event_baseline(base, &id);
                continue;
            };
            let Ok(Some(version)) = load_function_version(base, &id) else {
                clear_event_baseline(base, &id);
                continue;
            };
            if consent_validity(&consent, Some(&version), &registered).is_err() {
                continue;
            }
            let Ok((_, act)) = check_definition(&version.definition) else { continue };
            match act {
                Activation::Daily { .. } | Activation::Weekly { .. } | Activation::Interval { .. } => {
                    let granted_ms = consent["grantedAt"].as_str().and_then(iso_to_millis).unwrap_or(now);
                    let last_slot_ms = load_state(base, &id)
                        .ok()
                        .flatten()
                        .and_then(|(s, _)| s["lastSlot"].as_str().and_then(iso_to_millis));
                    if let Some(slot) = due_slot(&act, granted_ms, last_slot_ms, now) {
                        scheduled_due.push((id, slot));
                    }
                }
                Activation::Event {
                    folder,
                    subfolder,
                    extensions,
                    wait_seconds,
                } => {
                    watched_folders.insert(folder.clone());
                    active_events.push((id, folder, subfolder, extensions, wait_seconds));
                }
                Activation::Manual => {}
            }
        }

        let active_event_ids: HashSet<&str> = active_events.iter().map(|(id, ..)| id.as_str()).collect();
        self.bursts.retain(|id, _| active_event_ids.contains(id.as_str()));

        for (id, slot) in scheduled_due {
            let origin = if slot < self.started_ms { "recuperacion" } else { "horario" };
            let _ = execute_one(base, motor_dir, &id, origin, Some(slot), true, &confirm_owner);
        }

        let indexes = crate::motor_custom_index::watches(base)?;
        watched_folders.extend(indexes.iter().map(|index| index.folder_id().to_owned()));
        if watched_folders.is_empty() {
            self.custom_indexes.clear();
            let _ = motor_files::drain_index_diffs(base);
            return Ok(());
        }

        for fid in &watched_folders {
            let Some(folder) = registered.iter().find(|f| f.id == *fid) else { continue };
            if access::registered_access(base, folder)
                .map(|perms| perms.contains(&"encontrar"))
                .unwrap_or(false)
            {
                let _ = motor_files::reconcile_folder_index(base, folder, &confirm_owner);
            }
        }

        let diffs = motor_files::drain_index_diffs(base);
        self.custom_indexes.poll(base, &indexes, &diffs, &confirm_owner);
        let own_writes = std::mem::take(&mut self.own_writes);
        for (id, folder, subfolder, extensions, wait_seconds) in active_events {
            let min_seq = event_baseline(base, &id);
            let own = own_writes.get(&id);
            let matched = diffs.iter().any(|diff| {
                diff.folder_id == folder
                    && diff.seq > min_seq
                    && diff
                        .added
                        .iter()
                        .chain(diff.modified.iter())
                        .chain(diff.removed.iter())
                        .any(|rel| {
                            match_event_path(subfolder.as_deref(), extensions.as_deref(), rel)
                                && !own.is_some_and(|writes| {
                                    diff.seq > writes.after && diff.seq <= writes.through
                                        && writes.paths.contains(&(folder.clone(), rel.clone()))
                                })
                        })
            });
            if matched {
                let wait_ms = wait_seconds.saturating_mul(1000);
                let max_span = (wait_ms.saturating_mul(10)).min(30 * 60_000);
                let first_at = self.bursts.get(&id).map_or(now, |b| b.first_at_ms);
                let limit = first_at.saturating_add(max_span);
                let fire_at = now.saturating_add(wait_ms).min(limit);
                self.bursts.insert(
                    id.clone(),
                    EventBurst {
                        first_at_ms: first_at,
                        fire_at_ms: fire_at,
                    },
                );
            }
        }

        let now_fire = now_ms().unwrap_or(now);
        let ready: Vec<String> = self
            .bursts
            .iter()
            .filter(|(_, burst)| now_fire >= burst.fire_at_ms)
            .map(|(id, _)| id.clone())
            .collect();
        for id in ready {
            self.bursts.remove(&id);
            let after = motor_files::current_diff_seq();
            if let Ok(outcome) = execute_one(base, motor_dir, &id, "evento", None, true, &confirm_owner) {
                if outcome["estado"] == "completada" {
                    let mut written = HashSet::new();
                    for item in outcome["resultado"]["archivos"].as_array().into_iter().flatten() {
                        if let (Some(c), Some(r)) = (item["carpeta"].as_str(), item["ruta"].as_str()) {
                            written.insert((c.to_owned(), r.to_owned()));
                        }
                    }
                    let through = motor_files::current_diff_seq();
                    if through > after && !written.is_empty() {
                        self.own_writes.insert(id, OwnWrites { after, through, paths: written });
                    }
                }
            }
        }
        Ok(())
    }
}

pub(crate) fn call_tool(
    base: &str,
    motor_dir: Option<&Path>,
    name: &str,
    args: &Map<String, Value>,
    confirm_owner: impl Fn() -> Result<(), &'static str>,
) -> Result<Value, Fault> {
    match name {
        "funciones" => {
            only_obj_keys(args, &[], |m| Fault::new("INVALID_ARGUMENTS", m))?;
            let registered = registered_folders(base)?;
            let pending = pending_automation_requests(base);
            let now = now_ms()?;
            let mut items = Vec::new();
            for id in list_function_ids(base)? {
                if let Some(version) = load_function_version(base, &id)? {
                    items.push(status_of(base, &id, &version, &registered, &pending, now));
                }
            }
            let installation = read_json(base, "system-scheduler.json").ok().flatten();
            let scheduler_desc = if installation.as_ref().is_some_and(|i| i["state"] == "instalado") {
                let kind = installation
                    .as_ref()
                    .and_then(|i| i["record"]["kind"].as_str())
                    .unwrap_or("sistema");
                format!("instalado ({kind}): las funciones autorizadas se ejecutan también con Mind cerrado")
            } else {
                "no instalado: fuera de las sesiones no se ejecuta nada. El usuario lo instala con \"mind programador instalar\".".to_owned()
            };
            Ok(json!({
                "ejecutores": executor_catalog(),
                "funciones": items,
                "en_sesion": "activo",
                "programador_del_sistema": scheduler_desc,
            }))
        }
        "crear_funcion" => {
            only_obj_keys(args, &["id", "definicion"], |m| Fault::new("INVALID_ARGUMENTS", m))?;
            let id = args.get("id").and_then(Value::as_str).filter(|s| valid_function_id(s)).ok_or_else(invalid_id)?;
            let def = args.get("definicion").filter(|v| v.is_object()).ok_or_else(|| Fault::new("INVALID_ARGUMENTS", "definicion debe ser un objeto JSON."))?;
            check_definition(def)?;
            if load_function_version(base, id)?.is_some() {
                return Err(Fault::new("FUNCTION_EXISTS", "Ya existe una definición con ese identificador."));
            }
            let record = json!({
                "format": "mind-function-definition",
                "version": 2,
                "id": id,
                "definition": def,
                "generation": Uuid::new_v4().to_string(),
            });
            write_base_json(base, &def_file(id), &record, None, &confirm_owner)?;
            let registered = registered_folders(base)?;
            let pending = pending_automation_requests(base);
            let version = load_function_version(base, id)?.ok_or_else(|| Fault::new("READ_FAILED", "No se pudo leer la función creada."))?;
            let st = status_of(base, id, &version, &registered, &pending, now_ms()?);
            let mut out = agent_summary(&st);
            out["estado"] = json!("creada");
            out["id"] = json!(id);
            Ok(out)
        }
        "modificar_funcion" => {
            only_obj_keys(args, &["id", "definicion"], |m| Fault::new("INVALID_ARGUMENTS", m))?;
            let id = args.get("id").and_then(Value::as_str).filter(|s| valid_function_id(s)).ok_or_else(invalid_id)?;
            let def = args.get("definicion").filter(|v| v.is_object()).ok_or_else(|| Fault::new("INVALID_ARGUMENTS", "definicion debe ser un objeto JSON."))?;
            check_definition(def)?;
            let prev_bytes = read_file(base, &def_file(id), MAX_JSON_BYTES)?
                .ok_or_else(|| Fault::new("FUNCTION_NOT_FOUND", "No existe una definición con ese identificador."))?;
            let _ = load_function_version(base, id)?;
            let had_consent = load_consent(base, id).ok().flatten().is_some_and(|(v, _)| v["enabled"] == true);
            let record = json!({
                "format": "mind-function-definition",
                "version": 2,
                "id": id,
                "definition": def,
                "generation": Uuid::new_v4().to_string(),
            });
            write_base_json(base, &def_file(id), &record, Some(&prev_bytes), &confirm_owner)?;
            let mut out = json!({
                "estado": "modificada",
                "id": id,
                "autorizacion_caducada": had_consent,
            });
            if had_consent {
                out["nota"] = json!("La autorización automática anterior ya no vale: pide de nuevo \"activar_funcion\".");
            }
            Ok(out)
        }
        "retirar_funcion" => {
            only_obj_keys(args, &["id"], |m| Fault::new("INVALID_ARGUMENTS", m))?;
            let id = args.get("id").and_then(Value::as_str).filter(|s| valid_function_id(s)).ok_or_else(invalid_id)?;
            let Some(_lock) = try_acquire_lock(base, id)? else {
                return Err(Fault::new(
                    "FUNCTION_BUSY",
                    "La función se está ejecutando ahora. Vuelve a intentarlo cuando termine.",
                ));
            };
            if load_function_version(base, id)?.is_some() {
                let _ = motor_consent::remove_base_file(base, &def_file(id), &confirm_owner)?;
            }
            let _ = motor_consent::remove_base_file(base, &consent_file(id), &confirm_owner);
            let _ = motor_consent::remove_base_file(base, &state_file(id), &confirm_owner);
            let _ = motor_consent::remove_base_file(base, &history_file(id), &confirm_owner);
            let _ = motor_consent::remove_pending_automation_requests(base, id, &confirm_owner);
            Ok(json!({ "estado": "retirada", "id": id }))
        }
        "ejecutar_funcion" => {
            only_obj_keys(args, &["id"], |m| Fault::new("INVALID_ARGUMENTS", m))?;
            let id = args.get("id").and_then(Value::as_str).filter(|s| valid_function_id(s)).ok_or_else(invalid_id)?;
            let mut out = execute_one(base, motor_dir, id, "manual", None, false, confirm_owner)?;
            out["id"] = json!(id);
            Ok(out)
        }
        "desactivar_funcion" => {
            only_obj_keys(args, &["id"], |m| Fault::new("INVALID_ARGUMENTS", m))?;
            let id = args.get("id").and_then(Value::as_str).filter(|s| valid_function_id(s)).ok_or_else(invalid_id)?;
            if let Some((mut consent, prev)) = load_consent(base, id)? {
                if consent["enabled"] == true {
                    consent["enabled"] = json!(false);
                    consent["disabledAt"] = json!(now_iso()?);
                    write_base_json(base, &consent_file(id), &consent, Some(&prev), confirm_owner)?;
                }
            }
            Ok(json!({ "estado": "desactivada", "id": id }))
        }
        "historial_funcion" => {
            only_obj_keys(args, &["id"], |m| Fault::new("INVALID_ARGUMENTS", m))?;
            let mut entries = Vec::new();
            let id_arg = match args.get("id") {
                None => None,
                Some(v) => Some(v.as_str().filter(|s| valid_function_id(s)).ok_or_else(invalid_id)?),
            };
            if let Some(id) = id_arg {
                let (hist, _) = load_history(base, id)?;
                for mut item in hist.into_iter().rev().take(20) {
                    if let Some(obj) = item.as_object_mut() {
                        obj.insert("funcion".into(), json!(id));
                    }
                    entries.push(item);
                }
                return Ok(json!({ "id": id, "ejecuciones": entries }));
            }
            for fid in list_history_ids(base)? {
                if let Ok((hist, _)) = load_history(base, &fid) {
                    for mut item in hist {
                        if let Some(obj) = item.as_object_mut() {
                            obj.insert("funcion".into(), json!(fid));
                        }
                        entries.push(item);
                    }
                }
            }
            entries.sort_by(|a, b| b["fecha"].as_str().cmp(&a["fecha"].as_str()));
            entries.truncate(20);
            Ok(json!({ "id": Value::Null, "ejecuciones": entries }))
        }
        "activar_funcion" => {
            let prep = prepare_activation(base, args, None)?;
            finish_activation(base, prep, None, None, confirm_owner)
        }
        _ => Err(Fault::new("UNKNOWN_TOOL", "Operación de función no disponible.")),
    }
}
