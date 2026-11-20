//! Confines an auxiliary native operation to its actual parent.
use std::{
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

const SAFE_OPEN_UNAVAILABLE: &str = "SAFE_OPEN_UNAVAILABLE";

#[derive(Clone)]
pub(crate) struct ParentGuard(Arc<Mutex<State>>);

#[derive(Default)]
struct State {
    parent_gone: bool,
    deadline: Option<Instant>,
}

impl ParentGuard {
    pub(crate) fn from_args(args: &[String]) -> Result<Self, &'static str> {
        let [flag, pid] = args else { return Err(SAFE_OPEN_UNAVAILABLE) };
        if flag != "--parent-pid" {
            return Err(SAFE_OPEN_UNAVAILABLE);
        }
        let pid = pid.parse::<u32>().ok().filter(|pid| *pid > 1).ok_or(SAFE_OPEN_UNAVAILABLE)?;
        let guard = Self(Arc::new(Mutex::new(State::default())));
        parent::watch(pid, guard.clone())?;
        Ok(guard)
    }

    pub(crate) fn begin_commit(&self, timeout: Duration) -> Result<(), &'static str> {
        if timeout.is_zero() || timeout > Duration::from_secs(120) {
            return Err(SAFE_OPEN_UNAVAILABLE);
        }
        let mut state = self.0.lock().map_err(|_| SAFE_OPEN_UNAVAILABLE)?;
        if state.parent_gone {
            return Err(SAFE_OPEN_UNAVAILABLE);
        }
        state.deadline.get_or_insert_with(|| Instant::now() + timeout);
        Ok(())
    }

    fn parent_exited(&self) -> ! {
        let remaining = self.0.lock().ok().and_then(|mut state| {
            state.parent_gone = true;
            state.deadline.map(|deadline| deadline.saturating_duration_since(Instant::now()))
        });
        if let Some(remaining) = remaining {
            thread::sleep(remaining);
        }
        std::process::exit(74)
    }
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
    use super::{spawn_watch, ParentGuard, SAFE_OPEN_UNAVAILABLE};
    use std::{thread, time::Duration};

    pub(super) fn watch(expected: u32, guard: ParentGuard) -> Result<(), &'static str> {
        let parent = libc::pid_t::try_from(expected).map_err(|_| SAFE_OPEN_UNAVAILABLE)?;
        if unsafe { libc::getppid() } != parent {
            return Err(SAFE_OPEN_UNAVAILABLE);
        }
        spawn_watch(move || {
            while unsafe { libc::getppid() } == parent {
                thread::sleep(Duration::from_millis(250));
            }
            guard.parent_exited();
        })
    }
}

#[cfg(windows)]
mod parent {
    use super::{spawn_watch, ParentGuard, SAFE_OPEN_UNAVAILABLE};
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

    pub(super) fn watch(expected: u32, guard: ParentGuard) -> Result<(), &'static str> {
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
            guard.parent_exited();
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
    pub(super) fn watch(_: u32, _: super::ParentGuard) -> Result<(), &'static str> {
        Err(super::SAFE_OPEN_UNAVAILABLE)
    }
}
