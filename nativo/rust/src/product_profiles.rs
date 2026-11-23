//! Local, explicit preparation of HTTP profiles for the installed product.
use std::path::{Path, PathBuf};

use hmac::{Hmac, Mac};
use serde_json::{json, Map, Value};
use sha2::Sha256;
use toml_edit::{DocumentMut, InlineTable, Item, Table};
use unicode_normalization::UnicodeNormalization;

use crate::{host, motor_workspace::same_path, scan, text_write, update_package::{fail, fs_error, physical, read, sha, Result}};

const START: &str = "<!-- mind-startup:begin -->";
const END: &str = "<!-- mind-startup:end -->";
const MARKER: &str = "X-Mind-Managed";
const TRANSPORT: [&str; 16] = ["type","command","args","url","serverUrl","httpUrl","headers","http_headers",
    "env","env_vars","cwd","bearer_token_env_var","env_http_headers","headersHelper","oauth","authProviderType"];
const MAX: usize = 1024 * 1024;

struct Settings<'a> { root: &'a str, base: &'a str, token: &'a str, endpoint: String }
struct Candidate { client: &'static str, directory: PathBuf, file: &'static str, endpoint_key: &'static str }

fn canonical(value: &str) -> String {
    let value = value.replace('\\', "/");
    let value = value.trim_end_matches('/');
    if cfg!(windows) { value.to_lowercase() } else { value.to_owned() }
}
fn legacy_path(value: &Value, expected: &Path) -> bool {
    value.as_str().filter(|name| Path::new(name).is_absolute())
        .is_some_and(|name| canonical(name) == canonical(&expected.to_string_lossy()))
}
impl Settings<'_> {
    fn marker(&self, endpoint: &str, client: &str) -> String {
        let mut mac = Hmac::<Sha256>::new_from_slice(self.token.as_bytes()).expect("HMAC accepts all key lengths");
        mac.update(json!(["mind-http-1.0.5", canonical(self.root), canonical(self.base), client, endpoint]).to_string().as_bytes());
        format!("{:x}", mac.finalize().into_bytes())
    }

    fn headers(&self, client: &str) -> Value {
        json!({"Authorization":format!("Bearer {}",self.token),(MARKER):self.marker(&self.endpoint,client)})
    }

    fn owned_http(&self, client: &str, endpoint: &Value, headers: &Value) -> bool {
        let Some(url) = endpoint.as_str() else { return false };
        let Some(port) = url.strip_prefix("http://127.0.0.1:").and_then(|text| text.strip_suffix("/mcp"))
            .and_then(|text| text.parse::<u16>().ok()).filter(|port| *port != 0) else { return false };
        url == format!("http://127.0.0.1:{port}/mcp")
            && headers.as_object().is_some_and(|map| map.len() == 2)
            && headers["Authorization"] == format!("Bearer {}",self.token)
            && headers[MARKER].as_str().is_some_and(|known| host::same(known.as_bytes(),self.marker(url,client).as_bytes()))
    }

    fn owned_legacy(&self, entry: &Map<String, Value>) -> bool {
        let root = Path::new(&self.root);
        let runtime = root.join("Sistema/Componentes/Node").join(crate::update_package::target())
            .join(if cfg!(windows) { "node.exe" } else { "bin/node" });
        let Some(args) = entry.get("args").and_then(Value::as_array) else { return false };
        args.len() == 2 && args[1] == "mcp" && legacy_path(&args[0], &root.join("Sistema/arranque.cjs"))
            && entry.get("command").is_some_and(|command| legacy_path(command,&runtime))
            && entry.get("type").is_none_or(|kind| kind == "stdio")
            && entry.iter().all(|(key,value)| !TRANSPORT.contains(&key.as_str()) || matches!(key.as_str(),"command"|"args"|"type")
                || (key == "env" && value == &json!({"NODE_OPTIONS":""})))
    }
}

