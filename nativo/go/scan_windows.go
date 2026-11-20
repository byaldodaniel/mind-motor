//go:build windows

package main

import (
	"encoding/binary"
	"fmt"
	"runtime"
	"strings"
	"syscall"
	"unicode/utf16"
	"unsafe"
)

var ntDLL = syscall.NewLazyDLL("ntdll.dll")
var ntCreateFile = ntDLL.NewProc("NtCreateFile")
var ntStatusError = ntDLL.NewProc("RtlNtStatusToDosError")
var kernelDLL = syscall.NewLazyDLL("kernel32.dll")
var fileInfoEx = kernelDLL.NewProc("GetFileInformationByHandleEx")
var getDriveType = kernelDLL.NewProc("GetDriveTypeW")

type unicodeString struct {
	Length        uint16
	MaximumLength uint16
	Buffer        *uint16
}
type objectAttributes struct {
	Length                   uint32
	RootDirectory            syscall.Handle
	ObjectName               *unicodeString
	Attributes               uint32
	SecurityDescriptor       uintptr
	SecurityQualityOfService uintptr
}
type ioStatusBlock struct {
	Status      uintptr
	Information uintptr
}

func openDirectoryAt(parent syscall.Handle, name string) (syscall.Handle, uint32, error) {
	chars, err := syscall.UTF16FromString(name)
	if err != nil {
		return 0, 0, err
	}
	if len(chars) > 32767 {
		return 0, 0, fmt.Errorf("INVALID_ROOT: path too long")
	}
	u := unicodeString{uint16((len(chars) - 1) * 2), uint16(len(chars) * 2), &chars[0]}
	attrs := objectAttributes{RootDirectory: parent, ObjectName: &u, Attributes: 0x40}
	attrs.Length = uint32(unsafe.Sizeof(attrs))
	var h syscall.Handle
	var status ioStatusBlock
	result, _, _ := ntCreateFile.Call(uintptr(unsafe.Pointer(&h)), 0x1000a1, uintptr(unsafe.Pointer(&attrs)), uintptr(unsafe.Pointer(&status)), 0, 0, 7, 1, 0x200021, 0, 0)
	runtime.KeepAlive(chars)
	if int32(result) < 0 {
		code, _, _ := ntStatusError.Call(result)
		return 0, 0, syscall.Errno(code)
	}
	var info syscall.ByHandleFileInformation
	if err := syscall.GetFileInformationByHandle(h, &info); err != nil {
		syscall.CloseHandle(h)
		return 0, 0, err
	}
	if info.FileAttributes&0x400 != 0 {
		syscall.CloseHandle(h)
		return 0, 0, fmt.Errorf("REPARSE_POINT: directory denied")
	}
	if info.FileAttributes&0x10 == 0 {
		syscall.CloseHandle(h)
		return 0, 0, fmt.Errorf("SCOPE_CHANGED: not a directory")
	}
	return h, info.VolumeSerialNumber, nil
}
func scanDirectory(root string, relative []string, max int) ([]scanEntry, bool, error) {
	if len(root) < 3 || root[1] != ':' || root[2] != '\\' || strings.ContainsAny(root, "/\x00") || !((root[0] >= 'a' && root[0] <= 'z') || (root[0] >= 'A' && root[0] <= 'Z')) {
		return nil, false, fmt.Errorf("INVALID_ROOT: expected fixed local drive path")
	}
	drive, _ := syscall.UTF16PtrFromString(root[:3])
	kind, _, _ := getDriveType.Call(uintptr(unsafe.Pointer(drive)))
	if kind != 3 {
		return nil, false, fmt.Errorf("SAFE_SCAN_UNAVAILABLE: only fixed local volumes")
	}
	var parts []string
	for _, p := range strings.Split(strings.TrimRight(root[3:], "\\"), "\\") {
		if p == "" {
			continue
		}
		if p == "." || p == ".." || strings.Contains(p, ":") {
			return nil, false, fmt.Errorf("INVALID_ROOT")
		}
		parts = append(parts, p)
	}
	parts = append(parts, relative...)
	h, volume, err := openDirectoryAt(0, "\\??\\"+root[:3])
	if err != nil {
		return nil, false, err
	}
	defer func() { syscall.CloseHandle(h) }()
	for _, p := range parts {
		next, v, e := openDirectoryAt(h, p)
		if e != nil {
			return nil, false, e
		}
		syscall.CloseHandle(h)
		h = next
		volume = v
	}
	entries := make([]scanEntry, 0)
	buffer := make([]byte, 65536)
	for {
		ok, _, e := fileInfoEx.Call(uintptr(h), 10, uintptr(unsafe.Pointer(&buffer[0])), uintptr(len(buffer)))
		if ok == 0 {
			if e == syscall.Errno(18) {
				return entries, true, nil
			}
			return entries, false, e
		}
		for offset := 0; ; {
			if offset+104 > len(buffer) {
				return entries, false, fmt.Errorf("SCAN_FAILED: invalid directory record")
			}
			b := buffer[offset:]
			next := int(binary.LittleEndian.Uint32(b[0:4]))
			size := int64(binary.LittleEndian.Uint64(b[40:48]))
			attrs := binary.LittleEndian.Uint32(b[56:60])
			nameBytes := int(binary.LittleEndian.Uint32(b[60:64]))
			identity := binary.LittleEndian.Uint64(b[96:104])
			if nameBytes%2 != 0 || 104+nameBytes > len(b) {
				return entries, false, fmt.Errorf("SCAN_FAILED: invalid directory name")
			}
			codes := make([]uint16, nameBytes/2)
			for i := range codes {
				codes[i] = binary.LittleEndian.Uint16(b[104+i*2:])
			}
			for i := 0; i < len(codes); i++ {
				if codes[i] >= 0xd800 && codes[i] <= 0xdbff {
					if i+1 >= len(codes) || codes[i+1] < 0xdc00 || codes[i+1] > 0xdfff {
						return entries, false, fmt.Errorf("NAME_NOT_UTF8: unpaired UTF-16 surrogate")
					}
					i++
				} else if codes[i] >= 0xdc00 && codes[i] <= 0xdfff {
					return entries, false, fmt.Errorf("NAME_NOT_UTF8: unpaired UTF-16 surrogate")
				}
			}
			name := string(utf16.Decode(codes))
			if name != "." && name != ".." {
				if len(entries) >= max {
					return entries, false, nil
				}
				entry := scanEntry{Name: name, Type: "file", Identity: fmt.Sprintf("nt:%d:%d", volume, identity)}
				if identity == 0 {
					entry.Identity = ""
				}
				if attrs&0x400 != 0 {
					entry.Type = "link"
				} else if attrs&0x10 != 0 {
					entry.Type = "directory"
				} else {
					entry.Size = &size
				}
				entries = append(entries, entry)
			}
			if next == 0 {
				break
			}
			if next < 104 || offset+next <= offset || offset+next >= len(buffer) {
				return entries, false, fmt.Errorf("SCAN_FAILED: invalid next offset")
			}
			offset += next
		}
	}
}
