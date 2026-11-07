"""Apertura por componentes y lectura por descriptor. Solo biblioteca estándar.

No usa realpath + open. Las referencias a directorios se adquieren sin seguir
enlaces; los nombres siguientes se resuelven respecto a esas referencias.
El proceso, intérprete, código, Base y espacio de montajes deben ser de confianza.
"""
import contextlib
import errno
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import sys

MAX_BYTES = 1024 * 1024

_parent_spec = importlib.util.spec_from_file_location('native_parent', Path(__file__).with_name('native_parent.py'))
_parent = importlib.util.module_from_spec(_parent_spec)
_parent_spec.loader.exec_module(_parent)


class Refusal(Exception):
    pass


def guard_parent(expected_pid=None):
    try:
        # The launcher supplies the original parent even if POSIX already
        # reparented us to a subreaper before Python finished starting.
        if expected_pid is None and len(sys.argv) > 1 and sys.argv[1] == '--parent-pid':
            if len(sys.argv) != 3:
                raise _parent.ParentGone()
            try:
                expected_pid = int(sys.argv[2])
            except ValueError:
                raise _parent.ParentGone() from None
        return _parent.guard_parent(expected_pid)
    except _parent.ParentGone:
        raise Refusal('SAFE_OPEN_UNAVAILABLE') from None


def component(name):
    if (not isinstance(name, str) or not name or name in ('.', '..')
            or re.search(r'[\\/:\x00-\x1f<>"|?*]', name)
            or name.endswith(('.', ' '))
            or re.match(r'^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)', name, re.I)):
        raise Refusal('UNSAFE_PATH')
    return name


class Posix:
    def __init__(self):
        if (os.open not in os.supports_dir_fd
                or not all(hasattr(os, flag) for flag in ('O_NOFOLLOW', 'O_DIRECTORY', 'O_NONBLOCK'))):
            raise Refusal('SAFE_OPEN_UNAVAILABLE')

    def root(self, root):
        if not root.startswith('/') or root.startswith('//'):
            raise Refusal('UNSAFE_PATH')
        return os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW), root[1:].split('/') if root != '/' else []

    def child(self, parent, name, directory):
        flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
        if directory:
            flags |= os.O_DIRECTORY
        return os.open(component(name), flags, dir_fd=parent)

    def check(self, handle, directory):
        info = os.fstat(handle)
        if (not (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode))
                or (not directory and info.st_nlink != 1)):
            raise Refusal('UNSAFE_PATH')
        return info.st_dev

    close = staticmethod(os.close)

    def descriptor(self, handle):
        return handle


