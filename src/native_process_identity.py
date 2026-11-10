"""Read-only bounded process identity probe; standard library only, no process mutations."""
import ctypes as c
import errno
import json
import os
from pathlib import Path
import sys

def missing(pid):
    return {"pid": pid, "status": "missing"}

def unknown(pid, reason):
    return {"pid": pid, "status": "unknown", "reason": reason}

def windows(pid):
    from ctypes import wintypes as w
    kernel = c.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.argtypes = [w.DWORD, w.BOOL, w.DWORD]
    kernel.OpenProcess.restype = w.HANDLE
    kernel.GetProcessTimes.argtypes = [w.HANDLE] + [c.POINTER(w.FILETIME)] * 4
    kernel.GetProcessTimes.restype = w.BOOL
    kernel.QueryFullProcessImageNameW.argtypes = [w.HANDLE, w.DWORD, w.LPWSTR, c.POINTER(w.DWORD)]
    kernel.QueryFullProcessImageNameW.restype = w.BOOL
    kernel.WaitForSingleObject.argtypes = [w.HANDLE, w.DWORD]
    kernel.WaitForSingleObject.restype = w.DWORD
    kernel.CloseHandle.argtypes = [w.HANDLE]
    handle = kernel.OpenProcess(0x00100000 | 0x1000, False, pid)
    if not handle:
        code = c.get_last_error()
        return missing(pid) if code == 87 else unknown(pid, "access-denied" if code == 5 else "native-query-failed")
    try:
        wait = kernel.WaitForSingleObject(handle, 0)
        if wait == 0:
            return missing(pid)
        if wait != 258:
            return unknown(pid, "native-query-failed")
        times = [w.FILETIME() for _ in range(4)]
        if not kernel.GetProcessTimes(handle, *(c.byref(v) for v in times)):
            return unknown(pid, "access-denied")
        birth = (times[0].dwHighDateTime << 32) | times[0].dwLowDateTime
        size = w.DWORD(32768)
        buffer = c.create_unicode_buffer(size.value)
        executable = buffer.value if kernel.QueryFullProcessImageNameW(handle, 0, buffer, c.byref(size)) else None
        return {"pid": pid, "status": "present", "processBirth": "win32:" + str(birth),
                "processStartedAt": (birth - 116444736000000000) // 10000, "executable": executable}
    finally:
        kernel.CloseHandle(handle)

def linux(pid):
    root = Path("/proc") / str(pid)
    def stat():
        value = (root / "stat").read_text()
        parts = value[value.rfind(")") + 2:].split()
        return parts[0], parts[19]
    state, birth = stat()
    if state in ("Z", "X"):
        return missing(pid)
    boot = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
    executable = os.readlink(root / "exe")
    args = (root / "cmdline").read_bytes()[:32768].decode(errors="replace").split("\0")
    again_state, again_birth = stat()
    if birth != again_birth or again_state in ("Z", "X"):
        return unknown(pid, "process-changed")
    started = None
    for line in Path("/proc/stat").read_text().splitlines():
        if line.startswith("btime "):
            started = int(line.split()[1]) * 1000 + int(birth) * 1000 // os.sysconf("SC_CLK_TCK")
            break
    return {"pid": pid, "status": "present", "processBirth": "linux:" + boot + ":" + birth,
            "processStartedAt": started, "executable": executable, "argv": args}

def darwin(pid):
    class BSDInfo(c.Structure):
        _fields_ = [(name, c.c_uint32) for name in (
            "flags", "status", "xstatus", "pid", "ppid", "uid", "gid", "ruid",
            "rgid", "svuid", "svgid", "rfu")] + [
            ("comm", c.c_char * 16), ("name", c.c_char * 32)] + [
            (name, c.c_uint32) for name in ("nfiles", "pgid", "pjobc", "e_tdev", "e_tpgid", "nice")] + [
            ("start_sec", c.c_uint64), ("start_usec", c.c_uint64)]
    lib = c.CDLL("/usr/lib/libproc.dylib", use_errno=True)
    lib.proc_pidinfo.argtypes = [c.c_int, c.c_int, c.c_uint64, c.c_void_p, c.c_int]
    lib.proc_pidinfo.restype = c.c_int
    lib.proc_pidpath.argtypes = [c.c_int, c.c_void_p, c.c_uint32]
    lib.proc_pidpath.restype = c.c_int
    def info():
        value = BSDInfo()
        got = lib.proc_pidinfo(pid, 3, 0, c.byref(value), c.sizeof(value))
        if got != c.sizeof(value):
            if c.get_errno() == errno.ESRCH:
                raise ProcessLookupError()
            raise PermissionError()
        return value
    value = info()
    buffer = c.create_string_buffer(4096)
    executable = buffer.value.decode(errors="replace") if lib.proc_pidpath(pid, buffer, len(buffer)) > 0 else None
    again = info()
    if (value.start_sec, value.start_usec) != (again.start_sec, again.start_usec):
        return unknown(pid, "process-changed")
    return {"pid": pid, "status": "present", "processBirth": "darwin:" + str(value.start_sec) + ":" + str(value.start_usec),
            "processStartedAt": value.start_sec * 1000 + value.start_usec // 1000, "executable": executable}

def query(pid):
    try:
        if sys.platform == "win32":
            return windows(pid)
        if sys.platform == "linux":
            return linux(pid)
        if sys.platform == "darwin":
            return darwin(pid)
        return unknown(pid, "unsupported-platform")
    except (FileNotFoundError, ProcessLookupError):
        return missing(pid)
    except PermissionError:
        return unknown(pid, "access-denied")
    except (OSError, ValueError, IndexError, OverflowError):
        return unknown(pid, "native-query-failed")

def main():
    raw = sys.stdin.buffer.read(65537)
    if len(raw) > 65536:
        raise ValueError("oversized")
    pids = json.loads(raw).get("pids")
    if not isinstance(pids, list) or len(pids) > 256 or any(
            not isinstance(pid, int) or isinstance(pid, bool) or not 0 < pid <= 0xffffffff for pid in pids):
        raise ValueError("invalid pids")
    print(json.dumps({"processes": [query(pid) for pid in dict.fromkeys(pids)]}))

if __name__ == "__main__":
    try:
        main()
    except Exception:
        print(json.dumps({"error": "INVALID_PROCESS_QUERY"}))
        sys.exit(1)
