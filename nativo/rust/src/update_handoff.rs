//! Native update runner. The Base is never part of the transaction.
use std::{
    collections::{BTreeMap, BTreeSet}, fs::{self, File}, io::{self, Write},
    path::{Path, PathBuf}, time::Duration,
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{bridge, motor_native::Fault, motor_owner::{self, Owner}, motor_workspace::same_path,
    organize, scan, text_write, update_package::{self as package, *}};

pub(crate) const STATE: &str = "Sistema/Actualizaciones/estado.json";
pub(crate) const HANDOFF: &str = "Sistema/Actualizaciones/relevo.json";
pub(crate) const DOWNLOADS: &str = "Sistema/Actualizaciones/descargas";
const LEASE: &str = ".mind-arranque.lock";
const GROUPS: [&str; 3] = ["Sistema/Componentes", "Sistema/Programa", "Sistema/Licencias"];

pub(crate) fn handoff(root: &str) -> Result<Option<Value>> {
    read_json(root, HANDOFF)?.map(|record| {
        if record["format"] != "mind-update-handoff" || record["version"] != 1
            || !record["id"].as_str().is_some_and(valid_id) || !record["phase"].is_string()
        { return Err(fail("UPDATE_HANDOFF_INVALID", "El registro de actualización no es verificable.")); }
        Ok(record)
    }).transpose()
}

fn valid_id(value: &str) -> bool { Uuid::parse_str(value).is_ok_and(|id| id.to_string() == value) }
fn pending(record: &Value) -> bool { !matches!(record["phase"].as_str(), Some("completada" | "fallida")) }

pub(crate) fn check_start(root: &str) -> Result<()> {
    if handoff(root)?.is_some_and(|value| matches!(value["phase"].as_str(), Some("aplicando" | "verificando"))) {
        return Err(fail("UPDATE_RECOVERY_REQUIRED", "La actualización está sustituyendo el programa o necesita recuperación."));
    }
    Ok(())
}

pub(crate) fn directory(root: &str, id: &str) -> Result<PathBuf> {
    if !valid_id(id) { return Err(fail("UPDATE_HANDOFF_INVALID", "Identificador de actualización no válido.")); }
    let parent = Path::new(root).parent().ok_or_else(|| fail("UPDATE_PATH_INVALID", "La instalación no tiene una carpeta contenedora."))?;
    Ok(parent.join(format!(".mind-relevo-{id}")))
}

fn record(root: &str, base: &str, offer: &Offer) -> Result<Value> {
    let _lease = InstallationLease::acquire(root)?;
    if handoff(root)?.is_some_and(|value| pending(&value)) {
        return Err(fail("UPDATE_IN_PROGRESS", "Ya hay una actualización pendiente."));
    }
    let base_id = base_marker(base)?;
    let id = Uuid::new_v4().to_string();
    let work = directory(root, &id)?;
    create_private(&work)?;
    let value = json!({
        "format":"mind-update-handoff","version":1,"native":true,"id":id,
        "phase":"iniciando","baseDirectory":base,"baseIdentity":base_id,
        "release":offer.release,"expectedManifestSha256":offer.feed["manifestSha256"],
        "expectedPackageSha256":offer.selected["sha256"],"envelope":offer.envelope,
        "reported":{},"createdAt":iso(now_ms()),"updatedAt":iso(now_ms()),
        "owner":motor_owner::process_record(),
    });
    put(root, HANDOFF, &value)?;
    Ok(value)
}

fn create_private(path: &Path) -> Result<()> {
    let options = fs::DirBuilder::new();
    #[cfg(unix)]
    let options = {
        use std::os::unix::fs::DirBuilderExt;
        let mut options = options;
        options.mode(0o700);
        options
    };
    options.create(path).map_err(|error| fs_error("UPDATE_WRITE_FAILED", error))
}

fn save(root: &str, record: &mut Value, phase: &str) -> Result<()> {
    record["phase"] = json!(phase);
    record["updatedAt"] = iso(now_ms());
    put(root, HANDOFF, record)
}

fn runner_name() -> &'static str { if cfg!(windows) { "relevo.exe" } else { "relevo" } }

pub(crate) fn submit(root: &str, base: &str, offer: &Offer) -> Result<Value> {
    let mut job = record(root, base, offer)?;
    let id = job["id"].as_str().unwrap().to_owned();
    let runner = directory(root, &id)?.join(runner_name());
    let result = (|| -> Result<()> {
        let current = std::env::current_exe().map_err(|error| fs_error("UPDATE_HANDOFF_START_FAILED", error))?;
        fs::copy(current, &runner).map_err(|error| fs_error("UPDATE_HANDOFF_START_FAILED", error))?;
        spawn_background(&runner, &["relevo-actualizacion", root, &id], &[])
            .map_err(|error| fs_error("UPDATE_HANDOFF_START_FAILED", error))?;
        Ok(())
    })();
    if let Err(error) = result {
        job["error"] = json!({"code":error.code,"message":error.message});
        save(root, &mut job, "fallida")?;
        return Err(error);
    }
    Ok(json!({"estado":"programada","id":id,"fase":"iniciando","version":offer.release.mind_version,
        "indicacion":"Mind preparará el paquete firmado y esperará a que sus sesiones estén en quietud."}))
}

#[cfg(unix)]
fn spawn_background(program: &Path, args: &[&str], environment: &[(&str, &str)]) -> io::Result<()> {
    use std::{os::unix::process::CommandExt, process::{Command, Stdio}};

    Command::new(program).args(args).envs(environment.iter().copied()).process_group(0)
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().map(|_| ())
}

#[cfg(windows)]
pub(crate) struct BackgroundChild(std::os::windows::io::OwnedHandle);

#[cfg(windows)]
impl BackgroundChild {
    pub(crate) fn try_wait(&mut self) -> io::Result<Option<std::process::ExitStatus>> {
        use std::os::windows::{io::AsRawHandle, process::ExitStatusExt};
        use windows_sys::Win32::{Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT},
            System::Threading::{GetExitCodeProcess, WaitForSingleObject}};
        let handle = self.0.as_raw_handle();
        match unsafe { WaitForSingleObject(handle, 0) } {
            WAIT_TIMEOUT => Ok(None),
            WAIT_OBJECT_0 => {
                let mut code = 0;
                if unsafe { GetExitCodeProcess(handle, &mut code) } == 0 { return Err(io::Error::last_os_error()); }
                Ok(Some(std::process::ExitStatus::from_raw(code)))
            }
            _ => Err(io::Error::last_os_error()),
        }
    }
}

