//! Publishes an explicitly selected static output directory through the local host.
use std::{
    collections::BTreeMap,
    fs::{self, File, Metadata},
    io::{self, Read},
    path::{Component, Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use base64::{engine::general_purpose::STANDARD, Engine};
use futures_util::StreamExt;
use hmac::{Hmac, Mac};
use reqwest::{Client, Method, StatusCode};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::Sha256;
use tokio::{process::Command, time::timeout};
use uuid::Uuid;

use crate::{
    bridge::{base_id, regular_json},
    build_recipe::{BuildError, Recipe},
    views::{AssetInput, Git as ViewGit, Publication as ViewPublication, MAX_VIEW_BYTES, MAX_VIEW_FILES},
};

const USAGE: &str = "vista abrir --base ABS --proyecto NOMBRE --copia ABS --contenido ABS [--id UUID --version N] [--mantener-abierta | --no-mantener-abierta]\nvista consultar|cerrar --base ABS --id UUID\nvista receta --proyecto NOMBRE --copia ABS --receta ABS\nvista construir --base ABS --proyecto NOMBRE --copia ABS --receta ABS --autorizar SHA256 [--id UUID]";
const MAX_PATH: usize = 1024;
const MAX_DIRECTORIES: usize = 256;

#[derive(Serialize, PartialEq, Eq)]
pub(crate) struct Git {
    rama: Option<String>,
    revision: Option<String>,
    cambios: bool,
}

impl From<Git> for ViewGit {
    fn from(value: Git) -> Self {
        Self { rama: value.rama, revision: value.revision, cambios: value.cambios }
    }
}

#[derive(Serialize)]
pub(crate) struct Asset {
    pub(crate) ruta: String,
    pub(crate) base64: String,
}

impl From<Asset> for AssetInput {
    fn from(value: Asset) -> Self {
        Self { ruta: value.ruta, base64: value.base64 }
    }
}

#[derive(Serialize)]
struct Publication<'a> {
    proyecto: &'a str,
    copia: String,
    git: Option<Git>,
    archivos: Vec<Asset>,
    #[serde(skip_serializing_if = "Option::is_none")]
    mantener_abierta: Option<bool>,
}

struct ViewError {
    status: Option<StatusCode>,
    message: String,
}

pub(crate) struct Host {
    pub(crate) client: Client,
    port: u16,
    token: String,
}

impl Host {
    pub(crate) fn url(&self, route: &str) -> String {
        format!("http://127.0.0.1:{}{route}", self.port)
    }

    pub(crate) async fn connect(base: &Path) -> Result<Self, String> {
        if let Some(record) = regular_json(&base.join("anfitrion.json")) {
            if let Ok(host) = Self::verify(base, &record, true, false).await { return Ok(host); }
        }
        Self::connect_native(base).await
    }

    pub(crate) async fn connect_native(base: &Path) -> Result<Self, String> {
        if let Some(record) = regular_json(&base.join("conector.json")).filter(|record| record["backend"] == "rust") {
            if let Ok(motor) = Self::verify(base, &record, false, false).await { return Ok(motor); }
        }
        let record = regular_json(&base.join(crate::services::MOTOR_SECRET))
            .ok_or("Primero inicia el Motor o anfitrión con vistas habilitadas.")?;
        Self::verify(base, &record, false, true).await
    }

    async fn verify(base: &Path, record: &Value, is_host: bool, private: bool) -> Result<Self, String> {
        let identity = base_id(base).ok_or("La Base indicada no está disponible.")?;
        let port = port_in(&record, "port").ok_or("Registro de conector inválido.")?;
        let view_port = port_in(&record, "puertoVistas")
            .filter(|candidate| *candidate != port)
            .ok_or("El Motor o anfitrión no tiene las vistas habilitadas.")?;
        let pid = record["pid"]
            .as_u64()
            .filter(|pid| *pid > 0)
            .ok_or("Registro de conector inválido.")?;
        if record["version"].as_u64() != Some(1) || (!private && record["baseId"].as_str() != Some(identity.as_str())) {
            return Err("El registro local no corresponde a esta Base.".into());
        }
        let secret = if private {
            record.clone()
        } else {
            regular_json(&base.join("conector-secreto.json"))
                .filter(|secret| secret["version"].as_u64() == Some(1))
                .ok_or("El Motor de esta Base no tiene un conector válido.")?
        };
        let token = secret["token"]
            .as_str()
            .filter(|token| (32..=256).contains(&token.len()))
            .ok_or("El Motor de esta Base no tiene un conector válido.")?
            .to_owned();
        let client = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(12))
            .build()
            .map_err(|_| "No se pudo preparar la conexión local.")?;
        let host = Self { client, port, token };
        let nonce = Uuid::new_v4().simple().to_string();
        let scope = if private { "&alcance=servicios" } else { "" };
        let response = host.client.get(host.url(&format!("/health?nonce={nonce}{scope}")))
            .timeout(Duration::from_secs(3))
            .send().await.map_err(|_| "El Motor o anfitrión local no responde.")?;
        let status = response.status();
        let health = small_json(response).await?;
        let kind_ok = if is_host {
            health["anfitrion"].as_bool() == Some(true)
        } else {
            health["ok"].as_bool() == Some(true) && health["backend"].as_str() == Some("rust")
        };
        let domain = if private { "mind-services-health-v1" }
            else if is_host { "mind-host-health-v1" } else { "mind-health-v1" };
        if status != StatusCode::OK
            || !kind_ok
            || health["baseId"].as_str() != Some(identity.as_str())
            || health["pid"].as_u64() != Some(pid)
            || port_in(&health, "port") != Some(port)
            || !verified_proof(&host.token, domain, &nonce, &identity, port, &health)
        {
            return Err("No se pudo verificar la identidad del servidor local.".into());
        }
        if let Some(port) = port_in(&health, "puertoVistas") {
            if port != view_port {
                return Err("El puerto de las vistas cambió. Vuelve a intentarlo.".into());
            }
        } else if !is_host {
            return Err("El Motor no informó el puerto de vistas.".into());
        }
        Ok(host)
    }

    async fn request(
        &self,
        id: Option<Uuid>,
        method: Method,
        version: Option<u64>,
        publication: Option<&Publication<'_>>,
    ) -> Result<Value, ViewError> {
        let route = id.map_or_else(|| "/vistas".to_owned(), |id| format!("/vistas/{id}"));
        let expected = match method {
            Method::POST => StatusCode::CREATED,
            Method::DELETE => StatusCode::NO_CONTENT,
            _ => StatusCode::OK,
        };
        let mut request = self.client.request(method, self.url(&route)).bearer_auth(&self.token);
        if let Some(version) = version {
            request = request.header(reqwest::header::IF_MATCH, format!("\"{version}\""));
        }
        if let Some(publication) = publication {
            request = request.json(publication);
        }
        let response = request.send().await.map_err(|_| ViewError {
            status: None, message: "El anfitrión local no respondió a la operación.".into(),
        })?;
        let status = response.status();
        if status == expected && status == StatusCode::NO_CONTENT {
            return Ok(json!({"id": id.map(|id| id.to_string()), "cerrada": true}));
        }
        let body = small_json(response).await.map_err(|message| ViewError {
            status: (!status.is_success()).then_some(status), message,
        })?;
        if status != expected {
            return Err(ViewError {
                status: Some(status),
                message: format!("Mind devolvió {status}: {}", body["error"].as_str().unwrap_or("Error de la vista")),
            });
        }
        Ok(body)
    }
}

