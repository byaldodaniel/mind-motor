"""Exercise production run()/guard using real handles and deliberate I/O stalls."""
import importlib.util
import sys
import time

spec = importlib.util.spec_from_file_location('native_under_test', sys.argv[1])
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)
mode = sys.argv[2]

if mode == 'blocked-read':
    reader = getattr(native, 'reader', native)
    original_open = reader.safe_open

    def blocked_open(*args, **kwargs):
        descriptor = original_open(*args, **kwargs)
        print('BLOCKED', file=sys.stderr, flush=True)
        time.sleep(60)
        return descriptor

    reader.safe_open = blocked_open
elif mode in ('confirmed-write', 'confirmed-stall'):
    original_create = native.create_file

    def delayed_create(root, relative, data, confirm):
        def delayed_confirm():
            confirm()
            print('COMMITTING', file=sys.stderr, flush=True)
            time.sleep(60 if mode == 'confirmed-stall' else 0.75)
        return original_create(root, relative, data, delayed_confirm)

    native.create_file = delayed_create
elif mode == 'blocked-before-confirmation':
    # The production run installed its guard before invoking this operation.
    method = 'create_file' if hasattr(native, 'create_file') else 'modify_file' if hasattr(native, 'modify_file') else 'dispatch'
    original_operation = getattr(native, method)

    def blocked_operation(*args, **kwargs):
        print('BLOCKED', file=sys.stderr, flush=True)
        time.sleep(60)
        return original_operation(*args, **kwargs)

    setattr(native, method, blocked_operation)

sys.argv = [sys.argv[1], '--parent-pid', sys.argv[3]]
sys.exit(native.run())
