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
use serde_json::Value;
use sha2::Sha256;
use tokio::{process::Command, time::timeout};
use uuid::Uuid;

use crate::{
    bridge::{base_id, regular_json},
    views::{MAX_VIEW_BYTES, MAX_VIEW_FILES},
};

const USAGE: &str = "vista abrir --base ABS --proyecto NOMBRE --copia ABS --contenido ABS [--id UUID --version N]\nvista consultar|cerrar --base ABS --id UUID";
const MAX_PATH: usize = 1024;
const MAX_DIRECTORIES: usize = 256;

#[derive(Serialize, PartialEq, Eq)]
struct Git {
    rama: Option<String>,
    revision: Option<String>,
    cambios: bool,
}

#[derive(Serialize)]
struct Asset {
    ruta: String,
    base64: String,
}

#[derive(Serialize)]
struct Publication<'a> {
    proyecto: &'a str,
    copia: String,
    git: Option<Git>,
    archivos: Vec<Asset>,
}

struct Host {
    client: Client,
    port: u16,
    token: String,
}

impl Host {
    fn url(&self, route: &str) -> String {
        format!("http://127.0.0.1:{}{route}", self.port)
    }

    async fn connect(base: &Path) -> Result<Self, String> {
        let identity = base_id(base).ok_or("La Base indicada no está disponible.")?;
        let record = regular_json(&base.join("anfitrion.json"))
            .ok_or("Primero inicia el anfitrión con vistas habilitadas.")?;
        let port = port_in(&record, "port").ok_or("Registro de anfitrión inválido.")?;
        let view_port = port_in(&record, "puertoVistas")
            .filter(|candidate| *candidate != port)
            .ok_or("El anfitrión no tiene las vistas habilitadas.")?;
        let pid = record["pid"]
            .as_u64()
            .filter(|pid| *pid > 0)
            .ok_or("Registro de anfitrión inválido.")?;
        if record["version"].as_u64() != Some(1) || record["baseId"].as_str() != Some(identity.as_str()) {
            return Err("El registro del anfitrión no corresponde a esta Base.".into());
        }
        let secret = regular_json(&base.join("conector-secreto.json"))
            .filter(|secret| secret["version"].as_u64() == Some(1))
            .ok_or("El Motor de esta Base no tiene un conector válido.")?;
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
        let response = host.client.get(host.url(&format!("/health?nonce={nonce}")))
            .timeout(Duration::from_secs(3))
            .send().await.map_err(|_| "El anfitrión local no responde.")?;
        let status = response.status();
        let health = small_json(response).await?;
        if status != StatusCode::OK
            || health["anfitrion"].as_bool() != Some(true)
            || health["baseId"].as_str() != Some(identity.as_str())
            || health["pid"].as_u64() != Some(pid)
            || port_in(&health, "port") != Some(port)
            || !verified_proof(&host.token, &nonce, &identity, port, &health)
        {
            return Err("No se pudo verificar la identidad del anfitrión.".into());
        }
        if let Some(port) = port_in(&health, "puertoVistas") {
            if port != view_port {
                return Err("El puerto de las vistas cambió. Vuelve a intentarlo.".into());
            }
        }
        Ok(host)
    }
}

fn port_in(value: &Value, field: &str) -> Option<u16> {
    let port = u16::try_from(value[field].as_u64()?).ok()?;
    (port != 0).then_some(port)
}

fn verified_proof(token: &str, nonce: &str, base: &str, port: u16, health: &Value) -> bool {
    let Some(hex) = health["proof"].as_str() else { return false };
    if hex.len() != 64 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return false;
    }
    let bytes: Vec<u8> = (0..64)
        .step_by(2)
        .filter_map(|offset| u8::from_str_radix(&hex[offset..offset + 2], 16).ok())
        .collect();
    let mut mac = Hmac::<Sha256>::new_from_slice(token.as_bytes()).expect("HMAC accepts every key size");
    mac.update(format!("mind-host-health-v1\n{nonce}\n{base}\n{port}").as_bytes());
    mac.verify_slice(&bytes).is_ok()
}

