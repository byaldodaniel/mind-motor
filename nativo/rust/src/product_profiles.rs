//! Conexión local de los clientes MCP con esta instalación.
//!
//! Cada cliente arranca Mind con una entrada stdio propia: el ejecutable nativo de
//! la instalación con `producto mcp`. La entrada no guarda puerto ni credencial: el
//! puente lee el conector de la Base y despierta el Motor cuando hace falta, así que
//! sigue sirviendo tras reiniciar el equipo, cambiar de puerto o actualizar.
//!
//! `preparar` escribe la entrada cuando lo pide el usuario. `sanar` repite la misma
//! revisión en cada arranque y adopta las entradas de Mind que apuntan a esta
//! instalación o a una instalación que ya no existe (copias movidas, Node de 1.0.4,
//! HTTP de 1.0.5 r1). Las entradas ajenas, o de otra copia de Mind que sigue
//! instalada, no se tocan salvo que el usuario prepare esta copia expresamente.
use std::path::{Path, PathBuf};

use hmac::{Hmac, Mac};
use serde_json::{json, Map, Value};
use sha2::Sha256;
use toml_edit::{Array, DocumentMut, Item, Table};
use unicode_normalization::UnicodeNormalization;

use crate::{bridge, host, motor_workspace::same_path, scan, text_write,
    update_package::{executable, fail, fs_error, physical, read, sha, target, Result}};

const START: &str = "<!-- mind-startup:begin -->";
const END: &str = "<!-- mind-startup:end -->";
const MARKER: &str = "X-Mind-Managed";
const TRANSPORT: [&str; 16] = ["type","command","args","url","serverUrl","httpUrl","headers","http_headers",
    "env","env_vars","cwd","bearer_token_env_var","env_http_headers","headersHelper","oauth","authProviderType"];
const ARGS: [&str; 2] = ["producto", "mcp"];
const MAX: usize = 1024 * 1024;

/// `Explicit`: el usuario pidió conectar esta copia. `Heal`: revisión automática en un arranque.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Mode { Explicit, Heal }

/// Qué hacer con la entrada `mind` que ya tiene un cliente.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Claim { Current, Replace, Keep }

struct Settings<'a> { root: &'a str, base: &'a str, program: String, token: Option<String>, mode: Mode }
struct Candidate { client: &'static str, directory: PathBuf, file: &'static str }

fn canonical(value: &str) -> String {
    let value = value.replace('\\', "/");
    let value = value.trim_end_matches('/');
    if cfg!(windows) { value.to_lowercase() } else { value.to_owned() }
}

/// Ejecutable nativo de la instalación `root`.
pub(crate) fn program(root: &str) -> PathBuf {
    executable(&target()).split('/').fold(PathBuf::from(root), |path, part| path.join(part))
}

/// Últimos `count` componentes de `path`, en minúsculas y en orden.
fn tail(path: &Path, count: usize) -> Option<Vec<String>> {
    let mut parts: Vec<String> = path.components().rev().take(count)
        .map(|part| part.as_os_str().to_string_lossy().to_lowercase()).collect();
    if parts.len() != count { return None; }
    parts.reverse();
    Some(parts)
}

/// Instalación nativa a la que pertenece el ejecutable `command`.
fn native_root(command: &str) -> Option<PathBuf> {
    let path = Path::new(command);
    if !path.is_absolute() { return None; }
    let parts = tail(path, 5)?;
    if parts[..3] != ["sistema", "componentes", "nativo"] || !matches!(parts[4].as_str(), "mind-native" | "mind-native.exe") {
        return None;
    }
    path.ancestors().nth(5).map(Path::to_path_buf)
}

