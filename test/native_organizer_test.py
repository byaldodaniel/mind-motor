"""Garantías del SO para organizar (carpetas, mover, papelera), con datos ficticios fuera del repositorio."""
import importlib.util
import os
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

MOTOR = Path(__file__).resolve().parents[1]
DEVELOPMENT = MOTOR.parent
spec = importlib.util.spec_from_file_location('native_organizer', MOTOR / 'src' / 'native_organizer.py')
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)
TRASH_ID = '20261102T000000Z-0123456789ab'


class PlatformImport(unittest.TestCase):
    def test_import_without_posix_flags_and_fail_closed(self):
        # Reproduce el conjunto de atributos de Windows sin fingir que sus
        # operaciones nativas se han ejecutado en un anfitrión POSIX.
        flags = ('O_DIRECTORY', 'O_NOFOLLOW', 'O_NONBLOCK', 'O_CLOEXEC')
        with patch.dict(os.__dict__):
            for name in flags:
                if hasattr(os, name):
                    delattr(os, name)
            spec = importlib.util.spec_from_file_location('organizer_without_posix', MOTOR / 'src' / 'native_organizer.py')
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            self.assertTrue(callable(module.Windows))
            with self.assertRaises(module.Refusal) as caught:
                module.Posix()
            self.assertEqual(str(caught.exception), 'SAFE_OPEN_UNAVAILABLE')


class Organizer(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix='.mind-organizer-test-', dir=DEVELOPMENT))
        self.data = self.root / 'Datos ñ'
        (self.data / 'a').mkdir(parents=True)
        (self.data / 'a' / 'x.txt').write_text('hola', encoding='utf-8')
        (self.data / 'b').mkdir()

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def test_mkdir_never_replaces(self):
        result = native.make_directory(str(self.data), 'nueva')
        self.assertEqual(result['type'], 'directory')
        self.assertTrue((self.data / 'nueva').is_dir())
        with self.assertRaises(native.Refusal) as caught:
            native.make_directory(str(self.data), 'nueva')
        self.assertEqual(str(caught.exception), 'FILE_EXISTS')
        with self.assertRaises(native.Refusal) as caught:
            native.make_directory(str(self.data), 'no/existe')
        self.assertEqual(str(caught.exception), 'PARENT_NOT_FOUND')

    def test_move_and_rename_without_replacing(self):
        result = native.move_entry(str(self.data), 'a/x.txt', 'b/y.txt')
        self.assertEqual(result['type'], 'file')
        self.assertEqual((self.data / 'b' / 'y.txt').read_text(encoding='utf-8'), 'hola')
        self.assertFalse((self.data / 'a' / 'x.txt').exists())
        (self.data / 'a' / 'z.txt').write_text('z', encoding='utf-8')
        with self.assertRaises(native.Refusal) as caught:
            native.move_entry(str(self.data), 'a/z.txt', 'b/y.txt')
        self.assertEqual(str(caught.exception), 'FILE_EXISTS')
        self.assertEqual((self.data / 'b' / 'y.txt').read_text(encoding='utf-8'), 'hola')
        native.move_entry(str(self.data), 'a', 'b/a renombrada')
        self.assertTrue((self.data / 'b' / 'a renombrada' / 'z.txt').exists())
        with self.assertRaises(native.Refusal):
            native.move_entry(str(self.data), 'b', 'b/dentro')

    def test_move_between_roots(self):
        other = self.root / 'Otra'
        other.mkdir()
        native.move_entry(str(self.data), 'a/x.txt', 'x.txt', target_root=str(other))
        self.assertEqual((other / 'x.txt').read_text(encoding='utf-8'), 'hola')

    def test_case_only_rename(self):
        native.move_entry(str(self.data), 'a/x.txt', 'a/X.txt')
        self.assertEqual(sorted(os.listdir(self.data / 'a')), ['X.txt'])

    def test_trash_restore_and_purge(self):
        result = native.trash_entry(str(self.data), 'a/x.txt', TRASH_ID)
        self.assertEqual(result['type'], 'file')
        self.assertEqual(len(result['sha256']), 64)
        self.assertTrue((self.data / '.papelera-mind' / TRASH_ID / 'x.txt').exists())
        self.assertFalse((self.data / 'a' / 'x.txt').exists())
        (self.data / 'a' / 'x.txt').write_text('ocupado', encoding='utf-8')
        restored = native.restore_entry(str(self.data), TRASH_ID, 'x.txt', ['a'], ['x.txt', 'x (restaurado).txt'])
        self.assertEqual(restored['name'], 'x (restaurado).txt')
        self.assertEqual((self.data / 'a' / 'x.txt').read_text(encoding='utf-8'), 'ocupado')
        native.trash_entry(str(self.data), 'a', TRASH_ID)
        removed = native.purge_entry(str(self.data), TRASH_ID)
        self.assertGreaterEqual(removed['removed'], 3)
        self.assertEqual(os.listdir(self.data / '.papelera-mind'), [])

    @unittest.skipIf(os.name == 'nt', 'enlaces simbólicos de POSIX')
    def test_links_are_refused(self):
        outside = self.root / 'fuera'
        outside.mkdir()
        os.symlink(outside, self.data / 'enlace')
        with self.assertRaises((native.Refusal, OSError)) as caught:
            native.move_entry(str(self.data), 'a/x.txt', 'enlace/x.txt')
        self.assertEqual(native.error_code(caught.exception), 'UNSAFE_PATH')
        self.assertEqual(os.listdir(outside), [])


if __name__ == '__main__':
    unittest.main()