#[cfg(windows)]
fn spawn_background(program: &Path, args: &[&str], environment: &[(&str, &str)]) -> io::Result<()> {
    spawn_background_child(program, args, environment).map(drop)
}

#[cfg(windows)]
pub(crate) fn spawn_background_child(program: &Path, args: &[&str], environment: &[(&str, &str)]) -> io::Result<BackgroundChild> {
    use std::{env, ffi::{OsStr, OsString}, os::windows::{ffi::OsStrExt, io::{FromRawHandle, OwnedHandle}}, ptr};
    use windows_sys::Win32::{
        Foundation::CloseHandle,
        System::Threading::{CreateProcessW, CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW,
            CREATE_UNICODE_ENVIRONMENT, PROCESS_INFORMATION, STARTUPINFOW},
    };

    fn quote(argument: &OsStr, line: &mut Vec<u16>) {
        const QUOTE: u16 = b'"' as u16;
        const SLASH: u16 = b'\\' as u16;
        line.push(QUOTE);
        let mut slashes = 0;
        for unit in argument.encode_wide() {
            if unit == SLASH {
                slashes += 1;
                continue;
            }
            line.extend(std::iter::repeat_n(SLASH, slashes));
            if unit == QUOTE {
                line.extend(std::iter::repeat_n(SLASH, slashes + 1));
            }
            line.push(unit);
            slashes = 0;
        }
        line.extend(std::iter::repeat_n(SLASH, slashes * 2));
        line.push(QUOTE);
    }

    let executable: Vec<u16> = program.as_os_str().encode_wide().chain([0]).collect();
    let mut line = Vec::new();
    quote(program.as_os_str(), &mut line);
    for arg in args {
        line.push(b' ' as u16);
        quote(OsStr::new(arg), &mut line);
    }
    line.push(0);

    let block = if environment.is_empty() {
        None
    } else {
        let mut entries: Vec<_> = env::vars_os()
            .filter(|(key, _)| !environment.iter().any(|(name, _)| key.eq_ignore_ascii_case(OsStr::new(name))))
            .collect();
        entries.extend(environment.iter().map(|(name, value)| (OsString::from(*name), OsString::from(*value))));
        entries.sort_unstable_by_key(|(name, _)| name.to_ascii_uppercase());
        let mut block = Vec::new();
        for (key, value) in entries {
            block.extend(key.encode_wide().chain([b'=' as u16]).chain(value.encode_wide()).chain([0]));
        }
        block.push(0);
        Some(block)
    };
    let env_ptr = block.as_ref().map_or(ptr::null(), |vars| vars.as_ptr().cast());
    let startup = STARTUPINFOW { cb: std::mem::size_of::<STARTUPINFOW>() as u32, ..Default::default() };
    let mut process = PROCESS_INFORMATION::default();
    // Null standard streams alone do not prevent inheritable caller pipes from remaining open.
    let created = unsafe {
        CreateProcessW(executable.as_ptr(), line.as_mut_ptr(), ptr::null(), ptr::null(), 0,
            CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP | CREATE_UNICODE_ENVIRONMENT, env_ptr,
            ptr::null(), &startup, &mut process)
    };
    if created == 0 {
        return Err(io::Error::last_os_error());
    }
    unsafe {
        CloseHandle(process.hThread);
        Ok(BackgroundChild(OwnedHandle::from_raw_handle(process.hProcess)))
    }
}

