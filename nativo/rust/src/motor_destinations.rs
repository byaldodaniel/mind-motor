use std::path::{Component, Path, PathBuf};

use serde_json::{json, Map, Value};

use crate::{
    motor_files::{read_base_stored, refresh_index_after_write, write_base_json, IndexChange},
    motor_native::{invalid, only, Fault},
    motor_owner::timestamp,
    motor_permissions::{self as access, Scope, OUTPUT_TYPES},
    motor_records::load_conversation,
    motor_workspace::{relative_parts, same_path},
    organize, result_copy, scan,
};

const DESTINATIONS: &str = "work-destinations.json";
const MAX_REVISION: u64 = (1 << 53) - 1;
const MAX_METADATA_BYTES: usize = 256 * 1024;

pub(crate) fn call(
    base: &str, default: Option<&Path>, name: &str, args: &Map<String, Value>,
    confirm_owner: impl Fn() -> Result<(), &'static str>,
) -> Result<Value, Fault> {
    match name {
        "destinos_consultar" => {
            only(args, &["proyecto", "conversacion"])?;
            access::check_continuity(base, false)?;
            let selection = Selection::read(base, args)?;
            let mut result = access::destinations(base, selection.project.as_deref(), selection.id)?;
            let preferences = effective_preferences(base, selection.conversation.as_ref())?;
            result["predeterminado"] = json!(default.map(Path::to_path_buf).or(fallback(base)?));
            result["memoria"] = json!({
                "modo": preferences["mode"], "reglas": preferences["rules"],
                "archivo": selection.conversation.as_ref().map(|record| &record["content"]["file"]),
            });
            result["indicaciones"] = json!("Aplica estos destinos antes de cada creación. Para herramientas externas resuelve la ruta con destino_resolver; si imponen un temporal, copia el resultado con resultado_importar. Conserva y usa el ID de conversación.");
            access::check_continuity(base, false)?;
            Ok(result)
        }
        "destinos_configurar" => {
            only(args, &["proyecto", "conversacion", "revision", "destinos"])?;
            access::check_continuity(base, true)?;
            let selection = Selection::read(base, args)?;
            let revision = arg_revision(args, 0)?;
            let layer = args.get("destinos").ok_or_else(|| invalid("Indica destinos o null."))?;
            configure(base, selection.project.as_deref(), selection.id, revision, layer, || {
                confirm_owner()?;
                access::check_continuity(base, true).map_err(|error| error.code)
            })?;
            access::destinations(base, selection.project.as_deref(), selection.id)
        }
        "destino_resolver" => {
            only(args, &["proyecto", "conversacion", "nombre", "tipo", "destino", "preparar"])?;
            let prepare = args.get("preparar").map(|value| value.as_bool()
                .ok_or_else(|| invalid("preparar debe ser booleano."))).transpose()?.unwrap_or(false);
            let selection = Selection::read(base, args)?;
            let output = resolve(base, default, &selection, args, None)?;
            if prepare {
                prepare_parent(base, &output.scope, &["escribir"], &confirm_owner)?;
            }
            Ok(json!({
                "carpeta": output.scope.id, "ruta": output.scope.relative,
                "ruta_absoluta": output.absolute, "tipo": output.kind, "origen": output.origin,
            }))
        }
        "resultado_registrar" => {
            only(args, &["conversacion", "ruta", "tipo"])?;
            access::check_continuity(base, true)?;
            let selection = Selection::read(base, args)?;
            let id = selection.id.ok_or_else(|| invalid("Indica conversacion."))?;
            let path = absolute_path(args.get("ruta"))?;
            let kind = kind_of(args.get("tipo"), &path)?;
            let scope = resolve_scope(base, &path, &["escribir", "encontrar"])?;
            // El descriptor acredita existencia y tamaño sin leer el contenido.
            let file = scan::open_reader(&scope.root, &scope.relative).map_err(file_fault)?;
            let bytes = file.metadata().map_err(|_| file_fault("READ_FAILED"))?.len();
            let result = remember(base, id, &path, &kind, bytes, None, || {
                confirm_owner()?;
                confirm_scope(base, &scope, &["escribir", "encontrar"])
            })?;
            let _ = refresh_index_after_write(base, &scope, IndexChange::ObserveFile, &confirm_owner);
            Ok(json!({"estado": "registrado", "resultado": result}))
        }
        "resultado_importar" => {
            only(args, &["proyecto", "conversacion", "origen", "nombre", "tipo", "destino"])?;
            if args.contains_key("conversacion") {
                access::check_continuity(base, true)?;
            }
            let selection = Selection::read(base, args)?;
            let path = absolute_path(args.get("origen"))?;
            let source = resolve_scope(base, &path, &["leer"])?;
            let output = resolve(base, default, &selection, args, path.file_name().and_then(|name| name.to_str()))?;
            let confirm = || {
                confirm_owner()?;
                if selection.id.is_some() {
                    access::check_continuity(base, true).map_err(|error| error.code)?;
                }
                Ok(())
            };
            let copied = copy(base, &source, &output.scope, &confirm)?;
            let registration = match selection.id {
                None => json!({"estado": "sin_conversacion"}),
                Some(id) => match remember(base, id, &output.absolute, &output.kind, copied.size, Some(&copied.sha256), || {
                    confirm()?;
                    confirm_scope(base, &output.scope, &["escribir"])
                }) {
                    Ok(_) => json!({"estado": "registrado"}),
                    Err(error) => json!({
                        "estado": "pendiente", "codigo": error.code,
                        "nota": "El archivo existe en el destino; falta registrar sus metadatos.",
                    }),
                },
            };
            Ok(json!({
                "estado": "copiado", "ruta_absoluta": output.absolute,
                "bytes": copied.size, "sha256": copied.sha256, "origen_conservado": true,
                "registro": registration,
            }))
        }
        _ => Err(Fault::new("UNKNOWN_TOOL", "Operación de destinos desconocida.")),
    }
}

