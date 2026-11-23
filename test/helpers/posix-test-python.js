import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const skip = new Set(['site-packages', 'dist-packages', 'test', 'tests', '__pycache__']);

// Reproduce the POSIX layout of an installed package using real files.
// sys.executable can be a symlink under /usr/bin; its grandparent is not a Python distribution.
export async function copyPosixTestPython(executable, destination) {
  const { stdout } = await run(executable, ['-I', '-B', '-c', [
    'import json, sys, sysconfig',
    'print(json.dumps([sys.executable, sysconfig.get_path("stdlib"), sysconfig.get_config_var("LIBDIR"),',
    '    sysconfig.get_config_var("LDLIBRARY"), sysconfig.get_config_var("INSTSONAME")]))',
  ].join('\n')]);
  const [interpreter, stdlib, libdir, library, soname] = JSON.parse(stdout);
  const bin = path.join(destination, 'bin');
  const lib = path.join(destination, 'lib');
  await fs.mkdir(bin, { recursive: true });
  await fs.mkdir(lib, { recursive: true });
  await fs.copyFile(await fs.realpath(interpreter), path.join(bin, 'python3'));
  await fs.chmod(path.join(bin, 'python3'), 0o755);
  await fs.cp(stdlib, path.join(lib, path.basename(stdlib)), {
    recursive: true, dereference: true, filter: file => !skip.has(path.basename(file)),
  });
  for (const name of new Set([library, soname])) {
    if (!libdir || !name || name.endsWith('.a') || path.basename(name) !== name) continue;
    const source = path.join(libdir, name);
    const real = await fs.realpath(source).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (real) await fs.copyFile(real, path.join(lib, name));
  }
}
