use std::{
    ffi::c_void,
    fs::File,
    io::{self, Write},
    mem::{offset_of, size_of},
    os::windows::io::AsRawHandle,
    ptr,
};

use uuid::Uuid;

use super::{verify_text, Report, Result};

type Handle = *mut c_void;

const REPARSE_POINT: u32 = 0x400;
const DIRECTORY: u32 = 0x10;
const SYNC: u32 = 0x100000;
const READ_ATTR: u32 = 0x80;
const WRITE_DATA: u32 = 2;
const SHARE_ALL: u32 = 7;
const OPEN: u32 = 1;
const CREATE: u32 = 2;
const NO_FOLLOW: u32 = 0x200020;
const NON_DIRECTORY: u32 = 0x40;
const PRESERVED_ATTRS: u32 = 0x2 | 0x20 | 0x2000;
const SAFE_ATTRS: u32 = PRESERVED_ATTRS | 0x80;

#[repr(C)]
struct Status {
    status: usize,
    information: usize,
}

impl Status {
    fn empty() -> Self {
        Self { status: 0, information: 0 }
    }
}

#[repr(C)]
struct Rename {
    flags: u32,
    root: Handle,
    length: u32,
    name: [u16; 1],
}

#[repr(C)]
#[derive(Default)]
struct Time {
    low: u32,
    high: u32,
}

#[repr(C)]
#[derive(Default)]
struct Info {
    attributes: u32,
    created: Time,
    accessed: Time,
    written: Time,
    volume: u32,
    size_high: u32,
    size_low: u32,
    links: u32,
    index_high: u32,
    index_low: u32,
}

impl Info {
    fn identity(&self) -> (u32, u64) {
        (self.volume, (u64::from(self.index_high) << 32) | u64::from(self.index_low))
    }
}

#[repr(C)]
#[derive(Default)]
struct Basic {
    created: i64,
    accessed: i64,
    written: i64,
    changed: i64,
    attributes: u32,
}

#[repr(C)]
#[derive(Default)]
struct Standard {
    allocated: i64,
    eof: i64,
    links: u32,
    delete_pending: u8,
    directory: u8,
}

#[link(name = "ntdll")]
extern "system" {
    fn NtSetInformationFile(file: Handle, status: *mut Status, buffer: *mut c_void, size: u32, class: u32) -> i32;
    fn RtlNtStatusToDosError(status: i32) -> u32;
}

#[link(name = "kernel32")]
extern "system" {
    fn GetFileType(file: Handle) -> u32;
    fn GetFileInformationByHandle(file: Handle, data: *mut c_void) -> i32;
    fn GetFileInformationByHandleEx(file: Handle, class: i32, data: *mut c_void, size: u32) -> i32;
    fn SetFileInformationByHandle(file: Handle, class: u32, data: *const c_void, size: u32) -> i32;
    fn LocalFree(memory: Handle) -> Handle;
}

#[link(name = "advapi32")]
extern "system" {
    fn GetSecurityInfo(
        handle: Handle, object_type: u32, security_information: u32, owner: *mut Handle, group: *mut Handle,
        dacl: *mut Handle, sacl: *mut Handle, descriptor: *mut Handle,
    ) -> u32;
    fn GetSecurityDescriptorControl(descriptor: Handle, control: *mut u16, revision: *mut u32) -> i32;
    fn GetAce(acl: Handle, index: u32, ace: *mut Handle) -> i32;
}

pub(crate) fn checked_status(status: i32) -> io::Result<()> {
    if status >= 0 {
        Ok(())
    } else if status as u32 == 0xc000_0056 {
        // DOS translation can collapse DELETE_PENDING into ACCESS_DENIED.
        Err(io::Error::from_raw_os_error(303))
    } else {
        Err(io::Error::from_raw_os_error(unsafe { RtlNtStatusToDosError(status) } as i32))
    }
}

fn checked_bool(success: i32) -> io::Result<()> {
    if success != 0 { Ok(()) } else { Err(io::Error::last_os_error()) }
}