class Windows:
    """NtCreateFile con RootDirectory y exactamente un componente por apertura.

    FILE_OPEN_REPARSE_POINT abre el enlace mismo; se rechaza por atributos del
    handle antes de usarlo como raíz o leerlo. No depende de OBJ_DONT_REPARSE.
    """
    def __init__(self, share_writes=True):
        self.share_writes = share_writes
        import ctypes as c
        from ctypes import wintypes as w
        self.c = c
        self.w = w
        self.kernel = c.WinDLL('kernel32', use_last_error=True)
        self.nt = c.WinDLL('ntdll')

        class Unicode(c.Structure):
            _fields_ = [('Length', w.USHORT), ('MaximumLength', w.USHORT), ('Buffer', w.LPWSTR)]

        class Attributes(c.Structure):
            _fields_ = [('Length', w.ULONG), ('RootDirectory', w.HANDLE),
                        ('ObjectName', c.POINTER(Unicode)), ('Attributes', w.ULONG),
                        ('SecurityDescriptor', w.LPVOID), ('SecurityQualityOfService', w.LPVOID)]

        class Status(c.Structure):
            _fields_ = [('Status', c.c_void_p), ('Information', c.c_size_t)]

        class Info(c.Structure):
            _fields_ = [('attributes', w.DWORD), ('created', w.FILETIME),
                        ('accessed', w.FILETIME), ('written', w.FILETIME),
                        ('volume', w.DWORD), ('size_high', w.DWORD), ('size_low', w.DWORD),
                        ('links', w.DWORD), ('index_high', w.DWORD), ('index_low', w.DWORD)]

        class Standard(c.Structure):
            _fields_ = [('allocated', c.c_longlong), ('eof', c.c_longlong),
                        ('links', w.DWORD), ('delete_pending', c.c_ubyte), ('directory', c.c_ubyte)]

        self.Standard = Standard
        self.Unicode, self.Attributes, self.Status, self.Info = Unicode, Attributes, Status, Info
        self.nt.NtCreateFile.argtypes = [c.POINTER(w.HANDLE), w.DWORD, c.POINTER(Attributes),
                                        c.POINTER(Status), w.LPVOID, w.ULONG, w.ULONG,
                                        w.ULONG, w.ULONG, w.LPVOID, w.ULONG]
        self.nt.NtCreateFile.restype = c.c_long
        self.nt.RtlNtStatusToDosError.argtypes = [c.c_long]
        self.nt.RtlNtStatusToDosError.restype = w.ULONG
        self.kernel.GetFileInformationByHandle.argtypes = [w.HANDLE, c.POINTER(Info)]
        self.kernel.GetFileInformationByHandle.restype = w.BOOL
        self.kernel.GetFileInformationByHandleEx.argtypes = [w.HANDLE, c.c_int, w.LPVOID, w.DWORD]
        self.kernel.GetFileInformationByHandleEx.restype = w.BOOL
        self.volume_information = getattr(self.kernel, 'GetVolumeInformationByHandleW', None)
        if self.volume_information is not None:
            self.volume_information.argtypes = [w.HANDLE, w.LPWSTR, w.DWORD, c.POINTER(w.DWORD),
                                               c.POINTER(w.DWORD), c.POINTER(w.DWORD), w.LPWSTR, w.DWORD]
            self.volume_information.restype = w.BOOL
        self.kernel.GetFileType.argtypes = [w.HANDLE]
        self.kernel.GetFileType.restype = w.DWORD
        self.kernel.CloseHandle.argtypes = [w.HANDLE]
        self.kernel.CloseHandle.restype = w.BOOL
        self.kernel.GetDriveTypeW.argtypes = [w.LPCWSTR]
        self.kernel.GetDriveTypeW.restype = w.UINT

    def _open(self, parent, name, directory):
        c, w = self.c, self.w
        buffer = c.create_unicode_buffer(name)
        length = len(name.encode('utf-16-le'))
        if length > 65532:
            raise Refusal('UNSAFE_PATH')
        text = self.Unicode(length, length + 2, c.cast(buffer, w.LPWSTR))
        attrs = self.Attributes(c.sizeof(self.Attributes), parent, c.pointer(text), 0x40, None, None)
        handle, status = w.HANDLE(), self.Status()
        # Solo lectura/metadatos; FILE_OPEN (1), sin crear ni truncar.
        access = 0x100080 | (0x20 if directory else 1)  # SYNCHRONIZE, READ_ATTRIBUTES, TRAVERSE/READ_DATA
        result = self.nt.NtCreateFile(c.byref(handle), access, c.byref(attrs), c.byref(status),
                                      None, 0, 7 if directory or self.share_writes else 5, 1, 0x200020, None, 0)
        if result < 0:
            raise c.WinError(self.nt.RtlNtStatusToDosError(result))
        return handle.value

    def root(self, root):
        # Solo volúmenes locales con letra. UNC, dispositivos y rutas extendidas
        # se rechazan explícitamente; no se degrada a una apertura convencional.
        if not re.match(r'^[a-zA-Z]:\\', root) or '/' in root:
            raise Refusal('SAFE_OPEN_UNAVAILABLE')
        drive = root[:3]
        if self.kernel.GetDriveTypeW(drive) != 3:  # DRIVE_FIXED
            raise Refusal('SAFE_OPEN_UNAVAILABLE')
        return self._open(None, '\\??\\' + drive, True), root[3:].split('\\') if len(root) > 3 else []

    def child(self, parent, name, directory):
        return self._open(parent, component(name), directory)

    def _fat32_no_hardlinks_flags(self, handle, volume):
        if self.volume_information is None:
            return None
        c, w = self.c, self.w
        serial, flags = w.DWORD(), w.DWORD()
        filesystem = c.create_unicode_buffer(261)
        if not self.volume_information(handle, None, 0, c.byref(serial), None,
                                       c.byref(flags), filesystem, len(filesystem)):
            return None
        if serial.value != volume or filesystem.value != 'FAT32' or flags.value & 0x00400000:
            return None
        return flags.value

    def _zero_links_supported(self, handle, volume):
        # DriveFS expone FAT32 y comunica cero enlaces incluso en archivos nuevos.
        # Sólo se admite con el mismo handle, volumen y capacidades confirmadas.
        if self._fat32_no_hardlinks_flags(handle, volume) is None:
            return False
        standard = self.Standard()
        if not self.kernel.GetFileInformationByHandleEx(handle, 1, self.c.byref(standard), self.c.sizeof(standard)):
            return False
        return standard.links == 0 and not standard.delete_pending and not standard.directory

    def check(self, handle, directory):
        info = self.Info()
        if not self.kernel.GetFileInformationByHandle(handle, self.c.byref(info)):
            raise self.c.WinError(self.c.get_last_error())
        if (self.kernel.GetFileType(handle) != 1 or info.attributes & 0x400
                or bool(info.attributes & 0x10) != directory
                or (not directory and info.links != 1
                    and not (info.links == 0 and self._zero_links_supported(handle, info.volume)))):
            raise Refusal('UNSAFE_PATH')
        return info.volume

    def close(self, handle):
        self.kernel.CloseHandle(handle)

    def descriptor(self, handle):
        import msvcrt
        return msvcrt.open_osfhandle(handle, os.O_RDONLY | os.O_BINARY)


