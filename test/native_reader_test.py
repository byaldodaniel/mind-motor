"""Pruebas de garantías del SO con datos ficticios, fuera del repositorio."""
import contextlib
import csv
import errno
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
spec = importlib.util.spec_from_file_location('native_reader', MOTOR / 'src' / 'native_reader.py')
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)


class ReaderTest(unittest.TestCase):
    def setUp(self):
        self.temp = Path(tempfile.mkdtemp(prefix='.mind-native-test-', dir=DEVELOPMENT))
        self.folder = self.temp / 'Información ficticia'
        self.outside = self.temp / 'ajena'
        self.folder.mkdir()
        self.outside.mkdir()
        (self.folder / 'texto.txt').write_bytes(b'permitido')
        (self.outside / 'texto.txt').write_bytes(b'SECRETO FICTICIO')

    def tearDown(self):
        self.assertEqual(self.temp.parent, DEVELOPMENT)
        self.assertTrue(self.temp.name.startswith('.mind-native-test-'))
        # Las pruebas no dejan enlaces de directorio en la limpieza recursiva.
        shutil.rmtree(self.temp)

    def link_dir(self, target, name):
        if os.name == 'nt':
            # Solo un enlace conocido dentro del temporal. No se usa cmd para borrar.
            result = subprocess.run(['cmd', '/c', 'mklink', '/J', str(name), str(target)], capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
        else:
            os.symlink(target, name, target_is_directory=True)

    def read(self, relative='texto.txt', barrier=None):
        fd = native.safe_open(str(self.folder), relative, barrier)
        with os.fdopen(fd, 'rb') as source:
            return source.read()

    def test_root_replaced_after_acquisition_uses_held_directory(self):
        moved = self.temp / 'raíz conservada'

        def barrier(stage):
            self.assertEqual(stage, 'root')
            self.folder.rename(moved)
            self.link_dir(self.outside, self.folder)

        try:
            self.assertEqual(self.read(barrier=barrier), b'permitido')
        finally:
            if self.folder.exists():
                os.rmdir(self.folder) if os.name == 'nt' else os.unlink(self.folder)

    def test_intermediate_replaced_after_acquisition_uses_held_directory(self):
        sub = self.folder / 'sub'
        sub.mkdir()
        (sub / 'texto.txt').write_bytes(b'interior conservado')

        def barrier(stage):
            if stage == 'sub':
                sub.rename(self.temp / 'sub conservada')
                self.link_dir(self.outside, sub)

        try:
            self.assertEqual(self.read('sub/texto.txt', barrier), b'interior conservado')
        finally:
            if sub.exists():
                os.rmdir(sub) if os.name == 'nt' else os.unlink(sub)

    def test_leaf_replaced_after_open_does_not_redirect_read(self):
        fd = native.safe_open(str(self.folder), 'texto.txt')
        try:
            original = self.folder / 'texto.txt'
            original.rename(self.temp / 'original conservado.txt')
            original.write_bytes(b'sustituto')
            self.assertEqual(os.read(fd, 4096), b'permitido')
        finally:
            os.close(fd)

    def test_leaf_removed_after_open_remains_readable_through_descriptor(self):
        fd = native.safe_open(str(self.folder), 'texto.txt')
        try:
            os.unlink(self.folder / 'texto.txt')
            self.assertEqual(os.read(fd, 4096), b'permitido')
        finally:
            os.close(fd)

    def test_leaf_disappears_before_open_reports_missing(self):
        def barrier(stage):
            os.unlink(self.folder / 'texto.txt')
        with self.assertRaises(FileNotFoundError) as failure:
            self.read(barrier=barrier)
        self.assertEqual(native.error_code(failure.exception), 'FILE_NOT_FOUND')

    def test_link_inserted_before_child_open_is_rejected(self):
        sub = self.folder / 'sub'
        sub.mkdir()

        def barrier(stage):
            if stage == 'root':
                sub.rmdir()
                self.link_dir(self.outside, sub)
        try:
            with self.assertRaises((OSError, native.Refusal)) as failure:
                self.read('sub/texto.txt', barrier)
            self.assertEqual(native.error_code(failure.exception), 'UNSAFE_PATH')
        finally:
            os.rmdir(sub) if os.name == 'nt' else os.unlink(sub)

    def test_opens_no_other_content_and_never_enumerates(self):
        backend = native.Windows if os.name == 'nt' else native.Posix
        child = backend.child
        content_names = []

        def tracked(instance, parent, name, directory):
            if not directory:
                content_names.append(name)
            return child(instance, parent, name, directory)

        with mock.patch.object(backend, 'child', tracked), \
                mock.patch('os.listdir', side_effect=AssertionError('enumeración')), \
                mock.patch('os.scandir', side_effect=AssertionError('enumeración')):
            self.assertEqual(self.read(), b'permitido')
        self.assertEqual(content_names, ['texto.txt'])

    def test_real_os_permission_denial(self):
        original = self.folder / 'texto.txt'
        if os.name == 'nt':
            result = subprocess.run(['whoami', '/user', '/fo', 'csv', '/nh'], capture_output=True, text=True, check=True)
            sid = next(csv.reader(io.StringIO(result.stdout.strip())))[1]
            subprocess.run(['icacls', str(original), '/deny', f'*{sid}:(RD)'], capture_output=True, check=True)
            restore = lambda: subprocess.run(['icacls', str(original), '/remove:d', f'*{sid}'], capture_output=True, check=True)
        else:
            original.chmod(0)
            restore = lambda: original.chmod(0o600)
        try:
            with self.assertRaises(PermissionError) as failure:
                self.read()
            self.assertEqual(native.error_code(failure.exception), 'ACCESS_DENIED')
        finally:
            restore()

    def test_leaf_link_and_posix_fifo_rejected_without_blocking(self):
        if os.name == 'nt':
            self.link_dir(self.outside, self.folder / 'enlace.txt')
        else:
            os.symlink(self.outside / 'texto.txt', self.folder / 'enlace.txt')
        try:
            with self.assertRaises((OSError, native.Refusal)) as failure:
                self.read('enlace.txt')
        finally:
            os.rmdir(self.folder / 'enlace.txt') if os.name == 'nt' else os.unlink(self.folder / 'enlace.txt')
        self.assertEqual(native.error_code(failure.exception), 'UNSAFE_PATH')
        if os.name != 'nt':
            os.mkfifo(self.folder / 'tubería')
            with self.assertRaises(native.Refusal):
                self.read('tubería')

    def test_read_failure_after_partial_bytes_returns_no_content(self):
        fd = native.safe_open(str(self.folder), 'texto.txt')
        source = mock.MagicMock()
        source.__enter__.return_value = source
        source.fileno.return_value = fd
        source.read.side_effect = [b'parcial', OSError(errno.EIO, 'fallo ficticio')]
        request = json.dumps({'root': str(self.folder), 'relativePath': 'texto.txt'}).encode() + b'\nR'
        stdout, stderr = io.BytesIO(), io.StringIO()
        try:
            with mock.patch.object(native, 'safe_open', return_value=fd), \
                    mock.patch('os.fdopen', return_value=source), \
                    mock.patch.object(sys, 'stdin', mock.Mock(buffer=io.BytesIO(request))), \
                    mock.patch.object(sys, 'stdout', mock.Mock(buffer=stdout)), \
                    mock.patch.object(sys, 'stderr', stderr):
                self.assertEqual(native.run(), 1)
            self.assertEqual(stdout.getvalue(), b'')
            self.assertEqual(stderr.getvalue(), 'READY\nREAD_FAILED\n')
        finally:
            os.close(fd)



@unittest.skipUnless(os.name == 'nt', 'comprobaciones de handle propias de Windows')
class ZeroLinksWindowsTest(unittest.TestCase):
    def backend(self, *, filesystem='FAT32', flags=0x106, volume=42, serial=42,
                links=0, standard_links=0, deleted=0, reparse=False,
                volume_ok=True, standard_ok=True, directory=False):
        backend=native.Windows()
        kernel=mock.Mock()
        def info(handle, pointer):
            pointer._obj.attributes=0x80 | (0x400 if reparse else 0)
            pointer._obj.links=links;pointer._obj.volume=volume
            return True
        def standard(handle, kind, pointer, size):
            pointer._obj.links=standard_links;pointer._obj.delete_pending=deleted
            pointer._obj.directory=directory
            return standard_ok
        def volume_info(handle,name,name_size,serial_pointer,maximum,flags_pointer,fsname,fs_size):
            serial_pointer._obj.value=serial;flags_pointer._obj.value=flags;fsname.value=filesystem
            return volume_ok
        kernel.GetFileInformationByHandle.side_effect=info
        kernel.GetFileInformationByHandleEx.side_effect=standard
        kernel.GetFileType.return_value=1
        backend.kernel=kernel;backend.volume_information=mock.Mock(side_effect=volume_info)
        return backend

    def test_exact_supported_zero_link_volume_is_accepted(self):
        self.assertEqual(self.backend().check(123,False),42)

    def test_ntfs_unknown_hardlinks_and_wrong_volume_are_refused(self):
        for config in [dict(filesystem='NTFS'),dict(filesystem='UNKNOWN'),dict(filesystem='exFAT'),
                       dict(flags=0x00400106),dict(serial=99),dict(volume_ok=False)]:
            with self.subTest(config=config),self.assertRaisesRegex(native.Refusal,'UNSAFE_PATH'):
                self.backend(**config).check(123,False)

    def test_multiple_links_reparse_and_deleted_objects_remain_refused(self):
        for config in [dict(links=2),dict(links=3),dict(reparse=True),dict(deleted=1),
                       dict(standard_links=1),dict(standard_ok=False),dict(directory=True)]:
            with self.subTest(config=config),self.assertRaisesRegex(native.Refusal,'UNSAFE_PATH'):
                self.backend(**config).check(123,False)

    def test_missing_volume_api_is_refused_but_single_link_does_not_need_it(self):
        backend=self.backend();backend.volume_information=None
        with self.assertRaisesRegex(native.Refusal,'UNSAFE_PATH'):
            backend.check(123,False)
        backend=self.backend(links=1);backend.volume_information=None
        self.assertEqual(backend.check(123,False),42)

if __name__ == '__main__':
    unittest.main(verbosity=2)