pub(crate) fn loopback() -> Result<reqwest::Client> {
    reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(5)).build().map_err(|error| fs_error("UPDATE_CONNECTION_FAILED", error))
}
pub(crate) async fn rpc(client: &reqwest::Client, connection: &bridge::Connector, value: &Value) -> Result<Value> {
    let mut request = client.post(format!("http://127.0.0.1:{}/rpc", connection.port)).bearer_auth(&connection.token);
    // Capturar archivos o leer una unidad sincronizada puede tardar más que una consulta de quietud.
    let connection_error = if value["accion"] == "herramienta" {
        request = request.timeout(Duration::from_secs(600));
        "MOTOR_UNAVAILABLE"
    } else {
        "UPDATE_CONNECTION_FAILED"
    };
    let reply = request.json(value).send().await.and_then(reqwest::Response::error_for_status)
        .map_err(|error| fs_error(connection_error, error))?;
    let body = bounded(reply, 16 * 1024 * 1024).await?;
    serde_json::from_slice(&body).map_err(|error| fs_error(connection_error, error))
}

pub(crate) fn internet(timeout: Duration) -> Result<reqwest::Client> {
    let redirects = reqwest::redirect::Policy::custom(|attempt| {
        let url = attempt.url();
        if attempt.previous().len() < 5 && url.scheme() == "https" && url.username().is_empty()
            && url.password().is_none() && url.port().is_none()
            && matches!(url.host_str(), Some("github.com" | "release-assets.githubusercontent.com" | "objects.githubusercontent.com"))
        { attempt.follow() } else { attempt.stop() }
    });
    reqwest::Client::builder().https_only(true).redirect(redirects).no_proxy()
        .user_agent("Mind-updater").connect_timeout(Duration::from_secs(5)).timeout(timeout)
        .build().map_err(|error| fs_error("UPDATE_CONNECTION_FAILED", error))
}

pub(crate) async fn bounded(mut response: reqwest::Response, limit: usize) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    while let Some(part) = response.chunk().await.map_err(|error| fs_error("UPDATE_CONNECTION_FAILED", error))? {
        if bytes.len().saturating_add(part.len()) > limit {
            return Err(fail("UPDATE_PACKAGE_ALTERED", "La descarga supera el límite admitido."));
        }
        bytes.extend(part);
    }
    Ok(bytes)
}

