//go:build linux || darwin

package main

import (
	"fmt"
	"golang.org/x/sys/unix"
	"io"
	"os"
	"strings"
	"unicode/utf8"
)

func scanDirectory(root string, relative []string, max int) ([]scanEntry, bool, error) {
	if !strings.HasPrefix(root, "/") || strings.HasPrefix(root, "//") || strings.ContainsRune(root, 0) {
		return nil, false, fmt.Errorf("INVALID_ROOT")
	}
	var parts []string
	for _, p := range strings.Split(root, "/") {
		if p == "" {
			continue
		}
		if p == "." || p == ".." {
			return nil, false, fmt.Errorf("INVALID_ROOT")
		}
		parts = append(parts, p)
	}
	parts = append(parts, relative...)
	flags := unix.O_RDONLY | unix.O_DIRECTORY | unix.O_NOFOLLOW | unix.O_NONBLOCK | unix.O_CLOEXEC
	fd, err := unix.Open("/", flags, 0)
	if err != nil {
		return nil, false, err
	}
	for _, p := range parts {
		next, e := unix.Openat(fd, p, flags, 0)
		if e != nil {
			unix.Close(fd)
			return nil, false, e
		}
		unix.Close(fd)
		fd = next
	}
	file := os.NewFile(uintptr(fd), "mind-scan-directory")
	defer file.Close()
	entries := make([]scanEntry, 0)
	for {
		names, e := file.Readdirnames(256)
		for _, name := range names {
			if !utf8.ValidString(name) {
				return entries, false, fmt.Errorf("NAME_NOT_UTF8: undecodable directory entry")
			}
			if len(entries) >= max {
				return entries, false, nil
			}
			var st unix.Stat_t
			se := unix.Fstatat(fd, name, &st, unix.AT_SYMLINK_NOFOLLOW)
			if se != nil {
				if os.IsNotExist(se) {
					continue
				}
				entries = append(entries, scanEntry{Name: name, Type: "other", Error: se.Error()})
				return entries, false, se
			}
			entry := scanEntry{Name: name, Identity: fmt.Sprintf("posix:%d:%d", st.Dev, st.Ino), Type: "other"}
			switch st.Mode & unix.S_IFMT {
			case unix.S_IFDIR:
				entry.Type = "directory"
			case unix.S_IFLNK:
				entry.Type = "link"
			case unix.S_IFREG:
				entry.Type = "file"
				size := st.Size
				entry.Size = &size
			}
			entries = append(entries, entry)
		}
		if e == io.EOF {
			return entries, true, nil
		}
		if e != nil {
			return entries, false, e
		}
	}
}
