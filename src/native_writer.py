"""Creación exclusiva de un archivo nuevo por handles. Solo biblioteca estándar.

Reutiliza la apertura por componentes del lector seguro: los directorios se
adquieren sin seguir enlaces y el archivo se crea respecto al handle del padre.
El contenido se escribe en un temporal exclusivo del mismo directorio y se
publica con una operación que nunca reemplaza un nombre existente:
NtSetInformationFile(FileRenameInformation, ReplaceIfExists=FALSE) en Windows y
linkat en POSIX. Si algo falla antes de publicar, el temporal se descarta y el
nombre de destino no llega a existir.

Windows informa algunas colisiones de nombre como denegaciones: un nombre
abierto sin compartir por otro proceso (STATUS_SHARING_VIOLATION) o pendiente
de eliminación (STATUS_DELETE_PENDING, que Win32 traduce a ERROR_ACCESS_DENIED).
La existencia se consulta con una apertura solo de atributos, que no participa
en los modos de uso compartido, y se clasifica por NTSTATUS antes de traducirlo.
Una denegación real (STATUS_ACCESS_DENIED sin evidencia de que el nombre esté
ocupado) se sigue informando como ACCESS_DENIED.
"""
import base64
import contextlib
import errno
import importlib.util
import json
import os
from pathlib import Path
import stat
import sys
import uuid

_spec = importlib.util.spec_from_file_location('native_reader', Path(__file__).with_name('native_reader.py'))
reader = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(reader)

Refusal = reader.Refusal
component = reader.component
MAX_BYTES = 1024 * 1024
WINDOWS_EPOCH = 116444736000000000
STATUS_ACCESS_DENIED = 0xC0000022
STATUS_OBJECT_NAME_NOT_FOUND = 0xC0000034
STATUS_OBJECT_NAME_COLLISION = 0xC0000035
STATUS_OBJECT_PATH_NOT_FOUND = 0xC000003A
STATUS_SHARING_VIOLATION = 0xC0000043
STATUS_DELETE_PENDING = 0xC0000056
# Estados que prueban que el nombre existe aunque no se pueda abrir.
NAME_OCCUPIED = frozenset({STATUS_OBJECT_NAME_COLLISION, STATUS_SHARING_VIOLATION, STATUS_DELETE_PENDING})


def temporary_name():
    return f'.mind-create-{uuid.uuid4().hex}.tmp'


class Posix(reader.Posix):
    def __init__(self):
        super().__init__()
        if (not all(function in os.supports_dir_fd for function in (os.link, os.unlink, os.stat))
                or os.link not in os.supports_follow_symlinks
                or not hasattr(os, 'O_CLOEXEC')):
            raise Refusal('SAFE_OPEN_UNAVAILABLE')

    def exists(self, parent, name):
        try:
            os.stat(component(name), dir_fd=parent, follow_symlinks=False)
            return True
        except FileNotFoundError:
            return False

    def create(self, parent, name):
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC
        return os.open(component(name), flags, 0o666, dir_fd=parent)

    def write(self, handle, data):
        view = memoryview(data)
        while view:
            view = view[os.write(handle, view):]
        os.fsync(handle)

    def _same(self, handle, parent, name):
        held = os.fstat(handle)
        try:
            named = os.stat(name, dir_fd=parent, follow_symlinks=False)
        except FileNotFoundError:
            return False
        return (named.st_dev, named.st_ino) == (held.st_dev, held.st_ino)

    def publish(self, handle, parent, temporary, name):
        if not self._same(handle, parent, temporary):
            raise Refusal('UNSAFE_PATH')
        # linkat falla con EEXIST si el nombre existe, sea archivo, carpeta o enlace.
        os.link(temporary, name, src_dir_fd=parent, dst_dir_fd=parent, follow_symlinks=False)
        try:
            os.unlink(temporary, dir_fd=parent)
        except BaseException:
            # Sin el temporal retirado no se entrega un archivo con dos nombres.
            if self._same(handle, parent, name):
                os.unlink(name, dir_fd=parent)
            raise
        with contextlib.suppress(OSError):
            os.fsync(parent)

    def discard(self, handle, parent, temporary):
        if self._same(handle, parent, temporary):
            os.unlink(temporary, dir_fd=parent)

    def metadata(self, handle):
        info = os.fstat(handle)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise Refusal('UNSAFE_PATH')
        birth = getattr(info, 'st_birthtime', None)
        return {'size': info.st_size, 'modifiedMs': info.st_mtime_ns // 1_000_000,
                'changedMs': info.st_ctime_ns // 1_000_000,
                'createdMs': int(birth * 1000) if birth else None}


