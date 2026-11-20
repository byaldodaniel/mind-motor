import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { readHandoff, writeHandoff, handoffPath, handoffDirectory, handoffOwner, waitForHandoff, cleanupHandoffRunner, ensureHandoffDirectory, cleanupHandoffRunners } from '../src/update-handoff-state.js';

const python = process.env.MIND_TEST_BUNDLED_PYTHON || process.env.MIND_TEST_PYTHON;
const skipNative = !python || !path.isAbsolute(python);
async function rootFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mind-handoff-owner-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
// Solo lo que el intérprete aislado (-I) necesita para arrancar. Un Python instalado
// puede traer decenas de miles de archivos en site-packages, documentación o Tcl:
// enlazarlos todos agota el plazo de la prueba sin aportar nada al ensayo.
const RUNTIME_SKIP = new Set(['site-packages', 'test', 'tests', '__pycache__', 'Doc', 'Scripts', 'include', 'libs', 'share', 'tcl', 'Tools']);
async function linkRuntime(source, destination) {
  await fs.mkdir(destination, { recursive: true });
  for (const item of await fs.readdir(source, { withFileTypes: true })) {
    const from = path.join(source, item.name), to = path.join(destination, item.name);
    if (item.isDirectory()) { if (!RUNTIME_SKIP.has(item.name)) await linkRuntime(from, to); }
    else if (item.isFile()) {
      try { await fs.link(from, to); } catch (e) { if (e.code !== 'EXDEV') throw e; await fs.copyFile(from, to); }
    } else throw Error('El ensayo nativo requiere runtime de archivos regulares');
  }
}
async function nativeWorker(t) {
  const helper = new URL('../src/process-identity.js', import.meta.url).href;
  const script = 'import {identifyCurrentProcess} from ' + JSON.stringify(helper)
    + ';console.log(JSON.stringify(await identifyCurrentProcess({pythonExecutable:' + JSON.stringify(python) + '})));setInterval(()=>{},1000);';
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = '';
  child.stderr.on('data', data => { errors += data; });
  const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  t.after(async () => { if (child.exitCode === null) child.kill(); await closed; });
  const owner = await new Promise((resolve, reject) => {
    let text = '';
    child.stdout.on('data', data => {
      text += data;
      if (text.includes('\n')) { try { resolve(JSON.parse(text.split('\n')[0])); } catch (e) { reject(e); } }
    });
    child.once('error', reject);
    child.once('exit', () => reject(Error('worker terminó: ' + errors)));
  });
  assert.ok(owner.processBirth);
  return { child, closed, owner };
}

// En Windows, renombrar sobre relevo.json mientras un iniciador lo lee da EPERM:
// writeHandoff reintenta como storage.writeJson. Un lector que mantiene el archivo
// abierto 60 ms lo reproducía siempre sin el reintento.
test('un lector momentáneo de relevo.json no hace fallar writeHandoff', { skip: process.platform !== 'win32' && 'EPERM de renombrado propio de Windows' }, async t => {
  const root = await rootFixture(t);
  const id = randomUUID();
  await writeHandoff(root, { id, phase: 'aplicando' });
  const reader = await fs.open(handoffPath(root), 'r');
  const released = delay(60).then(() => reader.close());
  try {
    await writeHandoff(root, { id, phase: 'completada' });
  } finally {
    await released;
  }
  assert.equal((await readHandoff(root)).phase, 'completada');
});

test('marca terminal sin snapshot no bloquea y marca rota se conserva', async t => {
  const root = await rootFixture(t), record = { id: randomUUID(), phase: 'completada' };
  await writeHandoff(root, record);
  assert.deepEqual(await waitForHandoff({ root }), { waited: false, phase: 'completada' });
  assert.equal(await cleanupHandoffRunner(root, record), false);
  await fs.writeFile(handoffPath(root), '{roto');
  await assert.rejects(waitForHandoff({ root }), { code: 'UPDATE_HANDOFF_INVALID' });
  assert.equal(await fs.readFile(handoffPath(root), 'utf8'), '{roto');
});

test('identidad fuerte: no basta un PID ni una marca de fecha', async () => {
  assert.equal(await handoffOwner({ owner: { pid: process.pid, host: os.hostname(), startedAt: new Date().toISOString() } }, python), 'unknown');
  assert.equal(await handoffOwner({ owner: { pid: process.pid, host: os.hostname(), instanceToken: randomUUID() } }, python), 'unknown');
});