/// Instalación con Node (1.0.4 y anteriores) cuyo punto de entrada es `entry`.
fn legacy_root(command: &str, entry: &str) -> Option<PathBuf> {
    let (program, script) = (Path::new(command), Path::new(entry));
    if !program.is_absolute() || !script.is_absolute() { return None; }
    let name = program.file_name()?.to_string_lossy().to_lowercase();
    if !matches!(name.as_str(), "node" | "node.exe") { return None; }
    let parts = tail(script, 3)?;
    let root = match (parts[1].as_str(), parts[2].as_str()) {
        ("sistema", "arranque.cjs") => script.ancestors().nth(2)?,
        ("bin", "mind.js") if parts[0] == "motor" => script.ancestors().nth(3)?,
        _ => return None,
    };
    // El Node de la entrada también debe pertenecer a esa instalación.
    canonical(command).starts_with(&(canonical(&root.to_string_lossy()) + "/")).then(|| root.to_path_buf())
}

impl Settings<'_> {
    fn desired(&self, client: &str) -> Map<String, Value> {
        let mut entry = Map::new();
        if client == "Claude Code" { entry.insert("type".into(), json!("stdio")); }
        entry.insert("command".into(), json!(self.program));
        entry.insert("args".into(), json!(ARGS));
        entry
    }

    fn marker(&self, token: &str, endpoint: &str, client: &str) -> String {
        let mut mac = Hmac::<Sha256>::new_from_slice(token.as_bytes()).expect("HMAC accepts all key lengths");
        mac.update(json!(["mind-http-1.0.5", canonical(self.root), canonical(self.base), client, endpoint]).to_string().as_bytes());
        format!("{:x}", mac.finalize().into_bytes())
    }

    /// Entrada HTTP que escribió la 1.0.5 r1 de esta misma instalación.
    fn owned_http(&self, client: &str, endpoint: &Value, headers: &Value) -> bool {
        let Some(token) = self.token.as_deref() else { return false };
        let Some(url) = endpoint.as_str() else { return false };
        let Some(port) = url.strip_prefix("http://127.0.0.1:").and_then(|text| text.strip_suffix("/mcp"))
            .and_then(|text| text.parse::<u16>().ok()).filter(|port| *port != 0) else { return false };
        url == format!("http://127.0.0.1:{port}/mcp")
            && headers.as_object().is_some_and(|map| map.len() == 2)
            && headers.get("Authorization").and_then(Value::as_str) == Some(format!("Bearer {token}").as_str())
            && headers.get(MARKER).and_then(Value::as_str)
                .is_some_and(|known| host::same(known.as_bytes(), self.marker(token, url, client).as_bytes()))
    }

    /// Una entrada de otra instalación de Mind se adopta si esa instalación ya no
    /// existe o si el usuario pidió preparar esta copia.
    fn adopt(&self, root: &Path, alive: bool) -> Claim {
        let mine = canonical(&root.to_string_lossy()) == canonical(self.root);
        if mine || !alive || self.mode == Mode::Explicit { Claim::Replace } else { Claim::Keep }
    }

    fn claim(&self, client: &str, entry: &Map<String, Value>) -> Claim {
        let transport: Map<String, Value> = entry.iter().filter(|(key, _)| TRANSPORT.contains(&key.as_str()))
            .map(|(key, value)| (key.clone(), value.clone())).collect();
        if transport == self.desired(client) { return Claim::Current; }
        let only = |allowed: &[&str]| transport.keys().all(|key| allowed.contains(&key.as_str()));
        let stdio = transport.get("type").is_none_or(|kind| kind == "stdio");
        let command = transport.get("command").and_then(Value::as_str);
        let args: Option<Vec<&str>> = transport.get("args").and_then(Value::as_array)
            .and_then(|list| list.iter().map(Value::as_str).collect());
        // Entrada stdio nativa (1.0.5 en adelante).
        if only(&["type", "command", "args"]) && stdio && args.as_deref() == Some(&ARGS[..]) {
            if let Some((command, root)) = command.and_then(|command| native_root(command).map(|root| (command, root))) {
                return self.adopt(&root, Path::new(command).is_file());
            }
        }
        // Entrada stdio con Node (1.0.4 y anteriores); Codex la guarda con `[mcp_servers.mind.env]`.
        let quiet = transport.get("env").is_none_or(|env| env == &json!({"NODE_OPTIONS": ""}));
        if only(&["type", "command", "args", "env"]) && stdio && quiet {
            if let (Some(command), Some([script, "mcp"])) = (command, args.as_deref()) {
                if let Some(root) = legacy_root(command, script) {
                    return self.adopt(&root, Path::new(command).is_file() && Path::new(script).is_file());
                }
            }
        }
        // Entrada HTTP de 1.0.5 r1: solo la acredita su marca; sin acreditar, solo la sustituye una preparación expresa.
        let headers = transport.get("headers").or_else(|| transport.get("http_headers"));
        if headers.and_then(|value| value.get(MARKER)).is_some() {
            let endpoint = ["url", "httpUrl", "serverUrl"].iter().find_map(|key| transport.get(*key));
            let verified = endpoint.zip(headers).is_some_and(|(endpoint, headers)| self.owned_http(client, endpoint, headers));
            return if verified || self.mode == Mode::Explicit { Claim::Replace } else { Claim::Keep };
        }
        Claim::Keep
    }
}

