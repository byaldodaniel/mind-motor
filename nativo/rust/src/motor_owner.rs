use std::{
    ffi::OsString,
    fs::{self, File},
    io::{self, Read},
    path::{Path, PathBuf},
};

use serde_json::{json, Value};
use uuid::Uuid;

use crate::{motor_permissions::read_json, text_write};

const LOCK: &str = "conector.lock";
const RECOVERY: &str = "conector.lock.recovery";

pub(crate) struct Owner {
    base: String,
    token: String,
}

pub(crate) fn restore_lock_path(base: &Path) -> Option<PathBuf> {
    let parent = base.parent()?;
    let name = base.file_name()?;
    let mut lock_name = OsString::from(name);
    lock_name.push(".restauracion.lock");
    Some(parent.join(lock_name))
}

pub(crate) fn check_restore_lock_path(lock_path: &Path) -> Result<(), &'static str> {
    let meta = match fs::symlink_metadata(lock_path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err("BASE_RESTORING"),
        Ok(meta) => meta,
    };
    if !meta.is_file() {
        return Err("BASE_RESTORING");
    }
    let Ok(file) = File::open(lock_path) else {
        return Err("BASE_RESTORING");
    };
    let mut bytes = Vec::new();
    if file.take(16 * 1024 + 1).read_to_end(&mut bytes).is_err() || bytes.len() > 16 * 1024 {
        return Err("BASE_RESTORING");
    }
    let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
        return Err("BASE_RESTORING");
    };
    let Some((pid, host, birth, _token)) = lock_owner_fields(&value) else {
        return Err("BASE_RESTORING");
    };
    let Some((current_host, _)) = identity() else {
        return Err("BASE_RESTORING");
    };
    if host == current_host && is_stale_process(pid, birth) {
        Ok(())
    } else {
        Err("BASE_RESTORING")
    }
}

pub(crate) fn check_restore_lock(base: &str) -> Result<(), &'static str> {
    let Some(lock_path) = restore_lock_path(Path::new(base)) else {
        return Err("BASE_RESTORING");
    };
    check_restore_lock_path(&lock_path)
}

impl Owner {
    pub(crate) fn acquire(base: &str) -> Result<Self, String> {
        // Publica una identidad completa de la misma forma que una creación
        // normal. r3 puede distinguir este proceso de un PID reutilizado.
        let token = Uuid::new_v4().to_string();
        let (host, birth) = identity().ok_or("PROCESS_IDENTITY_UNKNOWN")?;
        let record = json!({
            "version": 2, "pid": std::process::id(), "host": host,
            "processBirth": birth, "token": token, "instanceToken": token,
            "startedAt": timestamp().ok_or("PROCESS_IDENTITY_UNKNOWN")?,
        });
        check_restore_lock(base)?;
        reject_barrier(base)?;
        let guard_write = || {
            reject_barrier(base)?;
            check_restore_lock(base)
        };
        let text = record.to_string();
        match text_write::write_bytes(base, LOCK, text.as_bytes(), 16 * 1024, None, guard_write) {
            Ok(_) => {}
            Err("FILE_EXISTS") if recover_abandoned(base, &host) => {
                text_write::write_bytes(base, LOCK, text.as_bytes(), 16 * 1024, None, guard_write)
                    .map_err(|error| if error == "FILE_EXISTS" { "BASE_OCUPADA" } else { error })?;
            }
            Err("FILE_EXISTS") => return Err("BASE_OCUPADA".into()),
            Err(error) => return Err(error.into()),
        }
        let owner = Self { base: base.to_owned(), token };
        if check_restore_lock(base).is_err() {
            drop(owner);
            return Err("BASE_RESTORING".into());
        }
        reject_barrier(base)?;
        owner.check()?;
        Ok(owner)
    }

    pub(crate) fn check(&self) -> Result<(), &'static str> {
        let entry = read_json(&self.base, LOCK).map_err(|_| "OWNER_LOCK_CHANGED")?;
        if entry.as_ref().and_then(|value| value["token"].as_str()) == Some(self.token.as_str()) {
            Ok(())
        } else {
            Err("OWNER_LOCK_CHANGED")
        }
    }
}

