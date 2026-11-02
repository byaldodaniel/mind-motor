"""Organización segura por handles: carpetas, movimientos y papelera. Solo biblioteca estándar.

Reutiliza la apertura por componentes del lector y el escritor seguros: la raíz
autorizada y cada carpeta se adquieren sin seguir enlaces, y todos los nombres
se resuelven respecto a handles ya abiertos y verificados. Origen y destino
parten del mismo handle de la raíz.

Garantías:
- Crear una carpeta nunca reemplaza nada (FILE_EXISTS) ni crea padres.
- Mover nunca reemplaza el destino, nunca mueve enlaces, puntos de reanálisis
  ni objetos especiales, ni una carpeta dentro de sí misma, y no cambia de
  volumen. Se mueve exactamente el objeto verificado:
  - POSIX: renameat2(RENAME_NOREPLACE) en Linux o renameatx_np(RENAME_EXCL) en
    macOS. Si no existen o el sistema de archivos no los admite, los archivos
    se mueven con linkat (falla si el nombre existe) y unlink del origen; las
    carpetas se deniegan (SAFE_OPEN_UNAVAILABLE). Se comprueba (st_dev, st_ino)
    del origen antes y del destino después; si no coinciden se deshace.
  - Windows: el origen se abre con DELETE y FILE_OPEN_REPARSE_POINT y se
    renombra por su handle con NtSetInformationFile(FileRenameInformation),
    ReplaceIfExists=FALSE y RootDirectory = padre de destino.
- La papelera (<raíz>/.papelera-mind/<id>/<nombre>) es un movimiento seguro,
  no una copia. El SHA-256 de un archivo se calcula por el handle retenido.
- Vaciar elimina el árbol de una entrada por handles, sin seguir enlaces: un
  enlace se elimina a sí mismo y nunca se desciende por él.

Protocolo: petición JSON en una línea; se valida y se adquieren los handles sin
modificar nada; READY en stderr; se espera W; se modifica; resultado JSON.
"""
import contextlib
import errno
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import sys
import uuid

_spec = importlib.util.spec_from_file_location('native_writer', Path(__file__).with_name('native_writer.py'))
writer = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(writer)

Refusal = writer.Refusal
component = writer.component
open_parent = writer.open_parent

TRASH = '.papelera-mind'
TRASH_ID = re.compile(r'^\d{8}T\d{6}Z-[0-9a-f]{12}$')
MAX_HASH_BYTES = 64 * 1024 * 1024
WINDOWS_EPOCH = 116444736000000000
# Windows y macOS no distinguen mayúsculas por defecto (como paths.js).
FOLD_CASE = os.name == 'nt' or sys.platform == 'darwin'

# Derechos, modos de compartición y opciones de NtCreateFile.
SYNCHRONIZE, DELETE = 0x100000, 0x10000
FILE_READ_DATA = FILE_LIST_DIRECTORY = 0x1
FILE_TRAVERSE, FILE_READ_ATTRIBUTES = 0x20, 0x80
SHARE_READ, SHARE_DELETE, SHARE_ALL = 0x1, 0x4, 0x7
FILE_OPEN, FILE_CREATE, FILE_OPEN_IF = 1, 2, 3
DIRECTORY_FILE, NON_DIRECTORY_FILE = 0x1, 0x40
SYNC_IO, OPEN_REPARSE_POINT = 0x20, 0x200000

STATUS_NOT_IMPLEMENTED = 0xC0000002
STATUS_INVALID_INFO_CLASS = 0xC0000003
STATUS_INVALID_PARAMETER = 0xC000000D
STATUS_ACCESS_DENIED = writer.STATUS_ACCESS_DENIED
STATUS_OBJECT_NAME_NOT_FOUND = writer.STATUS_OBJECT_NAME_NOT_FOUND
STATUS_OBJECT_NAME_COLLISION = writer.STATUS_OBJECT_NAME_COLLISION
STATUS_OBJECT_PATH_NOT_FOUND = writer.STATUS_OBJECT_PATH_NOT_FOUND
STATUS_SHARING_VIOLATION = writer.STATUS_SHARING_VIOLATION
STATUS_DELETE_PENDING = writer.STATUS_DELETE_PENDING
STATUS_FILE_IS_A_DIRECTORY = 0xC00000BA
STATUS_NOT_SUPPORTED = 0xC00000BB
STATUS_NOT_SAME_DEVICE = 0xC00000D4
STATUS_DIRECTORY_NOT_EMPTY = 0xC0000101
STATUS_NOT_A_DIRECTORY = 0xC0000103
STATUS_CANNOT_DELETE = 0xC0000121
NAME_OCCUPIED = writer.NAME_OCCUPIED
GONE = frozenset({STATUS_OBJECT_NAME_NOT_FOUND, STATUS_OBJECT_PATH_NOT_FOUND, STATUS_DELETE_PENDING})


class Entry:
    """Objeto adquirido: tipo, identidad física, handle retenido y metadatos."""
    __slots__ = ('kind', 'identity', 'handle', 'info')

    def __init__(self, kind, identity, handle, info):
        self.kind, self.identity, self.handle, self.info = kind, identity, handle, info


def fold(name):
    return name.lower() if FOLD_CASE else name


