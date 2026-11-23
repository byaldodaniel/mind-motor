use super::{Entry, Identity, Result};
use crate::text_write::windows::{acquire as open, checked_status, rename, set_information};
use serde_json::{json, Value};
use std::{ffi::c_void, fs::File, io, mem::size_of, os::windows::io::AsRawHandle};

const READ_ATTRIBUTES: u32 = 0x0000_0080;
const SYNCHRONIZE: u32 = 0x0010_0000;
const DELETE: u32 = 0x0001_0000;
const BASE: u32 = READ_ATTRIBUTES | SYNCHRONIZE;
const READ_DATA: u32 = 1;
const TRAVERSE: u32 = 0x20;
const DIRECTORY: u32 = 1;
const NON_DIRECTORY: u32 = 0x40;
const SECURE: u32 = 0x0020_0020; // Open the reparse point itself, synchronous I/O.
const REPARSE: u32 = 0x400;
const DIR_ATTR: u32 = 0x10;
const ALL_SHARING: u32 = 7;
const FILE_OPEN: u32 = 1;
const FILE_CREATE: u32 = 2;
const WINDOWS_EPOCH: i64 = 116_444_736_000_000_000;

type Handle = *mut c_void;

#[repr(C)]
#[derive(Default)]
struct RawTime { low: u32, high: u32 }

#[repr(C)]
#[derive(Default)]
struct Info {
    attributes: u32, created: RawTime, accessed: RawTime, written: RawTime,
    volume: u32, size_hi: u32, size_lo: u32, links: u32, id_hi: u32, id_lo: u32,
}

impl Info {
    fn directory(&self) -> bool { self.attributes & DIR_ATTR != 0 }
    fn reparse(&self) -> bool { self.attributes & REPARSE != 0 }
    fn id(&self) -> Identity {
        Identity(u64::from(self.volume), (u64::from(self.id_hi) << 32) | u64::from(self.id_lo))
    }
    fn size(&self) -> u64 { (u64::from(self.size_hi) << 32) | u64::from(self.size_lo) }
}

#[repr(C)]
#[derive(Default)]
struct Basic { created: i64, accessed: i64, written: i64, changed: i64, attributes: u32 }

#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetFileType(file: Handle) -> u32;
    fn GetFileInformationByHandle(file: Handle, info: *mut c_void) -> i32;
    fn GetFileInformationByHandleEx(file: Handle, class: i32, info: *mut c_void, length: u32) -> i32;
}

fn error(error: io::Error) -> &'static str {
    match error.raw_os_error() {
        Some(2 | 3 | 303) => "FILE_NOT_FOUND",
        Some(80 | 183) => "FILE_EXISTS",
        Some(32 | 33) => "FILE_IN_USE",
        Some(5 | 19) => "ACCESS_DENIED",
        Some(39 | 112) => "NO_SPACE",
        Some(145) => "NOT_EMPTY",
        Some(17 | 267 | 1920 | 4390 | 4392 | 4393) => "UNSAFE_PATH",
        _ if error.kind() == io::ErrorKind::InvalidInput => "UNSAFE_PATH",
        _ => "FAILED",
    }
}

fn info(file: &File) -> Result<Info> {
    let mut info = Info::default();
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), (&mut info as *mut Info).cast()) } == 0 {
        return Err(error(io::Error::last_os_error()));
    }
    Ok(info)
}

fn check(file: &File, directory: bool) -> Result<Info> {
    let info = info(file)?;
    if unsafe { GetFileType(file.as_raw_handle()) } != 1 || info.reparse()
        || info.directory() != directory
        || (!directory && (!crate::scan::single_link(file.as_raw_handle(), info.links, info.volume)
            || (info.links == 0 && info.id().1 == 0)))
    { return Err("UNSAFE_PATH"); }
    Ok(info)
}

pub(super) fn identity(file: &File) -> Result<Identity> { Ok(info(file)?.id()) }

