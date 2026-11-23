import { spawnSync } from 'node:child_process';
import { isAbsolute } from 'node:path';

const failed = [];
const python = process.env.MIND_TEST_BUNDLED_PYTHON || process.env.MIND_PYTHON ||
  (process.platform === 'win32' ? 'python' : 'python3');
const resolved = spawnSync(python, ['-I', '-B', '-c', 'import sys; print(sys.executable)'], {
  encoding: 'utf8', windowsHide: true,
});
const pythonExecutable = resolved.stdout?.trim();
if (resolved.status !== 0 || !pythonExecutable || !isAbsolute(pythonExecutable)) {
  console.error('No se pudo localizar el Python de pruebas:', python, resolved.error?.message ?? resolved.stderr);
  process.exit(1);
}
const testEnvironment = { ...process.env, MIND_AGENT_STARTUP: '0', MIND_TEST_BUNDLED_PYTHON: pythonExecutable,
  MIND_CATALOGO: process.env.MIND_CATALOGO ?? 'completo' };

for (const [command, args] of [
  [process.execPath, ['--test', '--test-concurrency=1', 'test/*.test.js']],
  [pythonExecutable, ['-I', '-B', 'test/native_reader_test.py']],
  [pythonExecutable, ['-I', '-B', 'test/native_index_test.py']],
  [pythonExecutable, ['-I', '-B', 'test/native_writer_test.py']],
  [pythonExecutable, ['-I', '-B', 'test/native_extract_test.py']],
  [pythonExecutable, ['-I', '-B', 'test/native_organizer_test.py']],
  [pythonExecutable, ['-I', '-B', 'test/native_result_copy_test.py']],
  // Sin ejecutable se valida el contrato de r3. Con él se incluyen las pruebas del Motor nativo.
  [process.execPath, ['--test', '--test-concurrency=1',
    process.env.MIND_NATIVE_EXE ? 'nativo/test/*.test.mjs' : 'nativo/test/contrato-r3.test.mjs']],
]) {
  // Las suites de r3 llaman a las operaciones por su nombre completo: corren con el
  // catálogo completo. El catálogo núcleo tiene sus pruebas (core-catalog) y su contrato.
  const result = spawnSync(command, args, { stdio: 'inherit', windowsHide: true, env: testEnvironment });
  if (result.error) console.error(result.error.message);
  // Se ejecutan todas las suites aunque una falle, para ver todos los diagnósticos.
  if (result.status !== 0) failed.push(args.at(-1));
}
if (failed.length > 0) {
  console.error(`Suites con fallos: ${failed.join(', ')}`);
  process.exit(1);
}
