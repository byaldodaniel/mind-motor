use std::{
    convert::Infallible,
    fs,
    io::{self, Write},
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use hyper::{body::Incoming, header, Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use tokio::{net::TcpListener, task::JoinSet};
use unicode_normalization::{char::is_combining_mark, UnicodeNormalization};
use uuid::Uuid;

use crate::{
    host::{self, Body},
    motor_mcp::Mcp,
    motor_owner::{timestamp, Owner},
    motor_files, motor_permissions as access, motor_records, organize, scan, text_write,
};

const MAX_RECORD: usize = 2 * 1024 * 1024;
const MAX_MARKDOWN: usize = 1024 * 1024;
const MAX_REVISION: u64 = (1 << 53) - 1;

#[derive(Debug)]
pub(crate) struct Fault {
    pub(crate) code: &'static str,
    pub(crate) message: String,
}

impl Fault {
    pub(crate) fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
}

impl std::fmt::Display for Fault {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

fn invalid(message: &'static str) -> Fault {
    Fault::new("INVALID_ARGUMENTS", message)
}

fn filesystem(code: &'static str) -> Fault {
    Fault::new(code, "La operación de archivo se detuvo. Revisa el destino y sus permisos.")
}

fn is_id(value: &str) -> bool {
    Uuid::parse_str(value).is_ok_and(|uuid| uuid.to_string() == value)
}

fn id(value: &Value) -> Result<&str, Fault> {
    value.as_str().filter(|id| is_id(id))
        .ok_or_else(|| Fault::new("INVALID_CONVERSATION_ID", "ID de conversación no válido."))
}

fn revision(value: &Value) -> Option<u64> {
    value.as_u64().filter(|&value| (1..=MAX_REVISION).contains(&value))
}

fn valid_text(value: &Value, limit: usize) -> Option<&str> {
    value.as_str().filter(|text| !text.trim().is_empty() && text.len() <= limit && !text.contains('\0'))
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn version(bytes: &[u8]) -> String {
    format!("sha256:{}", digest(bytes))
}

fn markdown(record: &Value) -> String {
    let content = &record["content"];
    let title = content["title"].as_str().unwrap_or_default().replace(['\r', '\n'], " ");
    let important = content["important"].as_str().unwrap_or_default();
    let id = record["id"].as_str().unwrap_or_default();
    let revision = record["revision"].as_u64().unwrap_or_default();
    format!("<!-- mind-conversation:{id} revision:{revision} -->\n# {title}\n\n{important}\n")
}

fn matches_markdown(bytes: &[u8], record: &Value) -> bool {
    let Ok(text) = std::str::from_utf8(bytes) else { return false };
    let Some((first, body)) = text.split_once('\n') else { return false };
    let Some(record_id) = record["id"].as_str() else { return false };
    let prefix = format!("<!-- mind-conversation:{record_id} revision:");
    let Some(number) = first.strip_prefix(&prefix).and_then(|part| part.strip_suffix(" -->"))
        .filter(|part| !part.starts_with('0') && part.bytes().all(|byte| byte.is_ascii_digit()))
        .and_then(|text| text.parse::<u64>().ok())
        else { return false };
    number > 0 && record["revision"].as_u64().is_some_and(|rev| number <= rev)
        && markdown(record).split_once('\n').is_some_and(|(_, expected)| body == expected)
}

fn file_conflict() -> Fault {
    Fault::new("CONVERSATION_FILE_CONFLICT", "El Markdown cambió fuera de Mind. Se conserva su contenido.")
}

fn revision_conflict() -> Fault {
    Fault::new("CONTINUITY_REVISION_CONFLICT", "La conversación cambió desde la revisión indicada.")
}

pub(crate) struct Motor {
    base: String,
    base_id: String,
    owner: Owner,
    work: Mutex<()>,
}

impl Motor {
    fn open(base: String) -> Result<Self, Fault> {
        let marker = access::read_json(&base, "mind-base.json")?.ok_or_else(|| {
            Fault::new("BASE_NOT_FOUND", "Indica una Base preparada por Mind.")
        })?;
        if marker["format"] != "mind-base" || marker["version"] != 3 {
            return Err(Fault::new("BASE_FORMAT_UNSUPPORTED", "El Motor nativo requiere el formato 3 de la Base."));
        }
        let base_id = id(&marker["baseId"])?.to_owned();
        let owner = Owner::acquire(&base).map_err(|error| {
            Fault::new("BASE_OWNERSHIP", error)
        })?;
        Ok(Self { base, base_id, owner, work: Mutex::new(()) })
    }

    pub(crate) fn call(&self, name: &str, args: Value) -> Result<Value, Fault> {
        let args = args.as_object().ok_or_else(|| invalid("Indica argumentos en un objeto."))?;
        let _work = self.work.lock().map_err(|_| Fault::new("MOTOR_UNAVAILABLE", "El Motor no pudo coordinar la petición."))?;
        self.owner.check().map_err(filesystem)?;
        match name {
            "estado" if args.is_empty() => self.state(),
            "retomar" => self.resume(args),
            "buscar" => self.search(args),
            "guardar" | "actualizar" if args.get("en").and_then(Value::as_str) == Some("continuidad") => {
                motor_records::call(&self.base, name, args, || self.owner.check())
            }
            "guardar" => self.save(args, false),
            "actualizar" => self.save(args, true),
            "leer" | "crear" | "modificar" => motor_files::call(&self.base, name, args, || self.owner.check()),
            _ => Err(Fault::new("UNKNOWN_TOOL", "Herramienta no disponible en el Motor nativo.")),
        }
    }

    fn state(&self) -> Result<Value, Fault> {
        Ok(json!({
            "mind": { "motor": "1.0.5", "base": self.base, "baseId": self.base_id },
            "motor_central": { "pid": std::process::id(), "estado": "active" },
            "continuidad": { "permisos": access::continuity_access(&self.base)? },
            "carpetas": access::folder_status(&self.base)?,
        }))
    }

    fn load(&self, id: &str) -> Result<(Value, String), Fault> {
        let name = record_file(id);
        let missing = || Fault::new("CONVERSATION_NOT_FOUND", "No existe esa conversación en Mind.");
        let bytes = access::read_file(&self.base, &name, MAX_RECORD)?.ok_or_else(missing)?;
        let record: Value = serde_json::from_slice(&bytes)
            .map_err(|_| Fault::new("RECORD_CORRUPT", "El registro técnico no contiene JSON válido."))?;
        if record["kind"] != "conversacion" || record["content"]["format"] != "mind-conversation" {
            return Err(missing());
        }
        let content = &record["content"];
        motor_records::validate_record(&record, id)?;
        if content["version"] != 1 || valid_text(&content["title"], 200).is_none()
            || valid_text(&content["important"], 64 * 1024).is_none()
        {
            return Err(Fault::new("CONTINUITY_CORRUPT", "El registro de conversación no tiene el formato esperado."));
        }
        Ok((record, digest(&bytes)))
    }

    fn resume(&self, args: &Map<String, Value>) -> Result<Value, Fault> {
        only(args, &["id", "consulta", "proyecto"])?;
        access::check_continuity(&self.base, false)?;
        let mut candidates = Vec::new();
        let id = match args.get("id") {
            Some(value) => id(value)?.to_owned(),
            None => {
                if !args.contains_key("consulta") { return Err(invalid("Indica un ID o texto para buscar.")); }
                candidates = self.hits(args)?.into_iter().take(3).collect();
                if candidates.is_empty() {
                    return Ok(json!({"encontrada":false, "consulta":args["consulta"], "candidatos":[]}));
                }
                candidates.remove(0)["id"].as_str().unwrap_or_default().to_owned()
            }
        };
        let (record, _) = self.load(&id)?;
        let mut value = conversation(&record);
        let results = access::read_json(&self.base, &format!("conversation-results-{id}.json"))?;
        if let Some(results) = results {
            if results["format"] != "mind-conversation-results" || results["version"] != 1 {
                return Err(Fault::new("RESULTS_CORRUPT", "Registro de resultados no compatible."));
            }
            let entries = results["results"].as_array().ok_or_else(|| Fault::new("RESULTS_CORRUPT", "Resultados no válidos."))?;
            value["resultados"] = json!(entries.iter().map(|entry| {
                let mut item = json!({"archivo": entry["path"], "tipo": entry["type"], "bytes": entry["bytes"]});
                if let Some(hash) = entry["sha256"].as_str() { item["sha256"] = json!(hash); }
                item
            }).collect::<Vec<_>>());
        } else {
            value["resultados"] = json!([]);
        }
        let destinations = access::destinations(&self.base, record["content"]["project"].as_str(), Some(&id))?;
        access::check_continuity(&self.base, false)?;
        let mut result = json!({ "conversacion": value, "destinos": destinations });
        if args.get("id").is_none() { result["candidatos"] = json!(candidates); }
        Ok(result)
    }

    fn search(&self, args: &Map<String, Value>) -> Result<Value, Fault> {
        only(args, &["en", "consulta", "proyecto", "limite"])?;
        if args.get("en") != Some(&json!("conversaciones")) {
            return Err(invalid("Indica buscar en conversaciones."));
        }
        access::check_continuity(&self.base, false)?;
        let limit = args.get("limite").map(|limit| limit.as_u64().filter(|limit| (1..=100).contains(limit))
            .ok_or_else(|| invalid("limite debe estar entre 1 y 100."))).transpose()?.unwrap_or(20);
        let hits = self.hits(args)?;
        let total = hits.len();
        let visible: Vec<_> = hits.into_iter().take(limit as usize).collect();
        access::check_continuity(&self.base, false)?;
        Ok(json!({ "total": total, "mostradas": visible.len(), "conversaciones": visible,
            "semantica": { "estado":"no_disponible" } }))
    }

    fn hits(&self, args: &Map<String, Value>) -> Result<Vec<Value>, Fault> {
        let query = args.get("consulta").map(|value| valid_text(value, 256)
            .ok_or_else(|| invalid("Indica texto de búsqueda de hasta 256 bytes."))).transpose()?;
        let project = args.get("proyecto").map(|value| valid_text(value, 200)
            .ok_or_else(|| invalid("Indica un proyecto válido."))).transpose()?.map(fold);
        let query = query.map(fold).unwrap_or_default();
        let terms = query.split_whitespace().collect::<Vec<_>>();
        let entries = fs::read_dir(&self.base).map_err(|_| filesystem("READ_FAILED"))?;
        let mut matches = Vec::new();
        for item in entries {
            let item = item.map_err(|_| filesystem("READ_FAILED"))?;
            let filename = item.file_name();
            let Some(candidate) = filename.to_str().and_then(|name| name.strip_prefix("continuity-"))
                .and_then(|name| name.strip_suffix(".json")).filter(|id| is_id(id)) else { continue };
            let (record, _) = match self.load(candidate) {
                Ok(value) => value,
                Err(error) if error.code == "CONVERSATION_NOT_FOUND" => continue,
                Err(error) => return Err(error),
            };
            let fields = &record["content"];
            if project.as_ref().is_some_and(|wanted| fields["project"].as_str().map(fold).as_ref() != Some(wanted)) {
                continue;
            }
            let title = fields["title"].as_str().unwrap_or_default();
            let important = fields["important"].as_str().unwrap_or_default();
            let heading = fold(title);
            let body = fold(important);
            if !terms.iter().all(|term| heading.contains(*term) || body.contains(*term)) { continue; }
            let rank = terms.iter().filter(|term| heading.contains(**term)).count();
            let excerpt: String = important.chars().take(240).collect();
            let updated = record["updatedAt"].as_str().unwrap_or_default().to_owned();
            matches.push((rank, updated, candidate.to_owned(), json!({
                "id": candidate, "revision": record["revision"], "titulo": title, "proyecto": fields["project"],
                "actualizado": record["updatedAt"], "extracto": excerpt, "coincidencia": "palabras",
            })));
        }
        matches.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.cmp(&a.1)).then_with(|| a.2.cmp(&b.2)));
        Ok(matches.into_iter().map(|(_, _, _, value)| value).collect())
    }

    fn save(&self, args: &Map<String, Value>, updating: bool) -> Result<Value, Fault> {
        only(args, &["en", "id", "revision", "titulo", "importante", "proyecto", "agente", "id_externo",
            "referencias", "destino", "solicitado", "preferencias"])?;
        if args.get("en").is_some_and(|value| value != "conversacion") {
            return Err(invalid("El Motor nativo guarda conversaciones."));
        }
        let explicit = args.get("solicitado").map(|value| value.as_bool().ok_or_else(|| {
            invalid("solicitado debe ser booleano.")
        })).transpose()?.unwrap_or(false);
        access::check_continuity(&self.base, true)?;
        let previous = if updating {
            let id = id(args.get("id").unwrap_or(&Value::Null))?;
            let expected = args.get("revision").and_then(revision).ok_or_else(|| invalid("Indica la revisión leída."))?;
            let loaded = self.load(id)?;
            if revision(&loaded.0["revision"]) != Some(expected) { return Err(revision_conflict()); }
            Some(loaded)
        } else {
            if args.contains_key("id") || args.contains_key("revision") {
                return Err(Fault::new("USE_ACTUALIZAR", "Usa actualizar para una conversación existente."));
            }
            None
        };
        let prior = previous.as_ref().map(|(record, _)| record);
        let prior_content = prior.map(|record| &record["content"]).unwrap_or(&Value::Null);
        let global = access::global_preferences(&self.base)?;
        let current_prefs = prior_content.get("preferences").unwrap_or(&global);
        let requested_prefs = args.get("preferencias").map(parse_preferences).transpose()?;
        if !explicit && (current_prefs["mode"] == "manual"
            || requested_prefs.as_ref().is_some_and(|prefs| prefs["mode"] == "manual"))
        {
            return Err(Fault::new("CONVERSATION_MANUAL_ONLY", "El usuario eligió guardar solo cuando lo indique."));
        }

        if let Some(prior) = prior.filter(|_| args.keys().all(|key| {
            matches!(key.as_str(), "en" | "id" | "revision" | "solicitado")
        })) {
            return self.retry(prior);
        }

        let conversation_id = prior.and_then(|record| record["id"].as_str())
            .map(str::to_owned).unwrap_or_else(|| Uuid::new_v4().to_string());
        let mut content = json!({"format": "mind-conversation", "version": 1});
        for (arg, field, limit, required) in [
            ("titulo", "title", 200, true), ("importante", "important", 64 * 1024, true),
            ("proyecto", "project", 200, false), ("agente", "agent", 200, false),
            ("id_externo", "externalId", 512, false),
        ] {
            let value = args.get(arg).unwrap_or(&prior_content[field]);
            if !required && value.is_null() {
                content[field] = Value::Null;
            } else {
                content[field] = json!(valid_text(value, limit).ok_or_else(|| Fault::new(
                    "INVALID_CONVERSATION", format!("El campo {arg} requiere texto válido de hasta {limit} bytes.")
                ))?);
            }
        }
        let preferences = requested_prefs.as_ref().or_else(|| prior_content.get("preferences"));
        if let Some(preferences) = preferences { content["preferences"] = preferences.clone(); }
        let target = match args.get("destino") {
            Some(value) => PathBuf::from(valid_text(value, 4096).ok_or_else(|| invalid("Indica un destino válido."))?),
            None => match prior_content["file"].as_str() {
                Some(file) => PathBuf::from(file),
                None => access::markdown_destination(
                    &self.base, content["project"].as_str(), prior.map(|_| conversation_id.as_str()), preferences,
                    &format!("conversacion-{}.md", Uuid::new_v4()),
                )?,
            },
        };
        let target = target.to_str().ok_or_else(|| invalid("La ruta no es Unicode válido."))?;
        let scope = access::resolve_markdown(&self.base, Path::new(target))?;
        let before_md = access::read_file(&scope.root, &scope.relative, MAX_MARKDOWN)?;
        if let Some(bytes) = &before_md {
            if !prior.is_some_and(|record| prior_content["file"] == target && matches_markdown(bytes, record)) {
                return Err(file_conflict());
            }
        }
        content["file"] = json!(target);
        content["markdownBase"] = json!({ "file": target, "version": before_md.as_deref().map(version) });
        let now = timestamp().ok_or_else(|| Fault::new("CLOCK_UNAVAILABLE", "No se pudo leer la hora del sistema."))?;
        let next = prior.and_then(|record| revision(&record["revision"])).unwrap_or(0) + 1;
        if next > MAX_REVISION { return Err(revision_conflict()); }
        let references = match args.get("referencias") {
            Some(value) => self.references(value, &conversation_id)?,
            None => prior.map(|record| record["references"].clone()).unwrap_or_else(|| json!([])),
        };
        let record = json!({
            "format": "mind-continuity-entry", "version": 1, "id": conversation_id, "revision": next,
            "createdAt": prior.and_then(|value| value["createdAt"].as_str()).unwrap_or(&now),
            "updatedAt": prior.and_then(|value| value["updatedAt"].as_str()).unwrap_or(&now).max(&now),
            "source": prior.map(|record| record["source"].clone()).unwrap_or_else(|| json!("Mind nativo")),
            "kind": "conversacion", "content": content, "references": references,
        });

        self.ensure_parent(target, &scope)?;
        let bytes = record.to_string() + "\n";
        let file = record_file(&conversation_id);
        text_write::write_bytes(
            &self.base, &file, bytes.as_bytes(), MAX_RECORD,
            previous.as_ref().map(|(_, hash)| hash.as_str()), || self.confirm(target, &scope),
        ).map_err(filesystem)?;
        if let Err(error) = self.write_markdown(&record, target, &scope, before_md.as_deref()) {
            let mut retry = json!({"id": conversation_id, "revision": next});
            if explicit { retry["solicitado"] = json!(true); }
            return Ok(json!({
                "estado": "pendiente_archivo", "conversacion": conversation(&record),
                "archivo": {"estado": "pendiente", "ruta": target, "codigo": error.code},
                "reintento": retry,
            }));
        }

        Ok(json!({ "estado": if updating { "actualizada" } else { "registrada" },
            "conversacion": conversation(&record) }))
    }

    fn references(&self, value: &Value, own: &str) -> Result<Value, Fault> {
        let refs = value.as_array().filter(|value| value.len() <= 100)
            .ok_or_else(|| invalid("Indica hasta 100 referencias."))?;
        let mut output = Vec::new();
        for value in refs {
            let item = value.as_object().ok_or_else(|| invalid("Cada referencia debe ser un objeto."))?;
            only(item, &["registro", "ubicacion", "relacion"])?;
            let mut mapped = match (item.get("registro"), item.get("ubicacion")) {
                (Some(value), None) => {
                    let id = id(value)?;
                    if id == own { return Err(invalid("Una referencia no puede apuntar al mismo registro.")); }
                    let known = access::read_json(&self.base, &record_file(id))?;
                    let known = known.ok_or_else(|| Fault::new("CONTINUITY_REFERENCE_NOT_FOUND", "No existe la referencia indicada."))?;
                    motor_records::validate_record(&known, id)?;
                    json!({ "entry": id })
                }
                (None, Some(value)) => json!({"locator": label(value, 2048)?}),
                _ => return Err(invalid("Cada referencia indica registro o ubicación.")),
            };
            if let Some(relation) = item.get("relacion") { mapped["relation"] = json!(label(relation, 200)?); }
            if !output.contains(&mapped) { output.push(mapped); }
        }
        Ok(json!(output))
    }

    fn retry(&self, record: &Value) -> Result<Value, Fault> {
        let target = record["content"]["file"].as_str()
            .ok_or_else(|| Fault::new("CONVERSATION_FILE_REQUIRED", "La conversación no tiene un Markdown asignado."))?;
        let scope = access::resolve_markdown(&self.base, Path::new(target))?;
        let current = access::read_file(&scope.root, &scope.relative, MAX_MARKDOWN)?;
        if !current.as_ref().is_some_and(|bytes| matches_markdown(bytes, record)) {
            let baseline = &record["content"]["markdownBase"];
            let expected = if baseline["file"] == target { baseline["version"].as_str() } else { None };
            if current.as_deref().map(version).as_deref() != expected { return Err(file_conflict()); }
            self.ensure_parent(target, &scope)?;
            self.write_markdown(record, target, &scope, current.as_deref())?;
        }
        Ok(json!({ "estado": "archivo_completado", "conversacion": conversation(record) }))
    }

    fn ensure_parent(&self, target: &str, scope: &access::Scope) -> Result<(), Fault> {
        let Some((parent, _)) = scope.relative.rsplit_once('/') else { return Ok(()) };
        let mut parts = String::new();
        for part in parent.split('/') {
            if !parts.is_empty() { parts.push('/'); }
            parts.push_str(part);
            match scan::open_directory(&scope.root, &parts) {
                Ok(_) => continue,
                Err("FILE_NOT_FOUND") => (),
                Err(code) => return Err(filesystem(code)),
            }
            let allowed = || {
                self.confirm(target, scope)?;
                access::resolve_file(&self.base, Some(&scope.id), &parts, &["organizar"])
                    .map(|_| ()).map_err(|error| error.code)
            };
            if let Err(code) = organize::create_directory(&scope.root, &parts, allowed) {
                // Another program may have made the directory after our read.
                if code != "FILE_EXISTS" { return Err(filesystem(code)); }
                scan::open_directory(&scope.root, &parts).map_err(filesystem)?;
            }
        }
        Ok(())
    }

    fn confirm(&self, target: &str, scope: &access::Scope) -> Result<(), &'static str> {
        self.owner.check()?;
        access::check_continuity(&self.base, true).map_err(|error| error.code)?;
        let current = access::resolve_markdown(&self.base, Path::new(target)).map_err(|error| error.code)?;
        if current != *scope { return Err("ACCESS_NOT_GRANTED"); }
        Ok(())
    }

    fn write_markdown(&self, record: &Value, target: &str, scope: &access::Scope, previous: Option<&[u8]>) -> Result<(), Fault> {
        let expected = previous.map(digest);
        text_write::write_bytes(&scope.root, &scope.relative, markdown(record).as_bytes(), MAX_MARKDOWN,
            expected.as_deref(), || self.confirm(target, scope))
            .map(|_| ()).map_err(filesystem)
    }
}

fn only(args: &Map<String, Value>, allowed: &[&str]) -> Result<(), Fault> {
    if args.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(invalid("La llamada incluye argumentos no admitidos."));
    }
    Ok(())
}

