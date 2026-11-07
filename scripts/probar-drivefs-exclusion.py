"""Prueba real y aislada de exclusión en DriveFS; no usa información personal."""
import contextlib
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import traceback
import uuid

ROOT=Path(__file__).resolve().parents[1]
PARENT=Path(r'G:\Mi unidad\Aldo Daniel\Mind\Data\Versiones')
fixture=PARENT/('Prueba exclusion DriveFS - '+str(uuid.uuid4()))
report_file=Path(sys.argv[1]);report={'resultado':'fallido'}
def load(name):
    spec=importlib.util.spec_from_file_location(name,ROOT/'src'/('native_'+name+'.py'));module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
writer=load('writer');modifier=load('modifier');copier=load('result_copy')
held=None
try:
    fixture.mkdir();initial=b'Original ficticio.';writer.create_file(str(fixture),'memoria.md',initial)
    # Otro proceso conserva acceso DELETE antes de la apertura del modificador.
    code="""import contextlib,importlib.util,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('modifier',Path(sys.argv[1])/'src'/'native_modifier.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
b=m.Windows()
with contextlib.ExitStack() as stack:
 parent,_=m.open_parent(b,stack,sys.argv[2],['memoria.md'])
 handle=b._nt(parent,'memoria.md',0x100000|0x10000|0x80,7,1,0x200020);stack.callback(b.close,handle)
 print('READY',flush=True);sys.stdin.buffer.read(1)
"""
    held=subprocess.Popen([sys.executable,'-I','-B','-c',code,str(ROOT),str(fixture)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    assert held.stdout.readline().strip()==b'READY'
    try:
        modifier.modify_file(str(fixture),'memoria.md',hashlib.sha256(initial).hexdigest(),b'No debe publicar.')
        raise AssertionError('No se rechazó el handle DELETE preexistente.')
    except OSError as error:
        assert getattr(error,'winerror',None) in (32,33)
        report['handle_DELETE_preexistente_otro_proceso']='rechazado antes de escribir'
    finally:
        held.stdin.write(b'X');held.stdin.flush();held.stdin.close();held.wait(timeout=10);held.stdout.close();held.stderr.close();held=None

    backend=modifier.Windows();call=backend.nt.NtSetInformationFile
    def tracked(handle,status,info,size,kind):
        if kind==10:
            # Barrera exacta: después de la última comprobación de identidad,
            # justo antes del reemplazo clásico. Un proceso ajeno intenta mover.
            swap="""import os,sys
try:os.rename(sys.argv[1],sys.argv[2])
except OSError as error:
 sys.exit(77 if getattr(error,'winerror',None) in (32,33) else 78)
sys.exit(0)
"""
            child=subprocess.run([sys.executable,'-I','-B','-c',swap,str(fixture/'memoria.md'),str(fixture/'apartada.md')],capture_output=True,timeout=10)
            assert child.returncode==77,'El intercambio concurrente no quedó bloqueado.'
            report['intercambio_tras_ultima_comprobacion']='bloqueado en otro proceso (WinError32/33)'
        result=call(handle,status,info,size,kind)
        report.setdefault('renombrados',[]).append({'clase':kind,'status':hex(result&0xffffffff)})
        return result
    backend.nt.NtSetInformationFile=tracked
    value=modifier.modify_file(str(fixture),'memoria.md',hashlib.sha256(initial).hexdigest(),b'Nuevo ficticio.',backend=backend)
    report['reemplazo_con_original_y_temporal_retenidos']=value
    check=copier.verify_result({'verifyOnly':True,'sourceRoot':str(fixture),'sourcePath':'memoria.md','maxBytes':1024})
    assert check['sha256']==hashlib.sha256(b'Nuevo ficticio.').hexdigest()
    with (fixture/'memoria.md').open('r+b'):
        try:
            copier.verify_result({'verifyOnly':True,'sourceRoot':str(fixture),'sourcePath':'memoria.md','maxBytes':1024})
            raise AssertionError('No se rechazó el escritor concurrente.')
        except OSError as error:
            assert getattr(error,'winerror',None) in (32,33)
            report['escritor_abierto']='rechazado por verificación/copias seguras'
    report['resultado']='superado'
except BaseException as error:report.update(error=str(error),stack=traceback.format_exc());sys.exitcode=1
finally:
    if held is not None:
        held.kill();held.wait(timeout=10)
        for stream in [held.stdin,held.stdout,held.stderr]:stream.close()
    if fixture.exists():
        assert fixture.resolve().parent==PARENT.resolve() and fixture.name.startswith('Prueba exclusion DriveFS - ')
        shutil.rmtree(fixture)
    report_file.write_text(json.dumps(report,indent=2),encoding='utf8');print(json.dumps(report));
if report['resultado']!='superado':sys.exit(1)
