use std::{fs, io, path::Path};

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{motor_native::Fault, motor_owner::timestamp,
    motor_permissions::{
        continuity_access, folder_status, lower_hex, persisted_continuity_policy,
        persisted_folder_policy, read_file, read_json, registered_folders, Folder,
    },
    scan, text_write};

const FOLDER: &[&str] = &["encontrar", "leer", "escribir", "organizar"];
const CONTINUITY: &[&str] = &["leer", "registrar"];
const PRESETS: &[(&str, &[&str], &str)] = &[
    ("encontrar", &["encontrar"], "Solo encontrar (nombres, rutas y fechas; sin abrir archivos)"),
    ("leer", &["encontrar", "leer"], "Encontrar y leer (sin cambiar nada)"),
    ("completo", FOLDER, "Acceso completo (leer, crear, modificar y organizar; borrar pide tu confirmación cada vez)"),
];
const LIMIT: usize = 2 * 1024 * 1024;
const POLICY: &str = "agent-continuity-access.json";

pub(crate) enum Prepared {
    Authorized(Value),
    Request(AccessRequest),
}

pub(crate) struct AccessRequest {
    target: Target,
    requested: Vec<&'static str>,
    current: Vec<&'static str>,
    client: String,
    reason: String,
}

enum Target {
    Continuity { policy: Option<Stored> },
    Folder { id: String, path: String, registry: Option<Stored>, policy: Option<Stored> },
}

struct Stored {
    value: Value,
    hash: String,
}

pub(crate) struct Paths<'a> {
    pub(crate) base: &'a str,
    pub(crate) motor: Option<&'a Path>,
    pub(crate) installation: Option<&'a Path>,
    pub(crate) user_data: Option<&'a Path>,
}

