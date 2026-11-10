import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  identifyCurrentProcess, probeProcesses, inspectProcessOwners,
  acquireOwnerFileLock, recoverAbandonedOwnerFile,
} from '../src/process-identity.js';
import { liveSessions } from '../src/session.js';

const host = os.hostname();
const pid = 424242;
const legacy = { version: 1, pid, host, startedAt: '2020-01-01T00:00:00.000Z' };
const present = { pid, status: 'present', processBirth: 'opaque:new',
  processStartedAt: Date.parse('2026-01-01T00:00:00Z'), executable: '/usr/bin/node' };
const inspect = (records, observation) => inspectProcessOwners(records, { probe: async () => [observation] });

test('native birth differentiates a reused PID from an active or paused process', async () => {
  const result = await inspect([{ ...legacy, version: 2, processBirth: 'opaque:old' },
    { ...legacy, version: 2, processBirth: 'opaque:new' }], present);
  assert.deepEqual(result.map(x => [x.state, x.reason]), [['stale', 'pid-reused'], ['active', 'same-process']]);
});

test('legacy PID reuse needs both newer birth and incompatible process; clock alone never evicts Mind', async () => {
  assert.equal((await inspect([legacy], present))[0].state, 'active');
  assert.equal((await inspect([legacy], { ...present, executable: 'C:\\Apps\\Chrome\\chrome.exe' }))[0].reason, 'legacy-pid-reused');
  assert.equal((await inspect([legacy], { ...present, executable: 'C:\\Apps\\Chrome\\chrome.exe',
    processStartedAt: Date.parse(legacy.startedAt) + 1000 }))[0].state, 'unknown');
  assert.equal((await inspect([legacy], { ...present, executable: null }))[0].state, 'unknown');
});

test('missing processes are stale; permission, another host and malformed records remain unknown', async () => {
  assert.equal((await inspect([legacy], { pid, status: 'missing' }))[0].reason, 'process-exited');
  assert.equal((await inspect([legacy], { pid, status: 'unknown', reason: 'access-denied' }))[0].state, 'unknown');
  const owners = await inspectProcessOwners([{ ...legacy, host: 'another-' + host }, { bad: true }], {
    probe: async () => { throw new Error('not authorized'); },
  });
  assert.deepEqual(owners.map(x => x.state), ['unknown', 'unknown']);
});

test('native probe observes own birth and a real child ending, without killing any stored PID', async t => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},4000)'], { windowsHide: true, stdio: 'ignore' });
  const exited = once(child, 'exit');
  t.after(async () => { child.kill(); await exited; });
  const identity = await identifyCurrentProcess();
  assert.equal(typeof identity.processBirth, 'string');
  const [own, other] = await probeProcesses([process.pid, child.pid]);
  assert.equal(own.processBirth, identity.processBirth);
  assert.equal(other.status, 'present');
  child.kill();
  await exited;
  assert.equal((await probeProcesses([child.pid]))[0].status, 'missing');
});

test('broken native helper fails closed', async () => {
  const [result] = await probeProcesses([pid], { pythonExecutable: path.join(os.tmpdir(), 'mind-no-such-python') });
  assert.equal(result.status, 'unknown');
});

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'mind-process-identity-'));
  t.after(async () => {
    assert.equal(path.dirname(base), os.tmpdir());
    assert.ok(path.basename(base).startsWith('mind-process-identity-'));
    await fs.rm(base, { recursive: true, force: true });
  });
  return base;
}

test('owner lock preserves active, unknown, corrupt and changed owners, and recovers only stale owners', async t => {
  const base = await fixture(t), file = path.join(base, 'operation.lock');
  const release = await acquireOwnerFileLock(file);
  await assert.rejects(acquireOwnerFileLock(file), { code: 'LOCK_BUSY' });
  await release();
  await fs.writeFile(file, '{broken');
  assert.equal(await recoverAbandonedOwnerFile(file), false);
  await assert.rejects(acquireOwnerFileLock(file), { code: 'PROCESS_IDENTITY_UNKNOWN' });
  assert.equal(await fs.readFile(file, 'utf8'), '{broken');
  await fs.writeFile(file, JSON.stringify(legacy));
  const staleInspector = async records => records.map(record => ({ ...record, state: 'stale' }));
  const unlock = await acquireOwnerFileLock(file, { inspect: staleInspector });
  await unlock();
  assert.deepEqual(await fs.readdir(base), []);
});

