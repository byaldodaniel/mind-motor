//go:build !windows

package main

import (
	"os/exec"
	"syscall"
)

func configureChild(cmd *exec.Cmd) { cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true} }
