use std::{
    convert::Infallible,
    fs,
    io::{self, Write},
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use http_body_util::{BodyExt, Limited};
use hyper::{body::Incoming, header, Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use tokio::{net::TcpListener, sync::Notify, task::JoinSet};
use unicode_normalization::{char::is_combining_mark, UnicodeNormalization};
use uuid::Uuid;

use crate::{
    host::{self, Body},
    motor_connector::Connector,
    motor_consent::{self as consent, AccessRequest, Prepared},
    motor_mcp::Mcp,
    motor_owner::{timestamp, Owner},
    motor_workspace::{physical_directory, relative_parts, with_workspace, Workspace},
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

pub(crate) fn is_id(value: &str) -> bool {
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
    layout: Layout,
}

impl Motor {
    fn validate_marker(marker: &Value) -> Result<String, Fault> {
        let corrupt = || Fault::new("BASE_MARKER_CORRUPT", "La marca de formato de la Base no es válida; no se modifica la Base.");
        if marker["format"] != "mind-base"
            || marker["version"].as_u64().is_none()
            || !marker["createdAt"].as_str().is_some_and(|text| !text.is_empty())
        {
            return Err(corrupt());
        }
        let base_id = marker["baseId"].as_str().filter(|text| is_id(text)).ok_or_else(corrupt)?.to_owned();
        if marker["version"] != 3 {
            return Err(Fault::new("BASE_FORMAT_UNSUPPORTED", "El Motor nativo requiere el formato 3 de la Base."));
        }
        Ok(base_id)
    }

    fn read_marker(base: &str) -> Result<Option<String>, Fault> {
        let marker = match access::read_json(base, "mind-base.json") {
            Ok(value) => value,
            Err(error) if error.code == "RECORD_CORRUPT" => {
                return Err(Fault::new("BASE_MARKER_CORRUPT", "La marca de formato de la Base no es válida; no se modifica la Base."));
            }
            Err(error) => return Err(error),
        };
        marker.as_ref().map(Self::validate_marker).transpose()
    }

    fn open(base: String, layout: Layout, create: bool) -> Result<Self, Fault> {
        if let Some(motor_dir) = layout.motor.as_deref().and_then(physical_directory) {
            let base_path = Path::new(&base);
            let motor_path = Path::new(&motor_dir);
            if relative_parts(motor_path, base_path).is_some() || relative_parts(base_path, motor_path).is_some() {
                return Err(Fault::new("BASE_OVERLAPS_MOTOR", "La Base no puede estar dentro del Motor."));
            }
        }
        if Self::read_marker(&base)?.is_none() && !create {
            return Err(Fault::new("BASE_NOT_FOUND", "Indica una Base preparada por Mind."));
        }
        let owner = Owner::acquire(&base).map_err(|error| {
            Fault::new("BASE_OWNERSHIP", error)
        })?;
        let base_id = match Self::read_marker(&base)? {
            Some(base_id) => base_id,
            None if create => {
                let base_id = Uuid::new_v4().to_string();
                let created_at = timestamp().ok_or_else(|| Fault::new("CLOCK_UNAVAILABLE", "No se pudo leer la hora del sistema."))?;
                let created_by = std::env::var("MIND_MOTOR_NATIVO_VERSION").unwrap_or_else(|_| "1.0.5".into());
                let marker = json!({
                    "format": "mind-base",
                    "version": 3,
                    "baseId": base_id,
                    "createdAt": created_at,
                    "createdBy": created_by,
                });
                let bytes = marker.to_string() + "\n";
                text_write::write_bytes(&base, "mind-base.json", bytes.as_bytes(), MAX_RECORD, None, || owner.check())
                    .map_err(filesystem)?;
                base_id
            }
            None => return Err(Fault::new("BASE_NOT_FOUND", "Indica una Base preparada por Mind.")),
        };
        Ok(Self { base, base_id, owner, work: Mutex::new(()), layout })
    }

    pub(crate) fn workspace(&self, paths: &[String], active: bool) -> Result<Workspace, Fault> {
        Workspace::open(&self.base, self.layout.motor.as_deref(), self.layout.installation.as_deref(),
            self.layout.user_data.as_deref(), paths, active)
    }

    pub(crate) fn prepare_access(&self, args: Value, client: Option<&Value>) -> Result<Prepared, Fault> {
        let mut args = args.as_object().cloned().ok_or_else(|| invalid("Indica argumentos en un objeto."))?;
        if args.remove("accion").is_some_and(|action| action != "solicitar") {
            return Err(invalid("Indica accion solicitar para solicitar acceso."));
        }
        let _work = self.work.lock().map_err(|_| filesystem("MOTOR_UNAVAILABLE"))?;
        self.owner.check().map_err(filesystem)?;
        consent::prepare(consent::Paths {
            base: &self.base,
            motor: self.layout.motor.as_deref(),
            installation: self.layout.installation.as_deref(),
            user_data: self.layout.user_data.as_deref(),
        }, &args, client)
    }

    pub(crate) fn finish_access(
        &self, request: AccessRequest, answer: Option<&Value>, active: impl Fn() -> bool,
    ) -> Result<Value, Fault> {
        let _work = self.work.lock().map_err(|_| filesystem("MOTOR_UNAVAILABLE"))?;
        let confirm = || {
            if !active() { return Err("SESSION_CLOSED"); }
            self.owner.check()
        };
        confirm().map_err(filesystem)?;
        consent::finish(consent::Paths {
            base: &self.base,
            motor: self.layout.motor.as_deref(),
            installation: self.layout.installation.as_deref(),
            user_data: self.layout.user_data.as_deref(),
        }, request, answer, confirm)
    }

    pub(crate) fn prepare_organize(
        &self, args: Value, client: Option<&Value>,
    ) -> Result<motor_files::OrganizePrepared, Fault> {
        let args = args.as_object().ok_or_else(|| invalid("Indica argumentos en un objeto."))?;
        let _work = self.work.lock().map_err(|_| filesystem("MOTOR_UNAVAILABLE"))?;
        self.owner.check().map_err(filesystem)?;
        motor_files::prepare_organize(&self.base, args, client, || self.owner.check())
    }

    pub(crate) fn finish_organize(
        &self, confirmation: motor_files::OrganizeConfirmation,
        decision: motor_files::OrganizeDecision<'_>, active: impl Fn() -> bool,
    ) -> Result<Value, Fault> {
        let _work = self.work.lock().map_err(|_| filesystem("MOTOR_UNAVAILABLE"))?;
        let confirm = || {
            if !active() { return Err("SESSION_CLOSED"); }
            self.owner.check()
        };
        confirm().map_err(filesystem)?;
        motor_files::finish_organize(&self.base, confirmation, decision, confirm)
    }

    pub(crate) fn call(&self, name: &str, args: Value) -> Result<Value, Fault> {
        if name == "acceso" {
            if args["accion"] == "retirar" {
                let mut args = args.as_object().cloned().ok_or_else(|| invalid("Indica argumentos en un objeto."))?;
                args.remove("accion");
                let _work = self.work.lock().map_err(|_| filesystem("MOTOR_UNAVAILABLE"))?;
                self.owner.check().map_err(filesystem)?;
                return consent::retire(&self.base, &args, || self.owner.check());
            }
            return match self.prepare_access(args, None)? {
                Prepared::Authorized(value) => Ok(value),
                Prepared::Request(request) => self.finish_access(request, None, || true),
            };
        }
        let args = args.as_object().ok_or_else(|| invalid("Indica argumentos en un objeto."))?;
        let _work = self.work.lock().map_err(|_| Fault::new("MOTOR_UNAVAILABLE", "El Motor no pudo coordinar la petición."))?;
        self.owner.check().map_err(filesystem)?;
        match name {
            "estado" if args.is_empty() => self.state(),
            "retomar" => self.resume(args),
            "buscar" => self.search(args),
            "guardar" | "actualizar" if args.get("en").and_then(Value::as_str) == Some("continuidad") => {
                access::check_continuity(&self.base, true)?;
                motor_files::recover_move(&self.base, || self.owner.check())?;
                motor_records::call(&self.base, name, args, || self.owner.check())
            }
            "guardar" => self.save(args, false),
            "actualizar" => self.save(args, true),
            "leer" | "crear" | "crear_carpeta" | "modificar" | "editar" | "organizar"
            | "mover" | "renombrar" | "papelera" | "restaurar" | "borrar" | "vaciar_papelera"
            | "explorar" | "eliminados" => motor_files::call(&self.base, name, args, || self.owner.check()),
            _ => Err(Fault::new("UNKNOWN_TOOL", "Herramienta no disponible en el Motor nativo.")),
        }
    }

    fn state(&self) -> Result<Value, Fault> {
        Ok(json!({
            "mind": { "motor": "1.0.5", "base": self.base, "baseId": self.base_id },
            "motor_central": { "pid": std::process::id(), "estado": "active" },
            "continuidad": { "permisos": access::continuity_access(&self.base)? },
            "carpetas": access::folder_status(&self.base)?,
            "solicitudes_pendientes": consent::list_pending(&self.base)?,
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
        motor_files::recover_move(&self.base, || self.owner.check())?;
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
        let target = match args.get("en") {
            None => "archivos",
            Some(value) => value.as_str().ok_or_else(|| invalid("en debe ser texto."))?,
        };
        match target {
            "archivos" => motor_files::search_files(&self.base, args, || self.owner.check()),
            "carpeta" => motor_files::explore_folder(&self.base, args, || self.owner.check()),
            "eliminados" => motor_files::list_removed(&self.base, args, || self.owner.check()),
            "conversaciones" => {
                only(args, &["en", "consulta", "proyecto", "limite"])?;
                access::check_continuity(&self.base, false)?;
                motor_files::recover_move(&self.base, || self.owner.check())?;
                let limit = args.get("limite").map(|limit| limit.as_u64().filter(|limit| (1..=100).contains(limit))
                    .ok_or_else(|| invalid("limite debe estar entre 1 y 100."))).transpose()?.unwrap_or(20);
                let hits = self.hits(args)?;
                let total = hits.len();
                let visible: Vec<_> = hits.into_iter().take(limit as usize).collect();
                access::check_continuity(&self.base, false)?;
                Ok(json!({ "total": total, "mostradas": visible.len(), "conversaciones": visible,
                    "semantica": { "estado":"no_disponible" } }))
            }
            _ => Err(invalid("Indica buscar en archivos, carpeta, eliminados o conversaciones.")),
        }
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
        motor_files::recover_move(&self.base, || self.owner.check())?;
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
            .map(|_| ()).map_err(filesystem)?;
        let _ = motor_files::reconcile_index_by_id(&self.base, &scope.id, || self.owner.check());
        Ok(())
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

#[derive(Default)]
struct Layout {
    motor: Option<PathBuf>,
    installation: Option<PathBuf>,
    user_data: Option<PathBuf>,
}

struct Server {
    port: u16,
    connector: Connector,
    motor: Arc<Motor>,
    mcp: Mcp,
    shutdown: Notify,
}

impl Server {
    async fn respond(&self, req: Request<Incoming>) -> Result<Response<Body>, Infallible> {
        let reply = if req.headers().contains_key(header::ORIGIN) || !host::allowed_origin(&req, self.port) {
            host::full(StatusCode::FORBIDDEN, json!({"error": "ORIGIN_NOT_ALLOWED"}))
        } else if req.uri().path() == "/health" && req.method() == Method::GET {
            host::full(StatusCode::OK, self.connector.health(req.uri().query(), self.mcp.count().await))
        } else if !req.headers().get(header::AUTHORIZATION).and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "))
            .is_some_and(|value| host::same(value.as_bytes(), self.connector.token.as_bytes()))
        {
            host::full(StatusCode::UNAUTHORIZED, json!({"error":"UNAUTHORIZED"}))
        } else if req.uri().path() == "/mcp" {
            self.mcp.handle(req, self.motor.clone()).await
        } else if req.uri().path() == "/rpc" && req.method() == Method::POST {
            self.rpc(req).await
        } else {
            host::full(StatusCode::NOT_FOUND, json!({"error": "NOT_FOUND"}))
        };
        Ok(reply)
    }

    async fn rpc(&self, req: Request<Incoming>) -> Response<Body> {
        let console_ok = req.headers().get("x-mind-consola").and_then(|value| value.to_str().ok())
            .is_some_and(|value| self.connector.console.as_deref()
                .is_some_and(|token| host::same(value.as_bytes(), token.as_bytes())));
        let parsed = match Limited::new(req.into_body(), crate::MAX_MESSAGE).collect().await {
            Ok(body) => serde_json::from_slice::<Value>(&body.to_bytes()).ok(),
            Err(_) => None,
        };
        let Some(payload) = parsed.filter(Value::is_object) else {
            return host::full(StatusCode::BAD_REQUEST, rpc_error(invalid("Petición no válida.")));
        };
        let action = payload["accion"].as_str().unwrap_or_default();
        if action == "consola" && !console_ok {
            return host::full(StatusCode::FORBIDDEN, json!({
                "ok": false,
                "error": {
                    "codigo": "CONSOLE_CREDENTIAL_REQUIRED",
                    "mensaje": "La credencial de un cliente MCP solo permite solicitar permisos. Apruébalos o retíralos desde la consola de Mind."
                }
            }));
        }
        if action == "apagar" {
            if (payload["soloSiInactivo"] == true || payload["soloSiQuieto"] == true) && self.mcp.count().await > 0 {
                return host::full(StatusCode::OK, json!({"ok":true,"busy":true}));
            }
            self.shutdown.notify_one();
            return host::full(StatusCode::OK, json!({"ok":true,"apagando":true}));
        }
        if action == "ping" {
            return host::full(StatusCode::OK, json!({"ok":true,"pid":std::process::id()}));
        }
        let motor = self.motor.clone();
        let result = tokio::task::spawn_blocking(move || motor.rpc_call(&payload)).await;
        match result {
            Ok(Ok(value)) => host::full(StatusCode::OK, value),
            Ok(Err(error)) => host::full(StatusCode::OK, rpc_error(error)),
            Err(_) => host::full(StatusCode::INTERNAL_SERVER_ERROR, rpc_error(filesystem("ERROR_INTERNO"))),
        }
    }
}

fn rpc_error(error: Fault) -> Value {
    json!({"ok":false, "error":{"codigo":error.code,"mensaje":error.message}})
}

impl Motor {
    fn rpc_call(&self, payload: &Value) -> Result<Value, Fault> {
        if payload["accion"].as_str() == Some("consola") {
            let _work = self.work.lock().map_err(|_| filesystem("MOTOR_UNAVAILABLE"))?;
            self.owner.check().map_err(filesystem)?;
            return consent::console(consent::Paths {
                base: &self.base,
                motor: self.layout.motor.as_deref(),
                installation: self.layout.installation.as_deref(),
                user_data: self.layout.user_data.as_deref(),
            }, payload, || self.owner.check());
        }
        let paths = payload["paths"].as_array().into_iter().flatten().take(64)
            .filter_map(Value::as_str).map(str::to_owned).collect::<Vec<_>>();
        let workspace = if !paths.is_empty() {
            self.workspace(&paths, true)?
        } else if let Some(cwd) = payload["cwd"].as_str() {
            let candidate = self.workspace(&[cwd.to_owned()], true)?;
            if candidate.has_roots() { candidate } else { self.workspace(&[], false)? }
        } else {
            self.workspace(&[], false)?
        };
        with_workspace(&workspace, || self.rpc_scoped(payload))
    }

    fn rpc_scoped(&self, payload: &Value) -> Result<Value, Fault> {
        let action = payload["accion"].as_str().unwrap_or_default();
        if action == "inicio" {
            let _work = self.work.lock().map_err(|_| filesystem("MOTOR_UNAVAILABLE"))?;
            self.owner.check().map_err(filesystem)?;
            motor_files::recover_move(&self.base, || self.owner.check())?;
            let state = self.state()?;
            return Ok(json!({"ok":true,"mind":state["mind"],
                "instrucciones":"Consulta las herramientas y permisos de este Motor Rust.",
                "destinos":access::destinations(&self.base, None, None)?}));
        }
        let (name, args) = match action {
            "estado" => ("estado", json!({})),
            "herramienta" => (payload["tool"].as_str().unwrap_or_default(), payload.get("args").cloned().unwrap_or_else(|| json!({}))),
            _ => return Err(invalid("Operación RPC no disponible en el Motor Rust.")),
        };
        let value = match name {
            "conversacion_leer" => self.call("retomar", args).map(|value| json!({"conversacion":value["conversacion"]})),
            "conversacion_guardar" if args.get("id").is_some() => self.call("actualizar", args),
            "conversacion_guardar" => self.call("guardar", args),
            "conversaciones_buscar" => {
                let Some(mut fields) = args.as_object().cloned() else {
                    return Err(invalid("Indica argumentos en un objeto."));
                };
                fields.insert("en".into(), json!("conversaciones"));
                self.call("buscar", Value::Object(fields))
            }
            "continuidad_registrar" => {
                let Some(mut fields) = args.as_object().cloned() else {
                    return Err(invalid("Indica argumentos en un objeto."));
                };
                fields.insert("en".into(), json!("continuidad"));
                self.call("guardar", Value::Object(fields))
            }
            "continuidad_actualizar" => {
                let Some(mut fields) = args.as_object().cloned() else {
                    return Err(invalid("Indica argumentos en un objeto."));
                };
                fields.insert("en".into(), json!("continuidad"));
                self.call("actualizar", Value::Object(fields))
            }
            "solicitar_acceso" => self.call("acceso", args),
            "retirar_acceso" => {
                let Some(mut fields) = args.as_object().cloned() else {
                    return Err(invalid("Indica argumentos en un objeto."));
                };
                if fields.contains_key("accion") {
                    return Err(invalid("La retirada incluye argumentos no admitidos."));
                }
                fields.insert("accion".into(), json!("retirar"));
                self.call("acceso", Value::Object(fields))
            }
            _ => self.call(name, args),
        };
        let (value, is_error) = match value {
            Ok(value) => (value, false),
            Err(error) => (json!({"error":{"codigo":error.code,"mensaje":error.message}}), true),
        };
        Ok(json!({"ok":true,"text":value.to_string(),"value":value,"isError":is_error}))
    }
}

fn write_startup_error(fault: &Fault) {
    let Some(raw) = std::env::var_os("MIND_MOTOR_ERROR_FILE") else { return };
    let candidate = PathBuf::from(&raw);
    if !candidate.is_absolute() { return; }
    let Some(name) = candidate.file_name().and_then(|value| value.to_str()) else { return };
    let Some(id_part) = name.strip_prefix("mind-motor-error-").and_then(|value| value.strip_suffix(".json")) else { return };
    if !is_id(id_part) { return; }
    let Some(parent) = candidate.parent() else { return };
    let Ok(parent_real) = fs::canonicalize(parent) else { return };
    let Ok(temp_real) = fs::canonicalize(std::env::temp_dir()) else { return };
    if parent_real != temp_real { return; }
    let Some(at) = timestamp() else { return };
    let payload = json!({ "code": fault.code, "message": fault.message, "at": at }).to_string() + "\n";
    if let Ok(mut file) = fs::OpenOptions::new().write(true).create_new(true).open(&candidate) {
        let _ = file.write_all(payload.as_bytes());
    }
}

fn boot_args(args: &[String]) -> Result<(PathBuf, bool, Layout), String> {
    let mut layout = Layout::default();
    let mut root = None;
    let mut publish = false;
    let mut args = args.iter();
    while let Some(flag) = args.next() {
        let target = match flag.as_str() {
            "--base" => &mut root,
            "--directorio-motor" => &mut layout.motor,
            "--raiz-instalacion" => &mut layout.installation,
            "--datos-usuario" => &mut layout.user_data,
            "--conector" if !publish => { publish = true; continue; }
            _ => return Err("motor --base ABS [--conector]".into()),
        };
        let value = args.next().map(PathBuf::from).filter(|path| path.is_absolute())
            .ok_or("Indica una ruta absoluta para motor.")?;
        if target.replace(value).is_some() { return Err("Opción repetida al arrancar el motor.".into()); }
    }
    let root = root.ok_or("motor --base ABS")?;
    Ok((root, publish, layout))
}

pub(crate) async fn run(args: &[String]) -> Result<(), String> {
    if !cfg!(any(windows, target_os = "linux")) {
        return Err("El arranque autónomo requiere escritura segura en Windows o Linux.".into());
    }
    let (root, publish, layout) = boot_args(args)?;
    if publish && !root.exists() {
        fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    }
    let canonical = root.canonicalize().map_err(|error| error.to_string())?;
    let base = canonical.to_str().ok_or("La ruta no es Unicode válido.")?;
    #[cfg(windows)]
    let base = base.strip_prefix("\\\\?\\").unwrap_or(base);
    let motor = Arc::new(Motor::open(base.to_owned(), layout, publish).map_err(|error| {
        write_startup_error(&error);
        error.to_string()
    })?);
    let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0))).await.map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|error| error.to_string())?.port();
    let connector = Connector::open(base, port, &motor.owner, publish)?;
    if !publish {
        println!("{}", json!({
            "pid": std::process::id(), "port": port, "url": connector.url(), "token": connector.token,
        }));
        io::stdout().flush().map_err(|error| error.to_string())?;
    }
    let server = Arc::new(Server { port, connector, motor, mcp: Mcp::new(), shutdown: Notify::new() });

    let shutdown = host::shutdown_signal();
    tokio::pin!(shutdown);
    let mut clients = JoinSet::new();
    loop {
        tokio::select! {
            _ = server.shutdown.notified() => break,
            signal = &mut shutdown => {
                signal.map_err(|error| error.to_string())?;
                break;
            }
            Some(_) = clients.join_next(), if !clients.is_empty() => {}
            accepted = listener.accept() => {
                let (stream, _) = accepted.map_err(|error| error.to_string())?;
                let server = server.clone();
                clients.spawn(async move {
                    let service = hyper::service::service_fn(move |req| {
                        let server = server.clone();
                        async move { server.respond(req).await }
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
