//go:build windows

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"unsafe"
)

// A connector or secret is read from the exact non-reparse handle acquired.
// Every parent is opened relative to its held parent; no check-then-reopen.
func openRegularNoFollow(filename string) (*os.File, error) {
	root := filepath.Dir(filename)
	leaf := filepath.Base(filename)
	if len(root) < 3 || root[1] != ':' || root[2] != '\\' || strings.ContainsAny(root, "/\x00") {
		return nil, fmt.Errorf("INVALID_ROOT")
	}
	drive, _ := syscall.UTF16PtrFromString(root[:3])
	kind, _, _ := getDriveType.Call(uintptr(unsafe.Pointer(drive)))
	if kind != 3 {
		return nil, fmt.Errorf("SAFE_SCAN_UNAVAILABLE")
	}
	h, _, err := openDirectoryAt(0, "\\??\\"+root[:3])
	if err != nil {
		return nil, err
	}
	defer func() { syscall.CloseHandle(h) }()
	for _, p := range strings.Split(strings.TrimRight(root[3:], "\\"), "\\") {
		if p == "" {
			continue
		}
		if p == "." || p == ".." || strings.Contains(p, ":") {
			return nil, fmt.Errorf("INVALID_ROOT")
		}
		next, _, e := openDirectoryAt(h, p)
		if e != nil {
			return nil, e
		}
		syscall.CloseHandle(h)
		h = next
	}
	chars, err := syscall.UTF16FromString(leaf)
	if err != nil {
		return nil, err
	}
	u := unicodeString{uint16((len(chars) - 1) * 2), uint16(len(chars) * 2), &chars[0]}
	attrs := objectAttributes{RootDirectory: h, ObjectName: &u, Attributes: 0x40}
	attrs.Length = uint32(unsafe.Sizeof(attrs))
	var fileHandle syscall.Handle
	var status ioStatusBlock
	result, _, _ := ntCreateFile.Call(uintptr(unsafe.Pointer(&fileHandle)), 0x100081, uintptr(unsafe.Pointer(&attrs)), uintptr(unsafe.Pointer(&status)), 0, 0, 7, 1, 0x200060, 0, 0)
	runtime.KeepAlive(chars)
	if int32(result) < 0 {
		code, _, _ := ntStatusError.Call(result)
		return nil, syscall.Errno(code)
	}
	var info syscall.ByHandleFileInformation
	if err := syscall.GetFileInformationByHandle(fileHandle, &info); err != nil {
		syscall.CloseHandle(fileHandle)
		return nil, err
	}
	if info.FileAttributes&0x410 != 0 {
		syscall.CloseHandle(fileHandle)
		return nil, fmt.Errorf("REPARSE_POINT: connector is not a regular non-reparse file")
	}
	return os.NewFile(uintptr(fileHandle), filename), nil
}