fn component(name: &str) -> io::Result<Vec<u16>> {
    if !crate::scan::reader_component(name) {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    let name = name.encode_utf16().collect::<Vec<_>>();
    if name.len() > 32_766 {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    Ok(name)
}

// All names here are single components relative to an already authorized handle.
pub(crate) fn acquire(
    parent: &File, name: &str, access: u32, share: u32, disposition: u32,
    options: u32, attributes: u32,
) -> io::Result<File> {
    if !crate::scan::reader_component(name) {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    crate::scan::windows_acquire(
        parent.as_raw_handle(), name, access, options | NO_FOLLOW, share, disposition, attributes,
    ).map(File::from)
}

pub(crate) fn rename(file: &File, parent: &File, name: &str, replace: bool) -> io::Result<()> {
    let name = component(name)?;
    let name_bytes = name.len() * size_of::<u16>();
    let bytes = (offset_of!(Rename, name) + name_bytes).max(size_of::<Rename>());
    // The native structure contains a pointer and must have native word alignment.
    let mut buffer = vec![0usize; bytes.div_ceil(size_of::<usize>())];
    let record = buffer.as_mut_ptr().cast::<Rename>();
    unsafe {
        ptr::addr_of_mut!((*record).flags).write(if replace { 0x1 | 0x2 } else { 0 });
        ptr::addr_of_mut!((*record).root).write(parent.as_raw_handle());
        ptr::addr_of_mut!((*record).length).write(name_bytes as u32);
        ptr::copy_nonoverlapping(name.as_ptr(), ptr::addr_of_mut!((*record).name).cast(), name.len());
        checked_status(set_information(file, buffer.as_mut_ptr().cast(), bytes as u32, if replace { 65 } else { 10 }))
    }
}

pub(crate) fn remove(file: &File) -> io::Result<()> {
    let mut flag = 1u8;
    checked_status(unsafe { set_information(file, (&mut flag as *mut u8).cast(), 1, 13) })
}

// The caller supplies a buffer with the layout and length required by the selected class.
pub(crate) unsafe fn set_information(
    file: &File, buffer: *mut c_void, length: u32, class: u32,
) -> i32 {
    unsafe { NtSetInformationFile(file.as_raw_handle(), &mut Status::empty(), buffer, length, class) }
}

fn raw_info(file: &File) -> io::Result<Info> {
    let mut info = Info::default();
    checked_bool(unsafe { GetFileInformationByHandle(file.as_raw_handle(), (&mut info as *mut Info).cast()) })?;
    Ok(info)
}

fn query<T: Default>(file: &File, class: i32) -> io::Result<T> {
    let mut value = T::default();
    checked_bool(unsafe {
        GetFileInformationByHandleEx(file.as_raw_handle(), class, (&mut value as *mut T).cast(), size_of::<T>() as u32)
    })?;
    Ok(value)
}

fn checked_file(file: &File, volume: u32, replace: bool) -> Result<Info> {
    let info = raw_info(file).map_err(|err| mapped(err, replace))?;
    if unsafe { GetFileType(file.as_raw_handle()) } != 1
        || info.attributes & (REPARSE_POINT | DIRECTORY) != 0 || info.links != 1 || info.volume != volume
    {
        return Err("UNSAFE_PATH");
    }
    Ok(info)
}

fn metadata(file: &File, previous: Option<String>) -> io::Result<Report> {
    let info = raw_info(file)?;
    let basic = query::<Basic>(file, 0)?;
    let (volume, index) = info.identity();
    let ms = |time: i64| (time > 0).then(|| (time - 116_444_736_000_000_000).div_euclid(10_000));
    Ok(Report {
        size: (u64::from(info.size_high) << 32) | u64::from(info.size_low),
        modified_ms: ms(basic.written),
        changed_ms: ms(basic.changed),
        created_ms: ms(basic.created),
        identity: Some(format!("nt:{volume}:{index}")),
        previous_identity: previous,
    })
}

pub(super) fn mapped(error: io::Error, replace: bool) -> &'static str {
    match error.raw_os_error() {
        Some(2 | 3) if replace => "FILE_NOT_FOUND",
        Some(2 | 3) => "PARENT_NOT_FOUND",
        Some(32 | 33) if replace => "FILE_IN_USE",
        Some(5 | 32 | 33) => "ACCESS_DENIED",
        Some(39 | 112) => "NO_SPACE",
        Some(80 | 183 | 303) if !replace => "FILE_EXISTS",
        Some(267 | 1920 | 4390 | 4392 | 4393) => "UNSAFE_PATH",
        Some(50 | 87) if replace => "SAFE_OPEN_UNAVAILABLE",
        _ if error.kind() == io::ErrorKind::InvalidInput => "UNSAFE_PATH",
        _ if replace => "MODIFY_FAILED",
        _ => "CREATE_FAILED",
    }
}

fn occupied(parent: &File, name: &str) -> io::Result<bool> {
    match acquire(parent, name, SYNC | READ_ATTR, SHARE_ALL, OPEN, 0, 0) {
        Ok(_) => Ok(true),
        Err(error) => match error.raw_os_error() {
            Some(2 | 3) => Ok(false),
            Some(32 | 80 | 183 | 303) => Ok(true),
            _ => Err(error),
        }
    }
}

struct Temporary {
    file: File,
    published: bool,
}

impl Temporary {
    fn new(parent: &File, replace: bool) -> Result<Self> {
        let prefix = if replace { "modify" } else { "create" };
        let name = format!(".mind-{prefix}-{}.tmp", Uuid::new_v4().simple());
        let write_attr = if replace { 0x100 } else { 0 };
        let file = acquire(
            parent, &name, SYNC | 0x10000 | READ_ATTR | WRITE_DATA | write_attr,
            0, CREATE, NON_DIRECTORY, 0x80,
        ).map_err(|err| mapped(err, replace))?;
        Ok(Self { file, published: false })
    }

    fn write(&self, data: &[u8], replace: bool) -> Result<()> {
        (&self.file).write_all(data).and_then(|_| self.file.sync_all())
            .map_err(|err| mapped(err, replace))
    }
}

impl Drop for Temporary {
    fn drop(&mut self) {
        if !self.published {
            let _ = remove(&self.file);
        }
    }
}

pub(super) fn create_stream(
    parent: &File, name: &str, confirm: impl FnOnce() -> Result<()>,
    transfer: impl FnOnce(&mut File) -> Result<u64>,
) -> Result<Report> {
    if occupied(parent, name).map_err(|err| mapped(err, false))? {
        return Err("FILE_EXISTS");
    }
    let volume = raw_info(parent).map_err(|err| mapped(err, false))?.volume;
    confirm()?;
    let mut temp = Temporary::new(parent, false)?;
    checked_file(&temp.file, volume, false)?;
    let size = transfer(&mut temp.file)?;
    if temp.file.metadata().map_err(|error| mapped(error, false))?.len() != size {
        return Err("CREATE_FAILED");
    }
    temp.file.sync_all().map_err(|error| mapped(error, false))?;
    if let Err(error) = rename(&temp.file, parent, name, false) {
        if matches!(error.raw_os_error(), Some(32 | 80 | 183 | 303))
            || (error.raw_os_error() == Some(5) && occupied(parent, name).unwrap_or(false))
        {
            return Err("FILE_EXISTS");
        }
        return Err(mapped(error, false));
    }
    temp.published = true;
    Ok(metadata(&temp.file, None).unwrap_or_else(|_| Report::size_only(size)))
}

fn single_stream(file: &File) -> bool {
    let mut buffer = [0u64; 512];
    if unsafe { GetFileInformationByHandleEx(file.as_raw_handle(), 7, buffer.as_mut_ptr().cast(), 4096) } == 0 {
        return io::Error::last_os_error().raw_os_error() == Some(38);
    }
    let bytes = unsafe { std::slice::from_raw_parts(buffer.as_ptr().cast::<u8>(), 4096) };
    let next = u32::from_le_bytes(bytes[0..4].try_into().unwrap());
    let name_bytes = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize;
    let default_stream: Vec<u8> = "::$DATA".encode_utf16().flat_map(u16::to_le_bytes).collect();
    next == 0 && name_bytes == default_stream.len() && bytes[24..24 + name_bytes] == default_stream
}

struct SecurityDescriptor(Handle);
impl Drop for SecurityDescriptor {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { LocalFree(self.0) };
        }
    }
}