class Windows(reader.Windows):
    def __init__(self):
        super().__init__()
        c, w = self.c, self.w

        class Basic(c.Structure):
            _fields_ = [('created', c.c_longlong), ('accessed', c.c_longlong),
                        ('written', c.c_longlong), ('changed', c.c_longlong),
                        ('attributes', w.DWORD)]

        self.Basic = Basic
        self.nt.NtSetInformationFile.argtypes = [w.HANDLE, c.POINTER(self.Status), w.LPVOID, w.ULONG, w.ULONG]
        self.nt.NtSetInformationFile.restype = c.c_long
        self.kernel.WriteFile.argtypes = [w.HANDLE, w.LPCVOID, w.DWORD, c.POINTER(w.DWORD), w.LPVOID]
        self.kernel.WriteFile.restype = w.BOOL
        self.kernel.FlushFileBuffers.argtypes = [w.HANDLE]
        self.kernel.FlushFileBuffers.restype = w.BOOL
        self.kernel.GetFileInformationByHandleEx.argtypes = [w.HANDLE, c.c_int, w.LPVOID, w.DWORD]
        self.kernel.GetFileInformationByHandleEx.restype = w.BOOL

    def _status(self, result):
        if result < 0:
            raise self.c.WinError(self.nt.RtlNtStatusToDosError(result))

    def _probe(self, parent, name):
        """NTSTATUS (sin signo) de abrir name solo para consultar sus atributos.

        SYNCHRONIZE | FILE_READ_ATTRIBUTES no pide datos ni DELETE, así que no
        entra en conflicto con un handle ajeno abierto sin compartir. No abre el
        contenido ni sigue enlaces (FILE_OPEN_REPARSE_POINT).
        """
        c, w = self.c, self.w
        buffer = c.create_unicode_buffer(name)
        length = len(name.encode('utf-16-le'))
        if length > 65532:
            raise Refusal('UNSAFE_PATH')
        text = self.Unicode(length, length + 2, c.cast(buffer, w.LPWSTR))
        attrs = self.Attributes(c.sizeof(self.Attributes), parent, c.pointer(text), 0x40, None, None)
        handle, status = w.HANDLE(), self.Status()
        # FILE_OPEN (1); comparte todo (7); opciones: E/S síncrona y FILE_OPEN_REPARSE_POINT.
        result = self.nt.NtCreateFile(c.byref(handle), 0x100080, c.byref(attrs), c.byref(status),
                                      None, 0, 7, 1, 0x200020, None, 0)
        if result >= 0:
            self.close(handle.value)
        return result & 0xFFFFFFFF, result

    def occupied(self, parent, name):
        """True si el nombre existe; False si no; OSError ante una denegación real."""
        status, result = self._probe(parent, component(name))
        if status < 0x80000000 or status in NAME_OCCUPIED:
            return True
        if status in (STATUS_OBJECT_NAME_NOT_FOUND, STATUS_OBJECT_PATH_NOT_FOUND):
            return False
        raise self.c.WinError(self.nt.RtlNtStatusToDosError(result))

    def exists(self, parent, name):
        return self.occupied(parent, name)

    def create(self, parent, name):
        c, w = self.c, self.w
        name = component(name)
        buffer = c.create_unicode_buffer(name)
        length = len(name.encode('utf-16-le'))
        text = self.Unicode(length, length + 2, c.cast(buffer, w.LPWSTR))
        attrs = self.Attributes(c.sizeof(self.Attributes), parent, c.pointer(text), 0x40, None, None)
        handle, status = w.HANDLE(), self.Status()
        # SYNCHRONIZE, DELETE, READ_ATTRIBUTES, WRITE_DATA; sin compartir mientras se escribe.
        access = 0x100000 | 0x10000 | 0x80 | 0x2
        # FILE_CREATE (2) nunca abre ni trunca algo existente. Opciones: no directorio,
        # E/S síncrona y FILE_OPEN_REPARSE_POINT.
        self._status(self.nt.NtCreateFile(c.byref(handle), access, c.byref(attrs), c.byref(status),
                                          None, 0x80, 0, 2, 0x200060, None, 0))
        return handle.value

    def write(self, handle, data):
        c, w = self.c, self.w
        offset = 0
        while offset < len(data):
            chunk = data[offset:offset + 65536]
            written = w.DWORD()
            if not self.kernel.WriteFile(handle, chunk, len(chunk), c.byref(written), None) or written.value == 0:
                raise c.WinError(c.get_last_error())
            offset += written.value
        if not self.kernel.FlushFileBuffers(handle):
            raise c.WinError(c.get_last_error())

    def publish(self, handle, parent, temporary, name):
        c, w = self.c, self.w
        encoded = component(name).encode('utf-16-le')

        class Rename(c.Structure):
            _fields_ = [('flags', w.ULONG), ('root', w.HANDLE), ('length', w.ULONG),
                        ('name', w.WCHAR * (len(encoded) // 2))]

        info = Rename(0, parent, len(encoded))
        c.memmove(c.addressof(info) + Rename.name.offset, encoded, len(encoded))
        # ReplaceIfExists=FALSE; el nombre se resuelve respecto al padre ya adquirido.
        result = self.nt.NtSetInformationFile(handle, c.byref(self.Status()), c.byref(info),
                                              c.sizeof(info), 10)
        if result >= 0:
            return
        status = result & 0xFFFFFFFF
        if status in NAME_OCCUPIED:
            raise Refusal('FILE_EXISTS')
        # El temporal ya se creó en este mismo padre, con los mismos derechos que
        # exige el renombrado. Un ACCESS_DENIED aquí solo se atribuye a una
        # colisión si el nombre consta ocupado; si no, se informa la denegación.
        if status == STATUS_ACCESS_DENIED:
            try:
                taken = self.occupied(parent, name)
            except OSError:
                taken = False
            if taken:
                raise Refusal('FILE_EXISTS')
        self._status(result)

    def discard(self, handle, parent, temporary):
        flag = self.c.c_ubyte(1)  # FileDispositionInformation: DeleteFile=TRUE.
        self._status(self.nt.NtSetInformationFile(handle, self.c.byref(self.Status()),
                                                  self.c.byref(flag), 1, 13))

    def metadata(self, handle):
        self.check(handle, False)
        basic, info = self.Basic(), self.Info()
        if (not self.kernel.GetFileInformationByHandleEx(handle, 0, self.c.byref(basic), self.c.sizeof(basic))
                or not self.kernel.GetFileInformationByHandle(handle, self.c.byref(info))):
            raise self.c.WinError(self.c.get_last_error())
        ms = lambda value: (value - WINDOWS_EPOCH) // 10_000 if value > 0 else None
        return {'size': (info.size_high << 32) | info.size_low, 'modifiedMs': ms(basic.written),
                'changedMs': ms(basic.changed), 'createdMs': ms(basic.created)}


def open_parent(backend, stack, root, parts, after_directory=None):
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
    return parent, volume


def create_file(root, relative, data, confirm=None, after_directory=None, before_publish=None, backend=None):
    """Crea relative con data; nunca sobrescribe ni deja resultados parciales en el destino.

    after_directory y before_publish son barreras deterministas solo para pruebas.
    """
    backend = backend or (Windows() if os.name == 'nt' else Posix())
    parts = [component(part) for part in relative.split('/')]
    name = parts[-1]
    with contextlib.ExitStack() as stack:
        parent, volume = open_parent(backend, stack, root, parts, after_directory)
        if backend.exists(parent, name):
            raise Refusal('FILE_EXISTS')
        if confirm:
            confirm()
        temporary = temporary_name()
        handle = backend.create(parent, temporary)
        stack.callback(backend.close, handle)
        published = False
        try:
            if backend.check(handle, False) != volume:
                raise Refusal('UNSAFE_PATH')
            backend.write(handle, data)
            if before_publish:
                before_publish(temporary)
            backend.publish(handle, parent, temporary, name)
            published = True
        except BaseException:
            if not published:
                with contextlib.suppress(OSError):
                    backend.discard(handle, parent, temporary)
            raise
        # Ya publicado: un fallo al consultar metadatos no debe ocultar que el archivo existe.
        try:
            return backend.metadata(handle)
        except (OSError, Refusal):
            return {'size': len(data), 'modifiedMs': None, 'changedMs': None, 'createdMs': None}


def error_code(error):
    if isinstance(error, Refusal):
        return str(error)
    win = getattr(error, 'winerror', None)
    if isinstance(error, FileExistsError) or win in (80, 183):
        return 'FILE_EXISTS'
    if getattr(error, 'errno', None) == errno.ENOSPC or win in (39, 112):
        return 'NO_SPACE'
    if isinstance(error, FileNotFoundError) or win in (2, 3):
        return 'PARENT_NOT_FOUND'
    code = reader.error_code(error)
    return 'CREATE_FAILED' if code == 'READ_FAILED' else code


def decode(request):
    if not isinstance(request, dict) or set(request) != {'root', 'relativePath', 'content'}:
        raise Refusal('CREATE_FAILED')
    data = base64.b64decode(request['content'], validate=True)
    if len(data) > MAX_BYTES:
        raise Refusal('TEXT_TOO_LARGE')
    try:
        data.decode('utf-8', 'strict')
    except UnicodeDecodeError:
        raise Refusal('INVALID_TEXT') from None
    if b'\0' in data:
        raise Refusal('INVALID_TEXT')
    return request['root'], request['relativePath'], data


def run():
    """Protocolo: petición en una línea, READY en stderr, espera W, resultado JSON."""
    def confirm():
        sys.stderr.write('READY\n')
        sys.stderr.flush()
        if sys.stdin.buffer.read(1) != b'W':
            raise Refusal('CREATE_FAILED')

    try:
        root, relative, data = decode(json.loads(sys.stdin.buffer.readline(3 * MAX_BYTES)))
        result = create_file(root, relative, data, confirm)
        sys.stdout.write(json.dumps(result))
        return 0
    except Exception as error:
        sys.stderr.write(error_code(error) + '\n')
        return 1


if __name__ == '__main__':
    sys.exit(run())