impl Drop for Owner {
    fn drop(&mut self) {
        if reject_barrier(&self.base).is_ok() && self.check().is_ok() {
            let _ = fs::remove_file(Path::new(&self.base).join(LOCK));
        }
    }
}

struct BarrierGuard(std::path::PathBuf);

impl Drop for BarrierGuard {
    fn drop(&mut self) {
        let _ = fs::remove_dir(&self.0);
    }
}

fn lock_owner_fields(value: &serde_json::Value) -> Option<(u32, &str, &str, &str)> {
    if value["version"].as_u64() != Some(2) {
        return None;
    }
    let pid = value["pid"].as_u64().and_then(|value| u32::try_from(value).ok()).filter(|&pid| pid >= 1)?;
    let host = value["host"].as_str().filter(|text| !text.is_empty())?;
    let birth = value["processBirth"].as_str().filter(|text| !text.is_empty())?;
    let token = value["token"].as_str().filter(|text| !text.is_empty())?;
    Some((pid, host, birth, token))
}

fn recover_abandoned(base: &str, current_host: &str) -> bool {
    if reject_barrier(base).is_err() {
        return false;
    }
    let Ok(Some(entry)) = read_json(base, LOCK) else {
        return false;
    };
    let Some((pid, host, birth, token)) = lock_owner_fields(&entry) else {
        return false;
    };
    if host != current_host || !is_stale_process(pid, birth) {
        return false;
    }
    let barrier_path = Path::new(base).join(RECOVERY);
    if fs::create_dir(&barrier_path).is_err() {
        return false;
    }
    let _guard = BarrierGuard(barrier_path);
    let Ok(Some(current)) = read_json(base, LOCK) else {
        return false;
    };
    let Some((cur_pid, cur_host, cur_birth, cur_token)) = lock_owner_fields(&current) else {
        return false;
    };
    if cur_pid != pid || cur_host != host || cur_birth != birth || cur_token != token {
        return false;
    }
    match fs::remove_file(Path::new(base).join(LOCK)) {
        Ok(()) => true,
        Err(error) if error.kind() == io::ErrorKind::NotFound => true,
        Err(_) => false,
    }
}

fn reject_barrier(base: &str) -> Result<(), &'static str> {
    match fs::symlink_metadata(Path::new(base).join(RECOVERY)) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Ok(_) => Err("BASE_OCUPADA"),
        Err(_) => Err("BASE_NO_VERIFICADA"),
    }
}

#[cfg(windows)]
mod windows {
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use windows_sys::Win32::{
        Foundation::{GetLastError, FILETIME, SYSTEMTIME, WAIT_OBJECT_0, WAIT_TIMEOUT},
        System::Threading::{
            GetCurrentProcess, GetProcessTimes, OpenProcess, WaitForSingleObject,
            PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
        },
    };

    #[link(name = "kernel32")]
    extern "system" {
        fn GetComputerNameExW(kind: i32, buffer: *mut u16, size: *mut u32) -> i32;
        fn GetSystemTime(time: *mut SYSTEMTIME);
    }

    pub(super) fn identity() -> Option<(String, String)> {
        let mut hostname = [0u16; 256];
        let mut length = hostname.len() as u32;
        if unsafe { GetComputerNameExW(1, hostname.as_mut_ptr(), &mut length) } == 0 {
            return None;
        }
        let host = String::from_utf16(&hostname[..length as usize]).ok()?;
        let (mut birth, mut exit, mut kernel, mut user) = (FILETIME::default(), FILETIME::default(), FILETIME::default(), FILETIME::default());
        if unsafe { GetProcessTimes(GetCurrentProcess(), &mut birth, &mut exit, &mut kernel, &mut user) } == 0 {
            return None;
        }
        let ticks = (u64::from(birth.dwHighDateTime) << 32) | u64::from(birth.dwLowDateTime);
        Some((host, format!("win32:{ticks}")))
    }

