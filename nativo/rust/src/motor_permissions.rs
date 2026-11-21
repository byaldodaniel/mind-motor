use std::{
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
};

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use unicode_normalization::{char::is_combining_mark, UnicodeNormalization};

use crate::{motor_native::Fault, scan};

const MAX_JSON_BYTES: usize = 2 * 1024 * 1024;
const FOLDER_LEVELS: [&str; 4] = ["encontrar", "leer", "escribir", "organizar"];
const OUTPUT_TYPES: [&str; 7] = [
    "documentos", "imagenes", "videos", "audio", "codigo", "otros", "memoria",
];
const CHANNELS: [&str; 3] = ["formulario-del-cliente", "consola", "administracion-local"];

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct Scope {
    pub(crate) root: String,
    pub(crate) relative: String,
    pub(crate) id: String,
    generation: Option<String>,
}

struct Folder {
    id: String,
    root: String,
    generation: Option<String>,
    exclusions: Vec<String>,
}

fn fault(code: &'static str, message: &str) -> Fault {
    Fault { code, message: message.to_owned() }
}

/// Abre por descriptores, sin seguir enlaces ni leer un registro arbitrariamente grande.
pub(crate) fn read_file(root: &str, relative: &str, limit: usize) -> Result<Option<Vec<u8>>, Fault> {
    let file = match scan::open_reader(root, relative) {
        Ok(file) => file,
        Err("FILE_NOT_FOUND") => return Ok(None),
        Err(code) => return Err(fault(code, "No se pudo abrir el archivo de forma segura.")),
    };
    let mut data = Vec::new();
    file.take(limit.saturating_add(1) as u64)
        .read_to_end(&mut data)
        .map_err(|_| fault("READ_FAILED", "No se pudo leer el archivo."))?;
    if data.len() > limit {
        return Err(fault("FILE_TOO_LARGE", "El archivo supera el tamaño permitido."));
    }
    Ok(Some(data))
}

pub(crate) fn read_json(base: &str, name: &str) -> Result<Option<Value>, Fault> {
    read_file(base, name, MAX_JSON_BYTES)?
        .map(|bytes| {
            serde_json::from_slice(&bytes)
                .map_err(|_| fault("RECORD_CORRUPT", "El registro técnico no contiene JSON válido."))
        })
        .transpose()
}

fn valid_channel(record: &Value) -> bool {
    record["channel"].as_str().is_some_and(|channel| CHANNELS.contains(&channel))
}

pub(crate) fn continuity_access(base: &str) -> Result<Vec<&'static str>, Fault> {
    let Some(policy) = read_json(base, "agent-continuity-access.json")? else {
        return Ok(Vec::new());
    };
    if policy["format"] != "mind-continuity-access"
        || policy["version"] != 1
        || !valid_channel(&policy)
        || !["leer", "registrar"].iter().all(|level| policy[*level].is_boolean())
    {
        return Err(fault("ACCESS_POLICY_CORRUPT", "La decisión de acceso a la continuidad es incompatible."));
    }
    Ok(["leer", "registrar"].into_iter().filter(|level| policy[*level] == true).collect())
}

pub(crate) fn check_continuity(base: &str, write: bool) -> Result<(), Fault> {
    let access = continuity_access(base)?;
    if !access.contains(&"leer") || (write && !access.contains(&"registrar")) {
        return Err(fault("ACCESS_NOT_GRANTED", "Se necesita el permiso vigente de continuidad."));
    }
    Ok(())
}