struct Selection<'a> {
    project: Option<String>,
    id: Option<&'a str>,
    conversation: Option<Value>,
}

impl<'a> Selection<'a> {
    fn read(base: &str, args: &'a Map<String, Value>) -> Result<Self, Fault> {
        let id = args.get("conversacion").map(crate::motor_native::id).transpose()?;
        let conversation = if let Some(id) = id {
            access::check_continuity(base, false)?;
            Some(load_conversation(base, id)?.0)
        } else {
            None
        };
        let project = args.get("proyecto").filter(|value| !(value.is_null() && id.is_some()))
            .map(|value| value.as_str().filter(|text| !text.trim().is_empty() && text.encode_utf16().count() <= 200)
                .ok_or_else(|| invalid_destinations("Proyecto no válido."))).transpose()?
            .or_else(|| conversation.as_ref().and_then(|record| record["content"]["project"].as_str()))
            .map(str::to_owned);
        Ok(Self { project, id, conversation })
    }
}

fn effective_preferences(base: &str, conversation: Option<&Value>) -> Result<Value, Fault> {
    let global = access::global_preferences(base)?;
    Ok(conversation.and_then(|item| item["content"].get("preferences")).filter(|value| !value.is_null())
        .cloned().unwrap_or(global))
}

struct Output {
    absolute: PathBuf,
    scope: Scope,
    kind: String,
    origin: &'static str,
}

fn resolve(
    base: &str, default: Option<&Path>, selection: &Selection<'_>, args: &Map<String, Value>,
    default_name: Option<&str>,
) -> Result<Output, Fault> {
    let name = match args.get("nombre") {
        None | Some(Value::Null) => default_name,
        Some(value) => value.as_str(),
    };
    let explicit = args.get("destino").map(|value| absolute_path(Some(value))).transpose()?;
    let inferred = name.map(Path::new).or(explicit.as_deref()).unwrap_or_else(|| Path::new(""));
    let kind = kind_of(args.get("tipo"), inferred)?;
    let (absolute, origin) = if let Some(location) = explicit {
        (location, "indicacion")
    } else {
        let name = name.filter(|name| name.encode_utf16().count() <= 4096 && name.split('/').all(scan::reader_component))
            .ok_or_else(|| invalid_destinations("Nombre relativo no válido."))?;
        let settings = access::destinations(base, selection.project.as_deref(), selection.id)?;
        let preference = settings["efectivos"][kind.as_str()].as_str();
        let origin = if preference.is_some() { "preferencia" } else { "predeterminado" };
        let directory = match preference.map(Path::new).or(default) {
            Some(directory) => directory.to_path_buf(),
            None => fallback(base)?.ok_or_else(|| Fault::new(
                "CONVERSATION_DESTINATION_REQUIRED", "No hay un único destino. Consulta destinos_consultar o indica uno autorizado."
            ))?,
        };
        (directory.join(name.replace('/', std::path::MAIN_SEPARATOR_STR)), origin)
    };
    let scope = resolve_scope(base, &absolute, &["escribir"])?;
    Ok(Output { absolute, scope, kind, origin })
}