pub(super) fn occupied(parent: &File, name: &str) -> Result<Option<Identity>> {
    match open(parent, name, BASE, ALL_SHARING, FILE_OPEN, SECURE, 0) {
        Ok(file) => Ok(Some(identity(&file)?)),
        Err(error) => match error.raw_os_error() {
            Some(2 | 3) => Ok(None),
            // The entry still occupies its name and cannot be our alias.
            Some(32 | 33 | 80 | 183 | 303) => Ok(Some(Identity(u64::MAX, u64::MAX))),
            _ => Err(self::error(error)),
        },
    }
}

pub(super) fn dir(parent: &File, name: &str, delete: bool) -> Result<File> {
    let access = BASE | TRAVERSE | READ_DATA | if delete { DELETE } else { 0 };
    let directory = open(parent, name, access, ALL_SHARING, FILE_OPEN, SECURE | DIRECTORY, 0).map_err(error)?;
    check(&directory, true)?;
    Ok(directory)
}

pub(super) fn mkdir(parent: &File, name: &str) -> Result<File> {
    let directory = open(parent, name, BASE | TRAVERSE | READ_DATA, ALL_SHARING, FILE_CREATE,
        SECURE | DIRECTORY, 0).map_err(|failure| {
            if matches!(failure.raw_os_error(), Some(5 | 32 | 33 | 303))
                && occupied(parent, name).ok().flatten().is_some()
            { "FILE_EXISTS" } else { error(failure) }
        })?;
    check(&directory, true).map_err(|_| "UNCONFIRMED")?;
    Ok(directory)
}

pub(super) fn acquire(parent: &File, name: &str, volume: Identity, read: bool) -> Result<Entry> {
    let probe = open(parent, name, BASE, ALL_SHARING, FILE_OPEN, SECURE, 0).map_err(error)?;
    let before = info(&probe)?;
    drop(probe);
    if before.reparse() { return Err("UNSAFE_PATH"); }
    let directory = before.directory();
    let share = if directory { 3 } else { 1 }; // Do not share DELETE.
    let access = BASE | DELETE | if read && !directory { READ_DATA } else { 0 };
    let flags = SECURE | if directory { DIRECTORY } else { NON_DIRECTORY };
    let file = open(parent, name, access, share, FILE_OPEN, flags, 0).map_err(error)?;
    let after = check(&file, directory)?;
    if after.id().0 != volume.0 { return Err("UNSAFE_PATH"); }
    if before.id() != after.id() { return Err("ENTRY_CHANGED"); }
    Ok(Entry { file, directory, id: after.id() })
}

pub(super) fn move_entry(entry: &Entry, _: &File, _: &str, to: &File, name: &str) -> Result<()> {
    rename(&entry.file, to, name, false).map_err(|failure| {
        if matches!(failure.raw_os_error(), Some(5 | 32 | 33 | 303))
            && occupied(to, name).ok().flatten().is_some()
        { "FILE_EXISTS" } else { error(failure) }
    })
}

pub(super) fn metadata(file: &File, directory: bool) -> Result<Value> {
    let info = check(file, directory)?;
    let mut basic = Basic::default();
    if unsafe { GetFileInformationByHandleEx(file.as_raw_handle(), 0, (&mut basic as *mut Basic).cast(), size_of::<Basic>() as u32) } == 0 {
        return Err(error(io::Error::last_os_error()));
    }
    let ms = |ticks: i64| (ticks > 0).then(|| (ticks - WINDOWS_EPOCH).div_euclid(10_000));
    Ok(json!({
        "size": (!directory).then(|| info.size()), "modifiedMs": ms(basic.written),
        "changedMs": ms(basic.changed), "createdMs": ms(basic.created),
    }))
}

fn dispose(file: &File) -> Result<()> {
    let mut flags = 0x13_u32; // Delete, POSIX semantics, ignore read-only attributes.
    let mut result = unsafe { set_information(file, (&mut flags as *mut u32).cast(), 4, 64) };
    if matches!(result as u32, 0xc0000002 | 0xc0000003 | 0xc000000d | 0xc00000bb) {
        let mut classic = 1_u8;
        result = unsafe { set_information(file, (&mut classic as *mut u8).cast(), 1, 13) };
    }
    if result as u32 == 0xc0000121 { return Err("ACCESS_DENIED"); }
    checked_status(result).map_err(error)
}

