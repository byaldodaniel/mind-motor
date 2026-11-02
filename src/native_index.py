"""Recorrido de metadatos por referencias de directorio. Solo biblioteca estándar.

Cada carpeta se abre respecto a la referencia ya adquirida de su padre, sin
seguir enlaces, y se lista desde esa misma referencia. Ninguna ruta completa se
vuelve a resolver durante el recorrido: sustituir un componente por un enlace
no puede hacer que se listen nombres de fuera de la raíz autorizada.
No abre archivos regulares ni lee su contenido.
"""
import errno
import json
import os
import re
import stat
import sys

WINDOWS_EPOCH = 116444736000000000  # 1970-01-01 en intervalos de 100 ns desde 1601.
LINK_TAGS = (0xA000000C, 0xA0000003)  # IO_REPARSE_TAG_SYMLINK y MOUNT_POINT (junction).


class Refusal(Exception):
    pass


class ScopeError(Exception):
    pass


def code_of(error):
    if isinstance(error, Refusal):
        return str(error)
    win = getattr(error, 'winerror', None)
    if win in (2, 3):
        return 'ENOENT'
    if win == 5:
        return 'EACCES'
    if win in (32, 33):
        return 'EBUSY'
    if win == 267:
        return 'ENOTDIR'
    if win in (1920, 4390, 4392, 4393):
        return 'ELOOP'
    return errno.errorcode.get(getattr(error, 'errno', None), 'EIO')


def utf8(name):
    try:
        name.encode('utf-8')
        return True
    except UnicodeEncodeError:
        return False


class Child:
    __slots__ = ('name', 'type', 'size', 'modified', 'changed', 'created',
                 'volume', 'identity', 'listing', 'error')

    def __init__(self, name, **values):
        self.name = name
        for slot in self.__slots__[1:]:
            setattr(self, slot, values.get(slot))


class Posix:
    FLAGS = os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0) | getattr(os, 'O_NOFOLLOW', 0) \
        | getattr(os, 'O_NONBLOCK', 0) | getattr(os, 'O_CLOEXEC', 0)

    def __init__(self):
        if (os.open not in os.supports_dir_fd or os.stat not in os.supports_dir_fd
                or os.scandir not in os.supports_fd
                or not all(hasattr(os, flag) for flag in ('O_NOFOLLOW', 'O_DIRECTORY'))):
            raise Refusal('SAFE_SCAN_UNAVAILABLE')

    def open_root(self, root):
        if not root.startswith('/') or root.startswith('//') or '\0' in root:
            raise Refusal('SAFE_SCAN_UNAVAILABLE')
        handle = os.open('/', self.FLAGS)
        try:
            for name in [part for part in root.split('/') if part]:
                parent = handle
                handle = os.open(name, self.FLAGS, dir_fd=parent)
                os.close(parent)
            return handle, os.fstat(handle).st_dev
        except BaseException:
            os.close(handle)
            raise

    def open_child(self, parent, child):
        handle = os.open(child.name, self.FLAGS, dir_fd=parent)
        try:
            info = os.fstat(handle)
            # El objeto abierto debe ser el mismo directorio cuyos metadatos se registraron.
            if not stat.S_ISDIR(info.st_mode) or (info.st_dev, info.st_ino) != child.identity:
                raise Refusal('ECHANGED')
            return handle
        except BaseException:
            os.close(handle)
            raise

    def children(self, handle, volume):
        names = []
        with os.scandir(handle) as entries:
            for entry in entries:
                names.append(entry.name)
        result = []
        for name in names:
            if not utf8(name):
                result.append(Child(name, error='NAME_NOT_UTF8'))
                continue
            try:
                info = os.stat(name, dir_fd=handle, follow_symlinks=False)
            except FileNotFoundError:
                continue
            except OSError as error:
                result.append(Child(name, error=code_of(error)))
                continue
            mode = info.st_mode
            kind = ('link' if stat.S_ISLNK(mode) else 'directory' if stat.S_ISDIR(mode)
                    else 'file' if stat.S_ISREG(mode) else 'other')
            birth = getattr(info, 'st_birthtime', None)
            result.append(Child(
                name, type=kind, size=info.st_size if kind == 'file' else None,
                modified=info.st_mtime_ns // 1_000_000, changed=info.st_ctime_ns // 1_000_000,
                created=int(birth * 1000) if birth else None,
                volume=info.st_dev, identity=(info.st_dev, info.st_ino),
                listing='OTHER_VOLUME' if kind == 'directory' and info.st_dev != volume else None))
        return result

    close = staticmethod(os.close)


