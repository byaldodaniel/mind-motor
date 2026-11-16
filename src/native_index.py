"""Recorrido de metadatos por referencias de directorio. Solo biblioteca estándar.

Cada carpeta se abre respecto a la referencia ya adquirida de su padre, sin
seguir enlaces, y se lista desde esa misma referencia. Ninguna ruta completa se
vuelve a resolver durante el recorrido: sustituir un componente por un enlace
no puede hacer que se listen nombres de fuera de la raíz autorizada.
No abre archivos regulares ni lee su contenido.
"""
import errno
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import sys

_parent_spec = importlib.util.spec_from_file_location('native_parent', Path(__file__).with_name('native_parent.py'))
_parent = importlib.util.module_from_spec(_parent_spec)
_parent_spec.loader.exec_module(_parent)


def guard_parent(expected_pid=None):
    """Keep the public guard used by fixtures, with the scanner's error code."""
    try:
        return _parent.guard_parent(expected_pid)
    except _parent.ParentGone:
        raise Refusal('SAFE_SCAN_PARENT_GONE') from None

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
IMPLICIT_EXCLUSIONS = frozenset({'.papelera-mind', '.codex', '.claude', '.gemini', '.git', 'node_modules'})


def _key(relative):
    return relative.lower() if FOLD_CASE else relative


def _record_from_child(relative, child):
    return {
        'path': relative,
        'type': child.type,
        'size': child.size,
        'modifiedMs': child.modified,
        'changedMs': child.changed,
        'createdMs': child.created,
        'listing': child.listing,
        'identity': f'{os.name}:' + ':'.join(str(part) for part in child.identity) if child.identity else None,
    }


def _open_root_checked(backend, root):
    try:
        return backend.open_root(root)
    except Refusal as error:
        if str(error) == 'ECHANGED':
            raise ScopeError('SCOPE_CHANGED') from error
        raise
    except FileNotFoundError as error:
        raise ScopeError('SCOPE_UNAVAILABLE') from error
    except OSError as error:
        changed = code_of(error) in ('ELOOP', 'ENOTDIR')
        raise ScopeError('SCOPE_CHANGED' if changed else 'SCOPE_UNAVAILABLE') from error


def scan(root, max_entries, backend=None, before_open=None, exclude=()):
    """Devuelve registros e incidencias. before_open solo es una barrera de pruebas.

    exclude: rutas relativas ("/") que el usuario excluyó. No se registran ni se
    abren: tampoco se listan ni se recorren sus descendientes.
    """
    backend = backend or (Windows() if os.name == 'nt' else Posix())
    excluded = frozenset(_key(item) for item in exclude)
    handle, volume = _open_root_checked(backend, root)
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
            if _key(child.name) in IMPLICIT_EXCLUSIONS or (excluded and _key(relative) in excluded):
                continue
            if child.error == 'NAME_NOT_UTF8':
                issues.append({'path': base, 'code': child.error})
                continue
            if child.error:
                add({'path': relative, 'error': child.error})
                continue
            record = _record_from_child(relative, child)
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


def _normalize_subpaths(subpaths):
    cleaned = []
    for raw in subpaths:
        if '\0' in raw:
            raise Refusal('SAFE_SCAN_FAILED')
        parts = [part for part in raw.replace('\\', '/').split('/') if part and part != '.']
        if any(part == '..' for part in parts):
            raise Refusal('SAFE_SCAN_FAILED')
        joined = '/'.join(parts)
        if joined == '':
            return ['']
        cleaned.append(joined)
    cleaned.sort(key=lambda item: (item.count('/'), _key(item)))
    kept = []
    kept_keys = []
    for item in cleaned:
        item_key = _key(item)
        if any(item_key == k or item_key.startswith(k + '/') for k in kept_keys):
            continue
        kept.append(item)
        kept_keys.append(item_key)
    return kept


