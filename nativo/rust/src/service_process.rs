//! Owns a local application's process tree and verifies its readiness.
use std::{fs, io, path::{Path, PathBuf}, time::Duration};

use reqwest::Client;
use serde_json::{json, Value};
use tokio::{process::{Child, Command}, time::{sleep, timeout, Instant}};
use uuid::Uuid;

use crate::{bridge::regular_json, build_recipe::Recipe};

const READY_HEADER: &str = "x-mind-listo";
const PROBE_INTERVAL: Duration = Duration::from_millis(50);
const PROBE_TIMEOUT: Duration = Duration::from_millis(500);
const STOP_TIMEOUT: Duration = Duration::from_secs(3);

struct Scratch(PathBuf);

impl Scratch {
    fn new() -> io::Result<Self> {
        let root = std::env::temp_dir().canonicalize()?;
        let directory = root.join(format!("mind-servicio-{}", Uuid::new_v4()));
        fs::create_dir(&directory)?;
        Ok(Self(directory))
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        // This unique directory was created by this attempt.
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub(crate) struct ServiceProcess {
    tree: platform::Tree,
    child: Child,
    pid: u32,
    port: u16,
    challenge: String,
    stopping: bool,
    _temp: Scratch,
}

impl ServiceProcess {
    pub(crate) async fn start(
        recipe: &Recipe, copy: &Path, database: &Path, client: &Client,
    ) -> Result<Self, String> {
        let temp = Scratch::new().map_err(|error| format!("No se pudo preparar el servicio: {error}"))?;
        let ready_file = temp.0.join("listo.json");
        let challenge = Uuid::new_v4().simple().to_string();
        let mut command = recipe.command(copy, &temp.0)?;
        command
            .env("MIND_SQLITE", database)
            .env("MIND_HOST", "127.0.0.1")
            .env("MIND_PORT", "0")
            .env("MIND_LISTO", &ready_file)
            .env("MIND_LISTO_TOKEN", &challenge)
            .kill_on_drop(true);
        let (child, tree, pid) = platform::Tree::spawn(command)
            .map_err(|error| format!("No se pudo iniciar el servicio local: {error}"))?;
        let mut service = Self { tree, child, pid, port: 0, challenge, stopping: false, _temp: temp };
        let ready = timeout(recipe.deadline(), async {
            loop {
                if service.tree.active().is_ok_and(|active| !active) {
                    return Err("El proceso de la aplicación terminó antes de estar listo.");
                }
                service.port = regular_json(&ready_file)
                    .and_then(|value| u16::try_from(value["puerto"].as_u64()?).ok())
                    .unwrap_or(0);
                if service.port != 0 && service.healthy(client).await {
                    return Ok(());
                }
                sleep(PROBE_INTERVAL).await;
            }
        }).await;

        let motivo = match ready {
            Ok(Ok(())) => return Ok(service),
            Ok(Err(motivo)) => motivo,
            Err(_) => "La aplicación no confirmó su estado de salud dentro del plazo.",
        };
        match service.stop().await {
            Ok(()) => Err(motivo.into()),
            Err(error) => Err(format!("{motivo} {error}")),
        }
    }

    pub(crate) fn port(&self) -> u16 { self.port }

    pub(crate) fn pid(&self) -> u32 { self.pid }

    pub(crate) async fn healthy(&self, client: &Client) -> bool {
        let url = format!("http://127.0.0.1:{}/health", self.port);
        // The challenge is only delivered to the app through its environment.
        // A different listener at the reported port cannot provide it.
        let response = client.get(&url).timeout(PROBE_TIMEOUT).send().await;
        response.is_ok_and(|reply| reply.status().is_success()
            && reply.url().as_str() == url
            && reply.headers().get(READY_HEADER)
                .is_some_and(|header| header.as_bytes() == self.challenge.as_bytes()))
    }

    pub(crate) fn resources(&self) -> Value {
        let (processes, memory) = self.tree.resources();
        json!({"procesos": processes, "memoria_bytes": memory})
    }

    pub(crate) async fn stop(mut self) -> Result<(), String> {
        self.tree.terminate().map_err(|error| format!("No se pudo cerrar el servicio: {error}"))?;
        self.stopping = true;
        let deadline = Instant::now() + STOP_TIMEOUT;
        tokio::time::timeout_at(deadline, self.child.wait()).await
            .map_err(|_| "El proceso de la aplicación no confirmó su cierre.".to_owned())?
            .map_err(|error| format!("No se pudo confirmar el cierre: {error}"))?;
        confirm_group_exit(deadline, || self.tree.active()).await
    }
}

async fn confirm_group_exit(deadline: Instant, mut active: impl FnMut() -> io::Result<bool>) -> Result<(), String> {
    loop {
        match active() {
            Ok(false) => return Ok(()),
            Ok(true) if Instant::now() >= deadline =>
                return Err("El grupo de procesos de la aplicación sigue activo.".into()),
            Ok(true) => {}
            // Darwin can report EPERM while the group's last members are zombies.
            // Only a subsequent negative probe confirms the group has disappeared.
            Err(error) if error.kind() == io::ErrorKind::PermissionDenied && Instant::now() < deadline => {}
            Err(error) => return Err(format!("No se pudo comprobar el cierre del grupo: {error}")),
        }
        tokio::time::sleep_until(deadline.min(Instant::now() + PROBE_INTERVAL)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn group_exit_requires_confirmation_after_permission_denied() {
        let mut probes = [Err(io::ErrorKind::PermissionDenied.into()), Ok(true), Ok(false)].into_iter();
        assert!(confirm_group_exit(Instant::now() + STOP_TIMEOUT, || probes.next().unwrap()).await.is_ok());
        assert!(probes.next().is_none());

        let error = confirm_group_exit(Instant::now(), || Err(io::ErrorKind::PermissionDenied.into())).await.unwrap_err();
        assert!(error.contains("No se pudo comprobar"));
        assert!(confirm_group_exit(Instant::now(), || Ok(true)).await.is_err());
    }
}

impl Drop for ServiceProcess {
    fn drop(&mut self) {
        // On Unix the leader must still be an owned, unreaped child when the
        // group is first signalled. On Windows the job handle closes as well.
        if !self.stopping {
            let _ = self.tree.terminate();
        }
    }
}

#[cfg(windows)]
mod platform {
    use super::{Child, Command, io};
    use std::{ffi::c_void, mem::size_of, os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle}};
    use windows_sys::Win32::{
        Foundation::{HANDLE, INVALID_HANDLE_VALUE},
        System::{
            Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32},
            JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, IsProcessInJob, JobObjectBasicAccountingInformation,
                JobObjectBasicProcessIdList, JobObjectExtendedLimitInformation, QueryInformationJobObject,
                SetInformationJobObject, TerminateJobObject, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
                JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            },
            ProcessStatus::{K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS},
            Threading::{
                GetProcessIdOfThread, OpenProcess, OpenThread, ResumeThread, CREATE_NO_WINDOW, CREATE_SUSPENDED,
                PROCESS_QUERY_LIMITED_INFORMATION, THREAD_QUERY_LIMITED_INFORMATION, THREAD_SUSPEND_RESUME,
            },
        },
    };

    pub(super) struct Tree(OwnedHandle);

    impl Tree {
        pub(super) fn spawn(mut command: Command) -> io::Result<(Child, Self, u32)> {
            let job = Self(owned(unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) })?);
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            check(unsafe { SetInformationJobObject(job.handle(), JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32) })?;

            // Application code can only run after its suspended process has
            // joined the job. If any setup step fails, kill_on_drop owns it.
            let child = command.creation_flags(CREATE_SUSPENDED | CREATE_NO_WINDOW).spawn()?;
            let pid = child.id().ok_or_else(|| io::Error::other("Falta el proceso hijo"))?;
            let handle = child.raw_handle().ok_or_else(|| io::Error::other("Falta el descriptor del proceso hijo"))?;
            check(unsafe { AssignProcessToJobObject(job.handle(), handle) })?;
            resume_initial_thread(pid)?;
            Ok((child, job, pid))
        }

