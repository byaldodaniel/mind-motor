"""Lifetime of a native helper, bound to its actual parent (standard library only).

This module is loaded by absolute trusted-code location, also under python -I.
It never opens or kills another process by name. Windows retains a process
HANDLE and checks creation times, so PID reuse cannot transfer ownership.
"""
import math
import os
import threading
import time


class ParentGone(Exception):
    pass


class ParentGuard:
    def __init__(self):
        self._lock = threading.Lock()
        self._commit_deadline = None
        self._parent_gone = False

    def begin_commit(self, timeout_seconds):
        """After W, permit an accepted mutation to finish if its parent dies.

        The allowance is bounded from confirmation, not extended on parent
        death. It does not authorize an operation or change its atomicity.
        """
        if (not isinstance(timeout_seconds, (int, float)) or isinstance(timeout_seconds, bool)
                or not math.isfinite(timeout_seconds) or not 0 < timeout_seconds <= 120):
            raise ValueError('Invalid commit deadline')
        with self._lock:
            if self._parent_gone:
                raise ParentGone()
            if self._commit_deadline is None:
                self._commit_deadline = time.monotonic() + timeout_seconds

    def parent_exited(self):
        with self._lock:
            self._parent_gone = True
            remaining = max(0, (self._commit_deadline or 0) - time.monotonic())
        if remaining:
            threading.Event().wait(remaining)
        # Exit only this helper, including a thread blocked in native I/O.
        os._exit(74)


def guard_parent(expected_pid=None):
    parent_pid = os.getppid()
    if parent_pid <= 1 or (expected_pid is not None and expected_pid != parent_pid):
        raise ParentGone()
    guard = ParentGuard()
    if os.name == 'nt':
        import ctypes as c
        from ctypes import wintypes as w
        kernel = c.WinDLL('kernel32', use_last_error=True)
        kernel.OpenProcess.argtypes = [w.DWORD, w.BOOL, w.DWORD]
        kernel.OpenProcess.restype = w.HANDLE
        kernel.GetCurrentProcess.restype = w.HANDLE
        kernel.GetProcessTimes.argtypes = [w.HANDLE] + [c.POINTER(w.FILETIME)] * 4
        kernel.GetProcessTimes.restype = w.BOOL
        kernel.WaitForSingleObject.argtypes = [w.HANDLE, w.DWORD]
        kernel.WaitForSingleObject.restype = w.DWORD
        kernel.CloseHandle.argtypes = [w.HANDLE]
        kernel.CloseHandle.restype = w.BOOL
        handle = kernel.OpenProcess(0x00100000 | 0x1000, False, parent_pid)
        if not handle:
            raise ParentGone()

        def created(process):
            values = [w.FILETIME() for _ in range(4)]
            if not kernel.GetProcessTimes(process, *(c.byref(value) for value in values)):
                raise ParentGone()
            return (values[0].dwHighDateTime << 32) | values[0].dwLowDateTime

        try:
            # Equal timestamps are ambiguous: fail closed rather than accept a
            # process that reused the parent PID before this handle was opened.
            if created(handle) >= created(kernel.GetCurrentProcess()) or kernel.WaitForSingleObject(handle, 0) != 258:
                raise ParentGone()
        except BaseException:
            kernel.CloseHandle(handle)
            raise

        def watch():
            try:
                # WAIT_TIMEOUT=258; signaled handle or wait failure ends only us.
                while kernel.WaitForSingleObject(handle, 250) == 258:
                    pass
            finally:
                kernel.CloseHandle(handle)
            guard.parent_exited()
    else:
        def watch():
            while os.getppid() == parent_pid:
                threading.Event().wait(0.25)
            guard.parent_exited()
    threading.Thread(target=watch, name='mind-parent-guard', daemon=True).start()
    return guard
