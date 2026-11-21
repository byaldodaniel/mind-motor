use std::{fs, io, path::Path};

use serde_json::json;
use uuid::Uuid;

use crate::{motor_permissions::read_json, text_write};

const LOCK: &str = "conector.lock";
const RECOVERY: &str = "conector.lock.recovery";

pub(crate) struct Owner {
    base: String,
    token: String,
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
        reject_barrier(base)?;
        let text = record.to_string();
        text_write::write_bytes(base, LOCK, text.as_bytes(), 16 * 1024, None, || reject_barrier(base))
            .map_err(|error| if error == "FILE_EXISTS" { "BASE_OCUPADA" } else { error })?;
        let owner = Self { base: base.to_owned(), token };
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
        if self.check().is_ok() {
            let _ = fs::remove_file(Path::new(&self.base).join(LOCK));
        }
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
    use windows_sys::Win32::{
        Foundation::{FILETIME, SYSTEMTIME},
        System::Threading::{GetCurrentProcess, GetProcessTimes},
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

    pub(crate) fn timestamp() -> Option<String> {
        let mut time = SYSTEMTIME::default();
        unsafe { GetSystemTime(&mut time) };
        Some(format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
            time.wYear, time.wMonth, time.wDay, time.wHour, time.wMinute, time.wSecond, time.wMilliseconds))
    }
}

#[cfg(windows)]
use windows::identity;
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
#[cfg(not(any(windows, unix)))]
pub(crate) fn timestamp() -> Option<String> {
    None
}