fn port_in(value: &Value, field: &str) -> Option<u16> {
    let port = u16::try_from(value[field].as_u64()?).ok()?;
    (port != 0).then_some(port)
}

fn verified_proof(token: &str, domain: &str, nonce: &str, base: &str, port: u16, health: &Value) -> bool {
    let Some(hex) = health["proof"].as_str() else { return false };
    if hex.len() != 64 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return false;
    }
    let bytes: Vec<u8> = (0..64)
        .step_by(2)
        .filter_map(|offset| u8::from_str_radix(&hex[offset..offset + 2], 16).ok())
        .collect();
    let mut mac = Hmac::<Sha256>::new_from_slice(token.as_bytes()).expect("HMAC accepts every key size");
    mac.update(format!("{domain}\n{nonce}\n{base}\n{port}").as_bytes());
    mac.verify_slice(&bytes).is_ok()
}

pub(crate) async fn small_json(response: reqwest::Response) -> Result<Value, String> {
    let mut chunks = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = chunks.next().await {
        let chunk = chunk.map_err(|_| "El anfitrión no completó su respuesta.")?;
        if bytes.len() + chunk.len() > 64 * 1024 {
            return Err("La respuesta del anfitrión es demasiado grande.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "El anfitrión respondió con datos inválidos.".into())
}

pub(crate) fn is_link(metadata: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

pub(crate) fn path_option(value: Option<&str>) -> Result<PathBuf, String> {
    let path = PathBuf::from(value.ok_or(USAGE)?);
    if !path.is_absolute() || path.components().any(|part| matches!(part, Component::ParentDir)) {
        return Err("Indica una ruta absoluta sin componentes «..».".into());
    }
    Ok(path)
}

pub(crate) fn directory(path: &Path) -> Result<PathBuf, String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| format!("{}: {error}", path.display()))?;
    if !metadata.is_dir() || is_link(&metadata) {
        return Err(format!("{} debe ser un directorio real.", path.display()));
    }
    path.canonicalize().map_err(|error| format!("{}: {error}", path.display()))
}

fn route_name(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or_default().to_ascii_uppercase();
    !name.starts_with('.')
        && !name.ends_with(['.', ' '])
        && !name.chars().any(|ch| ch.is_control() || "\\/:<>\"|?*".contains(ch))
        && !matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$")
        && !(stem.chars().count() == 4 && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.chars().last().is_some_and(|ch| "123456789¹²³".contains(ch)))
}

fn snapshot(root: &Path) -> Result<Vec<Asset>, String> {
    snapshot_filtered(root, None)
}

pub(crate) fn snapshot_filtered(root: &Path, skip: Option<&dyn Fn(&str) -> bool>) -> Result<Vec<Asset>, String> {
    let mut directories = vec![String::new()];
    let mut found_directories = 1;
    let mut assets = Vec::new();
    let mut remaining = MAX_VIEW_BYTES;
    while let Some(relative) = directories.pop() {
        let dir = root.join(relative.replace('/', std::path::MAIN_SEPARATOR_STR));
        for entry in fs::read_dir(&dir).map_err(|error| format!("{}: {error}", dir.display()))? {
            let entry = entry.map_err(|error| format!("No se pudo enumerar el contenido: {error}"))?;
            let filename = entry.file_name().into_string().map_err(|_| "El contenido debe tener nombres Unicode.")?;
            let child_relative = if relative.is_empty() { filename.clone() } else { format!("{relative}/{filename}") };
            if skip.is_some_and(|pred| pred(&child_relative)) {
                continue;
            }
            if !route_name(&filename) {
                return Err(format!("Nombre de archivo o carpeta no admitido: {filename:?}"));
            }
            let relative = child_relative;
            if relative.len() > MAX_PATH {
                return Err("Una ruta de la vista es demasiado larga.".into());
            }
            let metadata = fs::symlink_metadata(entry.path())
                .map_err(|error| format!("{relative}: {error}"))?;
            if is_link(&metadata) {
                return Err(format!("La vista contiene un enlace o punto de reanálisis: {relative}"));
            }
            if metadata.is_dir() {
                found_directories += 1;
                if found_directories > MAX_DIRECTORIES {
                    return Err("La vista contiene demasiados directorios.".into());
                }
                directories.push(relative);
                continue;
            }
            if !metadata.is_file() {
                return Err(format!("La vista requiere archivos regulares: {relative}"));
            }
            if assets.len() == MAX_VIEW_FILES {
                return Err("La vista contiene demasiados archivos.".into());
            }
            let mut file = open_asset(root, &relative)
                .map_err(|error| format!("No se pudo abrir {relative}: {error}"))?;
            let initial = file.metadata().map_err(|error| format!("{relative}: {error}"))?;
            if !initial.is_file() || is_link(&initial) {
                return Err(format!("La vista requiere archivos regulares: {relative}"));
            }
            if initial.len() > remaining as u64 {
                return Err("Los archivos superan el tamaño admitido para una vista.".into());
            }
            let mut bytes = Vec::new();
            (&mut file).take(remaining as u64 + 1).read_to_end(&mut bytes)
                .map_err(|error| format!("{relative}: {error}"))?;
            let final_state = file.metadata().map_err(|error| format!("{relative}: {error}"))?;
            if bytes.len() > remaining || bytes.len() as u64 != initial.len()
                || final_state.len() != initial.len()
                || final_state.modified().ok() != initial.modified().ok()
            {
                return Err(format!("{relative} cambió durante la lectura. Vuelve a intentarlo."));
            }
            remaining -= bytes.len();
            assets.push(Asset { ruta: relative, base64: STANDARD.encode(bytes) });
        }
    }
    assets.sort_unstable_by(|left, right| left.ruta.cmp(&right.ruta));
    Ok(assets)
}

pub(crate) fn build_publication(
    project: String, copy_id: String, git: Option<Git>, assets: Vec<Asset>, mantener_abierta: Option<bool>,
) -> ViewPublication {
    ViewPublication {
        proyecto: project,
        copia: copy_id,
        git: git.map(Into::into),
        archivos: assets.into_iter().map(Into::into).collect(),
        mantener_abierta,
    }
}

#[cfg(windows)]
pub(crate) fn open_asset(root: &Path, relative: &str) -> io::Result<File> {
    use std::{
        ffi::{c_void, OsString},
        os::windows::{ffi::OsStringExt, fs::OpenOptionsExt, io::AsRawHandle},
    };

    #[link(name = "kernel32")]
    extern "system" {
        fn GetFinalPathNameByHandleW(handle: *mut c_void, path: *mut u16, len: u32, flags: u32) -> u32;
    }

    // Validate the path of the handle we will actually read, including its
    // intermediate directories. Opening the final component never follows reparse points.
    let path = root.join(relative.replace('/', "\\"));
    let file = fs::OpenOptions::new().read(true).share_mode(1).custom_flags(0x00200000).open(&path)?;
    let mut buffer = vec![0u16; 32768];
    let length = unsafe {
        GetFinalPathNameByHandleW(file.as_raw_handle(), buffer.as_mut_ptr(), buffer.len() as u32, 0)
    } as usize;
    if length == 0 {
        return Err(io::Error::last_os_error());
    }
    if length >= buffer.len() || Path::new(&OsString::from_wide(&buffer[..length])) != path {
        return Err(io::Error::new(io::ErrorKind::PermissionDenied, "La ruta efectiva salió de la carpeta seleccionada."));
    }
    Ok(file)
}

#[cfg(unix)]
pub(crate) fn open_asset(root: &Path, relative: &str) -> io::Result<File> {
    use std::{
        ffi::CString,
        os::{fd::{AsRawFd, FromRawFd}, unix::ffi::OsStrExt},
    };

    fn open_at(dir: &File, name: &std::ffi::OsStr, flags: i32) -> io::Result<File> {
        let name = CString::new(name.as_bytes())
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "Componente de ruta inválido"))?;
        let fd = unsafe {
            libc::openat(dir.as_raw_fd(), name.as_ptr(), flags | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(unsafe { File::from_raw_fd(fd) })
    }

    let route = root.join(relative);
    let mut directory = File::open("/")?;
    let mut components = route.iter().skip(1).peekable();
    while let Some(name) = components.next() {
        if components.peek().is_none() {
            return open_at(&directory, name, libc::O_RDONLY | libc::O_NONBLOCK);
        }
        directory = open_at(&directory, name, libc::O_RDONLY | libc::O_DIRECTORY)?;
    }
    Err(io::Error::new(io::ErrorKind::InvalidInput, "Falta el archivo de la vista"))
}

#[cfg(not(any(unix, windows)))]
pub(crate) fn open_asset(_: &Path, _: &str) -> io::Result<File> {
    Err(io::Error::new(io::ErrorKind::Unsupported, "Apertura segura no disponible"))
}

pub(crate) async fn git_info(copy: &Path) -> Result<Option<Git>, String> {
    for ancestor in copy.ancestors() {
        match fs::symlink_metadata(ancestor.join(".git")) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(format!("No se pudo comprobar Git: {error}")),
            Ok(marker) if is_link(&marker) || !(marker.is_dir() || marker.is_file()) => {
                return Err("La referencia .git debe ser un archivo o directorio real.".into());
            }
            Ok(_) if ancestor != copy => {
                return Err("Indica como copia la carpeta raíz de Git.".into());
            }
            Ok(_) => break,
        }
    }
    if !copy.join(".git").exists() {
        return Ok(None);
    }
    let rama = git_value(copy, &["symbolic-ref", "--quiet", "--short", "HEAD"]).await?;
    let revision = git_value(copy, &["rev-parse", "--verify", "--quiet", "HEAD"]).await?;
    if rama.is_none() && revision.is_none() {
        return Err("Git no pudo identificar la rama ni la revisión.".into());
    }
    let status = git_output(copy, &["status", "--porcelain=v1", "-z", "--untracked-files=normal"]).await?;
    if !status.status.success() {
        return Err("Git no pudo comprobar los cambios locales.".into());
    }
    Ok(Some(Git { rama, revision, cambios: !status.stdout.is_empty() }))
}

async fn git_value(copy: &Path, args: &[&str]) -> Result<Option<String>, String> {
    let result = git_output(copy, args).await?;
    if result.status.code() == Some(1) {
        return Ok(None);
    }
    if !result.status.success() {
        return Err("Git no pudo identificar la revisión de la copia.".into());
    }
    let value = String::from_utf8(result.stdout).map_err(|_| "Git devolvió una revisión no válida.")?;
    Ok(Some(value.trim_end_matches(['\r', '\n']).to_owned()))
}

async fn git_output(copy: &Path, args: &[&str]) -> Result<std::process::Output, String> {
    let mut command = Command::new("git");
    command
        .arg("--no-optional-locks")
        .arg("-C")
        .arg(copy)
        .args(["-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false"])
        .args(args)
        .env_remove("GIT_DIR")
        .env_remove("GIT_COMMON_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .env_remove("GIT_CONFIG_PARAMETERS")
        .env_remove("GIT_CONFIG_COUNT")
        .env("GIT_TERMINAL_PROMPT", "0")
        .kill_on_drop(true)
        .stdin(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    timeout(Duration::from_secs(8), command.output()).await
        .map_err(|_| "Git no respondió a tiempo.".to_owned())?
        .map_err(|error| format!("No se pudo ejecutar Git: {error}"))
}

pub(crate) async fn run(args: &[String]) -> Result<(), String> {
    if matches!(args, [help] if help == "--help" || help == "-h") {
        println!("{USAGE}");
        return Ok(());
    }
    let (operation, args) = args.split_first().ok_or(USAGE)?;
    let mut options = BTreeMap::new();
    let mut mantener_abierta = None;
    let mut args = args.iter().map(String::as_str);
    while let Some(key) = args.next() {
        if matches!(key, "--mantener-abierta" | "--no-mantener-abierta") {
            if operation != "abrir" || mantener_abierta.replace(key == "--mantener-abierta").is_some() {
                return Err(USAGE.into());
            }
            continue;
        }
        if !matches!(key, "--base" | "--id" | "--version" | "--proyecto" | "--copia" | "--contenido" | "--receta" | "--autorizar")
            || options.insert(key, args.next().ok_or(USAGE)?).is_some()
        {
            return Err(USAGE.into());
        }
    }
    if matches!(operation.as_str(), "receta" | "construir") {
        return run_recipe(operation, options).await;
    }
    let base = path_option(options.remove("--base"))?;
    let id = view_id(options.remove("--id"))?;
    let version = options.remove("--version").map(str::parse::<u64>).transpose()
        .map_err(|_| "Indica una versión numérica de vista.")?;
    let publish = if operation == "abrir" && id.is_some() == version.is_some() && version != Some(0) {
        let project = options.remove("--proyecto").map(str::trim).filter(|name| !name.is_empty())
            .ok_or("Indica el nombre del proyecto.")?;
        let copy = path_option(options.remove("--copia"))?;
        let output = path_option(options.remove("--contenido"))?;
        if !options.is_empty() {
            return Err(USAGE.into());
        }
        let copy = directory(&copy)?;
        let output = directory(&output)?;
        let relative_output = output.strip_prefix(&copy)
            .map_err(|_| "Indica una carpeta de salida dentro de la copia.")?;
        if relative_output.components().any(|part| part.as_os_str().eq_ignore_ascii_case(".git")) {
            return Err("La carpeta de salida debe quedar fuera de los datos internos de Git.".into());
        }
        let git = git_info(&copy).await?;
        let assets = snapshot(&output)?;
        if git != git_info(&copy).await? {
            return Err("La copia de Git cambió al preparar la vista. Vuelve a intentarlo.".into());
        }
        Some(Publication {
            proyecto: project,
            copia: base_id(&copy).ok_or("No se pudo identificar la copia.")?,
            git,
            archivos: assets,
            mantener_abierta,
        })
    } else if matches!(operation.as_str(), "consultar" | "cerrar")
        && id.is_some() && version.is_none() && options.is_empty()
    {
        None
    } else {
        return Err(USAGE.into());
    };

    let host = Host::connect(&base).await?;
    let method = match operation.as_str() {
        "abrir" if id.is_some() => Method::PUT,
        "abrir" => Method::POST,
        "consultar" => Method::GET,
        "cerrar" => Method::DELETE,
        _ => return Err(USAGE.into()),
    };
    let body = host.request(id, method, version, publish.as_ref()).await.map_err(|error| error.message)?;
    println!("{body}");
    Ok(())
}

pub(crate) fn view_id(value: Option<&str>) -> Result<Option<Uuid>, String> {
    value.map(Uuid::parse_str).transpose().map_err(|_| "Indica un ID válido de vista.".into())
}

async fn run_recipe(operation: &str, mut options: BTreeMap<&str, &str>) -> Result<(), String> {
    let project = options.remove("--proyecto").map(str::trim)
        .filter(|name| !name.is_empty() && name.len() <= 512 && !name.chars().any(char::is_control))
        .ok_or("Indica el nombre del proyecto.")?;
    let copy = directory(&path_option(options.remove("--copia"))?)?;
    let file = path_option(options.remove("--receta"))?;
    let recipe = Recipe::load(project, &copy, &file)?;
    if operation == "receta" {
        if !options.is_empty() {
            return Err(USAGE.into());
        }
        println!("{}", recipe.review());
        return Ok(());
    }

    let base = path_option(options.remove("--base"))?;
    let approved = options.remove("--autorizar").ok_or("Autoriza explícitamente esta receta con --autorizar.")?;
    let id = view_id(options.remove("--id"))?;
    if !options.is_empty() {
        return Err(USAGE.into());
    }
    recipe.authorize(approved)?;
    let copy_id = base_id(&copy).ok_or("No se pudo identificar la copia.")?;
    let git = git_info(&copy).await?;
    let host = Host::connect(&base).await?;
    let previous = if let Some(id) = id {
        let current = host.request(Some(id), Method::GET, None, None).await.map_err(|error| error.message)?;
        if current["proyecto"].as_str() != Some(project) || current["copia"].as_str() != Some(copy_id.as_str()) {
            return Err("La vista pertenece a otro proyecto o copia.".into());
        }
        Some(current["version"].as_u64().ok_or("El anfitrión no devolvió la versión de la vista.")?)
    } else {
        None
    };
    let requested = json!({"proyecto": project, "copia": copy_id, "git": git, "receta": approved});
    let attempted = prepare_build(&recipe, &copy, &git).await;
    let failure = match attempted {
        Ok(assets) => {
            let publication = Publication { proyecto: project, copia: copy_id, git, archivos: assets, mantener_abierta: None };
            let method = if previous.is_some() { Method::PUT } else { Method::POST };
            match host.request(id, method, previous, Some(&publication)).await {
                Ok(served) => {
                    println!("{}", json!({"estado": "publicada", "solicitada": requested, "servida": served}));
                    return Ok(());
                }
                Err(error) => {
                    let estado = match error.status {
                        Some(StatusCode::PRECONDITION_FAILED | StatusCode::NOT_FOUND) if previous.is_some() => "desactualizada",
                        None => "indeterminada",
                        _ => "fallo",
                    };
                    BuildError { estado, motivo: error.message }
                }
            }
        }
        Err(failure) => failure,
    };

    let served = match id {
        Some(id) => host.request(Some(id), Method::GET, None, None).await.unwrap_or(Value::Null),
        None => Value::Null,
    };
    println!("{}", json!({
        "estado": failure.estado, "motivo": failure.motivo, "solicitada": requested, "servida": served,
    }));
    Err(failure.motivo)
}

async fn prepare_build(recipe: &Recipe, copy: &Path, before: &Option<Git>) -> Result<Vec<Asset>, BuildError> {
    let failure = |motivo| BuildError { estado: "fallo", motivo };
    let output = recipe.build(copy).await?;
    let assets = snapshot(output.path()).map_err(failure)?;
    if &git_info(copy).await.map_err(failure)? != before {
        return Err(BuildError {
            estado: "desactualizada",
            motivo: "La copia de Git cambió durante la compilación.".into(),
        });
    }
    Ok(assets)
}
