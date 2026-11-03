"""Pruebas del recorrido por referencias con datos ficticios, fuera del repositorio."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock

MOTOR = Path(__file__).resolve().parents[1]
DEVELOPMENT = MOTOR.parent
spec = importlib.util.spec_from_file_location('native_index', MOTOR / 'src' / 'native_index.py')
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)


def backend():
    return native.Windows() if os.name == 'nt' else native.Posix()


class CountingBackend:
    """Envuelve el backend real para contar referencias abiertas y cerradas."""

    def __init__(self, real):
        self.real, self.open, self.opened = real, 0, []

    def open_root(self, root):
        handle, volume = self.real.open_root(root)
        self.open += 1
        return handle, volume

    def open_child(self, parent, child):
        self.opened.append((child.name, child.type))
        handle = self.real.open_child(parent, child)
        self.open += 1
        return handle

    def children(self, handle, volume):
        return self.real.children(handle, volume)

    def close(self, handle):
        self.open -= 1
        self.real.close(handle)


class ScanTest(unittest.TestCase):
    def setUp(self):
        self.temp = Path(tempfile.mkdtemp(prefix='.mind-native-index-test-', dir=DEVELOPMENT)).resolve()
        self.folder = self.temp / 'Información ficticia'
        self.outside = self.temp / 'ajena'
        (self.folder / 'Proyectos' / 'Fotos').mkdir(parents=True)
        (self.folder / 'notas.txt').write_bytes(b'notas')
        (self.folder / 'Proyectos' / 'plan.md').write_bytes(b'plan')
        (self.folder / 'Proyectos' / 'Fotos' / 'foto.txt').write_bytes(b'foto')
        (self.outside / 'Proyectos' / 'Fotos').mkdir(parents=True)
        (self.outside / 'ajeno-raiz.txt').write_bytes(b'ajeno')
        (self.outside / 'Proyectos' / 'ajeno-intermedio.txt').write_bytes(b'ajeno')
        (self.outside / 'Proyectos' / 'Fotos' / 'ajeno-hoja.txt').write_bytes(b'ajeno')
        (self.outside / 'Fotos').mkdir()
        (self.outside / 'Fotos' / 'ajeno-hoja.txt').write_bytes(b'ajeno')
        self.expected = ['Proyectos', 'Proyectos/Fotos', 'Proyectos/Fotos/foto.txt',
                         'Proyectos/plan.md', 'notas.txt']

    def tearDown(self):
        self.assertEqual(self.temp.parent, DEVELOPMENT)
        self.assertTrue(self.temp.name.startswith('.mind-native-index-test-'))
        shutil.rmtree(self.temp)

    def link_dir(self, target, name):
        if os.name == 'nt':
            result = subprocess.run(['cmd', '/c', 'mklink', '/J', str(name), str(target)], capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
        else:
            os.symlink(target, name, target_is_directory=True)

    def scan(self, barrier=None, max_entries=100, using=None):
        counting = CountingBackend(using or backend())
        records, issues = native.scan(str(self.folder), max_entries, counting, barrier)
        self.assertEqual(counting.open, 0, 'Todas las referencias se cierran')
        self.counting = counting
        return {record['path']: record for record in records}, issues

    def assertNoForeignNames(self, records):
        self.assertFalse([name for name in records if 'ajeno' in name])

    def test_lists_metadata_and_opens_only_directories(self):
        records, issues = self.scan()
        self.assertEqual(sorted(records), self.expected)
        self.assertEqual(issues, [])
        self.assertEqual(records['notas.txt']['type'], 'file')
        self.assertEqual(records['notas.txt']['size'], 5)
        self.assertIsNone(records['Proyectos']['size'])
        self.assertEqual(self.counting.opened, [('Proyectos', 'directory'), ('Fotos', 'directory')])

    def test_excluded_paths_are_neither_listed_nor_opened(self):
        counting = CountingBackend(backend())
        records, issues = native.scan(str(self.folder), 100, counting, exclude=['Proyectos/Fotos', 'notas.txt'])
        self.assertEqual(counting.open, 0)
        self.assertEqual(sorted(record['path'] for record in records), ['Proyectos', 'Proyectos/plan.md'])
        self.assertEqual(issues, [])
        # La carpeta excluida no se abre: ningún nombre de su interior llega a leerse.
        self.assertEqual(counting.opened, [('Proyectos', 'directory')])
        records, _ = native.scan(str(self.folder), 100, exclude=['PROYECTOS'])
        expected = ['notas.txt'] if native.FOLD_CASE else self.expected
        self.assertEqual(sorted(record['path'] for record in records), expected)

    def test_every_native_open_requests_a_directory_without_following_links(self):
        if os.name == 'nt':
            real = backend()
            options = []
            create = real.nt.NtCreateFile

            def recording(*args):
                options.append(args[8])
                return create(*args)

            real.nt = types.SimpleNamespace(NtCreateFile=recording,
                                            RtlNtStatusToDosError=real.nt.RtlNtStatusToDosError)
            self.scan(using=real)
            # FILE_DIRECTORY_FILE y FILE_OPEN_REPARSE_POINT en cada apertura.
            self.assertTrue(options and all(value & 0x200001 == 0x200001 for value in options))
        else:
            # El backend se crea antes de sustituir os.open: con una función que no
            # admite dir_fd, el recorrido se deniega (SAFE_SCAN_UNAVAILABLE).
            real = backend()
            flags = []
            original = os.open

            def recording(path, flag, *args, **kwargs):
                flags.append(flag)
                return original(path, flag, *args, **kwargs)

            with mock.patch.object(native.os, 'open', recording):
                self.scan(using=real)
            self.assertTrue(flags and all(flag & os.O_DIRECTORY and flag & os.O_NOFOLLOW for flag in flags))

    def test_root_replaced_after_acquisition_keeps_scanning_held_directory(self):
        moved = self.temp / 'raíz conservada'

        def barrier(relative):
            if relative == 'Proyectos':
                self.folder.rename(moved)
                self.link_dir(self.outside, self.folder)

        records, _ = self.scan(barrier)
        self.assertEqual(sorted(records), self.expected)
        self.assertNoForeignNames(records)

    def test_intermediate_replaced_after_acquisition_keeps_scanning_held_directory(self):
        projects = self.folder / 'Proyectos'

        def barrier(relative):
            if relative == 'Proyectos/Fotos':
                projects.rename(self.temp / 'Proyectos conservados')
                self.link_dir(self.outside / 'Proyectos', projects)

        records, _ = self.scan(barrier)
        self.assertEqual(sorted(records), self.expected)
        self.assertNoForeignNames(records)

    def test_child_replaced_by_link_before_open_is_not_listed(self):
        projects = self.folder / 'Proyectos'

        def barrier(relative):
            if relative == 'Proyectos':
                projects.rename(self.temp / 'Proyectos movidos')
                self.link_dir(self.outside, projects)

        records, _ = self.scan(barrier)
        self.assertEqual(sorted(records), ['Proyectos', 'notas.txt'])
        self.assertEqual(records['Proyectos']['listing'], 'ECHANGED')
        self.assertNoForeignNames(records)

    def test_child_replaced_by_another_directory_is_not_listed(self):
        if os.name == 'nt':
            self.skipTest('La identidad por inode se comprueba en POSIX; en Windows rige el handle relativo.')
        photos = self.folder / 'Proyectos' / 'Fotos'

        def barrier(relative):
            if relative == 'Proyectos/Fotos':
                photos.rename(self.temp / 'Fotos movidas')
                photos.mkdir()
                (photos / 'ajeno-sustituto.txt').write_bytes(b'ajeno')

        records, _ = self.scan(barrier)
        self.assertEqual(records['Proyectos/Fotos']['listing'], 'ECHANGED')
        self.assertNoForeignNames(records)

    def test_child_that_disappears_before_open_is_omitted(self):
        def barrier(relative):
            if relative == 'Proyectos/Fotos':
                shutil.rmtree(self.folder / 'Proyectos' / 'Fotos')

        records, _ = self.scan(barrier)
        self.assertEqual(sorted(records), ['Proyectos', 'Proyectos/plan.md', 'notas.txt'])

    def test_other_volume_is_not_opened(self):
        real = backend()
        if os.name == 'nt':
            original = real._open

            def other_volume(parent, name, access):
                handle, volume = original(parent, name, access)
                return handle, volume + 1 if name == 'Proyectos' else volume

            real._open = other_volume
        else:
            original = os.stat

            def other_volume(name, *args, **kwargs):
                info = original(name, *args, **kwargs)
                if name != 'Proyectos':
                    return info
                fields = {field: getattr(info, field) for field in dir(info) if field.startswith('st_')}
                return types.SimpleNamespace(**{**fields, 'st_dev': info.st_dev + 1})

            patcher = mock.patch.object(native.os, 'stat', other_volume)
            patcher.start()
            self.addCleanup(patcher.stop)
        records, _ = self.scan(using=real)
        self.assertEqual(sorted(records), ['Proyectos', 'notas.txt'])
        self.assertEqual(records['Proyectos']['listing'], 'OTHER_VOLUME')

    def test_names_that_are_not_valid_utf8_are_reported_without_a_path(self):
        try:
            if os.name == 'nt':
                (self.folder / 'roto\ud800.txt').write_bytes(b'')
            else:
                with open(os.path.join(os.fsencode(self.folder), b'roto\xff.txt'), 'wb'):
                    pass
        except (OSError, UnicodeError):
            self.skipTest('El sistema de archivos no admite nombres fuera de UTF-8.')
        records, issues = self.scan()
        self.assertEqual(sorted(records), self.expected)
        self.assertEqual(issues, [{'path': '', 'code': 'NAME_NOT_UTF8'}])

    def test_limit_is_enforced_and_references_are_closed(self):
        counting = CountingBackend(backend())
        with self.assertRaises(native.Refusal) as failure:
            native.scan(str(self.folder), 3, counting)
        self.assertEqual(str(failure.exception), 'INDEX_LIMIT_EXCEEDED')
        self.assertEqual(counting.open, 0)

    def test_root_link_or_absence_is_a_scope_error(self):
        moved = self.temp / 'movida'
        self.folder.rename(moved)
        with self.assertRaises(native.ScopeError) as failure:
            native.scan(str(self.folder), 100)
        self.assertEqual(str(failure.exception), 'SCOPE_UNAVAILABLE')
        self.link_dir(moved, self.folder)
        with self.assertRaises(native.ScopeError) as failure:
            native.scan(str(self.folder), 100)
        self.assertEqual(str(failure.exception), 'SCOPE_CHANGED')
        if os.name == 'nt':
            os.rmdir(self.folder)
        else:
            os.unlink(self.folder)

    def test_protocol_returns_json_or_a_stable_code(self):
        def run(root):
            return subprocess.run([sys.executable, '-I', '-B', str(MOTOR / 'src' / 'native_index.py')],
                                  input=json.dumps({'root': root, 'maxEntries': 100}).encode() + b'\n',
                                  capture_output=True, timeout=30)

        result = run(str(self.folder))
        self.assertEqual(result.returncode, 0, result.stderr)
        output = json.loads(result.stdout)
        self.assertEqual(sorted(record['path'] for record in output['records']), self.expected)
        missing = run(str(self.temp / 'inexistente'))
        self.assertEqual((missing.returncode, missing.stderr.strip()), (1, b'SCOPE_UNAVAILABLE'))


if __name__ == '__main__':
    unittest.main()
