use std::{fs::File, io::{self, BufRead, Read, Write}, path::Path, time::Duration};

use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{native_parent::ParentGuard, scan::{open_directory, reader_component}};

type Result<T> = std::result::Result<T, &'static str>;
const TRASH: &str = ".papelera-mind";
const MAX_DIGEST: u64 = 64 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "lowercase", rename_all_fields = "camelCase", deny_unknown_fields)]
enum Request {
    Mkdir { root: String, relative_path: String },
    Move { root: String, from: String, to: String, target_root: Option<String> },
    Trash { root: String, relative_path: String, trash_id: String, expect: Option<Expected> },
    Restore { root: String, trash_id: String, name: String, target_parent: Vec<String>, candidates: Vec<String> },
    Purge { root: String, trash_id: String },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Expected {
    #[serde(rename = "type")] pub(crate) kind: Option<String>,
    pub(crate) size: Option<u64>,
    pub(crate) modified_ms: Option<i64>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct Identity(u64, u64);

impl Identity {
    fn record(self) -> Value {
        json!({"dev": self.0.to_string(), "ino": self.1.to_string()})
    }
}

enum Prepared<'a> {
    Other,
    Move(Identity),
    Trash(&'a Value),
}

struct Entry {
    file: File,
    directory: bool,
    id: Identity,
}

impl Entry {
    fn kind(&self) -> &'static str {
        if self.directory { "directory" } else { "file" }
    }
}

fn part(value: &str) -> Result<&str> {
    if reader_component(value) { Ok(value) } else { Err("UNSAFE_PATH") }
}

fn parts(value: &str) -> Result<Vec<&str>> {
    if value.encode_utf16().count() > 4096 {
        return Err("UNSAFE_PATH");
    }
    value.split('/').map(part).collect()
}

fn fold(value: &str) -> String {
    if cfg!(any(windows, target_os = "macos")) { value.to_lowercase() } else { value.to_owned() }
}

fn trash_id(value: &str) -> Result<&str> {
    let bytes = value.as_bytes();
    if bytes.len() == 29
        && bytes[..8].iter().all(u8::is_ascii_digit) && bytes[8] == b'T'
        && bytes[9..15].iter().all(u8::is_ascii_digit) && bytes[15..17] == *b"Z-"
        && bytes[17..].iter().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(b))
    { Ok(value) } else { Err("UNSAFE_PATH") }
}

fn same_volume(id: Identity, other: Identity) -> Result<()> {
    if id.0 == other.0 { Ok(()) } else { Err("UNSAFE_PATH") }
}

fn missing(error: &'static str, alternate: &'static str) -> &'static str {
    if error == "FILE_NOT_FOUND" { alternate } else { error }
}

// Keep the root open and resolve each descendant relative to the acquired directory.
fn descend(root: &File, root_id: Identity, names: &[&str], absent: &'static str) -> Result<(File, Vec<Identity>)> {
    let mut directory = root.try_clone().map_err(|_| "FAILED")?;
    let mut chain = vec![root_id];
    for name in names {
        directory = fs::dir(&directory, name, false).map_err(|e| missing(e, absent))?;
        let id = fs::identity(&directory)?;
        same_volume(root_id, id)?;
        chain.push(id);
    }
    Ok((directory, chain))
}

fn confirm(input: &mut impl BufRead, guard: &ParentGuard, seconds: u64) -> Result<()> {
    {
        let mut diagnostic = io::stderr().lock();
        diagnostic.write_all(b"READY\n").and_then(|_| diagnostic.flush()).map_err(|_| "FAILED")?;
    }
    let mut byte = [0];
    input.read_exact(&mut byte).map_err(|_| "FAILED")?;
    if byte != *b"W" { return Err("FAILED"); }
    guard.begin_commit(Duration::from_secs(seconds))
}

fn describe(entry: &Entry) -> Result<Value> {
    let mut data = fs::metadata(&entry.file, entry.directory)?;
    data["type"] = json!(entry.kind());
    Ok(data)
}