        pub(super) fn terminate(&self) -> io::Result<()> {
            check(unsafe { TerminateJobObject(self.handle(), 1) })
        }

        pub(super) fn active(&self) -> io::Result<bool> {
            self.process_count().map(|total| total != 0)
        }

        pub(super) fn resources(&self) -> (Option<u32>, Option<u64>) {
            let count = self.process_count().ok();
            if count == Some(0) {
                return (count, Some(0));
            }
            let mut ids = ProcessIds { assigned: 0, count: 0, ids: [0; 256] };
            let valid = self.query(JobObjectBasicProcessIdList, &mut ids).is_ok()
                && ids.count == ids.assigned && Some(ids.count) == count;
            let memory = valid.then(|| ids.ids.get(..ids.count as usize))
                .flatten()
                .and_then(|pids| pids.iter().try_fold(0_u64, |sum, pid| {
                    sum.checked_add(self.working_set(u32::try_from(*pid).ok()?)?)
                }));
            (count, memory)
        }

        fn process_count(&self) -> io::Result<u32> {
            let mut state = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
            self.query(JobObjectBasicAccountingInformation, &mut state)?;
            Ok(state.ActiveProcesses)
        }

        fn query<T>(&self, class: i32, value: &mut T) -> io::Result<()> {
            check(unsafe { QueryInformationJobObject(self.handle(), class, (value as *mut T).cast::<c_void>(),
                size_of::<T>() as u32, std::ptr::null_mut()) })
        }

