use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

use crate::{
    motor_consent::remove_base_file,
    motor_destinations::{self as outputs, absolute_path, arg_revision, file_fault, resolve_scope},
    motor_files::{read_base_stored, write_base_json},
    motor_native::{id, invalid, matches_markdown, only, Fault},
    motor_owner::timestamp,
    motor_permissions::{self as access, Scope, OUTPUT_TYPES},
    motor_records::{load_conversation, validate_record},
    motor_workspace::{relative_parts, same_path},
    result_copy::DigestInfo,
    scan,
};

const PREFERENCES: &str = "conversation-preferences.json";
const RELOCATION: &str = "conversation-relocation.json";
const MAX_REVISION: u64 = (1 << 53) - 1;

pub(crate) fn preferences(
    base: &str, changing: bool, args: &Map<String, Value>,
    confirm_owner: impl Fn() -> Result<(), &'static str>,
) -> Result<Value, Fault> {
    only(args, if changing { &["id", "revision", "preferencias"] } else { &["id"] })?;
    access::check_continuity(base, changing)?;
    let id = args.get("id").map(id).transpose()?;
    if changing {
        let preference = args.get("preferencias").ok_or_else(|| invalid("Indica preferencias."))?;
        let next = (!preference.is_null()).then(|| parse_preferences(preference)).transpose()?;
        let revision = arg_revision(args, u64::from(id.is_some()))?;
        let confirm = || {
            confirm_owner()?;
            access::check_continuity(base, true).map_err(|error| error.code)
        };
        if let Some(id) = id {
            let (mut record, bytes) = load_conversation(base, id)?;
            let content = record["content"].as_object_mut().expect("validated conversation content");
            if let Some(next) = next {
                content.insert("preferences".into(), next);
            } else {
                content.remove("preferences");
            }
            advance(&mut record, revision)?;
            write_base_json(base, &format!("continuity-{id}.json"), &record, Some(&bytes), confirm)?;
        } else {
            let next = next.ok_or_else(|| invalid_preference("Indica preferencias generales."))?;
            let previous = read_base_stored(base, PREFERENCES)?;
            let (current, _) = access::global_preferences_state(base)?;
            if current != revision || revision == MAX_REVISION {
                return Err(Fault::new("CONVERSATION_PREFERENCES_CONFLICT", "Las preferencias cambiaron; vuelve a consultarlas."));
            }
            let data = json!({
                "format": "mind-conversation-preferences", "version": 1,
                "revision": revision + 1, "preferences": next,
            });
            write_base_json(base, PREFERENCES, &data, previous.as_ref().map(|(_, bytes)| bytes.as_slice()), confirm)?;
        }
    }
    let (revision, global) = access::global_preferences_state(base)?;
    let conversation = id.map(|id| load_conversation(base, id).map(|record| record.0)).transpose()?;
    let exception = conversation.as_ref().and_then(|item| item["content"].get("preferences"))
        .filter(|value| !value.is_null());
    if let Some(exception) = exception {
        access::validate_preferences(exception)?;
    }
    let effective = exception.unwrap_or(&global);
    let mut description = preference_out(effective);
    description["automatica"] = json!(effective["mode"] != "manual");
    description["contenido_max_bytes"] = json!(64 * 1024);
    description["indicaciones"] = json!(match effective["mode"].as_str().unwrap_or_default() {
        "detallado" => "Conserva además contexto de trabajo, alternativas consideradas y explicaciones útiles. No supone copiar el historial completo. Actualiza ante cambios relevantes o al completar una etapa.",
        "manual" => "Guarda únicamente cuando el usuario lo indique expresamente. No guardes automáticamente.",
        "personalizado" => "Sigue las reglas del usuario para elegir contenido y momento de guardado.",
        _ => "Conserva decisiones y motivos, correcciones vigentes, resultados y ubicaciones, pendientes y siguiente paso. Actualiza ante cambios relevantes o al completar una etapa; no por cada mensaje.",
    });
    access::check_continuity(base, false)?;
    Ok(json!({
        "revision": revision, "revision_conversacion": conversation.as_ref().map(|record| &record["revision"]),
        "general": preference_out(&global), "excepcion": exception.map(preference_out),
        "heredada": exception.is_none(), "efectiva": description,
    }))
}

