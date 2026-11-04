import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fork, spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { readNative } from '../src/text-reader.js';
import { createNative } from '../src/text-creator.js';
import { modifyNative } from '../src/text-modifier.js';
import { runOrganizer } from '../src/organizer.js';

const python = process.env.MIND_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
const parentFixture = fileURLToPath(new URL('./fixtures/native_parent.mjs', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/native_lifetime.py', import.meta.url));
const testRoot = path.resolve(process.env.MIND_TEST_TMP ?? path.join(os.tmpdir(), 'mind-1.0.1-tests'));
const digest = (value) => createHash('sha256').update(value).digest('hex');

for (const helper of ['index', 'reader', 'extract', 'writer', 'modifier', 'organizer']) {
  test(`${helper} refuses a parent identity different from its actual parent`, async (t) => {
    const native = fileURLToPath(new URL(`../src/native_${helper}.py`, import.meta.url));
    const child = spawn(python, ['-I', '-B', native, '--parent-pid', '0'], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    t.after(() => child.kill());
    let output = '', diagnostic = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { diagnostic += chunk; });
    child.stdin.on('error', () => {});
    child.stdin.end('{}\n');
    const [code] = await once(child, 'close');
    assert.equal(code, 1);
    assert.equal(output, '');
    assert.equal(diagnostic.trim(), helper === 'index' ? 'SAFE_SCAN_PARENT_GONE' : 'SAFE_OPEN_UNAVAILABLE');
  });
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

async function gone(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (alive(pid) && Date.now() < deadline) await delay(50);
  assert.equal(alive(pid), false, `Owned helper ${pid} did not exit`);
}

async function temporary(t) {
  await fs.mkdir(testRoot, { recursive: true });
  const dir = await fs.mkdtemp(path.join(testRoot, 'native-lifetime-'));
  t.after(async () => {
    assert.equal(path.dirname(dir), testRoot);
    assert.ok(path.basename(dir).startsWith('native-lifetime-'));
    await fs.rm(dir, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(dir, 'ficticio.txt'), 'original ficticio');
  return dir;
}

async function killParent(t, helper, mode, request) {
  const native = fileURLToPath(new URL(`../src/native_${helper}.py`, import.meta.url));
  const parent = fork(parentFixture, [python, fixture, native, mode, JSON.stringify(request)], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true,
  });
  t.after(() => { if (parent.connected) parent.send('stop'); parent.kill(); });
  let stderr = '';
  parent.stderr.on('data', (chunk) => { stderr += chunk; });
  const message = await Promise.race([
    once(parent, 'message').then(([value]) => value),
    once(parent, 'exit').then(() => { throw new Error(`Parent exited: ${stderr}`); }),
    delay(10000, null, { ref: false }).then(() => { throw new Error(`Readiness timeout: ${stderr}`); }),
  ]);
  assert.equal(message.ready, true, JSON.stringify(message));
  assert.equal(alive(message.pid), true);
  const killedAt = Date.now();
  const exited = once(parent, 'exit');
  parent.kill('SIGKILL');
  await exited;
  await gone(message.pid, mode === 'confirmed-stall' ? 12000 : 5000);
  return { afterKillMs: Date.now() - killedAt, diagnostic: await fs.readFile(message.diagnosticFile, 'utf8') };
}

for (const helper of ['reader', 'extract']) {
  test(`parent death stops ${helper} blocked after acquiring the real descriptor`, async (t) => {
    const root = await temporary(t);
    await killParent(t, helper, 'blocked-read', {
      root, relativePath: 'ficticio.txt', ...(helper === 'extract' ? { format: 'docx' } : {}),
    });
    assert.equal(await fs.readFile(path.join(root, 'ficticio.txt'), 'utf8'), 'original ficticio');
  });
}

for (const helper of ['writer', 'modifier', 'organizer']) {
  test(`parent death before W exits ${helper} without changing original data`, async (t) => {
    const root = await temporary(t);
    const request = helper === 'organizer' ? { op: 'mkdir', root, relativePath: 'nueva' } : {
      root, relativePath: helper === 'writer' ? 'nuevo.txt' : 'ficticio.txt',
      content: Buffer.from('cambio ficticio').toString('base64'),
      ...(helper === 'modifier' ? { expected: digest('original ficticio') } : {}),
    };
    await killParent(t, helper, 'before-confirmation', request);
    assert.equal(await fs.readFile(path.join(root, 'ficticio.txt'), 'utf8'), 'original ficticio');
    assert.deepEqual(await fs.readdir(root), ['ficticio.txt']);
  });
  test(`parent death stops ${helper} blocked before reaching confirmation`, async (t) => {
    const root = await temporary(t);
    const request = helper === 'organizer' ? { op: 'mkdir', root, relativePath: 'nueva' } : {
      root, relativePath: helper === 'writer' ? 'nuevo.txt' : 'ficticio.txt',
      content: Buffer.from('cambio ficticio').toString('base64'),
      ...(helper === 'modifier' ? { expected: digest('original ficticio') } : {}),
    };
    await killParent(t, helper, 'blocked-before-confirmation', request);
    assert.equal(await fs.readFile(path.join(root, 'ficticio.txt'), 'utf8'), 'original ficticio');
    assert.deepEqual(await fs.readdir(root), ['ficticio.txt']);
  });
}

test('parent death after W allows an accepted atomic creation to finish', async (t) => {
  const root = await temporary(t);
  const outcome = await killParent(t, 'writer', 'confirmed-write', {
    root, relativePath: 'nuevo.txt', content: Buffer.from('aceptado ficticio').toString('base64'),
  });
  const content = await fs.readFile(path.join(root, 'nuevo.txt'), 'utf8').catch(error => `${error.code}: ${outcome.diagnostic}`);
  assert.equal(content, 'aceptado ficticio');
});

test('a confirmed write stalled after parent death still has a finite lifetime', async (t) => {
  const root = await temporary(t);
  const outcome = await killParent(t, 'writer', 'confirmed-stall', {
    root, relativePath: 'nuevo.txt', content: Buffer.from('aceptado ficticio').toString('base64'),
  });
  assert.ok(outcome.afterKillMs >= 9000, `Commit grace ended too early: ${outcome.afterKillMs} ms; ${outcome.diagnostic}`);
  assert.deepEqual(await fs.readdir(root), ['ficticio.txt']);
});

for (const operation of ['read', 'create', 'modify', 'organize']) {
  test(`expired ${operation} does not wait forever for confirmation or send it late`, { timeout: 20000 }, async (t) => {
    const root = await temporary(t);
    const entered = Promise.withResolvers();
    const confirmation = Promise.withResolvers();
    const confirm = () => { entered.resolve(); return confirmation.promise; };
    const options = { root, relativePath: 'ficticio.txt', pythonExecutable: python, confirm };
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const pending = operation === 'read' ? readNative(options)
      : operation === 'create' ? createNative({ ...options, relativePath: 'nuevo.txt', bytes: Buffer.from('ficticio') })
        : operation === 'modify' ? modifyNative({ ...options, expected: digest('original ficticio'), bytes: Buffer.from('ficticio') })
          : runOrganizer({ operation: 'mkdir', request: { op: 'mkdir', root, relativePath: 'nueva' }, pythonExecutable: python, confirm });
    const expected = { read: 'READ_FAILED', create: 'CREATE_FAILED', modify: 'MODIFY_FAILED', organize: 'CREATE_FOLDER_FAILED' };
    // Attach the rejection handler before advancing the deadline.
    const rejected = assert.rejects(pending, { code: expected[operation] });
    await Promise.race([entered.promise, rejected.then(() => { throw new Error('Helper closed before confirmation'); })]);
    t.mock.timers.tick(10000);
    await rejected;
    t.mock.timers.reset();
    confirmation.resolve();
    await delay(25);
    assert.equal(await fs.readFile(path.join(root, 'ficticio.txt'), 'utf8'), 'original ficticio');
    assert.deepEqual(await fs.readdir(root), ['ficticio.txt']);
  });
}
