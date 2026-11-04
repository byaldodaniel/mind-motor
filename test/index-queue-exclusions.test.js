import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { openMotor } from '../src/motor.js';
import { createFolderIndexer } from '../src/indexer.js';
import { createResourceGovernor } from '../src/resource-governor.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mind-queue-exclusions-'));
  t.after(async () => {
    assert.equal(path.dirname(root), os.tmpdir());
    assert.ok(path.basename(root).startsWith('mind-queue-exclusions-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const base = path.join(root, 'Base');
  const folder = path.join(root, 'Proyecto ficticio');
  await fs.mkdir(base);
  await fs.mkdir(path.join(folder, 'Privado'), { recursive: true });
  await fs.writeFile(path.join(folder, 'Privado', 'nota.txt'), 'Ficticio excluido');
  await fs.writeFile(path.join(folder, 'visible.txt'), 'Ficticio visible');
  const motor = await openMotor({ baseDirectory: base });
  const scope = await motor.authorizeFolder(folder);
  return { base, motor, scope };
}

test('una indexación en cola usa las exclusiones vigentes al comenzar', async (t) => {
  const { base, motor, scope } = await fixture(t);
  let release;
  let notify;
  const started = new Promise(resolve => { notify = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const holder = createResourceGovernor(base).run(async () => { notify(); await gate; });
  await started;
  const indexer = createFolderIndexer({ baseDirectory: base, resolveScope: id => motor.getAuthorizedFolder(id) });
  const queued = indexer.indexFolder(scope.id);
  // Observe that the request is queued before changing the authorization.
  try {
    const deadline = Date.now() + 5_000;
    while ((await fs.readdir(path.join(base, 'resource-queue'))).filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).length < 2) {
      assert.ok(Date.now() < deadline, 'La solicitud no entró en la cola');
      await delay(10);
    }
    await motor.setFolderExclusions(scope.id, ['Privado']);
  } finally { release(); await holder; }
  await queued;
  assert.deepEqual((await indexer.readFolderIndex(scope.id)).entries.map(item => item.path), ['visible.txt']);
});

test('cambiar exclusiones durante el primer recorrido impide publicar nombres excluidos', async (t) => {
  const { base, motor, scope } = await fixture(t);
  let reads = 0;
  const indexer = createFolderIndexer({ baseDirectory: base, resolveScope: async id => {
    if (++reads === 3) await motor.setFolderExclusions(id, ['Privado']);
    return motor.getAuthorizedFolder(id);
  } });
  await assert.rejects(indexer.indexFolder(scope.id), { code: 'INDEX_CONFLICT' });
  assert.equal(await indexer.readFolderIndex(scope.id), null);
  await indexer.indexFolder(scope.id);
  assert.deepEqual((await indexer.readFolderIndex(scope.id)).entries.map(item => item.path), ['visible.txt']);
});
