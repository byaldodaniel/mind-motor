use std::{
    collections::HashSet,
    fs::{self, OpenOptions},
    io::{self, Cursor, Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;
use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};

use crate::{
    motor_native::Fault,
    motor_owner::timestamp,
    motor_permissions::read_json,
    motor_workspace::{physical_directory, relative_parts},
    scan, text_write,
};

const KEY_FILE: &str = "backup-key.json";
const CONFIG_FILE: &str = "backup-config.json";
const MAGIC: &[u8; 8] = b"MINDBAK1";
const HEADER_MAX_BYTES: usize = 64 * 1024;
const KEY_BYTES: usize = 32;
const NONCE_BYTES: usize = 12;
const TAG_BYTES: usize = 16;
const SALT_BYTES: usize = 32;
const MAX_DEPTH: usize = 64;
const MAX_ENTRIES: usize = 200_000;
const MAX_RECORD_BYTES: usize = 64 * 1024;
const MAX_MANIFEST_BYTES: usize = 128 * 1024 * 1024;
const MAX_TOTAL_BYTES: usize = 128 * 1024 * 1024;
const MAX_NAME_ATTEMPTS: usize = 100;
const MIN_AGENT_INTERVAL: Duration = Duration::from_secs(60);

#[derive(Default)]
pub(crate) struct BackupLimiter {
    last_agent_backup: Mutex<Option<Instant>>,
}

impl BackupLimiter {
    pub(crate) fn check(&self) -> Result<(), Fault> {
        let guard = self
            .last_agent_backup
            .lock()
            .map_err(|_| Fault::new("MOTOR_UNAVAILABLE", "No se pudo coordinar el respaldo."))?;
        if let Some(last) = *guard {
            if last.elapsed() < MIN_AGENT_INTERVAL {
                return Err(Fault::new(
                    "BACKUP_TOO_FREQUENT",
                    "Ya se creó un respaldo hace menos de un minuto.",
                ));
            }
        }
        Ok(())
    }

    pub(crate) fn record(&self) {
        if let Ok(mut guard) = self.last_agent_backup.lock() {
            *guard = Some(Instant::now());
        }
    }
}

pub(crate) fn create_for_agent(
    base: &str,
    motor_dir: Option<&Path>,
    limiter: &BackupLimiter,
    confirm_owner: impl Fn() -> Result<(), &'static str>,
) -> Result<Value, Fault> {
    let config = read_backup_config(base)?;
    if config.is_none() {
        return Err(not_configured());
    }
    limiter.check()?;
    let created = create_configured_backup(base, motor_dir, confirm_owner)?;
    limiter.record();
    Ok(json!({
        "estado": created["estado"],
        "archivo": created["archivo"],
        "destino": created["destino"],
        "fecha": created["fecha"],
    }))
}

pub(crate) fn create_configured_backup(
    base: &str,
    motor_dir: Option<&Path>,
    confirm_owner: impl Fn() -> Result<(), &'static str>,
) -> Result<Value, Fault> {
    create_backup_at(base, motor_dir, None, confirm_owner)
}

fn create_backup_at(
    base: &str,
    motor_dir: Option<&Path>,
    destination_override: Option<&str>,
    confirm_owner: impl Fn() -> Result<(), &'static str>,
) -> Result<Value, Fault> {
    crate::motor_files::recover_move(base, &confirm_owner)?;
    let (config, dest) = match destination_override {
        Some(raw) => (None, physical_destination(base, motor_dir, raw)?),
        None => {
            let cfg = read_backup_config(base)?.ok_or_else(not_configured)?;
            let d = physical_destination(base, motor_dir, &cfg.destination)?;
            (Some(cfg), d)
        }
    };
    let master = load_key(base)?;

    let backup_id = Uuid::new_v4().to_string();
    let created_at = timestamp()
        .ok_or_else(|| Fault::new("CLOCK_UNAVAILABLE", "No se pudo leer la hora del sistema."))?;
    let mut data_key = [0u8; KEY_BYTES];
    let mut payload_nonce = [0u8; NONCE_BYTES];
    let mut wrap_nonce = [0u8; NONCE_BYTES];
    random_bytes(&mut data_key)?;
    random_bytes(&mut payload_nonce)?;
    random_bytes(&mut wrap_nonce)?;

    let wrap_aad = serde_json::to_vec(&json!(["mind-respaldo", 1, "clave-de-datos", master.key_id, backup_id]))
        .map_err(|_| Fault::new("BACKUP_WRITE_FAILED", "No se pudo preparar la cabecera del respaldo."))?;
    let (wrapped_dk, wrap_tag) = aes256_gcm_seal(&master.key, &wrap_nonce, &wrap_aad, &data_key);

    let base_id = read_base_marker_id(base);
    let motor_version = std::env::var("MIND_MOTOR_NATIVO_VERSION")
        .ok()
        .filter(|v| v.len() <= 64)
        .unwrap_or_else(|| "1.0.5".to_owned());

    let header = json!({
        "format": "mind-respaldo",
        "version": 1,
        "backupId": backup_id,
        "createdAt": created_at,
        "keyId": master.key_id,
        "baseId": base_id,
        "motorVersion": motor_version,
        "cipher": "aes-256-gcm",
        "compression": "zlib",
        "dataKey": {
            "nonce": STANDARD.encode(wrap_nonce),
            "ciphertext": STANDARD.encode(wrapped_dk),
            "tag": STANDARD.encode(wrap_tag),
        },
        "recoveryCode": master.recovery_code,
        "payload": {
            "nonce": STANDARD.encode(payload_nonce),
        },
    });
    let header_bytes = serde_json::to_vec(&header)
        .map_err(|_| Fault::new("BACKUP_WRITE_FAILED", "No se pudo serializar la cabecera del respaldo."))?;
    if header_bytes.len() > HEADER_MAX_BYTES {
        return Err(Fault::new("BACKUP_WRITE_FAILED", "La cabecera del respaldo supera el límite."));
    }
    let mut prefix = Vec::with_capacity(MAGIC.len() + 4 + header_bytes.len());
    prefix.extend_from_slice(MAGIC);
    prefix.extend_from_slice(&(header_bytes.len() as u32).to_be_bytes());
    prefix.extend_from_slice(&header_bytes);

    let (payload, files) = build_payload(base, &confirm_owner)?;
    let compressed = compress_zlib(&payload)?;
    let (ciphertext, tag) = aes256_gcm_seal(&data_key, &payload_nonce, &prefix, &compressed);

    let name = publish_backup_file(&dest, &created_at, &prefix, &ciphertext, &tag)?;
    if let Some(cfg) = &config {
        record_last_backup(base, cfg, &created_at, &name, confirm_owner)?;
    }

    let file_path = Path::new(&dest).join(&name).to_string_lossy().into_owned();
    Ok(json!({
        "estado": "creado",
        "archivo": name,
        "ruta": file_path,
        "destino": dest,
        "archivos": files,
        "fecha": created_at,
    }))
}

pub(crate) fn console_configure(
    base: &str,
    motor_dir: Option<&Path>,
    payload: &Value,
    confirm_owner: impl Fn() -> Result<(), &'static str>,
) -> Result<Value, Fault> {
    let key_value = payload.get("clave").filter(|v| v.is_object()).ok_or_else(|| {
        Fault::new(
            "BACKUP_KEY_CORRUPT",
            "La clave de respaldos de la Base (backup-key.json) no tiene el formato esperado; no se crean respaldos con ella.",
        )
    })?;
    let master = validate_key_record(key_value)?;
    let raw_dest = payload["destino"].as_str().ok_or_else(|| {
        Fault::new(
            "BACKUP_DESTINATION_INVALID",
            "Indica la ruta absoluta de la carpeta donde guardar los respaldos.",
        )
    })?;
    let dest = physical_destination(base, motor_dir, raw_dest)?;

    if crate::motor_permissions::read_file(base, KEY_FILE, HEADER_MAX_BYTES)
        .map_err(|_| {
            Fault::new(
                "BACKUP_KEY_CORRUPT",
                "La clave de respaldos de la Base (backup-key.json) está dañada o es un enlace; no se crean respaldos con ella.",
            )
        })?
        .is_some()
    {
        return Err(Fault::new(
            "BACKUP_ALREADY_CONFIGURED",
            "Los respaldos ya están configurados en esta Base; el código y el archivo de recuperación actuales siguen valiendo.",
        ));
    }

    let mut key_bytes = serde_json::to_vec_pretty(key_value)
        .map_err(|_| Fault::new("WRITE_FAILED", "No se pudo guardar la clave de respaldos."))?;
    key_bytes.push(b'\n');
    text_write::write_bytes(base, KEY_FILE, &key_bytes, HEADER_MAX_BYTES, None, &confirm_owner).map_err(|code| {
        if code == "FILE_EXISTS" {
            Fault::new(
                "BACKUP_ALREADY_CONFIGURED",
                "Los respaldos ya están configurados en esta Base; el código y el archivo de recuperación actuales siguen valiendo.",
            )
        } else {
            Fault::new(code, "No se pudo guardar backup-key.json en la Base.")
        }
    })?;

    let prev = read_backup_config(base).ok().flatten();
    let configured_at = timestamp()
        .ok_or_else(|| Fault::new("CLOCK_UNAVAILABLE", "No se pudo leer la hora del sistema."))?;
    let last_backup = prev
        .as_ref()
        .and_then(|cfg| cfg.raw.get("lastBackup").cloned())
        .unwrap_or(Value::Null);
    let config_record = json!({
        "format": "mind-respaldo-config",
        "version": 1,
        "destination": dest,
        "configuredAt": configured_at,
        "lastBackup": last_backup,
    });
    let mut config_bytes = serde_json::to_vec_pretty(&config_record)
        .map_err(|_| Fault::new("WRITE_FAILED", "No se pudo guardar backup-config.json."))?;
    config_bytes.push(b'\n');
    let expected = prev.as_ref().map(|cfg| cfg.digest.as_str());
    text_write::write_bytes(base, CONFIG_FILE, &config_bytes, HEADER_MAX_BYTES, expected, confirm_owner)
        .map_err(|code| Fault::new(code, "No se pudo guardar backup-config.json en la Base."))?;

    Ok(json!({
        "ok": true,
        "destino": dest,
        "keyId": master.key_id,
    }))
}

pub(crate) fn console_create(
    base: &str,
    motor_dir: Option<&Path>,
    payload: &Value,
    confirm_owner: impl Fn() -> Result<(), &'static str>,
) -> Result<Value, Fault> {
    let dest_override = match payload.get("destino") {
        None | Some(Value::Null) => None,
        Some(v) => Some(v.as_str().ok_or_else(|| {
            Fault::new(
                "BACKUP_DESTINATION_INVALID",
                "Indica la ruta absoluta de la carpeta donde guardar los respaldos.",
            )
        })?),
    };
    let created = create_backup_at(base, motor_dir, dest_override, confirm_owner)?;
    Ok(json!({
        "ok": true,
        "respaldo": {
            "archivo": created["archivo"],
            "ruta": created["ruta"],
            "destino": created["destino"],
            "archivos": created["archivos"],
            "fecha": created["fecha"],
        },
    }))
}

fn not_configured() -> Fault {
    Fault::new(
        "BACKUP_NOT_CONFIGURED",
        "Los respaldos no están configurados. El usuario debe ejecutar \"mind respaldo configurar <carpeta>\" en la carpeta de Mind.",
    )
}

struct BackupConfig {
    destination: String,
    configured_at: Option<Value>,
    last_backup: Option<LastBackup>,
    raw: Value,
    digest: String,
}

struct LastBackup {
    at: String,
}

fn read_backup_config(base: &str) -> Result<Option<BackupConfig>, Fault> {
    let bytes = match crate::motor_permissions::read_file(base, CONFIG_FILE, HEADER_MAX_BYTES) {
        Ok(Some(bytes)) => bytes,
        Ok(None) => return Ok(None),
        Err(error) => {
            return Err(Fault::new(
                "BACKUP_CONFIG_CORRUPT",
                format!("La configuración de respaldos ({CONFIG_FILE}) está dañada o es un enlace ({}).", error.code),
            ));
        }
    };
    let digest = format!("{:x}", Sha256::digest(&bytes));
    let data: Value = serde_json::from_slice(&bytes).map_err(|_| {
        Fault::new(
            "BACKUP_CONFIG_CORRUPT",
            "La configuración de respaldos (backup-config.json) no tiene el formato esperado.",
        )
    })?;
    let corrupt = || {
        Fault::new(
            "BACKUP_CONFIG_CORRUPT",
            "La configuración de respaldos (backup-config.json) no tiene el formato esperado.",
        )
    };
    let Some(destination) = data["destination"].as_str() else {
        return Err(corrupt());
    };
    if !data.is_object()
        || data["format"] != "mind-respaldo-config"
        || data["version"] != 1
        || !Path::new(destination).is_absolute()
    {
        return Err(corrupt());
    }
    let last_backup = match data.get("lastBackup") {
        Some(Value::Null) | None => None,
        Some(obj) => {
            let Some(at) = obj["at"].as_str() else { return Err(corrupt()) };
            if !obj.is_object() || !obj["file"].is_string() {
                return Err(corrupt());
            }
            Some(LastBackup { at: at.to_owned() })
        }
    };
    let configured_at = data.get("configuredAt").cloned();
    Ok(Some(BackupConfig {
        destination: destination.to_owned(),
        configured_at,
        last_backup,
        raw: data,
        digest,
    }))
}

struct MasterKey {
    key_id: String,
    key: [u8; KEY_BYTES],
    recovery_code: Value,
}

fn canonical_b64(value: &Value, expected_len: usize) -> Option<Vec<u8>> {
    let text = value.as_str()?;
    let bytes = STANDARD.decode(text).ok()?;
    (bytes.len() == expected_len && STANDARD.encode(&bytes) == text).then_some(bytes)
}

fn valid_sealed_fields(obj: &Value, expected_ct: usize) -> bool {
    let Some(map) = obj.as_object() else { return false };
    canonical_b64(&obj["nonce"], NONCE_BYTES).is_some()
        && canonical_b64(&obj["ciphertext"], expected_ct).is_some()
        && canonical_b64(&obj["tag"], TAG_BYTES).is_some()
        && map.keys().all(|k| matches!(k.as_str(), "kdf" | "nonce" | "ciphertext" | "tag"))
}

fn valid_kdf(obj: &Value) -> bool {
    let Some(map) = obj.as_object() else { return false };
    map.len() == 6
        && map.keys().all(|k| matches!(k.as_str(), "name" | "N" | "r" | "p" | "keyLength" | "salt"))
        && obj["name"] == "scrypt"
        && obj["keyLength"] == KEY_BYTES
        && obj["N"].as_u64().is_some()
        && obj["r"].as_u64().is_some()
        && obj["p"].as_u64().is_some()
        && canonical_b64(&obj["salt"], SALT_BYTES).is_some()
}

fn validate_key_record(data: &Value) -> Result<MasterKey, Fault> {
    let corrupt = || {
        Fault::new(
            "BACKUP_KEY_CORRUPT",
            "La clave de respaldos de la Base (backup-key.json) no tiene el formato esperado; no se crean respaldos con ella.",
        )
    };
    let Some(key_id) = data["keyId"].as_str() else { return Err(corrupt()) };
    if data["format"] != "mind-respaldo-clave"
        || data["version"] != 1
        || key_id.len() != 32
        || !key_id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || !data["createdAt"].is_string()
    {
        return Err(corrupt());
    }
    let Some(key_vec) = canonical_b64(&data["key"], KEY_BYTES) else { return Err(corrupt()) };
    let rc = &data["recoveryCode"];
    let Some(rc_map) = rc.as_object() else { return Err(corrupt()) };
    if rc_map.len() != 4 || !valid_kdf(&rc["kdf"]) || !valid_sealed_fields(rc, KEY_BYTES) {
        return Err(corrupt());
    }
    let mut key = [0u8; KEY_BYTES];
    key.copy_from_slice(&key_vec);
    Ok(MasterKey {
        key_id: key_id.to_owned(),
        key,
        recovery_code: rc.clone(),
    })
}

fn load_key(base: &str) -> Result<MasterKey, Fault> {
    let bytes = match crate::motor_permissions::read_file(base, KEY_FILE, HEADER_MAX_BYTES) {
        Ok(Some(bytes)) => bytes,
        Ok(None) => return Err(not_configured()),
        Err(_) => {
            return Err(Fault::new(
                "BACKUP_KEY_CORRUPT",
                "La clave de respaldos de la Base (backup-key.json) está dañada o es un enlace; no se crean respaldos con ella.",
            ));
        }
    };
    let data: Value = serde_json::from_slice(&bytes).map_err(|_| {
        Fault::new(
            "BACKUP_KEY_CORRUPT",
            "La clave de respaldos de la Base (backup-key.json) no tiene el formato esperado; no se crean respaldos con ella.",
        )
    })?;
    validate_key_record(&data)
}

fn physical_destination(base: &str, motor_dir: Option<&Path>, raw: &str) -> Result<String, Fault> {
    if raw.contains('\0') || !Path::new(raw).is_absolute() {
        return Err(Fault::new(
            "BACKUP_DESTINATION_INVALID",
            "Indica la ruta absoluta de la carpeta donde guardar los respaldos.",
        ));
    }
    let destination = physical_directory(Path::new(raw)).ok_or_else(|| {
        Fault::new(
            "BACKUP_DESTINATION_UNAVAILABLE",
            "El destino de los respaldos no existe o no es accesible.",
        )
    })?;
    if relative_parts(Path::new(base), Path::new(&destination)).is_some() {
        return Err(Fault::new(
            "BACKUP_DESTINATION_INVALID",
            "El destino de los respaldos no puede estar dentro de la Base.",
        ));
    }
    if let Some(motor) = motor_dir.and_then(physical_directory) {
        if relative_parts(Path::new(&motor), Path::new(&destination)).is_some() {
            return Err(Fault::new(
                "BACKUP_DESTINATION_INVALID",
                "El destino de los respaldos no puede estar dentro del Motor (se sustituye al actualizar Mind).",
            ));
        }
    }
    Ok(destination)
}

fn read_base_marker_id(base: &str) -> Option<String> {
    let marker = read_json(base, "mind-base.json").ok().flatten()?;
    let id = marker["baseId"].as_str()?;
    crate::motor_native::is_id(id).then(|| id.to_owned())
}

fn is_excluded(name: &str, top_level: bool) -> bool {
    if (name.starts_with(".mind-") && name.ends_with(".tmp"))
        || name.ends_with(".lock")
        || name.contains(".lock.abandonado-")
    {
        return true;
    }
    if !top_level {
        return false;
    }
    matches!(
        name,
        KEY_FILE
            | "sesiones"
            | "conector.json"
            | "conector-secreto.json"
            | "conector-consola.json"
            | "anfitrion.json"
            | "conector.lock.recovery"
            | "motor-central.log"
            | "motor-central.log.1"
            | "conversation-index.sqlite"
            | "conversation-index.sqlite-journal"
            | "conversation-index.sqlite-wal"
            | "conversation-index.sqlite-shm"
    ) || name.starts_with("consent-request-")
}

fn valid_entry_name(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && name.len() <= 255
        && !name.chars().any(|c| {
            let code = c as u32;
            code <= 0x1f || code == 0x7f || c == '/' || c == '\\'
        })
}

fn push_frame(out: &mut Vec<u8>, value: &Value, limit: usize) -> Result<(), Fault> {
    let body = serde_json::to_vec(value)
        .map_err(|_| Fault::new("BACKUP_WRITE_FAILED", "No se pudo serializar un registro del respaldo."))?;
    if body.len() > limit {
        return Err(Fault::new("BACKUP_TOO_LARGE", "La Base tiene demasiadas entradas para un respaldo."));
    }
    out.extend_from_slice(&(body.len() as u32).to_be_bytes());
    out.extend_from_slice(&body);
    Ok(())
}

fn build_payload(
    base: &str,
    confirm_owner: impl Fn() -> Result<(), &'static str>,
) -> Result<(Vec<u8>, usize), Fault> {
    let mut payload = Vec::new();
    let mut manifest_entries = Vec::new();
    let mut files = 0usize;
    let mut directories = 0usize;
    let mut total_bytes = 0usize;
    let mut seen_dirs = HashSet::new();
    seen_dirs.insert(String::new());

    fn walk_dir(
        base: &str,
        relative: &str,
        depth: usize,
        payload: &mut Vec<u8>,
        manifest_entries: &mut Vec<Value>,
        files: &mut usize,
        directories: &mut usize,
        total_bytes: &mut usize,
    ) -> Result<(), Fault> {
        let dir_path = if relative.is_empty() {
            PathBuf::from(base)
        } else {
            let mut p = PathBuf::from(base);
            for part in relative.split('/') {
                p.push(part);
            }
            p
        };
        let mut names = Vec::new();
        let entries = match fs::read_dir(&dir_path) {
            Ok(entries) => entries,
            Err(error) => {
                if !relative.is_empty() && error.kind() == io::ErrorKind::NotFound {
                    return Ok(());
                }
                return Err(Fault::new(
                    "BACKUP_SOURCE_UNREADABLE",
                    format!("No se pudo leer «{}» de la Base; no se publicó ningún respaldo.", if relative.is_empty() { "." } else { relative }),
                ));
            }
        };
        for item in entries {
            let item = item.map_err(|_| {
                Fault::new("BACKUP_SOURCE_UNREADABLE", "No se pudo enumerar la Base durante el respaldo.")
            })?;
            let Ok(name) = item.file_name().into_string() else { continue };
            names.push(name);
        }
        names.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));

        for name in names {
            if is_excluded(&name, relative.is_empty()) || !valid_entry_name(&name) {
                continue;
            }
            let child_rel = if relative.is_empty() {
                name.clone()
            } else {
                format!("{relative}/{name}")
            };
            let full_path = dir_path.join(&name);
            let meta = match fs::symlink_metadata(&full_path) {
                Ok(m) => m,
                Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                Err(_) => {
                    return Err(Fault::new(
                        "BACKUP_SOURCE_UNREADABLE",
                        format!("No se pudo inspeccionar «{child_rel}» en la Base."),
                    ));
                }
            };
            if is_reparse_or_link(&meta) {
                continue;
            }
            if meta.is_dir() {
                if depth + 1 >= MAX_DEPTH {
                    return Err(Fault::new(
                        "BACKUP_TOO_LARGE",
                        "La Base tiene subcarpetas demasiado profundas para respaldarla.",
                    ));
                }
                if manifest_entries.len() >= MAX_ENTRIES {
                    return Err(Fault::new(
                        "BACKUP_TOO_LARGE",
                        "La Base tiene demasiadas entradas para un respaldo.",
                    ));
                }
                *directories += 1;
                push_frame(payload, &json!({ "type": "directory", "path": child_rel }), MAX_RECORD_BYTES)?;
                manifest_entries.push(json!({ "path": child_rel, "type": "directory" }));
                walk_dir(
                    base,
                    &child_rel,
                    depth + 1,
                    payload,
                    manifest_entries,
                    files,
                    directories,
                    total_bytes,
                )?;
            } else if meta.is_file() {
                if manifest_entries.len() >= MAX_ENTRIES {
                    return Err(Fault::new(
                        "BACKUP_TOO_LARGE",
                        "La Base tiene demasiadas entradas para un respaldo.",
                    ));
                }
                let mut reader = match scan::open_reader(base, &child_rel) {
                    Ok(file) => file,
                    Err("FILE_NOT_FOUND") => continue,
                    Err("UNSAFE_PATH") => continue,
                    Err(_) => {
                        return Err(Fault::new(
                            "BACKUP_SOURCE_UNREADABLE",
                            format!("No se pudo abrir «{child_rel}» en la Base."),
                        ));
                    }
                };
                let mut data = Vec::new();
                let limit = MAX_TOTAL_BYTES.saturating_sub(*total_bytes);
                (&mut reader)
                    .take(limit.saturating_add(1) as u64)
                    .read_to_end(&mut data)
                    .map_err(|_| {
                        Fault::new(
                            "BACKUP_SOURCE_UNREADABLE",
                            format!("No se pudo leer «{child_rel}» en la Base."),
                        )
                    })?;
                if data.len() > limit {
                    return Err(Fault::new(
                        "BACKUP_TOO_LARGE",
                        "La Base supera el tamaño admitido para el respaldo nativo.",
                    ));
                }
                let size = data.len();
                let sha256 = format!("{:x}", Sha256::digest(&data));
                push_frame(
                    payload,
                    &json!({ "type": "file", "path": child_rel, "size": size }),
                    MAX_RECORD_BYTES,
                )?;
                payload.extend_from_slice(&data);
                manifest_entries.push(json!({
                    "path": child_rel,
                    "type": "file",
                    "size": size,
                    "sha256": sha256,
                }));
                *files += 1;
                *total_bytes += size;
            }
        }
        Ok(())
    }

    confirm_owner().map_err(|code| Fault::new(code, "Cambió la propiedad de la Base."))?;
    walk_dir(
        base,
        "",
        0,
        &mut payload,
        &mut manifest_entries,
        &mut files,
        &mut directories,
        &mut total_bytes,
    )?;
    confirm_owner().map_err(|code| Fault::new(code, "Cambió la propiedad de la Base."))?;

    push_frame(
        &mut payload,
        &json!({
            "type": "manifest",
            "entries": manifest_entries,
            "files": files,
            "directories": directories,
            "bytes": total_bytes,
        }),
        MAX_MANIFEST_BYTES,
    )?;
    Ok((payload, files))
}