pub(crate) fn parse_preferences(value: &Value) -> Result<Value, Fault> {
    let fields = value.as_object().ok_or_else(|| invalid("Preferencias no válidas."))?;
    only(fields, &["modo", "reglas", "carpeta_destino"])?;
    let mut result = json!({
        "mode": value["modo"],
        "rules": fields.get("reglas").filter(|value| !value.is_null()).cloned().unwrap_or_else(|| json!("")),
    });
    if let Some(directory) = fields.get("carpeta_destino") {
        result["directory"] = directory.clone();
    }
    access::validate_preferences(&result)?;
    Ok(result)
}

pub(crate) fn preference_out(value: &Value) -> Value {
    let mut result = json!({"modo": value["mode"], "reglas": value["rules"]});
    if let Some(directory) = value.get("directory") { result["carpeta_destino"] = directory.clone(); }
    result
}

struct Resource {
    path: PathBuf,
    kind: String,
}

struct CopyPlan {
    resource: Resource,
    source: Scope,
    absolute: PathBuf,
    target: Scope,
    digest: DigestInfo,
    same_location: bool,
    reused: bool,
}

pub(crate) fn transfer(
    base: &str, args: &Map<String, Value>, confirm_owner: impl Fn() -> Result<(), &'static str>,
) -> Result<Value, Fault> {
    only(args, &["id", "revision", "destino"])?;
    access::check_continuity(base, true)?;
    let id = id(args.get("id").ok_or_else(|| invalid("Indica id."))?)?;
    let revision = arg_revision(args, 1)?;
    let directory = absolute_path(args.get("destino"))?;
    let (record, _) = load_conversation(base, id)?;
    if record["revision"] != revision { return Err(revision_conflict()); }
    let memory = record["content"]["file"].as_str()
        .ok_or_else(|| Fault::new("CONVERSATION_FILE_REQUIRED", "Guarda primero la memoria Markdown de esta conversación."))?;
    let (registered, _) = outputs::result_state(base, id)?;
    outputs::validate_results(&registered["results"])?;
    let policy = access::destinations(base, record["content"]["project"].as_str(), Some(id))?;
    let name = format!("conversation-transfer-{id}.json");
    let stored = read_base_stored(base, &name)?;
    let journal = stored.as_ref().map(|(value, _)| value);
    if journal.is_some_and(|stored| stored["format"] != "mind-conversation-transfer"
        || stored["version"] != 1 || stored["id"] != id || !stored["files"].is_array()
        || absolute_path(stored.get("destination")).is_err())
    {
        return Err(Fault::new("CONVERSATION_TRANSFER_CORRUPT", "El registro de copias necesita revisión."));
    }
    let completed = policy["conversacion"]["carpeta"].as_str().is_some_and(|path| same_path(path, &directory))
        && relative_parts(&directory, Path::new(memory)).is_some_and(|parts| !parts.is_empty());
    let retry = journal.filter(|stored| stored["destination"].as_str().is_some_and(|path| same_path(path, &directory)));
    let retry = match retry {
        Some(journal) if journal["revision"] == revision => {
            if journal["resultsRevision"] != registered["revision"] || journal["destinationsRevision"] != policy["revision"] {
                return Err(transfer_conflict("La conversación cambió desde el intento anterior. Se conservan las copias."));
            }
            journal["files"].as_array()
        }
        Some(_) if !completed => return Err(transfer_conflict("La conversación cambió desde el intento anterior. Se conservan las copias.")),
        _ => None,
    };

    let (resources, external) = collect_resources(base, memory, &registered["results"], &record)?;
    let confirm = || {
        confirm_owner()?;
        access::check_continuity(base, true).map_err(|error| error.code)
    };
    let plan = plan_copies(base, &directory, resources, retry.map(Vec::as_slice), &confirm)?;
    let first = &plan[0];
    let markdown = access::read_file(&first.source.root, &first.source.relative, 1024 * 1024)?
        .ok_or_else(|| file_fault("FILE_NOT_FOUND"))?;
    if !matches_markdown(&markdown, &record) {
        return Err(Fault::new("CONVERSATION_FILE_CONFLICT", "La memoria fue editada fuera de Mind; revisa esa edición antes de trasladarla."));
    }
    if crate::motor_native::digest(&markdown) != first.digest.sha256 {
        return Err(file_fault("SOURCE_CHANGED"));
    }
    if completed && plan.iter().all(|item| item.same_location) {
        if stored.is_some() { remove_base_file(base, &name, confirm)?; }
        let files: Vec<_> = plan.iter().map(|item| file_result(item, &item.digest, false)).collect();
        return Ok(json!({
            "estado": "trasladada", "id": id, "revision": revision, "archivo": memory, "destino": directory,
            "archivos": files, "referencias_externas": external, "origenes_conservados": true, "ya_trasladada": true,
        }));
    }

    let files: Vec<_> = plan.iter().map(|item| json!({
        "source": item.resource.path, "target": item.absolute, "size": item.digest.size, "sha256": item.digest.sha256,
    })).collect();
    let next = json!({
        "format": "mind-conversation-transfer", "version": 1, "id": id, "revision": revision,
        "destination": directory, "resultsRevision": registered["revision"], "destinationsRevision": policy["revision"],
        "files": files,
    });
    write_base_json(base, &name, &next, stored.as_ref().map(|(_, bytes)| bytes.as_slice()), &confirm)?;

    let mut copied = Vec::new();
    let outcome = (|| {
        for item in &plan {
            let actual = if item.reused {
                item.digest.clone()
            } else {
                outputs::copy(base, &item.source, &item.target, &confirm)?
            };
            copied.push(file_result(item, &actual, true));
            if actual != item.digest { return Err(file_fault("SOURCE_CHANGED")); }
        }
        for item in &plan {
            outputs::confirm_scope(base, &item.source, &["leer"]).map_err(file_fault)?;
            outputs::confirm_scope(base, &item.target, &["encontrar", "escribir"]).map_err(file_fault)?;
        }
        let metadata = transfer_metadata(id, revision, &directory, &record, &registered, &policy, &plan)?;
        write_base_json(base, RELOCATION, &metadata, None, &confirm)?;
        crate::motor_files::recover_move(base, &confirm_owner)?;
        let (updated, _) = load_conversation(base, id)?;
        remove_base_file(base, &name, &confirm_owner)?;
        Ok(updated["revision"].clone())
    })();

    match outcome {
        Ok(new_revision) => Ok(json!({
            "estado": "trasladada", "id": id, "revision": new_revision, "archivo": first.absolute,
            "destino": directory, "archivos": copied, "referencias_externas": external, "origenes_conservados": true,
        })),
        Err(error) => Ok(json!({
            "estado": "pendiente", "id": id, "archivos_copiados": copied, "origenes_conservados": true,
            "codigo": error.code, "mensaje": error.message,
            "nota": "Las decisiones y archivos originales se conservan. El traslado no está confirmado; vuelve a leer la conversación antes de continuar.",
        })),
    }
}