fn fold(text: &str) -> String {
    text.nfd().filter(|ch| !is_combining_mark(*ch)).flat_map(char::to_lowercase).collect()
}

fn record_file(id: &str) -> String {
    format!("continuity-{id}.json")
}

fn label(value: &Value, max: usize) -> Result<&str, Fault> {
    value.as_str().filter(|text| !text.is_empty() && text.encode_utf16().count() <= max
        && !text.chars().any(|ch| ch <= '\u{1f}' || ch == '\u{7f}'))
        .ok_or_else(|| invalid("La referencia contiene texto no válido."))
}

fn parse_preferences(value: &Value) -> Result<Value, Fault> {
    let fields = value.as_object().ok_or_else(|| invalid("Preferencias no válidas."))?;
    only(fields, &["modo", "reglas", "carpeta_destino"])?;
    let mode = value["modo"].as_str().filter(|mode| matches!(*mode, "esencial" | "detallado" | "manual" | "personalizado"))
        .ok_or_else(|| invalid("Modo de conservación no válido."))?;
    let rules = fields.get("reglas").map(|value| value.as_str().filter(|text| text.len() <= 4096 && !text.contains('\0'))
        .ok_or_else(|| invalid("Reglas de conservación no válidas."))).transpose()?.unwrap_or("");
    if mode == "personalizado" && rules.trim().is_empty() { return Err(invalid("El modo personalizado requiere reglas.")); }
    let mut preferences = json!({ "mode": mode, "rules": rules });
    if let Some(value) = fields.get("carpeta_destino") {
        let directory = valid_text(value, 4096).filter(|text| Path::new(text).is_absolute())
            .ok_or_else(|| invalid("Indica una carpeta de destino absoluta."))?;
        preferences["directory"] = json!(directory);
    }
    Ok(preferences)
}