fn is_reparse_or_link(meta: &fs::Metadata) -> bool {
    if meta.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        return meta.file_attributes() & 0x400 != 0;
    }
    #[cfg(not(windows))]
    {
        false
    }
}

fn compress_zlib(payload: &[u8]) -> Result<Vec<u8>, Fault> {
    let mut zip_buf = Cursor::new(Vec::new());
    {
        let mut writer = ZipWriter::new(&mut zip_buf);
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        writer
            .start_file("p", options)
            .map_err(|_| Fault::new("BACKUP_WRITE_FAILED", "No se pudo comprimir el respaldo."))?;
        writer
            .write_all(payload)
            .map_err(|_| Fault::new("BACKUP_WRITE_FAILED", "No se pudo comprimir el respaldo."))?;
        writer
            .finish()
            .map_err(|_| Fault::new("BACKUP_WRITE_FAILED", "No se pudo completar la compresión del respaldo."))?;
    }
    let mut archive = ZipArchive::new(Cursor::new(zip_buf.into_inner()))
        .map_err(|_| Fault::new("BACKUP_WRITE_FAILED", "No se pudo empaquetar el respaldo."))?;
    let mut raw = archive
        .by_index_raw(0)
        .map_err(|_| Fault::new("BACKUP_WRITE_FAILED", "No se pudo extraer la carga comprimida."))?;
    if raw.compression() != CompressionMethod::Deflated {
        return Err(Fault::new("BACKUP_WRITE_FAILED", "Compresión inesperada del respaldo."));
    }
    let mut out = Vec::with_capacity(2 + raw.compressed_size() as usize + 4);
    out.extend_from_slice(&[0x78, 0x9c]);
    io::copy(&mut raw, &mut out)
        .map_err(|_| Fault::new("BACKUP_WRITE_FAILED", "No se pudo escribir la carga comprimida."))?;
    out.extend_from_slice(&adler32(payload).to_be_bytes());
    Ok(out)
}