async fn get_zip(root: &str, channel: &Channel, offer: &Offer, work: &Path) -> Result<File> {
    let cache = format!("{DOWNLOADS}/{}.zip", offer.selected["sha256"].as_str().unwrap());
    match scan::open_reader_without_writers(root, &cache) {
        Ok(file) => return Ok(file),
        Err("FILE_NOT_FOUND") => {}
        Err(code) => return Err(fs_error("UPDATE_PATH_LINK", code)),
    }
    let file = work.join("paquete.zip");
    let mut destination = fs::OpenOptions::new().write(true).create_new(true).open(&file)
        .map_err(|error| fs_error("UPDATE_WRITE_FAILED", error))?;
    let url = channel.address(offer.selected["url"].as_str().unwrap())?;
    let mut response = internet(Duration::from_secs(180))?.get(url).send().await
        .and_then(reqwest::Response::error_for_status).map_err(|error| fs_error("UPDATE_CONNECTION_FAILED", error))?;
    let expected = offer.selected["bytes"].as_u64().unwrap();
    let mut size = 0u64;
    while let Some(bytes) = response.chunk().await.map_err(|error| fs_error("UPDATE_CONNECTION_FAILED", error))? {
        size = size.saturating_add(bytes.len() as u64);
        if size > expected { return Err(fail("UPDATE_PACKAGE_ALTERED", "La descarga excedió el tamaño firmado.")); }
        destination.write_all(&bytes).map_err(|error| fs_error("UPDATE_WRITE_FAILED", error))?;
    }
    destination.sync_all().map_err(|error| fs_error("UPDATE_WRITE_FAILED", error))?;
    drop(destination);
    scan::open_reader_without_writers(&physical(work)?, "paquete.zip").map_err(|code| fs_error("UPDATE_PATH_LINK", code))
}

struct InstallationLease<'a> { root: &'a str, token: String }
impl<'a> InstallationLease<'a> {
    fn acquire(root: &'a str) -> Result<Self> {
        if Path::new(root).join(format!("{LEASE}.recovery")).symlink_metadata().is_ok() { return Err(busy()); }
        let owner = motor_owner::process_record().ok_or_else(busy)?;
        let token = owner["token"].as_str().unwrap().to_owned();
        let bytes = owner.to_string() + "
";
        text_write::write_bytes(root, LEASE, bytes.as_bytes(), MAX_DOCUMENT, None, || Ok(()))
            .map_err(|code| if code == "FILE_EXISTS" { busy() } else { fs_error("INSTALLATION_BUSY", code) })?;
        Ok(Self { root, token })
    }
}
impl Drop for InstallationLease<'_> {
    fn drop(&mut self) {
        if read_json(self.root, LEASE).ok().flatten().is_some_and(|owner| owner["token"] == self.token) {
            let _ = fs::remove_file(Path::new(self.root).join(LEASE));
        }
    }
}

fn busy() -> Fault { fail("INSTALLATION_BUSY", "La instalación tiene actividad o un propietario no verificable.") }

fn check_sessions(root: &str, relative: &str) -> Result<()> {
    let (entries, complete) = match scan::scan_directory(root, relative, 1024) {
        Ok(result) => result,
        Err(_) if absent(&Path::new(root).join(relative))? => return Ok(()),
        Err(_) => return Err(busy()),
    };
    if !complete { return Err(busy()); }
    for entry in entries {
        let name = entry["name"].as_str().unwrap_or_default();
        if name.starts_with("sesion-") && name.ends_with(".json") {
            let value = read_json(root, &format!("{relative}/{name}"))?.ok_or_else(busy)?;
            if value["format"] != "mind-session" || !motor_owner::known_stale(&value) { return Err(busy()); }
        }
    }
    Ok(())
}

