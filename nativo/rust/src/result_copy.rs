//! Streams a result through held descriptors and publishes it without replacing its destination.
use std::{fs::File, io::{self, BufRead, Read, Write}, time::Duration};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::{native_parent::ParentGuard, scan::open_reader_without_writers, text_write};

const MAX_REQUEST: u64 = 32_768;
const MAX_BYTES: u64 = 4 * 1024 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Copy {
    source_root: String,
    source_path: String,
    target_root: String,
    target_path: String,
    max_bytes: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Verify {
    verify_only: bool,
    source_root: String,
    source_path: String,
    max_bytes: u64,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Request {
    Copy(Copy),
    Verify(Verify),
}

#[derive(PartialEq, Eq)]
struct Fingerprint {
    size: u64,
    written: i128,
    changed: i128,
}

#[cfg(windows)]
fn fingerprint(file: &File) -> io::Result<Fingerprint> {
    use std::{ffi::c_void, mem::size_of, os::windows::io::AsRawHandle};
    #[repr(C)]
    #[derive(Default)]
    struct BasicInfo {
        creation: i64,
        access: i64,
        write: i64,
        change: i64,
        attributes: u32,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetFileInformationByHandleEx(handle: *mut c_void, class: i32, buffer: *mut c_void, size: u32) -> i32;
    }
    let mut basic = BasicInfo::default();
    if unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle(), 0, (&mut basic as *mut BasicInfo).cast(), size_of::<BasicInfo>() as u32,
        )
    } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(Fingerprint { size: file.metadata()?.len(), written: basic.write.into(), changed: basic.change.into() })
}

#[cfg(unix)]
fn fingerprint(file: &File) -> io::Result<Fingerprint> {
    use std::os::unix::fs::MetadataExt;
    let info = file.metadata()?;
    let nanos = |seconds: i64, fraction: i64| i128::from(seconds) * 1_000_000_000 + i128::from(fraction);
    Ok(Fingerprint {
        size: info.len(), written: nanos(info.mtime(), info.mtime_nsec()),
        changed: nanos(info.ctime(), info.ctime_nsec()),
    })
}

#[cfg(not(any(windows, unix)))]
fn fingerprint(_: &File) -> io::Result<Fingerprint> {
    Err(io::Error::new(io::ErrorKind::Unsupported, "safe copy unavailable"))
}

fn io_code(error: io::Error) -> &'static str {
    if error.kind() == io::ErrorKind::PermissionDenied {
        return "ACCESS_DENIED";
    }
    #[cfg(windows)]
    if matches!(error.raw_os_error(), Some(39 | 112)) { return "NO_SPACE"; }
    #[cfg(unix)]
    if error.raw_os_error() == Some(libc::ENOSPC) { return "NO_SPACE"; }
    "COPY_FAILED"
}

fn transfer(
    source: &mut File, mut destination: Option<&mut File>, before: &Fingerprint, limit: u64,
) -> Result<(u64, String), &'static str> {
    let mut buffer = vec![0u8; 1024 * 1024];
    let mut digest = Sha256::new();
    let mut total = 0;
    loop {
        let count = source.read(&mut buffer).map_err(io_code)?;
        if count == 0 { break; }
        total += count as u64;
        if total > limit { return Err("FILE_TOO_LARGE"); }
        let chunk = &buffer[..count];
        if let Some(file) = &mut destination {
            file.write_all(chunk).map_err(io_code)?;
        }
        digest.update(chunk);
    }
    if total != before.size || &fingerprint(source).map_err(io_code)? != before {
        return Err("SOURCE_CHANGED");
    }
    Ok((total, format!("{:x}", digest.finalize())))
}

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct DigestInfo {
    pub(crate) size: u64,
    pub(crate) sha256: String,
}

pub(crate) fn copy_file(
    root: &str, path: &str, target_root: &str, target_path: &str,
    confirm: impl Fn() -> Result<(), &'static str>,
) -> Result<DigestInfo, &'static str> {
    let result = execute(root, path, Some((target_root, target_path)), MAX_BYTES, &confirm, &confirm)?;
    digest_info(&result)
}

pub(crate) fn verify_file(
    root: &str, path: &str, confirm: impl Fn() -> Result<(), &'static str>,
) -> Result<DigestInfo, &'static str> {
    let result = execute(root, path, None, MAX_BYTES, &confirm, &confirm)?;
    digest_info(&result)
}

fn digest_info(value: &Value) -> Result<DigestInfo, &'static str> {
    Ok(DigestInfo {
        size: value["size"].as_u64().ok_or("COPY_FAILED")?,
        sha256: value["sha256"].as_str().ok_or("COPY_FAILED")?.to_owned(),
    })
}

fn execute(
    root: &str, path: &str, target: Option<(&str, &str)>, limit: u64,
    confirm: impl FnOnce() -> Result<(), &'static str>,
    confirm_after_read: impl FnOnce() -> Result<(), &'static str>,
) -> Result<Value, &'static str> {
    if limit > MAX_BYTES { return Err("FILE_TOO_LARGE"); }
    let mut source = open_reader_without_writers(root, path)?;
    let before = fingerprint(&source).map_err(io_code)?;
    if before.size > limit { return Err("FILE_TOO_LARGE"); }
    if let Some((target_root, target_path)) = target {
        let mut hash = None;
        let mut result = text_write::create_stream(target_root, target_path, confirm, |destination| {
            let (count, digest) = transfer(&mut source, Some(destination), &before, limit)?;
            confirm_after_read()?;
            hash = Some(digest);
            Ok(count)
        })?;
        result["sha256"] = json!(hash.ok_or("COPY_FAILED")?);
        Ok(result)
    } else {
        confirm()?;
        let (size, digest) = transfer(&mut source, None, &before, limit)?;
        confirm_after_read()?;
        Ok(json!({"size": size, "sha256": digest}))
    }
}

fn operate(args: &[String]) -> Result<Value, &'static str> {
    let guard = ParentGuard::from_args(args)?;
    let mut input = io::stdin().lock();
    let mut line = Vec::new();
    (&mut input).take(MAX_REQUEST).read_until(b'\n', &mut line).map_err(io_code)?;
    if line.last() != Some(&b'\n') { return Err("COPY_FAILED"); }
    let request: Request = serde_json::from_slice(&line).map_err(|_| "COPY_FAILED")?;
    let confirm = || {
        {
            let mut diagnostic = io::stderr().lock();
            diagnostic.write_all(b"READY\n").map_err(io_code)?;
            diagnostic.flush().map_err(io_code)?;
        }
        let mut accepted = [0];
        input.read_exact(&mut accepted).map_err(io_code)?;
        if accepted != *b"W" { return Err("COPY_FAILED"); }
        guard.begin_commit(Duration::from_secs(120))
    };
    match request {
        Request::Copy(copy) => execute(
            &copy.source_root, &copy.source_path, Some((&copy.target_root, &copy.target_path)), copy.max_bytes, confirm, || Ok(()),
        ),
        Request::Verify(verify) if verify.verify_only => execute(
            &verify.source_root, &verify.source_path, None, verify.max_bytes, confirm, || Ok(()),
        ),
        Request::Verify(_) => Err("COPY_FAILED"),
    }
}

pub(crate) fn run(args: &[String]) -> Result<(), String> {
    let outcome = operate(args).map_err(str::to_owned)?;
    serde_json::to_writer(io::stdout().lock(), &outcome).map_err(|_| "COPY_FAILED".into())
}