pub(crate) fn folder_for(
    base: &str, path: &Path, allow_root: bool,
) -> Result<(access::Folder, String), Fault> {
    let mut folders = access::folders(base)?;
    folders.sort_by_key(|folder| std::cmp::Reverse(folder.root.len()));
    for folder in folders {
        let Some(parts) = relative_parts(Path::new(&folder.root), path) else { continue };
        if allow_root || !parts.is_empty() {
            return Ok((folder, parts.join("/")));
        }
    }
    Err(Fault::new("FOLDER_NOT_AUTHORIZED", "La ubicación no está abierta o autorizada en Mind."))
}

pub(crate) fn resolve_scope(base: &str, absolute: &Path, required: &[&str]) -> Result<Scope, Fault> {
    let (folder, relative) = folder_for(base, absolute, false)?;
    access::resolve_file(base, Some(&folder.id), &relative, required)
}

fn fallback(base: &str) -> Result<Option<PathBuf>, Fault> {
    let mut result = None;
    for folder in access::folders(base)? {
        if access::folder_access(base, &folder)?.contains(&"escribir") {
            if result.is_some() { return Ok(None); }
            result = Some(PathBuf::from(folder.root));
        }
    }
    Ok(result)
}

pub(crate) fn confirm_scope(base: &str, scope: &Scope, required: &[&str]) -> Result<(), &'static str> {
    let absolute = scope_path(scope);
    let current = resolve_scope(base, &absolute, required).map_err(|error| error.code)?;
    if current != *scope { return Err("ACCESS_NOT_GRANTED"); }
    Ok(())
}

fn scope_path(scope: &Scope) -> PathBuf {
    Path::new(&scope.root).join(scope.relative.replace('/', std::path::MAIN_SEPARATOR_STR))
}

fn prepare_parent(
    base: &str, scope: &Scope, required: &[&str],
    confirm: &impl Fn() -> Result<(), &'static str>,
) -> Result<(), Fault> {
    let Some((parent, _)) = scope.relative.rsplit_once('/') else { return Ok(()) };
    let mut relative = String::new();
    for part in parent.split('/') {
        if !relative.is_empty() { relative.push('/'); }
        relative.push_str(part);
        let directory = access::resolve_file(base, Some(&scope.id), &relative, &["organizar"])?;
        match scan::open_directory(&scope.root, &relative) {
            Ok(_) => continue,
            Err("FILE_NOT_FOUND") => (),
            Err(code) => return Err(file_fault(code)),
        }
        let result = organize::create_directory(&scope.root, &relative, || {
            confirm()?;
            confirm_scope(base, scope, required)?;
            confirm_scope(base, &directory, &["organizar"])
        });
        match result {
            Ok(()) => { let _ = refresh_index_after_write(base, &directory, IndexChange::CreateDirectory, confirm); }
            Err("FILE_EXISTS") => { scan::open_directory(&scope.root, &relative).map_err(file_fault)?; }
            Err(code) => return Err(file_fault(code)),
        }
    }
    Ok(())
}

pub(crate) fn copy(
    base: &str, source: &Scope, target: &Scope,
    confirm: &impl Fn() -> Result<(), &'static str>,
) -> Result<result_copy::DigestInfo, Fault> {
    prepare_parent(base, target, &["escribir"], confirm)?;
    let copied = result_copy::copy_file(&source.root, &source.relative, &target.root, &target.relative, || {
        confirm()?;
        confirm_scope(base, source, &["leer"])?;
        confirm_scope(base, target, &["escribir"])
    }).map_err(file_fault)?;
    let _ = refresh_index_after_write(base, target, IndexChange::CreateFile, confirm);
    Ok(copied)
}

pub(crate) fn verify(
    base: &str, source: &Scope, confirm: &impl Fn() -> Result<(), &'static str>,
) -> Result<result_copy::DigestInfo, Fault> {
    result_copy::verify_file(&source.root, &source.relative, || {
        confirm()?;
        confirm_scope(base, source, &["leer"])
    }).map_err(file_fault)
}