fn collect_resources(base: &str, memory: &str, results: &Value, record: &Value) -> Result<(Vec<Resource>, Vec<String>), Fault> {
    let mut resources = vec![Resource { path: PathBuf::from(memory), kind: "memoria".into() }];
    for item in results.as_array().into_iter().flatten() {
        let path = absolute_path(item.get("path"))?;
        if !resources.iter().any(|resource| same_path(resource.path.to_str().unwrap_or_default(), &path)) {
            resources.push(Resource { path, kind: item["type"].as_str().unwrap_or_default().to_owned() });
        }
    }
    let mut external = Vec::new();
    for locator in record["references"].as_array().into_iter().flatten().filter_map(|item| item["locator"].as_str()) {
        if !Path::new(locator).is_absolute() { continue; }
        let path = absolute_path(Some(&json!(locator)))?;
        if resources.iter().any(|resource| same_path(resource.path.to_str().unwrap_or_default(), &path)) { continue; }
        let (folder, relative) = outputs::folder_for(base, &path, true)?;
        if relative.is_empty() {
            external.push(locator.to_owned());
            continue;
        }
        let scope = access::resolve_file(base, Some(&folder.id), &relative, &["encontrar"])?;
        if scan::open_directory(&scope.root, &scope.relative).is_ok() {
            external.push(locator.to_owned());
        } else {
            resources.push(Resource { kind: outputs::output_type(&path).to_owned(), path });
        }
    }
    Ok((resources, external))
}