class Windows:
    """NtCreateFile con RootDirectory, un componente por apertura y
    FILE_OPEN_REPARSE_POINT; la enumeración usa el mismo handle."""

    TRAVERSE = 0x100000 | 0x80 | 0x20  # SYNCHRONIZE, READ_ATTRIBUTES, TRAVERSE
    LIST = TRAVERSE | 0x1  # + LIST_DIRECTORY

    def __init__(self):
        import ctypes as c
        from ctypes import wintypes as w
        self.c, self.w = c, w
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
        self.kernel.CloseHandle.argtypes = [w.HANDLE]
        self.kernel.CloseHandle.restype = w.BOOL
        self.kernel.GetDriveTypeW.argtypes = [w.LPCWSTR]
        self.kernel.GetDriveTypeW.restype = w.UINT

    def _open(self, parent, name, access):
        c, w = self.c, self.w
        buffer = c.create_unicode_buffer(name)
        length = len(name.encode('utf-16-le', 'surrogatepass'))
        if length > 65532:
            raise Refusal('ENAMETOOLONG')
        text = self.Unicode(length, length + 2, c.cast(buffer, w.LPWSTR))
        attrs = self.Attributes(c.sizeof(self.Attributes), parent, c.pointer(text), 0x40, None, None)
        handle, status = w.HANDLE(), self.Status()
        # FILE_OPEN (1); FILE_DIRECTORY_FILE | SYNCHRONOUS_IO_NONALERT | OPEN_REPARSE_POINT.
        result = self.nt.NtCreateFile(c.byref(handle), access, c.byref(attrs), c.byref(status),
                                      None, 0, 7, 1, 0x200021, None, 0)
        if result < 0:
            raise c.WinError(self.nt.RtlNtStatusToDosError(result))
        try:
            info = self.Info()
            if not self.kernel.GetFileInformationByHandle(handle, c.byref(info)):
                raise c.WinError(c.get_last_error())
            if info.attributes & 0x400 or not info.attributes & 0x10:
                raise Refusal('ECHANGED')
            return handle.value, info.volume
        except BaseException:
            self.kernel.CloseHandle(handle)
            raise

    def open_root(self, root):
        # Solo volúmenes locales fijos con letra; UNC y dispositivos se deniegan.
        if not re.match(r'^[a-zA-Z]:\\', root) or '/' in root or '\0' in root:
            raise Refusal('SAFE_SCAN_UNAVAILABLE')
        if self.kernel.GetDriveTypeW(root[:3]) != 3:
            raise Refusal('SAFE_SCAN_UNAVAILABLE')
        names = [part for part in root[3:].split('\\') if part]
        handle, volume = self._open(None, '\\??\\' + root[:3], self.LIST if not names else self.TRAVERSE)
        try:
            for index, name in enumerate(names):
                parent = handle
                handle, volume = self._open(parent, name, self.LIST if index == len(names) - 1 else self.TRAVERSE)
                self.close(parent)
            return handle, volume
        except BaseException:
            self.close(handle)
            raise

    def open_child(self, parent, child):
        if '\\' in child.name or '/' in child.name or '\0' in child.name:
            raise Refusal('ECHANGED')
        handle, volume = self._open(parent, child.name, self.LIST)
        if volume != child.volume:
            self.close(handle)
            raise Refusal('OTHER_VOLUME')
        return handle

    def children(self, handle, volume):
        c = self.c
        size = 65536
        buffer = c.create_string_buffer(size)
        result = []
        while True:
            # FileIdBothDirectoryInfo (10): metadatos e identidad del mismo recorrido.
            if not self.kernel.GetFileInformationByHandleEx(handle, 10, buffer, size):
                error = c.get_last_error()
                if error == 18:  # ERROR_NO_MORE_FILES
                    return result
                raise c.WinError(error)
            offset = 0
            raw = buffer.raw
            while True:
                following = int.from_bytes(raw[offset:offset + 4], 'little')
                created, _, written, changed, end = (
                    int.from_bytes(raw[offset + at:offset + at + 8], 'little', signed=True)
                    for at in (8, 16, 24, 32, 40))
                attributes = int.from_bytes(raw[offset + 56:offset + 60], 'little')
                length = int.from_bytes(raw[offset + 60:offset + 64], 'little')
                tag = int.from_bytes(raw[offset + 64:offset + 68], 'little')  # EaSize: etiqueta de reparse
                file_id = int.from_bytes(raw[offset + 96:offset + 104], 'little')
                name = raw[offset + 104:offset + 104 + length].decode('utf-16-le', 'surrogatepass')
                if name not in ('.', '..'):
                    child = self._child(name, attributes, tag, created, written, changed, end, volume)
                    child.identity = (volume, file_id) if file_id else None
                    result.append(child)
                if following == 0:
                    break
                offset += following

    @staticmethod
    def _child(name, attributes, tag, created, written, changed, end, volume):
        if not utf8(name):
            return Child(name, error='NAME_NOT_UTF8')
        ms = lambda value: (value - WINDOWS_EPOCH) // 10_000 if value > 0 else None
        reparse = bool(attributes & 0x400)
        directory = bool(attributes & 0x10)
        kind = 'link' if reparse and tag in LINK_TAGS else 'directory' if directory else 'file'
        return Child(name, type=kind, size=end if kind == 'file' else None,
                     modified=ms(written), changed=ms(changed), created=ms(created),
                     volume=volume, listing='REPARSE_POINT' if kind == 'directory' and reparse else None)

    def close(self, handle):
        self.kernel.CloseHandle(handle)