def parts_of(relative):
    if not isinstance(relative, str):
        raise Refusal('UNSAFE_PATH')
    return [component(part) for part in relative.split('/')]


class Posix(writer.Posix):
    DIRECTORY = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC
    FILE = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC

    def __init__(self):
        super().__init__()
        if (not all(function in os.supports_dir_fd for function in (os.mkdir, os.rmdir, os.unlink, os.stat, os.link))
                or os.scandir not in os.supports_fd):
            raise Refusal('SAFE_OPEN_UNAVAILABLE')
        self._noreplace = None

    @staticmethod
    def _identity(info):
        return (info.st_dev, info.st_ino)

    def _named(self, parent, name):
        try:
            return os.stat(name, dir_fd=parent, follow_symlinks=False)
        except FileNotFoundError:
            return None

    def directory_identity(self, handle):
        return self._identity(os.fstat(handle))

    def mkdir(self, parent, name, delete=False):
        os.mkdir(component(name), 0o777, dir_fd=parent)
        try:
            return os.open(name, self.DIRECTORY, dir_fd=parent)
        except OSError:
            raise Refusal('UNCONFIRMED') from None

    def ensure_directory(self, parent, name):
        with contextlib.suppress(FileExistsError):
            os.mkdir(component(name), 0o777, dir_fd=parent)
        # O_NOFOLLOW | O_DIRECTORY: un enlace o un archivo con ese nombre se rechaza.
        return self.child(parent, name, True)

    def open_directory(self, parent, name, delete=False):
        return self.child(parent, name, True)

    def remove_directory(self, parent, name, handle):
        current = self._named(parent, name)
        if current is None or self._identity(current) != self._identity(os.fstat(handle)):
            raise Refusal('ENTRY_CHANGED')
        os.rmdir(name, dir_fd=parent)

    def _lock(self, handle):
        import fcntl
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            # Otro proceso de Mind lo está modificando u organizando.
            if error.errno in (errno.EACCES, errno.EAGAIN):
                raise Refusal('FILE_IN_USE') from None
            raise

    def acquire(self, parent, name, volume, read=False):
        """Examina la entrada sin seguir enlaces. Solo carpetas o archivos regulares con un enlace."""
        info = os.stat(component(name), dir_fd=parent, follow_symlinks=False)
        if stat.S_ISDIR(info.st_mode):
            kind = 'directory'
        elif stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
            kind = 'file'
        else:
            raise Refusal('UNSAFE_PATH')
        if info.st_dev != volume:
            raise Refusal('UNSAFE_PATH')
        handle = None
        if kind == 'file':
            handle = os.open(name, self.FILE, dir_fd=parent)
            try:
                held = os.fstat(handle)
                if not stat.S_ISREG(held.st_mode) or self._identity(held) != self._identity(info):
                    raise Refusal('ENTRY_CHANGED')
                self._lock(handle)
            except BaseException:
                os.close(handle)
                raise
        return Entry(kind, self._identity(info), handle, info)

    def release(self, entry):
        if entry.handle is not None:
            os.close(entry.handle)
            entry.handle = None

    def same_entry(self, parent, name, entry):
        named = self._named(parent, name)
        return named is not None and self._identity(named) == entry.identity

    def _native(self):
        """renameat2/renameatx_np de la libc, o None si no existe."""
        if self._noreplace is None:
            function, flag = None, 0
            import ctypes
            name, flag = ('renameatx_np', 0x4) if sys.platform == 'darwin' else ('renameat2', 0x1)
            for library in [None, '/usr/lib/libSystem.B.dylib'] if sys.platform == 'darwin' else [None]:
                try:
                    function = getattr(ctypes.CDLL(library, use_errno=True), name, None)
                except OSError:
                    function = None
                if function is not None:
                    function.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
                    function.restype = ctypes.c_int
                    break
            self._noreplace = (function, flag)
        return self._noreplace

    def _rename_noreplace(self, src_parent, src, dst_parent, dst):
        """True si se movió; False si no hay un renombrado sin reemplazo disponible aquí."""
        function, flag = self._native()
        if function is None:
            return False
        import ctypes
        if function(src_parent, os.fsencode(src), dst_parent, os.fsencode(dst), flag) == 0:
            return True
        code = ctypes.get_errno()
        # EINVAL/ENOTSUP: el sistema de archivos no admite la opción; ENOSYS: núcleo antiguo.
        if code in (errno.EINVAL, errno.ENOSYS, errno.ENOTSUP, errno.EOPNOTSUPP):
            return False
        raise OSError(code, os.strerror(code))

    def move(self, entry, src_parent, src, dst_parent, dst):
        if self._rename_noreplace(src_parent, src, dst_parent, dst):
            return
        if entry.kind != 'file':
            raise Refusal('SAFE_OPEN_UNAVAILABLE')
        # Archivos: linkat falla con EEXIST si el nombre existe; luego se retira el origen.
        os.link(src, dst, src_dir_fd=src_parent, dst_dir_fd=dst_parent, follow_symlinks=False)
        linked = self._named(dst_parent, dst)
        if linked is None or self._identity(linked) != entry.identity:
            # Se enlazó otro objeto que ocupó el nombre de origen: se retira el nombre nuevo.
            if linked is not None:
                os.unlink(dst, dir_fd=dst_parent)
            raise Refusal('ENTRY_CHANGED')
        current = self._named(src_parent, src)
        if current is None or self._identity(current) != entry.identity:
            raise Refusal('UNCONFIRMED')
        os.unlink(src, dir_fd=src_parent)

    def moved(self, entry, dst_parent, dst):
        named = self._named(dst_parent, dst)
        if named is None or self._identity(named) != entry.identity:
            return False
        entry.info = named
        with contextlib.suppress(OSError):
            os.fsync(dst_parent)
        return True

    def move_back(self, src_parent, src, dst_parent, dst):
        if not self._rename_noreplace(src_parent, src, dst_parent, dst):
            raise Refusal('UNCONFIRMED')

    def metadata(self, entry):
        info = entry.info
        birth = getattr(info, 'st_birthtime', None)
        return {'size': info.st_size if entry.kind == 'file' else None,
                'modifiedMs': info.st_mtime_ns // 1_000_000, 'changedMs': info.st_ctime_ns // 1_000_000,
                'createdMs': int(birth * 1000) if birth else None}

    def directory_metadata(self, handle):
        return self.metadata(Entry('directory', None, handle, os.fstat(handle)))

    def digest(self, entry, limit):
        if entry.info.st_size > limit:
            return None
        os.lseek(entry.handle, 0, os.SEEK_SET)
        digest, total = hashlib.sha256(), 0
        while True:
            chunk = os.read(entry.handle, 1024 * 1024)
            if not chunk:
                return digest.hexdigest()
            total += len(chunk)
            if total > limit:
                return None
            digest.update(chunk)

    @staticmethod
    def _names(handle):
        with os.scandir(handle) as entries:
            return [item.name for item in entries]

    def purge(self, handle, volume, before_remove=None):
        """Elimina el contenido de handle por descriptores; devuelve cuántas entradas eliminó."""
        removed = 0
        stack = [(handle, None, None, iter(self._names(handle)))]
        try:
            while stack:
                current, name, identity, pending = stack[-1]
                child = next(pending, None)
                if child is None:
                    stack.pop()
                    if name is not None:
                        os.close(current)
                        parent = stack[-1][0]
                        named = self._named(parent, name)
                        if named is None or self._identity(named) != identity:
                            raise Refusal('ENTRY_CHANGED')
                        os.rmdir(name, dir_fd=parent)
                        removed += 1
                    continue
                if before_remove:
                    before_remove(child)
                info = self._named(current, child)
                if info is None:
                    continue
                if not stat.S_ISDIR(info.st_mode):
                    # Archivos, enlaces y objetos especiales: unlink nunca sigue enlaces.
                    os.unlink(child, dir_fd=current)
                    removed += 1
                    continue
                if info.st_dev != volume:
                    raise Refusal('UNSAFE_PATH')
                sub = os.open(child, self.DIRECTORY, dir_fd=current)
                try:
                    if self._identity(os.fstat(sub)) != self._identity(info):
                        raise Refusal('ENTRY_CHANGED')
                    listed = self._names(sub)
                except BaseException:
                    os.close(sub)
                    raise
                stack.append((sub, child, self._identity(info), iter(listed)))
        finally:
            for current, name, _, _ in stack:
                if name is not None:
                    os.close(current)
        return removed