def scan_subpaths(root, max_entries, backend=None, before_open=None, exclude=(), subpaths=()):
    """Recorre únicamente ramas concretas desde la raíz por referencias de directorio."""
    targets = _normalize_subpaths(subpaths)
    if not targets:
        return [], [], [], []
    if targets == ['']:
        records, issues = scan(root, max_entries, backend=backend, before_open=before_open, exclude=exclude)
        return records, issues, [''], []

    backend = backend or (Windows() if os.name == 'nt' else Posix())
    excluded = frozenset(_key(item) for item in exclude)
    root_handle, volume = _open_root_checked(backend, root)

    records = []
    issues = []
    by_path_key = {}
    scanned_prefixes = []
    scanned_keys = set()
    missing_prefixes = []
    missing_keys = set()
    stack = []

    def add_unique(record):
        key = _key(record['path'])
        existing = by_path_key.get(key)
        if existing is not None:
            existing.update(record)
            return existing
        if len(records) + 1 > max_entries:
            raise Refusal('INDEX_LIMIT_EXCEEDED')
        records.append(record)
        by_path_key[key] = record
        return record

    def add_prefix(target_list, seen_keys, value):
        key = _key(value)
        if key not in seen_keys:
            seen_keys.add(key)
            target_list.append(value)

    try:
        try:
            root_children = backend.children(root_handle, volume)
        except OSError as error:
            raise ScopeError('SCOPE_UNAVAILABLE') from error

        for target in targets:
            parts = target.split('/')
            curr_handle = root_handle
            parent_rel = ''
            parent_record = None
            try:
                for index, seg in enumerate(parts):
                    candidate_rel = f'{parent_rel}/{seg}' if parent_rel else seg
                    if _key(seg) in IMPLICIT_EXCLUSIONS or (excluded and _key(candidate_rel) in excluded):
                        add_prefix(missing_prefixes, missing_keys, candidate_rel)
                        break
                    try:
                        children = root_children if curr_handle == root_handle else backend.children(curr_handle, volume)
                    except OSError as error:
                        if parent_record is not None:
                            parent_record['listing'] = code_of(error)
                        break

                    matched = None
                    for child in children:
                        if child.error == 'NAME_NOT_UTF8':
                            continue
                        if child.name == seg or (FOLD_CASE and _key(child.name) == _key(seg)):
                            matched = child
                            break
                    if matched is None:
                        add_prefix(missing_prefixes, missing_keys, candidate_rel)
                        break

                    actual_rel = f'{parent_rel}/{matched.name}' if parent_rel else matched.name
                    if actual_rel != candidate_rel:
                        add_prefix(missing_prefixes, missing_keys, candidate_rel)
                    if _key(matched.name) in IMPLICIT_EXCLUSIONS or (excluded and _key(actual_rel) in excluded):
                        add_prefix(missing_prefixes, missing_keys, actual_rel)
                        break
                    if matched.error:
                        add_unique({'path': actual_rel, 'error': matched.error})
                        add_prefix(scanned_prefixes, scanned_keys, actual_rel)
                        break

                    record = add_unique(_record_from_child(actual_rel, matched))
                    is_last = (index == len(parts) - 1)
                    if matched.type != 'directory' or matched.listing is not None:
                        add_prefix(scanned_prefixes, scanned_keys, actual_rel)
                        break

                    try:
                        if before_open:
                            before_open(actual_rel)
                        opened = backend.open_child(curr_handle, matched)
                    except FileNotFoundError:
                        if records and records[-1] is record and by_path_key.get(_key(actual_rel)) is record:
                            records.pop()
                            by_path_key.pop(_key(actual_rel), None)
                        add_prefix(missing_prefixes, missing_keys, actual_rel)
                        break
                    except (OSError, Refusal) as error:
                        code = code_of(error)
                        record['listing'] = 'ECHANGED' if code in ('ELOOP', 'ENOTDIR') else code
                        add_prefix(scanned_prefixes, scanned_keys, actual_rel)
                        break

                    if is_last:
                        try:
                            listed = backend.children(opened, volume)
                        except OSError as error:
                            backend.close(opened)
                            record['listing'] = code_of(error)
                            add_prefix(scanned_prefixes, scanned_keys, actual_rel)
                            break
                        add_prefix(scanned_prefixes, scanned_keys, actual_rel)
                        stack.append((opened, actual_rel, iter(listed)))
                        while stack:
                            s_parent, s_base, s_pending = stack[-1]
                            s_child = next(s_pending, None)
                            if s_child is None:
                                stack.pop()
                                backend.close(s_parent)
                                continue
                            s_rel = f'{s_base}/{s_child.name}' if s_base else s_child.name
                            if _key(s_child.name) in IMPLICIT_EXCLUSIONS or (excluded and _key(s_rel) in excluded):
                                continue
                            if s_child.error == 'NAME_NOT_UTF8':
                                issues.append({'path': s_base, 'code': s_child.error})
                                continue
                            if s_child.error:
                                add_unique({'path': s_rel, 'error': s_child.error})
                                continue
                            s_record = add_unique(_record_from_child(s_rel, s_child))
                            if s_child.type != 'directory' or s_child.listing is not None:
                                continue
                            try:
                                if before_open:
                                    before_open(s_rel)
                                s_opened = backend.open_child(s_parent, s_child)
                            except FileNotFoundError:
                                if records and records[-1] is s_record and by_path_key.get(_key(s_rel)) is s_record:
                                    records.pop()
                                    by_path_key.pop(_key(s_rel), None)
                                continue
                            except (OSError, Refusal) as error:
                                code = code_of(error)
                                s_record['listing'] = 'ECHANGED' if code in ('ELOOP', 'ENOTDIR') else code
                                continue
                            try:
                                s_listed = backend.children(s_opened, volume)
                            except OSError as error:
                                backend.close(s_opened)
                                s_record['listing'] = code_of(error)
                                continue
                            stack.append((s_opened, s_rel, iter(s_listed)))
                        break
                    else:
                        if curr_handle != root_handle:
                            backend.close(curr_handle)
                        curr_handle = opened
                        parent_rel = actual_rel
                        parent_record = record
            finally:
                if curr_handle != root_handle:
                    backend.close(curr_handle)
        return records, issues, scanned_prefixes, missing_prefixes
    finally:
        for parent, _, _ in stack:
            backend.close(parent)
        backend.close(root_handle)


