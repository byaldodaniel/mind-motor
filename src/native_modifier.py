"""Sustitución segura del contenido de un archivo de texto existente. Solo biblioteca estándar.

Reutiliza la apertura por componentes del lector seguro: los directorios y el
archivo se adquieren sin seguir enlaces. El contenido actual se lee por el
mismo handle y se compara con la versión esperada (SHA-256). El nuevo contenido
se escribe completo en un temporal exclusivo del mismo directorio y se publica
con un rename atómico que reemplaza el nombre:

- Windows: el archivo se mantiene abierto sin compartir escritura mientras se
  verifica y publica; nadie más puede cambiar su contenido. La publicación usa
  FileRenameInformationEx con REPLACE_IF_EXISTS y POSIX_SEMANTICS respecto al
  handle del padre, y después se confirma que el archivo sustituido es el
  verificado.
- POSIX: flock exclusivo no bloqueante sobre el descriptor original durante
  verificación, preparación y publicación. Tras bloquear se verifica que el
  nombre aún corresponde al inode abierto; se conservan las comprobaciones
  previas a renameat y la confirmación del inode sustituido. El bloqueo es
  consultivo: otros programas que no lo respetan aún pueden interferir.

Si no se pueden conservar los metadatos de seguridad del original, se rechaza.
"""
import base64
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

_spec = importlib.util.spec_from_file_location('native_reader', Path(__file__).with_name('native_reader.py'))
reader = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(reader)

Refusal = reader.Refusal
component = reader.component
MAX_BYTES = 1024 * 1024
# Máximo propio del auxiliar: el anfitrión puede pedir un límite menor o mayor
# que el predeterminado (maxBytes), pero nunca por encima de este. Se aplica al
# contenido nuevo y a la lectura de verificación del archivo actual.
ABSOLUTE_MAX_BYTES = 16 * 1024 * 1024
WINDOWS_EPOCH = 116444736000000000


def temporary_name():
    return f'.mind-modify-{uuid.uuid4().hex}.tmp'


def check_text(data, code):
    try:
        data.decode('utf-8', 'strict')
    except UnicodeDecodeError:
        raise Refusal(code) from None
    if b'\0' in data:
        raise Refusal(code)