fn adler32(data: &[u8]) -> u32 {
    const MOD_ADLER: u32 = 65521;
    let mut a: u32 = 1;
    let mut b: u32 = 0;
    for chunk in data.chunks(5552) {
        for &byte in chunk {
            a += u32::from(byte);
            b += a;
        }
        a %= MOD_ADLER;
        b %= MOD_ADLER;
    }
    (b << 16) | a
}

fn publish_backup_file(
    dest: &str,
    created_at: &str,
    prefix: &[u8],
    ciphertext: &[u8],
    tag: &[u8; TAG_BYTES],
) -> Result<String, Fault> {
    let dest_dir = Path::new(dest);
    let temp = dest_dir.join(format!(".mind-respaldo-{}.tmp", Uuid::new_v4()));
    let cleanup = |path: &Path| {
        let _ = fs::remove_file(path);
    };
    let mut opts = OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let write_res = (|| -> io::Result<()> {
        let mut file = opts.open(&temp)?;
        file.write_all(prefix)?;
        file.write_all(ciphertext)?;
        file.write_all(tag)?;
        file.sync_all()?;
        Ok(())
    })();
    if let Err(error) = write_res {
        cleanup(&temp);
        return Err(map_write_io_error(error));
    }

    let stamp = format!(
        "{}Z",
        created_at[..19].replace(':', "-")
    );
    for attempt in 1..=MAX_NAME_ATTEMPTS {
        let suffix = if attempt == 1 {
            String::new()
        } else {
            format!("-{attempt}")
        };
        let candidate = format!("mind-respaldo-{stamp}{suffix}.mindbak");
        let target = dest_dir.join(&candidate);
        match publish_exclusive(&temp, &target) {
            Ok(()) => return Ok(candidate),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                cleanup(&temp);
                return Err(map_write_io_error(error));
            }
        }
    }
    cleanup(&temp);
    Err(Fault::new(
        "BACKUP_WRITE_FAILED",
        "No se encontró un nombre libre para el respaldo.",
    ))
}