pub(crate) fn absolute_path(value: Option<&Value>) -> Result<PathBuf, Fault> {
    let value = value.and_then(Value::as_str)
        .filter(|text| !text.contains('\0') && text.encode_utf16().count() <= 4096)
        .ok_or_else(|| invalid_destinations("El destino debe ser una ruta absoluta."))?;
    let path = Path::new(value);
    if !path.is_absolute() { return Err(invalid_destinations("El destino debe ser una ruta absoluta.")); }
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => { normalized.pop(); }
            Component::CurDir => {}
            other => normalized.push(other.as_os_str()),
        }
    }
    Ok(normalized)
}

pub(crate) fn output_type(path: &Path) -> &'static str {
    match path.extension().and_then(|ext| ext.to_str()).unwrap_or("").to_ascii_lowercase().as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "avif" | "tiff" | "bmp" => "imagenes",
        "mp4" | "mov" | "webm" | "avi" | "mkv" => "videos",
        "mp3" | "wav" | "ogg" | "m4a" | "flac" => "audio",
        "js" | "ts" | "tsx" | "jsx" | "py" | "html" | "css" | "json" | "yaml" | "yml" | "sh"
        | "ps1" | "sql" | "rs" | "go" | "java" | "c" | "cpp" => "codigo",
        "md" | "txt" | "pdf" | "docx" | "xlsx" | "pptx" | "odt" | "ods" | "odp" | "csv" | "tsv" => "documentos",
        _ => "otros",
    }
}

fn kind_of(value: Option<&Value>, path: &Path) -> Result<String, Fault> {
    match value.filter(|value| !value.is_null()) {
        Some(value) => value.as_str().filter(|kind| OUTPUT_TYPES.contains(kind)).map(str::to_owned)
            .ok_or_else(|| invalid_destinations("Tipo de resultado no válido.")),
        None => Ok(output_type(path).to_owned()),
    }
}

pub(crate) fn validate_layer(value: &Value) -> Result<Value, Fault> {
    let layer = value.as_object().filter(|value| value.keys().all(|key| matches!(key.as_str(), "carpeta" | "tipos")))
        .ok_or_else(|| invalid_destinations("Política de destinos no válida."))?;
    let mut result = Map::new();
    if let Some(directory) = layer.get("carpeta") {
        result.insert("carpeta".to_owned(), json!(absolute_path(Some(directory))?));
    }
    if let Some(types) = layer.get("tipos") {
        let types = types.as_object().filter(|types| types.keys().all(|kind| OUTPUT_TYPES.contains(&kind.as_str())))
            .ok_or_else(|| invalid_destinations("Tipos de destino no válidos."))?;
        let normalized = types.iter().map(|(kind, directory)| Ok((kind.clone(), json!(absolute_path(Some(directory))?))))
            .collect::<Result<Map<_, _>, Fault>>()?;
        result.insert("tipos".to_owned(), json!(normalized));
    }
    Ok(Value::Object(result))
}

pub(crate) fn configure(
    base: &str, project: Option<&str>, conversation: Option<&str>, revision: u64, layer: &Value,
    confirm: impl Fn() -> Result<(), &'static str>,
) -> Result<(), Fault> {
    let previous = read_base_stored(base, DESTINATIONS)?;
    let mut next = match &previous {
        Some((value, _)) => {
            access::validate_destination_registry(value)?;
            value.clone()
        }
        None => json!({
            "format": "mind-work-destinations", "version": 1, "revision": 0,
            "general": {}, "proyectos": {}, "conversaciones": {},
        }),
    };
    if next["revision"] != revision || revision == MAX_REVISION {
        return Err(Fault::new("DESTINATIONS_REVISION_CONFLICT", "Los destinos cambiaron; vuelve a consultarlos."));
    }
    let layer = (!layer.is_null()).then(|| validate_layer(layer)).transpose()?;
    let selection = conversation.map(|id| ("conversaciones", id.to_owned()))
        .or_else(|| project.map(|name| ("proyectos", crate::motor_native::fold(name))));
    if let Some((section, key)) = selection {
        let policies = next[section].as_object_mut().expect("checked destination registry");
        if let Some(layer) = layer { policies.insert(key, layer); } else { policies.remove(&key); }
    } else {
        next["general"] = layer.unwrap_or_else(|| json!({}));
    }
    next["revision"] = json!(revision + 1);
    if next.to_string().len() > MAX_METADATA_BYTES {
        return Err(invalid_destinations("Demasiadas preferencias de destinos."));
    }
    write_base_json(base, DESTINATIONS, &next, previous.as_ref().map(|(_, bytes)| bytes.as_slice()), confirm)
}

