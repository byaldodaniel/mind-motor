import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { agentFixture } from './helpers/agent-fixture.js';
import { openMotor } from '../src/motor.js';
import { createIndexStore } from '../src/index-store.js';

test('índice en memoria: se reutiliza, es inmutable y lo invalida otro proceso, la revocación y las exclusiones', async (t) => {
  const fixture = await agentFixture(t, { prefix: '.mind-cache-test-', files: { 'Privado/x.txt': 'x' } });
  const session = await fixture.open();
  const { motor } = session;
  const folder = await motor.authorizeFolder(fixture.folder);
  await motor.indexFolder(folder.id);
  const first = await motor.readFolderIndex(folder.id);
  const second = await motor.readFolderIndex(folder.id);
  assert.equal(first.entries, second.entries, 'la segunda lectura no vuelve a validar el archivo');
  assert.throws(() => { first.entries.push({}); });

  // Otra instancia del Motor (como otro proceso) publica un índice nuevo.
  const other = await openMotor({ baseDirectory: motor.baseDirectory, pythonExecutable: fixture.layout.pythonExecutable });
  await fs.writeFile(path.join(fixture.folder, 'nuevo.txt'), 'n');
  await other.indexFolder(folder.id);
  const fresh = await motor.readFolderIndex(folder.id);
  assert.ok(fresh.entries.some((entry) => entry.path === 'nuevo.txt'), 'la caché no oculta cambios de otro proceso');
  const found = await motor.searchFiles({ folderIds: [folder.id], query: 'nuevo' });
  assert.equal(found.total, 1);

  // Exclusión: se retira en el acto.
  await motor.setFolderExclusions(folder.id, ['Privado']);
  assert.equal((await motor.searchFiles({ folderIds: [folder.id], query: 'x.txt' })).total, 0);

  // Revocación desde otra instancia: ningún resultado de la autorización anterior.
  await other.revokeFolder(folder.id);
  const after = await motor.searchFiles({ folderIds: [folder.id], query: '' }).catch((error) => error);
  assert.ok(after instanceof Error ? true : after.total === 0, JSON.stringify(after));
  assert.equal(await motor.readFolderIndex(folder.id).catch(() => null), null);
});

async function cacheFixture(t, maxBytes) {
  const root = path.resolve(os.tmpdir());
  const base = await fs.mkdtemp(path.join(root, 'mind-index-cache-limits-'));
  t.after(async () => {
    assert.equal(path.dirname(base), root);
    assert.ok(path.basename(base).startsWith('mind-index-cache-limits-'));
    await fs.rm(base, { recursive: true, force: true });
  });
  t.mock.method(os, 'freemem', () => os.totalmem());
  const store = createIndexStore(base, { maxBytes });
  async function save(id, name) {
    const time = '2026-01-01T00:00:00.000Z';
    await store.save({ scopeId: id, root: path.join(base, 'origen-ficticio'), generation: 1,
      authorizationGeneration: null, createdAt: time, updatedAt: time, issues: [],
      entries: [{ path: name, type: 'file', size: 1, state: 'indexed', reason: null,
        createdAt: time, modifiedAt: time, changedAt: time, identity: null }],
    });
  }
  return { store, save };
}

test('caché por bytes: desaloja un índice anterior y no retiene uno que excede el presupuesto', async t => {
  const { store, save } = await cacheFixture(t, 1500);
  const a = 'a'.repeat(64), b = 'b'.repeat(64), large = 'c'.repeat(64);
  await save(a, 'a.txt');
  await save(b, 'b.txt');
  await save(large, 'x'.repeat(900) + '.txt');
  const first = await store.load(a);
  assert.equal((await store.load(a)).entries, first.entries, 'El índice pequeño se reutiliza');
  await store.load(b);
  const reloaded = await store.load(a);
  assert.notEqual(reloaded.entries, first.entries, 'Dos índices pequeños juntos exceden el presupuesto');
  assert.deepEqual(reloaded.entries, first.entries);
  const oversized = await store.load(large);
  assert.notEqual((await store.load(large)).entries, oversized.entries, 'Un índice grande se entrega sin retenerlo');
});

test('presión de memoria: suelta caché y la vuelve a utilizar cuando hay memoria disponible', async t => {
  const { store, save } = await cacheFixture(t, 1024 * 1024);
  const id = 'd'.repeat(64);
  await save(id, 'ficticio.txt');
  const first = await store.load(id);
  assert.equal((await store.load(id)).entries, first.entries);
  t.mock.method(os, 'freemem', () => 1);
  const pressured = await store.load(id);
  assert.notEqual(pressured.entries, first.entries);
  assert.notEqual((await store.load(id)).entries, pressured.entries);
  t.mock.method(os, 'freemem', () => os.totalmem());
  const recovered = await store.load(id);
  assert.equal((await store.load(id)).entries, recovered.entries);
});
