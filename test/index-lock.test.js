import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { withIndexLock, processAlive } from '../src/index-lock.js';

const development = path.dirname(fileURLToPath(new URL('..', import.meta.url)));
const SCOPE = 'c'.repeat(64);

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(development, '.mind-index-lock-test-'));
  t.after(async () => {
    assert.equal(path.dirname(base), development);
    await fs.rm(base, { recursive: true, force: true });
  });
  return { base, lock: path.join(base, `folder-index-${SCOPE}.lock`) };
}

/** PID de un proceso que ya terminó. */
async function deadPid() {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true });
  await new Promise((resolve) => child.once('exit', resolve));
  assert.equal(processAlive(child.pid), false);
  return child.pid;
}

const owner = (fields) => `${JSON.stringify({ version: 1, owner: 'ficticio', createdAt: '2026-01-01T00:00:00.000Z', ...fields })}\n`;

test('un bloqueo de un proceso terminado en este equipo se recupera y la tarea se ejecuta', async (t) => {
  const { base, lock } = await fixture(t);
  await fs.writeFile(lock, owner({ pid: await deadPid(), host: os.hostname() }));
  assert.equal(await withIndexLock(base, SCOPE, async () => 'hecho'), 'hecho');
  assert.deepEqual(await fs.readdir(base), []);
  // Formato anterior sin equipo (Base local): también se recupera si el proceso no existe.
  await fs.writeFile(lock, owner({ pid: await deadPid() }));
  assert.equal(await withIndexLock(base, SCOPE, async () => 'otra vez'), 'otra vez');
});

test('nunca se recupera un bloqueo vivo, de otro equipo ni vacío reciente', async (t) => {
  const { base, lock } = await fixture(t);
  for (const content of [
    owner({ pid: process.pid, host: os.hostname() }),
    owner({ pid: await deadPid(), host: `otro-${os.hostname()}` }),
    '',
    '{no es json',
  ]) {
    await fs.writeFile(lock, content);
    const old = new Date(Date.now() - 3_600_000);
    if (content !== '') await fs.utimes(lock, old, old);
    let ran = false;
    await assert.rejects(withIndexLock(base, SCOPE, async () => { ran = true; }), { code: 'INDEX_LOCK_TIMEOUT' });
    assert.equal(ran, false);
    assert.equal(await fs.readFile(lock, 'utf8'), content);
  }
});

test('un bloqueo vacío antiguo sigue siendo indeterminado y se conserva', async (t) => {
  const { base, lock } = await fixture(t);
  await fs.writeFile(lock, '');
  const old = new Date(Date.now() - 120_000);
  await fs.utimes(lock, old, old);
  await assert.rejects(withIndexLock(base, SCOPE, async () => 'hecho', 'folder-index', { timeoutMs: 150 }), { code: 'INDEX_LOCK_TIMEOUT' });
  assert.equal(await fs.readFile(lock, 'utf8'), '');
});

test('el bloqueo nuevo guarda el equipo y el proceso para poder demostrar su abandono', async (t) => {
  const { base, lock } = await fixture(t);
  await withIndexLock(base, SCOPE, async () => {
    const data = JSON.parse(await fs.readFile(lock, 'utf8'));
    assert.equal(data.pid, process.pid);
    assert.equal(data.host, os.hostname());
  });
});