fn inherited_acl(file: &File) -> bool {
    let mut dacl = ptr::null_mut();
    let mut descriptor = SecurityDescriptor(ptr::null_mut());
    if unsafe {
        GetSecurityInfo(file.as_raw_handle(), 1, 4, ptr::null_mut(), ptr::null_mut(),
                        &mut dacl, ptr::null_mut(), &mut descriptor.0)
    } != 0 || dacl.is_null() || descriptor.0.is_null() {
        return false;
    }
    let (mut control, mut revision) = (0u16, 0u32);
    if unsafe { GetSecurityDescriptorControl(descriptor.0, &mut control, &mut revision) } == 0
        || control & 0x1000 != 0
    {
        return false;
    }
    // ACL.AceCount and ACE_HEADER.AceFlags in structures owned by GetSecurityInfo.
    let count = unsafe { u32::from(dacl.cast::<u16>().add(2).read()) };
    (0..count).all(|index| {
        let mut ace = ptr::null_mut();
        unsafe { GetAce(dacl, index, &mut ace) != 0 && !ace.is_null() && ace.cast::<u8>().add(1).read() & 0x10 != 0 }
    })
}

fn confirm_original(parent: &File, name: &str, original: &Info) -> Result<()> {
    let named = acquire(parent, name, SYNC | READ_ATTR, SHARE_ALL, OPEN, 0, 0)
        .map_err(|_| "VERSION_CONFLICT")?;
    let info = raw_info(&named).map_err(|_| "VERSION_CONFLICT")?;
    if info.identity() != original.identity() || info.attributes != original.attributes || info.links != 1 {
        return Err("VERSION_CONFLICT");
    }
    Ok(())
}

