"""Exercise the production parent guard while the helper is blocked in a long operation."""
import importlib.util
import sys
import time

spec = importlib.util.spec_from_file_location('native_index', sys.argv[1])
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)
native.guard_parent(int(sys.argv[2]))
print('READY', flush=True)
time.sleep(60)
