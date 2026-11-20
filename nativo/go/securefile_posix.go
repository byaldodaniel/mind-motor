//go:build linux || darwin

package main

import (
	"fmt"
	"golang.org/x/sys/unix"
	"os"
	"path/filepath"
	"strings"
)

func openRegularNoFollow(filename string) (*os.File, error) {
	parent := filepath.Dir(filename)
	leaf := filepath.Base(filename)
	if !strings.HasPrefix(parent, "/") || strings.HasPrefix(parent, "//") {
		return nil, fmt.Errorf("INVALID_ROOT")
	}
	flags := unix.O_RDONLY | unix.O_DIRECTORY | unix.O_NOFOLLOW | unix.O_NONBLOCK | unix.O_CLOEXEC
	fd, err := unix.Open("/", flags, 0)
	if err != nil {
		return nil, err
	}
	defer func() { unix.Close(fd) }()
	for _, p := range strings.Split(parent, "/") {
		if p == "" {
			continue
		}
		if p == "." || p == ".." {
			return nil, fmt.Errorf("INVALID_ROOT")
		}
		next, e := unix.Openat(fd, p, flags, 0)
		if e != nil {
			return nil, e
		}
		unix.Close(fd)
		fd = next
	}
	fileFD, err := unix.Openat(fd, leaf, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	var st unix.Stat_t
	if err = unix.Fstat(fileFD, &st); err != nil {
		unix.Close(fileFD)
		return nil, err
	}
	if st.Mode&unix.S_IFMT != unix.S_IFREG {
		unix.Close(fileFD)
		return nil, fmt.Errorf("not a regular connector file")
	}
	return os.NewFile(uintptr(fileFD), filename), nil
}