pub(super) fn modify_text(
    parent: &File, name: &str, data: &[u8], limit: usize, expected: &str,
    confirm: impl FnOnce() -> Result<()>,
) -> Result<Report> {
    let parent_info = raw_info(parent).map_err(|err| mapped(err, true))?;
    // Hold the original without FILE_SHARE_WRITE while verifying and publishing.
    let target = acquire(
        parent, name, SYNC | 0x20000 | READ_ATTR | 1 | WRITE_DATA,
        1 | 4, OPEN, 0, 0,
    ).map_err(|err| mapped(err, true))?;
    let original = checked_file(&target, parent_info.volume, true)?;
    verify_text(&target, limit, expected)?;
    if original.attributes & 1 != 0 {
        return Err("ACCESS_DENIED");
    }
    if original.attributes & !SAFE_ATTRS != 0 || !single_stream(&target) || !inherited_acl(&target) {
        return Err("METADATA_NOT_PRESERVABLE");
    }
    let initial = query::<Basic>(&target, 0).map_err(|err| mapped(err, true))?;
    let basic = Basic { created: initial.created, attributes: original.attributes & PRESERVED_ATTRS, ..Default::default() };
    confirm()?;
    let mut temp = Temporary::new(parent, true)?;
    checked_file(&temp.file, parent_info.volume, true)?;
    checked_bool(unsafe {
        SetFileInformationByHandle(temp.file.as_raw_handle(), 0, (&basic as *const Basic).cast(), size_of::<Basic>() as u32)
    }).map_err(|err| mapped(err, true))?;
    temp.write(data, true)?;
    confirm_original(parent, name, &original)?;
    if query::<Basic>(&target, 0).map_err(|_| "VERSION_CONFLICT")?.changed != initial.changed {
        return Err("VERSION_CONFLICT");
    }
    rename(&temp.file, parent, name, true).map_err(|err| mapped(err, true))?;
    temp.published = true;

    let old = query::<Standard>(&target, 1).map_err(|_| "MODIFY_UNCONFIRMED")?;
    if old.links != 0 && old.delete_pending == 0 {
        return Err("MODIFY_UNCONFIRMED");
    }
    let (volume, index) = original.identity();
    Ok(metadata(&temp.file, Some(format!("nt:{volume}:{index}")))
        .unwrap_or_else(|_| Report::size_only(data.len() as u64)))
}