        fn working_set(&self, pid: u32) -> Option<u64> {
            let process = owned(unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) }).ok()?;
            let mut in_job = 0;
            check(unsafe { IsProcessInJob(process.as_raw_handle(), self.handle(), &mut in_job) }).ok()?;
            if in_job == 0 { return None; }
            let size = size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
            let mut counters = PROCESS_MEMORY_COUNTERS { cb: size, ..Default::default() };
            check(unsafe { K32GetProcessMemoryInfo(process.as_raw_handle(), &mut counters, size) }).ok()?;
            Some(counters.WorkingSetSize as u64)
        }

        fn handle(&self) -> HANDLE { self.0.as_raw_handle() }
    }

    #[repr(C)]
    struct ProcessIds {
        assigned: u32,
        count: u32,
        ids: [usize; 256],
    }

    fn resume_initial_thread(pid: u32) -> io::Result<()> {
        // Command closes the initial thread handle. A just-created suspended
        // process still has its single initial thread in the system snapshot.
        let snapshot = owned(unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) })?;
        let mut entry = THREADENTRY32 { dwSize: size_of::<THREADENTRY32>() as u32, ..Default::default() };
        check(unsafe { Thread32First(snapshot.as_raw_handle(), &mut entry) })?;
        loop {
            if entry.th32OwnerProcessID == pid {
                let thread = owned(unsafe { OpenThread(THREAD_QUERY_LIMITED_INFORMATION | THREAD_SUSPEND_RESUME,
                    0, entry.th32ThreadID) })?;
                if unsafe { GetProcessIdOfThread(thread.as_raw_handle()) } != pid {
                    return Err(io::Error::other("El hilo no corresponde al proceso hijo"));
                }
                return match unsafe { ResumeThread(thread.as_raw_handle()) } {
                    1 => Ok(()),
                    u32::MAX => Err(io::Error::last_os_error()),
                    _ => Err(io::Error::other("El hilo inicial no estaba suspendido")),
                };
            }
            entry.dwSize = size_of::<THREADENTRY32>() as u32;
            if unsafe { Thread32Next(snapshot.as_raw_handle(), &mut entry) } == 0 {
                return Err(io::Error::other("No se encontró el hilo inicial suspendido"));
            }
        }
    }

    fn owned(handle: HANDLE) -> io::Result<OwnedHandle> {
        if handle.is_null() || handle == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        Ok(unsafe { OwnedHandle::from_raw_handle(handle) })
    }

    fn check(value: i32) -> io::Result<()> {
        if value == 0 { Err(io::Error::last_os_error()) } else { Ok(()) }
    }
}

#[cfg(unix)]
mod platform {
    use super::{Child, Command, io};

    pub(super) struct Tree(libc::pid_t);

    impl Tree {
        pub(super) fn spawn(mut command: Command) -> io::Result<(Child, Self, u32)> {
            let child = command.process_group(0).spawn()?;
            let pid = child.id().ok_or_else(|| io::Error::other("Falta el proceso hijo"))?;
            let group = libc::pid_t::try_from(pid).map_err(io::Error::other)?;
            Ok((child, Self(group), pid))
        }

        pub(super) fn terminate(&self) -> io::Result<()> {
            self.signal(libc::SIGKILL).map(|_| ())
        }

        pub(super) fn active(&self) -> io::Result<bool> {
            #[cfg(target_os = "linux")]
            if let Some((count, _)) = linux_resources(self.0) {
                return Ok(count != 0);
            }
            self.signal(0)
        }

        pub(super) fn resources(&self) -> (Option<u32>, Option<u64>) {
            #[cfg(target_os = "linux")]
            if let Some((count, memory)) = linux_resources(self.0) {
                return (Some(count), memory);
            }
            (None, None)
        }

        fn signal(&self, signal: libc::c_int) -> io::Result<bool> {
            if unsafe { libc::kill(-self.0, signal) } == 0 {
                return Ok(true);
            }
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::ESRCH) { Ok(false) } else { Err(error) }
        }
    }

    #[cfg(target_os = "linux")]
    fn linux_resources(group: libc::pid_t) -> Option<(u32, Option<u64>)> {
        let mut count = 0u32;
        let mut pages = 0u64;
        for entry in std::fs::read_dir("/proc").ok()?.flatten() {
            if entry.file_name().to_string_lossy().parse::<u32>().is_err() { continue; }
            let Ok(stat) = std::fs::read_to_string(entry.path().join("stat")) else { continue; };
            let Some((_, fields)) = stat.rsplit_once(')') else { continue; };
            let mut fields = fields.split_whitespace();
            let state = fields.next();
            let process_group = fields.nth(1).and_then(|id| id.parse::<libc::pid_t>().ok());
            if process_group != Some(group) || matches!(state, Some("Z" | "X")) { continue; }
            count = count.saturating_add(1);
            pages = pages.saturating_add(fields.nth(18).and_then(|rss| rss.parse::<u64>().ok()).unwrap_or(0));
        }
        let page_size = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
        Some((count, u64::try_from(page_size).ok().and_then(|size| pages.checked_mul(size))))
    }
}
