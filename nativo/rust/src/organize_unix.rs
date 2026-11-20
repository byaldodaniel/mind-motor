use super::{Entry, Identity, Result};
use serde_json::{json, Value};
use std::{ffi::{CStr, CString}, fs::File, io, mem, os::fd::{AsRawFd, FromRawFd}};

const FLAGS: i32 = libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK;
const DIR_FLAGS: i32 = FLAGS | libc::O_DIRECTORY;

fn error(error: io::Error) -> &'static str {
    match error.raw_os_error() {
        Some(libc::ENOENT) => "FILE_NOT_FOUND",
        Some(libc::EEXIST) => "FILE_EXISTS",
        Some(libc::ENOTEMPTY) => "NOT_EMPTY",
        Some(libc::EACCES | libc::EPERM | libc::EROFS) => "ACCESS_DENIED",
        Some(libc::ENOSPC | libc::EDQUOT) => "NO_SPACE",
        Some(libc::EBUSY) => "FILE_IN_USE",
        Some(libc::EXDEV | libc::ELOOP | libc::ENOTDIR) => "UNSAFE_PATH",
        _ if error.kind() == io::ErrorKind::InvalidInput => "UNSAFE_PATH",
        _ => "FAILED",
    }
}

fn component(name: &str) -> Result<CString> { CString::new(name).map_err(|_| "UNSAFE_PATH") }

fn open(parent: &File, name: &CStr, flags: i32) -> Result<File> {
    let fd = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), flags) };
    if fd < 0 { return Err(error(io::Error::last_os_error())); }
    Ok(unsafe { File::from_raw_fd(fd) })
}

fn status(file: &File) -> Result<libc::stat> {
    let mut info = unsafe { mem::zeroed() };
    if unsafe { libc::fstat(file.as_raw_fd(), &mut info) } < 0 {
        return Err(error(io::Error::last_os_error()));
    }
    Ok(info)
}

fn named(parent: &File, name: &CStr) -> Result<Option<libc::stat>> {
    let mut info = unsafe { mem::zeroed() };
    if unsafe { libc::fstatat(parent.as_raw_fd(), name.as_ptr(), &mut info, libc::AT_SYMLINK_NOFOLLOW) } < 0 {
        let code = error(io::Error::last_os_error());
        return if code == "FILE_NOT_FOUND" { Ok(None) } else { Err(code) };
    }
    Ok(Some(info))
}

#[allow(clippy::unnecessary_cast)]
fn id(info: &libc::stat) -> Identity { Identity(info.st_dev as u64, info.st_ino as u64) }

pub(super) fn identity(file: &File) -> Result<Identity> { Ok(id(&status(file)?)) }

pub(super) fn occupied(parent: &File, name: &str) -> Result<Option<Identity>> {
    Ok(named(parent, &component(name)?)?.as_ref().map(id))
}

pub(super) fn dir(parent: &File, name: &str, _: bool) -> Result<File> {
    open(parent, &component(name)?, DIR_FLAGS)
}

pub(super) fn mkdir(parent: &File, name: &str) -> Result<File> {
    let name = component(name)?;
    if unsafe { libc::mkdirat(parent.as_raw_fd(), name.as_ptr(), 0o777) } < 0 {
        return Err(error(io::Error::last_os_error()));
    }
    open(parent, &name, DIR_FLAGS).map_err(|_| "UNCONFIRMED")
}

pub(super) fn acquire(parent: &File, name: &str, volume: Identity, _: bool) -> Result<Entry> {
    let name = component(name)?;
    let before = named(parent, &name)?.ok_or("FILE_NOT_FOUND")?;
    let mode = before.st_mode & libc::S_IFMT;
    let directory = mode == libc::S_IFDIR;
    if id(&before).0 != volume.0 || (!directory && (mode != libc::S_IFREG || before.st_nlink != 1)) {
        return Err("UNSAFE_PATH");
    }
    let file = open(parent, &name, if directory { DIR_FLAGS } else { FLAGS })?;
    let after = status(&file)?;
    if id(&after) != id(&before) || after.st_mode & libc::S_IFMT != mode { return Err("ENTRY_CHANGED"); }
    if !directory {
        if after.st_nlink != 1 { return Err("UNSAFE_PATH"); }
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } < 0 {
            let err = io::Error::last_os_error();
            return Err(if matches!(err.raw_os_error(), Some(libc::EACCES | libc::EAGAIN)) {
                "FILE_IN_USE"
            } else { error(err) });
        }
    }
    Ok(Entry { file, directory, id: id(&after) })
}

#[cfg(target_os = "linux")]
fn rename_noreplace(from: &File, source: &CStr, to: &File, target: &CStr) -> i64 {
    (unsafe {
        libc::syscall(libc::SYS_renameat2, from.as_raw_fd(), source.as_ptr(), to.as_raw_fd(), target.as_ptr(),
            libc::RENAME_NOREPLACE)
    }) as i64
}

#[cfg(target_os = "macos")]
fn rename_noreplace(from: &File, source: &CStr, to: &File, target: &CStr) -> i64 {
    (unsafe { libc::renameatx_np(from.as_raw_fd(), source.as_ptr(), to.as_raw_fd(), target.as_ptr(), libc::RENAME_EXCL) }) as i64
}

fn rename(from: &File, source: &CStr, to: &File, target: &CStr) -> Result<()> {
    if rename_noreplace(from, source, to, target) == 0 { return Ok(()); }
    let errno = io::Error::last_os_error();
    if matches!(errno.raw_os_error(), Some(libc::EINVAL | libc::ENOSYS | libc::ENOTSUP)) {
        return Err("SAFE_OPEN_UNAVAILABLE");
    }
    Err(error(errno))
}