fn publish_exclusive(temporary: &Path, target: &Path) -> io::Result<()> {
    match fs::hard_link(temporary, target) {
        Ok(()) => {
            let _ = fs::remove_file(temporary);
            return Ok(());
        }
        Err(error) => {
            if error.kind() == io::ErrorKind::AlreadyExists {
                return Err(error);
            }
            if !matches!(
                error.raw_os_error(),
                Some(1 | 18 | 22 | 31 | 38 | 45 | 50 | 95 | 524)
            ) && error.kind() != io::ErrorKind::Unsupported
                && error.kind() != io::ErrorKind::PermissionDenied
            {
                return Err(error);
            }
        }
    }
    let mut reserve = OpenOptions::new();
    reserve.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        reserve.mode(0o600);
    }
    drop(reserve.open(target)?);
    if let Err(error) = fs::rename(temporary, target) {
        let _ = fs::remove_file(target);
        return Err(error);
    }
    Ok(())
}

fn map_write_io_error(error: io::Error) -> Fault {
    if error.kind() == io::ErrorKind::PermissionDenied {
        return Fault::new(
            "BACKUP_DESTINATION_UNAVAILABLE",
            "No se puede escribir en el destino de los respaldos.",
        );
    }
    Fault::new(
        "BACKUP_WRITE_FAILED",
        format!("No se pudo escribir el respaldo ({}); no se publicó ningún archivo.", error),
    )
}

