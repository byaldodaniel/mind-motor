import { spawnSync } from 'node:child_process';

const failed = [];

for (const [command, args] of [
  [process.execPath, ['--test', '--test-concurrency=1', 'test/*.test.js']],
  [process.platform === 'win32' ? 'python' : 'python3', ['-I', '-B', 'test/native_reader_test.py']],
  [process.platform === 'win32' ? 'python' : 'python3', ['-I', '-B', 'test/native_index_test.py']],
  [process.platform === 'win32' ? 'python' : 'python3', ['-I', '-B', 'test/native_writer_test.py']],
  [process.platform === 'win32' ? 'python' : 'python3', ['-I', '-B', 'test/native_extract_test.py']],
  [process.platform === 'win32' ? 'python' : 'python3', ['-I', '-B', 'test/native_organizer_test.py']],
  [process.platform === 'win32' ? 'python' : 'python3', ['-I', '-B', 'test/native_result_copy_test.py']],
]) {
  const result = spawnSync(command, args, { stdio: 'inherit', windowsHide: true, env:{...process.env,MIND_AGENT_STARTUP:'0'} });
  if (result.error) console.error(result.error.message);
  // Se ejecutan todas las suites aunque una falle, para ver todos los diagnósticos.
  if (result.status !== 0) failed.push(args.at(-1));
}
if (failed.length > 0) {
  console.error(`Suites con fallos: ${failed.join(', ')}`);
  process.exit(1);
}