/// Prepara las conexiones y las instrucciones de arranque de los clientes detectados.
pub(crate) fn prepare(root: &str, base: &str, mode: Mode) -> Result<Value> {
    let home = std::env::home_dir().filter(|path| path.is_absolute())
        .ok_or_else(|| fail("CLIENT_CONNECTION_UNSAFE", "No se conoce el perfil local."))?;
    let codex = absolute_env("CODEX_HOME").unwrap_or_else(|| home.join(".codex"));
    let gemini = absolute_env("GEMINI_CLI_HOME").unwrap_or_else(|| home.clone()).join(".gemini");
    let options = [
        Candidate {client:"Codex",directory:codex.clone(),file:"config.toml"},
        Candidate {client:"Claude Code",directory:home.clone(),file:".claude.json"},
        Candidate {client:"Gemini CLI",directory:gemini.clone(),file:"settings.json"},
        Candidate {client:"Antigravity",directory:home.join(".gemini/config"),file:"mcp_config.json"},
        Candidate {client:"Antigravity",directory:home.join(".gemini/antigravity"),file:"mcp_config.json"},
    ];
    let token = bridge::regular_json(&Path::new(base).join("conector-secreto.json"))
        .filter(|secret| secret["version"] == 1)
        .and_then(|secret| secret["token"].as_str().filter(|token| token.len() >= 32).map(str::to_owned));
    let settings = Settings { root, base, program: program(root).to_string_lossy().into_owned(), token, mode };
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

/// Revisión automática en cada arranque. Nunca escribe en stdout ni detiene a quien la llama.
pub(crate) fn heal(root: &str, base: &str) {
    if std::env::var("MIND_AGENT_STARTUP").as_deref() == Ok("0") { return; }
    let _ = prepare(root, base, Mode::Heal);
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
        if profile.client == "Codex" { return codex(settings, current); }
        let mut config: Value = if current.trim().is_empty() {json!({})}
            else {serde_json::from_str(current).map_err(|_| unsafe_profile())?};
        let root = config.as_object_mut().ok_or_else(unsafe_profile)?;
        let servers = root.entry("mcpServers").or_insert_with(||json!({})).as_object_mut().ok_or_else(unsafe_profile)?;
        let mut entry = match servers.get("mind") {
            Some(Value::Object(value)) => {
                match settings.claim(profile.client, value) {
                    Claim::Current => return Ok(Some(current.to_owned())),
                    Claim::Keep => return Ok(None),
                    Claim::Replace => value.clone(),
                }
            }
            Some(_) => return Ok(None),
            None => Map::new(),
        };
        entry.retain(|key,_| !TRANSPORT.contains(&key.as_str()));
        entry.extend(settings.desired(profile.client));
        servers.insert("mind".into(),Value::Object(entry));
        Ok(Some(serde_json::to_string_pretty(&config).map_err(|_| unsafe_profile())? + "\n"))
    })
}

