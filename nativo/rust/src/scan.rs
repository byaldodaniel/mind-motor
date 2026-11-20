use serde_json::{json,Value};
#[derive(Debug)]
pub struct ScanError(pub &'static str,pub String);
impl From<std::io::Error> for ScanError {fn from(e:std::io::Error)->Self {Self("IO_ERROR",e.to_string())}}
fn invalid(message:&str)->ScanError{ScanError("INVALID_SCOPE",message.into())}
fn append_entry(entries:&mut Vec<Value>,bytes:&mut usize,entry:Value)->bool{let size=serde_json::to_vec(&entry).map(|v|v.len()+1).unwrap_or(crate::MAX_MESSAGE);if *bytes+size>crate::MAX_MESSAGE-4096{return false}*bytes+=size;entries.push(entry);true}
pub fn handle(request:Value)->Value {
    let candidate=request.get("id").cloned().unwrap_or(Value::Null);
    let valid_id=candidate.as_str().is_some_and(|s| !s.is_empty() && s.chars().count()<=128) || candidate.as_u64().is_some_and(|n| n<=9_007_199_254_740_991);
    let id=if valid_id{candidate}else{Value::Null};
    let result=(|| {
        if !valid_id {return Err(invalid("id must be a nonempty string of at most 128 characters or nonnegative safe integer"))}
        if !request.as_object().is_some_and(|o|o.keys().all(|k|matches!(k.as_str(),"id"|"root"|"relative"|"maxEntries"))) {return Err(invalid("Unknown request property"))}
        let root=request.get("root").and_then(Value::as_str).ok_or_else(||invalid("root must be an absolute string"))?;
        let relative=request.get("relative").map(|v|v.as_str().ok_or_else(||invalid("relative must be a string"))).transpose()?.unwrap_or("");
        if root.chars().count()>32767||relative.chars().count()>32767||root.contains('\0')||relative.contains('\0')||relative.contains('\\')||relative.starts_with('/')||relative.ends_with('/')||relative.contains(':')||relative.split('/').any(|p|p=="."||p=="..")||relative.contains("//") {return Err(invalid("Unsafe path component"))}
        let max=request.get("maxEntries").map(|v|v.as_u64().ok_or_else(||invalid("maxEntries must be positive integer"))).transpose()?.unwrap_or(100_000);
        if max==0||max>1_000_000{return Err(invalid("maxEntries must be between 1 and 1000000"))}
        platform::scan(root,relative,max as usize)
    })();
    match result {
        Ok((entries,complete))=>json!({"id":id,"entries":entries,"complete":complete}),
        Err(ScanError(code,message))=>json!({"id":id,"entries":[],"complete":false,"error":{"code":code,"message":message}})
    }
}

pub(crate) fn open_reader(root: &str, relative: &str) -> Result<std::fs::File, &'static str> {
    if !relative.split('/').all(reader_component) {
        return Err("UNSAFE_PATH");
    }
    platform::open_reader(root, relative)
}

fn reader_component(name: &str) -> bool {
    let base = name.split('.').next().unwrap_or("").to_ascii_lowercase();
    let reserved = matches!(base.as_str(), "con" | "prn" | "aux" | "nul")
        || (["com", "lpt"].iter().filter_map(|prefix| base.strip_prefix(prefix)).any(|number| {
            number.len() == 1 && matches!(number.as_bytes()[0], b'1'..=b'9')
        }));
    !name.is_empty()
        && !name.ends_with(['.', ' '])
        && !reserved
        && !name.chars().any(|c| matches!(c, '\\' | '/' | ':' | '<' | '>' | '"' | '|' | '?' | '*' | '\x00'..='\x1f'))
}