class Posix(reader.Posix):
    def __init__(self):
        super().__init__()
        if (not all(function in os.supports_dir_fd for function in (os.rename, os.unlink, os.stat))
                or not all(hasattr(os, name) for name in ('O_CLOEXEC', 'fchmod', 'fchown'))):
            raise Refusal('SAFE_OPEN_UNAVAILABLE')

    def open_target(self, parent, name):
        handle = self.child(parent, name, False)
        try:
            import fcntl
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError as error:
                if error.errno in (errno.EACCES, errno.EAGAIN):
                    raise Refusal('FILE_IN_USE') from None
                raise
            # Un descriptor abierto antes de otro rename puede bloquear el inode
            # antiguo cuando el ganador ya lo liberó. Nunca usarlo como vigente.
            if not self._same(handle, parent, name):
                raise Refusal('VERSION_CONFLICT')
            volume = self.check(handle, False)
            return handle, volume
        except BaseException:
            self.close(handle)
            raise

    def read(self, handle, limit=MAX_BYTES):
        """Lee como máximo limit + 1 bytes: lo justo para saber si supera el límite."""
        chunks, size = [], 0
        while size <= limit:
            chunk = os.read(handle, min(65536, limit + 1 - size))
            if not chunk:
                break
            chunks.append(chunk)
            size += len(chunk)
        return b''.join(chunks)

    @staticmethod
    def _snapshot(info):
        return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)

    def inspect(self, handle):
        info = os.fstat(handle)
        if not info.st_mode & stat.S_IWUSR:
            raise Refusal('ACCESS_DENIED')  # Sin escritura para el dueño: el usuario lo protegió.
        if info.st_mode & 0o7000 or info.st_uid != os.geteuid():
            raise Refusal('METADATA_NOT_PRESERVABLE')
        if hasattr(os, 'listxattr'):
            try:
                names = os.listxattr(handle)
            except OSError:
                names = []
            # Las etiquetas SELinux se asignan de nuevo; ACL u otros atributos se perderían.
            if any(name != 'security.selinux' for name in names):
                raise Refusal('METADATA_NOT_PRESERVABLE')
        return {'snapshot': self._snapshot(info), 'mode': stat.S_IMODE(info.st_mode), 'gid': info.st_gid}

    def create(self, parent, name, original):
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC
        handle = os.open(component(name), flags, 0o600, dir_fd=parent)
        try:
            os.fchmod(handle, original['mode'])
            if os.fstat(handle).st_gid != original['gid']:
                try:
                    os.fchown(handle, -1, original['gid'])
                except PermissionError:
                    raise Refusal('METADATA_NOT_PRESERVABLE') from None
            return handle
        except BaseException:
            os.close(handle)
            with contextlib.suppress(OSError):
                os.unlink(name, dir_fd=parent)
            raise

    def write(self, handle, data):
        view = memoryview(data)
        while view:
            view = view[os.write(handle, view):]
        os.fsync(handle)

    def _named(self, parent, name):
        try:
            return os.stat(name, dir_fd=parent, follow_symlinks=False)
        except FileNotFoundError:
            return None

    def _same(self, handle, parent, name):
        held, named = os.fstat(handle), self._named(parent, name)
        return named is not None and (named.st_dev, named.st_ino) == (held.st_dev, held.st_ino)

    def publish(self, temp, parent, temporary, target, name, original):
        named = self._named(parent, name)
        if (named is None or not stat.S_ISREG(named.st_mode)
                or self._snapshot(named) != original['snapshot']
                or self._snapshot(os.fstat(target)) != original['snapshot']):
            raise Refusal('VERSION_CONFLICT')
        if not self._same(temp, parent, temporary):
            raise Refusal('UNSAFE_PATH')
        os.rename(temporary, name, src_dir_fd=parent, dst_dir_fd=parent)
        with contextlib.suppress(OSError):
            os.fsync(parent)

    def confirm_replaced(self, target, original=None, parent=None, name=None, temp=None):
        # El inode verificado ya no tiene nombre: lo sustituido era exactamente él.
        return os.fstat(target).st_nlink == 0

    def discard(self, handle, parent, temporary):
        if self._same(handle, parent, temporary):
            os.unlink(temporary, dir_fd=parent)

    def metadata(self, handle):
        info = os.fstat(handle)
        birth = getattr(info, 'st_birthtime', None)
        return {'size': info.st_size, 'modifiedMs': info.st_mtime_ns // 1_000_000,
                'changedMs': info.st_ctime_ns // 1_000_000,
                'createdMs': int(birth * 1000) if birth else None,
                'identity': f'posix:{info.st_dev}:{info.st_ino}'}