fn lower_hex(value: &str) -> bool {
    value.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn generation(value: &Value) -> Option<&str> {
    value.as_str().filter(|id| {
        id.len() == 36
            && id.bytes().all(|byte| byte == b'-' || byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

fn relative_parts<'a>(parent: &Path, child: &'a Path) -> Option<Vec<&'a str>> {
    let mut child = child.components();
    for expected in parent.components() {
        let actual = child.next()?;
        let (expected, actual) = (expected.as_os_str().to_str()?, actual.as_os_str().to_str()?);
        let equal = if cfg!(windows) { expected.to_lowercase() == actual.to_lowercase() } else { expected == actual };
        if !equal {
            return None;
        }
    }
    child
        .map(|part| {
            let Component::Normal(part) = part else { return None };
            part.to_str()
        })
        .collect()
}

fn valid_absolute(path: &Path) -> bool {
    path.is_absolute() && path.to_str().is_some_and(|path| !path.contains('\0'))
        && !path.components().any(|part| matches!(part, Component::ParentDir))
}

fn valid_exclusions(value: &Value) -> Option<Vec<String>> {
    let excludes = value.as_array()?;
    if excludes.len() > 64 {
        return None;
    }
    excludes
        .iter()
        .map(|item| {
            let item = item.as_str()?;
            (item.encode_utf16().count() <= 1024
                && !item.contains(['\0', '\\'])
                && !item.split('/').any(|part| matches!(part, "" | "." | "..")))
            .then(|| item.to_owned())
        })
        .collect()
}

fn load_folder(base: &str, id: &str, record: Value) -> Result<Folder, Fault> {
    let invalid = || fault("AUTHORIZATION_CORRUPT", "El registro de autorización de carpeta es incompatible.");
    let version = record["version"].as_u64().ok_or_else(invalid)?;
    let size = record.as_object().ok_or_else(invalid)?.len();
    let root = record["path"].as_str().ok_or_else(invalid)?;
    let root_path = Path::new(root);
    let canonical_id = format!("{:x}", Sha256::digest(if cfg!(windows) { root.to_lowercase() } else { root.to_owned() }));
    if record["format"] != "mind-folder-authorization"
        || record["id"] != id || canonical_id != id || !valid_absolute(root_path)
    {
        return Err(invalid());
    }
    let (folder_generation, exclusions) = match (version, size) {
        (1, 4) => (None, Vec::new()),
        (2, 5) => (Some(generation(&record["generation"]).ok_or_else(invalid)?.to_owned()), Vec::new()),
        (3, 6) if record.get("generation") == Some(&Value::Null) || generation(&record["generation"]).is_some() => {
            (generation(&record["generation"]).map(str::to_owned), valid_exclusions(&record["exclusions"]).ok_or_else(invalid)?)
        }
        _ => return Err(invalid()),
    };
    let base = Path::new(base);
    if relative_parts(base, root_path).is_some() || relative_parts(root_path, base).is_some() {
        return Err(fault("FOLDER_OVERLAPS_INTERNAL", "La carpeta autorizada no puede abarcar la Base."));
    }
    Ok(Folder { id: id.to_owned(), root: root.to_owned(), generation: folder_generation, exclusions })
}

fn folders(base: &str) -> Result<Vec<Folder>, Fault> {
    // Solo enumeramos nombres técnicos bajo la Base. La apertura de cada registro
    // usa el lector por descriptores.
    scan::open_directory(base, "").map_err(|code| fault(code, "No se pudo abrir la Base de forma segura."))?;
    let names = fs::read_dir(base).map_err(|_| fault("READ_FAILED", "No se pudieron consultar las carpetas registradas."))?;
    let mut records = Vec::new();
    for entry in names {
        let name = entry.map_err(|_| fault("READ_FAILED", "No se pudo consultar un registro de carpeta."))?.file_name();
        let Some(name) = name.to_str() else { continue };
        let Some(id) = name.strip_prefix("folder-authorization-").and_then(|name| name.strip_suffix(".json")) else {
            continue;
        };
        if id.len() == 64 && lower_hex(id) {
            if let Some(record) = read_json(base, name)? {
                records.push(load_folder(base, id, record)?);
            }
        }
    }
    records.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(records)
}

fn folder_access(base: &str, folder: &Folder) -> Result<Vec<&'static str>, Fault> {
    let Some(record) = read_json(base, &format!("folder-access-{}.json", folder.id))? else {
        return Ok(Vec::new());
    };
    let access = &record["access"];
    if record["format"] != "mind-folder-access"
        || record["version"] != 1 || record["folderId"] != folder.id
        || !valid_channel(&record) || !record["grantedAt"].is_string()
        || !(record.get("generation") == Some(&Value::Null) || generation(&record["generation"]).is_some())
        || access.as_object().map(Map::len) != Some(FOLDER_LEVELS.len())
        || !FOLDER_LEVELS.iter().all(|level| access[*level].is_boolean())
    {
        return Err(fault("ACCESS_POLICY_CORRUPT", "La decisión de acceso a la carpeta es incompatible."));
    }
    if generation(&record["generation"]) != folder.generation.as_deref() {
        return Ok(Vec::new());
    }
    Ok(FOLDER_LEVELS.into_iter().filter(|level| access[*level] == true).collect())
}

pub(crate) fn folder_status(base: &str) -> Result<Vec<Value>, Fault> {
    folders(base)?.into_iter().map(|folder| {
        let access = folder_access(base, &folder)?;
        Ok(json!({"id": folder.id, "ruta": folder.root, "permisos": access, "excluidas": folder.exclusions}))
    }).collect()
}

fn excluded(folder: &Folder, names: &[&str]) -> bool {
    const HIDDEN: [&str; 6] = [".papelera-mind", ".codex", ".claude", ".gemini", ".git", "node_modules"];
    let fold = |value: &str| if cfg!(any(windows, target_os = "macos")) { value.to_lowercase() } else { value.to_owned() };
    if names.iter().any(|name| HIDDEN.contains(&fold(name).as_str())) {
        return true;
    }
    let relative = fold(&names.join("/"));
    folder.exclusions.iter().any(|entry| {
        let entry = fold(entry);
        relative == entry || relative.strip_prefix(&entry).is_some_and(|remaining| remaining.starts_with('/'))
    })
}

pub(crate) fn resolve_markdown(base: &str, destination: &Path) -> Result<Scope, Fault> {
    if !valid_absolute(destination)
        || !destination.extension().and_then(|extension| extension.to_str()).is_some_and(|extension| extension.eq_ignore_ascii_case("md"))
    {
        return Err(fault("INVALID_CONVERSATION_DESTINATION", "El destino debe ser un archivo .md con ruta absoluta."));
    }
    let registered = folders(base)?;
    let (folder, names) = registered.iter().filter_map(|folder| {
        let names = relative_parts(Path::new(&folder.root), destination)?;
        (!names.is_empty()).then_some((folder, names))
    }).max_by_key(|(folder, _)| folder.root.len())
        .ok_or_else(|| fault("FOLDER_NOT_AUTHORIZED", "El destino no está en una carpeta registrada."))?;
    make_scope(base, folder, names, &["leer", "escribir"])
}

fn absolute_directory(value: &Value) -> bool {
    value.as_str().is_some_and(|directory| directory.encode_utf16().count() <= 4096 && valid_absolute(Path::new(directory)))
}

fn valid_destination_layer(value: &Value) -> bool {
    value.as_object().is_some_and(|layer| layer.iter().all(|(key, value)| match key.as_str() {
        "carpeta" => absolute_directory(value),
        "tipos" => value.as_object().is_some_and(|types| types.iter().all(|(key, value)| OUTPUT_TYPES.contains(&key.as_str()) && absolute_directory(value))),
        _ => false,
    }))
}

pub(crate) fn destinations(base: &str, project: Option<&str>, conversation: Option<&str>) -> Result<Value, Fault> {
    let Some(data) = read_json(base, "work-destinations.json")? else {
        return Ok(json!({"revision": 0, "general": {}, "proyecto": null, "conversacion": null, "efectivos": {}}));
    };
    let invalid = || fault("INVALID_DESTINATIONS", "La configuración de destinos es incompatible.");
    if data["format"] != "mind-work-destinations" || data["version"] != 1
        || !data["revision"].as_u64().is_some_and(|revision| (1..=9_007_199_254_740_991).contains(&revision))
        || !valid_destination_layer(&data["general"])
    {
        return Err(invalid());
    }
    let projects = data["proyectos"].as_object().ok_or_else(invalid)?;
    let conversations = data["conversaciones"].as_object().ok_or_else(invalid)?;
    if !projects.values().chain(conversations.values()).all(valid_destination_layer) {
        return Err(invalid());
    }
    let project = project.and_then(|project| {
        let name: String = project.nfd().filter(|character| !is_combining_mark(*character)).collect();
        projects.get(&name.to_lowercase())
    });
    let conversation = conversation.and_then(|id| conversations.get(id));
    let layers = [conversation, project, Some(&data["general"])];
    let effective: Map<String, Value> = OUTPUT_TYPES.into_iter().filter_map(|kind| {
        layers.iter().flatten().find_map(|layer| {
            layer["tipos"].get(kind).or_else(|| layer.get("carpeta")).map(|directory| (kind.to_owned(), directory.clone()))
        })
    }).collect();
    Ok(json!({"revision": data["revision"], "general": data["general"], "proyecto": project, "conversacion": conversation, "efectivos": effective}))
}

pub(crate) fn global_preferences(base: &str) -> Result<Value, Fault> {
    let Some(data) = read_json(base, "conversation-preferences.json")? else {
        return Ok(json!({"mode": "esencial", "rules": ""}));
    };
    let preferences = &data["preferences"];
    let rules = preferences["rules"].as_str().filter(|rules| rules.len() <= 4096 && !rules.contains('\0'));
    let mode = preferences["mode"].as_str();
    if data["format"] != "mind-conversation-preferences" || data["version"] != 1
        || !data["revision"].as_u64().is_some_and(|revision| (1..=9_007_199_254_740_991).contains(&revision))
        || !matches!(mode, Some("esencial" | "detallado" | "manual" | "personalizado"))
        || rules.is_none() || (mode == Some("personalizado") && rules.is_some_and(|rules| rules.trim().is_empty()))
        || preferences.get("directory").is_some_and(|directory| !absolute_directory(directory))
    {
        return Err(fault("INVALID_CONVERSATION_PREFERENCES", "Las preferencias de conversación son incompatibles."));
    }
    Ok(preferences.clone())
}

fn memory_directory(layer: &Value) -> Option<&str> {
    layer["tipos"]["memoria"].as_str().or_else(|| layer["carpeta"].as_str())
}

pub(crate) fn markdown_destination(
    base: &str, project: Option<&str>, conversation: Option<&str>, preferences: Option<&Value>, filename: &str,
) -> Result<PathBuf, Fault> {
    if !scan::reader_component(filename) {
        return Err(fault("UNSAFE_PATH", "Nombre de archivo inseguro."));
    }
    let configured = destinations(base, project, conversation)?;
    let global = global_preferences(base)?;
    let directory = preferences.and_then(|item| item["directory"].as_str())
        .or_else(|| memory_directory(&configured["conversacion"]))
        .or_else(|| memory_directory(&configured["proyecto"]))
        .or_else(|| global["directory"].as_str())
        .or_else(|| memory_directory(&configured["general"]));
    if let Some(directory) = directory {
        return Ok(Path::new(directory).join(filename));
    }
    let mut writable = Vec::new();
    for folder in folders(base)? {
        let access = folder_access(base, &folder)?;
        if access.contains(&"leer") && access.contains(&"escribir") {
            writable.push(folder.root);
        }
    }
    if let [only] = writable.as_slice() {
        return Ok(Path::new(only).join("Conversaciones").join(filename));
    }
    Err(fault("CONVERSATION_DESTINATION_REQUIRED", "Indica un destino o configura una carpeta de memoria autorizada."))
}

pub(crate) fn resolve_file(base: &str, carpeta: Option<&str>, relative: &str, required: &[&str]) -> Result<Scope, Fault> {
    let names: Vec<_> = relative.split('/').collect();
    let registered = folders(base)?;
    let folder = if let Some(reference) = carpeta {
        let matches_path = |folder: &Folder| {
            valid_absolute(Path::new(reference))
                && relative_parts(Path::new(&folder.root), Path::new(reference)).is_some_and(|rest| rest.is_empty())
        };
        registered.iter().find(|folder| folder.id == reference || matches_path(folder))
            .ok_or_else(|| fault("FOLDER_NOT_AUTHORIZED", "La carpeta no está registrada."))?
    } else if let [only] = registered.as_slice() {
        only
    } else {
        return Err(fault("INVALID_ARGUMENTS", "Indica una carpeta registrada cuando el ámbito no sea único."));
    };
    make_scope(base, folder, names, required)
}

fn make_scope(base: &str, folder: &Folder, names: Vec<&str>, required: &[&str]) -> Result<Scope, Fault> {
    let relative = names.join("/");
    if relative.encode_utf16().count() > 4096 || !names.iter().all(|name| scan::reader_component(name)) {
        return Err(fault("UNSAFE_PATH", "La ruta contiene componentes inseguros."));
    }
    let access = folder_access(base, folder)?;
    if !required.iter().all(|level| access.contains(level)) {
        return Err(fault("ACCESS_NOT_GRANTED", "La carpeta no tiene los permisos requeridos."));
    }
    if excluded(folder, &names) {
        return Err(fault("PATH_EXCLUDED", "El destino está en una ruta excluida."));
    }
    Ok(Scope {
        root: folder.root.clone(), relative, id: folder.id.clone(), generation: folder.generation.clone(),
    })
}