fn value_json(value: &toml_edit::Value) -> Value {
    use toml_edit::Value as Toml;
    match value {
        Toml::String(text) => json!(text.value()),
        Toml::Integer(number) => json!(number.value()),
        Toml::Float(number) => json!(number.value()),
        Toml::Boolean(flag) => json!(flag.value()),
        Toml::Datetime(date) => json!(date.value().to_string()),
        Toml::Array(list) => Value::Array(list.iter().map(value_json).collect()),
        Toml::InlineTable(table) => Value::Object(table.iter().map(|(key, value)| (key.to_owned(), value_json(value))).collect()),
    }
}
/// Una entrada de Codex en JSON, con sus subtablas (`[mcp_servers.mind.env]`) incluidas.
fn item_json(item: &Item) -> Value {
    match item {
        Item::Value(value) => value_json(value),
        Item::Table(table) => Value::Object(table.iter().map(|(key, item)| (key.to_owned(), item_json(item))).collect()),
        Item::ArrayOfTables(list) => Value::Array(list.iter()
            .map(|table| Value::Object(table.iter().map(|(key, item)| (key.to_owned(), item_json(item))).collect())).collect()),
        Item::None => Value::Null,
    }
}

fn codex(settings: &Settings<'_>, current: &str) -> Result<Option<String>> {
    let mut document = current.parse::<DocumentMut>().map_err(|_| unsafe_profile())?;
    let mut implicit = Table::new();
    implicit.set_implicit(true);
    let servers = document.as_table_mut().entry("mcp_servers").or_insert(Item::Table(implicit))
        .as_table_mut().ok_or_else(unsafe_profile)?;
    if let Some(item) = servers.get("mind") {
        let Value::Object(entry) = item_json(item) else { return Ok(None); };
        if !item.is_table() { return Ok(None); }
        match settings.claim("Codex", &entry) {
            Claim::Current => return Ok(Some(current.to_owned())),
            Claim::Keep => return Ok(None),
            Claim::Replace => {}
        }
    }
    let entry = servers.entry("mind").or_insert(Item::Table(Table::new())).as_table_mut().ok_or_else(unsafe_profile)?;
    for field in TRANSPORT { entry.remove(field); }
    entry["command"] = toml_edit::value(settings.program.as_str());
    entry["args"] = toml_edit::value(ARGS.iter().copied().collect::<Array>());
    Ok(Some(document.to_string()))
}

