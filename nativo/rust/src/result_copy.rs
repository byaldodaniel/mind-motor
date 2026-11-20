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

fn operate(args: &[String]) -> Result<Value, &'static str> {
    let guard = ParentGuard::from_args(args)?;
    let mut input = io::stdin().lock();
    let mut line = Vec::new();
    (&mut input).take(MAX_REQUEST).read_until(b'\n', &mut line).map_err(io_code)?;
    if line.last() != Some(&b'\n') { return Err("COPY_FAILED"); }
    let request: Request = serde_json::from_slice(&line).map_err(|_| "COPY_FAILED")?;
    let (root, path, limit) = match &request {
        Request::Copy(copy) => (&copy.source_root, &copy.source_path, copy.max_bytes),
        Request::Verify(verify) if verify.verify_only => (&verify.source_root, &verify.source_path, verify.max_bytes),
        Request::Verify(_) => return Err("COPY_FAILED"),
    };
    if limit > MAX_BYTES { return Err("FILE_TOO_LARGE"); }
    let mut source = open_reader_without_writers(root, path)?;
    let before = fingerprint(&source).map_err(io_code)?;
    if before.size > limit { return Err("FILE_TOO_LARGE"); }
    let mut confirm = || {
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
        Request::Copy(copy) => {
            let mut hash = None;
            let mut result = text_write::create_stream(&copy.target_root, &copy.target_path, confirm, |destination| {
                let (count, digest) = transfer(&mut source, Some(destination), &before, limit)?;
                hash = Some(digest);
                Ok(count)
            })?;
            result["sha256"] = json!(hash.ok_or("COPY_FAILED")?);
            Ok(result)
        }
        Request::Verify(_) => {
            confirm()?;
            let (size, digest) = transfer(&mut source, None, &before, limit)?;
            Ok(json!({"size": size, "sha256": digest}))
        }
    }
}

pub(crate) fn run(args: &[String]) -> Result<(), String> {
    let outcome = operate(args).map_err(str::to_owned)?;
    serde_json::to_writer(io::stdout().lock(), &outcome).map_err(|_| "COPY_FAILED".into())
}