test('worker nativo vivo bloquea; desconocido no recupera; al morir se recupera con Python snapshot y conserva acta',
  { skip: skipNative, timeout: 60_000 }, async t => {
    const root = await rootFixture(t), id = randomUUID(), worker = await nativeWorker(t);
    const directory = handoffDirectory(root, id);
    const sourceRuntime = process.platform === 'win32' ? path.dirname(python) : path.dirname(path.dirname(python));
    await linkRuntime(sourceRuntime, path.join(directory, 'Python'));
    const snapshotPython = path.join(directory, 'Python', process.platform === 'win32' ? 'python.exe' : 'bin/python3');
    const record = { id, phase: 'aplicando', owner: worker.owner };
    assert.equal(await handoffOwner(record, snapshotPython), 'active');
    assert.equal(await handoffOwner({ ...record, owner: { ...worker.owner, processBirth: 'otro-nacimiento' } }, snapshotPython), 'stale');
    let recoveries = 0;
    const recover = async (target, stale) => {
      recoveries++;
      assert.equal(target, root);
      assert.equal(stale.id, id);
      assert.equal(worker.child.exitCode === null && worker.child.signalCode === null, false, 'la recuperación sólo empieza tras cierre real');
      await writeHandoff(root, { ...record, phase: 'fallida', error: { code: 'UPDATE_INTERRUPTED' } });
    };
    await writeHandoff(root, { ...record, owner: { ...worker.owner, host: 'otro-equipo.invalid' } });
    await assert.rejects(waitForHandoff({ root, pythonExecutable: '/runtime-mutable-ausente', recover }), { code: 'UPDATE_OWNER_UNKNOWN' });
    assert.equal(recoveries, 0);
    assert.equal((await readHandoff(root)).phase, 'aplicando');
    assert.ok(await fs.stat(snapshotPython));
    await writeHandoff(root, record);
    let finished = false;
    const waiting = waitForHandoff({ root, pythonExecutable: '/runtime-mutable-ausente', pollMs: 30, recover }).then(value => { finished = true; return value; });
    await delay(200);
    assert.equal(finished, false);
    assert.equal(recoveries, 0);
    assert.equal(await cleanupHandoffRunner(root, { ...record, phase: 'completada' }), false, 'no borra un worker vivo');
    await writeHandoff(root, { ...record, phase: 'verificando' });
    await delay(100);
    assert.equal(finished, false);
    worker.child.kill();
    await worker.closed;
    assert.deepEqual(await waiting, { waited: true, phase: 'fallida' });
    assert.equal(recoveries, 1);
    await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
    const report = await readHandoff(root);
    assert.equal(report.phase, 'fallida');
    assert.equal(report.error.code, 'UPDATE_INTERRUPTED');
  });

test('destino del relevo: rechaza archivos y enlaces tanto en Relevos como en el UUID', async t => {
  const external = await rootFixture(t);
  await fs.writeFile(path.join(external, 'intacto.txt'), 'destino externo intacto');
  for (const slot of ['Relevos', 'UUID']) {
    for (const kind of ['archivo', 'enlace']) {
      const root = await rootFixture(t), id = randomUUID();
      const directory = await ensureHandoffDirectory(root, id);
      const target = slot === 'Relevos' ? path.dirname(directory) : directory;
      await fs.rm(target, { recursive: true, force: true });
      if (kind === 'archivo') await fs.writeFile(target, 'no es una carpeta');
      else await fs.symlink(external, target, process.platform === 'win32' ? 'junction' : 'dir');
      await assert.rejects(ensureHandoffDirectory(root, id), { code: 'UPDATE_PATH_LINK' }, slot + '/' + kind);
      if (kind === 'archivo') assert.equal(await fs.readFile(target, 'utf8'), 'no es una carpeta');
      else assert.equal((await fs.lstat(target)).isSymbolicLink(), true);
      assert.deepEqual(await fs.readdir(external), ['intacto.txt']);
      assert.equal(await fs.readFile(path.join(external, 'intacto.txt'), 'utf8'), 'destino externo intacto');
    }
  }
});

test('los mirrors limpian un terminal antiguo tras cambiar UUID y conservan activos y no verificables',
  { skip: skipNative, timeout: 60_000 }, async t => {
    const { identifyCurrentProcess } = await import('../src/process-identity.js');
    const root = await rootFixture(t), worker = await nativeWorker(t);
    const own = await identifyCurrentProcess({ pythonExecutable: python });
    const old = { id: randomUUID(), phase: 'completada', owner: worker.owner };
    const oldDirectory = await ensureHandoffDirectory(root, old.id);
    const sourceRuntime = process.platform === 'win32' ? path.dirname(python) : path.dirname(path.dirname(python));
    await linkRuntime(sourceRuntime, path.join(oldDirectory, 'Python'));
    await writeHandoff(root, old);
    assert.equal(JSON.parse(await fs.readFile(path.join(oldDirectory, 'registro.json'), 'utf8')).id, old.id);
    const kept = [
      { id: randomUUID(), phase: 'completada', owner: own },
      { id: randomUUID(), phase: 'fallida', owner: { ...own, host: 'otro-equipo.invalid' } },
      { id: randomUUID(), phase: 'espera-quietud', owner: worker.owner },
    ];
    for (const record of kept) {
      const directory = await ensureHandoffDirectory(root, record.id);
      const snapshotPython = path.join(directory, 'Python', process.platform === 'win32' ? 'python.exe' : 'bin/python3');
      await fs.mkdir(path.dirname(snapshotPython), { recursive: true });
      await fs.writeFile(snapshotPython, 'snapshot ficticio; nunca se ejecuta para estos dueños');
      await writeHandoff(root, record);
    }
    worker.child.kill();
    await worker.closed;
    const markerBefore = await fs.readFile(handoffPath(root), 'utf8');
    await cleanupHandoffRunners(root);
    await assert.rejects(fs.stat(oldDirectory), { code: 'ENOENT' });
    for (const record of kept) {
      assert.ok((await fs.stat(handoffDirectory(root, record.id))).isDirectory(), record.phase);
      assert.equal(JSON.parse(await fs.readFile(path.join(handoffDirectory(root, record.id), 'registro.json'), 'utf8')).id, record.id);
    }
    assert.equal(await fs.readFile(handoffPath(root), 'utf8'), markerBefore, 'el barrido conserva el acta vigente');
    assert.equal((await readHandoff(root)).id, kept.at(-1).id);
  });
