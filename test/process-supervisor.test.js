import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fork, spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { scanFolder } from '../src/index-scan.js';
import { spawnSupervised, processDiagnostics, stopSupervisedProcesses } from '../src/process-supervisor.js';

const python = process.env.MIND_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
const native = fileURLToPath(new URL('../src/native_index.py', import.meta.url));
const sleeper = fileURLToPath(new URL('./fixtures/guarded_index_sleep.py', import.meta.url));
const parentFixture = fileURLToPath(new URL('./fixtures/index_parent.mjs', import.meta.url));
const testRoot = path.resolve(process.env.MIND_TEST_TMP ?? path.join(os.tmpdir(), 'mind-1.0.1-tests'));

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

async function gone(pid) {
  const deadline = Date.now() + 5000;
  while (alive(pid) && Date.now() < deadline) await delay(50);
  assert.equal(alive(pid), false, `Own helper ${pid} did not exit`);
}

async function ready(child) {
  let text = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('Helper did not become ready')); }, 10000);
    const data = (chunk) => { text += chunk; if (text.includes('READY')) { cleanup(); resolve(); } };
    const exit = (code) => { cleanup(); reject(new Error(`Helper exited before ready: ${code}`)); };
    function cleanup() { clearTimeout(timer); child.stdout.off('data', data); child.off('exit', exit); }
    child.stdout.on('data', data);
    child.once('exit', exit);
  });
}

async function temporary(t) {
  await fs.mkdir(testRoot, { recursive: true });
  const dir = await fs.mkdtemp(path.join(testRoot, 'lifecycle-'));
  t.after(async () => {
    assert.equal(path.dirname(dir), testRoot);
    assert.ok(path.basename(dir).startsWith('lifecycle-'));
    await fs.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

test('normal native scan exits and removes its active diagnostic record', async (t) => {
  const dir = await temporary(t);
  await fs.writeFile(path.join(dir, 'ficticio.txt'), 'dato ficticio');
  const result = await scanFolder(dir, { previous: [], maxEntries: 10, pythonExecutable: python });
  assert.deepEqual(result.entries.map((item) => item.path), ['ficticio.txt']);
  assert.equal(processDiagnostics().active.length, 0);
  const latest = processDiagnostics().recent.at(-1);
  assert.equal(latest.state, 'completed');
  assert.equal(latest.kind, 'index');
  await gone(latest.pid);
});

test('pre-cancelled scan creates no process; in-flight scan cancellation reaps its child', async (t) => {
  const dir = await temporary(t);
  const before = processDiagnostics().recent.length;
  await assert.rejects(scanFolder(dir, {
    previous: [], maxEntries: 10, pythonExecutable: python, signal: AbortSignal.abort(),
  }), { code: 'SCAN_CANCELLED' });
  assert.equal(processDiagnostics().recent.length, before);
  const controller = new AbortController();
  const pending = scanFolder(dir, { previous: [], maxEntries: 10, pythonExecutable: python, signal: controller.signal });
  const own = processDiagnostics().active.at(-1);
  assert.ok(own.pid);
  controller.abort();
  await assert.rejects(pending, { code: 'SCAN_CANCELLED' });
  await gone(own.pid);
  assert.equal(processDiagnostics().active.length, 0);
});

test('scan deadline rejects without a partial result and reaps the helper', async (t) => {
  const dir = await temporary(t);
  const pending = scanFolder(dir, { previous: [], maxEntries: 10, pythonExecutable: python, timeoutMs: 1 });
  const own = processDiagnostics().active.at(-1);
  await assert.rejects(pending, { code: 'SCAN_TIMEOUT' });
  await gone(own.pid);
});

test('cancelling a running blocked helper kills only its own child handle', async (t) => {
  const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  t.after(() => other.kill());
  const controller = new AbortController();
  const managed = spawnSupervised(python, ['-I', '-B', sleeper, native, String(process.pid)], { signal: controller.signal, kind: 'test', timeoutMs: 20000 });
  t.after(() => managed.stop());
  await ready(managed.child);
  controller.abort();
  const result = await managed.completed;
  assert.equal(result.error.code, 'PROCESS_CANCELLED');
  await gone(managed.child.pid);
  assert.equal(alive(other.pid), true);
});

test('deadline stops a helper blocked in a long operation', async (t) => {
  const managed = spawnSupervised(python, ['-I', '-B', sleeper, native, String(process.pid)], { kind: 'test', timeoutMs: 1500 });
  t.after(() => managed.stop());
  await ready(managed.child);
  const result = await managed.completed;
  assert.equal(result.error.code, 'PROCESS_TIMEOUT');
  await gone(managed.child.pid);
});

test('hard-killing the real parent terminates its blocked Python helper', async (t) => {
  const parent = fork(parentFixture, [python, sleeper, native], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
  let childPid;
  t.after(() => { if (parent.connected) parent.send('stop'); parent.kill(); });
  let stderr = '';
  parent.stderr.on('data', (chunk) => { stderr += chunk; });
  const message = await Promise.race([
    once(parent, 'message').then(([value]) => value),
    once(parent, 'exit').then(() => { throw new Error(`Parent exited: ${stderr}`); }),
    delay(10000, null, { ref: false }).then(() => { throw new Error(`Parent readiness timeout: ${stderr}`); }),
  ]);
  assert.equal(message.ready, true, JSON.stringify(message));
  childPid = message.pid;
  assert.equal(alive(childPid), true);
  // The helper has completed guard setup and is sleeping, not naturally exiting.
  await delay(300);
  assert.equal(alive(childPid), true);
  const exited = once(parent, 'exit');
  parent.kill('SIGKILL');
  await exited;
  await gone(childPid);
});

test('supervisor shutdown waits for its children to exit', async (t) => {
  const managed = spawnSupervised(python, ['-I', '-B', sleeper, native, String(process.pid)], { kind: 'shutdown-test', timeoutMs: 20000 });
  t.after(() => managed.stop());
  await ready(managed.child);
  await stopSupervisedProcesses({ kind: 'shutdown-test' });
  await gone(managed.child.pid);
  assert.equal(processDiagnostics().active.some((item) => item.id === managed.id), false);
});
