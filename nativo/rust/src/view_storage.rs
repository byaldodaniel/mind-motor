//! Immutable storage for local website previews.
use std::{
    collections::BTreeMap,
    fs::{File, OpenOptions},
    io::{self, Read, Seek, SeekFrom, Write},
    sync::{Arc, Mutex},
};

use bytes::Bytes;
use http_body_util::{BodyExt, StreamBody};
use hyper::body::Frame;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::{Body, Git, Snapshot, MAX_ASSET_PATH, MAX_VIEW_BYTES};
use crate::{scan, view_cli::{read_asset, route_name}};

pub(super) const LOCAL_BYTES: usize = 512 * 1024 * 1024;
const LOCAL_FILES: usize = 8192;
const LOCAL_DIRECTORIES: usize = 2048;
const CHUNK: usize = 128 * 1024;

#[derive(Clone)]
pub(super) enum AssetBytes {
    Memory(Bytes),
    Disk { file: Arc<Mutex<File>>, offset: u64, size: usize },
}

impl AssetBytes {
    pub(super) fn len(&self) -> usize {
        match self {
            Self::Memory(bytes) => bytes.len(),
            Self::Disk { size, .. } => *size,
        }
    }

    pub(super) fn body(self, start: usize, size: usize, script: Option<String>) -> Body {
        let state = (self, start, size, script);
        let stream = futures_util::stream::try_unfold(state, |(asset, start, remaining, script)| async move {
            if remaining == 0 {
                return Ok(script.map(|script| (Frame::data(Bytes::from(script)), (asset, start, 0, None))));
            }
            let bytes = match &asset {
                Self::Memory(bytes) => bytes.slice(start..start + remaining),
                Self::Disk { file, offset, .. } => {
                    let file = Arc::clone(file);
                    let position = offset + start as u64;
                    let count = remaining.min(CHUNK);
                    tokio::task::spawn_blocking(move || -> io::Result<Bytes> {
                        let mut buffer = vec![0; count];
                        let mut file = file.lock().map_err(|_| io::Error::other("Archivo temporal ocupado."))?;
                        file.seek(SeekFrom::Start(position))?;
                        file.read_exact(&mut buffer)?;
                        Ok(Bytes::from(buffer))
                    }).await.map_err(io::Error::other)??
                }
            };
            let count = bytes.len();
            Ok(Some((Frame::data(bytes), (asset, start + count, remaining - count, script))))
        });
        BodyExt::boxed(StreamBody::new(stream))
    }
}

// Only the open handle owns the temporary copy. Exit or a crash releases it.
fn temporary_file() -> io::Result<File> {
    let path = std::env::temp_dir().join(format!("mind-vista-{}.tmp", Uuid::new_v4()));
    let mut options = OpenOptions::new();
    options.create_new(true).read(true).write(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // FILE_FLAG_DELETE_ON_CLOSE. Disallow other processes opening the file.
        options.share_mode(0).custom_flags(0x04000000);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(&path)?;
    #[cfg(unix)]
    std::fs::remove_file(&path)?;
    Ok(file)
}

fn scoped(prefix: &str, relative: &str) -> String {
    if prefix.is_empty() { relative.to_owned() }
    else if relative.is_empty() { prefix.to_owned() }
    else { format!("{prefix}/{relative}") }
}

fn local_paths(
    root: &str, prefix: &str, skip: &dyn Fn(&str) -> bool,
) -> Result<(BTreeMap<String, usize>, usize), String> {
    let mut pending = vec![String::new()];
    let mut directories = 1;
    let mut paths = BTreeMap::new();
    let mut total = 0;
    while let Some(dir) = pending.pop() {
        // Enumeration and metadata come from a held directory handle within the authorization.
        let (entries, complete) = scan::scan_directory(root, &scoped(prefix, &dir), 100_000)
            .map_err(|err| format!("No se pudo enumerar la carpeta de la vista ({})", err.0))?;
        if !complete {
            return Err(format!("La carpeta {dir:?} supera el límite de enumeración de Mind."));
        }
        for entry in entries {
            let name = entry["name"].as_str().ok_or("Mind no pudo leer el nombre de un recurso.")?;
            let relative = scoped(&dir, name);
            if name.starts_with('.') || skip(&relative) { continue; }
            if !route_name(name) || relative.len() > MAX_ASSET_PATH {
                return Err(format!("Ruta de la vista no admitida: {relative:?}"));
            }
            match entry["type"].as_str() {
                Some("directory") => {
                    directories += 1;
                    if directories > LOCAL_DIRECTORIES {
                        return Err(format!("La vista supera el límite de {LOCAL_DIRECTORIES} directorios."));
                    }
                    pending.push(relative);
                }
                Some("file") => {
                    if paths.len() == LOCAL_FILES {
                        return Err(format!("La vista supera el límite de {LOCAL_FILES} archivos."));
                    }
                    let size = entry["size"].as_u64().ok_or("No se pudo verificar el tamaño de un recurso.")?;
                    if size > (LOCAL_BYTES - total) as u64 {
                        return Err(format!("La vista supera el límite de {} MiB.", LOCAL_BYTES / (1024 * 1024)));
                    }
                    total += size as usize;
                    paths.insert(relative, size as usize);
                }
                _ => return Err(format!("La vista requiere archivos y carpetas sin enlaces: {relative}")),
            }
        }
    }
    if !paths.contains_key("index.html") {
        return Err("Selecciona la carpeta del sitio que contiene index.html.".into());
    }
    Ok((paths, total))
}

impl Snapshot {
    pub(crate) fn directory(
        root: &str, prefix: &str, skip: &dyn Fn(&str) -> bool, project: String, copy: String, git: Option<Git>,
    ) -> Result<Self, String> {
        let (paths, size) = local_paths(root, prefix, skip)?;
        let mut assets = BTreeMap::new();
        let mut digest = Sha256::new();
        let mut buffer = vec![0; CHUNK];
        let mut offset = 0;
        let on_disk = size > MAX_VIEW_BYTES;
        let spool = if on_disk {
            Some(Arc::new(Mutex::new(temporary_file().map_err(|e| format!("No se pudo preparar la copia temporal de la vista: {e}"))?)))
        } else { None };
        for (name, length) in paths {
            let source = scan::open_reader_without_writers(root, &scoped(prefix, &name))
                .map_err(|code| format!("No se pudo abrir el recurso {name:?} ({code})."))?;
            digest.update((name.len() as u64).to_be_bytes());
            digest.update(name.as_bytes());
            digest.update((length as u64).to_be_bytes());
            let asset = if let Some(file) = &spool {
                let mut writer = file.lock().map_err(|_| "No se pudo escribir la copia temporal de la vista.")?;
                read_asset(source, &name, length, &mut buffer, |chunk| {
                    writer.write_all(chunk)?;
                    digest.update(chunk);
                    Ok(())
                })?;
                AssetBytes::Disk { file: Arc::clone(file), offset, size: length }
            } else {
                let mut bytes = Vec::with_capacity(length);
                read_asset(source, &name, length, &mut buffer, |chunk| {
                    bytes.extend_from_slice(chunk);
                    digest.update(chunk);
                    Ok(())
                })?;
                AssetBytes::Memory(Bytes::from(bytes))
            };
            offset += length as u64;
            assets.insert(name, asset);
        }
        let fingerprint = format!("{:x}", digest.finalize());
        Ok(Self { project, copy, git, assets, fingerprint, size, on_disk })
    }
}