fn plan_copies(
    base: &str, directory: &Path, resources: Vec<Resource>, retry: Option<&[Value]>,
    confirm: &impl Fn() -> Result<(), &'static str>,
) -> Result<Vec<CopyPlan>, Fault> {
    let mut plan: Vec<CopyPlan> = Vec::with_capacity(resources.len());
    for resource in resources {
        let source = resolve_scope(base, &resource.path, &["leer"])?;
        let basename = resource.path.file_name().and_then(|name| name.to_str()).ok_or_else(|| file_fault("UNSAFE_PATH"))?;
        let destination = directory.join(&resource.kind);
        let mut absolute = destination.join(basename);
        let mut number = 1;
        while plan.iter().any(|item| same_path(item.absolute.to_str().unwrap_or_default(), &absolute)) {
            number += 1;
            absolute = destination.join(format!("{number}-{basename}"));
        }
        let target = resolve_scope(base, &absolute, &["encontrar", "escribir"])?;
        let same_location = same_path(resource.path.to_str().unwrap_or_default(), &absolute);
        let prior = retry.and_then(|entries| entries.iter().find(|item| {
            item["source"].as_str().is_some_and(|value| same_path(value, &resource.path))
                && item["target"].as_str().is_some_and(|value| same_path(value, &absolute))
        }));
        let exists = match scan::open_reader(&target.root, &target.relative) {
            Ok(_) => true,
            Err("FILE_NOT_FOUND") => false,
            Err(code) => return Err(file_fault(code)),
        };
        if exists && !same_location && prior.is_none() {
            return Err(Fault::new("FILE_EXISTS", "El destino contiene un archivo del mismo nombre; se conserva intacto."));
        }
        let digest = outputs::verify(base, &source, confirm)?;
        if prior.is_some_and(|item| item["size"] != digest.size || item["sha256"] != digest.sha256) {
            return Err(file_fault("SOURCE_CHANGED"));
        }
        if exists && !same_location && outputs::verify(base, &target, confirm)? != digest {
            return Err(transfer_conflict("Una copia del intento anterior cambió; se conserva intacta."));
        }
        plan.push(CopyPlan { resource, source, absolute, target, digest, same_location, reused: exists || same_location });
    }
    Ok(plan)
}

fn file_result(item: &CopyPlan, digest: &DigestInfo, include_source: bool) -> Value {
    let mut result = json!({
        "archivo": item.absolute, "tipo": item.resource.kind, "bytes": digest.size, "sha256": digest.sha256,
    });
    if include_source { result["origen"] = json!(item.resource.path); }
    result
}

fn transfer_metadata(
    id: &str, revision: u64, directory: &Path, record: &Value, results: &Value, policy: &Value, plan: &[CopyPlan],
) -> Result<Value, Fault> {
    let now = timestamp().ok_or_else(|| file_fault("CLOCK_UNAVAILABLE"))?;
    let mut references = record["references"].clone();
    for reference in references.as_array_mut().into_iter().flatten() {
        if let Some(item) = reference["locator"].as_str().and_then(|path| {
            plan.iter().find(|item| same_path(path, &item.resource.path))
        }) {
            reference["locator"] = json!(item.absolute);
        }
    }
    let results_out: Vec<_> = plan.iter().skip(1).map(|item| json!({
        "path": item.absolute, "type": item.resource.kind, "bytes": item.digest.size,
        "sha256": item.digest.sha256, "updatedAt": now,
    })).collect();
    let types: Map<_, _> = OUTPUT_TYPES.iter().map(|&kind| (kind.to_owned(), json!(directory.join(kind)))).collect();
    let mut metadata = json!({
        "format": "mind-conversation-relocation", "version": 1, "kind": "metadata", "id": id, "revision": revision,
        "file": plan[0].absolute, "references": references, "results": results_out, "resultsRevision": results["revision"],
        "destinations": {"carpeta": directory, "tipos": types}, "destinationsRevision": policy["revision"],
    });
    if let Some(prefs) = record["content"].get("preferences").filter(|value| !value.is_null()) {
        let mut prefs = prefs.clone();
        if prefs.get("directory").is_some() { prefs["directory"] = json!(directory.join("memoria")); }
        access::validate_preferences(&prefs)?;
        metadata["preferences"] = prefs;
    }
    outputs::validate_results(&metadata["results"])?;
    outputs::validate_layer(&metadata["destinations"])?;
    Ok(metadata)
}

