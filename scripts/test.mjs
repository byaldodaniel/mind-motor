import { spawnSync } from 'node:child_process';

for (const [command, args] of [
  [process.execPath, ['--test', 'test/*.test.js']],
  [process.platform === 'win32' ? 'python' : 'python3', ['-I', '-B', 'test/native_reader_test.py']],
  [process.platform === 'win32' ? 'python' : 'python3', ['-I', '-B', 'test/native_index_test.py']],
  [process.platform === 'win32' ? 'python' : 'python3', ['-I', '-B', 'test/native_writer_test.py']],
  [process.platform === 'win32' ? 'python' : 'python3', ['-I', '-B', 'test/native_extract_test.py']],
  [process.platform === 'win32' ? 'python' : 'python3', ['-I', '-B', 'test/native_organizer_test.py']],
]) {
  const result = spawnSync(command, args, { stdio: 'inherit', windowsHide: true });
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) process.exit(result.status ?? 1);
}