fn check_expected(entry: &Entry, metadata: &Value, expected: Option<Expected>) -> Result<()> {
    let Some(expected) = expected else { return Ok(()); };
    if expected.kind.as_deref().is_some_and(|value| value != entry.kind())
        || (!entry.directory && (expected.size.is_some_and(|value| metadata["size"].as_u64() != Some(value))
            || expected.modified_ms.is_some_and(|value| metadata["modifiedMs"].as_i64() != Some(value))))
    {
        return Err("ENTRY_CHANGED");
    }
    Ok(())
}

fn digest(entry: &Entry, metadata: &Value) -> Result<Option<String>> {
    if entry.directory || metadata["size"].as_u64().is_some_and(|size| size > MAX_DIGEST) {
        return Ok(None);
    }
    let mut reader = (&entry.file).take(MAX_DIGEST + 1);
    let mut hash = Sha256::new();
    let mut chunk = vec![0; 64 * 1024];
    let mut total = 0;
    loop {
        let n = reader.read(&mut chunk).map_err(|_| "FAILED")?;
        if n == 0 { return Ok(Some(format!("{:x}", hash.finalize()))); }
        total += n as u64;
        if total > MAX_DIGEST { return Ok(None); }
        hash.update(&chunk[..n]);
    }
}

fn holder(top: &File, id: Identity, name: &str) -> Result<(File, File, Identity)> {
    let name = trash_id(name)?;
    let trash = fs::dir(top, TRASH, false).map_err(|error| missing(error, "TRASH_MISSING"))?;
    same_volume(id, fs::identity(&trash)?)?;
    let folder = fs::dir(&trash, name, true).map_err(|error| missing(error, "TRASH_MISSING"))?;
    let current = fs::identity(&folder)?;
    same_volume(id, current)?;
    Ok((trash, folder, current))
}

pub(crate) fn create_directory(root: &str, path: &str, confirm: impl FnOnce() -> Result<()>) -> Result<()> {
    let request = Request::Mkdir { root: root.to_owned(), relative_path: path.to_owned() };
    run_request(request, |_, _| confirm()).map(|_| ())
}

pub(crate) fn move_entry(
    root: &str, from: &str, to: &str, target_root: Option<String>,
    prepare: impl FnOnce(Value) -> Result<()>,
) -> Result<Value> {
    let request = Request::Move {
        root: root.to_owned(), from: from.to_owned(), to: to.to_owned(), target_root,
    };
    run_request(request, |_, prepared| match prepared {
        Prepared::Move(identity) => prepare(identity.record()),
        _ => Err("FAILED"),
    })
}

pub(crate) fn trash_entry(
    root: &str, relative_path: &str, trash_id: &str, expect: Option<Expected>,
    prepare: impl FnOnce(&Value) -> Result<()>,
) -> Result<Value> {
    let request = Request::Trash {
        root: root.to_owned(), relative_path: relative_path.to_owned(),
        trash_id: trash_id.to_owned(), expect,
    };
    run_request(request, |_, prepared| match prepared {
        Prepared::Trash(metadata) => prepare(metadata),
        _ => Err("FAILED"),
    })
}

// Verifica la identidad a partir del descriptor del directorio y sin seguir enlaces.
pub(crate) fn location_identity(path: &Path) -> Result<Option<Value>> {
    if !path.is_absolute() {
        return Err("UNSAFE_PATH");
    }
    let parent = path.parent().and_then(Path::to_str).ok_or("UNSAFE_PATH")?;
    let name = part(path.file_name().and_then(|name| name.to_str()).ok_or("UNSAFE_PATH")?)?;
    let directory = match open_directory(parent, "") {
        Ok(directory) => directory,
        Err("FILE_NOT_FOUND") => return Ok(None),
        Err(error) => return Err(error),
    };
    Ok(fs::occupied(&directory, name)?.map(Identity::record))
}

pub(crate) fn restore_entry(
    root: &str, trash_id: &str, name: &str, target_parent: Vec<String>, candidates: Vec<String>,
    confirm: impl FnOnce() -> Result<()>,
) -> Result<Value> {
    let request = Request::Restore {
        root: root.to_owned(), trash_id: trash_id.to_owned(), name: name.to_owned(),
        target_parent, candidates,
    };
    run_request(request, |_, _| confirm())
}

