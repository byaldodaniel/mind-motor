"""Garantías del SO para la modificación, con datos ficticios fuera del repositorio."""
import base64
import hashlib
import importlib.util
import io
import json
import os
import queue
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest import mock

MOTOR = Path(__file__).resolve().parents[1]
DEVELOPMENT = MOTOR.parent
spec = importlib.util.spec_from_file_location('native_modifier', MOTOR / 'src' / 'native_modifier.py')
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)


def digest(data):
    return hashlib.sha256(data).hexdigest()


class ModifierProcess:
    """Cada barrera se confirma por una tubería; no hay sleeps ni carreras probabilísticas."""
    def __init__(self, request, mode='normal'):
        self.process = subprocess.Popen(
            [sys.executable, '-I', '-B', str(MOTOR / 'test' / 'fixtures' / 'modifier_process.py'), mode],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding='utf-8')
        self.phases, self.output, self.diagnostics = queue.Queue(), [], []

        def stderr():
            for line in self.process.stderr:
                self.diagnostics.append(line)
                self.phases.put(json.loads(line))

        self.readers = [threading.Thread(target=stderr, daemon=True),
                        threading.Thread(target=lambda: self.output.append(self.process.stdout.read()), daemon=True)]
        for reader in self.readers:
            reader.start()
        self.process.stdin.write(json.dumps(request) + '\n')
        self.process.stdin.flush()

    def wait_for(self, phase):
        event = self.phases.get(timeout=10)
        if event['phase'] != phase or event['pid'] != self.process.pid:
            raise AssertionError(event)

    def release(self, command='go'):
        self.process.stdin.write(command + '\n')
        self.process.stdin.flush()

    def finish(self):
        self.process.stdin.close()
        self.process.wait(timeout=10)
        for reader in self.readers:
            reader.join(timeout=2)
        result = json.loads(''.join(self.output))
        if self.process.returncode != (0 if result['ok'] else 1):
            raise AssertionError((self.process.returncode, result, self.diagnostics))
        return result

    def close(self):
        if self.process.poll() is None:
            self.process.kill()
        self.process.wait(timeout=10)
        for reader in self.readers:
            reader.join(timeout=2)
        for stream in (self.process.stdin, self.process.stdout, self.process.stderr):
            if not stream.closed:
                stream.close()


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
        self.processes = []

    def tearDown(self):
        for process in self.processes:
            process.close()
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

    def worker(self, data=b'nuevo', mode='normal', expected=None):
        process = ModifierProcess(self.request(data, expected), mode)
        self.processes.append(process)
        return process

    def test_independent_processes_exclude_before_version_and_before_publish(self):
        for phase in ('before_read', 'verified', 'prepared'):
            with self.subTest(phase=phase):
                self.target.write_bytes(b'original')
                first = self.worker(b'primero', phase)
                first.wait_for(phase)
                second = self.worker(b'segundo')
                self.assertNotEqual(first.process.pid, second.process.pid)
                rejected = second.finish()
                self.assertFalse(rejected['ok'])
                self.assertEqual(rejected['code'], 'FILE_IN_USE')
                self.assertEqual(self.target.read_bytes(), b'original')
                first.release()
                published = first.finish()
                self.assertTrue(published['ok'])
                self.assertEqual(sum(result['ok'] for result in (published, rejected)), 1)
                self.assertEqual(self.target.read_bytes(), b'primero')
                self.assertEqual(self.names(), ['nota.txt'])

    @unittest.skipIf(os.name == 'nt', 'Windows adquiere la exclusión durante la apertura, no después.')
    def test_descriptor_opened_before_replacement_cannot_publish_after_lock_release(self):
        delayed = self.worker(b'obsoleto', 'opened')
        delayed.wait_for('opened')
        current = self.worker(b'primero')
        self.assertTrue(current.finish()['ok'])
        delayed.release()
        result = delayed.finish()
        self.assertFalse(result['ok'])
        self.assertEqual(result['code'], 'VERSION_CONFLICT')
        self.assertEqual(self.target.read_bytes(), b'primero')
        self.assertEqual(self.names(), ['nota.txt'])

    def test_old_version_conflicts_and_updated_versions_work_sequentially(self):
        self.assertTrue(self.worker(b'primero').finish()['ok'])
        stale = self.worker(b'obsoleto').finish()
        self.assertFalse(stale['ok'])
        self.assertEqual(stale['code'], 'VERSION_CONFLICT')
        self.assertEqual(self.target.read_bytes(), b'primero')
        self.assertTrue(self.worker(b'segundo', expected=digest(b'primero')).finish()['ok'])
        self.assertTrue(self.worker(b'tercero', expected=digest(b'segundo')).finish()['ok'])
        self.assertEqual(self.target.read_bytes(), b'tercero')
        self.assertEqual(self.names(), ['nota.txt'])

    def test_failure_and_cancellation_clean_temporaries_and_release_exclusion(self):
        for mode, command, code in (('fail', 'go', 'NO_SPACE'), ('prepared', 'cancel', 'MODIFY_FAILED')):
            with self.subTest(mode=mode):
                self.target.write_bytes(b'original')
                failing = self.worker(b'no publicar', mode)
                failing.wait_for('prepared')
                self.assertEqual(len([name for name in self.names() if name.startswith('.mind-modify-')]), 1)
                failing.release(command)
                result = failing.finish()
                self.assertFalse(result['ok'])
                self.assertEqual(result['code'], code)
                self.assertEqual(self.target.read_bytes(), b'original')
                self.assertEqual(self.names(), ['nota.txt'])
                self.assertTrue(self.worker(b'recuperado').finish()['ok'])
                self.assertEqual(self.target.read_bytes(), b'recuperado')

    def test_eof_or_process_termination_before_writing_releases_exclusion(self):
        for terminated in (False, True):
            with self.subTest(terminated=terminated):
                self.target.write_bytes(b'original')
                waiting = self.worker(b'no publicar', 'verified')
                waiting.wait_for('verified')
                if terminated:
                    waiting.close()
                else:
                    self.assertEqual(waiting.finish()['code'], 'MODIFY_FAILED')
                self.assertEqual(self.target.read_bytes(), b'original')
                self.assertEqual(self.names(), ['nota.txt'])
                self.assertTrue(self.worker(b'recuperado').finish()['ok'])

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