class Windows(reader.Windows):
    # Atributos que se pueden trasladar al nuevo archivo sin perder garantías.
    PRESERVED = 0x2 | 0x20 | 0x2000  # HIDDEN, ARCHIVE, NOT_CONTENT_INDEXED
    ALLOWED = PRESERVED | 0x80  # NORMAL

    def __init__(self):
        super().__init__()
        self._delete_excluded_targets = set()
        c, w = self.c, self.w

        class Basic(c.Structure):
            _fields_ = [('created', c.c_longlong), ('accessed', c.c_longlong),
                        ('written', c.c_longlong), ('changed', c.c_longlong),
                        ('attributes', w.DWORD)]

        class Standard(c.Structure):
            _fields_ = [('allocation', c.c_longlong), ('end', c.c_longlong), ('links', w.DWORD),
                        ('delete_pending', c.c_ubyte), ('directory', c.c_ubyte)]

        self.Basic, self.Standard = Basic, Standard
        self.advapi = c.WinDLL('advapi32', use_last_error=True)
        self.nt.NtSetInformationFile.argtypes = [w.HANDLE, c.POINTER(self.Status), w.LPVOID, w.ULONG, w.ULONG]
        self.nt.NtSetInformationFile.restype = c.c_long
        for name, args in (('ReadFile', [w.HANDLE, w.LPVOID, w.DWORD, c.POINTER(w.DWORD), w.LPVOID]),
                           ('WriteFile', [w.HANDLE, w.LPCVOID, w.DWORD, c.POINTER(w.DWORD), w.LPVOID]),
                           ('FlushFileBuffers', [w.HANDLE]),
                           ('GetFileInformationByHandleEx', [w.HANDLE, c.c_int, w.LPVOID, w.DWORD]),
                           ('SetFileInformationByHandle', [w.HANDLE, c.c_int, w.LPVOID, w.DWORD])):
            getattr(self.kernel, name).argtypes = args
            getattr(self.kernel, name).restype = w.BOOL
        self.kernel.LocalFree.argtypes = [w.HLOCAL]
        self.kernel.LocalFree.restype = w.HLOCAL
        self.advapi.GetSecurityInfo.argtypes = [w.HANDLE, c.c_int, w.DWORD, c.POINTER(w.LPVOID),
                                                c.POINTER(w.LPVOID), c.POINTER(w.LPVOID),
                                                c.POINTER(w.LPVOID), c.POINTER(w.LPVOID)]
        self.advapi.GetSecurityInfo.restype = w.DWORD
        self.advapi.GetSecurityDescriptorControl.argtypes = [w.LPVOID, c.POINTER(w.WORD), c.POINTER(w.DWORD)]
        self.advapi.GetSecurityDescriptorControl.restype = w.BOOL
        self.advapi.GetAce.argtypes = [w.LPVOID, w.DWORD, c.POINTER(w.LPVOID)]
        self.advapi.GetAce.restype = w.BOOL

    def _status(self, result):
        if result < 0:
            raise self.c.WinError(self.nt.RtlNtStatusToDosError(result))

    def _error(self):
        raise self.c.WinError(self.c.get_last_error())

    def _nt(self, parent, name, access, share, disposition, options, attributes=0):
        c, w = self.c, self.w
        buffer = c.create_unicode_buffer(name)
        length = len(name.encode('utf-16-le'))
        if length > 65532:
            raise Refusal('UNSAFE_PATH')
        text = self.Unicode(length, length + 2, c.cast(buffer, w.LPWSTR))
        attrs = self.Attributes(c.sizeof(self.Attributes), parent, c.pointer(text), 0x40, None, None)
        handle, status = w.HANDLE(), self.Status()
        self._status(self.nt.NtCreateFile(c.byref(handle), access, c.byref(attrs), c.byref(status),
                                          None, attributes, share, disposition, options, None, 0))
        return handle.value

    def open_target(self, parent, name):
        # SYNCHRONIZE, READ_CONTROL, READ_ATTRIBUTES, READ_DATA y WRITE_DATA.
        # Sin FILE_SHARE_WRITE: también otra instancia de Mind debe pedir escritura,
        # de modo que su apertura falle mientras este handle permanece abierto.
        volume = self.check(parent, True)
        capabilities = self._fat32_no_hardlinks_flags(parent, volume)
        # En FAT32/DriveFS el reemplazo clásico exige conservar una exclusión
        # de DELETE: bloquea intercambiar el nombre original durante el commit,
        # incluso si existía antes un handle con acceso DELETE.
        share = 0x1 if capabilities is not None else 0x1 | 0x4
        handle = self._nt(parent, component(name), 0x100000 | 0x20000 | 0x80 | 0x1 | 0x2, share, 1, 0x200020)
        try:
            target_volume = self.check(handle, False)
            if share == 0x1:
                self._delete_excluded_targets.add(handle)
            return handle, target_volume
        except BaseException:
            self.close(handle)
            raise

    def close(self, handle):
        self._delete_excluded_targets.discard(handle)
        super().close(handle)

    def read(self, handle, limit=MAX_BYTES):
        """Lee como máximo limit + 1 bytes: lo justo para saber si supera el límite."""
        c, w = self.c, self.w
        chunks, size = [], 0
        buffer = c.create_string_buffer(65536)
        while size <= limit:
            count = w.DWORD()
            if not self.kernel.ReadFile(handle, buffer, min(65536, limit + 1 - size), c.byref(count), None):
                self._error()
            if count.value == 0:
                break
            chunks.append(buffer.raw[:count.value])
            size += count.value
        return b''.join(chunks)

    def _identity(self, handle):
        info = self.Info()
        if not self.kernel.GetFileInformationByHandle(handle, self.c.byref(info)):
            self._error()
        return info

    def _single_stream(self, handle):
        c = self.c
        buffer = c.create_string_buffer(4096)
        if not self.kernel.GetFileInformationByHandleEx(handle, 7, buffer, len(buffer)):
            error = c.get_last_error()
            if error == 38:  # ERROR_HANDLE_EOF: sin flujos de datos.
                return True
            raise c.WinError(error)
        next_offset = int.from_bytes(buffer.raw[0:4], 'little')
        length = int.from_bytes(buffer.raw[4:8], 'little')
        name = buffer.raw[24:24 + length].decode('utf-16-le')
        return next_offset == 0 and name == '::$DATA'

    def _inherited_dacl_only(self, handle):
        c, w = self.c, self.w
        dacl, descriptor = w.LPVOID(), w.LPVOID()
        if self.advapi.GetSecurityInfo(handle, 1, 4, None, None, c.byref(dacl), None, c.byref(descriptor)):
            return False
        try:
            control, revision = w.WORD(), w.DWORD()
            if (not dacl.value
                    or not self.advapi.GetSecurityDescriptorControl(descriptor, c.byref(control), c.byref(revision))
                    or control.value & 0x1000):  # SE_DACL_PROTECTED
                return False
            count = int.from_bytes(c.string_at(dacl.value + 4, 2), 'little')
            for index in range(count):
                ace = w.LPVOID()
                if not self.advapi.GetAce(dacl, index, c.byref(ace)):
                    return False
                if not c.string_at(ace.value + 1, 1)[0] & 0x10:  # INHERITED_ACE
                    return False
            return True
        finally:
            self.kernel.LocalFree(descriptor)

    def inspect(self, handle):
        info = self._identity(handle)
        if info.attributes & 0x1:
            raise Refusal('ACCESS_DENIED')  # Solo lectura: el usuario lo protegió.
        capabilities = self._fat32_no_hardlinks_flags(handle, info.volume)
        # No existen ADS ni ACL persistentes en el volumen confirmado. Evitar
        # consultas que el proveedor no implementa sólo cuando sus flags lo prueban.
        no_streams = capabilities is not None and not capabilities & 0x00040000
        no_acls = capabilities is not None and not capabilities & 0x00000008
        if (info.attributes & ~self.ALLOWED
                or (not no_streams and not self._single_stream(handle))
                or (not no_acls and not self._inherited_dacl_only(handle))):
            raise Refusal('METADATA_NOT_PRESERVABLE')
        basic = self.Basic()
        if not self.kernel.GetFileInformationByHandleEx(handle, 0, self.c.byref(basic), self.c.sizeof(basic)):
            self._error()
        return {'identity': (info.volume, info.index_high, info.index_low),
                'attributes': info.attributes & self.PRESERVED, 'created': basic.created,
                'zero_links_reported': info.links == 0 and capabilities is not None,
                'delete_excluded': handle in self._delete_excluded_targets}

    def create(self, parent, name, original):
        # SYNCHRONIZE, DELETE, READ/WRITE_ATTRIBUTES, WRITE_DATA; FILE_CREATE sin compartir.
        handle = self._nt(parent, component(name), 0x100000 | 0x10000 | 0x100 | 0x80 | 0x2, 0, 2, 0x200060, 0x80)
        try:
            basic = self.Basic(original['created'], 0, 0, 0, original['attributes'])
            if not self.kernel.SetFileInformationByHandle(handle, 0, self.c.byref(basic), self.c.sizeof(basic)):
                self._error()
            return handle
        except BaseException:
            with contextlib.suppress(OSError):
                self.discard(handle, parent, name)
            self.close(handle)
            raise

    def write(self, handle, data):
        c, w = self.c, self.w
        offset = 0
        while offset < len(data):
            chunk = data[offset:offset + 65536]
            written = w.DWORD()
            if not self.kernel.WriteFile(handle, chunk, len(chunk), c.byref(written), None) or written.value == 0:
                self._error()
            offset += written.value
        if not self.kernel.FlushFileBuffers(handle):
            self._error()

    def _confirm_original_name(self, parent, name, original):
        # Resolver un solo componente respecto al padre retenido. No cerrar el
        # original ni abrir su ruta absoluta para poder reemplazarlo.
        try:
            named = self._nt(parent, component(name), 0x100000 | 0x80, 0x7, 1, 0x200020)
        except OSError as error:
            if getattr(error, 'winerror', None) in (2, 3):
                raise Refusal('VERSION_CONFLICT') from None
            raise
        try:
            info = self._identity(named)
            if (info.attributes & 0x400
                    or (info.volume, info.index_high, info.index_low) != original['identity']):
                raise Refusal('VERSION_CONFLICT')
        finally:
            self.close(named)

    def publish(self, temp, parent, temporary, target, name, original):
        c, w = self.c, self.w
        self._confirm_original_name(parent, name, original)
        encoded = name.encode('utf-16-le')

        class Rename(c.Structure):
            _fields_ = [('flags', w.ULONG), ('root', w.HANDLE), ('length', w.ULONG),
                        ('name', w.WCHAR * (len(encoded) // 2))]

        # FILE_RENAME_REPLACE_IF_EXISTS | FILE_RENAME_POSIX_SEMANTICS.
        info = Rename(0x1 | 0x2, parent, len(encoded))
        c.memmove(c.addressof(info) + Rename.name.offset, encoded, len(encoded))
        result = self.nt.NtSetInformationFile(temp, c.byref(self.Status()), c.byref(info), c.sizeof(info), 65)
        unsupported = (-1073741821, -1073741822, -1073741637, -1073741811)
        if result in unsupported:
            capabilities = self._fat32_no_hardlinks_flags(target, original['identity'][0])
            if (not original.get('zero_links_reported') or capabilities is None
                    or not original.get('delete_excluded') or target not in self._delete_excluded_targets):
                raise Refusal('SAFE_OPEN_UNAVAILABLE')
            # DriveFS/FAT32 no implementa la clase extendida. La clase clásica
            # sigue siendo un renombrado nativo relativo al mismo handle padre.
            # Revalidar tras el rechazo; original y temporal permanecen abiertos.
            self._confirm_original_name(parent, name, original)
            info.flags = 1
            result = self.nt.NtSetInformationFile(temp, c.byref(self.Status()), c.byref(info), c.sizeof(info), 10)
            self._status(result)
            original['classic_fallback'] = True
            return
        self._status(result)

    def confirm_replaced(self, target, original=None, parent=None, name=None, temp=None):
        standard = self.Standard()
        if not self.kernel.GetFileInformationByHandleEx(target, 1, self.c.byref(standard), self.c.sizeof(standard)):
            self._error()
        if original and original.get('zero_links_reported'):
            if not original.get('classic_fallback'):
                return bool(standard.delete_pending)
            if (parent is None or name is None or temp is None
                    or not original.get('delete_excluded') or target not in self._delete_excluded_targets):
                return False
            # En DriveFS ni cero enlaces ni delete_pending demuestran el cambio.
            # El nombre final debe identificar al temporal retenido y diferir del
            # original, ambos aún abiertos, sin enlaces ni cambio de volumen.
            try:
                named = self._nt(parent, component(name), 0x100000 | 0x80, 0x7, 1, 0x200020)
            except OSError:
                return False
            try:
                self.check(named, False)
                current, replacement, previous = self._identity(named), self._identity(temp), self._identity(target)
                identity = lambda info: (info.volume, info.index_high, info.index_low)
                return (identity(current) == identity(replacement)
                        and identity(current) != identity(previous)
                        and identity(previous) == original['identity']
                        and current.volume == previous.volume)
            finally:
                self.close(named)
        return standard.links == 0 or bool(standard.delete_pending)

    def discard(self, handle, parent, temporary):
        flag = self.c.c_ubyte(1)  # FileDispositionInformation: DeleteFile=TRUE.
        self._status(self.nt.NtSetInformationFile(handle, self.c.byref(self.Status()),
                                                  self.c.byref(flag), 1, 13))

    def metadata(self, handle):
        basic, info = self.Basic(), self._identity(handle)
        if not self.kernel.GetFileInformationByHandleEx(handle, 0, self.c.byref(basic), self.c.sizeof(basic)):
            self._error()
        ms = lambda value: (value - WINDOWS_EPOCH) // 10_000 if value > 0 else None
        return {'size': (info.size_high << 32) | info.size_low, 'modifiedMs': ms(basic.written),
                'changedMs': ms(basic.changed), 'createdMs': ms(basic.created),
                'identity': f'nt:{info.volume}:{(info.index_high << 32) | info.index_low}'}


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


def modify_file(root, relative, expected, data, confirm=None, after_directory=None, before_publish=None, backend=None,
                max_bytes=MAX_BYTES):
    """Sustituye el contenido si la versión actual coincide con expected (SHA-256 hex).

    after_directory y before_publish son barreras deterministas solo para pruebas.
    max_bytes limita la lectura de verificación del archivo actual, acotado por el
    máximo propio del auxiliar. Devuelve los metadatos del archivo publicado.
    """
    backend = backend or (Windows() if os.name == 'nt' else Posix())
    limit = min(max_bytes, ABSOLUTE_MAX_BYTES)
    parts = [component(part) for part in relative.split('/')]
    name = parts[-1]
    with contextlib.ExitStack() as stack:
        parent, volume = open_parent(backend, stack, root, parts, after_directory)
        target, target_volume = backend.open_target(parent, name)
        stack.callback(backend.close, target)
        if target_volume != volume:
            raise Refusal('UNSAFE_PATH')
        current = backend.read(target, limit)
        if len(current) > limit:
            raise Refusal('FILE_TOO_LARGE')
        check_text(current, 'TEXT_UNREADABLE')
        if hashlib.sha256(current).hexdigest() != expected:
            raise Refusal('VERSION_CONFLICT')
        original = backend.inspect(target)
        previous_identity = backend.metadata(target).get('identity')
        if confirm:
            confirm()
        temporary = temporary_name()
        temp = backend.create(parent, temporary, original)
        stack.callback(backend.close, temp)
        published = False
        try:
            if backend.check(temp, False) != volume:
                raise Refusal('UNSAFE_PATH')
            backend.write(temp, data)
            if before_publish:
                before_publish(temporary)
            backend.publish(temp, parent, temporary, target, name, original)
            published = True
        except BaseException:
            if not published:
                with contextlib.suppress(OSError):
                    backend.discard(temp, parent, temporary)
            raise
        if not backend.confirm_replaced(target, original, parent, name, temp):
            raise Refusal('MODIFY_UNCONFIRMED')
        try:
            return {**backend.metadata(temp), 'previousIdentity': previous_identity}
        except OSError:
            return {'size': len(data), 'modifiedMs': None, 'changedMs': None, 'createdMs': None}


def error_code(error):
    if isinstance(error, Refusal):
        return str(error)
    win = getattr(error, 'winerror', None)
    if win in (32, 33):
        return 'FILE_IN_USE'
    if getattr(error, 'errno', None) == 28 or win in (39, 112):
        return 'NO_SPACE'
    code = reader.error_code(error)
    return 'MODIFY_FAILED' if code == 'READ_FAILED' else code


def size_limit(request):
    """Límite pedido por el anfitrión (maxBytes), acotado por el máximo propio; 1 MiB si no se indica."""
    if 'maxBytes' not in request:
        return MAX_BYTES
    value = request['maxBytes']
    if not isinstance(value, int) or isinstance(value, bool) or value < 1:
        raise Refusal('MODIFY_FAILED')
    return min(value, ABSOLUTE_MAX_BYTES)


def decode(request):
    required = {'root', 'relativePath', 'expected', 'content'}
    if (not isinstance(request, dict) or not required <= set(request) <= required | {'maxBytes'}
            or not isinstance(request['expected'], str) or not re.fullmatch(r'[0-9a-f]{64}', request['expected'])):
        raise Refusal('MODIFY_FAILED')
    data = base64.b64decode(request['content'], validate=True)
    if len(data) > size_limit(request):
        raise Refusal('TEXT_TOO_LARGE')
    check_text(data, 'INVALID_TEXT')
    return request['root'], request['relativePath'], request['expected'], data


def run():
    """Protocolo: petición en una línea, READY en stderr, espera W, resultado JSON."""
    def confirm():
        sys.stderr.write('READY\n')
        sys.stderr.flush()
        if sys.stdin.buffer.read(1) != b'W':
            raise Refusal('MODIFY_FAILED')
        parent_guard.begin_commit(10)

    try:
        parent_guard = reader.guard_parent()
        request = json.loads(sys.stdin.buffer.readline(3 * ABSOLUTE_MAX_BYTES))
        root, relative, expected, data = decode(request)
        result = modify_file(root, relative, expected, data, confirm, max_bytes=size_limit(request))
        sys.stdout.write(json.dumps(result))
        return 0
    except Exception as error:
        sys.stderr.write(error_code(error) + '\n')
        return 1


if __name__ == '__main__':
    sys.exit(run())
