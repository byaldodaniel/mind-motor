import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openMotor } from '../src/motor.js';

const development = fileURLToPath(new URL('../..', import.meta.url));
const worker = new URL('./fixtures/index_process.mjs', import.meta.url);

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(development, '.mind-index-process-test-'));
  const children = [];
  const base = path.join(root, 'Base ficticia');
  const folder = path.join(root, 'Información ficticia');
  await fs.mkdir(base);
  await fs.mkdir(folder);
  for (const name of ['a.txt', 'b.txt']) await fs.writeFile(path.join(folder, name), 'inicial');
  const motor = await openMotor({ baseDirectory: base });
  const scope = await motor.authorizeFolder(folder);
  await motor.indexFolder(scope.id);
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
    await Promise.all(children.map((child) => child.exited));
    assert.equal(path.dirname(root), path.resolve(development));
    assert.ok(path.basename(root).startsWith('.mind-index-process-test-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, base, folder, motor, children, id: scope.id,
    filename: path.join(base, `folder-index-${scope.id}.json`),
    lock: path.join(base, `folder-index-${scope.id}.lock`) };
}

function start(t, fixture, options) {
  const child = fork(worker, [JSON.stringify({ base: fixture.base, id: fixture.id, ...options })],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  const messages = [];
  const listeners = new Set();
  let stderr = '';
  let exited = false;
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('message', (message) => {
    messages.push(message);
    for (const listener of listeners) listener();
  });
  const exit = new Promise((resolve) => child.once('exit', (code, signal) => {
    exited = true;
    resolve({ code, signal });
    for (const listener of listeners) listener();
  }));
  child.exited = exit;
  fixture.children.push(child);
  function wait(phase) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        listeners.delete(check);
        reject(new Error(`Barrera ${phase} no alcanzada: ${stderr}`));
      }, 15000);
      function check() {
        const found = messages.find((message) => message.phase === phase);
        if (!found && !exited) return;
        clearTimeout(timeout);
        listeners.delete(check);
        if (found) resolve(found);
        else reject(new Error(`Proceso terminó antes de ${phase}: ${JSON.stringify(messages)} ${stderr}`));
      }
      listeners.add(check);
      check();
    });
  }
  return { child, wait, exit, release: () => child.send('continue'),
    async result() { const message = await wait('result'); await exit; return message; } };
}

async function success(process) {
  const outcome = await process.result();
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  return outcome.result;
}

async function assertEntries(f, expected, generation) {
  const index = await f.motor.readFolderIndex(f.id);
  assert.equal(index.generation, generation);
  const found = await f.motor.searchFiles({ folderIds: [f.id], query: '.txt' });
  assert.equal(found.total, index.entries.length);
  for (const [name, size] of Object.entries(expected)) {
    assert.equal(index.entries.find((entry) => entry.path === name)?.size, size);
    assert.equal(found.results.find((entry) => entry.relativePath === name)?.size, size);
  }
}

for (const operation of ['modify', 'create']) {
  test(`dos procesos ${operation}: esperan y conservan ambas publicaciones y búsquedas`, { timeout: 30000 }, async (t) => {
    const f = await fixture(t);
    const names = operation === 'modify' ? ['a.txt', 'b.txt'] : ['c.txt', 'd.txt'];
    const first = start(t, f, { operation, relativePath: names[0], previous: 'inicial',
      content: 'primera actualización ficticia', pausePublish: true });
    await first.wait('before-publish');
    const second = start(t, f, { operation, relativePath: names[1], previous: 'inicial',
      content: 'segunda actualización ficticia diferente' });
    // EEXIST real: el segundo intentó adquirir la coordinación mientras el primero la tenía.
    await second.wait('contended');
    assert.equal((await f.motor.readFolderIndex(f.id)).generation, 1);
    first.release();
    assert.equal((await success(first)).index.generation, 2);
    assert.equal((await success(second)).index.generation, 3);
    await assertEntries(f, { [names[0]]: Buffer.byteLength('primera actualización ficticia'),
      [names[1]]: Buffer.byteLength('segunda actualización ficticia diferente') }, 3);
    assert.ok(!(await fs.readdir(f.base)).some((name) => name.endsWith('.lock') || name.endsWith('.tmp')));
  });
}

test('recorrido fuera del bloqueo: una modificación concurrente invalida la instantánea', { timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  const scan = start(t, f, { operation: 'scan', pauseScan: true });
  await scan.wait('scanned');
  await success(start(t, f, { operation: 'modify', relativePath: 'a.txt', previous: 'inicial', content: 'modificado después del recorrido' }));
  scan.release();
  assert.equal((await scan.result()).code, 'INDEX_CONFLICT');
  await assertEntries(f, { 'a.txt': Buffer.byteLength('modificado después del recorrido'), 'b.txt': 7 }, 2);
});