#[cfg(windows)]
mod platform {
    use super::*;
    use std::{ffi::c_void, fs::File, io, mem, os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle}, ptr};
    type Handle=*mut c_void;
    #[repr(C)] struct Unicode {length:u16,max:u16,buffer:*mut u16}
    #[repr(C)] struct Attributes {length:u32,root:Handle,name:*mut Unicode,flags:u32,security:*mut c_void,qos:*mut c_void}
    #[repr(C)] struct Status {status:usize,information:usize}
    #[repr(C)] #[derive(Default)] struct Time {lo:u32,hi:u32}
    #[repr(C)] #[derive(Default)] struct Info {attributes:u32,created:Time,accessed:Time,written:Time,volume:u32,size_hi:u32,size_lo:u32,links:u32,index_hi:u32,index_lo:u32}
    #[link(name="ntdll")] extern "system" {
        fn NtCreateFile(handle:*mut Handle,access:u32,attrs:*mut Attributes,status:*mut Status,size:*const i64,attributes:u32,share:u32,disposition:u32,options:u32,ea:*const c_void,ealen:u32)->i32;
        fn RtlNtStatusToDosError(status:i32)->u32;
    }
    #[link(name="kernel32")] extern "system" {
        fn GetFileType(handle:Handle)->u32;
        fn GetFileInformationByHandle(handle:Handle,info:*mut Info)->i32;
        fn GetFileInformationByHandleEx(handle:Handle,class:i32,info:*mut c_void,size:u32)->i32;
        fn GetDriveTypeW(root:*const u16)->u32;
        fn GetLastError()->u32;
    }
    struct Directory {handle:OwnedHandle,volume:u32}
    fn os_error(code:u32)->ScanError {ScanError("IO_ERROR",format!("Windows error {code}: {}",std::io::Error::from_raw_os_error(code as i32)))}

    fn acquire(parent: Handle, name: &str, access: u32, options: u32) -> io::Result<OwnedHandle> {
        let mut text: Vec<u16> = name.encode_utf16().collect();
        if text.len() > 32_766 {
            return Err(io::Error::from(io::ErrorKind::InvalidInput));
        }
        let mut unicode = Unicode { length: (text.len() * 2) as u16, max: (text.len() * 2) as u16, buffer: text.as_mut_ptr() };
        let mut attrs = Attributes {
            length: mem::size_of::<Attributes>() as u32, root: parent,
            name: &mut unicode, flags: 0x40, security: ptr::null_mut(), qos: ptr::null_mut(),
        };
        let mut status = Status { status: 0, information: 0 };
        let mut handle = ptr::null_mut();
        let result = unsafe {
            NtCreateFile(&mut handle, access, &mut attrs, &mut status, ptr::null(), 0, 7, 1, options, ptr::null(), 0)
        };
        if result < 0 {
            return Err(io::Error::from_raw_os_error(unsafe { RtlNtStatusToDosError(result) } as i32));
        }
        Ok(unsafe { OwnedHandle::from_raw_handle(handle) })
    }

    fn metadata(handle: &OwnedHandle) -> io::Result<Info> {
        let mut info = Info::default();
        if unsafe { GetFileInformationByHandle(handle.as_raw_handle(), &mut info) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(info)
    }

    fn open(parent:Handle,name:&str,list:bool)->Result<Directory,ScanError> {
        let handle = acquire(parent, name, 0x1000a0 | if list { 1 } else { 0 }, 0x200021)
            .map_err(|error| match error.raw_os_error() {
                Some(code) => os_error(code as u32),
                None => invalid("Path component too long"),
            })?;
        let info = metadata(&handle).map_err(|error| os_error(error.raw_os_error().unwrap_or(1) as u32))?;
        if info.attributes&0x400!=0||info.attributes&0x10==0{return Err(ScanError("REPARSE_POINT","Directory is a reparse point or changed type".into()))}
        Ok(Directory { handle, volume: info.volume })
    }

    fn reader_error(error: io::Error) -> &'static str {
        match error.raw_os_error() {
            Some(2 | 3) => "FILE_NOT_FOUND",
            Some(5 | 32 | 33) => "ACCESS_DENIED",
            Some(1920 | 4390 | 4392 | 4393) => "UNSAFE_PATH",
            _ if error.kind() == io::ErrorKind::InvalidInput => "UNSAFE_PATH",
            _ => "READ_FAILED",
        }
    }

    fn reader_open(parent: Handle, name: &str, directory: bool) -> Result<(OwnedHandle, u32), &'static str> {
        // Open the reparse point itself and inspect its held handle before use.
        let access = 0x100080 | if directory { 0x20 } else { 1 };
        let handle = acquire(parent, name, access, 0x200020).map_err(reader_error)?;
        let info = metadata(&handle).map_err(reader_error)?;
        if unsafe { GetFileType(handle.as_raw_handle()) } != 1
            || info.attributes & 0x400 != 0
            || (info.attributes & 0x10 != 0) != directory
            || (!directory && info.links != 1)
        {
            return Err("UNSAFE_PATH");
        }
        Ok((handle, info.volume))
    }

    pub(super) fn open_reader(root: &str, relative: &str) -> Result<File, &'static str> {
        let bytes = root.as_bytes();
        if bytes.len() < 3 || !bytes[0].is_ascii_alphabetic() || bytes[1] != b':'
            || bytes[2] != b'\\' || root.contains('/')
        {
            return Err("SAFE_OPEN_UNAVAILABLE");
        }
        let drive = &root[..3];
        let drive_wide: Vec<u16> = drive.encode_utf16().chain(Some(0)).collect();
        if unsafe { GetDriveTypeW(drive_wide.as_ptr()) } != 3 {
            return Err("SAFE_OPEN_UNAVAILABLE");
        }
        let (mut directory, mut volume) = reader_open(ptr::null_mut(), &format!("\\??\\{drive}"), true)?;
        if root.len() > 3 {
            for name in root[3..].split('\\') {
                if !reader_component(name) {
                    return Err("UNSAFE_PATH");
                }
                (directory, volume) = reader_open(directory.as_raw_handle(), name, true)?;
            }
        }
        let (ancestor, file) = relative.rsplit_once('/').unwrap_or(("", relative));
        for name in ancestor.split('/').filter(|name| !name.is_empty()) {
            let (next, current_volume) = reader_open(directory.as_raw_handle(), name, true)?;
            if current_volume != volume {
                return Err("UNSAFE_PATH");
            }
            directory = next;
        }
        let (file, current_volume) = reader_open(directory.as_raw_handle(), file, false)?;
        if current_volume != volume {
            return Err("UNSAFE_PATH");
        }
        Ok(File::from(file))
    }
    fn u32le(b:&[u8],o:usize)->u32{u32::from_le_bytes(b[o..o+4].try_into().unwrap())}
    fn u64le(b:&[u8],o:usize)->u64{u64::from_le_bytes(b[o..o+8].try_into().unwrap())}
    pub fn scan(root:&str,relative:&str,max:usize)->Result<(Vec<Value>,bool),ScanError> {
        let bytes=root.as_bytes();
        if bytes.len()<3||!bytes[0].is_ascii_alphabetic()||bytes[1]!=b':'||bytes[2]!=b'\\'||root.contains('/') {return Err(invalid("Only absolute local drive paths are supported"))}
        let drive:Vec<u16>=root[..3].encode_utf16().chain(Some(0)).collect();
        if unsafe{GetDriveTypeW(drive.as_ptr())}!=3{return Err(ScanError("UNSUPPORTED_VOLUME","Only fixed local volumes are supported by this pilot".into()))}
        let mut parts:Vec<&str>=root[3..].split('\\').filter(|p|!p.is_empty()).collect();
        parts.extend(relative.split('/').filter(|p|!p.is_empty()));
        if parts.iter().any(|p|*p=="."||*p==".."||p.contains(':')) {return Err(invalid("Unsafe path component"))}
        let mut directory=open(ptr::null_mut(),&format!("\\??\\{}",&root[..3]),parts.is_empty())?;
        let volume=directory.volume;
        for (i,part) in parts.iter().enumerate(){let next=open(directory.handle.as_raw_handle(),part,i+1==parts.len())?;if next.volume!=volume{return Err(ScanError("OTHER_VOLUME","Volume changed".into()))}directory=next;}
        // Enumeration and metadata are obtained from the same held directory handle.
        let mut aligned=vec![0u64;8192];let mut entries=Vec::new();let mut response_bytes=0;
        loop {
            if unsafe{GetFileInformationByHandleEx(directory.handle.as_raw_handle(),10,aligned.as_mut_ptr().cast(),65536)}==0 {
                let code=unsafe{GetLastError()};if code==18{return Ok((entries,true))}return Err(os_error(code))
            }
            let raw=unsafe{std::slice::from_raw_parts(aligned.as_ptr().cast::<u8>(),65536)};
            let mut offset=0;
            loop {
                if offset+104>raw.len(){return Err(ScanError("INVALID_NATIVE_RECORD","Truncated directory record".into()))}
                let next=u32le(raw,offset) as usize;let length=u32le(raw,offset+60) as usize;
                if length%2!=0||offset+104+length>raw.len()||next!=0&&(next<104+length||offset+next>=raw.len()){return Err(ScanError("INVALID_NATIVE_RECORD","Invalid directory record length".into()))}
                let name16:Vec<u16>=raw[offset+104..offset+104+length].chunks_exact(2).map(|b|u16::from_le_bytes([b[0],b[1]])).collect();
                let name=String::from_utf16(&name16).map_err(|_|ScanError("NAME_NOT_UTF8","Directory contains non-Unicode name".into()))?;
                if name!="."&&name!=".." {
                    if entries.len()==max{return Ok((entries,false))}
                    let attributes=u32le(raw,offset+56);let file_id=u64le(raw,offset+96);
                    let kind=if attributes&0x400!=0{"link"}else if attributes&0x10!=0{"directory"}else{"file"};
                    let mut entry=json!({"name":name,"type":kind});
                    if kind=="file"{entry["size"]=json!(u64le(raw,offset+40))}
                    if file_id!=0{entry["identity"]=json!(format!("nt:{}:{}",volume,file_id))}
                    if !append_entry(&mut entries,&mut response_bytes,entry){return Ok((entries,false))}
                }
                if next==0{break}offset+=next;
            }
        }
    }
}
#[cfg(unix)]
mod platform {
    use super::*;
    use std::{ffi::{CString,CStr},mem,os::fd::{AsRawFd,FromRawFd,OwnedFd}};
    const FLAGS:i32=libc::O_RDONLY|libc::O_DIRECTORY|libc::O_NOFOLLOW|libc::O_CLOEXEC;
    fn open_at(parent: i32, name: &str, flags: i32) -> std::io::Result<OwnedFd> {
        let name = CString::new(name).map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
        let fd = unsafe { libc::openat(parent, name.as_ptr(), flags) };
        if fd < 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(unsafe { OwnedFd::from_raw_fd(fd) })
    }
    fn open(parent: i32, name: &str) -> Result<OwnedFd, ScanError> {
        open_at(parent, name, FLAGS).map_err(ScanError::from)
    }
    fn descriptor_stat(fd: i32) -> std::io::Result<libc::stat> {
        let mut info = unsafe { mem::zeroed() };
        if unsafe { libc::fstat(fd, &mut info) } < 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(info)
    }
    fn stat(fd: i32) -> Result<libc::stat, ScanError> {
        descriptor_stat(fd).map_err(ScanError::from)
    }