pub(crate) fn purge_entry(
    root: &str, trash_id: &str, confirm: impl FnOnce() -> Result<()>,
) -> Result<Value> {
    let request = Request::Purge { root: root.to_owned(), trash_id: trash_id.to_owned() };
    run_request(request, |_, _| confirm())
}

fn run_request(request: Request, approve: impl FnOnce(u64, Prepared<'_>) -> Result<()>) -> Result<Value> {
    match request {
        Request::Mkdir { root, relative_path } => {
            let names = parts(&relative_path)?;
            let (name, parents) = names.split_last().ok_or("UNSAFE_PATH")?;
            let top = open_directory(&root, "")?;
            let volume = fs::identity(&top)?;
            let (parent, _) = descend(&top, volume, parents, "PARENT_NOT_FOUND")?;
            if fs::occupied(&parent, name)?.is_some() { return Err("FILE_EXISTS"); }
            approve(10, Prepared::Other)?;
            let created = fs::mkdir(&parent, name).map_err(|error| missing(error, "PARENT_NOT_FOUND"))?;
            let id = fs::identity(&created).map_err(|_| "UNCONFIRMED")?;
            same_volume(volume, id).map_err(|_| "UNCONFIRMED")?;
            describe(&Entry { file: created, directory: true, id }).map_err(|_| "UNCONFIRMED")
        }
        Request::Move { root, from, to, target_root } => {
            let src = parts(&from)?;
            let dst = parts(&to)?;
            let same_root = target_root.is_none();
            if (same_root && (src == dst || (dst.len() > src.len()
                && src.iter().zip(&dst).all(|(a,b)| fold(a) == fold(b)))))
                || [src[0], dst[0]].into_iter().any(|name| fold(name) == TRASH) {
                return Err("INVALID_MOVE");
            }
            let (name, parents) = src.split_last().ok_or("UNSAFE_PATH")?;
            let (new_name, target_parents) = dst.split_last().ok_or("UNSAFE_PATH")?;
            let top = open_directory(&root, "")?;
            let volume = fs::identity(&top)?;
            let (source, _) = descend(&top, volume, parents, "FILE_NOT_FOUND")?;
            let other = target_root.map(|path| open_directory(&path, "")).transpose()?;
            let target_root = other.as_ref().unwrap_or(&top);
            let target_volume = fs::identity(target_root)?;
            if volume.0 != target_volume.0 { return Err("CROSS_DEVICE"); }
            let (target, chain) = descend(target_root, target_volume, target_parents, "PARENT_NOT_FOUND")?;
            let entry = fs::acquire(&source, name, volume, false)?;
            if entry.directory && chain.contains(&entry.id) { return Err("INVALID_MOVE"); }
            let alias = match fs::occupied(&target, new_name)? {
                Some(id) if id == entry.id => true,
                Some(_) => return Err("FILE_EXISTS"),
                None => false,
            };
            approve(10, Prepared::Move(entry.id))?;
            if alias {
                let temporary = format!(".mind-move-{}.tmp", Uuid::new_v4().simple());
                fs::move_entry(&entry, &source, name, &source, &temporary)?;
                if let Err(error) = fs::move_entry(&entry, &source, &temporary, &target, new_name) {
                    fs::move_entry(&entry, &source, &temporary, &source, name).map_err(|_| "UNCONFIRMED")?;
                    return Err(error);
                }
            } else {
                fs::move_entry(&entry, &source, name, &target, new_name)?;
            }
            describe(&entry).map_err(|_| "UNCONFIRMED")
        }
        Request::Trash { root, relative_path, trash_id: id, expect } => {
            let id = trash_id(&id)?;
            let names = parts(&relative_path)?;
            if fold(names[0]) == TRASH { return Err("UNSAFE_PATH"); }
            let (name, parents) = names.split_last().ok_or("UNSAFE_PATH")?;
            let top = open_directory(&root, "")?;
            let volume = fs::identity(&top)?;
            let (source, _) = descend(&top, volume, parents, "FILE_NOT_FOUND")?;
            let entry = fs::acquire(&source, name, volume, true)?;
            let mut metadata = describe(&entry)?;
            check_expected(&entry, &metadata, expect)?;
            metadata["sha256"] = json!(digest(&entry, &metadata)?);
            approve(30, Prepared::Trash(&metadata))?;
            let trash = match fs::mkdir(&top, TRASH) {
                Ok(file) => file,
                Err("FILE_EXISTS") => fs::dir(&top, TRASH, false)?,
                Err(error) => return Err(error),
            };
            same_volume(volume, fs::identity(&trash)?)?;
            let folder = fs::mkdir(&trash, id)?;
            let identity = fs::identity(&folder).map_err(|_| "UNCONFIRMED")?;
            let changed = same_volume(volume, identity)
                .and_then(|()| fs::move_entry(&entry, &source, name, &folder, name));
            if let Err(error) = changed {
                // Delete only the empty holder we just made.
                let _ = fs::remove_created_dir(&trash, id, identity);
                return Err(error);
            }
            Ok(metadata)
        }
        Request::Restore { root, trash_id: id, name, target_parent, candidates } => {
            let name = part(&name)?;
            let parents = target_parent.iter().map(|name| part(name)).collect::<Result<Vec<_>>>()?;
            let candidates = candidates.iter().map(|name| part(name)).collect::<Result<Vec<_>>>()?;
            if candidates.is_empty() || candidates.len() > 32
                || parents.first().is_some_and(|name| fold(name) == TRASH)
                || (parents.is_empty() && candidates.iter().any(|name| fold(name) == TRASH))
            { return Err("UNSAFE_PATH"); }
            let top = open_directory(&root, "")?;
            let volume = fs::identity(&top)?;
            let (trash, folder, identity) = holder(&top, volume, &id)?;
            let entry = fs::acquire(&folder, name, volume, false).map_err(|e| missing(e, "TRASH_MISSING"))?;
            let (target, chain) = descend(&top, volume, &parents, "PARENT_NOT_FOUND")?;
            if entry.directory && chain.contains(&entry.id) { return Err("INVALID_MOVE"); }
            approve(10, Prepared::Other)?;
            for candidate in candidates {
                if fs::occupied(&target, candidate)?.is_some() { continue; }
                match fs::move_entry(&entry, &folder, name, &target, candidate) {
                    Ok(()) => {
                        let _ = fs::remove_dir(&trash, &id, &folder, identity);
                        let mut result = describe(&entry).map_err(|_| "UNCONFIRMED")?;
                        result["name"] = json!(candidate);
                        return Ok(result);
                    }
                    Err("FILE_EXISTS") => continue,
                    Err(error) => return Err(error),
                }
            }
            Err("FILE_EXISTS")
        }
        Request::Purge { root, trash_id: id } => {
            let top = open_directory(&root, "")?;
            let volume = fs::identity(&top)?;
            let (trash, folder, identity) = holder(&top, volume, &id)?;
            approve(120, Prepared::Other)?;
            let removed = fs::purge(&folder, volume)?;
            fs::remove_dir(&trash, &id, &folder, identity)?;
            Ok(json!({"removed": removed}))
        }
    }
}

pub(crate) fn run(args: &[String]) -> std::result::Result<(), String> {
    let guard = ParentGuard::from_args(args)?;
    let mut stdin = io::stdin().lock();
    let mut line = Vec::new();
    stdin.by_ref().take(65_536).read_until(b'\n', &mut line).map_err(|_| "FAILED")?;
    if line.last() != Some(&b'\n') { return Err("FAILED".into()); }
    let data = serde_json::from_slice(&line).map_err(|_| "FAILED")?;
    let result = run_request(data, |seconds, _| confirm(&mut stdin, &guard, seconds))?;
    serde_json::to_writer(io::stdout().lock(), &result).map_err(|_| "UNCONFIRMED".into())
}

#[cfg(windows)] #[path = "organize_windows.rs"] mod fs;
#[cfg(unix)] #[path = "organize_unix.rs"] mod fs;
