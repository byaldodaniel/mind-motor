"""Proceso auxiliar de pruebas; las barreras no existen en el protocolo productivo."""
import importlib.util
import json
import os
from pathlib import Path
import sys

spec = importlib.util.spec_from_file_location(
    'native_modifier', Path(__file__).resolve().parents[2] / 'src' / 'native_modifier.py')
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)


def checkpoint(phase):
    print(json.dumps({'phase': phase, 'pid': os.getpid()}), file=sys.stderr, flush=True)
    answer = sys.stdin.buffer.readline().strip()
    if answer == b'cancel':
        raise KeyboardInterrupt()
    if answer != b'go':
        raise native.Refusal('MODIFY_FAILED')


def main():
    mode = sys.argv[1]
    root, relative, expected, content = native.decode(json.loads(sys.stdin.buffer.readline()))
    backend_type = native.Windows if os.name == 'nt' else native.Posix

    class Backend(backend_type):
        def child(self, parent, name, directory):
            handle = super().child(parent, name, directory)
            if mode == 'opened' and not directory:
                try:
                    checkpoint('opened')
                except BaseException:
                    self.close(handle)
                    raise
            return handle

        def read(self, handle, *limit):
            if mode == 'before_read':
                checkpoint('before_read')
            return super().read(handle, *limit)

    def confirm():
        if mode == 'verified':
            checkpoint('verified')

    def before_publish(temporary):
        if mode in ('prepared', 'fail'):
            checkpoint('prepared')
        if mode == 'fail':
            raise OSError(28, 'sin espacio ficticio')

    try:
        metadata = native.modify_file(root, relative, expected, content, confirm=confirm,
                                      before_publish=before_publish, backend=Backend())
        print(json.dumps({'ok': True, 'pid': os.getpid(), 'metadata': metadata}), flush=True)
        return 0
    except BaseException as error:
        print(json.dumps({'ok': False, 'pid': os.getpid(), 'code': native.error_code(error)}), flush=True)
        return 1


if __name__ == '__main__':
    sys.exit(main())
