import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createResourceGovernor } from '../src/resource-governor.js';

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'mind-resource-test-'));
  // Like an MCP host's open stdin: background polling deliberately uses
  // unref timers, and a pending Promise alone does not keep Node alive.
  const hostLifetime = setInterval(() => {}, 1000);
  t.after(() => clearInterval(hostLifetime));
  t.after(async () => {
    assert.equal(path.dirname(base), path.resolve(os.tmpdir()));
    assert.ok(path.basename(base).startsWith('mind-resource-test-'));
    await fs.rm(base, { recursive: true, force: true });
  });
  return base;
}
async function queued(governor, count) {
  for (let i = 0; i < 100; i++) {
    if ((await governor.status()).cola.length >= count) return;
    await delay(10);
  }
  throw new Error('La cola no recibió las tareas');
}

test('presupuesto por Base: una tarea pesada, prioridad interactiva y cola vacía al terminar', async t => {
  const base = await fixture(t);
  const first = createResourceGovernor(base, { sample: () => ({ pressured: false }) });
  const second = createResourceGovernor(base, { sample: () => ({ pressured: false }) });
  const order = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let started;
  const began = new Promise(resolve => { started = resolve; });
  const a = first.run(async () => { order.push('a'); started(); await gate; order.push('a-fin'); });
  await began;
  const b = second.run(async () => { order.push('fondo'); }, { priority: 'background' });
  const c = first.run(async () => { order.push('usuario'); });
  await queued(first, 3);
  release();
  await Promise.all([a, b, c]);
  assert.deepEqual(order, ['a', 'a-fin', 'usuario', 'fondo']);
  assert.equal((await first.status()).cola.length, 0);
  assert.equal((await fs.readdir(base)).some(name => name.endsWith('.lock')), false);
});

test('presión de recursos aplaza fondo, permite consulta y reanuda al recuperarse', async t => {
  const base = await fixture(t);
  let pressured = true;
  const governor = createResourceGovernor(base, { sample: () => ({ pressured }) });
  let ran = false;
  const background = governor.run(async () => { ran = true; }, { priority: 'background' });
  await queued(governor, 1);
  assert.equal(await governor.run(async () => 'consulta'), 'consulta');
  assert.equal(ran, false);
  pressured = false;
  await background;
  assert.equal(ran, true);
});

test('cancelar una tarea en espera la retira sin ejecutarla', async t => {
  const base = await fixture(t);
  const governor = createResourceGovernor(base, { sample: () => ({ pressured: true }) });
  const controller = new AbortController();
  const pending = governor.run(() => { throw new Error('No debe ejecutarse'); }, { signal: controller.signal, priority: 'background' });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await queued(governor, 1);
  controller.abort();
  await rejected;
  assert.equal((await governor.status()).cola.length, 0);
});

test('promover una carpeta libera su recorrido de fondo pese a la presión, sin liberar otras', async t => {
  const base = await fixture(t);
  const governor = createResourceGovernor(base, { sample: () => ({ pressured: true }) });
  const requested = 'a'.repeat(64);
  const unrelated = 'b'.repeat(64);
  const controller = new AbortController();
  let ranUnrelated = false;
  const other = governor.run(async () => { ranUnrelated = true; }, {
    priority: 'background', scopeId: unrelated, signal: controller.signal,
  });
  const rejected = assert.rejects(other, { name: 'AbortError' });
  t.after(() => controller.abort());
  const promoted = governor.run(async () => 'requested-complete', { priority: 'background', scopeId: requested });
  await queued(governor, 2);
  assert.equal(ranUnrelated, false);
  await governor.promote(requested);
  assert.equal(await promoted, 'requested-complete');
  assert.equal(ranUnrelated, false);
  controller.abort();
  await rejected;
  assert.equal((await governor.status()).cola.length, 0);
});

test('una promoción vencida deja de evitar el control de presión', async t => {
  const base = await fixture(t);
  const governor = createResourceGovernor(base, { sample: () => ({ pressured: true }) });
  const scopeId = 'c'.repeat(64);
  await governor.promote(scopeId, 1);
  await delay(20);
  const controller = new AbortController();
  let ran = false;
  const task = governor.run(async () => { ran = true; }, { priority: 'background', scopeId, signal: controller.signal });
  const rejected = assert.rejects(task, { name: 'AbortError' });
  t.after(() => controller.abort());
  await queued(governor, 1);
  await delay(150);
  assert.equal(ran, false);
  controller.abort();
  await rejected;
});

test('un timeout del trabajo admitido se propaga y no vuelve a ejecutarlo', async t => {
  const base = await fixture(t);
  const governor = createResourceGovernor(base, { sample: () => ({ pressured: false }), waitLimitMs: 500 });
  let calls = 0;
  const error = Object.assign(new Error('fallo del trabajo'), { code: 'INDEX_LOCK_TIMEOUT' });
  await assert.rejects(governor.run(async () => { calls++; throw error; }), value => value === error);
  assert.equal(calls, 1);
  assert.equal((await governor.status()).cola.length, 0);
});