fn record_last_backup(
    base: &str,
    config: &BackupConfig,
    created_at: &str,
    name: &str,
    confirm_owner: impl Fn() -> Result<(), &'static str>,
) -> Result<(), Fault> {
    if config
        .last_backup
        .as_ref()
        .is_some_and(|last| last.at.as_str() > created_at)
    {
        return Ok(());
    }
    let updated = json!({
        "format": "mind-respaldo-config",
        "version": 1,
        "destination": config.destination,
        "configuredAt": config.configured_at,
        "lastBackup": {
            "at": created_at,
            "file": name,
        },
    });
    let mut bytes = serde_json::to_vec_pretty(&updated)
        .map_err(|_| Fault::new("WRITE_FAILED", "No se pudo guardar la configuración de respaldos."))?;
    bytes.push(b'\n');
    let _ = config.raw;
    text_write::write_bytes(
        base,
        CONFIG_FILE,
        &bytes,
        HEADER_MAX_BYTES,
        Some(&config.digest),
        confirm_owner,
    )
    .map(|_| ())
    .map_err(|code| Fault::new(code, "No se pudo actualizar el último respaldo en backup-config.json."))
}

// ---------------------------------------------------------------------------
// CSPRNG + FIPS 197 AES-256 + NIST SP 800-38D AES-256-GCM
// ---------------------------------------------------------------------------