fn startup(root: &str, current: &str) -> Result<Option<String>> {
    let root: String = root.nfc().collect();
    let console = Path::new(&root).join("Sistema").join(if cfg!(windows) { "mind.cmd" } else { "mind" });
    let console = console.to_string_lossy();
    let block = format!("{START}
## Mind 1.0.5

Al empezar usa `retomar` con el ID o `estado`. Antes de crear consulta `mind` con `operacion: destinos_consultar`.

`buscar` y `retomar` aceptan `consulta` y `consultas`. Usa `recientes` cuando la búsqueda no encuentre coincidencias. \
Usa `leer`, `crear`, `modificar`, `organizar` y `acceso` en carpetas autorizadas. Guarda con `guardar` y actualiza con `actualizar`. \
`vista` acepta `mantener_abierta`. Para otras operaciones consulta `mind` con `operacion: ayuda` o `mind_cambiar`.

Instalación de Mind: `{root}`. El cliente arranca Mind cuando lo necesita. Si sus herramientas no aparecen, \
ejecuta `{console}` con la orden `preparar` y pide al usuario abrir una conversación nueva; mientras tanto usa \
`{console}` con `herramienta NOMBRE JSON`.
{END}");
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

#[cfg(test)]
mod tests {
    use super::*;

    fn settings<'a>(root: &'a str, base: &'a str, mode: Mode) -> Settings<'a> {
        Settings { root, base, program: program(root).to_string_lossy().into_owned(), token: None, mode }
    }
    fn object(value: Value) -> Map<String, Value> { value.as_object().cloned().unwrap() }

    #[cfg(windows)]
    const ROOT: &str = r"C:\Mind-prueba-inexistente\My Mind";
    #[cfg(not(windows))]
    const ROOT: &str = "/tmp/mind-prueba-inexistente/My Mind";

    #[test]
    fn adopta_la_entrada_node_de_esta_instalacion_tambien_en_codex() {
        let base = Path::new(ROOT).join("Sistema").join("Base");
        let base = base.to_string_lossy();
        let node = Path::new(ROOT).join("Sistema/Componentes/Node/win32-x64/node.exe");
        let script = Path::new(ROOT).join("Sistema/arranque.cjs");
        let current = format!("[mcp_servers.mind]\ncommand = {}\nargs = [{}, \"mcp\"]\n\n[mcp_servers.mind.env]\nNODE_OPTIONS = \"\"\n\n[otro]\nclave = 1\n",
            json!(node.to_string_lossy()), json!(script.to_string_lossy()));
        let settings = settings(ROOT, &base, Mode::Heal);
        let updated = codex(&settings, &current).unwrap().unwrap();
        let document = updated.parse::<DocumentMut>().unwrap();
        let entry = item_json(&document["mcp_servers"]["mind"]);
        assert_eq!(entry, json!({"command": settings.program, "args": ARGS}));
        assert_eq!(document["otro"]["clave"].as_integer(), Some(1));
        assert_eq!(codex(&settings, &updated).unwrap().unwrap(), updated);
    }

    #[test]
    fn respeta_entradas_ajenas_y_copias_vivas_salvo_preparacion_expresa() {
        let base = format!("{ROOT}/Sistema/Base");
        let heal = settings(ROOT, &base, Mode::Heal);
        let foreign = object(json!({"command": "servidor-ficticio", "args": ["mcp"]}));
        assert!(heal.claim("Claude Code", &foreign) == Claim::Keep);
        // Una copia movida o borrada se adopta; otra copia que sigue instalada se respeta.
        let copy = std::env::temp_dir().join(format!("mind-prueba-{}", uuid::Uuid::new_v4().simple()));
        let exe = copy.join("Sistema/Componentes/Nativo/win32-x64/mind-native.exe");
        let other = object(json!({"command": exe.to_string_lossy(), "args": ARGS}));
        assert!(heal.claim("Gemini CLI", &other) == Claim::Replace, "la copia inexistente se adopta");
        std::fs::create_dir_all(exe.parent().unwrap()).unwrap();
        std::fs::write(&exe, b"").unwrap();
        let kept = heal.claim("Gemini CLI", &other);
        let taken = settings(ROOT, &base, Mode::Explicit).claim("Gemini CLI", &other);
        std::fs::remove_dir_all(&copy).unwrap();
        assert!(kept == Claim::Keep, "otra copia viva se respeta");
        assert!(taken == Claim::Replace, "preparar esta copia la sustituye");
        let mine = object(json!({"command": heal.program, "args": ARGS}));
        assert!(heal.claim("Gemini CLI", &mine) == Claim::Current);
        assert!(heal.claim("Claude Code", &mine) == Claim::Replace, "Claude Code necesita type stdio");
        let http = object(json!({"type": "http", "url": "http://127.0.0.1:61886/mcp",
            "headers": {"Authorization": "Bearer x", MARKER: "y"}}));
        assert!(heal.claim("Claude Code", &http) == Claim::Keep, "sin credencial no se acredita");
        let explicit = settings(ROOT, &base, Mode::Explicit);
        assert!(explicit.claim("Claude Code", &http) == Claim::Replace);
        assert!(explicit.claim("Claude Code", &foreign) == Claim::Keep);
    }

    #[test]
    fn el_bloque_de_arranque_no_queda_indentado() {
        let text = startup(ROOT, "Regla local.\n").unwrap().unwrap();
        assert!(text.starts_with("Regla local.\n\n<!-- mind-startup:begin -->"));
        assert!(text.lines().all(|line| !line.starts_with("    ")), "{text}");
        assert!(text.contains("`preparar`"));
        let again = startup(ROOT, &text).unwrap().unwrap();
        assert_eq!(again, text);
    }
}
