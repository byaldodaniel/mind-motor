"""Copia binaria por descriptores, sin sobrescribir y sin cargar el archivo completo."""
import contextlib
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
_spec=importlib.util.spec_from_file_location('copy_writer',Path(__file__).with_name('native_writer.py'))
writer=importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(writer)
reader=writer.reader
Refusal=reader.Refusal

def copy_result(request, confirm=None, before_finish=None):
    keys={'sourceRoot','sourcePath','targetRoot','targetPath','maxBytes'}
    if not isinstance(request,dict) or set(request)!=keys:
        raise Refusal('COPY_FAILED')
    maximum=request['maxBytes']
    if not isinstance(maximum,int) or isinstance(maximum,bool) or maximum<0 or maximum>4*1024**3:
        raise Refusal('FILE_TOO_LARGE')
    with os.fdopen(reader.safe_open(request['sourceRoot'],request['sourcePath']),'rb',buffering=0) as source:
        before=os.fstat(source.fileno())
        if before.st_size>maximum:
            raise Refusal('FILE_TOO_LARGE')
        digest=hashlib.sha256()
        def transfer(backend,handle):
            total=0
            while True:
                chunk=source.read(1024*1024)
                if not chunk:
                    break
                total+=len(chunk)
                if total>maximum:
                    raise Refusal('FILE_TOO_LARGE')
                backend.write(handle,chunk,flush=False)
                digest.update(chunk)
            if before_finish:
                before_finish()
            after=os.fstat(source.fileno())
            fingerprint=lambda st:(st.st_dev,st.st_ino,st.st_size,st.st_mtime_ns,st.st_ctime_ns)
            if total!=before.st_size or fingerprint(before)!=fingerprint(after):
                raise Refusal('SOURCE_CHANGED')
            backend.flush(handle)
            return total
        result=writer.create_file(request['targetRoot'],request['targetPath'],b'',confirm=confirm,write_data=transfer)
        result['sha256']=digest.hexdigest()
        return result

def run():
    try:
        guard=reader.guard_parent()
        request=json.loads(sys.stdin.buffer.readline(32768))
        def confirm():
            sys.stderr.write('READY\n')
            sys.stderr.flush()
            if sys.stdin.buffer.read(1)!=b'W':
                raise Refusal('COPY_FAILED')
            guard.begin_commit(120)
        sys.stdout.write(json.dumps(copy_result(request,confirm=confirm)))
        return 0
    except Exception as error:
        sys.stderr.write(writer.error_code(error)+'\n')
        return 1

if __name__=='__main__':
    sys.exit(run())
