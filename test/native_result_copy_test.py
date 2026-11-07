"""Pruebas de copia física por flujo; datos ficticios y directorios temporales."""
import importlib.util
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('result_copy',ROOT/'src'/'native_result_copy.py')
native=importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)

class CopyTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='mind-result-copy-')
        self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)
        self.source=self.root/'origen';self.target=self.root/'destino'
        self.source.mkdir();self.target.mkdir()
    def request(self,name='copia.bin'):
        return dict(sourceRoot=str(self.source),sourcePath='origen.bin',targetRoot=str(self.target),targetPath=name,maxBytes=4*1024**3)
    def test_binary_stream_hash_and_exclusive_publish(self):
        data=bytes(range(256))*12001
        (self.source/'origen.bin').write_bytes(data)
        copied=native.copy_result(self.request())
        self.assertEqual((self.target/'copia.bin').read_bytes(),data)
        self.assertEqual(copied['sha256'],hashlib.sha256(data).hexdigest())
        self.assertEqual(copied['size'],len(data))
        self.assertEqual(os.stat(self.target/'copia.bin').st_nlink,1)
        with self.assertRaisesRegex(native.Refusal,'FILE_EXISTS'):
            native.copy_result(self.request())
        self.assertEqual((self.source/'origen.bin').read_bytes(),data)
    def test_source_change_discards_unpublished_file(self):
        # Windows impide la escritura mientras copia; POSIX detecta el cambio.
        for iteration in range(20):
            with self.subTest(iteration=iteration):
                origin=self.source/'origen.bin'
                origin.write_bytes(b'original')
                if os.name=='nt':
                    blocked=[]
                    def mutate():
                        try:
                            origin.write_bytes(b'cambiado')
                        except PermissionError:
                            blocked.append(True)
                    copied=native.copy_result(self.request('copia-%d.bin'%iteration),before_finish=mutate)
                    self.assertEqual(blocked,[True])
                    self.assertEqual(copied['sha256'],hashlib.sha256(b'original').hexdigest())
                    self.assertEqual((self.target/('copia-%d.bin'%iteration)).read_bytes(),b'original')
                    origin.write_bytes(b'liberado')
                else:
                    with self.assertRaisesRegex(native.Refusal,'SOURCE_CHANGED'):
                        native.copy_result(self.request(),before_finish=lambda:origin.write_bytes(b'cambiado'))
                    self.assertEqual(list(self.target.iterdir()),[])
    @unittest.skipUnless(os.name=='nt','compartición de handles propia de Windows')
    def test_existing_writer_refuses_copy_before_publication(self):
        origin=self.source/'origen.bin'
        origin.write_bytes(b'original')
        with origin.open('r+b'):
            with self.assertRaises(PermissionError):
                native.copy_result(self.request())
        self.assertEqual(list(self.target.iterdir()),[])
    def test_link_source_and_parent_traversal_refused(self):
        (self.source/'origen.bin').write_bytes(b'data')
        os.link(self.source/'origen.bin',self.source/'otro.bin')
        with self.assertRaisesRegex(native.Refusal,'UNSAFE_PATH'):
            native.copy_result(self.request())
        (self.source/'otro.bin').unlink()
        request=self.request('../fuera.bin')
        with self.assertRaises(native.Refusal):
            native.copy_result(request)
        self.assertFalse((self.root/'fuera.bin').exists())
    def test_size_limit_does_not_create_output(self):
        (self.source/'origen.bin').write_bytes(b'1234')
        request=self.request();request['maxBytes']=3
        with self.assertRaisesRegex(native.Refusal,'FILE_TOO_LARGE'):
            native.copy_result(request)
        self.assertEqual(list(self.target.iterdir()),[])
    def test_does_not_read_or_create_before_confirmation(self):
        (self.source/'origen.bin').write_bytes(b'test')
        child=subprocess.Popen([sys.executable,'-I','-B',str(ROOT/'src'/'native_result_copy.py'),'--parent-pid',str(os.getpid())],
            stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        self.addCleanup(lambda: child.wait(timeout=5))
        self.addCleanup(lambda: child.kill() if child.poll() is None else None)
        self.addCleanup(child.stdin.close)
        self.addCleanup(child.stdout.close)
        self.addCleanup(child.stderr.close)
        child.stdin.write((json.dumps(self.request())+'\n').encode());child.stdin.flush()
        self.assertEqual(child.stderr.readline().rstrip(b'\r\n'),b'READY')
        self.assertEqual(list(self.target.iterdir()),[])
        child.stdin.write(b'N');child.stdin.flush();child.stdin.close()
        child.wait(timeout=5);self.assertNotEqual(child.returncode,0)
        self.assertEqual(list(self.target.iterdir()),[])
        child.stdout.close();child.stderr.close()

    def verify_request(self):
        return dict(verifyOnly=True,sourceRoot=str(self.source),sourcePath='origen.bin',maxBytes=4*1024**3)
    def test_verify_binary_without_copy(self):
        data=bytes(range(256))*12001
        (self.source/'origen.bin').write_bytes(data)
        confirmed=[]
        value=native.verify_result(self.verify_request(),confirm=lambda:confirmed.append(True))
        self.assertEqual(confirmed,[True])
        self.assertEqual(value,dict(size=len(data),sha256=hashlib.sha256(data).hexdigest()))
        self.assertEqual(list(self.target.iterdir()),[])
        self.assertEqual((self.source/'origen.bin').read_bytes(),data)
    def test_verify_rejects_links_and_limits(self):
        origin=self.source/'origen.bin';origin.write_bytes(b'1234')
        request=self.verify_request();request['maxBytes']=3
        with self.assertRaisesRegex(native.Refusal,'FILE_TOO_LARGE'):
            native.verify_result(request)
        os.link(origin,self.source/'enlace.bin')
        with self.assertRaisesRegex(native.Refusal,'UNSAFE_PATH'):
            native.verify_result(self.verify_request())
    def test_verify_detects_or_blocks_source_change(self):
        origin=self.source/'origen.bin';origin.write_bytes(b'original')
        if os.name=='nt':
            blocked=[]
            def mutate():
                try:
                    origin.write_bytes(b'cambiado')
                except PermissionError:
                    blocked.append(True)
            value=native.verify_result(self.verify_request(),before_finish=mutate)
            self.assertEqual(blocked,[True]);self.assertEqual(value['sha256'],hashlib.sha256(b'original').hexdigest())
            origin.write_bytes(b'liberado')
        else:
            with self.assertRaisesRegex(native.Refusal,'SOURCE_CHANGED'):
                native.verify_result(self.verify_request(),before_finish=lambda:origin.write_bytes(b'cambiado'))
    def test_verify_does_not_read_before_confirmation(self):
        (self.source/'origen.bin').write_bytes(b'test')
        child=subprocess.Popen([sys.executable,'-I','-B',str(ROOT/'src'/'native_result_copy.py'),'--parent-pid',str(os.getpid())],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        try:
            child.stdin.write((json.dumps(self.verify_request())+'\n').encode());child.stdin.flush()
            self.assertEqual(child.stderr.readline().rstrip(b'\r\n'),b'READY')
            child.stdin.write(b'N');child.stdin.close();child.wait(timeout=5)
            self.assertNotEqual(child.returncode,0);self.assertEqual(child.stdout.read(),b'')
        finally:
            if child.poll() is None:child.kill()
            child.wait(timeout=5)
            if not child.stdin.closed:child.stdin.close()
            child.stdout.close();child.stderr.close()

if __name__=='__main__':
    unittest.main()