class Windows(writer.Windows):
    def __init__(self):
        super().__init__()
        c, w = self.c, self.w
        self.kernel.ReadFile.argtypes = [w.HANDLE, w.LPVOID, w.DWORD, c.POINTER(w.DWORD), w.LPVOID]
        self.kernel.ReadFile.restype = w.BOOL

    def _raise(self, result):
        raise self.c.WinError(self.nt.RtlNtStatusToDosError(result))

    def _create(self, parent, name, access, share, disposition, options):
        """NtCreateFile relativo a parent: (NTSTATUS sin signo, resultado, handle o None)."""
        c, w = self.c, self.w
        if not name or '\\' in name or '/' in name or '\0' in name:
            raise Refusal('UNSAFE_PATH')
        buffer = c.create_unicode_buffer(name)
        length = len(name.encode('utf-16-le', 'surrogatepass'))
        if length > 65532:
            raise Refusal('UNSAFE_PATH')
        text = self.Unicode(length, length + 2, c.cast(buffer, w.LPWSTR))
        attrs = self.Attributes(c.sizeof(self.Attributes), parent, c.pointer(text), 0x40, None, None)
        handle, status = w.HANDLE(), self.Status()
        result = self.nt.NtCreateFile(c.byref(handle), access, c.byref(attrs), c.byref(status),
                                      None, 0, share, disposition, options, None, 0)
        if result < 0:
            return result & 0xFFFFFFFF, result, None
        return 0, result, handle.value

    def _info(self, handle):
        info = self.Info()
        if not self.kernel.GetFileInformationByHandle(handle, self.c.byref(info)):
            raise self.c.WinError(self.c.get_last_error())
        return info

    def directory_identity(self, handle):
        info = self._info(handle)
        return (info.volume, info.index_high, info.index_low)

    def _created(self, parent, name, status, result):
        if status in NAME_OCCUPIED:
            raise Refusal('FILE_EXISTS')
        if status == STATUS_ACCESS_DENIED:
            try:
                taken = self.occupied(parent, name)
            except OSError:
                taken = False
            if taken:
                raise Refusal('FILE_EXISTS')
        if status == STATUS_NOT_A_DIRECTORY:
            raise Refusal('UNSAFE_PATH')
        self._raise(result)

    def mkdir(self, parent, name, delete=False):
        name = component(name)
        access = SYNCHRONIZE | FILE_READ_ATTRIBUTES | FILE_LIST_DIRECTORY | FILE_TRAVERSE | (DELETE if delete else 0)
        # FILE_CREATE nunca abre ni reemplaza algo existente.
        status, result, handle = self._create(parent, name, access, SHARE_ALL, FILE_CREATE,
                                              DIRECTORY_FILE | SYNC_IO | OPEN_REPARSE_POINT)
        if handle is None:
            self._created(parent, name, status, result)
        return handle

    def ensure_directory(self, parent, name):
        name = component(name)
        status, result, handle = self._create(parent, name, SYNCHRONIZE | FILE_READ_ATTRIBUTES | FILE_LIST_DIRECTORY | FILE_TRAVERSE,
                                              SHARE_ALL, FILE_OPEN_IF, DIRECTORY_FILE | SYNC_IO | OPEN_REPARSE_POINT)
        if handle is None:
            self._created(parent, name, status, result)
        return handle

    def open_directory(self, parent, name, delete=False):
        access = SYNCHRONIZE | FILE_READ_ATTRIBUTES | FILE_LIST_DIRECTORY | FILE_TRAVERSE | (DELETE if delete else 0)
        status, result, handle = self._create(parent, component(name), access, SHARE_ALL, FILE_OPEN,
                                              DIRECTORY_FILE | SYNC_IO | OPEN_REPARSE_POINT)
        if handle is None:
            if status == STATUS_NOT_A_DIRECTORY:
                raise Refusal('UNSAFE_PATH')
            self._raise(result)
        return handle

    def dispose(self, handle):
        """Marca para eliminar por el handle; se elimina al cerrarlo."""
        c = self.c
        # FileDispositionInformationEx: DELETE | POSIX_SEMANTICS | IGNORE_READONLY_ATTRIBUTE.
        flags = c.c_ulong(0x1 | 0x2 | 0x10)
        result = self.nt.NtSetInformationFile(handle, c.byref(self.Status()), c.byref(flags), 4, 64)
        if result < 0 and (result & 0xFFFFFFFF) in (STATUS_INVALID_PARAMETER, STATUS_INVALID_INFO_CLASS,
                                                     STATUS_NOT_IMPLEMENTED, STATUS_NOT_SUPPORTED):
            flag = c.c_ubyte(1)  # FileDispositionInformation clásica: DeleteFile=TRUE.
            result = self.nt.NtSetInformationFile(handle, c.byref(self.Status()), c.byref(flag), 1, 13)
        if result >= 0:
            return
        status = result & 0xFFFFFFFF
        if status == STATUS_CANNOT_DELETE:
            raise Refusal('ACCESS_DENIED')
        if status == STATUS_DIRECTORY_NOT_EMPTY:
            raise Refusal('NOT_EMPTY')
        self._raise(result)

    def remove_directory(self, parent, name, handle):
        self.dispose(handle)

    def acquire(self, parent, name, volume, read=False):
        name = component(name)
        # Primero solo atributos (no participa en la compartición) para conocer el tipo.
        status, result, probe = self._create(parent, name, SYNCHRONIZE | FILE_READ_ATTRIBUTES, SHARE_ALL, FILE_OPEN,
                                             SYNC_IO | OPEN_REPARSE_POINT)
        if probe is None:
            self._opened(status, result)
        try:
            attributes = self._info(probe).attributes
        finally:
            self.close(probe)
        if attributes & 0x400:
            raise Refusal('UNSAFE_PATH')
        directory = bool(attributes & 0x10)
        # Archivos sin compartir escritura: excluye escritores, también a los modificadores de Mind.
        share = SHARE_ALL if directory else SHARE_READ | SHARE_DELETE
        access = DELETE | SYNCHRONIZE | FILE_READ_ATTRIBUTES | (FILE_READ_DATA if read and not directory else 0)
        options = SYNC_IO | OPEN_REPARSE_POINT | (DIRECTORY_FILE if directory else NON_DIRECTORY_FILE)
        status, result, handle = self._create(parent, name, access, share, FILE_OPEN, options)
        if handle is None:
            if status in (STATUS_NOT_A_DIRECTORY, STATUS_FILE_IS_A_DIRECTORY):
                raise Refusal('ENTRY_CHANGED')
            self._opened(status, result)
        try:
            info = self._info(handle)
            if (self.kernel.GetFileType(handle) != 1 or info.attributes & 0x400
                    or bool(info.attributes & 0x10) != directory or (not directory and info.links != 1)
                    or info.volume != volume):
                raise Refusal('UNSAFE_PATH')
            kind = 'directory' if directory else 'file'
            return Entry(kind, (info.volume, info.index_high, info.index_low), handle, info)
        except BaseException:
            self.close(handle)
            raise

    def _opened(self, status, result):
        if status in GONE:
            # Como OSError: quien llama decide si falta el origen o la entrada de la papelera.
            raise self.c.WinError(2)
        if status == STATUS_SHARING_VIOLATION:
            raise Refusal('FILE_IN_USE')
        self._raise(result)

    def release(self, entry):
        if entry.handle is not None:
            self.close(entry.handle)
            entry.handle = None

    def same_entry(self, parent, name, entry):
        status, result, handle = self._create(parent, component(name), SYNCHRONIZE | FILE_READ_ATTRIBUTES, SHARE_ALL,
                                              FILE_OPEN, SYNC_IO | OPEN_REPARSE_POINT)
        if handle is None:
            return False
        try:
            return self.directory_identity(handle) == entry.identity
        finally:
            self.close(handle)

    def move(self, entry, src_parent, src, dst_parent, dst):
        c, w = self.c, self.w
        encoded = component(dst).encode('utf-16-le')

        class Rename(c.Structure):
            _fields_ = [('flags', w.ULONG), ('root', w.HANDLE), ('length', w.ULONG),
                        ('name', w.WCHAR * (len(encoded) // 2))]

        # ReplaceIfExists=FALSE; el nombre se resuelve respecto al padre de destino adquirido.
        info = Rename(0, dst_parent, len(encoded))
        c.memmove(c.addressof(info) + Rename.name.offset, encoded, len(encoded))
        result = self.nt.NtSetInformationFile(entry.handle, c.byref(self.Status()), c.byref(info), c.sizeof(info), 10)
        if result >= 0:
            return
        status = result & 0xFFFFFFFF
        if status == STATUS_OBJECT_NAME_COLLISION:
            raise Refusal('FILE_EXISTS')
        if status == STATUS_NOT_SAME_DEVICE:
            raise Refusal('UNSAFE_PATH')
        if status in (STATUS_SHARING_VIOLATION, STATUS_DELETE_PENDING, STATUS_ACCESS_DENIED):
            # Se clasifica por el destino: solo un nombre que consta ocupado es FILE_EXISTS.
            try:
                taken = self.occupied(dst_parent, dst)
            except OSError:
                taken = False
            if taken:
                raise Refusal('FILE_EXISTS')
            if status == STATUS_SHARING_VIOLATION:
                raise Refusal('FILE_IN_USE')
        self._raise(result)

    def moved(self, entry, dst_parent, dst):
        # El renombrado actúa sobre el handle: lo movido es exactamente el objeto verificado.
        return True

    def move_back(self, src_parent, src, dst_parent, dst):
        raise Refusal('UNCONFIRMED')

    def _times(self, handle):
        basic = self.Basic()
        if not self.kernel.GetFileInformationByHandleEx(handle, 0, self.c.byref(basic), self.c.sizeof(basic)):
            raise self.c.WinError(self.c.get_last_error())
        ms = lambda value: (value - WINDOWS_EPOCH) // 10_000 if value > 0 else None
        return {'modifiedMs': ms(basic.written), 'changedMs': ms(basic.changed), 'createdMs': ms(basic.created)}

    def metadata(self, entry):
        info = self._info(entry.handle)
        size = (info.size_high << 32) | info.size_low if entry.kind == 'file' else None
        return {'size': size, **self._times(entry.handle)}

    def directory_metadata(self, handle):
        return {'size': None, **self._times(handle)}

    def digest(self, entry, limit):
        c, w = self.c, self.w
        info = self._info(entry.handle)
        if ((info.size_high << 32) | info.size_low) > limit:
            return None
        digest, total = hashlib.sha256(), 0
        buffer = c.create_string_buffer(1024 * 1024)
        while True:
            count = w.DWORD()
            if not self.kernel.ReadFile(entry.handle, buffer, len(buffer), c.byref(count), None):
                raise c.WinError(c.get_last_error())
            if count.value == 0:
                return digest.hexdigest()
            total += count.value
            if total > limit:
                return None
            digest.update(buffer.raw[:count.value])

    def _names(self, handle):
        """Nombres y atributos enumerados desde el handle (FileFullDirectoryInfo)."""
        c = self.c
        size = 65536
        buffer = c.create_string_buffer(size)
        result = []
        while True:
            if not self.kernel.GetFileInformationByHandleEx(handle, 14, buffer, size):
                error = c.get_last_error()
                if error == 18:  # ERROR_NO_MORE_FILES
                    return result
                raise c.WinError(error)
            raw, offset = buffer.raw, 0
            while True:
                following = int.from_bytes(raw[offset:offset + 4], 'little')
                attributes = int.from_bytes(raw[offset + 56:offset + 60], 'little')
                length = int.from_bytes(raw[offset + 60:offset + 64], 'little')
                name = raw[offset + 68:offset + 68 + length].decode('utf-16-le', 'surrogatepass')
                if name not in ('.', '..'):
                    result.append((name, attributes))
                if following == 0:
                    break
                offset += following

    def _open_child(self, parent, name, attributes, volume):
        """Abre un hijo de la papelera como sí mismo; None si ya no existe."""
        reparse, directory = bool(attributes & 0x400), bool(attributes & 0x10)
        descend = directory and not reparse
        access = DELETE | SYNCHRONIZE | FILE_READ_ATTRIBUTES | (FILE_LIST_DIRECTORY | FILE_TRAVERSE if descend else 0)
        options = SYNC_IO | OPEN_REPARSE_POINT | (DIRECTORY_FILE if descend else 0 if reparse else NON_DIRECTORY_FILE)
        status, result, handle = self._create(parent, name, access, SHARE_ALL, FILE_OPEN, options)
        if handle is None:
            if status in GONE:
                return None, False
            if status in (STATUS_NOT_A_DIRECTORY, STATUS_FILE_IS_A_DIRECTORY):
                raise Refusal('ENTRY_CHANGED')
            self._raise(result)
        try:
            info = self._info(handle)
            if bool(info.attributes & 0x400) != reparse or (not reparse and bool(info.attributes & 0x10) != directory):
                raise Refusal('ENTRY_CHANGED')
            if descend and info.volume != volume:
                raise Refusal('UNSAFE_PATH')
            return handle, descend
        except BaseException:
            self.close(handle)
            raise

    def purge(self, handle, volume, before_remove=None):
        removed = 0
        stack = [(handle, False, iter(self._names(handle)))]
        try:
            while stack:
                current, owned, pending = stack[-1]
                child = next(pending, None)
                if child is None:
                    stack.pop()
                    if owned:
                        try:
                            self.dispose(current)
                        finally:
                            self.close(current)
                        removed += 1
                    continue
                name, attributes = child
                if before_remove:
                    before_remove(name)
                opened, descend = self._open_child(current, name, attributes, volume)
                if opened is None:
                    continue
                if descend:
                    try:
                        listed = self._names(opened)
                    except BaseException:
                        self.close(opened)
                        raise
                    stack.append((opened, True, iter(listed)))
                    continue
                # Archivos y puntos de reanálisis se eliminan a sí mismos; nunca se sigue el destino.
                try:
                    self.dispose(opened)
                finally:
                    self.close(opened)
                removed += 1
        finally:
            for current, owned, _ in stack:
                if owned:
                    self.close(current)
        return removed


def default_backend():
    return Windows() if os.name == 'nt' else Posix()


def acquire_root(backend, stack, root, after_directory=None):
    """Raíz autorizada por componentes: open_parent de un único componente final."""
    return open_parent(backend, stack, root, [None], after_directory)


def missing(error):
    return isinstance(error, FileNotFoundError) or getattr(error, 'winerror', None) in (2, 3)


def descend(backend, stack, handle, volume, names, after_directory=None, chain=None, absent='FILE_NOT_FOUND'):
    """Carpetas sucesivas por componentes, en el mismo volumen; registra sus identidades en chain."""
    for name in names:
        try:
            handle = backend.child(handle, name, True)
        except OSError as error:
            if missing(error):
                raise Refusal(absent) from None
            raise
        stack.callback(backend.close, handle)
        if backend.check(handle, True) != volume:
            raise Refusal('UNSAFE_PATH')
        if chain is not None:
            chain.append(backend.directory_identity(handle))
        if after_directory:
            after_directory(name)
    return handle


def acquire(backend, stack, parent, name, volume, read=False, absent='FILE_NOT_FOUND'):
    try:
        entry = backend.acquire(parent, name, volume, read)
    except OSError as error:
        if missing(error):
            raise Refusal(absent) from None
        raise
    stack.callback(backend.release, entry)
    return entry


def relocate(backend, entry, src_parent, src, dst_parent, dst):
    """Mueve entry sin reemplazar y confirma que lo movido es exactamente entry."""
    backend.move(entry, src_parent, src, dst_parent, dst)
    if not backend.moved(entry, dst_parent, dst):
        # Otro objeto ocupó el nombre de origen entre la verificación y el rename: se deshace.
        try:
            backend.move_back(dst_parent, dst, src_parent, src)
        except (OSError, Refusal):
            raise Refusal('UNCONFIRMED') from None
        raise Refusal('ENTRY_CHANGED')


def relocate_alias(backend, entry, src_parent, src, dst_parent, dst):
    """Cambio solo de mayúsculas o normalización: pasa por un nombre temporal único."""
    temporary = f'.mind-move-{uuid.uuid4().hex}.tmp'
    relocate(backend, entry, src_parent, src, src_parent, temporary)
    try:
        relocate(backend, entry, src_parent, temporary, dst_parent, dst)
    except BaseException:
        with contextlib.suppress(OSError, Refusal):
            relocate(backend, entry, src_parent, temporary, src_parent, src)
        raise


def make_directory(root, relative, confirm=None, after_directory=None, before_change=None, backend=None):
    """Crea una carpeta vacía; nunca reemplaza ni crea padres."""
    backend = backend or default_backend()
    parts = parts_of(relative)
    with contextlib.ExitStack() as stack:
        top, volume = acquire_root(backend, stack, root, after_directory)
        parent = descend(backend, stack, top, volume, parts[:-1], after_directory, absent='PARENT_NOT_FOUND')
        if backend.exists(parent, parts[-1]):
            raise Refusal('FILE_EXISTS')
        if confirm:
            confirm()
        if before_change:
            before_change()
        try:
            created = backend.mkdir(parent, parts[-1])
        except OSError as error:
            if missing(error):
                raise Refusal('PARENT_NOT_FOUND') from None
            raise
        stack.callback(backend.close, created)
        try:
            if backend.check(created, True) != volume:
                raise Refusal('UNCONFIRMED')
            return {'type': 'directory', **backend.directory_metadata(created)}
        except (OSError, Refusal):
            raise Refusal('UNCONFIRMED') from None


def inside(inner, outer):
    """inner está dentro de outer (o es outer), comparando como el sistema."""
    return len(inner) >= len(outer) and [fold(part) for part in inner[:len(outer)]] == [fold(part) for part in outer]


def move_entry(root, source, target, confirm=None, after_directory=None, before_change=None, backend=None):
    """Mueve o renombra source a target dentro de la misma raíz, sin reemplazar."""
    backend = backend or default_backend()
    src, dst = parts_of(source), parts_of(target)
    if src == dst or (inside(dst, src) and len(dst) > len(src)) or fold(src[0]) == fold(TRASH) or fold(dst[0]) == fold(TRASH):
        raise Refusal('INVALID_MOVE')
    with contextlib.ExitStack() as stack:
        top, volume = acquire_root(backend, stack, root, after_directory)
        src_parent = descend(backend, stack, top, volume, src[:-1], after_directory)
        chain = [backend.directory_identity(top)]
        dst_parent = descend(backend, stack, top, volume, dst[:-1], after_directory, chain, absent='PARENT_NOT_FOUND')
        entry = acquire(backend, stack, src_parent, src[-1], volume)
        if entry.kind == 'directory' and entry.identity in chain:
            raise Refusal('INVALID_MOVE')
        alias = False
        if backend.exists(dst_parent, dst[-1]):
            if not backend.same_entry(dst_parent, dst[-1], entry):
                raise Refusal('FILE_EXISTS')
            alias = True
        if confirm:
            confirm()
        if before_change:
            before_change()
        (relocate_alias if alias else relocate)(backend, entry, src_parent, src[-1], dst_parent, dst[-1])
        return {'type': entry.kind, **backend.metadata(entry)}


def check_expected(entry, meta, expect):
    """Lo confirmado por el usuario debe seguir siendo lo que se mueve a la papelera."""
    if not expect:
        return
    if expect.get('type') not in (None, entry.kind):
        raise Refusal('ENTRY_CHANGED')
    if entry.kind == 'file':
        for field in ('size', 'modifiedMs'):
            if expect.get(field) is not None and expect[field] != meta[field]:
                raise Refusal('ENTRY_CHANGED')


def trash_entry(root, relative, trash_id, expect=None, confirm=None, after_directory=None, before_change=None,
                backend=None, hash_limit=None):
    """Mueve relative a <raíz>/.papelera-mind/<trash_id>/<nombre> sin copiarlo."""
    backend = backend or default_backend()
    parts = parts_of(relative)
    if fold(parts[0]) == fold(TRASH) or not isinstance(trash_id, str) or not TRASH_ID.match(trash_id):
        raise Refusal('UNSAFE_PATH')
    with contextlib.ExitStack() as stack:
        top, volume = acquire_root(backend, stack, root, after_directory)
        parent = descend(backend, stack, top, volume, parts[:-1], after_directory)
        entry = acquire(backend, stack, parent, parts[-1], volume, read=True)
        meta = backend.metadata(entry)
        check_expected(entry, meta, expect)
        limit = MAX_HASH_BYTES if hash_limit is None else hash_limit
        sha256 = backend.digest(entry, limit) if entry.kind == 'file' else None
        if confirm:
            confirm()
        trash = backend.ensure_directory(top, TRASH)
        stack.callback(backend.close, trash)
        if backend.check(trash, True) != volume:
            raise Refusal('UNSAFE_PATH')
        holder = backend.mkdir(trash, trash_id, delete=True)
        stack.callback(backend.close, holder)
        moved = False
        try:
            if backend.check(holder, True) != volume:
                raise Refusal('UNSAFE_PATH')
            if before_change:
                before_change()
            relocate(backend, entry, parent, parts[-1], holder, parts[-1])
            moved = True
        finally:
            if not moved:
                with contextlib.suppress(OSError, Refusal):
                    backend.remove_directory(trash, trash_id, holder)
        return {'type': entry.kind, **meta, 'sha256': sha256}


def open_holder(backend, stack, top, volume, trash_id):
    """.papelera-mind/<trash_id>, sin seguir enlaces; TRASH_MISSING si no existe."""
    if not isinstance(trash_id, str) or not TRASH_ID.match(trash_id):
        raise Refusal('UNSAFE_PATH')
    handles = []
    for parent, name, delete in ((top, TRASH, False), (None, trash_id, True)):
        try:
            handle = backend.open_directory(parent if parent is not None else handles[-1], name, delete)
        except OSError as error:
            if missing(error):
                raise Refusal('TRASH_MISSING') from None
            raise
        stack.callback(backend.close, handle)
        if backend.check(handle, True) != volume:
            raise Refusal('UNSAFE_PATH')
        handles.append(handle)
    return handles


def restore_entry(root, trash_id, name, target_parent, candidates, confirm=None, after_directory=None,
                  before_change=None, backend=None):
    """Devuelve la entrada de la papelera al primer nombre libre de candidates, sin reemplazar."""
    backend = backend or default_backend()
    name = component(name)
    parent_parts = [component(part) for part in target_parent]
    names = [component(candidate) for candidate in candidates]
    if not names or (parent_parts and fold(parent_parts[0]) == fold(TRASH)) or (not parent_parts and any(
            fold(candidate) == fold(TRASH) for candidate in names)):
        raise Refusal('UNSAFE_PATH')
    with contextlib.ExitStack() as stack:
        top, volume = acquire_root(backend, stack, root, after_directory)
        trash, holder = open_holder(backend, stack, top, volume, trash_id)
        entry = acquire(backend, stack, holder, name, volume, absent='TRASH_MISSING')
        chain = [backend.directory_identity(top)]
        destination = descend(backend, stack, top, volume, parent_parts, after_directory, chain, absent='PARENT_NOT_FOUND')
        if entry.kind == 'directory' and entry.identity in chain:
            raise Refusal('INVALID_MOVE')
        if confirm:
            confirm()
        if before_change:
            before_change()
        for candidate in names:
            try:
                relocate(backend, entry, holder, name, destination, candidate)
                break
            except Refusal as error:
                if str(error) != 'FILE_EXISTS':
                    raise
        else:
            raise Refusal('FILE_EXISTS')
        with contextlib.suppress(OSError, Refusal):
            backend.remove_directory(trash, trash_id, holder)
        return {'type': entry.kind, 'name': candidate, **backend.metadata(entry)}


def purge_entry(root, trash_id, confirm=None, after_directory=None, before_remove=None, backend=None):
    """Elimina definitivamente .papelera-mind/<trash_id> y todo su contenido, por handles."""
    backend = backend or default_backend()
    with contextlib.ExitStack() as stack:
        top, volume = acquire_root(backend, stack, root, after_directory)
        trash, holder = open_holder(backend, stack, top, volume, trash_id)
        if confirm:
            confirm()
        removed = backend.purge(holder, volume, before_remove)
        backend.remove_directory(trash, trash_id, holder)
        return {'removed': removed}


def error_code(error):
    if isinstance(error, Refusal):
        return str(error)
    win = getattr(error, 'winerror', None)
    code = getattr(error, 'errno', None)
    if isinstance(error, FileExistsError) or code == errno.EEXIST or win in (80, 183):
        return 'FILE_EXISTS'
    if code == errno.ENOTEMPTY or win == 145:
        return 'NOT_EMPTY'
    if code in (errno.ENOSPC, getattr(errno, 'EDQUOT', errno.ENOSPC)) or win in (39, 112):
        return 'NO_SPACE'
    if missing(error):
        return 'FILE_NOT_FOUND'
    if code == errno.EXDEV or win == 17:
        return 'UNSAFE_PATH'
    if code == errno.EBUSY or win in (32, 33):
        return 'FILE_IN_USE'
    if isinstance(error, PermissionError) or code == errno.EROFS or win in (5, 19):
        return 'ACCESS_DENIED'
    if code in (errno.ELOOP, errno.ENOTDIR) or win in (267, 1920, 4390, 4392, 4393):
        return 'UNSAFE_PATH'
    return 'FAILED'


FIELDS = {
    'mkdir': {'op', 'root', 'relativePath'},
    'move': {'op', 'root', 'from', 'to'},
    'trash': {'op', 'root', 'relativePath', 'trashId', 'expect'},
    'restore': {'op', 'root', 'trashId', 'name', 'targetParent', 'candidates'},
    'purge': {'op', 'root', 'trashId'},
}


def decode(request):
    if (not isinstance(request, dict) or request.get('op') not in FIELDS or set(request) != FIELDS[request['op']]
            or not isinstance(request['root'], str)):
        raise Refusal('FAILED')
    if request['op'] == 'trash':
        expect = request['expect']
        if expect is not None and (not isinstance(expect, dict) or not set(expect) <= {'type', 'size', 'modifiedMs'}):
            raise Refusal('FAILED')
    if request['op'] == 'restore':
        if (not isinstance(request['targetParent'], list) or not isinstance(request['candidates'], list)
                or not 0 < len(request['candidates']) <= 32):
            raise Refusal('FAILED')
    return request


def dispatch(request, confirm):
    op = request['op']
    if op == 'mkdir':
        return make_directory(request['root'], request['relativePath'], confirm)
    if op == 'move':
        return move_entry(request['root'], request['from'], request['to'], confirm)
    if op == 'trash':
        return trash_entry(request['root'], request['relativePath'], request['trashId'], request['expect'], confirm)
    if op == 'restore':
        return restore_entry(request['root'], request['trashId'], request['name'], request['targetParent'],
                             request['candidates'], confirm)
    return purge_entry(request['root'], request['trashId'], confirm)


def run():
    """Protocolo: petición en una línea, READY en stderr, espera W, resultado JSON."""
    def confirm():
        sys.stderr.write('READY\n')
        sys.stderr.flush()
        if sys.stdin.buffer.read(1) != b'W':
            raise Refusal('FAILED')

    try:
        request = decode(json.loads(sys.stdin.buffer.readline(65536)))
        sys.stdout.write(json.dumps(dispatch(request, confirm)))
        return 0
    except Exception as error:
        sys.stderr.write(error_code(error) + '\n')
        return 1


if __name__ == '__main__':
    sys.exit(run())