#[cfg(windows)]
fn random_bytes(out: &mut [u8]) -> Result<(), Fault> {
    use std::ffi::c_void;
    #[link(name = "bcrypt")]
    extern "system" {
        fn BCryptGenRandom(
            h_algorithm: *mut c_void,
            pb_buffer: *mut u8,
            cb_buffer: u32,
            dw_flags: u32,
        ) -> i32;
    }
    let status = unsafe { BCryptGenRandom(std::ptr::null_mut(), out.as_mut_ptr(), out.len() as u32, 0x0000_0002) };
    if status != 0 {
        return Err(Fault::new("RNG_UNAVAILABLE", "No se pudo generar aleatoriedad criptográfica."));
    }
    Ok(())
}

#[cfg(unix)]
fn random_bytes(out: &mut [u8]) -> Result<(), Fault> {
    let mut f = fs::File::open("/dev/urandom")
        .map_err(|_| Fault::new("RNG_UNAVAILABLE", "No se pudo abrir la fuente aleatoria del sistema."))?;
    f.read_exact(out)
        .map_err(|_| Fault::new("RNG_UNAVAILABLE", "No se pudo leer aleatoriedad criptográfica."))?;
    Ok(())
}

const SBOX: [u8; 256] = [
    0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76,
    0xca, 0x82, 0xc9, 0x7d, 0xfa, 0x59, 0x47, 0xf0, 0xad, 0xd4, 0xa2, 0xaf, 0x9c, 0xa4, 0x72, 0xc0,
    0xb7, 0xfd, 0x93, 0x26, 0x36, 0x3f, 0xf7, 0xcc, 0x34, 0xa5, 0xe5, 0xf1, 0x71, 0xd8, 0x31, 0x15,
    0x04, 0xc7, 0x23, 0xc3, 0x18, 0x96, 0x05, 0x9a, 0x07, 0x12, 0x80, 0xe2, 0xeb, 0x27, 0xb2, 0x75,
    0x09, 0x83, 0x2c, 0x1a, 0x1b, 0x6e, 0x5a, 0xa0, 0x52, 0x3b, 0xd6, 0xb3, 0x29, 0xe3, 0x2f, 0x84,
    0x53, 0xd1, 0x00, 0xed, 0x20, 0xfc, 0xb1, 0x5b, 0x6a, 0xcb, 0xbe, 0x39, 0x4a, 0x4c, 0x58, 0xcf,
    0xd0, 0xef, 0xaa, 0xfb, 0x43, 0x4d, 0x33, 0x85, 0x45, 0xf9, 0x02, 0x7f, 0x50, 0x3c, 0x9f, 0xa8,
    0x51, 0xa3, 0x40, 0x8f, 0x92, 0x9d, 0x38, 0xf5, 0xbc, 0xb6, 0xda, 0x21, 0x10, 0xff, 0xf3, 0xd2,
    0xcd, 0x0c, 0x13, 0xec, 0x5f, 0x97, 0x44, 0x17, 0xc4, 0xa7, 0x7e, 0x3d, 0x64, 0x5d, 0x19, 0x73,
    0x60, 0x81, 0x4f, 0xdc, 0x22, 0x2a, 0x90, 0x88, 0x46, 0xee, 0xb8, 0x14, 0xde, 0x5e, 0x0b, 0xdb,
    0xe0, 0x32, 0x3a, 0x0a, 0x49, 0x06, 0x24, 0x5c, 0xc2, 0xd3, 0xac, 0x62, 0x91, 0x95, 0xe4, 0x79,
    0xe7, 0xc8, 0x37, 0x6d, 0x8d, 0xd5, 0x4e, 0xa9, 0x6c, 0x56, 0xf4, 0xea, 0x65, 0x7a, 0xae, 0x08,
    0xba, 0x78, 0x25, 0x2e, 0x1c, 0xa6, 0xb4, 0xc6, 0xe8, 0xdd, 0x74, 0x1f, 0x4b, 0xbd, 0x8b, 0x8a,
    0x70, 0x3e, 0xb5, 0x66, 0x48, 0x03, 0xf6, 0x0e, 0x61, 0x35, 0x57, 0xb9, 0x86, 0xc1, 0x1d, 0x9e,
    0xe1, 0xf8, 0x98, 0x11, 0x69, 0xd9, 0x8e, 0x94, 0x9b, 0x1e, 0x87, 0xe9, 0xce, 0x55, 0x28, 0xdf,
    0x8c, 0xa1, 0x89, 0x0d, 0xbf, 0xe6, 0x42, 0x68, 0x41, 0x99, 0x2d, 0x0f, 0xb0, 0x54, 0xbb, 0x16,
];