fn fail(code: &'static str, message: &str) -> Fault { Fault::new(code, message) }

fn changed() -> Fault { fail("ACCESS_CHANGED", "La autorización cambió mientras se esperaba la respuesta.") }

fn read(base: &str, name: &str) -> Result<Option<Stored>, Fault> {
    read_file(base, name, LIMIT)?.map(|bytes| {
        let value = serde_json::from_slice(&bytes)
            .map_err(|_| fail("RECORD_CORRUPT", "El registro de autorización no contiene JSON válido."))?;
        Ok(Stored { value, hash: format!("{:x}", Sha256::digest(&bytes)) })
    }).transpose()
}

fn unchanged(base: &str, name: &str, expected: Option<&Stored>) -> Result<bool, Fault> {
    Ok(read(base, name)?.as_ref().map(|current| &current.hash) == expected.map(|record| &record.hash))
}

fn save(
    base: &str, name: &str, value: &Value, previous: Option<&Stored>,
    confirm: impl FnOnce() -> Result<(), &'static str>,
) -> Result<(), Fault> {
    let text = value.to_string() + "\n";
    match text_write::write_bytes(base, name, text.as_bytes(), LIMIT, previous.map(|record| record.hash.as_str()), confirm) {
        Ok(_) => Ok(()),
        Err("FILE_EXISTS" | "VERSION_CONFLICT") => Err(changed()),
        Err(code) => Err(fail(code, "No se pudo guardar la decisión de acceso.")),
    }
}

pub(crate) fn clean_text(value: &str, max: usize) -> String {
    clean(value, max)
}

pub(crate) fn format_client_name(client: Option<&Value>) -> String {
    client_name(client)
}

fn clean(value: &str, max: usize) -> String {
    let flat: String = value.chars().map(|ch| {
        if ch.is_control() || matches!(ch, '\u{2028}'..='\u{202e}' | '\u{2066}'..='\u{2069}') { ' ' } else { ch }
    }).collect();
    let flat = flat.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= max { flat }
    else { flat.chars().take(max - 1).chain(std::iter::once('…')).collect() }
}

fn client_name(client: Option<&Value>) -> String {
    let client = client.unwrap_or(&Value::Null);
    let name = clean(client["title"].as_str().or_else(|| client["name"].as_str()).unwrap_or(""), 80);
    if name.is_empty() { return "un agente sin identificar".into(); }
    let version = clean(client["version"].as_str().unwrap_or(""), 32);
    if version.is_empty() { name } else { format!("{name} {version}") }
}

fn levels(value: &Value, allowed: &[&'static str]) -> Result<Vec<&'static str>, Fault> {
    let names = if let Some(list) = value.as_array() {
        list.iter().map(Value::as_str).collect::<Option<Vec<_>>>()
    } else {
        value.as_object().map(|items| items.iter()
            .filter_map(|(name, value)| (value == true).then_some(name.as_str())).collect())
    }.filter(|names| names.iter().all(|name| allowed.contains(name)))
        .ok_or_else(|| fail("INVALID_ACCESS", "Indica únicamente los permisos admitidos."))?;
    Ok(allowed.iter().copied().filter(|level| names.contains(level)).collect())
}

fn preset(name: &str) -> Option<&'static [&'static str]> {
    PRESETS.iter().find_map(|(item, levels, _)| (*item == name).then_some(*levels))
}

fn physical(path: &Path) -> Result<String, Fault> {
    let path = fs::canonicalize(path).map_err(|_| fail("FOLDER_UNAVAILABLE", "La carpeta no existe o no es accesible."))?;
    let name = path.to_str().ok_or_else(|| fail("INVALID_FOLDER_PATH", "La ruta debe ser texto válido."))?;
    #[cfg(windows)]
    {
        if let Some(unc) = name.strip_prefix(r"\\?\UNC\") {
            return Ok(format!(r"\\{unc}"));
        }
        return Ok(name.strip_prefix(r"\\?\").unwrap_or(name).to_owned());
    }
    #[cfg(not(windows))]
    Ok(name.to_owned())
}

fn contains(parent: &Path, child: &Path) -> bool {
    let mut parts = child.components();
    parent.components().all(|expected| parts.next().is_some_and(|actual| {
        if cfg!(windows) {
            expected.as_os_str().to_string_lossy().to_lowercase() == actual.as_os_str().to_string_lossy().to_lowercase()
        } else { expected == actual }
    }))
}

fn candidate(paths: &Paths<'_>, name: &str) -> Result<String, Fault> {
    if name.contains('\0') || !Path::new(name).is_absolute() {
        return Err(fail("INVALID_FOLDER_PATH", "Indica la ruta absoluta de una carpeta existente."));
    }
    let canonical = physical(Path::new(name))?;
    let path = Path::new(&canonical);
    if !path.is_dir() { return Err(fail("NOT_A_FOLDER", "La ubicación debe ser una carpeta.")); }
    let home = std::env::home_dir()
        .filter(|path| path.is_absolute())
        .ok_or_else(|| fail("CONSENT_UNAVAILABLE", "No se pudo verificar la carpeta personal."))?;
    let home = physical(&home).unwrap_or_else(|_| home.to_string_lossy().into_owned());
    if path.parent().is_none() || contains(path, Path::new(&home)) {
        return Err(fail("FOLDER_TOO_BROAD", "Elige una carpeta concreta y distinta de la carpeta personal completa."));
    }
    let executable = std::env::current_exe().ok().and_then(|exe| exe.parent().map(Path::to_owned));
    let overlaps = |location: &str| contains(Path::new(location), path) || contains(path, Path::new(location));
    for internal in [Some(Path::new(paths.base)), paths.motor, executable.as_deref()].into_iter().flatten() {
        if overlaps(&physical(internal).unwrap_or_else(|_| internal.to_string_lossy().into_owned())) {
            return Err(fail("FOLDER_OVERLAPS_INTERNAL", "Motor y Base permanecen protegidos."));
        }
    }
    if let Some(installation) = paths.installation {
        let installation = physical(installation).unwrap_or_else(|_| installation.to_string_lossy().into_owned());
        let allowed = paths.user_data.and_then(|data| physical(data).ok()).is_some_and(|data| {
            contains(Path::new(&installation), Path::new(&data)) && contains(Path::new(&data), path)
        });
        if overlaps(&installation) && !allowed {
            return Err(fail("FOLDER_OVERLAPS_INTERNAL", "La carpeta de instalación permanece protegida."));
        }
    }
    scan::open_directory(&canonical, "").map_err(|code| fail(code, "No se pudo abrir la carpeta de forma segura."))?;
    Ok(canonical)
}

fn folder_id(path: &str) -> String {
    let folded = if cfg!(windows) { path.to_lowercase() } else { path.to_owned() };
    format!("{:x}", Sha256::digest(folded.as_bytes()))
}

fn registry_file(id: &str) -> String { format!("folder-authorization-{id}.json") }
fn policy_file(id: &str) -> String { format!("folder-access-{id}.json") }

pub(crate) fn prepare(
    paths: Paths<'_>, args: &Map<String, Value>, client: Option<&Value>,
) -> Result<Prepared, Fault> {
    let base = paths.base;
    if args.keys().any(|key| !matches!(key.as_str(), "ruta" | "acceso" | "permisos" | "continuidad" | "motivo")) {
        return Err(fail("INVALID_ARGUMENTS", "La solicitud incluye argumentos no admitidos."));
    }
    let reason = match args.get("motivo") {
        None => String::new(),
        Some(value) => clean(value.as_str().filter(|value| value.encode_utf16().count() <= 1000)
            .ok_or_else(|| fail("INVALID_ARGUMENTS", "El motivo debe ser texto de hasta 1000 caracteres."))?, 300),
    };
    let client = client_name(client);
    if let Some(requested) = args.get("continuidad") {
        if ["ruta", "acceso", "permisos"].iter().any(|name| args.contains_key(*name)) {
            return Err(fail("INVALID_ARGUMENTS", "Usa continuidad o ruta con acceso, no ambos."));
        }
        let mut requested = levels(requested, CONTINUITY)?;
        let policy = read(base, POLICY)?;
        let current = continuity_access(base)?;
        if !unchanged(base, POLICY, policy.as_ref())? { return Err(changed()); }
        requested.retain(|level| !current.contains(level));
        if requested.is_empty() {
            return Ok(Prepared::Authorized(json!({"estado":"ya-autorizado","continuidad":current})));
        }
        return Ok(Prepared::Request(AccessRequest { target: Target::Continuity { policy }, requested, current, client, reason }));
    }
    let path = args.get("ruta").and_then(Value::as_str)
        .ok_or_else(|| fail("INVALID_FOLDER_PATH", "Indica una ruta absoluta de carpeta."))?;
    let mut requested = match (args.get("acceso"), args.get("permisos")) {
        (Some(_), Some(_)) => return Err(fail("INVALID_ARGUMENTS", "Usa acceso o permisos, no ambos.")),
        (Some(access), None) => access.as_str().and_then(preset).map(|levels| levels.to_vec())
            .ok_or_else(|| fail("INVALID_ACCESS", "acceso debe ser encontrar, leer o completo."))?,
        (None, Some(value)) => levels(value, FOLDER)?,
        (None, None) => vec![],
    };
    if !requested.contains(&"encontrar") { requested.insert(0, "encontrar"); }
    let path = candidate(&paths, path)?;
    crate::motor_permissions::check_workspace_request(base, Path::new(&path))?;
    let id = folder_id(&path);
    let registry_name = registry_file(&id);
    let policy_name = policy_file(&id);
    let registry = read(base, &registry_name)?;
    let policy = read(base, &policy_name)?;
    let folders = folder_status(base)?;
    let current = folders.iter().find(|folder| folder["id"] == id)
        .and_then(|folder| folder["permisos"].as_array())
        .map(|permissions| FOLDER.iter().copied().filter(|level| permissions.iter().any(|value| value == *level)).collect::<Vec<_>>())
        .unwrap_or_default();
    if !unchanged(base, &registry_name, registry.as_ref())? || !unchanged(base, &policy_name, policy.as_ref())? {
        return Err(changed());
    }
    if requested.iter().all(|level| current.contains(level)) {
        return Ok(Prepared::Authorized(json!({
            "estado":"ya-autorizado","carpeta":{"id":id,"ruta":path,"permisos":current}
        })));
    }
    Ok(Prepared::Request(AccessRequest { target: Target::Folder { id, path, registry, policy }, requested, current, client, reason }))
}

impl AccessRequest {
    pub(crate) fn form(&self, protocol: &str) -> Value {
        let reason = if self.reason.is_empty() { String::new() } else {
            format!("\nMotivo indicado por el agente (no verificado): «{}»", self.reason)
        };
        let (message, properties, required) = match &self.target {
            Target::Folder { path, .. } => {
                let index = if self.requested.contains(&"escribir") || self.requested.contains(&"organizar") { 2 }
                    else if self.requested.contains(&"leer") { 1 } else { 0 };
                let (suggested, _, label) = PRESETS[index];
                let choice = if protocol == "2025-11-25" {
                    let options = PRESETS.iter().map(|(key, _, label)| json!({"const":key,"title":label})).collect::<Vec<_>>();
                    json!({"type":"string","title":"Acceso","oneOf":options,"default":suggested})
                } else {
                    let keys = PRESETS.iter().map(|(key, _, _)| *key).collect::<Vec<_>>();
                    let labels = PRESETS.iter().map(|(_, _, label)| *label).collect::<Vec<_>>();
                    json!({"type":"string","title":"Acceso","enum":keys,"enumNames":labels,"default":suggested})
                };
                (format!("{} solicita, mediante Mind, acceso a esta carpeta y a todo lo que contiene:\n{}\n\nAcceso solicitado: {}.{}\n\nAutoriza solo si reconoces esta solicitud.", self.client, path, label, reason),
                    json!({"acceso":choice,"excluir":{"type":"string","title":"Excluir subcarpetas (opcional)",
                        "description":"Rutas dentro de la carpeta, separadas por comas","default":""}}),
                    vec!["acceso"])
            }
            Target::Continuity { .. } => {
                let properties = self.requested.iter().map(|level| {
                    let title = if *level == "leer" { "Consultar decisiones, resultados y contexto registrados por otros agentes o sesiones" }
                        else { "Registrar decisiones, resultados y contexto para continuar después" };
                    (level.to_string(), json!({"type":"boolean","title":title,"default":true}))
                }).collect::<Map<_,_>>();
                (format!("{} solicita acceso a los registros de continuidad de Mind.{}", self.client, reason), Value::Object(properties), vec![])
            }
        };
        let mut params = json!({"message":message,"requestedSchema":{"type":"object","properties":properties,"required":required}});
        if protocol == "2025-11-25" { params["mode"] = json!("form"); }
        params
    }
}

fn tomorrow(now: &str) -> Option<String> {
    let (date, time) = now.split_once('T')?;
    let mut date = date.split('-').map(|part| part.parse::<u32>().ok());
    let (mut year, mut month, mut day) = (date.next()??, date.next()??, date.next()??);
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let lengths = [31, 28 + u32::from(leap), 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    day += 1;
    if day > *lengths.get(month.checked_sub(1)? as usize)? {
        day = 1;
        month += 1;
        if month == 13 { month = 1; year += 1; }
    }
    Some(format!("{year:04}-{month:02}-{day:02}T{time}"))
}

fn now() -> Result<String, Fault> {
    timestamp().ok_or_else(|| fail("CLOCK_UNAVAILABLE", "No se pudo consultar la hora de la solicitud."))
}

fn pending(
    base: &str, request: &AccessRequest, cancelled: bool, confirm_owner: impl FnOnce() -> Result<(), &'static str>,
) -> Result<Value, Fault> {
    let (kind, path) = match &request.target {
        Target::Folder { path, .. } => ("carpeta", Some(path.as_str())),
        Target::Continuity { .. } => ("continuidad", None),
    };
    let id = Uuid::new_v4().to_string();
    let created = now()?;
    let expiry = tomorrow(&created).ok_or_else(|| fail("CLOCK_UNAVAILABLE", "No se pudo calcular la caducidad."))?;
    let record = json!({
        "format":"mind-consent-request","version":1,"id":id,"kind":kind,"path":path,
        "requested":request.requested,"reason":request.reason,"client":clean(&request.client,120),
        "createdAt":created,"expiresAt":expiry
    });
    save(base, &format!("consent-request-{id}.json"), &record, None, confirm_owner)?;
    let prefix = if cancelled { "El formulario de autorización se canceló o tu cliente no pudo mostrarlo." }
        else { "Tu cliente no muestra formularios de autorización." };
    Ok(json!({"estado":"pendiente","solicitud":id,
        "instrucciones":format!("{prefix} La solicitud quedó pendiente para que el usuario la revise con \"Autorizar Mind\". Después consulta \"estado\".")}))
}

pub(crate) fn save_operation_pending(
    base: &str, kind: &str, operation: Value, client: &str, reason: &str, cancelled: bool,
    confirm_owner: impl FnOnce() -> Result<(), &'static str>,
) -> Result<Value, Fault> {
    let id = Uuid::new_v4().to_string();
    let created = now()?;
    let expiry = tomorrow(&created).ok_or_else(|| fail("CLOCK_UNAVAILABLE", "No se pudo calcular la caducidad."))?;
    let record = json!({
        "format": "mind-consent-request",
        "version": 1,
        "id": id,
        "kind": kind,
        "path": Value::Null,
        "requested": [kind],
        "reason": clean(reason, 300),
        "client": clean(client, 120),
        "createdAt": created,
        "expiresAt": expiry,
        "operation": operation,
    });
    save(base, &format!("consent-request-{id}.json"), &record, None, confirm_owner)?;
    let what = if kind == "vaciado" { "la eliminación definitiva" } else { "el borrado" };
    let mut out = json!({
        "estado": "pendiente",
        "solicitud": id,
        "que_hacer": format!("El usuario debe aprobar {what} en la consola de Mind: \"mind autorizar\" en la carpeta de Mind (o \"Autorizar Mind\"). Hasta entonces no se ha tocado nada."),
    });
    if cancelled {
        out["nota"] = json!("El formulario se cerró sin responder.");
    }
    Ok(out)
}

pub(crate) fn save_automation_pending(
    base: &str, function_id: &str, generation: &str, fingerprint: &str, client: &str, reason: &str,
    cancelled: bool, confirm_owner: impl FnOnce() -> Result<(), &'static str>,
) -> Result<Value, Fault> {
    let id = Uuid::new_v4().to_string();
    let created = now()?;
    let expiry = tomorrow(&created).ok_or_else(|| fail("CLOCK_UNAVAILABLE", "No se pudo calcular la caducidad."))?;
    let record = json!({
        "format": "mind-consent-request",
        "version": 1,
        "id": id,
        "kind": "automatizacion",
        "path": Value::Null,
        "requested": ["activar"],
        "reason": clean(reason, 300),
        "client": clean(client, 120),
        "createdAt": created,
        "expiresAt": expiry,
        "automation": {
            "functionId": function_id,
            "generation": generation,
            "fingerprint": fingerprint,
        },
    });
    save(base, &format!("consent-request-{id}.json"), &record, None, confirm_owner)?;
    let mut out = json!({
        "estado": "pendiente",
        "solicitud": id,
        "que_hacer": "El usuario debe aprobar la activación con \"mind autorizar\" en la carpeta de Mind. Hasta entonces no se ejecuta sola.",
    });
    if cancelled {
        out["nota"] = json!("El formulario se cerró sin responder.");
    }
    Ok(out)
}

pub(crate) fn remove_pending_automation_requests(
    base: &str, function_id: &str, confirm_owner: impl Fn() -> Result<(), &'static str>,
) -> Result<(), Fault> {
    let entries = fs::read_dir(base).map_err(|_| fail("READ_FAILED", "No se pudieron listar las solicitudes."))?;
    for entry in entries {
        let Ok(entry) = entry else { continue };
        let filename = entry.file_name();
        let Some(name) = filename.to_str() else { continue };
        let Some(id) = name.strip_prefix("consent-request-").and_then(|value| value.strip_suffix(".json")) else { continue };
        if !Uuid::parse_str(id).is_ok_and(|uuid| uuid.to_string() == id) { continue; }
        let Some(record) = read_json(base, name).ok().flatten() else { continue };
        if record["kind"] == "automatizacion" && record["automation"]["functionId"].as_str() == Some(function_id) {
            let _ = remove_base_file(base, name, &confirm_owner);
        }
    }
    Ok(())
}

fn normalize_exclusions(raw: impl IntoIterator<Item = String>) -> Result<Vec<String>, Fault> {
    let invalid = || fail("INVALID_EXCLUSIONS", "Indica hasta 64 rutas relativas dentro de la carpeta.");
    let raw = raw.into_iter().collect::<Vec<_>>();
    if raw.len() > 64 { return Err(invalid()); }
    let mut normalized: Vec<String> = Vec::new();
    for item in raw {
        let normalized_path = item.replace('\\', "/");
        let item = normalized_path.trim_matches('/');
        if item.encode_utf16().count() > 1024 || item.contains('\0')
            || item.split('/').any(|part| matches!(part, "" | "." | ".."))
        {
            return Err(invalid());
        }
        if !normalized.iter().any(|known| {
            if cfg!(any(windows, target_os = "macos")) { known.to_lowercase() == item.to_lowercase() }
            else { known == item }
        }) {
            normalized.push(item.to_owned());
        }
    }
    normalized.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
    Ok(normalized)
}

fn merge(current: &[&str], added: &[&str], order: &[&'static str]) -> Vec<&'static str> {
    order.iter().copied().filter(|level| current.contains(level) || added.contains(level)).collect()
}

/// The reply must come from the server request on the original MCP session.
pub(crate) fn finish(
    paths: Paths<'_>, request: AccessRequest, answer: Option<&Value>,
    confirm_owner: impl Fn() -> Result<(), &'static str>,
) -> Result<Value, Fault> {
    let base = paths.base;
    let Some(answer) = answer else { return pending(base, &request, false, confirm_owner) };
    if !answer.is_object() {
        return Err(fail("CONSENT_UNAVAILABLE", "El cliente devolvió una respuesta de autorización no válida."));
    }
    match answer["action"].as_str() {
        Some("decline") => return Ok(json!({"estado":"rechazado"})),
        Some("accept") => (),
        _ => return pending(base, &request, true, confirm_owner),
    }
    let content = &answer["content"];
    match request.target {
        Target::Continuity { policy } => {
            let granted = request.requested.iter().copied().filter(|level| content[*level] == true).collect::<Vec<_>>();
            if granted.is_empty() { return Ok(json!({"estado":"rechazado"})); }
            if !unchanged(base, POLICY, policy.as_ref())? { return Err(changed()); }
            let access = merge(&request.current, &granted, CONTINUITY);
            let record = json!({
                "format":"mind-continuity-access","version":1,"leer":access.contains(&"leer"),
                "registrar":access.contains(&"registrar"),"grantedAt":now()?,"channel":"formulario-del-cliente"
            });
            save(base, POLICY, &record, policy.as_ref(), confirm_owner)?;
            Ok(json!({"estado":"autorizado","continuidad":access}))
        }
        Target::Folder { path, id, registry, policy } => {
            let Some(granted) = content["acceso"].as_str().and_then(preset) else {
                return Ok(json!({"estado":"rechazado"}));
            };
            if candidate(&paths, &path)? != path { return Err(changed()); }
            crate::motor_permissions::check_workspace_request(base, Path::new(&path))?;
            let registry_name = registry_file(&id);
            let policy_name = policy_file(&id);
            if !unchanged(base, &registry_name, registry.as_ref())? || !unchanged(base, &policy_name, policy.as_ref())? {
                return Err(changed());
            }
            let prior_exclusions = registry.as_ref().and_then(|item| item.value["exclusions"].as_array());
            let added = content["excluir"].as_str().into_iter().flat_map(|text| text.split(',').map(str::trim))
                .filter(|text| !text.is_empty());
            let exclusions = normalize_exclusions(prior_exclusions.into_iter().flatten().filter_map(Value::as_str).chain(added).map(str::to_owned))?;
            let generation = registry.as_ref().map(|record| record.value["generation"].clone())
                .unwrap_or_else(|| json!(Uuid::new_v4().to_string()));
            if registry.is_none() || prior_exclusions.map(Vec::len).unwrap_or(0) != exclusions.len() {
                let mut authority = json!({
                    "format":"mind-folder-authorization","version":2,"id":id,"path":path,"generation":generation
                });
                if !exclusions.is_empty() {
                    authority["version"] = json!(3);
                    authority["exclusions"] = json!(exclusions);
                }
                save(base, &registry_name, &authority, registry.as_ref(), &confirm_owner)?;
            }
            let access = merge(&request.current, granted, FOLDER);
            let permissions = FOLDER.iter().map(|level| (level.to_string(), json!(access.contains(level)))).collect::<Map<_,_>>();
            let record = json!({
                "format":"mind-folder-access","version":1,"folderId":id,"generation":generation,
                "access":permissions,"grantedAt":now()?,"channel":"formulario-del-cliente"
            });
            save(base, &policy_name, &record, policy.as_ref(), || {
                confirm_owner()?;
                let live = read_json(base, &registry_name).map_err(|error| error.code)?;
                if live.is_some_and(|value| value["id"] == id && value["path"] == path
                    && value["generation"] == generation) { Ok(()) } else { Err("ACCESS_CHANGED") }
            })?;
            let _ = crate::motor_files::reconcile_index_by_id(base, &id, &confirm_owner);
            let folder_obj = Folder {
                id: id.clone(),
                root: path.clone(),
                generation: generation.as_str().map(str::to_owned),
                exclusions: exclusions.clone(),
            };
            let indice = crate::motor_files::index_summary(base, &folder_obj);
            Ok(json!({"estado":"autorizado","carpeta":{"id":id,"ruta":path,"permisos":access,"excluidas":exclusions},
                "indice":indice}))
        }
    }
}

fn valid_pending_operation(kind: Option<&str>, operation: &Value) -> bool {
    let Some(kind) = kind.filter(|k| matches!(*k, "borrado" | "vaciado")) else {
        return true;
    };
    let valid_folder = operation["folderId"].as_str().is_some_and(|id| id.len() == 64 && lower_hex(id));
    if !valid_folder {
        return false;
    }
    if kind == "borrado" {
        operation["relativePath"].as_str().is_some_and(|p| !p.is_empty() && p.encode_utf16().count() <= 4096)
    } else {
        operation["trashId"].as_str().is_some_and(crate::motor_files::valid_trash_id)
    }
}

fn valid_pending_automation(kind: Option<&str>, automation: &Value) -> bool {
    if kind != Some("automatizacion") {
        return true;
    }
    let fn_id_ok = automation["functionId"].as_str().is_some_and(|id| {
        let b = id.as_bytes();
        (1..=64).contains(&b.len())
            && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
            && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-' || *c == b'_')
    });
    let gen_ok = automation["generation"].as_str().is_some_and(|g| {
        g.len() == 36 && Uuid::parse_str(g).is_ok_and(|uuid| uuid.to_string() == g)
    });
    let fp_ok = automation["fingerprint"].as_str().is_some_and(|fp| fp.len() == 64 && lower_hex(fp));
    fn_id_ok && gen_ok && fp_ok
}

fn is_valid_pending(record: &Value, id: &str, now: &str) -> bool {
    let kind = record["kind"].as_str();
    record["format"] == "mind-consent-request"
        && record["version"] == 1
        && record["id"] == id
        && matches!(kind, Some("carpeta" | "continuidad" | "automatizacion" | "borrado" | "vaciado"))
        && record["createdAt"].as_str().is_some_and(|value| value.len() == now.len())
        && record["expiresAt"].as_str().is_some_and(|value| value.len() == now.len())
        && record["requested"].as_array().is_some_and(|items| items.iter().all(Value::is_string))
        && (kind != Some("carpeta")
            || record["path"].as_str().is_some_and(|value| !value.contains('\0') && Path::new(value).is_absolute()))
        && valid_pending_operation(kind, &record["operation"])
        && valid_pending_automation(kind, &record["automation"])
}

pub(crate) fn list_pending(base: &str) -> Result<Vec<Value>, Fault> {
    let now = now()?;
    let entries = fs::read_dir(base).map_err(|_| fail("READ_FAILED", "No se pudieron listar las solicitudes."))?;
    let mut requests = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|_| fail("READ_FAILED", "No se pudieron listar las solicitudes."))?;
        let filename = entry.file_name();
        let Some(name) = filename.to_str() else { continue };
        let Some(id) = name.strip_prefix("consent-request-").and_then(|value| value.strip_suffix(".json")) else { continue };
        if !Uuid::parse_str(id).is_ok_and(|uuid| uuid.to_string() == id) { continue; }
        let Some(record) = read_json(base, name).ok().flatten() else { continue };
        if !is_valid_pending(&record, id, &now) || record["expiresAt"].as_str().is_none_or(|value| value < now.as_str()) {
            continue;
        }
        requests.push(json!({"id":id,"tipo":record["kind"],"ruta":record["path"],"permisos":record["requested"],"creada":record["createdAt"]}));
    }
    requests.sort_by(|left, right| {
        left["creada"].as_str().cmp(&right["creada"].as_str())
            .then_with(|| left["id"].as_str().cmp(&right["id"].as_str()))
    });
    Ok(requests)
}

pub(crate) fn remove_base_file(
    base: &str, name: &str, confirm_owner: impl FnOnce() -> Result<(), &'static str>,
) -> Result<bool, Fault> {
    scan::open_directory(base, "").map_err(|code| fail(code, "No se pudo abrir la Base de forma segura."))?;
    confirm_owner().map_err(|code| fail(code, "Cambió el propietario de la Base durante la operación."))?;
    let path = Path::new(base).join(name);
    match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(_) => return Err(fail("REMOVE_FAILED", "No se pudo comprobar el archivo técnico.")),
        Ok(meta) if meta.file_type().is_symlink() => {
            return Err(fail("RECORD_LINK", "Un registro técnico no puede ser un enlace."));
        }
        Ok(_) => {}
    }
    match fs::remove_file(&path) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err(fail("REMOVE_FAILED", "No se pudo retirar el archivo técnico.")),
    }
}

fn revoke_folder_files(
    base: &str, id: &str, confirm_owner: impl Fn() -> Result<(), &'static str>,
) -> Result<bool, Fault> {
    if id.len() != 64 || !lower_hex(id) {
        return Err(fail("INVALID_AUTHORIZATION_ID", "El identificador de autorización no es válido."));
    }
    let removed = remove_base_file(base, &registry_file(id), &confirm_owner)?;
    for name in [
        policy_file(id),
        format!("folder-properties-{id}.json"),
        format!("trash-{id}.json"),
        format!("folder-removed-{id}.json"),
        format!("folder-index-{id}.json"),
    ] {
        remove_base_file(base, &name, &confirm_owner)?;
    }
    Ok(removed)
}

pub(crate) fn retire(
    base: &str, args: &Map<String, Value>, confirm_owner: impl Fn() -> Result<(), &'static str>,
) -> Result<Value, Fault> {
    if args.keys().any(|key| !matches!(key.as_str(), "carpeta" | "permisos" | "excluir" | "todo")) {
        return Err(fail("INVALID_ARGUMENTS", "La retirada incluye argumentos no admitidos."));
    }
    let all = args.get("todo").map(|value| {
        value.as_bool().ok_or_else(|| fail("INVALID_ARGUMENTS", "todo debe ser booleano."))
    }).transpose()?.unwrap_or(false);
    let removing = args.get("permisos").map(|value| levels(value, FOLDER)).transpose()?;
    let revoke_all = all || removing.as_ref().is_some_and(|list| list.contains(&"encontrar"));
    let additions = args.get("excluir").map(|value| {
        let list = value.as_array().ok_or_else(|| fail("INVALID_ARGUMENTS", "excluir debe ser una lista de rutas."))?;
        list.iter().map(|item| item.as_str().filter(|value| value.encode_utf16().count() <= 1024)
            .map(str::to_owned).ok_or_else(|| fail("INVALID_ARGUMENTS", "Cada exclusión debe ser una ruta de hasta 1024 caracteres.")))
            .collect::<Result<Vec<_>, _>>()
    }).transpose()?;
    if !revoke_all && removing.is_none() && additions.is_none() {
        return Err(fail("INVALID_ARGUMENTS", "Indica los permisos a retirar o las rutas a excluir."));
    }
    let folders = folder_status(base)?;
    let selected = match args.get("carpeta") {
        Some(value) => {
            let reference = value.as_str().ok_or_else(|| fail("INVALID_ARGUMENTS", "carpeta debe ser texto."))?;
            folders.iter().find(|item| item["id"] == reference || item["ruta"].as_str().is_some_and(|path| {
                contains(Path::new(path), Path::new(reference)) && contains(Path::new(reference), Path::new(path))
            }))
        }
        None if folders.len() == 1 => folders.first(),
        None => return Err(fail("INVALID_ARGUMENTS", "Indica una carpeta registrada cuando el ámbito no sea único.")),
    }.ok_or_else(|| fail("FOLDER_NOT_AUTHORIZED", "La carpeta no está autorizada."))?;
    let id = selected["id"].as_str()
        .ok_or_else(|| fail("AUTHORIZATION_CORRUPT", "El registro de autorización de carpeta es incompatible."))?;
    if crate::motor_permissions::is_workspace_folder(id) {
        return Err(fail("NOT_YET_PORTED", "Retira la carpeta de las raíces abiertas para reducir los permisos persistidos de esa carpeta."));
    }

    let registry_name = registry_file(id);
    let policy_name = policy_file(id);
    let registry = read(base, &registry_name)?
        .ok_or_else(|| fail("FOLDER_NOT_AUTHORIZED", "La carpeta no tiene una autorización persistida."))?;
    let policy = read(base, &policy_name)?;
    let generation = &registry.value["generation"];
    let path = &registry.value["path"];
    // La lista fue validada por la misma política que aplica el Motor. Revisa
    // la instantánea para que una revocación simultánea no quede reescrita.
    let live = folder_status(base)?;
    let current = live.iter().find(|folder| folder["id"] == id)
        .ok_or_else(changed)?;
    if !unchanged(base, &registry_name, Some(&registry))? || !unchanged(base, &policy_name, policy.as_ref())? {
        return Err(changed());
    }

    if revoke_all {
        revoke_folder_files(base, id, &confirm_owner)?;
        return Ok(json!({
            "estado": "retirada",
            "carpeta": id,
            "nota": "Se retiró la autorización y su índice. Los archivos originales no se modificaron."
        }));
    }

    let mut result = json!({"estado":"actualizado","carpeta":id});
    if let Some(added) = additions {
        let previous = registry.value["exclusions"].as_array().into_iter().flatten().filter_map(Value::as_str);
        let exclusions = normalize_exclusions(previous.map(str::to_owned).chain(added))?;
        let authority = json!({
            "format":"mind-folder-authorization","version":3,"id":id,
            "path":path,"generation":generation,"exclusions":exclusions
        });
        save(base, &registry_name, &authority, Some(&registry), &confirm_owner)?;
        let updated_folder = Folder {
            id: id.to_owned(),
            root: path.as_str().unwrap_or_default().to_owned(),
            generation: generation.as_str().map(str::to_owned),
            exclusions: exclusions.clone(),
        };
        let removed_entries = crate::motor_files::prune_excluded_from_index(base, &updated_folder, &confirm_owner).unwrap_or(0);
        result["excluidas"] = json!(exclusions);
        if removing.is_none() {
            result["entradas_retiradas_del_indice"] = json!(removed_entries);
        }
    }

    if let Some(removing) = removing {
        let retained: Vec<_> = FOLDER.iter().copied().filter(|level| {
            !removing.contains(level) && current["permisos"].as_array()
                .is_some_and(|stored| stored.iter().any(|value| value == *level))
        }).collect();
        let access: Map<_, _> = FOLDER.iter().map(|level| (level.to_string(), json!(retained.contains(level)))).collect();
        let channel = policy.as_ref().and_then(|record| record.value["channel"].as_str()).unwrap_or("administracion-local");
        let record = json!({
            "format":"mind-folder-access","version":1,"folderId":id,"generation":generation,
            "access":access,"grantedAt":now()?,"channel":channel
        });
        save(base, &policy_name, &record, policy.as_ref(), || {
            confirm_owner()?;
            let current = read_json(base, &registry_name).map_err(|error| error.code)?;
            if current.is_some_and(|value| value["id"] == id && value["path"] == *path
                && value["generation"] == *generation) { Ok(()) } else { Err("ACCESS_CHANGED") }
        })?;
        result["permisos"] = json!(retained);
    }
    Ok(result)
}

fn valid_folder_id(value: Option<&Value>) -> Result<&str, Fault> {
    value.and_then(Value::as_str)
        .filter(|id| id.len() == 64 && lower_hex(id))
        .ok_or_else(|| fail("INVALID_SCOPE_ID", "El identificador de la carpeta no es válido."))
}

fn valid_channel_arg(value: Option<&Value>) -> Result<&str, Fault> {
    value.and_then(Value::as_str)
        .filter(|channel| matches!(*channel, "formulario-del-cliente" | "consola" | "administracion-local"))
        .ok_or_else(|| fail("INVALID_ACCESS", "Canal de consentimiento desconocido."))
}

pub(crate) fn console(
    paths: Paths<'_>, payload: &Value, confirm_owner: impl Fn() -> Result<(), &'static str>,
) -> Result<Value, Fault> {
    let base = paths.base;
    let operation = payload["operacion"].as_str()
        .ok_or_else(|| fail("INVALID_ARGUMENTS", "Indica la operación de consola."))?;
    match operation {
        "listar_carpetas" => {
            let folders: Vec<Value> = registered_folders(base)?.into_iter().map(|folder| {
                json!({"id": folder.id, "path": folder.root, "generation": folder.generation, "exclusions": folder.exclusions})
            }).collect();
            Ok(json!({"ok": true, "carpetas": folders}))
        }
        "obtener_carpeta" => {
            let id = valid_folder_id(payload.get("id"))?;
            let folder = registered_folders(base)?.into_iter().find(|folder| folder.id == id).map(|folder| {
                json!({"id": folder.id, "path": folder.root, "generation": folder.generation, "exclusions": folder.exclusions})
            });
            Ok(json!({"ok": true, "carpeta": folder}))
        }
        "autorizar_carpeta" => {
            let path = payload.get("ruta").and_then(Value::as_str)
                .ok_or_else(|| fail("INVALID_FOLDER_PATH", "Indica una ruta absoluta válida."))?;
            let canonical = candidate(&paths, path)?;
            let id = folder_id(&canonical);
            if let Some(existing) = registered_folders(base)?.into_iter().find(|folder| folder.id == id) {
                return Ok(json!({"ok": true, "carpeta": {"id": existing.id, "path": existing.root}}));
            }
            let authority = json!({
                "format": "mind-folder-authorization",
                "version": 2,
                "id": id,
                "path": canonical,
                "generation": Uuid::new_v4().to_string(),
            });
            save(base, &registry_file(&id), &authority, None, &confirm_owner)?;
            Ok(json!({"ok": true, "carpeta": {"id": id, "path": canonical}}))
        }
        "exclusiones_carpeta" => {
            let id = valid_folder_id(payload.get("id"))?;
            let raw = payload.get("excluidas").and_then(Value::as_array)
                .ok_or_else(|| fail("INVALID_EXCLUSIONS", "Las exclusiones deben ser una lista."))?;
            let items = raw.iter().map(|item| {
                item.as_str().map(str::to_owned).ok_or_else(|| fail("INVALID_EXCLUSIONS", "Cada exclusión debe ser texto."))
            }).collect::<Result<Vec<_>, _>>()?;
            let exclusions = normalize_exclusions(items)?;
            let Some(folder) = registered_folders(base)?.into_iter().find(|folder| folder.id == id) else {
                return Err(fail("FOLDER_NOT_AUTHORIZED", "Esa carpeta no está autorizada."));
            };
            let registry_name = registry_file(id);
            let registry = read(base, &registry_name)?
                .ok_or_else(|| fail("FOLDER_NOT_AUTHORIZED", "Esa carpeta no está autorizada."))?;
            let authority = json!({
                "format": "mind-folder-authorization",
                "version": 3,
                "id": id,
                "path": folder.root,
                "generation": folder.generation,
                "exclusions": exclusions,
            });
            save(base, &registry_name, &authority, Some(&registry), &confirm_owner)?;
            let updated_folder = Folder {
                id: id.to_owned(),
                root: folder.root,
                generation: folder.generation,
                exclusions: exclusions.clone(),
            };
            let removed_entries = crate::motor_files::prune_excluded_from_index(base, &updated_folder, &confirm_owner).unwrap_or(0);
            Ok(json!({"ok": true, "exclusions": exclusions, "removedEntries": removed_entries}))
        }
        "retirar_carpeta" => {
            let id = valid_folder_id(payload.get("id"))?;
            let removed = revoke_folder_files(base, id, &confirm_owner)?;
            Ok(json!({"ok": true, "retirada": removed}))
        }
        "obtener_acceso" => {
            let id = valid_folder_id(payload.get("id"))?;
            let Some(folder) = registered_folders(base)?.into_iter().find(|folder| folder.id == id) else {
                return Ok(json!({"ok": true, "acceso": null}));
            };
            let acceso = persisted_folder_policy(base, &folder)?.map(|record| {
                json!({
                    "folderId": id,
                    "access": record["access"],
                    "grantedAt": record["grantedAt"],
                    "channel": record["channel"],
                })
            });
            Ok(json!({"ok": true, "acceso": acceso}))
        }
        "guardar_acceso" => {
            let id = valid_folder_id(payload.get("id"))?;
            let granted = levels(payload.get("permisos").unwrap_or(&Value::Null), FOLDER)?;
            let channel = valid_channel_arg(payload.get("canal"))?;
            let Some(folder) = registered_folders(base)?.into_iter().find(|folder| folder.id == id) else {
                return Err(fail("FOLDER_NOT_AUTHORIZED", "La carpeta no está registrada."));
            };
            let registry_name = registry_file(id);
            let policy_name = policy_file(id);
            let policy = read(base, &policy_name)?;
            let access: Map<_, _> = FOLDER.iter().map(|level| (level.to_string(), json!(granted.contains(level)))).collect();
            let granted_at = now()?;
            let generation_value = json!(folder.generation);
            let record = json!({
                "format": "mind-folder-access",
                "version": 1,
                "folderId": id,
                "generation": generation_value,
                "access": access,
                "grantedAt": granted_at,
                "channel": channel,
            });
            save(base, &policy_name, &record, policy.as_ref(), || {
                confirm_owner()?;
                let live = read_json(base, &registry_name).map_err(|error| error.code)?;
                let live_gen = live.as_ref().and_then(|value| value.get("generation")).cloned().unwrap_or(Value::Null);
                if live.is_some_and(|value| value["id"] == id && value["path"] == folder.root && live_gen == generation_value) {
                    Ok(())
                } else {
                    Err("ACCESS_CHANGED")
                }
            })?;
            if granted.contains(&"encontrar") {
                let _ = crate::motor_files::reconcile_folder_index(base, &folder, &confirm_owner);
            }
            Ok(json!({"ok": true, "acceso": {"folderId": id, "access": access, "grantedAt": granted_at, "channel": channel}}))
        }
        "retirar_acceso" => {
            let id = valid_folder_id(payload.get("id"))?;
            let removed = remove_base_file(base, &policy_file(id), &confirm_owner)?;
            Ok(json!({"ok": true, "retirado": removed}))
        }
        "obtener_continuidad" => {
            let policy = persisted_continuity_policy(base)?;
            Ok(json!({"ok": true, "continuidad": policy}))
        }
        "guardar_continuidad" => {
            let granted = levels(payload.get("permisos").unwrap_or(&Value::Null), CONTINUITY)?;
            let channel = valid_channel_arg(payload.get("canal"))?;
            let policy = read(base, POLICY)?;
            let (leer, registrar) = (granted.contains(&"leer"), granted.contains(&"registrar"));
            let granted_at = now()?;
            let record = json!({
                "format": "mind-continuity-access",
                "version": 1,
                "leer": leer,
                "registrar": registrar,
                "grantedAt": granted_at,
                "channel": channel,
            });
            save(base, POLICY, &record, policy.as_ref(), &confirm_owner)?;
            Ok(json!({"ok": true, "continuidad": {"leer": leer, "registrar": registrar, "grantedAt": granted_at, "channel": channel}}))
        }
        "listar_solicitudes" => {
            let now = now()?;
            let entries = fs::read_dir(base).map_err(|_| fail("READ_FAILED", "No se pudieron listar las solicitudes."))?;
            let mut requests = Vec::new();
            for entry in entries {
                let entry = entry.map_err(|_| fail("READ_FAILED", "No se pudieron listar las solicitudes."))?;
                let filename = entry.file_name();
                let Some(name) = filename.to_str() else { continue };
                let Some(id) = name.strip_prefix("consent-request-").and_then(|value| value.strip_suffix(".json")) else { continue };
                if !Uuid::parse_str(id).is_ok_and(|uuid| uuid.to_string() == id) { continue; }
                let stored = read_json(base, name).ok().flatten();
                match stored {
                    Some(record) if is_valid_pending(&record, id, &now)
                        && record["expiresAt"].as_str().is_some_and(|value| value >= now.as_str()) =>
                    {
                        requests.push(record);
                    }
                    _ => {
                        let _ = remove_base_file(base, name, &confirm_owner);
                    }
                }
            }
            requests.sort_by(|left, right| {
                left["createdAt"].as_str().cmp(&right["createdAt"].as_str())
                    .then_with(|| left["id"].as_str().cmp(&right["id"].as_str()))
            });
            Ok(json!({"ok": true, "solicitudes": requests}))
        }
        "retirar_solicitud" => {
            let id = payload.get("id").and_then(Value::as_str)
                .filter(|id| Uuid::parse_str(id).is_ok_and(|uuid| uuid.to_string() == *id))
                .ok_or_else(|| fail("INVALID_REQUEST_ID", "Identificador de solicitud no válido."))?;
            let removed = remove_base_file(base, &format!("consent-request-{id}.json"), &confirm_owner)?;
            Ok(json!({"ok": true, "retirada": removed}))
        }
        "leer_indice" => {
            let id = valid_folder_id(payload.get("id"))?;
            let indice = crate::motor_files::console_read_index(base, id)?;
            Ok(json!({"ok": true, "indice": indice}))
        }
        "indexar_carpeta" => {
            let id = valid_folder_id(payload.get("id"))?;
            let indice = crate::motor_files::reconcile_index_by_id(base, id, &confirm_owner)?;
            Ok(json!({"ok": true, "indice": indice}))
        }
        "obtener_papelera" => {
            let id = valid_folder_id(payload.get("id"))?;
            let trash_id = payload.get("papelera").and_then(Value::as_str)
                .ok_or_else(|| fail("INVALID_TRASH_ID", "El identificador de la papelera no es válido."))?;
            let entrada = crate::motor_files::console_get_trash(base, id, trash_id)?;
            Ok(json!({"ok": true, "entrada": entrada}))
        }
        "borrar_elemento" => crate::motor_files::console_delete_entry(base, payload, &confirm_owner),
        "vaciar_elemento" => crate::motor_files::console_purge_entry(base, payload, &confirm_owner),
        "preparar_automatizacion" => crate::motor_automations::console_prepare(base, payload),
        "autorizar_automatizacion" => crate::motor_automations::console_authorize(base, payload, &confirm_owner),
        "ejecutar_programadas" => crate::motor_automations::console_run_due(base, paths.motor, &confirm_owner),
        "respaldo_configurar" => crate::motor_backup::console_configure(base, paths.motor, payload, &confirm_owner),
        "respaldo_crear" => crate::motor_backup::console_create(base, paths.motor, payload, &confirm_owner),
        _ => Err(fail("INVALID_ARGUMENTS", "Operación de consola no admitida.")),
    }
}