pub(crate) fn prepare(root: &str, base: &str, port: u16, token: &str) -> Result<Value> {
    let home = std::env::home_dir().filter(|path| path.is_absolute())
        .ok_or_else(|| fail("CLIENT_CONNECTION_UNSAFE", "No se conoce el perfil local."))?;
    let codex = absolute_env("CODEX_HOME").unwrap_or_else(|| home.join(".codex"));
    let gemini = absolute_env("GEMINI_CLI_HOME").unwrap_or_else(|| home.clone()).join(".gemini");
    let options = [
        Candidate {client:"Codex",directory:codex.clone(),file:"config.toml",endpoint_key:"url"},
        Candidate {client:"Claude Code",directory:home.clone(),file:".claude.json",endpoint_key:"url"},
        Candidate {client:"Gemini CLI",directory:gemini.clone(),file:"settings.json",endpoint_key:"httpUrl"},
        Candidate {client:"Antigravity",directory:home.join(".gemini/config"),file:"mcp_config.json",endpoint_key:"serverUrl"},
        Candidate {client:"Antigravity",directory:home.join(".gemini/antigravity"),file:"mcp_config.json",endpoint_key:"serverUrl"},
    ];
    let settings = Settings {root,base,token,endpoint:format!("http://127.0.0.1:{port}/mcp")};
    let mut connections = Vec::new();
    for profile in options {
        if profile.client == "Claude Code" && !profile.directory.join(profile.file).exists() && !home.join(".claude").is_dir() { continue; }
        if !profile.directory.exists() { continue; }
        let state = edit_connection(&settings, &profile);
        connections.push(status(profile.client, &profile.directory.join(profile.file), state));
    }
    let mut rules = Vec::new();
    for (name, path, heading) in [
        ("Codex",codex,"AGENTS.md"),("Claude Code",home.join(".claude"),"CLAUDE.md"),
        ("Gemini CLI",gemini,"GEMINI.md"),("Antigravity",home.join(".gemini"),"GEMINI.md"),
    ] {
        if !path.exists() { continue; }
        let heading = if name == "Codex" && path.join("AGENTS.override.md").exists() { "AGENTS.override.md" } else { heading };
        let result = rewrite(&path, heading, |current| startup(root, current));
        rules.push(status(name, &path.join(heading), result));
    }
    let partial = connections.iter().chain(&rules).any(|item| item["estado"] == "pendiente");
    Ok(json!({"estado":if partial {"parcial"} else {"preparado"},"conexiones":connections,"clientes":rules}))
}

fn absolute_env(name: &str) -> Option<PathBuf> {
    std::env::var_os(name).map(PathBuf::from).filter(|path| path.is_absolute())
}
fn status(client: &str, file: &Path, state: Result<&'static str>) -> Value {
    match state {
        Ok(state) => json!({"cliente":client,"archivo":file,"estado":state}),
        Err(error) => json!({"cliente":client,"archivo":file,"estado":"pendiente","codigo":error.code}),
    }
}
fn unsafe_profile() -> crate::motor_native::Fault { fail("CLIENT_CONNECTION_UNSAFE", "El perfil necesita revisión local.") }

fn rewrite(directory: &Path, name: &str, edit: impl FnOnce(&str) -> Result<Option<String>>) -> Result<&'static str> {
    let root = physical(directory)?;
    if !same_path(&root, directory) { return Err(unsafe_profile()); }
    scan::open_directory(&root, "").map_err(|_| unsafe_profile())?;
    let previous = read(&root,name,MAX)?;
    let current = previous.as_deref().map(std::str::from_utf8).transpose().map_err(|_| unsafe_profile())?.unwrap_or_default();
    let Some(new) = edit(current)? else { return Ok("ajena"); };
    if new == current { return Ok("vigente"); }
    let hash = previous.as_ref().map(|data| sha(data));
    text_write::write_bytes(&root,name,new.as_bytes(),MAX,hash.as_deref(),||Ok(()))
        .map_err(|code| fs_error("CLIENT_CONNECTION_CHANGED",code))?;
    Ok(if previous.is_some() { "actualizada" } else { "creada" })
}