const RCON: [u8; 7] = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40];

fn sub_word(w: [u8; 4]) -> [u8; 4] {
    [
        SBOX[w[0] as usize],
        SBOX[w[1] as usize],
        SBOX[w[2] as usize],
        SBOX[w[3] as usize],
    ]
}

fn rot_word(w: [u8; 4]) -> [u8; 4] {
    [w[1], w[2], w[3], w[0]]
}

fn aes256_expand_key(key: &[u8; 32]) -> [[u8; 4]; 60] {
    let mut w = [[0u8; 4]; 60];
    for (i, slot) in w[..8].iter_mut().enumerate() {
        *slot = [key[4 * i], key[4 * i + 1], key[4 * i + 2], key[4 * i + 3]];
    }
    for i in 8..60 {
        let mut temp = w[i - 1];
        if i % 8 == 0 {
            temp = sub_word(rot_word(temp));
            temp[0] ^= RCON[i / 8 - 1];
        } else if i % 8 == 4 {
            temp = sub_word(temp);
        }
        for j in 0..4 {
            w[i][j] = w[i - 8][j] ^ temp[j];
        }
    }
    w
}

#[inline]
fn xtime(a: u8) -> u8 {
    (a << 1) ^ ((a >> 7) * 0x1b)
}

fn aes256_encrypt_block(rk: &[[u8; 4]; 60], block: &[u8; 16]) -> [u8; 16] {
    let mut s = *block;
    for c in 0..4 {
        for r in 0..4 {
            s[4 * c + r] ^= rk[c][r];
        }
    }
    for round in 1..14 {
        for byte in &mut s {
            *byte = SBOX[*byte as usize];
        }
        // ShiftRows
        let tmp1 = s[1];
        s[1] = s[5];
        s[5] = s[9];
        s[9] = s[13];
        s[13] = tmp1;
        s.swap(2, 10);
        s.swap(6, 14);
        let tmp3 = s[15];
        s[15] = s[11];
        s[11] = s[7];
        s[7] = s[3];
        s[3] = tmp3;
        // MixColumns
        for c in 0..4 {
            let i = 4 * c;
            let (a0, a1, a2, a3) = (s[i], s[i + 1], s[i + 2], s[i + 3]);
            let t = a0 ^ a1 ^ a2 ^ a3;
            s[i] = a0 ^ t ^ xtime(a0 ^ a1);
            s[i + 1] = a1 ^ t ^ xtime(a1 ^ a2);
            s[i + 2] = a2 ^ t ^ xtime(a2 ^ a3);
            s[i + 3] = a3 ^ t ^ xtime(a3 ^ a0);
        }
        let base = round * 4;
        for c in 0..4 {
            for r in 0..4 {
                s[4 * c + r] ^= rk[base + c][r];
            }
        }
    }
    // Round 14 (no MixColumns)
    for byte in &mut s {
        *byte = SBOX[*byte as usize];
    }
    let tmp1 = s[1];
    s[1] = s[5];
    s[5] = s[9];
    s[9] = s[13];
    s[13] = tmp1;
    s.swap(2, 10);
    s.swap(6, 14);
    let tmp3 = s[15];
    s[15] = s[11];
    s[11] = s[7];
    s[7] = s[3];
    s[3] = tmp3;
    for c in 0..4 {
        for r in 0..4 {
            s[4 * c + r] ^= rk[56 + c][r];
        }
    }
    s
}

