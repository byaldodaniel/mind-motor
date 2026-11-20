use std::{
    fs::File,
    io::{self, BufRead, Read, Write},
    time::Duration,
};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{native_parent::ParentGuard, scan};

#[cfg(windows)]
#[path = "text_write_windows.rs"]
pub(crate) mod windows;

#[cfg(unix)]
#[path = "text_write_unix.rs"]
mod unix;

#[cfg(unix)]
use unix as platform;
#[cfg(windows)]
use windows as platform;

const DEFAULT_LIMIT: usize = 1024 * 1024;
const MAX_LIMIT: usize = 16 * DEFAULT_LIMIT;
const MAX_REQUEST: u64 = (3 * MAX_LIMIT) as u64;

type Result<T> = std::result::Result<T, &'static str>;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    root: String,
    relative_path: String,
    content: String,
    max_bytes: Option<usize>,
    expected: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Report {
    size: u64,
    modified_ms: Option<i64>,
    changed_ms: Option<i64>,
    created_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    identity: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    previous_identity: Option<String>,
}

impl Report {
    fn size_only(size: u64) -> Self {
        Self {
            size,
            modified_ms: None,
            changed_ms: None,
            created_ms: None,
            identity: None,
            previous_identity: None,
        }
    }
}

pub(crate) fn create(args: &[String]) -> std::result::Result<(), String> {
    run(args, false).map_err(str::to_owned)
}

pub(crate) fn modify(args: &[String]) -> std::result::Result<(), String> {
    run(args, true).map_err(str::to_owned)
}

#[cfg(any(unix, windows))]
fn run(args: &[String], replace: bool) -> Result<()> {
    let failed = if replace { "MODIFY_FAILED" } else { "CREATE_FAILED" };
    let guard = ParentGuard::from_args(args)?;
    let mut input = io::stdin().lock();
    let mut request = Vec::new();
    (&mut input).take(MAX_REQUEST).read_until(b'\n', &mut request).map_err(|_| failed)?;
    if request.last() != Some(&b'\n') {
        return Err(failed);
    }
    let request: Request = serde_json::from_slice(&request).map_err(|_| failed)?;
    let expected = match (replace, request.expected.as_deref()) {
        (false, None) => None,
        (true, Some(value)) if value.len() == 64
            && value.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)) => Some(value),
        _ => return Err(failed),
    };
    let limit = request.max_bytes.unwrap_or(DEFAULT_LIMIT).min(MAX_LIMIT);
    if limit == 0 {
        return Err(failed);
    }
    let data = STANDARD.decode(request.content).map_err(|_| failed)?;
    if data.len() > limit {
        return Err("TEXT_TOO_LARGE");
    }
    check_text(&data, "INVALID_TEXT")?;
    let (parent, name) = destination(&request.root, &request.relative_path, replace)?;
    let confirm = || -> Result<()> {
        {
            let mut diagnostic = io::stderr().lock();
            diagnostic.write_all(b"READY\n").map_err(|_| failed)?;
            diagnostic.flush().map_err(|_| failed)?;
        }
        let mut ack = [0];
        input.read_exact(&mut ack).map_err(|_| failed)?;
        if ack != *b"W" {
            return Err(failed);
        }
        guard.begin_commit(Duration::from_secs(10))
    };

    let report = match expected {
        Some(expected) => platform::modify_text(&parent, name, &data, limit, expected, confirm),
        None => platform::create_stream(&parent, name, confirm, |file| {
            file.write_all(&data).map_err(|error| platform::mapped(error, false))?;
            Ok(data.len() as u64)
        }),
    }?;
    serde_json::to_writer(io::stdout().lock(), &report)
        .map_err(|_| if replace { "MODIFY_UNCONFIRMED" } else { "CREATE_UNCONFIRMED" })
}

#[cfg(not(any(unix, windows)))]
fn run(_: &[String], _: bool) -> Result<()> {
    Err("SAFE_OPEN_UNAVAILABLE")
}

fn check_text(data: &[u8], invalid: &'static str) -> Result<()> {
    if data.contains(&0) || std::str::from_utf8(data).is_err() {
        return Err(invalid);
    }
    Ok(())
}

fn verify_text(file: &File, limit: usize, expected: &str) -> Result<()> {
    let mut current = Vec::new();
    file.take((limit + 1) as u64).read_to_end(&mut current).map_err(|_| "MODIFY_FAILED")?;
    if current.len() > limit {
        return Err("FILE_TOO_LARGE");
    }
    check_text(&current, "TEXT_UNREADABLE")?;
    if format!("{:x}", Sha256::digest(&current)) != expected {
        return Err("VERSION_CONFLICT");
    }
    Ok(())
}

fn destination<'a>(root: &str, relative: &'a str, replace: bool) -> Result<(File, &'a str)> {
    if relative.encode_utf16().count() > 4096
        || !relative.split('/').all(scan::reader_component)
    {
        return Err("UNSAFE_PATH");
    }
    let (ancestor, name) = relative.rsplit_once('/').unwrap_or(("", relative));
    let parent = scan::open_directory(root, ancestor).map_err(|code| match code {
        "FILE_NOT_FOUND" if !replace => "PARENT_NOT_FOUND",
        "READ_FAILED" if replace => "MODIFY_FAILED",
        "READ_FAILED" => "CREATE_FAILED",
        code => code,
    })?;
    Ok((parent, name))
}

#[cfg(any(unix, windows))]
pub(crate) fn create_stream(
    root: &str, relative: &str, confirm: impl FnOnce() -> Result<()>,
    transfer: impl FnOnce(&mut File) -> Result<u64>,
) -> Result<serde_json::Value> {
    let (parent, name) = destination(root, relative, false)?;
    let report = platform::create_stream(&parent, name, confirm, transfer)?;
    serde_json::to_value(report).map_err(|_| "CREATE_UNCONFIRMED")
}

#[cfg(not(any(unix, windows)))]
pub(crate) fn create_stream(
    _: &str, _: &str, _: impl FnOnce() -> Result<()>,
    _: impl FnOnce(&mut File) -> Result<u64>,
) -> Result<serde_json::Value> {
    Err("SAFE_OPEN_UNAVAILABLE")
}