fn conversation(record: &Value) -> Value {
    let content = &record["content"];
    let preferences = content.get("preferences").map(|value| {
        let mut result = json!({"modo": value["mode"], "reglas": value["rules"]});
        if let Some(directory) = value.get("directory") { result["carpeta_destino"] = directory.clone(); }
        result
    });
    let references = record["references"].as_array().into_iter().flatten().map(|reference| {
        let mut value = if let Some(entry) = reference.get("entry") {
            json!({"registro": entry})
        } else { json!({"ubicacion": reference["locator"]}) };
        if let Some(relation) = reference.get("relation") { value["relacion"] = relation.clone(); }
        value
    }).collect::<Vec<_>>();
    json!({
        "id": record["id"], "revision": record["revision"], "creado": record["createdAt"],
        "actualizado": record["updatedAt"], "titulo": content["title"], "importante": content["important"],
        "proyecto": content["project"], "agente": content["agent"], "id_externo": content["externalId"],
        "archivo": content["file"], "preferencias": preferences, "referencias": references,
    })
}

async fn respond(
    req: Request<Incoming>, port: u16, token: &str, mcp: &Mcp, motor: Arc<Motor>,
) -> Result<Response<Body>, Infallible> {
    let reply = if !host::allowed_origin(&req, port) {
        host::full(StatusCode::FORBIDDEN, json!({"error": "ORIGIN_NOT_ALLOWED"}))
    } else if req.uri().path() == "/health" && req.method() == Method::GET {
        host::full(StatusCode::OK, json!({"ok":true,"pid":std::process::id(),"port":port}))
    } else if req.uri().path() != "/mcp" {
        host::full(StatusCode::NOT_FOUND, json!({"error": "NOT_FOUND"}))
    } else if !req.headers().get(header::AUTHORIZATION).and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .is_some_and(|value| host::same(value.as_bytes(), token.as_bytes()))
    {
        host::full(StatusCode::UNAUTHORIZED, json!({"error":"UNAUTHORIZED"}))
    } else {
        mcp.handle(req, motor).await
    };
    Ok(reply)
}

