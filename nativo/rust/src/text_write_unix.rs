use std::{
    ffi::CString,
    fs::File,
    io,
    mem::MaybeUninit,
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::fs::MetadataExt,
    },
    time::UNIX_EPOCH,
};

#[cfg(any(target_os = "linux", target_os = "macos"))]
use {super::verify_text, std::io::Write};

use uuid::Uuid;

use super::{Report, Result};

fn os_result(value: libc::c_int) -> io::Result<()> {
    if value == -1 { Err(io::Error::last_os_error()) } else { Ok(()) }
}

fn named(parent: &File, name: &CString) -> io::Result<Option<libc::stat>> {
    let mut info = MaybeUninit::uninit();
    let result = unsafe {
        libc::fstatat(parent.as_raw_fd(), name.as_ptr(), info.as_mut_ptr(), libc::AT_SYMLINK_NOFOLLOW)
    };
    match os_result(result) {
        Ok(()) => Ok(Some(unsafe { info.assume_init() })),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn same(file: &File, parent: &File, name: &CString) -> io::Result<bool> {
    let held = file.metadata()?;
    Ok(named(parent, name)?.is_some_and(|named| {
        held.dev() == named.st_dev as u64 && held.ino() == named.st_ino as u64
    }))
}

// Darwin's mode_t is narrower than the C variadic argument to openat.
fn open_at(parent: &File, name: &CString, flags: i32, mode: libc::c_uint) -> io::Result<File> {
    let flags = flags | libc::O_CLOEXEC | libc::O_NOFOLLOW;
    let fd = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), flags, mode) };
    os_result(fd)?;
    Ok(unsafe { File::from_raw_fd(fd) })
}

fn unlink(parent: &File, name: &CString) -> io::Result<()> {
    os_result(unsafe { libc::unlinkat(parent.as_raw_fd(), name.as_ptr(), 0) })
}

pub(super) fn mapped(error: io::Error, replace: bool) -> &'static str {
    match error.raw_os_error() {
        Some(libc::ENOSPC) => "NO_SPACE",
        Some(libc::ELOOP | libc::ENOTDIR | libc::EXDEV) => "UNSAFE_PATH",
        _ if error.kind() == io::ErrorKind::NotFound && replace => "FILE_NOT_FOUND",
        _ if error.kind() == io::ErrorKind::NotFound => "PARENT_NOT_FOUND",
        _ if error.kind() == io::ErrorKind::AlreadyExists && !replace => "FILE_EXISTS",
        _ if error.kind() == io::ErrorKind::PermissionDenied => "ACCESS_DENIED",
        _ if replace => "MODIFY_FAILED",
        _ => "CREATE_FAILED",
    }
}

fn report(file: &File, previous_identity: Option<String>) -> io::Result<Report> {
    let info = file.metadata()?;
    let milliseconds = |seconds: i64, ns: i64| seconds.checked_mul(1000)?.checked_add(ns / 1_000_000);
    Ok(Report {
        size: info.len(),
        modified_ms: milliseconds(info.mtime(), info.mtime_nsec()),
        changed_ms: milliseconds(info.ctime(), info.ctime_nsec()),
        created_ms: info.created().ok().and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .and_then(|duration| duration.as_millis().try_into().ok()),
        identity: Some(format!("posix:{}:{}", info.dev(), info.ino())),
        previous_identity,
    })
}

fn check_file(file: &File, parent: &File, replace: bool) -> Result<std::fs::Metadata> {
    let info = file.metadata().map_err(|err| mapped(err, replace))?;
    let volume = parent.metadata().map_err(|err| mapped(err, replace))?.dev();
    if !info.is_file() || info.nlink() != 1 || info.dev() != volume {
        return Err("UNSAFE_PATH");
    }
    Ok(info)
}

struct Temporary<'a> {
    parent: &'a File,
    name: CString,
    file: File,
    published: bool,
}

impl<'a> Temporary<'a> {
    fn new(parent: &'a File, replace: bool) -> Result<Self> {
        let prefix = if replace { "modify" } else { "create" };
        let name = CString::new(format!(".mind-{prefix}-{}.tmp", Uuid::new_v4().simple())).unwrap();
        let file = open_at(
            parent, &name, libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
            if replace { 0o600 } else { 0o666 },
        ).map_err(|error| mapped(error, replace))?;
        Ok(Self { parent, name, file, published: false })
    }

    fn check_name(&self, replace: bool) -> Result<()> {
        if !same(&self.file, self.parent, &self.name).map_err(|err| mapped(err, replace))? {
            return Err("UNSAFE_PATH");
        }
        Ok(())
    }
}