test('retirada espera una publicación activa, elimina el índice y no lo revive al reautorizar', { timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  const before = JSON.parse(await fs.readFile(f.filename, 'utf8'));
  const active = start(t, f, { operation: 'modify', relativePath: 'a.txt', previous: 'inicial', content: 'modificación ficticia', pausePublish: true });
  await active.wait('before-publish');
  const revoke = start(t, f, { operation: 'revoke' });
  await revoke.wait('contended');
  active.release();
  await success(active);
  assert.equal(await success(revoke), true);
  await assert.rejects(fs.stat(f.filename), { code: 'ENOENT' });
  await assert.rejects(f.motor.readFolderIndex(f.id), { code: 'FOLDER_NOT_AUTHORIZED' });
  const scope = await f.motor.authorizeFolder(f.folder);
  assert.equal(scope.id, f.id);
  assert.equal(await f.motor.readFolderIndex(f.id), null);
  await f.motor.indexFolder(f.id);
  assert.notEqual((await f.motor.readFolderIndex(f.id)).authorizationGeneration, before.authorizationGeneration);
});

for (const operation of ['scan', 'record-create', 'record-modify']) {
  test(`${operation} pendiente no hereda una autorización nueva`, { timeout: 30000 }, async (t) => {
    const f = await fixture(t);
    const old = await f.motor.readFolderIndex(f.id);
    const entry = { ...old.entries[0], path: operation === 'record-create' ? 'nuevo.txt' : 'a.txt', size: 999 };
    const pending = start(t, f, { operation, entry, pauseAuthorization: true });
    await pending.wait('captured');
    await success(start(t, f, { operation: 'revoke' }));
    await f.motor.authorizeFolder(f.folder);
    await f.motor.indexFolder(f.id);
    const current = await fs.readFile(f.filename, 'utf8');
    pending.release();
    assert.equal((await pending.result()).code, 'INDEX_SCOPE_CHANGED');
    assert.equal(await fs.readFile(f.filename, 'utf8'), current);
    assert.notEqual((await f.motor.readFolderIndex(f.id)).authorizationGeneration, old.authorizationGeneration);
  });
}

test('removeFolderIndex espera la publicación y la retirada gana al finalizar', { timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  const active = start(t, f, { operation: 'scan', pausePublish: true });
  await active.wait('before-publish');
  const remove = start(t, f, { operation: 'remove' });
  await remove.wait('contended');
  active.release();
  await success(active);
  assert.equal(await success(remove), true);
  assert.equal(await f.motor.readFolderIndex(f.id), null);
});

test('bloqueo viejo vivo se respeta; abandonado por un proceso terminado se recupera solo', { timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  const original = await fs.readFile(f.filename, 'utf8');
  const owner = start(t, f, { operation: 'scan', pausePublish: true });
  await owner.wait('before-publish');
  const lock = await fs.readFile(f.lock, 'utf8');
  const old = new Date(Date.now() - 60000);
  await fs.utimes(f.lock, old, old);
  const liveWaiter = start(t, f, { operation: 'revoke' });
  await liveWaiter.wait('contended');
  assert.equal((await liveWaiter.result()).code, 'INDEX_LOCK_TIMEOUT');
  assert.equal(await fs.readFile(f.lock, 'utf8'), lock);
  assert.equal((await f.motor.listAuthorizedFolders())[0].id, f.id, 'La retirada fallida aún no revocó');
  owner.child.kill();
  await owner.exit;
  // El dueño terminó sin liberar: el bloqueo quedó abandonado y nada se publicó.
  assert.equal(await fs.readFile(f.lock, 'utf8'), lock);
  assert.equal(await fs.readFile(f.filename, 'utf8'), original);
  // Recuperación automática aprobada (opción B): mismo equipo y proceso dueño inexistente.
  const abandonedWaiter = start(t, f, { operation: 'scan' });
  await abandonedWaiter.wait('contended');
  const recovered = await abandonedWaiter.result();
  assert.equal(recovered.ok, true, JSON.stringify(recovered));
  assert.equal(recovered.result.generation, 2);
  assert.ok(!(await fs.readdir(f.base)).some((name) => name.endsWith('.lock') || name.includes('.abandonado-')));
});

test('dos carpetas distintas publican independientemente, aun con otra coordinación ocupada', { timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  const other = path.join(f.root, 'Otra carpeta ficticia');
  await fs.mkdir(other);
  const scope = await f.motor.authorizeFolder(other);
  await f.motor.indexFolder(scope.id);
  const first = start(t, f, { operation: 'scan', pausePublish: true });
  await first.wait('before-publish');
  const second = start(t, f, { id: scope.id, operation: 'create', relativePath: 'independiente.txt', content: 'ficticio' });
  assert.equal((await success(second)).index.generation, 2);
  assert.equal((await f.motor.readFolderIndex(f.id)).generation, 1);
  first.release();
  await success(first);
});

test('fallo ordinario libera coordinación, limpia temporal y conserva índice; creación avisa reconciliación', { timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  const original = await fs.readFile(f.filename, 'utf8');
  const result = await success(start(t, f, { operation: 'create', relativePath: 'nuevo.txt', content: 'ficticio', failPublish: true }));
  assert.deepEqual(result.index, { status: 'needs-reconciliation', generation: null, code: 'EIO' });
  assert.equal(await fs.readFile(f.filename, 'utf8'), original);
  assert.ok(!(await fs.readdir(f.base)).some((name) => name.endsWith('.lock') || name.endsWith('.tmp')));
  assert.equal(await fs.readFile(path.join(f.folder, 'nuevo.txt'), 'utf8'), 'ficticio');
  assert.equal((await f.motor.indexFolder(f.id)).generation, 2);
});
