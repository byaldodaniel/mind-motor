"""List the direct children of a live test motor using Windows Tool Help."""
import ctypes as c
from ctypes import wintypes as w
from contextlib import contextmanager
import json
import sys


class ProcessEntry(c.Structure):
    _fields_ = [
        ("size", w.DWORD), ("usage", w.DWORD), ("pid", w.DWORD),
        ("default_heap", c.c_size_t), ("module", w.DWORD), ("threads", w.DWORD),
        ("parent", w.DWORD), ("priority", w.LONG), ("flags", w.DWORD),
        ("exe", w.WCHAR * 260),
    ]


kernel = c.WinDLL("kernel32", use_last_error=True)


def api(name, result, *arguments):
    function = getattr(kernel, name)
    function.restype = result
    function.argtypes = arguments
    return function


snapshot = api("CreateToolhelp32Snapshot", w.HANDLE, w.DWORD, w.DWORD)
first = api("Process32FirstW", w.BOOL, w.HANDLE, c.POINTER(ProcessEntry))
next_entry = api("Process32NextW", w.BOOL, w.HANDLE, c.POINTER(ProcessEntry))
open_process = api("OpenProcess", w.HANDLE, w.DWORD, w.BOOL, w.DWORD)
close = api("CloseHandle", w.BOOL, w.HANDLE)
times = api("GetProcessTimes", w.BOOL, w.HANDLE, *([c.POINTER(w.FILETIME)] * 4))
image = api("QueryFullProcessImageNameW", w.BOOL, w.HANDLE, w.DWORD, w.LPWSTR, c.POINTER(w.DWORD))


@contextmanager
def handle(value):
    if not value or value == c.c_void_p(-1).value:
        raise c.WinError(c.get_last_error())
    try:
        yield value
    finally:
        close(value)


def created(process):
    stamps = [w.FILETIME() for _ in range(4)]
    if not times(process, *(c.byref(stamp) for stamp in stamps)):
        raise c.WinError(c.get_last_error())
    return (stamps[0].dwHighDateTime << 32) | stamps[0].dwLowDateTime


def children(parent_pid):
    result = []
    query_limited = 0x1000  # PROCESS_QUERY_LIMITED_INFORMATION
    with handle(open_process(query_limited, False, parent_pid)) as parent:
        parent_start = created(parent)
        with handle(snapshot(0x2, 0)) as table:  # TH32CS_SNAPPROCESS
            entry = ProcessEntry(size=c.sizeof(ProcessEntry))
            available = first(table, c.byref(entry))
            while available:
                if entry.parent == parent_pid:
                    child_handle = open_process(query_limited, False, entry.pid)
                    # A child can already have exited between the snapshot and this call.
                    if child_handle or c.get_last_error() != 87:  # ERROR_INVALID_PARAMETER
                        with handle(child_handle) as child:
                            if created(child) >= parent_start:
                                length = w.DWORD(32768)
                                name = c.create_unicode_buffer(length.value)
                                if not image(child, 0, name, c.byref(length)):
                                    raise c.WinError(c.get_last_error())
                                result.append({"pid": entry.pid, "path": name.value})
                available = next_entry(table, c.byref(entry))
            if c.get_last_error() != 18:  # ERROR_NO_MORE_FILES
                raise c.WinError(c.get_last_error())
    return result


if __name__ == "__main__":
    print(json.dumps(children(int(sys.argv[1]))))
