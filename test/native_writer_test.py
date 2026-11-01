"""Garantías del SO para la creación, con datos ficticios fuera del repositorio."""
import base64
import contextlib
import csv
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

MOTOR = Path(__file__).resolve().parents[1]
DEVELOPMENT = MOTOR.parent
spec = importlib.util.spec_from_file_location('native_writer', MOTOR / 'src' / 'native_writer.py')
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)


@contextlib.contextmanager
def held(path, share, delete_pending=False):
    """Windows: mantiene path abierto como lo haría otro proceso.

    share=0 reproduce al ganador de una creación concurrente, que conserva su
    handle sin compartir hasta terminar. delete_pending deja el nombre pendiente
    de eliminación hasta cerrar el handle.
    """
    import ctypes as c
    from ctypes import wintypes as w
    kernel = c.WinDLL('kernel32', use_last_error=True)
    kernel.CreateFileW.argtypes = [w.LPCWSTR, w.DWORD, w.DWORD, w.LPVOID, w.DWORD, w.DWORD, w.HANDLE]
    kernel.CreateFileW.restype = w.HANDLE
    kernel.SetFileInformationByHandle.argtypes = [w.HANDLE, c.c_int, w.LPVOID, w.DWORD]
    kernel.SetFileInformationByHandle.restype = w.BOOL
    kernel.CloseHandle.argtypes = [w.HANDLE]
    access = 0x80000000 | (0x10000 if delete_pending else 0)  # GENERIC_READ | DELETE
    handle = kernel.CreateFileW(str(path), access, share, None, 3, 0x80, None)  # OPEN_EXISTING
    if handle in (None, c.c_void_p(-1).value):
        raise c.WinError(c.get_last_error())
    try:
        if delete_pending:
            flag = c.c_ubyte(1)  # FileDispositionInfo (4): DeleteFile=TRUE, semántica clásica.
            if not kernel.SetFileInformationByHandle(handle, 4, c.byref(flag), 1):
                raise c.WinError(c.get_last_error())
        yield
    finally:
        kernel.CloseHandle(handle)


