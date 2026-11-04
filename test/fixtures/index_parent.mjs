import { spawn } from 'node:child_process';

const [python, sleeper, native] = process.argv.slice(2);
const child = spawn(python, ['-I', '-B', sleeper, native, String(process.pid)], {
  // Bypass libuv's kill-on-parent-exit Job to test the native guard itself.
  stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform === 'win32',
});
child.stdout.on('data', (chunk) => {
  if (String(chunk).includes('READY')) process.send({ ready: true, pid: child.pid });
});
child.stderr.on('data', (chunk) => process.stderr.write(chunk));
child.on('error', (error) => { process.send({ error: String(error) }); process.exitCode = 1; });
process.on('message', (message) => {
  if (message === 'stop') child.kill();
});
