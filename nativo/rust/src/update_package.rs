//! Signed channel and package validation. Installation is a separate operation.
use std::{
    collections::{BTreeMap, BTreeSet}, fs::{self, File}, io::{self, Read, Seek, Write},
    path::Path, time::{SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::STANDARD, Engine};
use ring::signature::{UnparsedPublicKey, ED25519};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization;

use crate::{motor_files::{iso_to_millis, millis_to_iso}, motor_native::Fault, motor_permissions,
    motor_workspace::physical_directory, organize, scan, text_write};

pub(crate) type Result<T> = std::result::Result<T, Fault>;
pub(crate) const MANIFEST: &str = "Sistema/mind-producto.json";
pub(crate) const DESCRIPTOR: &str = "Sistema/entrega-firmada.json";
pub(crate) const CHANNEL: &str = "Sistema/canal-actualizaciones.json";
pub(crate) const LEGACY_CHANNEL: &str = "Sistema/Programa/Motor/src/update-channel.json";
pub(crate) const MAX_PACKAGE: u64 = 512 * 1024 * 1024;
pub(crate) const MAX_DOCUMENT: usize = 2 * 1024 * 1024;
const MAX_EXPANDED: u64 = 1024 * 1024 * 1024;
const MAX_FILES: usize = 5500;
pub(crate) const TARGETS: [&str; 6] = ["win32-x64", "win32-arm64", "linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"];

pub(crate) fn fail(code: &'static str, message: impl Into<String>) -> Fault { Fault::new(code, message) }
pub(crate) fn fs_error(code: &'static str, error: impl std::fmt::Display) -> Fault {
    fail(code, format!("No se pudo completar la operación de actualización ({error})."))
}
pub(crate) fn sha(bytes: &[u8]) -> String { format!("{:x}", Sha256::digest(bytes)) }
pub(crate) fn hash(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub(crate) fn now_ms() -> i64 {
    let ms = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis();
    i64::try_from(ms).unwrap_or(i64::MAX)
}
pub(crate) fn iso(ms: i64) -> Value { json!(millis_to_iso(ms)) }
pub(crate) fn millis(value: &Value) -> Option<i64> { iso_to_millis(value.as_str()?) }

pub(crate) fn physical(path: &Path) -> Result<String> {
    if !path.is_absolute() {
        return Err(fail("UPDATE_PATH_INVALID", "Indica una ruta absoluta."));
    }
    physical_directory(path).ok_or_else(|| fail("UPDATE_PATH_INVALID", "La carpeta no se puede abrir de forma segura."))
}

pub(crate) fn target() -> String {
    let os = match std::env::consts::OS { "windows" => "win32", "macos" => "darwin", os => os };
    let arch = match std::env::consts::ARCH { "x86_64" => "x64", "aarch64" => "arm64", arch => arch };
    format!("{os}-{arch}")
}
pub(crate) fn executable(target: &str) -> String {
    let file = if target.starts_with("win32-") { "mind-native.exe" } else { "mind-native" };
    format!("Sistema/Componentes/Nativo/{target}/{file}")
}

fn version_parts(value: &str) -> Option<[u64; 3]> {
    let mut parts = value.split_once('+').map_or(value, |(version, _)| version).split('.');
    let mut result = [0; 3];
    for number in &mut result {
        let part = parts.next()?;
        if part.len() > 1 && part.starts_with('0') { return None; }
        if part.is_empty() || !part.bytes().all(|c| c.is_ascii_digit()) { return None; }
        *number = part.parse().ok()?;
    }
    parts.next().is_none().then_some(result)
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Release {
    pub(crate) mind_version: String,
    #[serde(default)]
    pub(crate) package_revision: u64,
    #[serde(default = "one")]
    pub(crate) layout_version: u32,
    #[serde(default = "one")]
    pub(crate) update_protocol_version: u32,
}
fn one() -> u32 { 1 }

impl Release {
    pub(crate) fn read(value: &Value) -> Result<Self> {
        let release: Self = serde_json::from_value(value.clone())
            .map_err(|_| fail("UPDATE_RELEASE_INVALID", "La entrega no identifica la versión de Mind."))?;
        if version_parts(&release.mind_version).is_none() || release.package_revision > 9_007_199_254_740_991
            || !matches!(release.layout_version, 1 | 2) || !matches!(release.update_protocol_version, 1 | 2)
        {
            return Err(fail("UPDATE_RELEASE_INVALID", "La identidad de la entrega no es válida."));
        }
        Ok(release)
    }

    pub(crate) fn newer_than(&self, other: &Self) -> bool {
        (version_parts(&self.mind_version), self.package_revision)
            > (version_parts(&other.mind_version), other.package_revision)
    }

    pub(crate) fn key(&self) -> String { format!("{}-r{}", self.mind_version, self.package_revision) }
}

pub(crate) fn read(root: &str, file: &str, limit: usize) -> Result<Option<Vec<u8>>> {
    motor_permissions::read_file(root, file, limit)
}
pub(crate) fn read_json(root: &str, file: &str) -> Result<Option<Value>> {
    read(root, file, MAX_DOCUMENT)?.map(|bytes| serde_json::from_slice(&bytes)
        .map_err(|error| fs_error("UPDATE_STATE_INVALID", error))).transpose()
}
pub(crate) fn ensure(root: &str, directory: &str) -> Result<()> {
    let mut parent = String::new();
    for part in directory.split('/').filter(|part| !part.is_empty()) {
        if !scan::reader_component(part) {
            return Err(fail("UPDATE_PATH_INVALID", "Componente de actualización no válido."));
        }
        if !parent.is_empty() { parent.push('/'); }
        parent.push_str(part);
        match scan::open_directory(root, &parent) {
            Ok(_) => {}
            Err("FILE_NOT_FOUND") => {
                match organize::create_directory(root, &parent, || Ok(())) {
                    Ok(()) | Err("FILE_EXISTS") => {}
                    Err(code) => return Err(fs_error("UPDATE_PATH_LINK", code)),
                }
                scan::open_directory(root, &parent).map_err(|code| fs_error("UPDATE_PATH_LINK", code))?;
            }
            Err(code) => return Err(fs_error("UPDATE_PATH_LINK", code)),
        }
    }
    Ok(())
}
pub(crate) fn put(root: &str, file: &str, value: &Value) -> Result<()> {
    if let Some((parent, _)) = file.rsplit_once('/') { ensure(root, parent)?; }
    let previous = read(root, file, MAX_DOCUMENT)?.map(|bytes| sha(&bytes));
    let next = value.to_string() + "
";
    text_write::write_bytes(root, file, next.as_bytes(), MAX_DOCUMENT, previous.as_deref(), || Ok(()))
        .map(|_| ()).map_err(|code| fs_error("UPDATE_WRITE_FAILED", code))
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Channel {
    pub(crate) repository: String,
    pub(crate) public_key: String,
    pub(crate) url: Option<String>,
}

impl Channel {
    pub(crate) fn load(root: &str) -> Result<Self> {
        let data = match read_json(root, CHANNEL)? {
            Some(value) => value,
            None => read_json(root, LEGACY_CHANNEL)?.ok_or_else(|| fail("UPDATE_CHANNEL_INVALID", "Falta la clave de confianza instalada."))?,
        };
        let channel: Self = serde_json::from_value(data)
            .map_err(|_| fail("UPDATE_CHANNEL_INVALID", "El canal de actualización instalado no es válido."))?;
        let repo = channel.repository.split('/').collect::<Vec<_>>();
        if repo.len() != 2 || repo.iter().any(|name| name.is_empty() || matches!(*name, "." | "..")
            || !name.bytes().all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c)))
        {
            return Err(fail("UPDATE_CHANNEL_INVALID", "El repositorio de actualización no es válido."));
        }
        channel.key()?;
        Ok(channel)
    }

    fn key(&self) -> Result<Vec<u8>> {
        let pem = self.public_key.trim().lines().collect::<Vec<_>>();
        let invalid = || fail("UPDATE_SIGNATURE_INVALID", "La clave de confianza no es Ed25519.");
        if pem.first() != Some(&"-----BEGIN PUBLIC KEY-----") || pem.last() != Some(&"-----END PUBLIC KEY-----") || pem.len() < 3 {
            return Err(invalid());
        }
        let der = STANDARD.decode(pem[1..pem.len()-1].concat()).map_err(|_| invalid())?;
        // DER SubjectPublicKeyInfo for Ed25519, without algorithm parameters.
        const PREFIX: &[u8] = &[0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00];
        if der.len() != PREFIX.len() + 32 || !der.starts_with(PREFIX) { return Err(invalid()); }
        Ok(der[PREFIX.len()..].to_vec())
    }

    pub(crate) fn address(&self, raw: &str) -> Result<reqwest::Url> {
        let invalid = || fail("UPDATE_CHANNEL_INVALID", "La URL no pertenece a las entregas HTTPS del canal.");
        let url = reqwest::Url::parse(raw).map_err(|_| invalid())?;
        if url.scheme() != "https" || url.host_str() != Some("github.com") || url.port().is_some()
            || !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some()
            || !url.path().starts_with(&format!("/{}/releases/", self.repository))
        { return Err(invalid()); }
        Ok(url)
    }

    pub(crate) fn verify(&self, envelope: &Value) -> Result<Value> {
        let invalid = || fail("UPDATE_SIGNATURE_INVALID", "Firma Ed25519 de actualización incorrecta.");
        let decode = |field| envelope[field].as_str().and_then(|text| STANDARD.decode(text).ok()).ok_or_else(invalid);
        let payload = decode("payload")?;
        let signature = decode("signature")?;
        UnparsedPublicKey::new(&ED25519, self.key()?).verify(&payload, &signature).map_err(|_| invalid())?;
        serde_json::from_slice(&payload).map_err(|error| fs_error("UPDATE_CHANNEL_INVALID", error))
    }
}

#[derive(Clone)]
pub(crate) struct Offer {
    pub(crate) feed: Value,
    pub(crate) release: Release,
    pub(crate) selected: Value,
    pub(crate) envelope: Value,
}
impl Offer {
    pub(crate) fn verify(channel: &Channel, envelope: &Value) -> Result<Self> {
        let feed = channel.verify(envelope)?;
        let release = Release::read(&feed)?;
        if feed["format"] != "mind-update" || feed["version"] != 2 || release.layout_version != 2
            || release.update_protocol_version != 2 || release.package_revision == 0
            || !feed["manifestSha256"].as_str().is_some_and(hash)
        { return Err(fail("UPDATE_PROTOCOL_INVALID", "El canal no identifica una entrega verificable.")); }
        let packages = feed["packages"].as_array().ok_or_else(|| fail("UPDATE_CHANNEL_INVALID", "Faltan los paquetes del canal."))?;
        let candidates = packages.iter().filter(|entry| supports(entry, &target())).collect::<Vec<_>>();
        if candidates.len() != 1 || (candidates[0]["targets"].is_array()
            && (packages.len() != 1 || candidates[0]["platform"] != "win32" || candidates[0]["arch"] != "x64"))
        { return Err(fail("UPDATE_PLATFORM_MISMATCH", "Falta un paquete único para este equipo.")); }
        let selected = candidates[0];
        let url = channel.address(selected["url"].as_str().unwrap_or_default())?;
        if !url.path().to_ascii_lowercase().ends_with(".zip") || !selected["sha256"].as_str().is_some_and(hash)
            || !selected["bytes"].as_u64().is_some_and(|bytes| (1..=MAX_PACKAGE).contains(&bytes))
        { return Err(fail("UPDATE_PACKAGE_ALTERED", "La huella o el tamaño del ZIP no es válido.")); }
        Ok(Self { selected: selected.clone(), feed, release, envelope: envelope.clone() })
    }

    pub(crate) fn identity(&self) -> Value {
        json!({"release":self.release,"manifestSha256":self.feed["manifestSha256"],"packageSha256":self.selected["sha256"]})
    }
}

fn supports(value: &Value, target: &str) -> bool {
    match value.get("targets") {
        Some(Value::Array(targets)) => {
            let entries = targets.iter().filter_map(Value::as_str).collect::<BTreeSet<_>>();
            entries.len() == targets.len() && entries.len() >= 5 && entries.is_subset(&TARGETS.into_iter().collect())
                && TARGETS.into_iter().filter(|id| *id != "win32-arm64").all(|id| entries.contains(id))
                && entries.contains(target)
        }
        Some(_) => false,
        None => target.split_once('-').is_some_and(|(os, arch)| value["platform"] == os && value["arch"] == arch),
    }
}

pub(crate) fn installed(root: &str) -> Result<Value> {
    let manifest = read_json(root, MANIFEST)?.ok_or_else(|| fail("UPDATE_NOT_INSTALLATION", "Falta el manifiesto instalado."))?;
    if manifest["format"] != "mind-product" || manifest["version"] != 1 || !manifest["files"].is_object() {
        return Err(fail("UPDATE_NOT_INSTALLATION", "El manifiesto instalado no es válido."));
    }
    Release::read(&manifest)?;
    Ok(manifest)
}

pub(crate) fn managed(relative: &str) -> bool {
    relative.len() <= 240 && relative.split('/').all(scan::reader_component)
        && relative.split('/').count() <= 12
        && !relative.split('/').any(|p| p == "." || p == "..")
        && relative.nfc().eq(relative.chars())
        && !matches!(relative.to_ascii_lowercase().split('/').next(),
            Some("base" | "conversaciones" | ".mind-arranque.lock" | ".mind-arranque.lock.recovery"))
        && !["sistema/base", "sistema/estado", "sistema/actualizaciones"].iter().any(|name| {
            let lower = relative.to_ascii_lowercase();
            lower == *name || lower.strip_prefix(name).is_some_and(|suffix| suffix.starts_with('/'))
        })
}

pub(crate) fn file_hash(file: &mut File, limit: u64) -> Result<(String, u64)> {
    let mut digest = Sha256::new();
    let size = io::copy(&mut file.take(limit + 1), &mut digest)
        .map_err(|error| fs_error("UPDATE_PACKAGE_ALTERED", error))?;
    if size > limit { return Err(fail("UPDATE_PACKAGE_ALTERED", "El archivo supera el tamaño admitido.")); }
    Ok((format!("{:x}", digest.finalize()), size))
}

fn incoming_path(path: &str) -> bool {
    matches!(path, "LEEME.md" | CHANNEL | "Sistema/mind" | "Sistema/mind.cmd"
        | "Sistema/Autorizar Mind.cmd" | "Sistema/Autorizar Mind.command")
        || path.starts_with("Sistema/Licencias/")
        || TARGETS.into_iter().any(|target| path == executable(target))
}

pub(crate) struct Package {
    pub(crate) manifest: Value,
    pub(crate) files: BTreeMap<String, String>,
}

pub(crate) fn unpack(mut source: File, offer: &Offer, channel: &Channel, stage: &str) -> Result<Package> {
    let (actual, size) = file_hash(&mut source, MAX_PACKAGE)?;
    if offer.selected["sha256"] != actual || offer.selected["bytes"] != size {
        return Err(fail("UPDATE_PACKAGE_ALTERED", "El ZIP no coincide con la huella y tamaño firmados."));
    }
    source.rewind().map_err(|error| fs_error("PACKAGE_ARCHIVE_INVALID", error))?;
    let mut archive = zip::ZipArchive::new(source).map_err(|error| fs_error("PACKAGE_ARCHIVE_INVALID", error))?;
    if archive.has_duplicate_names() || archive.len() > MAX_FILES { return Err(fail("PACKAGE_ARCHIVE_INVALID", "El ZIP tiene demasiadas entradas.")); }
    let mut roots = BTreeSet::new();
    let mut entries = BTreeMap::new();
    let mut folded = BTreeSet::new();
    let mut expanded = 0u64;
    for index in 0..archive.len() {
        let entry = archive.by_index(index).map_err(|error| fs_error("PACKAGE_ARCHIVE_INVALID", error))?;
        let decoded = entry.name().map_err(|error| fs_error("PACKAGE_ARCHIVE_INVALID", error))?;
        let name = decoded.trim_end_matches('/');
        let (root, relative) = name.split_once('/').unwrap_or((name, ""));
        if !scan::reader_component(root) || (!relative.is_empty() && !managed(relative)) || entry.enclosed_name().is_none()
            || entry.is_symlink() || entry.encrypted() || (!entry.is_file() && !entry.is_dir())
        { return Err(fail("PACKAGE_ARCHIVE_INVALID", "El ZIP tiene un enlace, un objeto especial o una ruta insegura.")); }
        roots.insert(root.to_owned());
        if entry.is_dir() { continue; }
        expanded = expanded.saturating_add(entry.size());
        if relative.is_empty() || expanded > MAX_EXPANDED || !folded.insert(relative.to_lowercase())
        { return Err(fail("PACKAGE_ARCHIVE_INVALID", "El ZIP tiene rutas duplicadas o tamaño excesivo.")); }
        entries.insert(relative.to_owned(), index);
    }
    if roots.len() != 1 { return Err(fail("PACKAGE_ARCHIVE_INVALID", "El ZIP debe tener una única carpeta raíz.")); }
    let mut document = |name| -> Result<Vec<u8>> {
        let index = entries.get(name).ok_or_else(|| fail("PACKAGE_ARCHIVE_INVALID", "Falta el manifiesto o su firma."))?;
        let entry = archive.by_index(*index).map_err(|error| fs_error("PACKAGE_ARCHIVE_INVALID", error))?;
        let mut bytes = Vec::new();
        entry.take((MAX_DOCUMENT + 1) as u64).read_to_end(&mut bytes).map_err(|error| fs_error("PACKAGE_ARCHIVE_INVALID", error))?;
        if bytes.len() > MAX_DOCUMENT { return Err(fail("PACKAGE_ARCHIVE_INVALID", "El manifiesto supera el tamaño admitido.")); }
        Ok(bytes)
    };
    let descriptor = serde_json::from_slice(&document(DESCRIPTOR)?).map_err(|error| fs_error("PACKAGE_SIGNATURE_INVALID", error))?;
    let descriptor = channel.verify(&descriptor)?;
    let manifest_bytes = document(MANIFEST)?;
    let manifest_sha = sha(&manifest_bytes);
    if descriptor["format"] != "mind-package" || descriptor["version"] != 1 || Release::read(&descriptor)? != offer.release
        || descriptor["manifestSha256"] != manifest_sha || offer.feed["manifestSha256"] != manifest_sha
    { return Err(fail("UPDATE_MANIFEST_ALTERED", "El manifiesto no coincide con el descriptor y el canal firmados.")); }
    let manifest: Value = serde_json::from_slice(&manifest_bytes).map_err(|error| fs_error("UPDATE_MANIFEST_ALTERED", error))?;
    if manifest["format"] != "mind-product" || manifest["version"] != 1 || Release::read(&manifest)? != offer.release
        || manifest["runtime"] != "rust" || manifest["baseFormatVersion"] != 3 || !supports(&manifest, &target())
        || manifest["links"].as_object().is_none_or(|links| !links.is_empty())
    { return Err(fail("UPDATE_RELEASE_INVALID", "El paquete no conserva el formato de Base ni identifica un Motor Rust para este equipo.")); }
    let mut files: BTreeMap<String, String> = serde_json::from_value(manifest["files"].clone())
        .map_err(|error| fs_error("UPDATE_MANIFEST_ALTERED", error))?;
    if !files.contains_key(&executable(&target())) || !files.contains_key(CHANNEL)
        || files.len() + 2 != entries.len() || files.keys().any(|key| matches!(key.as_str(), MANIFEST | DESCRIPTOR))
        || files.iter().any(|(key, value)| !managed(key) || !hash(value) || !entries.contains_key(key)
            || !incoming_path(key))
    { return Err(fail("UPDATE_MANIFEST_ALTERED", "El ZIP no corresponde a la lista de archivos firmada.")); }
    files.insert(MANIFEST.into(), manifest_sha);
    files.insert(DESCRIPTOR.into(), sha(&document(DESCRIPTOR)?));
    for (relative, expected) in &files {
        let mut body = archive.by_index(entries[relative]).map_err(|error| fs_error("PACKAGE_ARCHIVE_INVALID", error))?;
        if let Some((parent, _)) = relative.rsplit_once('/') { ensure(stage, parent)?; }
        let file = Path::new(stage).join(relative);
        let mut destination = fs::OpenOptions::new().write(true).create_new(true).open(&file)
            .map_err(|error| fs_error("UPDATE_WRITE_FAILED", error))?;
        let mut digest = Sha256::new();
        let mut buffer = [0u8; 64 * 1024];
        let size = body.size();
        let mut count = 0u64;
        loop {
            let n = body.read(&mut buffer).map_err(|error| fs_error("PACKAGE_ARCHIVE_INVALID", error))?;
            if n == 0 { break; }
            count += n as u64;
            if count > size { return Err(fail("UPDATE_PACKAGE_ALTERED", "La entrada descomprimida supera el límite firmado.")); }
            digest.update(&buffer[..n]);
            destination.write_all(&buffer[..n]).map_err(|error| fs_error("UPDATE_WRITE_FAILED", error))?;
        }
        if count != size || format!("{:x}", digest.finalize()) != *expected {
            return Err(fail("UPDATE_PACKAGE_ALTERED", "Un archivo no coincide con su SHA-256 firmado."));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let executable = relative.starts_with("Sistema/Componentes/Nativo/")
                || matches!(relative.as_str(), "Sistema/mind" | "Sistema/Autorizar Mind.command");
            destination.set_permissions(fs::Permissions::from_mode(if executable { 0o755 } else { 0o644 }))
                .map_err(|error| fs_error("UPDATE_WRITE_FAILED", error))?;
        }
        destination.sync_all().map_err(|error| fs_error("UPDATE_WRITE_FAILED", error))?;
    }
    // The installed channel remains pinned when the new program is loaded.
    let incoming = Channel::load(stage)?;
    if incoming.key()? != channel.key()? || incoming.repository != channel.repository {
        return Err(fail("UPDATE_SIGNATURE_INVALID", "El paquete intenta cambiar el canal de confianza."));
    }
    Ok(Package { manifest, files })
}
