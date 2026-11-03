import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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

test('un bloqueo vacío y antiguo (dueño terminado antes de escribirlo) se recupera', async (t) => {
  const { base, lock } = await fixture(t);
  await fs.writeFile(lock, '');
  const old = new Date(Date.now() - 120_000);
  await fs.utimes(lock, old, old);
  assert.equal(await withIndexLock(base, SCOPE, async () => 'hecho'), 'hecho');
  assert.deepEqual(await fs.readdir(base), []);
});

test('el bloqueo nuevo guarda el equipo y el proceso para poder demostrar su abandono', async (t) => {
  const { base, lock } = await fixture(t);
  await withIndexLock(base, SCOPE, async () => {
    const data = JSON.parse(await fs.readFile(lock, 'utf8'));
    assert.equal(data.pid, process.pid);
    assert.equal(data.host, os.hostname());
  });
});