pub(crate) async fn run(args: &[String]) -> Result<(), String> {
    if !cfg!(any(windows, target_os = "linux")) {
        return Err("El arranque autónomo requiere escritura segura en Windows o Linux.".into());
    }
    let [flag, root] = args else { return Err("motor --base ABS".into()) };
    if flag != "--base" || !Path::new(root).is_absolute() { return Err("motor --base ABS".into()); }
    let canonical = Path::new(root).canonicalize().map_err(|error| error.to_string())?;
    let base = canonical.to_str().ok_or("La ruta no es Unicode válido.")?;
    #[cfg(windows)]
    let base = base.strip_prefix("\\\\?\\").unwrap_or(base);
    let motor = Arc::new(Motor::open(base.to_owned()).map_err(|error| error.to_string())?);
    let mcp = Arc::new(Mcp::new());
    let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0))).await.map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|error| error.to_string())?.port();
    let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    println!("{}", json!({
        "pid": std::process::id(), "port": port, "url": format!("http://127.0.0.1:{port}/mcp"), "token": token,
    }));
    io::stdout().flush().map_err(|error| error.to_string())?;

    let shutdown = host::shutdown_signal();
    tokio::pin!(shutdown);
    let mut clients = JoinSet::new();
    loop {
        tokio::select! {
            signal = &mut shutdown => {
                signal.map_err(|error| error.to_string())?;
                break;
            }
            Some(_) = clients.join_next(), if !clients.is_empty() => {}
            accepted = listener.accept() => {
                let (stream, _) = accepted.map_err(|error| error.to_string())?;
                let (token, motor, mcp) = (token.clone(), motor.clone(), mcp.clone());
                clients.spawn(async move {
                    let service = hyper::service::service_fn(move |req| {
                        let (token, motor, mcp) = (token.clone(), motor.clone(), mcp.clone());
                        async move { respond(req, port, &token, &mcp, motor).await }
                    });
                    let _ = hyper::server::conn::http1::Builder::new()
                        .serve_connection(TokioIo::new(stream), service).await;
                });
            }
        }
    }
    clients.shutdown().await;
    Ok(())
}