pub(super) fn remove_dir(_: &File, _: &str, file: &File, _: Identity) -> Result<()> { dispose(file) }

pub(super) fn remove_created_dir(parent: &File, name: &str, id: Identity) -> Result<()> {
    let file = dir(parent, name, true)?;
    if identity(&file)? != id { return Err("ENTRY_CHANGED"); }
    dispose(&file)
}

fn names(directory: &File) -> Result<Vec<(String, u32)>> {
    let mut all = Vec::new();
    let mut aligned = vec![0_u64; 8_192];
    loop {
        if unsafe { GetFileInformationByHandleEx(directory.as_raw_handle(), 14, aligned.as_mut_ptr().cast(), 65_536) } == 0 {
            let error_os = io::Error::last_os_error();
            if error_os.raw_os_error() == Some(18) { return Ok(all); }
            return Err(error(error_os));
        }
        // The native structure's UTF-16 name starts at byte 68.
        let raw = unsafe { std::slice::from_raw_parts(aligned.as_ptr().cast::<u8>(), 65_536) };
        let mut offset = 0;
        loop {
            if offset + 68 > raw.len() { return Err("FAILED"); }
            let word = |at| u32::from_le_bytes(raw[at..at + 4].try_into().unwrap());
            let next = word(offset) as usize;
            let attributes = word(offset + 56);
            let length = word(offset + 60) as usize;
            let end = (offset + 68).checked_add(length).ok_or("FAILED")?;
            if length % 2 != 0 || end > raw.len()
                || (next != 0 && (next < 68 + length || offset + next >= raw.len()))
            { return Err("FAILED"); }
            let name = raw[offset + 68..end].chunks_exact(2)
                .map(|bytes| u16::from_le_bytes([bytes[0], bytes[1]])).collect::<Vec<_>>();
            let name = String::from_utf16(&name).map_err(|_| "UNSAFE_PATH")?;
            if name != "." && name != ".." {
                if name.is_empty() || name.contains(['\\', '/', ':', '\0']) { return Err("UNSAFE_PATH"); }
                all.push((name, attributes));
            }
            if next == 0 { break; }
            offset += next;
        }
    }
}

type Children = std::vec::IntoIter<(String, u32)>;

pub(super) fn purge(directory: &File, volume: Identity) -> Result<u64> {
    struct Frame { dir: File, remove: bool, children: Children }
    let root = directory.try_clone().map_err(error)?;
    let mut stack = vec![Frame { dir: root, remove: false, children: names(directory)?.into_iter() }];
    let mut removed = 0;
    while let Some(frame) = stack.last_mut() {
        let Some((name, attrs)) = frame.children.next() else {
            let done = stack.pop().expect("stack has its current frame");
            if done.remove {
                dispose(&done.dir)?;
                removed += 1;
            }
            continue;
        };
        let reparse = attrs & REPARSE != 0;
        let directory = attrs & DIR_ATTR != 0;
        let descend = directory && !reparse;
        let access = BASE | DELETE | if descend { READ_DATA | TRAVERSE } else { 0 };
        let flags = SECURE | if descend { DIRECTORY } else if reparse { 0 } else { NON_DIRECTORY };
        let child = match open(&frame.dir, &name, access, ALL_SHARING, FILE_OPEN, flags, 0) {
            Ok(file) => file,
            Err(failure) => match error(failure) {
                "FILE_NOT_FOUND" => continue,
                other => return Err(other),
            },
        };
        let found = info(&child)?;
        if found.reparse() != reparse || (!reparse && found.directory() != directory) {
            return Err("ENTRY_CHANGED");
        }
        if descend {
            if found.id().0 != volume.0 { return Err("UNSAFE_PATH"); }
            let children = names(&child)?.into_iter();
            stack.push(Frame { dir: child, remove: true, children });
        } else {
            dispose(&child)?;
            removed += 1;
        }
    }
    Ok(removed)
}