    pub(super) fn is_stale_process(pid: u32, process_birth: &str) -> bool {
        let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if handle.is_null() {
            return unsafe { GetLastError() } == 87;
        }
        let handle = unsafe { OwnedHandle::from_raw_handle(handle) };
        let wait = unsafe { WaitForSingleObject(handle.as_raw_handle(), 0) };
        if wait == WAIT_OBJECT_0 {
            return true;
        }
        if wait != WAIT_TIMEOUT {
            return false;
        }
        let (mut birth, mut exit, mut kernel, mut user) = (
            FILETIME::default(), FILETIME::default(), FILETIME::default(), FILETIME::default(),
        );
        if unsafe { GetProcessTimes(handle.as_raw_handle(), &mut birth, &mut exit, &mut kernel, &mut user) } == 0 {
            return false;
        }
        let ticks = (u64::from(birth.dwHighDateTime) << 32) | u64::from(birth.dwLowDateTime);
        format!("win32:{ticks}") != process_birth
    }

    pub(crate) fn timestamp() -> Option<String> {
        let mut time = SYSTEMTIME::default();
        unsafe { GetSystemTime(&mut time) };
        Some(format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
            time.wYear, time.wMonth, time.wDay, time.wHour, time.wMinute, time.wSecond, time.wMilliseconds))
    }
}

#[cfg(windows)]
use windows::{identity, is_stale_process};
#[cfg(windows)]
pub(crate) use windows::timestamp;

#[cfg(target_os = "linux")]
fn identity() -> Option<(String, String)> {
    let mut hostname = [0u8; 256];
    if unsafe { libc::gethostname(hostname.as_mut_ptr().cast(), hostname.len()) } != 0 {
        return None;
    }
    let length = hostname.iter().position(|byte| *byte == 0)?;
    let host = String::from_utf8(hostname[..length].to_vec()).ok()?;
    let boot = fs::read_to_string("/proc/sys/kernel/random/boot_id").ok()?;
    let stat = fs::read_to_string("/proc/self/stat").ok()?;
    let birth = stat.rsplit_once(')')?.1.split_whitespace().nth(19)?;
    Some((host, format!("linux:{}:{birth}", boot.trim())))
}

#[cfg(target_os = "linux")]
fn is_stale_process(pid: u32, process_birth: &str) -> bool {
    let stat = match fs::read_to_string(format!("/proc/{pid}/stat")) {
        Ok(content) => content,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return true,
        Err(_) => return false,
    };
    let Some((_, rest)) = stat.rsplit_once(')') else {
        return false;
    };
    let parts: Vec<&str> = rest.split_whitespace().collect();
    let Some(state) = parts.first().copied() else {
        return false;
    };
    if matches!(state, "Z" | "X") {
        return true;
    }
    let Some(birth) = parts.get(19).copied() else {
        return false;
    };
    let Ok(boot) = fs::read_to_string("/proc/sys/kernel/random/boot_id") else {
        return false;
    };
    format!("linux:{}:{birth}", boot.trim()) != process_birth
}

#[cfg(unix)]
pub(crate) fn timestamp() -> Option<String> {
    use std::time::{SystemTime, UNIX_EPOCH};

    let elapsed = SystemTime::now().duration_since(UNIX_EPOCH).ok()?;
    let seconds = elapsed.as_secs().try_into().ok()?;
    let mut time = std::mem::MaybeUninit::<libc::tm>::uninit();
    if unsafe { libc::gmtime_r(&seconds, time.as_mut_ptr()) }.is_null() {
        return None;
    }
    let time = unsafe { time.assume_init() };
    Some(format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        time.tm_year + 1900, time.tm_mon + 1, time.tm_mday, time.tm_hour,
        time.tm_min, time.tm_sec, elapsed.subsec_millis()))
}

#[cfg(not(any(windows, target_os = "linux")))]
fn identity() -> Option<(String, String)> {
    None
}
#[cfg(not(any(windows, target_os = "linux")))]
fn is_stale_process(_pid: u32, _process_birth: &str) -> bool {
    false
}
#[cfg(not(any(windows, unix)))]
pub(crate) fn timestamp() -> Option<String> {
    None
}