def safe_open(root, relative, after_directory=None, *, share_writes=True):
    """Devuelve un descriptor propio; el llamador debe cerrarlo.

    after_directory se usa únicamente como barrera determinista en pruebas.
    No se activa por argumentos, entorno ni protocolo de producción.
    """
    backend = Windows(share_writes=share_writes) if os.name == 'nt' else Posix()
    parts = [component(part) for part in relative.split('/')]
    with contextlib.ExitStack() as stack:
        parent, ancestors = backend.root(root)
        stack.callback(backend.close, parent)
        backend.check(parent, True)
        for name in ancestors:
            parent = backend.child(parent, name, True)
            stack.callback(backend.close, parent)
            backend.check(parent, True)
        volume = backend.check(parent, True)
        if after_directory:
            after_directory('root')
        for name in parts[:-1]:
            parent = backend.child(parent, name, True)
            stack.callback(backend.close, parent)
            if backend.check(parent, True) != volume:
                raise Refusal('UNSAFE_PATH')
            if after_directory:
                after_directory(name)
        target = backend.child(parent, parts[-1], False)
        try:
            if backend.check(target, False) != volume:
                raise Refusal('UNSAFE_PATH')
            return backend.descriptor(target)
        except BaseException:
            backend.close(target)
            raise


def error_code(error):
    if isinstance(error, _parent.ParentGone):
        return 'SAFE_OPEN_UNAVAILABLE'
    if isinstance(error, Refusal):
        return str(error)
    win = getattr(error, 'winerror', None)
    if isinstance(error, PermissionError) or win in (5, 32, 33):
        return 'ACCESS_DENIED'
    if isinstance(error, FileNotFoundError) or win in (2, 3):
        return 'FILE_NOT_FOUND'
    if getattr(error, 'errno', None) in (errno.ELOOP, errno.ENOTDIR) or win in (1920, 4390, 4392, 4393):
        return 'UNSAFE_PATH'
    return 'READ_FAILED'


def run():
    try:
        guard_parent()
        request = json.loads(sys.stdin.buffer.readline(32768))
        fd = safe_open(request['root'], request['relativePath'])
        with os.fdopen(fd, 'rb', buffering=0) as source:
            sys.stderr.write('READY\n')
            sys.stderr.flush()
            if sys.stdin.buffer.read(1) != b'R':
                raise Refusal('READ_FAILED')
            if os.fstat(source.fileno()).st_size > MAX_BYTES:
                raise Refusal('FILE_TOO_LARGE')
            chunks, size = [], 0
            while size <= MAX_BYTES:
                chunk = source.read(min(65536, MAX_BYTES + 1 - size))
                if not chunk:
                    break
                chunks.append(chunk)
                size += len(chunk)
            data = b''.join(chunks)
            if len(data) > MAX_BYTES:
                raise Refusal('FILE_TOO_LARGE')
            sys.stdout.buffer.write(data)
        return 0
    except Exception as error:
        sys.stderr.write(error_code(error) + '\n')
        return 1


if __name__ == '__main__':
    sys.exit(run())