// El diario metadata es el mismo que entiende r3. Comparar los valores
// antes de escribir permite reanudar después de publicar cualquiera de los tres registros.
pub(crate) fn apply_metadata(
    base: &str, journal: &Value, confirm: impl Fn() -> Result<(), &'static str>,
) -> Result<(), Fault> {
    let bad = || Fault::new("CONVERSATION_RELOCATION_CORRUPT", "El diario de traslado no tiene el formato esperado.");
    let id = id(&journal["id"]).map_err(|_| bad())?;
    let read_revision = |key: &str| journal[key].as_u64().filter(|&revision| revision < MAX_REVISION).ok_or_else(bad);
    let revision = read_revision("revision")?;
    if revision == 0 { return Err(bad()); }
    let results_revision = read_revision("resultsRevision")?;
    let destinations_revision = read_revision("destinationsRevision")?;
    let file = absolute_path(journal.get("file"))?;
    if !file.extension().and_then(|value| value.to_str()).is_some_and(|ext| ext.eq_ignore_ascii_case("md")) {
        return Err(bad());
    }
    let (mut record, bytes) = load_conversation(base, id)?;
    let before = record["content"].clone();
    let before_refs = record["references"].clone();
    record["content"]["file"] = json!(file);
    if record["content"]["markdownBase"].is_object() {
        record["content"]["markdownBase"]["file"] = json!(file);
    }
    if let Some(prefs) = journal.get("preferences") {
        access::validate_preferences(prefs)?;
        record["content"]["preferences"] = prefs.clone();
    }
    record["references"] = journal["references"].clone();
    let change_record = record["content"] != before || record["references"] != before_refs;
    if change_record { advance(&mut record, revision)?; }
    validate_record(&record, id)?;

    let (results, _) = outputs::result_state(base, id)?;
    outputs::validate_results(&journal["results"])?;
    let change_results = results["results"] != journal["results"];
    if change_results && results["revision"] != results_revision {
        return Err(Fault::new("RESULTS_REVISION_CONFLICT", "Los resultados cambiaron; vuelve a consultarlos."));
    }
    let settings = access::destinations(base, None, Some(id))?;
    let destinations = outputs::validate_layer(&journal["destinations"])?;
    let change_destinations = settings["conversacion"] != destinations;
    if change_destinations && settings["revision"] != destinations_revision {
        return Err(Fault::new("DESTINATIONS_REVISION_CONFLICT", "Los destinos cambiaron; vuelve a consultarlos."));
    }
    if change_record {
        write_base_json(base, &format!("continuity-{id}.json"), &record, Some(&bytes), &confirm)?;
    }
    if change_results { outputs::replace_results(base, id, results_revision, &journal["results"], &confirm)?; }
    if change_destinations { outputs::configure(base, None, Some(id), destinations_revision, &destinations, &confirm)?; }
    Ok(())
}

fn advance(record: &mut Value, revision: u64) -> Result<(), Fault> {
    if record["revision"] != revision || revision >= MAX_REVISION { return Err(revision_conflict()); }
    let now = timestamp().ok_or_else(|| file_fault("CLOCK_UNAVAILABLE"))?;
    record["revision"] = json!(revision + 1);
    if record["updatedAt"].as_str().is_some_and(|previous| previous < now.as_str()) {
        record["updatedAt"] = json!(now);
    }
    Ok(())
}

fn revision_conflict() -> Fault {
    Fault::new("CONTINUITY_REVISION_CONFLICT", "La conversación cambió; vuelve a leerla antes de modificarla.")
}

fn transfer_conflict(message: &'static str) -> Fault {
    Fault::new("CONVERSATION_TRANSFER_CONFLICT", message)
}

fn invalid_preference(message: &'static str) -> Fault {
    Fault::new("INVALID_CONVERSATION_PREFERENCES", message)
}