test('recovery rereads owner inside barrier and never removes the replacement file', async t => {
  const base = await fixture(t), file = path.join(base, 'operation.lock');
  await fs.writeFile(file, JSON.stringify(legacy));
  const moved = file + '.previous';
  const replacement = JSON.stringify({ ...legacy, token: 'new-live-owner' });
  const result = await recoverAbandonedOwnerFile(file, { inspect: async records => {
    await fs.rename(file, moved);
    await fs.writeFile(file, replacement);
    return records.map(record => ({ ...record, state: 'stale' }));
  } });
  assert.equal(result, false);
  assert.equal(await fs.readFile(file, 'utf8'), replacement);
});

test('session inspection reports unknown separately and blocks old consumers conservatively', async t => {
  const base = await fixture(t);
  await fs.mkdir(path.join(base, 'sesiones'));
  const a = randomUUID(), b = randomUUID(), c = randomUUID();
  const record = id => ({ format: 'mind-session', version: 1, ...legacy, id });
  await fs.writeFile(path.join(base, 'sesiones', 'sesion-' + a + '.json'), JSON.stringify(record(a)));
  await fs.writeFile(path.join(base, 'sesiones', 'sesion-' + b + '.json'), '{broken');
  await fs.writeFile(path.join(base, 'sesiones', 'sesion-' + c + '.json'), JSON.stringify({ ...record(c), host: 'remote-' + host }));
  const result = await liveSessions(base, { probe: async () => [{ pid, status: 'missing' }] });
  assert.equal(result.stale.length, 1);
  assert.equal(result.unknown.length, 2);
  assert.equal(result.live.length, 2);
});

test('an opened real session is registered in both stores until its safe close', async t => {
  const { agentFixture } = await import('./helpers/agent-fixture.js');
  const f = await agentFixture(t, { prefix: '.mind-live-owner-test-' });
  const session = await f.open();
  for (const location of [f.layout.baseDirectory, path.join(f.mind, '.mind-producto')]) {
    const status = await liveSessions(location, { pythonExecutable: f.layout.pythonExecutable });
    assert.equal(status.live.length, 1);
    assert.equal(status.live[0].id, session.id);
    assert.equal(status.live[0].version, 2);
    assert.equal(status.live[0].state, 'active');
    assert.equal(typeof status.live[0].processBirth, 'string');
  }
  await session.close();
  assert.equal((await liveSessions(f.layout.baseDirectory)).live.length, 0);
  assert.equal((await liveSessions(path.join(f.mind, '.mind-producto'))).live.length, 0);
});

test('guided repair cleans stale records in both session stores, preserves ambiguous entries', async t => {
  const { agentFixture, scriptedPrompt } = await import('./helpers/agent-fixture.js');
  const { repairConsole } = await import('../src/console.js');
  const f = await agentFixture(t, { prefix: '.mind-repair-owner-test-' });
  const session = await f.open();
  const child = spawn(process.execPath, ['-e', ''], { windowsHide: true, stdio: 'ignore' });
  await once(child, 'exit');
  const id = randomUUID();
  const dead = { format: 'mind-session', version: 1, id, pid: child.pid, host,
    startedAt: '2020-01-01T00:00:00Z' };
  const paths = [path.join(f.layout.baseDirectory, 'sesiones'), path.join(f.mind, '.mind-producto', 'sesiones')];
  for (const directory of paths) await fs.writeFile(path.join(directory, 'sesion-' + id + '.json'), JSON.stringify(dead));
  const prompt = scriptedPrompt('s');
  assert.equal(await repairConsole({ session, prompt }), 2);
  for (const directory of paths) await assert.rejects(fs.access(path.join(directory, 'sesion-' + id + '.json')), { code: 'ENOENT' });
  const temporary = path.join(f.layout.baseDirectory, '.mind-ficticio.tmp');
  await fs.writeFile(temporary, 'Uncommitted data without verifiable ownership');
  assert.equal(await repairConsole({ session, prompt: scriptedPrompt('s') }), 0);
  assert.equal(await fs.readFile(temporary, 'utf8'), 'Uncommitted data without verifiable ownership');
  const corrupt = randomUUID(), file = path.join(paths[0], 'sesion-' + corrupt + '.json');
  await fs.writeFile(file, '{broken');
  const blocked = scriptedPrompt('s');
  assert.equal(await repairConsole({ session, prompt: blocked }), 0);
  assert.equal(await fs.readFile(file, 'utf8'), '{broken');
  assert.ok(blocked.lines.some(line => /no verificables/u.test(line)));
});