def _execute_request(request):
    exclude = request.get('exclude', [])
    if not isinstance(exclude, list) or not all(isinstance(item, str) and item for item in exclude):
        raise Refusal('SAFE_SCAN_FAILED')
    subpaths = request.get('subpaths')
    if subpaths is not None:
        if not isinstance(subpaths, list) or not all(isinstance(item, str) for item in subpaths):
            raise Refusal('SAFE_SCAN_FAILED')
        records, issues, scanned_prefixes, missing_prefixes = scan_subpaths(
            request['root'], int(request['maxEntries']), exclude=exclude, subpaths=subpaths
        )
        return {
            'records': records,
            'issues': issues,
            'scannedPrefixes': scanned_prefixes,
            'missingPrefixes': missing_prefixes,
        }
    records, issues = scan(request['root'], int(request['maxEntries']), exclude=exclude)
    return {'records': records, 'issues': issues}


def run():
    try:
        expected_pid = None
        daemon = False
        args = sys.argv[1:]
        index = 0
        while index < len(args):
            arg = args[index]
            if arg == '--daemon':
                daemon = True
                index += 1
            elif arg == '--parent-pid' and index + 1 < len(args):
                expected_pid = int(args[index + 1])
                index += 2
            else:
                raise Refusal('SAFE_SCAN_PARENT_GONE')

        guard_parent(expected_pid)
        if not daemon:
            line = sys.stdin.buffer.readline(65536)
            request = json.loads(line)
            sys.stdout.write(json.dumps(_execute_request(request)))
            return 0

        while True:
            line = sys.stdin.buffer.readline(262144)
            if not line:
                return 0
            text = line.strip()
            if not text:
                continue
            try:
                guard_parent(expected_pid)
                request = json.loads(text)
                result = _execute_request(request)
                payload = {'ok': True, **result}
            except (Refusal, ScopeError) as error:
                code = str(error)
                if code == 'SAFE_SCAN_PARENT_GONE':
                    return 1
                payload = {'ok': False, 'error': code}
            except Exception:
                payload = {'ok': False, 'error': 'SAFE_SCAN_FAILED'}
            sys.stdout.write(json.dumps(payload) + '\n')
            sys.stdout.flush()
    except (Refusal, ScopeError) as error:
        sys.stderr.write(f'{error}\n')
        return 1
    except Exception:
        sys.stderr.write('SAFE_SCAN_FAILED\n')
        return 1


if __name__ == '__main__':
    sys.exit(run())