# Windows y macOS no distinguen mayúsculas por defecto: una exclusión debe cubrir
# el mismo nombre escrito de otra forma.
FOLD_CASE = os.name == 'nt' or sys.platform == 'darwin'


def _key(relative):
    return relative.lower() if FOLD_CASE else relative


def scan(root, max_entries, backend=None, before_open=None, exclude=()):
    """Devuelve registros e incidencias. before_open solo es una barrera de pruebas.

    exclude: rutas relativas ("/") que el usuario excluyó. No se registran ni se
    abren: tampoco se listan ni se recorren sus descendientes.
    """
    backend = backend or (Windows() if os.name == 'nt' else Posix())
    excluded = frozenset(_key(item) for item in exclude)
    try:
        handle, volume = backend.open_root(root)
    except Refusal as error:
        if str(error) == 'ECHANGED':
            raise ScopeError('SCOPE_CHANGED') from error
        raise
    except FileNotFoundError as error:
        raise ScopeError('SCOPE_UNAVAILABLE') from error
    except OSError as error:
        changed = code_of(error) in ('ELOOP', 'ENOTDIR')
        raise ScopeError('SCOPE_CHANGED' if changed else 'SCOPE_UNAVAILABLE') from error
    records, issues, stack = [], [], []

    def add(record):
        records.append(record)
        if len(records) > max_entries:
            raise Refusal('INDEX_LIMIT_EXCEEDED')

    try:
        try:
            stack.append((handle, '', iter(backend.children(handle, volume))))
        except OSError as error:
            backend.close(handle)
            raise ScopeError('SCOPE_UNAVAILABLE') from error
        while stack:
            parent, base, pending = stack[-1]
            child = next(pending, None)
            if child is None:
                stack.pop()
                backend.close(parent)
                continue
            relative = f'{base}/{child.name}' if base else child.name
            if excluded and _key(relative) in excluded:
                continue
            if child.error == 'NAME_NOT_UTF8':
                issues.append({'path': base, 'code': child.error})
                continue
            if child.error:
                add({'path': relative, 'error': child.error})
                continue
            record = {'path': relative, 'type': child.type, 'size': child.size,
                      'modifiedMs': child.modified, 'changedMs': child.changed,
                      'createdMs': child.created, 'listing': child.listing,
                      'identity': f'{os.name}:' + ':'.join(str(part) for part in child.identity) if child.identity else None}
            add(record)
            if child.type != 'directory' or child.listing is not None:
                continue
            try:
                if before_open:
                    before_open(relative)
                opened = backend.open_child(parent, child)
            except FileNotFoundError:
                records.pop()  # Desapareció: es una eliminación real.
                continue
            except (OSError, Refusal) as error:
                code = code_of(error)
                # Un componente convertido en enlace o archivo no se sigue.
                record['listing'] = 'ECHANGED' if code in ('ELOOP', 'ENOTDIR') else code
                continue
            try:
                listed = backend.children(opened, volume)
            except OSError as error:
                backend.close(opened)
                record['listing'] = code_of(error)
                continue
            stack.append((opened, relative, iter(listed)))
        return records, issues
    finally:
        for parent, _, _ in stack:
            backend.close(parent)


def run():
    try:
        request = json.loads(sys.stdin.buffer.readline(65536))
        exclude = request.get('exclude', [])
        if not isinstance(exclude, list) or not all(isinstance(item, str) and item for item in exclude):
            raise Refusal('SAFE_SCAN_FAILED')
        records, issues = scan(request['root'], int(request['maxEntries']), exclude=exclude)
        sys.stdout.write(json.dumps({'records': records, 'issues': issues}))
        return 0
    except (Refusal, ScopeError) as error:
        sys.stderr.write(f'{error}\n')
        return 1
    except Exception:
        sys.stderr.write('SAFE_SCAN_FAILED\n')
        return 1


if __name__ == '__main__':
    sys.exit(run())
