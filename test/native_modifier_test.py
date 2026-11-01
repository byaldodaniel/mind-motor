"""Garantías del SO para la modificación, con datos ficticios fuera del repositorio."""
import base64
import hashlib
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
spec = importlib.util.spec_from_file_location('native_modifier', MOTOR / 'src' / 'native_modifier.py')
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)


def digest(data):
    return hashlib.sha256(data).hexdigest()


class ModifierTest(unittest.TestCase):
    def setUp(self):
        self.temp = Path(tempfile.mkdtemp(prefix='.mind-native-modify-test-', dir=DEVELOPMENT))
        self.folder = self.temp / 'Información ficticia'
        self.outside = self.temp / 'ajena'
        self.folder.mkdir()
        self.outside.mkdir()
        self.target = self.folder / 'nota.txt'
        self.target.write_bytes(b'original')
        (self.outside / 'nota.txt').write_bytes(b'SECRETO FICTICIO')

    def tearDown(self):
        self.assertEqual(self.temp.parent, DEVELOPMENT)
        self.assertTrue(self.temp.name.startswith('.mind-native-modify-test-'))
        shutil.rmtree(self.temp)

    def link_dir(self, target, name):
        if os.name == 'nt':
            result = subprocess.run(['cmd', '/c', 'mklink', '/J', str(name), str(target)], capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
        else:
            os.symlink(target, name, target_is_directory=True)

    def unlink_dir(self, name):
        os.rmdir(name) if os.name == 'nt' else os.unlink(name)

    def modify(self, data=b'nuevo', relative='nota.txt', expected=None, **barriers):
        return native.modify_file(str(self.folder), relative, expected or digest(b'original'), data, **barriers)

    def assert_code(self, code, **arguments):
        with self.assertRaises((OSError, native.Refusal)) as failure:
            self.modify(**arguments)
        self.assertEqual(native.error_code(failure.exception), code)

    def names(self, directory=None):
        return sorted(os.listdir(directory or self.folder))

    def test_replaces_content_atomically_without_temporaries(self):
        result = self.modify('café 🧠\r\n'.encode())
        self.assertEqual(self.target.read_bytes(), 'café 🧠\r\n'.encode())
        self.assertEqual(result['size'], len('café 🧠\r\n'.encode()))
        self.assertEqual(self.names(), ['nota.txt'])
        self.assertEqual(self.names(self.outside), ['nota.txt'])

    def test_version_mismatch_never_writes(self):
        self.assert_code('VERSION_CONFLICT', expected=digest(b'otra'))
        self.assertEqual(self.target.read_bytes(), b'original')
        self.assertEqual(self.names(), ['nota.txt'])

    def test_file_swapped_before_publish_is_not_overwritten(self):
        def swap(temporary):
            self.assertTrue(temporary.startswith('.mind-modify-'))
            self.target.rename(self.folder / 'movido.txt')
            self.target.write_bytes(b'original')  # Mismo contenido, otro archivo.

        self.assert_code('VERSION_CONFLICT', before_publish=swap)
        self.assertEqual(self.target.read_bytes(), b'original')
        self.assertEqual(self.names(), ['movido.txt', 'nota.txt'])

    def test_target_removed_before_publish_is_not_recreated(self):
        self.assert_code('VERSION_CONFLICT', before_publish=lambda temporary: self.target.unlink())
        self.assertEqual(self.names(), [])

    def test_concurrent_write_is_blocked_or_detected(self):
        def intrude(temporary):
            try:
                with open(self.target, 'ab') as handle:
                    handle.write(b' ajeno')
                self.intruded = True
            except PermissionError:
                self.intruded = False

        if os.name == 'nt':
            # Windows: el handle sin FILE_SHARE_WRITE impide escribir; la publicación sigue.
            self.modify(before_publish=intrude)
            self.assertFalse(self.intruded)
            self.assertEqual(self.target.read_bytes(), b'nuevo')
        else:
            # POSIX: no hay bloqueo obligatorio; el cambio se detecta y no se sobrescribe.
            self.assert_code('VERSION_CONFLICT', before_publish=intrude)
            self.assertTrue(self.intruded)
            self.assertEqual(self.target.read_bytes(), b'original ajeno')
        self.assertEqual(self.names(), ['nota.txt'])

    def test_failure_before_publish_keeps_original_and_discards_temporary(self):
        with self.assertRaises(OSError):
            self.modify(before_publish=lambda temporary: (_ for _ in ()).throw(OSError(5, 'fallo ficticio')))
        backend = native.Windows if os.name == 'nt' else native.Posix
        with mock.patch.object(backend, 'write', side_effect=OSError(28, 'sin espacio')):
            self.assert_code('NO_SPACE')
        self.assertEqual(self.target.read_bytes(), b'original')
        self.assertEqual(self.names(), ['nota.txt'])

    def test_root_replaced_after_acquisition_modifies_held_directory(self):
        moved = self.temp / 'raíz conservada'

        def barrier(stage):
            self.assertEqual(stage, 'root')
            self.folder.rename(moved)
            self.link_dir(self.outside, self.folder)

        try:
            self.modify(after_directory=barrier)
        finally:
            self.unlink_dir(self.folder)
        self.assertEqual((moved / 'nota.txt').read_bytes(), b'nuevo')
        self.assertEqual((self.outside / 'nota.txt').read_bytes(), b'SECRETO FICTICIO')

    def test_link_inserted_before_child_open_is_rejected(self):
        sub = self.folder / 'sub'
        sub.mkdir()
        (sub / 'nota.txt').write_bytes(b'original')

        def barrier(stage):
            if stage == 'root':
                sub.rename(self.temp / 'sub apartada')
                self.link_dir(self.outside, sub)

        try:
            self.assert_code('UNSAFE_PATH', relative='sub/nota.txt', after_directory=barrier)
        finally:
            self.unlink_dir(sub)
        self.assertEqual((self.outside / 'nota.txt').read_bytes(), b'SECRETO FICTICIO')

    def test_never_enumerates_or_opens_other_content(self):
        (self.folder / 'vecino.txt').write_bytes(b'no abrir')
        with mock.patch('os.listdir', side_effect=AssertionError('enumeración')), \
                mock.patch('os.scandir', side_effect=AssertionError('enumeración')):
            self.modify()
        self.assertEqual((self.folder / 'vecino.txt').read_bytes(), b'no abrir')

    def run_protocol(self, payload, answer=b'W'):
        line = json.dumps(payload).encode() + b'\n' + answer
        stdout, stderr = io.StringIO(), io.StringIO()
        with mock.patch.object(sys, 'stdin', mock.Mock(buffer=io.BytesIO(line))), \
                mock.patch.object(sys, 'stdout', stdout), \
                mock.patch.object(sys, 'stderr', stderr):
            code = native.run()
        return code, stdout.getvalue(), stderr.getvalue()

    def request(self, data, expected=None):
        return {'root': str(self.folder), 'relativePath': 'nota.txt',
                'expected': expected or digest(b'original'), 'content': base64.b64encode(data).decode()}

    def test_protocol_writes_only_after_confirmation(self):
        self.assertEqual(self.run_protocol(self.request(b'x'), answer=b''), (1, '', 'READY\nMODIFY_FAILED\n'))
        self.assertEqual(self.target.read_bytes(), b'original')
        code, out, err = self.run_protocol(self.request(b'confirmado'))
        self.assertEqual((code, err), (0, 'READY\n'))
        self.assertEqual(json.loads(out)['size'], len(b'confirmado'))
        self.assertEqual(self.target.read_bytes(), b'confirmado')

    def test_protocol_rejects_invalid_requests_before_opening(self):
        for data, code in ((b'\xc3\x28', 'INVALID_TEXT'), (b'a\0b', 'INVALID_TEXT'),
                           (b'a' * (native.MAX_BYTES + 1), 'TEXT_TOO_LARGE')):
            self.assertEqual(self.run_protocol(self.request(data)), (1, '', f'{code}\n'))
        self.assertEqual(self.run_protocol(self.request(b'x', 'A' * 64)), (1, '', 'MODIFY_FAILED\n'))
        self.assertEqual(self.target.read_bytes(), b'original')


if __name__ == '__main__':
    unittest.main(verbosity=2)