pub(crate) fn result_state(base: &str, id: &str) -> Result<(Value, Option<Vec<u8>>), Fault> {
    match read_base_stored(base, &format!("conversation-results-{id}.json"))? {
        None => Ok((json!({"revision": 0, "results": []}), None)),
        Some((data, bytes)) => {
            if data["format"] != "mind-conversation-results" || data["version"] != 1
                || !data["revision"].as_u64().is_some_and(|value| value <= MAX_REVISION)
                || !data["results"].is_array()
            {
                return Err(Fault::new("RESULTS_CORRUPT", "Registro de resultados no compatible."));
            }
            Ok((data, Some(bytes)))
        }
    }
}

pub(crate) fn validate_results(results: &Value) -> Result<(), Fault> {
    let bad_result = || Fault::new("INVALID_RESULT", "Resultado no válido.");
    let entries = results.as_array().ok_or_else(bad_result)?;
    if entries.len() > 1000 || results.to_string().len() > MAX_METADATA_BYTES {
        return Err(Fault::new("RESULTS_TOO_LARGE", "Demasiados resultados en esta conversación."));
    }
    for item in entries {
        absolute_path(item.get("path")).map_err(|_| bad_result())?;
        if !item["type"].as_str().is_some_and(|kind| OUTPUT_TYPES.contains(&kind))
            || !item["bytes"].as_u64().is_some_and(|size| size <= MAX_REVISION)
            || item.get("sha256").is_some_and(|hash| !hash.as_str().is_some_and(|hash| hash.len() == 64 && access::lower_hex(hash)))
        {
            return Err(bad_result());
        }
    }
    Ok(())
}

pub(crate) fn replace_results(
    base: &str, id: &str, revision: u64, results: &Value, confirm: impl Fn() -> Result<(), &'static str>,
) -> Result<(), Fault> {
    let (before, bytes) = result_state(base, id)?;
    if before["revision"] != revision || revision == MAX_REVISION {
        return Err(Fault::new("RESULTS_REVISION_CONFLICT", "Los resultados cambiaron; vuelve a consultarlos."));
    }
    validate_results(results)?;
    let next = json!({"format": "mind-conversation-results", "version": 1, "revision": revision + 1, "results": results});
    write_base_json(base, &format!("conversation-results-{id}.json"), &next, bytes.as_deref(), confirm)
}

fn remember(
    base: &str, id: &str, path: &Path, kind: &str, size: u64, hash: Option<&str>,
    confirm: impl Fn() -> Result<(), &'static str>,
) -> Result<Value, Fault> {
    let (mut data, _) = result_state(base, id)?;
    let now = timestamp().ok_or_else(|| file_fault("CLOCK_UNAVAILABLE"))?;
    let mut entry = json!({"path": path, "type": kind, "bytes": size, "updatedAt": now});
    if let Some(hash) = hash { entry["sha256"] = json!(hash); }
    let entries = data["results"].as_array_mut().expect("checked result registry");
    entries.retain(|entry| !entry["path"].as_str().is_some_and(|prior| same_path(prior, path)));
    entries.push(entry.clone());
    replace_results(base, id, data["revision"].as_u64().unwrap_or_default(), &data["results"], || {
        confirm()?;
        access::check_continuity(base, true).map_err(|error| error.code)
    })?;
    Ok(entry)
}

pub(crate) fn arg_revision(args: &Map<String, Value>, min: u64) -> Result<u64, Fault> {
    args.get("revision").and_then(Value::as_u64).filter(|value| (min..=MAX_REVISION).contains(value))
        .ok_or_else(|| invalid("Indica una revisión válida."))
}

fn invalid_destinations(message: &'static str) -> Fault {
    Fault::new("INVALID_DESTINATIONS", message)
}

pub(crate) fn file_fault(code: &'static str) -> Fault {
    Fault::new(code, "Se detuvo la operación sobre el archivo. Revisa su ruta y permisos.")
}
