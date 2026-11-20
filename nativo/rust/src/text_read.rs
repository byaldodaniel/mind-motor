use std::{
    fs::File,
    io::{self, BufRead, Read, Write},
    thread,
};

use serde::Deserialize;

const MAX_REQUEST_BYTES: u64 = 32_768;
const MAX_TEXT_BYTES: u64 = 1024 * 1024;
const SAFE_OPEN_UNAVAILABLE: &str = "SAFE_OPEN_UNAVAILABLE";
const READ_FAILED: &str = "READ_FAILED";
const FILE_TOO_LARGE: &str = "FILE_TOO_LARGE";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    root: String,
    relative_path: String,
}

pub(crate) fn run(args: &[String]) -> Result<(), String> {
    read_text(args).map_err(str::to_owned)
}

fn read_text(args: &[String]) -> Result<(), &'static str> {
    let [flag, pid] = args else {
        return Err(SAFE_OPEN_UNAVAILABLE);
    };
    if flag != "--parent-pid" {
        return Err(SAFE_OPEN_UNAVAILABLE);
    }
    let pid = pid
        .parse::<u32>()
        .ok()
        .filter(|pid| *pid > 1)
        .ok_or(SAFE_OPEN_UNAVAILABLE)?;
    parent::watch(pid)?;

    let mut input = io::stdin().lock();
    let request = request(&mut input)?;
    let file = crate::scan::open_reader(&request.root, &request.relative_path)?;
    {
        let mut diagnostic = io::stderr().lock();
        diagnostic.write_all(b"READY\n").map_err(|_| READ_FAILED)?;
        diagnostic.flush().map_err(|_| READ_FAILED)?;
    }

    // The host checks the grant again while this exact file remains open.
    let mut acknowledge = [0];
    input.read_exact(&mut acknowledge).map_err(|_| READ_FAILED)?;
    if acknowledge != *b"R" {
        return Err(READ_FAILED);
    }
    let bytes = contents(file)?;
    io::stdout().lock().write_all(&bytes).map_err(|_| READ_FAILED)
}

fn request(input: &mut impl BufRead) -> Result<Request, &'static str> {
    let mut line = Vec::new();
    input
        .take(MAX_REQUEST_BYTES)
        .read_until(b'\n', &mut line)
        .map_err(|_| READ_FAILED)?;
    if line.last() != Some(&b'\n') {
        return Err(READ_FAILED);
    }
    serde_json::from_slice(&line).map_err(|_| READ_FAILED)
}

fn contents(file: File) -> Result<Vec<u8>, &'static str> {
    if file.metadata().map_err(|_| READ_FAILED)?.len() > MAX_TEXT_BYTES {
        return Err(FILE_TOO_LARGE);
    }
    let mut bytes = Vec::new();
    file.take(MAX_TEXT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| READ_FAILED)?;
    if bytes.len() as u64 > MAX_TEXT_BYTES {
        return Err(FILE_TOO_LARGE);
    }
    Ok(bytes)
}

fn spawn_watch(watch: impl FnOnce() + Send + 'static) -> Result<(), &'static str> {
    thread::Builder::new()
        .name("mind-parent-guard".into())
        .spawn(watch)
        .map(|_| ())
        .map_err(|_| SAFE_OPEN_UNAVAILABLE)
}

#[cfg(unix)]
mod parent {
    use super::{spawn_watch, SAFE_OPEN_UNAVAILABLE};
    use std::{thread, time::Duration};

    pub(super) fn watch(expected: u32) -> Result<(), &'static str> {
        let parent = libc::pid_t::try_from(expected).map_err(|_| SAFE_OPEN_UNAVAILABLE)?;
        if unsafe { libc::getppid() } != parent {
            return Err(SAFE_OPEN_UNAVAILABLE);
        }
        spawn_watch(move || {
            while unsafe { libc::getppid() } == parent {
                thread::sleep(Duration::from_millis(250));
            }
            std::process::exit(74);
        })
    }
}

#[cfg(windows)]
mod parent {
    use super::{spawn_watch, SAFE_OPEN_UNAVAILABLE};
    use std::{
        mem::size_of,
        os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    };
    use windows_sys::Win32::{
        Foundation::{FILETIME, HANDLE, INVALID_HANDLE_VALUE, WAIT_TIMEOUT},
        System::{
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
                TH32CS_SNAPPROCESS,
            },
            Threading::{
                GetCurrentProcess, GetProcessTimes, OpenProcess, WaitForSingleObject, INFINITE,
                PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
            },
        },
    };

    pub(super) fn watch(expected: u32) -> Result<(), &'static str> {
        if actual_parent() != Some(expected) {
            return Err(SAFE_OPEN_UNAVAILABLE);
        }
        let handle = unsafe {
            OpenProcess(PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, 0, expected)
        };
        if handle.is_null() {
            return Err(SAFE_OPEN_UNAVAILABLE);
        }
        let parent = unsafe { OwnedHandle::from_raw_handle(handle) };
        // Strict ordering and an owned process handle guard against PID reuse.
        let parent_created = created(handle).ok_or(SAFE_OPEN_UNAVAILABLE)?;
        let child_created = created(unsafe { GetCurrentProcess() }).ok_or(SAFE_OPEN_UNAVAILABLE)?;
        if parent_created >= child_created || unsafe { WaitForSingleObject(handle, 0) } != WAIT_TIMEOUT {
            return Err(SAFE_OPEN_UNAVAILABLE);
        }
        spawn_watch(move || {
            unsafe { WaitForSingleObject(parent.as_raw_handle(), INFINITE) };
            std::process::exit(74);
        })
    }

    fn actual_parent() -> Option<u32> {
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
        if snapshot.is_null() || snapshot == INVALID_HANDLE_VALUE {
            return None;
        }
        let snapshot = unsafe { OwnedHandle::from_raw_handle(snapshot) };
        let mut entry = PROCESSENTRY32W { dwSize: size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        let pid = std::process::id();
        let mut available = unsafe { Process32FirstW(snapshot.as_raw_handle(), &mut entry) };
        while available != 0 {
            if entry.th32ProcessID == pid {
                return Some(entry.th32ParentProcessID);
            }
            available = unsafe { Process32NextW(snapshot.as_raw_handle(), &mut entry) };
        }
        None
    }

    fn created(handle: HANDLE) -> Option<u64> {
        let (mut creation, mut exit, mut kernel, mut user) = (
            FILETIME::default(), FILETIME::default(), FILETIME::default(), FILETIME::default()
        );
        if unsafe { GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) } == 0 {
            return None;
        }
        Some((u64::from(creation.dwHighDateTime) << 32) | u64::from(creation.dwLowDateTime))
    }
}

#[cfg(not(any(unix, windows)))]
mod parent {
    pub(super) fn watch(_: u32) -> Result<(), &'static str> {
        Err(super::SAFE_OPEN_UNAVAILABLE)
    }
}
