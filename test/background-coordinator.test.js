import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createBackgroundLease } from '../src/background-coordinator.js';
import { openSession } from '../src/session.js';
import { schedulerFor } from '../src/automations/scheduler.js';
import { openMotor } from '../src/motor.js';
import { createIndexObserver } from '../src/index-observer.js';
import { MotorError } from '../src/errors.js';
import { withRequestContext } from '../src/request-context.js';

const cleanups = new WeakMap();
const cleanup = (t, fn) => cleanups.get(t).push(fn);
async function temporary(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mind-coordinator-'));
  cleanups.set(t, []);
  t.after(async () => {
    for (const fn of cleanups.get(t).reverse()) await fn();
    assert.equal(path.dirname(root), os.tmpdir());
    assert.ok(path.basename(root).startsWith('mind-coordinator-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}

test('un único dueño entre sesiones del mismo proceso; cierre permite relevo', async (t) => {
  const base = await temporary(t);
  const owners = ['primera', 'segunda', 'tercera'].map((id) => createBackgroundLease(base, id));
  const results = await Promise.all(owners.map((owner) => owner.acquire()));
  assert.equal(results.filter(Boolean).length, 1);
  const first = results.indexOf(true);
  const next = (first + 1) % owners.length;
  assert.equal(owners[next].status().ownerPid, process.pid);
  await owners[first].release();
  assert.equal(await owners[next].acquire(), true);
  assert.equal(await owners[(next + 1) % owners.length].acquire(), false);
  await owners[next].release();
  await assert.rejects(fs.access(path.join(base, 'background-owner.json')), { code: 'ENOENT' });
});

test('no se roba dueño vivo por antigüedad; se recupera al morir su proceso', async (t) => {
  const base = await temporary(t);
  const moduleUrl = new URL('../src/background-coordinator.js', import.meta.url).href;
  const code = `import {createBackgroundLease} from ${JSON.stringify(moduleUrl)};
    const owner=createBackgroundLease(process.env.MIND_TEST_BASE,'hijo-ficticio');
    await owner.acquire(); console.log('ready'); setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, MIND_TEST_BASE: base }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let ended = false;
  const exit = once(child, 'exit').then(() => { ended = true; });
  cleanup(t, async () => { if (!ended) child.kill(); await exit; });
  await Promise.race([
    once(child.stdout, 'data'),
    exit.then(() => { throw new Error('El propietario terminó antes de estar listo'); }),
  ]);
  const contender = createBackgroundLease(base, 'reemplazo');
  const filename = path.join(base, 'background-owner.json');
  const record = JSON.parse(await fs.readFile(filename, 'utf8'));
  record.startedAt = '2000-01-01T00:00:00.000Z';
  await fs.writeFile(filename, JSON.stringify(record));
  assert.equal(await contender.acquire(), false);
  child.kill();
  await exit;
  assert.equal(await contender.acquire(), true);
  assert.equal(contender.status().ownerPid, process.pid);
  await contender.release();
});

test('seguidores consultan sin reindexar ni programar; asumen el trabajo al cerrar dueño', async (t) => {
  const root = await temporary(t);
  const base = path.join(root, 'Base ficticia');
  const folder = path.join(root, 'Proyecto ficticio');
  await fs.mkdir(folder);
  await fs.writeFile(path.join(folder, 'nota.md'), 'Datos ficticios');
  const sessions = [];
  cleanup(t, async () => { await Promise.allSettled(sessions.map((session) => session.close())); });
  const layout = { product: false, baseDirectory: base,
    motorDirectory: fileURLToPath(new URL('..', import.meta.url)),
    pythonExecutable: process.env.MIND_TEST_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3'),
    protectedDirectories: [],
  };
  const open = async () => {
    const session = await openSession({ layout, motorVersion: '1.0.1', observe: true });
    sessions.push(session);
    return session;
  };
  const owner = await open();
  const scope = await owner.motor.authorizeFolder(folder);
  await owner.start();
  await owner.ensureIndex(scope.id);
  const generation = (await owner.motor.readFolderIndex(scope.id)).generation;
  const follower = await open();
  await follower.start();
  assert.equal(owner.backgroundStatus().role, 'owner');
  assert.equal(follower.backgroundStatus().role, 'follower');
  assert.ok(schedulerFor(owner));
  assert.equal(schedulerFor(follower), null);
  for (let n = 0; n < 4; n++) assert.equal((await follower.ensureIndex(scope.id)).status, 'current');
  assert.equal((await follower.motor.readFolderIndex(scope.id)).generation, generation);
  const added = path.join(root, 'Segundo proyecto ficticio');
  await fs.mkdir(added);
  await fs.writeFile(path.join(added, 'nota.md'), 'Otra nota ficticia');
  const addedScope = await follower.motor.authorizeFolder(added);
  const waitingAt = Date.now();
  assert.equal((await follower.ensureIndex(addedScope.id, { timeoutMs: 8_000 })).status, 'current');
  assert.ok(Date.now() - waitingAt < 8_000, 'El dueño descubre la autorización sin esperar el intervalo de 30 segundos');
  await owner.close();
  await follower.sync();
  assert.equal(follower.backgroundStatus().role, 'owner');
  assert.ok(schedulerFor(follower));
  await follower.ensureIndex(scope.id);
  assert.ok((await follower.motor.readFolderIndex(scope.id)).generation > generation);
});

test('límite fatal no se reintenta al sincronizar; cambiar exclusiones permite reanudar', async (t) => {
  const root = await temporary(t);
  const folder = path.join(root, 'Proyecto ficticio');
  await fs.mkdir(folder);
  await fs.writeFile(path.join(folder, 'nota.md'), 'Ficticio');
  let scans = 0;
  let limited = true;
  const session = await openSession({
    layout: { product: false, baseDirectory: path.join(root, 'Base ficticia'),
      motorDirectory: fileURLToPath(new URL('..', import.meta.url)), protectedDirectories: [],
      pythonExecutable: process.env.MIND_TEST_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3') },
    motorVersion: '1.0.1', observe: true,
    motorFactory: async (options) => {
      const actual = await openMotor(options);
      const simulated = { ...actual,
        async indexFolder(...args) {
          scans++;
          if (limited) throw new MotorError('INDEX_LIMIT_EXCEEDED', 'Límite ficticio');
          return actual.indexFolder(...args);
        },
        openIndexObserver: (settings) => createIndexObserver({ ...settings, motor: simulated }),
      };
      return simulated;
    },
  });
  cleanup(t, () => session.close());
  const scope = await session.motor.authorizeFolder(folder);
  await session.start();
  await assert.rejects(session.ensureIndex(scope.id), { code: 'INDEX_LIMIT_EXCEEDED' });
  assert.equal(scans, 1);
  for (let n = 0; n < 3; n++) await session.sync();
  await assert.rejects(session.ensureIndex(scope.id), { code: 'INDEX_LIMIT_EXCEEDED' });
  assert.equal(scans, 1, 'Una consulta tampoco reintenta el mismo error fatal');
  limited = false;
  await session.motor.setFolderExclusions(scope.id, ['omitida']);
  await session.sync();
  assert.equal((await session.ensureIndex(scope.id)).status, 'current');
  assert.equal(scans, 2);
});

test('cancelar consulta abandona la espera compartida; cerrar sesión cancela el recorrido', async (t) => {
  const root = await temporary(t);
  const folder = path.join(root, 'Proyecto ficticio');
  await fs.mkdir(folder);
  let started;
  const scanning = new Promise((resolve) => { started = resolve; });
  let scanAborted = false;
  const session = await openSession({
    layout: { product: false, baseDirectory: path.join(root, 'Base ficticia'),
      motorDirectory: fileURLToPath(new URL('..', import.meta.url)), protectedDirectories: [] },
    motorVersion: '1.0.1', observe: true,
    motorFactory: async (options) => {
      const actual = await openMotor(options);
      const simulated = { ...actual,
        indexFolder(_id, { signal }) {
          started();
          return new Promise((_resolve, reject) => {
            const aborted = () => { scanAborted = true; reject(signal.reason); };
            if (signal.aborted) aborted();
            else signal.addEventListener('abort', aborted, { once: true });
          });
        },
        openIndexObserver: (settings) => createIndexObserver({ ...settings, motor: simulated }),
      };
      return simulated;
    },
  });
  cleanup(t, () => session.close());
  const scope = await session.motor.authorizeFolder(folder);
  await session.start();
  await scanning;
  const controller = new AbortController();
  const waiting = withRequestContext({ signal: controller.signal }, () => session.ensureIndex(scope.id));
  const rejected = assert.rejects(waiting, { code: 'REQUEST_CANCELLED' });
  controller.abort(new Error('consulta ficticia cancelada'));
  await rejected;
  assert.equal(scanAborted, false);
  await session.close();
  assert.equal(scanAborted, true);
  await assert.rejects(fs.access(path.join(root, 'Base ficticia', 'background-owner.json')), { code: 'ENOENT' });
});

test('close del observador independiente cancela su recorrido sin señal externa', async (t) => {
  const root = await temporary(t);
  const folderId = 'a'.repeat(64);
  let started;
  const scanning = new Promise((resolve) => { started = resolve; });
  let cancelled = false;
  const observer = createIndexObserver({ motor: {
    baseDirectory: root,
    listAuthorizedFolders: async () => [{ id: folderId, path: root }],
    readFolderIndex: async () => null,
    indexFolder(_id, { signal, priority }) {
      assert.equal(priority, 'interactive', 'La llamada administrativa explícita no espera carga ociosa');
      started();
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
        cancelled = true;
        reject(signal.reason);
      }, { once: true }));
    },
  } });
  cleanup(t, () => observer.close());
  const initial = observer.observe(folderId);
  await scanning;
  await observer.close();
  await initial;
  assert.equal(cancelled, true);
  assert.deepEqual(observer.list(), []);
});