async fn quiet<'a>(root: &'a str, base: &str) -> Result<(InstallationLease<'a>, Owner)> {
    let client = loopback()?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30 * 60);
    loop {
        if tokio::time::Instant::now() > deadline {
            return Err(fail("MIND_IN_USE", "Mind no alcanzó la quietud para completar el relevo."));
        }
        if let Some(connection) = bridge::healthy(Path::new(base), &client).await {
            let state = rpc(&client, &connection, &json!({"accion":"quietud"})).await?;
            if state["quieto"] != true {
                tokio::time::sleep(Duration::from_millis(250)).await;
                continue;
            }
            let stopped = rpc(&client, &connection, &json!({"accion":"apagar","soloSiQuieto":true,
                "soloSiInactivo":true,"motivo":"actualizacion"})).await?;
            if stopped["ok"] != true {
                tokio::time::sleep(Duration::from_millis(250)).await;
                continue;
            }
        }
        match InstallationLease::acquire(root) {
            Ok(lease) => {
                if let Ok(owner) = Owner::acquire(base) {
                    if check_sessions(base, "sesiones").is_ok() && check_sessions(root, "Sistema/Estado/sesiones").is_ok() {
                        return Ok((lease, owner));
                    }
                }
            }
            Err(error) if error.code == "INSTALLATION_BUSY" => {}
            Err(error) => return Err(error),
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

pub(crate) fn base_marker(base: &str) -> Result<String> {
    let marker = read_json(base, "mind-base.json")?.ok_or_else(|| fail("UPDATE_BASE_UNKNOWN", "Falta la identidad de la Base."))?;
    if marker["format"] != "mind-base" || marker["version"] != 3 {
        return Err(fail("UPDATE_BASE_UNKNOWN", "El relevo requiere una Base de formato 3."));
    }
    marker["baseId"].as_str().filter(|id| valid_id(id)).map(str::to_owned)
        .ok_or_else(|| fail("UPDATE_BASE_UNKNOWN", "El identificador de la Base no es válido."))
}

fn absent(path: &Path) -> Result<bool> {
    match path.symlink_metadata() {
        Ok(_) => Ok(false),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(true),
        Err(error) => Err(fs_error("UPDATE_PATH_LINK", error)),
    }
}

fn declared(value: &Value) -> Result<BTreeMap<String, String>> {
    let files: BTreeMap<String, String> = serde_json::from_value(value["files"].clone())
        .map_err(|error| fs_error("UPDATE_MANIFEST_ALTERED", error))?;
    if files.len() > 5500 || files.iter().any(|(path, value)| !managed(path) || !hash(value)) {
        return Err(fail("UPDATE_MANIFEST_ALTERED", "La instalación contiene rutas administradas inválidas."));
    }
    Ok(files)
}

fn group(path: &str) -> &str {
    GROUPS.into_iter().find(|group| path.strip_prefix(group).is_some_and(|tail| tail.starts_with('/'))).unwrap_or(path)
}

fn attest_group(root: &str, name: &str, old: &BTreeMap<String, String>, depth: usize) -> Result<()> {
    if depth > 20 { return Err(fail("UPDATE_UNMANAGED_CONTENT", "Una carpeta del programa excede la profundidad permitida.")); }
    let (entries, complete) = scan::scan_directory(root, name, 5500).map_err(|code| fs_error("UPDATE_PATH_LINK", code.0))?;
    if !complete { return Err(fail("UPDATE_UNMANAGED_CONTENT", "La carpeta del programa supera el límite de entradas.")); }
    for entry in entries {
        let item = entry["name"].as_str().filter(|name| scan::reader_component(name)).ok_or_else(busy)?;
        let relative = format!("{name}/{item}");
        match entry["type"].as_str() {
            Some("directory") => attest_group(root, &relative, old, depth + 1)?,
            Some("file") if old.contains_key(&relative) => {}
            Some("file") if name.ends_with("/__pycache__") && item.ends_with(".pyc") => {}
            _ => return Err(fail("UPDATE_UNMANAGED_CONTENT", format!("Hay un archivo o enlace ajeno en {relative}."))),
        }
    }
    Ok(())
}

#[derive(Clone, Serialize, Deserialize)]
struct Step { name: String, old: bool }
fn move_path(parent: &str, from: &str, to: &str) -> Result<()> {
    if let Some((directory, _)) = to.rsplit_once('/') { ensure(parent, directory)?; }
    organize::move_entry(parent, from, to, None, |_| Ok(())).map(|_| ())
        .map_err(|code| fs_error("UPDATE_TRANSACTION_FAILED", code))
}
fn component(path: &Path) -> Result<&str> {
    path.file_name().and_then(|name| name.to_str()).filter(|name| scan::reader_component(name))
        .ok_or_else(|| fail("UPDATE_PATH_INVALID", "El nombre de la instalación no es válido."))
}

fn plan(root: &str, incoming: &Package, current: &Value) -> Result<Vec<Step>> {
    let old = declared(current)?;
    let old_names = old.keys().map(|path| group(path)).chain([MANIFEST, DESCRIPTOR]).collect::<BTreeSet<_>>();
    let new_names = incoming.files.keys().map(|path| group(path)).collect::<BTreeSet<_>>();
    let mut result = Vec::new();
    for name in old_names.union(&new_names).copied() {
        let exists = !absent(&Path::new(root).join(name))?;
        if exists && !old_names.contains(name) {
            return Err(fail("UPDATE_UNMANAGED_CONTENT", format!("La instalación ya contiene {name} sin una huella administrada.")));
        }
        if exists {
            if GROUPS.contains(&name) {
                attest_group(root, name, &old, 0)?;
            } else {
                let mut file = scan::open_reader_without_writers(root, name).map_err(|code| fs_error("UPDATE_PATH_LINK", code))?;
                if let Some(expected) = old.get(name) {
                    if file_hash(&mut file, MAX_PACKAGE)?.0 != *expected {
                        // Old global client rules and user-edited readme stay exactly as they are.
                        if matches!(name, "AGENTS.md" | "CLAUDE.md" | "GEMINI.md" | "LEEME.md") && !new_names.contains(name) {
                            continue;
                        }
                        return Err(fail("UPDATE_UNMANAGED_CONTENT", format!("El archivo administrado {name} cambió.")));
                    }
                }
            }
            result.push(Step { name: name.to_owned(), old: true });
        }
        if new_names.contains(name) { result.push(Step { name: name.to_owned(), old: false }); }
    }
    Ok(result)
}

fn paths(root: &str, work: &Path, step: &Step) -> Result<(String, String, String)> {
    if !managed(&step.name) { return Err(fail("UPDATE_HANDOFF_INVALID", "El diario contiene una ruta insegura.")); }
    let installation = Path::new(root);
    let parent = physical(installation.parent().ok_or_else(busy)?)?;
    let (from, to) = if step.old {
        (format!("{}/{}", component(installation)?, step.name), format!("{}/anterior/{}", component(work)?, step.name))
    } else {
        (format!("{}/entrante/{}", component(work)?, step.name), format!("{}/{}", component(installation)?, step.name))
    };
    Ok((parent, from, to))
}
fn reverse(root: &str, work: &Path, steps: &[Step]) -> Result<()> {
    for step in steps.iter().rev() {
        let (parent, from, to) = paths(root, work, step)?;
        if absent(&Path::new(&parent).join(&from))? {
            if absent(&Path::new(&parent).join(&to))? { return Err(fail("UPDATE_RECOVERY_REQUIRED", "Faltan los dos lados de un movimiento del diario.")); }
            move_path(&parent, &to, &from)?;
        }
    }
    Ok(())
}

async fn verify_running_binary(root: &str, base: &str, expected_base: &str, expected_manifest: &str) -> Result<Value> {
    let executable = Path::new(root).join(package::executable(&target()));
    let checked = tokio::time::timeout(Duration::from_secs(15),
        tokio::process::Command::new(&executable).kill_on_drop(true)
            .args(["verificar-instalacion", root, base, expected_base, expected_manifest]).output()).await
        .map_err(|_| fail("UPDATE_VERIFY_FAILED", "La verificación con el Motor nuevo no terminó."))?
        .map_err(|error| fs_error("UPDATE_VERIFY_FAILED", error))?;
    if !checked.status.success() { return Err(fail("UPDATE_VERIFY_FAILED", "El Motor nuevo rechazó la instalación o la Base.")); }
    let answer: Value = serde_json::from_slice(&checked.stdout).map_err(|error| fs_error("UPDATE_VERIFY_FAILED", error))?;
    if answer["baseId"] != expected_base || answer["manifestSha256"] != expected_manifest || answer["runtime"] != "rust" {
        return Err(fail("UPDATE_VERIFY_FAILED", "El Motor nuevo no acreditó la Base y la entrega esperadas."));
    }
    Ok(answer)
}

pub(crate) fn verify_installation(args: &[String]) -> Result<Value> {
    let [root, base, expected_base, expected_manifest] = args else { return Err(busy()); };
    let root = physical(Path::new(root))?;
    let base = physical(Path::new(base))?;
    let bytes = read(&root, MANIFEST, MAX_DOCUMENT)?.ok_or_else(busy)?;
    let manifest = installed(&root)?;
    if manifest["runtime"] != "rust" || manifest["baseFormatVersion"] != 3 || sha(&bytes) != *expected_manifest
        || base_marker(&base)? != *expected_base
    { return Err(fail("UPDATE_VERIFY_FAILED", "No coinciden el programa, la Base o el manifiesto firmado.")); }
    let _ = crate::motor_permissions::registered_folders(&base)?;
    let _ = crate::motor_permissions::persisted_continuity_policy(&base)?;
    Ok(json!({"runtime":"rust","baseId":expected_base,"manifestSha256":expected_manifest,"version":manifest["mindVersion"]}))
}

pub(crate) async fn run_worker(root: &str, id: &str, source: Option<File>, restart: bool) -> Result<Value> {
    let root = physical(Path::new(root))?;
    let work = directory(&root, id)?;
    let work_root = physical(&work)?;
    if !same_path(&work_root, &work) { return Err(fail("UPDATE_PATH_LINK", "El directorio de relevo cambió.")); }
    let mut job = handoff(&root)?.filter(|job| job["id"] == id && job["phase"] == "iniciando" && job["native"] == true)
        .ok_or_else(|| fail("UPDATE_HANDOFF_INVALID", "No se encontró un relevo nativo listo para empezar."))?;
    job["owner"] = json!(motor_owner::process_record());
    save(&root, &mut job, "descargando")?;
    let base = job["baseDirectory"].as_str().unwrap_or_default().to_owned();
    let step_result = apply(&root, &base, &work, &mut job, source).await;
    if let Err(error) = step_result {
        job["error"] = json!({"code":error.code,"message":error.message});
        if error.code != "UPDATE_RECOVERY_REQUIRED" { save(&root, &mut job, "fallida")?; }
        else { put(&root, HANDOFF, &job)?; }
        return Err(error);
    }
    crate::product_profiles::heal(&root, &base);
    if restart { let _ = start_program(&root, &base); }
    Ok(job)
}

async fn apply(root: &str, base: &str, work: &Path, job: &mut Value, source: Option<File>) -> Result<()> {
    let current = installed(root)?;
    let channel = Channel::load(root)?;
    let offer = Offer::verify(&channel, &job["envelope"])?;
    if !offer.release.newer_than(&Release::read(&current)?)
        || offer.identity()["manifestSha256"] != job["expectedManifestSha256"]
        || offer.selected["sha256"] != job["expectedPackageSha256"]
        || offer.identity()["release"] != job["release"] || base_marker(base)? != job["baseIdentity"]
    { return Err(fail("UPDATE_CANDIDATE_CHANGED", "Cambió la Base o la entrega autorizada.")); }
    let source = match source { Some(file) => file, None => get_zip(root, &channel, &offer, work).await? };
    save(root, job, "preparando")?;
    let stage = work.join("entrante");
    create_private(&stage)?;
    let package = unpack(source, &offer, &channel, &physical(&stage)?)?;
    save(root, job, "espera-quietud")?;
    let (_lease, _owner) = quiet(root, base).await?;
    if base_marker(base)? != job["baseIdentity"] || installed(root)? != current {
        return Err(fail("UPDATE_CANDIDATE_CHANGED", "La instalación o la Base cambió mientras esperaba quietud."));
    }
    let steps = plan(root, &package, &current)?;
    let work_root = physical(work)?;
    put(&work_root, "diario.json", &json!({"version":1,"id":job["id"],"steps":steps}))?;
    save(root, job, "aplicando")?;
    let transaction = async {
        for step in &steps {
            let (parent, from, to) = paths(root, work, step)?;
            move_path(&parent, &from, &to)?;
        }
        save(root, job, "verificando")?;
        for (file, expected) in &package.files {
            let mut opened = scan::open_reader_without_writers(root, file).map_err(|code| fs_error("UPDATE_VERIFY_FAILED", code))?;
            if file_hash(&mut opened, MAX_PACKAGE)?.0 != *expected {
                return Err(fail("UPDATE_MANIFEST_ALTERED", "Un archivo publicado no coincide con el manifiesto firmado."));
            }
        }
        if installed(root)? != package.manifest {
            return Err(fail("UPDATE_MANIFEST_ALTERED", "Cambió el manifiesto publicado."));
        }
        job["verification"] = verify_running_binary(root, base, job["baseIdentity"].as_str().unwrap(),
            offer.feed["manifestSha256"].as_str().unwrap()).await?;
        job["result"] = json!({"status":"actualizada","baseDirectory":base,"respaldo":work.join("anterior")});
        job["finishedAt"] = iso(now_ms());
        job["error"] = Value::Null;
        save(root, job, "completada")
    }.await;
    if let Err(error) = transaction {
        reverse(root, work, &steps).map_err(|_| fail("UPDATE_RECOVERY_REQUIRED", "Se conserva el diario para deshacer el cambio parcial."))?;
        return Err(error);
    }
    Ok(())
}

pub(crate) fn start_program(root: &str, base: &str) -> Result<()> {
    let program = Path::new(root).join(package::executable(&target()));
    let release = Release::read(&installed(root)?)?;
    let revision = release.package_revision.to_string();
    spawn_background(&program, &["motor", "--base", base, "--conector", "--raiz-instalacion", root],
        &[("MIND_MOTOR_NATIVO_VERSION", &release.mind_version), ("MIND_MOTOR_NATIVO_REVISION", &revision)])
        .map_err(|error| fs_error("UPDATE_START_FAILED", error))
}

pub(crate) async fn offline(args: &[String]) -> Result<Value> {
    let [root, base, feed, zip, consent] = args else {
        return Err(fail("INVALID_ARGUMENTS", "Usa actualizar-firmada INSTALACION BASE CANAL ZIP --confirmar."));
    };
    if consent != "--confirmar" { return Err(fail("UPDATE_CONSENT_REQUIRED", "Confirma explícitamente la entrega con --confirmar.")); }
    let root = physical(Path::new(root))?;
    let base = physical(Path::new(base))?;
    let launch = std::env::current_exe().map_err(|error| fs_error("UPDATE_HANDOFF_START_FAILED", error))?;
    if crate::motor_workspace::relative_parts(Path::new(&root), &launch).is_some() {
        return Err(fail("UPDATE_HANDOFF_START_FAILED", "Ejecuta la migración desde un binario de confianza fuera de la instalación."));
    }
    let open = |path: &str| -> Result<File> {
        let path = Path::new(path);
        let parent = physical(path.parent().ok_or_else(busy)?)?;
        scan::open_reader_without_writers(&parent, component(path)?).map_err(|code| fs_error("UPDATE_PATH_LINK", code))
    };
    use std::io::Read;
    let mut envelope = Vec::new();
    open(feed)?.take(128 * 1024 + 1).read_to_end(&mut envelope).map_err(|error| fs_error("UPDATE_CHANNEL_INVALID", error))?;
    if envelope.len() > 128 * 1024 { return Err(fail("UPDATE_CHANNEL_INVALID", "El canal supera el tamaño admitido.")); }
    let channel = Channel::load(&root)?;
    let offer = Offer::verify(&channel, &serde_json::from_slice(&envelope).map_err(|error| fs_error("UPDATE_CHANNEL_INVALID", error))?)?;
    if !offer.release.newer_than(&Release::read(&installed(&root)?)?) {
        return Err(fail("UPDATE_NOT_AVAILABLE", "La entrega ya está instalada."));
    }
    let source = open(zip)?;
    let job = record(&root, &base, &offer)?;
    run_worker(&root, job["id"].as_str().unwrap(), Some(source), false).await
}

pub(crate) async fn recover(args: &[String]) -> Result<Value> {
    let [root, consent] = args else { return Err(busy()); };
    if consent != "--confirmar" { return Err(fail("UPDATE_CONSENT_REQUIRED", "Confirma la recuperación desde la consola local.")); }
    let root = physical(Path::new(root))?;
    let mut job = handoff(&root)?.filter(|job| job["native"] == true && job["phase"] != "fallida").ok_or_else(busy)?;
    if pending(&job) && !motor_owner::known_stale(&job["owner"]) { return Err(busy()); }
    let work = directory(&root, job["id"].as_str().unwrap())?;
    let journal = read_json(&physical(&work)?, "diario.json")?.filter(|value| value["version"] == 1 && value["id"] == job["id"])
        .ok_or_else(busy)?;
    let steps: Vec<Step> = serde_json::from_value(journal["steps"].clone()).map_err(|error| fs_error("UPDATE_HANDOFF_INVALID", error))?;
    let base = job["baseDirectory"].as_str().unwrap_or_default().to_owned();
    if base_marker(&base)? != job["baseIdentity"] { return Err(busy()); }
    let (_lease, _owner) = quiet(&root, &base).await?;
    save(&root, &mut job, "aplicando")?;
    reverse(&root, &work, &steps).map_err(|_| fail("UPDATE_RECOVERY_REQUIRED", "Se conserva el diario para completar la recuperación."))?;
    job["result"] = json!({"status":"revertida","baseDirectory":base});
    job["error"] = json!({"code":"UPDATE_REVERTED","message":"Se restauró el programa anterior desde la consola."});
    job["finishedAt"] = iso(now_ms());
    save(&root, &mut job, "fallida")?;
    Ok(job)
}