@unittest.skipUnless(os.name == 'nt', 'capacidades y metadatos de handles Windows')
class WindowsCapabilitiesTest(unittest.TestCase):
    def backend(self, capabilities=0x106, attributes=0x80):
        backend=native.Windows()
        info=backend.Info();info.volume=42;info.links=0;info.attributes=attributes;info.index_low=7
        backend._identity=mock.Mock(return_value=info)
        backend._fat32_no_hardlinks_flags=mock.Mock(return_value=capabilities)
        backend._single_stream=mock.Mock(return_value=True)
        backend._inherited_dacl_only=mock.Mock(return_value=True)
        backend.kernel=mock.Mock()
        backend.kernel.GetFileInformationByHandleEx.return_value=True
        return backend

    def test_ads_acl_queries_are_skipped_only_when_positive_capabilities_exclude_them(self):
        backend=self.backend();value=backend.inspect(123)
        self.assertTrue(value['zero_links_reported'])
        backend._single_stream.assert_not_called();backend._inherited_dacl_only.assert_not_called()
        for flags in [None,0x00040008]:
            with self.subTest(flags=flags):
                backend=self.backend(flags);backend.inspect(123)
                backend._single_stream.assert_called_once_with(123)
                backend._inherited_dacl_only.assert_called_once_with(123)

    def test_readonly_and_unsupported_metadata_stay_rejected(self):
        for attrs in [0x81,0x800]:
            with self.subTest(attributes=attrs),self.assertRaises(native.Refusal):
                self.backend(attributes=attrs).inspect(123)
        backend=self.backend(None);backend._single_stream.return_value=False
        with self.assertRaisesRegex(native.Refusal,'METADATA_NOT_PRESERVABLE'):
            backend.inspect(123)

    def test_zero_count_before_replacement_is_not_confirmation(self):
        backend=self.backend()
        self.assertFalse(backend.confirm_replaced(123,{'zero_links_reported':True}))

    def test_classic_fallback_never_runs_for_unknown_volume(self):
        for capabilities,zero in [(None,True),(0x106,False)]:
            with self.subTest(capabilities=capabilities,zero=zero):
                backend=self.backend(capabilities);backend._confirm_original_name=mock.Mock()
                backend.nt=mock.Mock();backend.nt.NtSetInformationFile.return_value=-1073741811
                with self.assertRaisesRegex(native.Refusal,'SAFE_OPEN_UNAVAILABLE'):
                    backend.publish(22,33,'temporary',11,'name.md',{'identity':(42,0,7),'zero_links_reported':zero})
                self.assertEqual(backend.nt.NtSetInformationFile.call_count,1)

    def test_classic_fallback_revalidates_original_name_after_extended_refusal(self):
        backend=self.backend();backend._delete_excluded_targets.add(11);backend.nt=mock.Mock();backend.nt.NtSetInformationFile.return_value=-1073741811
        backend._confirm_original_name=mock.Mock(side_effect=[None,native.Refusal('VERSION_CONFLICT')])
        with self.assertRaisesRegex(native.Refusal,'VERSION_CONFLICT'):
            backend.publish(22,33,'temporary',11,'name.md',{'identity':(42,0,7),'zero_links_reported':True,'delete_excluded':True})
        self.assertEqual(backend.nt.NtSetInformationFile.call_count,1)

    def test_classic_fallback_requires_final_identity_equal_temp_and_distinct_old(self):
        backend=self.backend();backend._nt=mock.Mock(return_value=55);backend.check=mock.Mock();backend.close=mock.Mock()
        def identity(index):
            value=backend.Info();value.volume=42;value.index_low=index;return value
        original={'identity':(42,0,7),'zero_links_reported':True,'classic_fallback':True,'delete_excluded':True}
        backend._delete_excluded_targets.add(11)
        backend._identity.side_effect=lambda handle: identity({11:7,22:8,55:9}[handle])
        self.assertFalse(backend.confirm_replaced(11,original,33,'name.md',22))
        backend._identity.side_effect=lambda handle: identity({11:7,22:8,55:8}[handle])
        self.assertTrue(backend.confirm_replaced(11,original,33,'name.md',22))

    def test_positive_target_capability_without_actual_delete_guard_refuses_classic(self):
        backend=self.backend();backend.nt=mock.Mock();backend.nt.NtSetInformationFile.return_value=-1073741811
        backend._confirm_original_name=mock.Mock()
        # El padre no permitió demostrar la capacidad al abrir: el handle no
        # consta en el conjunto con DELETE excluido, aunque luego el target sí.
        for declared in [False,True]:
            with self.subTest(declared=declared),self.assertRaisesRegex(native.Refusal,'SAFE_OPEN_UNAVAILABLE'):
                backend.publish(22,33,'temporary',11,'name.md',{'identity':(42,0,7),'zero_links_reported':True,'delete_excluded':declared})
        self.assertEqual(backend.nt.NtSetInformationFile.call_count,2)

    def test_closed_handle_does_not_keep_delete_guard_proof(self):
        backend=self.backend();backend._delete_excluded_targets.add(11)
        backend.close(11)
        self.assertNotIn(11,backend._delete_excluded_targets)
        backend.nt=mock.Mock();backend.nt.NtSetInformationFile.return_value=-1073741811
        backend._confirm_original_name=mock.Mock()
        # Un HANDLE numérico reutilizado no hereda la exclusión del anterior.
        with self.assertRaisesRegex(native.Refusal,'SAFE_OPEN_UNAVAILABLE'):
            backend.publish(22,33,'temporary',11,'name.md',{'identity':(42,0,7),'zero_links_reported':True,'delete_excluded':True})

if __name__ == '__main__':
    unittest.main(verbosity=2)