async fn small_json(response: reqwest::Response) -> Result<Value, String> {
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

fn is_link(metadata: &Metadata) -> bool {
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

fn path_option(value: Option<&str>) -> Result<PathBuf, String> {
    let path = PathBuf::from(value.ok_or(USAGE)?);
    if !path.is_absolute() || path.components().any(|part| matches!(part, Component::ParentDir)) {
        return Err("Indica una ruta absoluta sin componentes «..».".into());
    }
    Ok(path)
}

fn directory(path: &Path) -> Result<PathBuf, String> {
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
    let mut directories = vec![String::new()];
    let mut found_directories = 1;
    let mut assets = Vec::new();
    let mut remaining = MAX_VIEW_BYTES;
    while let Some(relative) = directories.pop() {
        let dir = root.join(relative.replace('/', std::path::MAIN_SEPARATOR_STR));
        for entry in fs::read_dir(&dir).map_err(|error| format!("{}: {error}", dir.display()))? {
            let entry = entry.map_err(|error| format!("No se pudo enumerar el contenido: {error}"))?;
            let filename = entry.file_name().into_string().map_err(|_| "El contenido debe tener nombres Unicode.")?;
            if !route_name(&filename) {
                return Err(format!("Nombre de archivo o carpeta no admitido: {filename:?}"));
            }
            let relative = if relative.is_empty() { filename } else { format!("{relative}/{filename}") };
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

#[cfg(windows)]
fn open_asset(root: &Path, relative: &str) -> io::Result<File> {
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
fn open_asset(root: &Path, relative: &str) -> io::Result<File> {
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
fn open_asset(_: &Path, _: &str) -> io::Result<File> {
    Err(io::Error::new(io::ErrorKind::Unsupported, "Apertura segura no disponible"))
}

async fn git_info(copy: &Path) -> Result<Option<Git>, String> {
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
    let mut pairs = args.chunks_exact(2);
    for pair in &mut pairs {
        let key = pair[0].as_str();
        if !matches!(key, "--base" | "--id" | "--version" | "--proyecto" | "--copia" | "--contenido")
            || options.insert(key, pair[1].as_str()).is_some()
        {
            return Err(USAGE.into());
        }
    }
    if !pairs.remainder().is_empty() {
        return Err(USAGE.into());
    }
    let base = path_option(options.remove("--base"))?;
    let id = options.remove("--id").map(Uuid::parse_str).transpose()
        .map_err(|_| "Indica un ID válido de vista.")?;
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
        })
    } else if matches!(operation.as_str(), "consultar" | "cerrar")
        && id.is_some() && version.is_none() && options.is_empty()
    {
        None
    } else {
        return Err(USAGE.into());
    };

    let host = Host::connect(&base).await?;
    let route = id.map_or_else(|| "/vistas".to_owned(), |id| format!("/vistas/{id}"));
    let (method, expected) = match operation.as_str() {
        "abrir" if id.is_some() => (Method::PUT, StatusCode::OK),
        "abrir" => (Method::POST, StatusCode::CREATED),
        "consultar" => (Method::GET, StatusCode::OK),
        "cerrar" => (Method::DELETE, StatusCode::NO_CONTENT),
        _ => return Err(USAGE.into()),
    };
    let mut request = host.client.request(method, host.url(&route)).bearer_auth(host.token);
    if let Some(version) = version {
        request = request.header(reqwest::header::IF_MATCH, format!("\"{version}\""));
    }
    if let Some(publish) = publish {
        request = request.json(&publish);
    }
    let response = request.send().await.map_err(|_| "El anfitrión local no respondió a la operación.")?;
    let status = response.status();
    if status == StatusCode::NO_CONTENT && expected == status {
        println!("{}", serde_json::json!({ "id": id.unwrap().to_string(), "cerrada": true }));
        return Ok(());
    }
    let body = small_json(response).await?;
    if status != expected {
        return Err(format!("Mind devolvió {status}: {}", body["error"].as_str().unwrap_or("Error de la vista")));
    }
    println!("{body}");
    Ok(())
}