    fn reader_error(error: std::io::Error) -> &'static str {
        match error.raw_os_error() {
            Some(libc::ELOOP | libc::ENOTDIR) => "UNSAFE_PATH",
            _ if error.kind() == std::io::ErrorKind::NotFound => "FILE_NOT_FOUND",
            _ if error.kind() == std::io::ErrorKind::PermissionDenied => "ACCESS_DENIED",
            _ => "READ_FAILED",
        }
    }

    fn reader_open(parent: i32, name: &str, directory: bool) -> Result<(OwnedFd, libc::stat), &'static str> {
        let common = libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC;
        let flags = common | if directory { libc::O_DIRECTORY } else { 0 };
        let fd = open_at(parent, name, flags).map_err(reader_error)?;
        let info = descriptor_stat(fd.as_raw_fd()).map_err(reader_error)?;
        let expected = if directory { libc::S_IFDIR } else { libc::S_IFREG };
        if info.st_mode & libc::S_IFMT != expected || (!directory && info.st_nlink != 1) {
            return Err("UNSAFE_PATH");
        }
        Ok((fd, info))
    }

    pub(super) fn open_reader(root: &str, relative: &str) -> Result<std::fs::File, &'static str> {
        if !root.starts_with('/') || root.starts_with("//") {
            return Err("UNSAFE_PATH");
        }
        let (mut directory, mut volume) = reader_open(libc::AT_FDCWD, "/", true)?;
        if root != "/" {
            for name in root[1..].split('/') {
                if !reader_component(name) {
                    return Err("UNSAFE_PATH");
                }
                (directory, volume) = reader_open(directory.as_raw_fd(), name, true)?;
            }
        }
        let (ancestor, file) = relative.rsplit_once('/').unwrap_or(("", relative));
        for name in ancestor.split('/').filter(|name| !name.is_empty()) {
            let (next, current_volume) = reader_open(directory.as_raw_fd(), name, true)?;
            if current_volume.st_dev != volume.st_dev {
                return Err("UNSAFE_PATH");
            }
            directory = next;
        }
        let (file, current_volume) = reader_open(directory.as_raw_fd(), file, false)?;
        if current_volume.st_dev != volume.st_dev {
            return Err("UNSAFE_PATH");
        }
        Ok(std::fs::File::from(file))
    }
    struct Stream(*mut libc::DIR);impl Drop for Stream{fn drop(&mut self){unsafe{libc::closedir(self.0);}}}
    #[cfg(target_os="linux")] fn errno()->*mut i32{unsafe{libc::__errno_location()}}
    #[cfg(target_os="macos")] fn errno()->*mut i32{unsafe{libc::__error()}}
    pub fn scan(root:&str,relative:&str,max:usize)->Result<(Vec<Value>,bool),ScanError>{
        if !root.starts_with('/')||root.starts_with("//"){return Err(invalid("Absolute local path required"))}
        let mut current=open(libc::AT_FDCWD,"/")?;
        for part in root.split('/').filter(|p|!p.is_empty()) {if part=="."||part==".."{return Err(invalid("Unsafe root component"))}current=open(current.as_raw_fd(),part)?;}
        let volume=stat(current.as_raw_fd())?.st_dev;
        for part in relative.split('/').filter(|p|!p.is_empty()){let next=open(current.as_raw_fd(),part)?;if stat(next.as_raw_fd())?.st_dev!=volume{return Err(ScanError("OTHER_VOLUME","Volume changed".into()))}current=next;}
        let duplicate=unsafe{libc::dup(current.as_raw_fd())};if duplicate<0{return Err(std::io::Error::last_os_error().into())}
        let raw=unsafe{libc::fdopendir(duplicate)};if raw.is_null(){unsafe{libc::close(duplicate)};return Err(std::io::Error::last_os_error().into())}
        let stream=Stream(raw);let mut entries=Vec::new();let mut response_bytes=0;
        loop {
            unsafe{*errno()=0};let entry=unsafe{libc::readdir(stream.0)};
            if entry.is_null(){if unsafe{*errno()}!=0{return Err(std::io::Error::last_os_error().into())}return Ok((entries,true))}
            let raw_name=unsafe{CStr::from_ptr((*entry).d_name.as_ptr())};
            let name=raw_name.to_str().map_err(|_|ScanError("NAME_NOT_UTF8","Directory contains non-Unicode name".into()))?;
            if name=="."||name==".."{continue}if entries.len()==max{return Ok((entries,false))}
            let mut info:libc::stat=unsafe{mem::zeroed()};
            if unsafe{libc::fstatat(current.as_raw_fd(),raw_name.as_ptr(),&mut info,libc::AT_SYMLINK_NOFOLLOW)}<0{let error=std::io::Error::last_os_error();if error.raw_os_error()==Some(libc::ENOENT){continue}return Err(error.into())}
            let kind=match info.st_mode&libc::S_IFMT{libc::S_IFREG=>"file",libc::S_IFDIR=>"directory",libc::S_IFLNK=>"link",_=>"other"};
            let mut entry=json!({"name":name,"type":kind,"identity":format!("posix:{}:{}",info.st_dev,info.st_ino)});
            if kind=="file"{entry["size"]=json!(info.st_size)}if !append_entry(&mut entries,&mut response_bytes,entry){return Ok((entries,false))}
        }
    }
}
#[cfg(not(any(windows,unix)))] mod platform {use super::*; pub(super) fn open_reader(_: &str, _: &str) -> Result<std::fs::File, &'static str> { Err("SAFE_OPEN_UNAVAILABLE") } pub fn scan(_:&str,_:&str,_:usize)->Result<(Vec<Value>,bool),ScanError>{Err(ScanError("SAFE_SCAN_UNAVAILABLE","Unsupported platform".into()))}}
