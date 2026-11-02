import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { agentFixture } from './helpers/agent-fixture.js';
import { openMotor } from '../src/motor.js';

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
