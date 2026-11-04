import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const [python, fixture, native, mode, request] = process.argv.slice(2);
// Keep stderr alive independently of this parent. Killing a pipe's reader
// during print(..., flush=True) can otherwise abort the helper itself, which
// would make the parent-death guard tests pass for the wrong reason.
const diagnosticFile = path.join(path.resolve(process.env.MIND_TEST_TMP ?? path.dirname(JSON.parse(request).root)),
  `native-lifetime-${randomUUID()}.stderr.log`);
const diagnosticHandle = fs.openSync(diagnosticFile, 'wx');
const child = spawn(python, ['-I', '-B', fixture, native, mode, String(process.pid)], {
  // Exercise the Python guard itself, independently of libuv's automatic Job
  // cleanup. Production mutation launchers use the same detached flag.
  stdio: ['pipe', 'pipe', diagnosticHandle], windowsHide: true, detached: process.platform === 'win32',
});
fs.closeSync(diagnosticHandle);
let diagnostic = '';
let notified = false;
let confirmed = false;
child.stdin.on('error', () => {});
child.stdout.resume();
function inspect() {
  diagnostic = fs.readFileSync(diagnosticFile, 'utf8').replace(/\r\n/g, '\n');
  if (mode.startsWith('confirmed-') && !confirmed && diagnostic.includes('READY\n')) {
    confirmed = true;
    child.stdin.write('W');
  }
  const marker = mode.startsWith('blocked-') ? 'BLOCKED' : mode.startsWith('confirmed-') ? 'COMMITTING' : 'READY';
  if (!notified && diagnostic.includes(marker)) {
    notified = true;
    process.send({ ready: true, pid: child.pid, diagnosticFile });
  }
}
const poll = setInterval(inspect, 10);
child.once('error', (error) => process.send({ error: String(error) }));
child.once('close', (code) => {
  clearInterval(poll);
  inspect();
  if (!notified) process.send({ error: diagnostic, code });
});
child.stdin.write(`${request}\n`);
process.on('message', (message) => {
  if (message === 'stop') child.kill();
});