pub(super) fn move_entry(entry: &Entry, from: &File, source: &str, to: &File, target: &str) -> Result<()> {
    let source = component(source)?;
    let target = component(target)?;
    if named(from, &source)?.as_ref().map(id) != Some(entry.id) { return Err("ENTRY_CHANGED"); }
    rename(from, &source, to, &target)?;
    match named(to, &target) {
        Ok(info) if info.as_ref().map(id) == Some(entry.id) => {
            let _ = unsafe { libc::fsync(to.as_raw_fd()) };
            Ok(())
        }
        Ok(Some(_)) => {
            rename(to, &target, from, &source).map_err(|_| "UNCONFIRMED")?;
            Err("ENTRY_CHANGED")
        }
        _ => Err("UNCONFIRMED"),
    }
}

#[allow(clippy::unnecessary_cast)]
pub(super) fn metadata(file: &File, directory: bool) -> Result<Value> {
    let info = status(file)?;
    let modified_ms = (info.st_mtime as i64).saturating_mul(1000).saturating_add((info.st_mtime_nsec as i64) / 1_000_000);
    let changed_ms = (info.st_ctime as i64).saturating_mul(1000).saturating_add((info.st_ctime_nsec as i64) / 1_000_000);
    #[cfg(target_os = "macos")]
    let created_ms = (info.st_birthtime != 0).then(|| (info.st_birthtime as i64).saturating_mul(1000)
        .saturating_add((info.st_birthtime_nsec as i64) / 1_000_000));
    #[cfg(not(target_os = "macos"))]
    let created_ms: Option<i64> = None;
    Ok(json!({
        "size": if directory { None } else { Some(u64::try_from(info.st_size).map_err(|_| "FAILED")?) },
        "modifiedMs": modified_ms, "changedMs": changed_ms, "createdMs": created_ms,
    }))
}

fn unlink(parent: &File, name: &CStr, directory: bool) -> Result<()> {
    let flags = if directory { libc::AT_REMOVEDIR } else { 0 };
    if unsafe { libc::unlinkat(parent.as_raw_fd(), name.as_ptr(), flags) } == 0 {
        return Ok(());
    }
    Err(error(io::Error::last_os_error()))
}

fn unlink_directory(parent: &File, name: &CStr, expected: Identity) -> Result<()> {
    if named(parent, name)?.as_ref().map(id) != Some(expected) { return Err("ENTRY_CHANGED"); }
    unlink(parent, name, true)
}

pub(super) fn remove_dir(parent: &File, name: &str, _: &File, expected: Identity) -> Result<()> {
    unlink_directory(parent, &component(name)?, expected)
}

pub(super) fn remove_created_dir(parent: &File, name: &str, expected: Identity) -> Result<()> {
    unlink_directory(parent, &component(name)?, expected)
}

struct Stream(*mut libc::DIR);

impl Drop for Stream {
    fn drop(&mut self) { unsafe { libc::closedir(self.0); } }
}

#[cfg(target_os = "linux")]
fn errno() -> *mut i32 { unsafe { libc::__errno_location() } }

#[cfg(target_os = "macos")]
fn errno() -> *mut i32 { unsafe { libc::__error() } }

fn names(directory: &File) -> Result<Vec<CString>> {
    let duplicate = unsafe { libc::fcntl(directory.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 0) };
    if duplicate < 0 { return Err(error(io::Error::last_os_error())); }
    let raw = unsafe { libc::fdopendir(duplicate) };
    if raw.is_null() {
        let failure = io::Error::last_os_error();
        unsafe { libc::close(duplicate); }
        return Err(error(failure));
    }
    let stream = Stream(raw);
    let mut all = Vec::new();
    loop {
        unsafe { *errno() = 0 };
        let entry = unsafe { libc::readdir(stream.0) };
        if entry.is_null() {
            return if unsafe { *errno() == 0 } { Ok(all) } else { Err(error(io::Error::last_os_error())) };
        }
        let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) };
        if !matches!(name.to_bytes(), b"." | b"..") { all.push(name.to_owned()); }
    }
}

pub(super) fn purge(directory: &File, volume: Identity) -> Result<u64> {
    struct Frame {
        dir: File, link: Option<(CString, Identity)>, children: std::vec::IntoIter<CString>,
    }
    let mut stack = vec![Frame { dir: directory.try_clone().map_err(error)?, link: None, children: names(directory)?.into_iter() }];
    let mut removed = 0;
    while let Some(frame) = stack.last_mut() {
        let Some(name) = frame.children.next() else {
            let done = stack.pop().expect("stack has its current frame");
            if let Some((name, expected)) = done.link {
                let parent = &stack.last().expect("only children have links").dir;
                unlink_directory(parent, &name, expected)?;
                removed += 1;
            }
            continue;
        };
        let Some(info) = named(&frame.dir, &name)? else { continue; };
        if info.st_mode & libc::S_IFMT != libc::S_IFDIR {
            // Unlink removes the entry itself, not the target of a link.
            unlink(&frame.dir, &name, false)?;
            removed += 1;
            continue;
        }
        let expected = id(&info);
        if expected.0 != volume.0 { return Err("UNSAFE_PATH"); }
        let child = open(&frame.dir, &name, DIR_FLAGS)?;
        if identity(&child)? != expected { return Err("ENTRY_CHANGED"); }
        let children = names(&child)?.into_iter();
        stack.push(Frame { dir: child, link: Some((name, expected)), children });
    }
    Ok(removed)
}
