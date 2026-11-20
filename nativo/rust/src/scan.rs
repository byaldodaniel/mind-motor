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
#[cfg(windows)]
mod platform {
    use super::*;
    use std::{ffi::c_void,ptr,mem};
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
        fn CloseHandle(handle:Handle)->i32;
        fn GetFileInformationByHandle(handle:Handle,info:*mut Info)->i32;
        fn GetFileInformationByHandleEx(handle:Handle,class:i32,info:*mut c_void,size:u32)->i32;
        fn GetDriveTypeW(root:*const u16)->u32;
        fn GetLastError()->u32;
    }
    struct Directory {handle:Handle,volume:u32}
    impl Drop for Directory {fn drop(&mut self){unsafe{CloseHandle(self.handle);}}}
    fn os_error(code:u32)->ScanError {ScanError("IO_ERROR",format!("Windows error {code}: {}",std::io::Error::from_raw_os_error(code as i32)))}
    fn open(parent:Handle,name:&str,list:bool)->Result<Directory,ScanError> {
        let mut text:Vec<u16>=name.encode_utf16().collect();
        if text.len()>32766{return Err(invalid("Path component too long"))}
        let mut unicode=Unicode{length:(text.len()*2) as u16,max:(text.len()*2) as u16,buffer:text.as_mut_ptr()};
        let mut attrs=Attributes{length:mem::size_of::<Attributes>() as u32,root:parent,name:&mut unicode,flags:0x40,security:ptr::null_mut(),qos:ptr::null_mut()};
        let mut status=Status{status:0,information:0};let mut handle=ptr::null_mut();
        let result=unsafe{NtCreateFile(&mut handle,0x1000A0|if list{1}else{0},&mut attrs,&mut status,ptr::null(),0,7,1,0x200021,ptr::null(),0)};
        if result<0{return Err(os_error(unsafe{RtlNtStatusToDosError(result)}))}
        let mut directory=Directory{handle,volume:0};let mut info=Info::default();
        if unsafe{GetFileInformationByHandle(handle,&mut info)}==0{return Err(os_error(unsafe{GetLastError()}))}
        if info.attributes&0x400!=0||info.attributes&0x10==0{return Err(ScanError("REPARSE_POINT","Directory is a reparse point or changed type".into()))}
        directory.volume=info.volume;Ok(directory)
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
        for (i,part) in parts.iter().enumerate(){let next=open(directory.handle,part,i+1==parts.len())?;if next.volume!=volume{return Err(ScanError("OTHER_VOLUME","Volume changed".into()))}directory=next;}
        // Enumeration and metadata are obtained from the same held directory handle.
        let mut aligned=vec![0u64;8192];let mut entries=Vec::new();let mut response_bytes=0;
        loop {
            if unsafe{GetFileInformationByHandleEx(directory.handle,10,aligned.as_mut_ptr().cast(),65536)}==0 {
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
    fn open(parent:i32,name:&str)->Result<OwnedFd,ScanError>{let name=CString::new(name).map_err(|_|invalid("NUL in path"))?;let fd=unsafe{libc::openat(parent,name.as_ptr(),FLAGS)};if fd<0{return Err(std::io::Error::last_os_error().into())}Ok(unsafe{OwnedFd::from_raw_fd(fd)})}
    fn stat(fd:i32)->Result<libc::stat,ScanError>{let mut s=unsafe{mem::zeroed()};if unsafe{libc::fstat(fd,&mut s)}<0{return Err(std::io::Error::last_os_error().into())}Ok(s)}
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
#[cfg(not(any(windows,unix)))] mod platform {use super::*;pub fn scan(_:&str,_:&str,_:usize)->Result<(Vec<Value>,bool),ScanError>{Err(ScanError("SAFE_SCAN_UNAVAILABLE","Unsupported platform".into()))}}