fn gf128_mul(x: u128, h: u128) -> u128 {
    const R: u128 = 0xe100_0000_0000_0000_0000_0000_0000_0000;
    let mut z = 0u128;
    let mut v = h;
    for i in 0..128 {
        if (x >> (127 - i)) & 1 != 0 {
            z ^= v;
        }
        let lsb = v & 1;
        v >>= 1;
        if lsb != 0 {
            v ^= R;
        }
    }
    z
}

fn ghash_update(h: u128, y: &mut u128, data: &[u8]) {
    for chunk in data.chunks(16) {
        let mut block = [0u8; 16];
        block[..chunk.len()].copy_from_slice(chunk);
        *y = gf128_mul(*y ^ u128::from_be_bytes(block), h);
    }
}

fn inc32(block: &mut [u8; 16]) {
    let ctr = u32::from_be_bytes([block[12], block[13], block[14], block[15]]).wrapping_add(1);
    block[12..16].copy_from_slice(&ctr.to_be_bytes());
}

fn aes256_gcm_seal(
    key: &[u8; 32],
    nonce: &[u8; 12],
    aad: &[u8],
    plaintext: &[u8],
) -> (Vec<u8>, [u8; 16]) {
    let rk = aes256_expand_key(key);
    let h = u128::from_be_bytes(aes256_encrypt_block(&rk, &[0u8; 16]));

    let mut j0 = [0u8; 16];
    j0[..12].copy_from_slice(nonce);
    j0[15] = 1;

    let mut ctr = j0;
    let mut ciphertext = Vec::with_capacity(plaintext.len());
    for chunk in plaintext.chunks(16) {
        inc32(&mut ctr);
        let keystream = aes256_encrypt_block(&rk, &ctr);
        for (i, &b) in chunk.iter().enumerate() {
            ciphertext.push(b ^ keystream[i]);
        }
    }

    let mut y = 0u128;
    ghash_update(h, &mut y, aad);
    ghash_update(h, &mut y, &ciphertext);
    let mut len_block = [0u8; 16];
    len_block[..8].copy_from_slice(&((aad.len() as u64) * 8).to_be_bytes());
    len_block[8..16].copy_from_slice(&((ciphertext.len() as u64) * 8).to_be_bytes());
    y = gf128_mul(y ^ u128::from_be_bytes(len_block), h);

    let s = u128::from_be_bytes(aes256_encrypt_block(&rk, &j0));
    let tag = (y ^ s).to_be_bytes();
    (ciphertext, tag)
}