class WriterTest(unittest.TestCase):
    def setUp(self):
        self.temp = Path(tempfile.mkdtemp(prefix='.mind-native-create-test-', dir=DEVELOPMENT))
        self.folder = self.temp / 'Información ficticia'
        self.outside = self.temp / 'ajena'
        self.folder.mkdir()
        self.outside.mkdir()

    def tearDown(self):
        self.assertEqual(self.temp.parent, DEVELOPMENT)
        self.assertTrue(self.temp.name.startswith('.mind-native-create-test-'))
        shutil.rmtree(self.temp)

    def link_dir(self, target, name):
        if os.name == 'nt':
            result = subprocess.run(['cmd', '/c', 'mklink', '/J', str(name), str(target)], capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
        else:
            os.symlink(target, name, target_is_directory=True)

    def unlink_dir(self, name):
        os.rmdir(name) if os.name == 'nt' else os.unlink(name)

    def create(self, relative='nuevo.txt', data=b'creado', **barriers):
        return native.create_file(str(self.folder), relative, data, **barriers)

    def assert_code(self, code, relative='nuevo.txt', **barriers):
        with self.assertRaises((OSError, native.Refusal)) as failure:
            self.create(relative, **barriers)
        self.assertEqual(native.error_code(failure.exception), code)

    def names(self, directory=None):
        return sorted(os.listdir(directory or self.folder))

    def test_creates_exact_bytes_without_leaving_temporaries(self):
        result = self.create(data='café 🧠\r\n'.encode())
        self.assertEqual((self.folder / 'nuevo.txt').read_bytes(), 'café 🧠\r\n'.encode())
        self.assertEqual(result['size'], len('café 🧠\r\n'.encode()))
        self.assertIsInstance(result['modifiedMs'], int)
        self.assertEqual(self.names(), ['nuevo.txt'])

    def test_existing_file_directory_or_link_is_never_replaced(self):
        (self.folder / 'nuevo.txt').write_bytes(b'original')
        (self.folder / 'carpeta').mkdir()
        self.link_dir(self.outside, self.folder / 'enlace')
        try:
            for name in ('nuevo.txt', 'carpeta', 'enlace'):
                self.assert_code('FILE_EXISTS', name)
        finally:
            self.unlink_dir(self.folder / 'enlace')
        self.assertEqual((self.folder / 'nuevo.txt').read_bytes(), b'original')
        self.assertEqual(self.names(), ['carpeta', 'nuevo.txt'])
        self.assertEqual(self.names(self.outside), [])

    def test_name_appearing_before_publish_wins_and_temporary_is_discarded(self):
        def file_race(temporary):
            self.assertTrue(temporary.startswith('.mind-create-'))
            (self.folder / 'nuevo.txt').write_bytes(b'ajeno')

        self.assert_code('FILE_EXISTS', before_publish=file_race)
        self.assertEqual((self.folder / 'nuevo.txt').read_bytes(), b'ajeno')
        self.assertEqual(self.names(), ['nuevo.txt'])

        def link_race(temporary):
            self.link_dir(self.outside, self.folder / 'enlace.txt')

        try:
            self.assert_code('FILE_EXISTS', 'enlace.txt', before_publish=link_race)
        finally:
            self.unlink_dir(self.folder / 'enlace.txt')
        self.assertEqual(self.names(self.outside), [])
        self.assertEqual(self.names(), ['nuevo.txt'])

    def test_failure_before_publish_leaves_no_target_and_no_temporary(self):
        def broken(temporary):
            raise OSError(5, 'fallo ficticio')

        with self.assertRaises(OSError):
            self.create(before_publish=broken)
        self.assertEqual(self.names(), [])
        backend = native.Windows if os.name == 'nt' else native.Posix
        with mock.patch.object(backend, 'write', side_effect=OSError(28, 'sin espacio')):
            self.assert_code('NO_SPACE')
        self.assertEqual(self.names(), [])

    def test_root_replaced_after_acquisition_creates_in_held_directory(self):
        moved = self.temp / 'raíz conservada'

        def barrier(stage):
            self.assertEqual(stage, 'root')
            self.folder.rename(moved)
            self.link_dir(self.outside, self.folder)

        try:
            self.create(after_directory=barrier)
        finally:
            self.unlink_dir(self.folder)
        self.assertEqual((moved / 'nuevo.txt').read_bytes(), b'creado')
        self.assertEqual(self.names(self.outside), [])

    def test_intermediate_replaced_after_acquisition_creates_in_held_directory(self):
        sub = self.folder / 'sub'
        sub.mkdir()
        kept = self.temp / 'sub conservada'

        def barrier(stage):
            if stage == 'sub':
                sub.rename(kept)
                self.link_dir(self.outside, sub)

        try:
            self.create('sub/nuevo.txt', after_directory=barrier)
        finally:
            self.unlink_dir(sub)
        self.assertEqual((kept / 'nuevo.txt').read_bytes(), b'creado')
        self.assertEqual(self.names(self.outside), [])

    def test_link_inserted_before_child_open_is_rejected(self):
        sub = self.folder / 'sub'
        sub.mkdir()

        def barrier(stage):
            if stage == 'root':
                sub.rmdir()
                self.link_dir(self.outside, sub)

        try:
            self.assert_code('UNSAFE_PATH', 'sub/nuevo.txt', after_directory=barrier)
        finally:
            self.unlink_dir(sub)
        self.assertEqual(self.names(self.outside), [])

    def test_missing_parent_and_file_as_parent(self):
        (self.folder / 'archivo').write_bytes(b'x')
        self.assert_code('PARENT_NOT_FOUND', 'falta/nuevo.txt')
        self.assert_code('UNSAFE_PATH', 'archivo/nuevo.txt')
        self.assertEqual(self.names(), ['archivo'])

    def test_real_os_permission_denial(self):
        if os.name == 'nt':
            result = subprocess.run(['whoami', '/user', '/fo', 'csv', '/nh'], capture_output=True, text=True, check=True)
            sid = next(csv.reader(io.StringIO(result.stdout.strip())))[1]
            subprocess.run(['icacls', str(self.folder), '/deny', f'*{sid}:(WD)'], capture_output=True, check=True)
            restore = lambda: subprocess.run(['icacls', str(self.folder), '/remove:d', f'*{sid}'], capture_output=True, check=True)
        else:
            if os.geteuid() == 0:
                self.skipTest('root ignora los modos POSIX')
            self.folder.chmod(0o500)
            restore = lambda: self.folder.chmod(0o700)
        try:
            self.assert_code('ACCESS_DENIED')
        finally:
            restore()
        self.assertEqual(self.names(), [])

    @unittest.skipUnless(os.name == 'nt', 'modos de uso compartido de Windows')
    def test_concurrent_winner_holding_the_name_is_reported_as_existing(self):
        """Ventana de la carrera de creación concurrente en Windows.

        El ganador ya publicó y conserva su handle sin compartir. El perdedor,
        tanto en la comprobación previa como al publicar, debe informar
        FILE_EXISTS y no ACCESS_DENIED.
        """
        target = self.folder / 'carrera.txt'
        target.write_bytes(b'ganador')
        with held(target, share=0):
            self.assert_code('FILE_EXISTS', 'carrera.txt')
        target.unlink()

        with contextlib.ExitStack() as winner:
            def publish_first(temporary):
                target.write_bytes(b'ganador')
                winner.enter_context(held(target, share=0))

            self.assert_code('FILE_EXISTS', 'carrera.txt', before_publish=publish_first)
        self.assertEqual(target.read_bytes(), b'ganador')
        self.assertEqual(self.names(), ['carrera.txt'])

    @unittest.skipUnless(os.name == 'nt', 'eliminación pendiente de Windows')
    def test_name_pending_deletion_is_an_existing_name_not_a_denial(self):
        target = self.folder / 'pendiente.txt'
        target.write_bytes(b'anterior')
        with held(target, share=7, delete_pending=True):
            self.assert_code('FILE_EXISTS', 'pendiente.txt')
        self.assertEqual(self.names(), [])

        other = self.folder / 'tardío.txt'
        with contextlib.ExitStack() as pending:
            def deleted_before_publish(temporary):
                other.write_bytes(b'anterior')
                pending.enter_context(held(other, share=7, delete_pending=True))

            self.assert_code('FILE_EXISTS', 'tardío.txt', before_publish=deleted_before_publish)
        self.assertEqual(self.names(), [])
        # Libre el nombre, la creación procede con normalidad.
        self.create('pendiente.txt')
        self.assertEqual(self.names(), ['pendiente.txt'])

    @unittest.skipUnless(os.name == 'nt', 'ACL de Windows')
    def test_real_denial_on_an_existing_name_is_still_reported_as_denied(self):
        """Sin permiso para ver el nombre, la colisión no se presume."""
        target = self.folder / 'protegido.txt'
        target.write_bytes(b'ajeno')
        result = subprocess.run(['whoami', '/user', '/fo', 'csv', '/nh'], capture_output=True, text=True, check=True)
        sid = next(csv.reader(io.StringIO(result.stdout.strip())))[1]
        # Sin listar la carpeta ni leer atributos del archivo, NTFS no concede la consulta.
        subprocess.run(['icacls', str(self.folder), '/deny', f'*{sid}:(RD)'], capture_output=True, check=True)
        subprocess.run(['icacls', str(target), '/deny', f'*{sid}:(RA)'], capture_output=True, check=True)
        try:
            self.assert_code('ACCESS_DENIED', 'protegido.txt')
        finally:
            subprocess.run(['icacls', str(target), '/remove:d', f'*{sid}'], capture_output=True, check=True)
            subprocess.run(['icacls', str(self.folder), '/remove:d', f'*{sid}'], capture_output=True, check=True)
        self.assertEqual(target.read_bytes(), b'ajeno')
        self.assertEqual(self.names(), ['protegido.txt'])

    def test_never_enumerates_or_opens_other_content(self):
        backend = native.Windows if os.name == 'nt' else native.Posix
        (self.folder / 'vecino.txt').write_bytes(b'no abrir')
        child = backend.child
        opened = []

        def tracked(instance, parent, name, directory):
            opened.append(name)
            return child(instance, parent, name, directory)

        with mock.patch.object(backend, 'child', tracked), \
                mock.patch('os.listdir', side_effect=AssertionError('enumeración')), \
                mock.patch('os.scandir', side_effect=AssertionError('enumeración')):
            self.create()
        self.assertNotIn('vecino.txt', opened)
        self.assertEqual((self.folder / 'vecino.txt').read_bytes(), b'no abrir')

    def run_protocol(self, payload, answer=b'W'):
        line = json.dumps(payload).encode() + b'\n' + answer
        stdout, stderr = io.StringIO(), io.StringIO()
        with mock.patch.object(sys, 'stdin', mock.Mock(buffer=io.BytesIO(line))), \
                mock.patch.object(sys, 'stdout', stdout), \
                mock.patch.object(sys, 'stderr', stderr):
            code = native.run()
        return code, stdout.getvalue(), stderr.getvalue()

    def request(self, data, relative='nuevo.txt'):
        return {'root': str(self.folder), 'relativePath': relative, 'content': base64.b64encode(data).decode()}

    def test_protocol_creates_only_after_confirmation(self):
        code, out, err = self.run_protocol(self.request(b'confirmado'))
        self.assertEqual((code, err), (0, 'READY\n'))
        self.assertEqual(json.loads(out)['size'], len(b'confirmado'))
        code, out, err = self.run_protocol(self.request(b'x', 'otro.txt'), answer=b'')
        self.assertEqual((code, out, err), (1, '', 'READY\nCREATE_FAILED\n'))
        self.assertEqual(self.names(), ['nuevo.txt'])

    def test_protocol_rejects_invalid_text_before_touching_the_folder(self):
        for data, code in ((b'\xc3\x28', 'INVALID_TEXT'), (b'a\0b', 'INVALID_TEXT'),
                           (b'a' * (native.MAX_BYTES + 1), 'TEXT_TOO_LARGE')):
            self.assertEqual(self.run_protocol(self.request(data)), (1, '', f'{code}\n'))
        bad = self.request(b'x')
        bad['extra'] = True
        self.assertEqual(self.run_protocol(bad), (1, '', 'CREATE_FAILED\n'))
        self.assertEqual(self.names(), [])


if __name__ == '__main__':
    unittest.main(verbosity=2)