impl Drop for Temporary<'_> {
    fn drop(&mut self) {
        if !self.published && same(&self.file, self.parent, &self.name).unwrap_or(false) {
            let _ = unlink(self.parent, &self.name);
        }
    }
}

pub(super) fn create_stream(
    parent: &File, name: &str, confirm: impl FnOnce() -> Result<()>,
    transfer: impl FnOnce(&mut File) -> Result<u64>,
) -> Result<Report> {
    let name = CString::new(name).map_err(|_| "UNSAFE_PATH")?;
    if named(parent, &name).map_err(|error| mapped(error, false))?.is_some() {
        return Err("FILE_EXISTS");
    }
    confirm()?;
    let mut temp = Temporary::new(parent, false)?;
    check_file(&temp.file, parent, false)?;
    let size = transfer(&mut temp.file)?;
    if temp.file.metadata().map_err(|error| mapped(error, false))?.len() != size {
        return Err("CREATE_FAILED");
    }
    temp.file.sync_all().map_err(|error| mapped(error, false))?;
    temp.check_name(false)?;
    os_result(unsafe {
        libc::linkat(parent.as_raw_fd(), temp.name.as_ptr(), parent.as_raw_fd(), name.as_ptr(), 0)
    }).map_err(|error| mapped(error, false))?;
    if let Err(error) = unlink(parent, &temp.name) {
        if same(&temp.file, parent, &name).unwrap_or(false) {
            let _ = unlink(parent, &name);
        }
        return Err(mapped(error, false));
    }
    temp.published = true;
    let _ = parent.sync_all();
    Ok(report(&temp.file, None).unwrap_or_else(|_| Report::size_only(size)))
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn preserve_metadata(file: &File, info: &std::fs::Metadata) -> Result<()> {
    if info.mode() & 0o200 == 0 {
        return Err("ACCESS_DENIED");
    }
    if info.mode() & 0o7000 != 0 || info.uid() != unsafe { libc::geteuid() } {
        return Err("METADATA_NOT_PRESERVABLE");
    }
    platform_metadata(file)
}

#[cfg(target_os = "linux")]
fn platform_metadata(file: &File) -> Result<()> {
    let mut tags = vec![0u8; 65_536];
    let size = unsafe { libc::flistxattr(file.as_raw_fd(), tags.as_mut_ptr().cast(), tags.len()) };
    if size < 0 {
        return if io::Error::last_os_error().raw_os_error() == Some(libc::ENOTSUP) {
            Ok(())
        } else {
            Err("METADATA_NOT_PRESERVABLE")
        };
    }
    if tags[..size as usize].split(|&byte| byte == 0)
        .any(|tag| !tag.is_empty() && tag != b"security.selinux")
    {
        return Err("METADATA_NOT_PRESERVABLE");
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn platform_metadata(file: &File) -> Result<()> {
    use std::{ffi::c_void, ptr};

    unsafe extern "C" {
        fn acl_get_fd_np(fd: libc::c_int, kind: libc::c_int) -> *mut c_void;
        fn acl_free(acl: *mut c_void) -> libc::c_int;
    }

    const ACL_TYPE_EXTENDED: libc::c_int = 0x100;
    let fd = file.as_raw_fd();
    let mut info = MaybeUninit::<libc::stat>::uninit();
    os_result(unsafe { libc::fstat(fd, info.as_mut_ptr()) })
        .map_err(|_| "METADATA_NOT_PRESERVABLE")?;
    if unsafe { info.assume_init().st_flags } != 0 {
        return Err("METADATA_NOT_PRESERVABLE");
    }
    let attributes = unsafe {
        libc::flistxattr(fd, ptr::null_mut(), 0, libc::XATTR_SHOWCOMPRESSION)
    };
    if attributes != 0 {
        return Err("METADATA_NOT_PRESERVABLE");
    }
    let acl = unsafe { acl_get_fd_np(fd, ACL_TYPE_EXTENDED) };
    if !acl.is_null() {
        unsafe { acl_free(acl) };
        return Err("METADATA_NOT_PRESERVABLE");
    }
    // Darwin returns ENOENT for a descriptor with no extended ACL.
    if io::Error::last_os_error().raw_os_error() != Some(libc::ENOENT) {
        return Err("METADATA_NOT_PRESERVABLE");
    }
    Ok(())
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn written_attributes(file: &File, original: &std::fs::Metadata) -> Result<()> {
    let mode = (original.mode() & 0o777) as libc::mode_t;
    let group = file.metadata().map_err(|_| "METADATA_NOT_PRESERVABLE")?.gid();
    if group != original.gid() {
        os_result(unsafe { libc::fchown(file.as_raw_fd(), !0, original.gid()) })
            .map_err(|_| "METADATA_NOT_PRESERVABLE")?;
    }
    os_result(unsafe { libc::fchmod(file.as_raw_fd(), mode) })
        .map_err(|_| "METADATA_NOT_PRESERVABLE")?;
    let result = file.metadata().map_err(|_| "METADATA_NOT_PRESERVABLE")?;
    if result.uid() != original.uid() || result.gid() != original.gid() || result.mode() & 0o777 != original.mode() & 0o777 {
        return Err("METADATA_NOT_PRESERVABLE");
    }
    Ok(())
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
type Snapshot = (u64, u64, u64, i64, i64, i64, i64);

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn snapshot(info: &std::fs::Metadata) -> Snapshot {
    (info.dev(), info.ino(), info.len(), info.mtime(), info.mtime_nsec(), info.ctime(), info.ctime_nsec())
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn matches_snapshot(info: libc::stat, old: Snapshot) -> bool {
    info.st_mode & libc::S_IFMT == libc::S_IFREG && info.st_nlink == 1
        && (info.st_dev as u64, info.st_ino as u64, info.st_size as u64, info.st_mtime as i64,
            info.st_mtime_nsec as i64, info.st_ctime as i64, info.st_ctime_nsec as i64) == old
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
pub(super) fn modify_text(
    parent: &File, name: &str, data: &[u8], limit: usize, expected: &str,
    confirm: impl FnOnce() -> Result<()>,
) -> Result<Report> {
    let name = CString::new(name).map_err(|_| "UNSAFE_PATH")?;
    let target = open_at(parent, &name, libc::O_RDONLY | libc::O_NONBLOCK, 0)
        .map_err(|error| mapped(error, true))?;
    check_file(&target, parent, true)?;
    os_result(unsafe { libc::flock(target.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) })
        .map_err(|error| match error.raw_os_error() {
            Some(libc::EACCES | libc::EAGAIN) => "FILE_IN_USE",
            _ => mapped(error, true),
        })?;
    if !same(&target, parent, &name).map_err(|error| mapped(error, true))? {
        return Err("VERSION_CONFLICT");
    }
    let before_read = snapshot(&check_file(&target, parent, true)?);
    verify_text(&target, limit, expected)?;
    let info = check_file(&target, parent, true)?;
    if snapshot(&info) != before_read {
        return Err("VERSION_CONFLICT");
    }
    preserve_metadata(&target, &info)?;
    let old = snapshot(&info);
    let old_identity = Some(format!("posix:{}:{}", info.dev(), info.ino()));
    confirm()?;

    let mut temp = Temporary::new(parent, true)?;
    check_file(&temp.file, parent, true)?;
    written_attributes(&temp.file, &info)?;
    temp.file.write_all(data).and_then(|_| temp.file.sync_all())
        .map_err(|error| mapped(error, true))?;
    #[cfg(target_os = "macos")]
    platform_metadata(&temp.file)?;
    let still_named = named(parent, &name).map_err(|error| mapped(error, true))?
        .is_some_and(|info| matches_snapshot(info, old));
    let still_held = snapshot(&check_file(&target, parent, true)?) == old;
    if !still_named || !still_held {
        return Err("VERSION_CONFLICT");
    }
    temp.check_name(true)?;
    os_result(unsafe {
        libc::renameat(parent.as_raw_fd(), temp.name.as_ptr(), parent.as_raw_fd(), name.as_ptr())
    }).map_err(|error| mapped(error, true))?;
    temp.published = true;
    let _ = parent.sync_all();
    // A non-cooperating Unix writer can race ordinary renameat(). Only
    // report success when we can confirm that we replaced the held inode.
    if target.metadata().map_err(|_| "MODIFY_UNCONFIRMED")?.nlink() != 0
        || !same(&temp.file, parent, &name).map_err(|_| "MODIFY_UNCONFIRMED")?
    {
        return Err("MODIFY_UNCONFIRMED");
    }
    Ok(report(&temp.file, old_identity).unwrap_or_else(|_| Report::size_only(data.len() as u64)))
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub(super) fn modify_text(
    _: &File, _: &str, _: &[u8], _: usize, _: &str, _: impl FnOnce() -> Result<()>,
) -> Result<Report> {
    // An overwrite is unsafe until this platform can attest original ACLs
    // and extended attributes and preserve the metadata it admits.
    Err("SAFE_OPEN_UNAVAILABLE")
}