fn edit_connection(settings: &Settings<'_>, profile: &Candidate) -> Result<&'static str> {
    rewrite(&profile.directory, profile.file, |current| {
        if profile.client == "Codex" { return codex(settings,current); }
        let mut config: Value = if current.is_empty() {json!({})}
            else {serde_json::from_str(current).map_err(|_| unsafe_profile())?};
        let root = config.as_object_mut().ok_or_else(unsafe_profile)?;
        let servers = root.entry("mcpServers").or_insert_with(||json!({})).as_object_mut().ok_or_else(unsafe_profile)?;
        let mut current_entry = match servers.get("mind") {
            Some(Value::Object(value)) => value.clone(),
            Some(_) => return Ok(None),
            None => Map::new(),
        };
        if servers.contains_key("mind") {
            let plain = current_entry.keys().all(|key| !TRANSPORT.contains(&key.as_str())
                || key == profile.endpoint_key || key == "headers" || (profile.client == "Claude Code" && key == "type"));
            let http = plain && (profile.client != "Claude Code" || current_entry.get("type").is_some_and(|value| value == "http"))
                && settings.owned_http(profile.client,current_entry.get(profile.endpoint_key).unwrap_or(&Value::Null),
                    current_entry.get("headers").unwrap_or(&Value::Null));
            if http && current_entry[profile.endpoint_key] == settings.endpoint { return Ok(Some(current.to_owned())); }
            if !http && !settings.owned_legacy(&current_entry) { return Ok(None); }
        }
        current_entry.retain(|key,_| !TRANSPORT.contains(&key.as_str()));
        current_entry.insert(profile.endpoint_key.into(),json!(settings.endpoint));
        current_entry.insert("headers".into(),settings.headers(profile.client));
        if profile.client == "Claude Code" { current_entry.insert("type".into(),json!("http")); }
        servers.insert("mind".into(),Value::Object(current_entry));
        Ok(Some(serde_json::to_string_pretty(&config).map_err(|_| unsafe_profile())? + "
"))
    })
}

fn codex(settings: &Settings<'_>, current: &str) -> Result<Option<String>> {
    let mut document = current.parse::<DocumentMut>().map_err(|_| unsafe_profile())?;
    let servers = document.as_table_mut().entry("mcp_servers").or_insert(Item::Table(Table::new()))
        .as_table_mut().ok_or_else(unsafe_profile)?;
    if let Some(item) = servers.get("mind") {
        let Some(table) = item.as_table() else { return Ok(None); };
        let value: Map<String, Value> = table.iter().filter_map(|(key, field)| {
            if !TRANSPORT.contains(&key) { return None; }
            let value = if let Some(array) = field.as_array() {
                json!(array.iter().map(|it|it.as_str()).collect::<Vec<_>>())
            } else if let Some(headers) = field.as_inline_table() {
                Value::Object(headers.iter().map(|(k,v)|(k.to_owned(),json!(v.as_str()))).collect())
            } else { json!(field.as_str()) };
            Some((key.to_owned(),value))
        }).collect();
        let http = value.keys().all(|key| matches!(key.as_str(),"url"|"http_headers"))
            && settings.owned_http("Codex",value.get("url").unwrap_or(&Value::Null),value.get("http_headers").unwrap_or(&Value::Null));
        if http && value["url"] == settings.endpoint { return Ok(Some(current.to_owned())); }
        if !http && !settings.owned_legacy(&value) { return Ok(None); }
    }
    let entry = servers.entry("mind").or_insert(Item::Table(Table::new())).as_table_mut().ok_or_else(unsafe_profile)?;
    for field in TRANSPORT { entry.remove(field); }
    entry["url"] = toml_edit::value(&settings.endpoint);
    let mut headers = InlineTable::new();
    headers.insert("Authorization", toml_edit::Value::from(format!("Bearer {}",settings.token)));
    headers.insert(MARKER,toml_edit::Value::from(settings.marker(&settings.endpoint,"Codex")));
    entry["http_headers"] = Item::Value(toml_edit::Value::InlineTable(headers));
    Ok(Some(document.to_string()))
}

fn startup(root: &str, current: &str) -> Result<Option<String>> {
    let block = format!("{START}
## Mind 1.0.5

Al empezar usa `retomar` con el ID o `estado`. Antes de crear consulta `mind` con `operacion: destinos_consultar`.

        `buscar` y `retomar` aceptan `consulta` y `consultas`. Usa `recientes` cuando la búsqueda no encuentre coincidencias.         Usa `leer`, `crear`, `modificar`, `organizar` y `acceso` en carpetas autorizadas. Guarda con `guardar` y actualiza con `actualizar`.         `vista` acepta `mantener_abierta`. Para otras operaciones consulta `mind` con `operacion: ayuda` o `mind_cambiar`.

        Instalación de Mind: {}. Ejecuta el iniciador de esta instalación si el Motor necesita arrancar.
{END}", json!(root.nfc().collect::<String>()));
    match (current.find(START),current.find(END)) {
        (None,None) => Ok(Some(format!("{}{block}
",if current.is_empty(){String::new()}else{current.trim_end_matches('\n').to_owned()+"

"}))),
        (Some(start),Some(end)) if end >= start + START.len() && current.matches(START).count() == 1 && current.matches(END).count() == 1 => {
            Ok(Some(format!("{}{block}{}",&current[..start],&current[end + END.len()..])))
        }
        _ => Err(unsafe_profile()),
    }
}