test('dos recuperadores revalidan al dueño dentro de la barrera y un tercero nunca se solapa', { timeout: 15_000 }, async (t) => {
  const gate = () => {
    let release;
    const promise = new Promise(resolve => { release = resolve; });
    return { promise, release };
  };
  const secondRead = gate();
  const staleRead = gate();
  const freshRead = gate();
  const freshReply = gate();
  const firstTask = gate();
  const finishFirst = gate();
  const tasks = [];
  t.after(async () => {
    for (const item of [secondRead, staleRead, freshRead, freshReply, firstTask, finishFirst]) item.release();
    await Promise.allSettled(tasks);
  });
  const { base, lock } = await fixture(t);
  const barrier = `${lock}.recovery`;
  const dead = await deadPid();
  await fs.writeFile(lock, owner({ pid: dead, host: os.hostname() }));
  const readFile = fs.readFile.bind(fs);
  const lstat = fs.lstat.bind(fs);
  const rename = fs.rename.bind(fs);
  let deadReads = 0;
  let heldFreshRead = false;
  let liveRenames = 0;
  t.mock.method(fs, 'readFile', async (filename, ...args) => {
    const value = await readFile(filename, ...args);
    if (filename !== lock) return value;
    const pid = JSON.parse(value).pid;
    if (pid === dead) {
      const readNumber = ++deadReads;
      if (readNumber === 1) await secondRead.promise;
      if (readNumber === 2) { secondRead.release(); await staleRead.promise; }
    } else if (pid === process.pid && !heldFreshRead && await lstat(barrier).then(() => true, () => false)) {
      heldFreshRead = true;
      freshRead.release();
      await freshReply.promise;
    }
    return value;
  });
  t.mock.method(fs, 'rename', async (from, to) => {
    if (from === lock && JSON.parse(await readFile(from, 'utf8')).pid === process.pid) liveRenames++;
    return rename(from, to);
  });
  let active = 0;
  let maximum = 0;
  let entered = 0;
  const task = async () => {
    active++;
    maximum = Math.max(maximum, active);
    entered++;
    try {
      if (entered === 1) { firstTask.release(); await finishFirst.promise; }
      else await delay(25);
    } finally { active--; }
  };
  const start = () => {
    const pending = withIndexLock(base, SCOPE, task, undefined, { timeoutMs: 10_000 });
    pending.catch(() => {});
    tasks.push(pending);
  };
  start();
  start();
  await firstTask.promise;
  // A second caller still holds the dead owner's original observation. It must
  // re-read the now-live owner under its own recovery barrier before any rename.
  staleRead.release();
  await freshRead.promise;
  start();
  await delay(60);
  assert.equal(entered, 1);
  assert.equal(liveRenames, 0);
  freshReply.release();
  finishFirst.release();
  await Promise.all(tasks);
  assert.equal(entered, 3);
  assert.equal(maximum, 1);
  assert.equal(liveRenames, 0);
  assert.deepEqual(await fs.readdir(base), []);
});

test('una barrera creada después de comprobarla impide entrar en la tarea hasta liberarse', async (t) => {
  const { base, lock } = await fixture(t);
  const barrier = `${lock}.recovery`;
  const open = fs.open.bind(fs);
  let created = false;
  let notify;
  const opened = new Promise(resolve => { notify = resolve; });
  t.mock.method(fs, 'open', async (filename, ...args) => {
    if (filename === lock && !created) {
      created = true;
      await fs.mkdir(barrier);
      notify();
    }
    return open(filename, ...args);
  });
  let ran = false;
  const pending = withIndexLock(base, SCOPE, async () => { ran = true; });
  await opened;
  await delay(60);
  assert.equal(ran, false);
  await fs.rmdir(barrier);
  await pending;
  assert.equal(ran, true);
  assert.deepEqual(await fs.readdir(base), []);
});

test('una barrera huérfana falla cerrado y nunca se elimina por antigüedad', async (t) => {
  const { base, lock } = await fixture(t);
  const barrier = `${lock}.recovery`;
  await fs.mkdir(barrier);
  const old = new Date(Date.now() - 3_600_000);
  await fs.utimes(barrier, old, old);
  let ran = false;
  await assert.rejects(withIndexLock(base, SCOPE, async () => { ran = true; }, undefined, { timeoutMs: 100 }),
    { code: 'INDEX_LOCK_TIMEOUT' });
  assert.equal(ran, false);
  assert.deepEqual(await fs.readdir(base), [path.basename(barrier)]);
});

test('perder el nombre del bloqueo antes de publicar dueño impide ejecutar la tarea', async (t) => {
  const { base, lock } = await fixture(t);
  const open = fs.open.bind(fs);
  const replacement = owner({ pid: process.pid, host: os.hostname(), owner: 'otro-dueño-ficticio' });
  let replaced = false;
  t.mock.method(fs, 'open', async (filename, ...args) => {
    const handle = await open(filename, ...args);
    if (filename === lock && !replaced) {
      replaced = true;
      // Models an acquirer paused after creating an empty file: recovery can
      // remove that old empty file before the original handle writes its owner.
      await fs.rename(lock, `${lock}.apartado`);
      await fs.writeFile(lock, replacement);
    }
    return handle;
  });
  let ran = false;
  await assert.rejects(withIndexLock(base, SCOPE, async () => { ran = true; }), { code: 'INDEX_LOCK_LOST' });
  assert.equal(ran, false);
  assert.equal(await fs.readFile(lock, 'utf8'), replacement);
});
