import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { RUNS } from './runs.mjs';
import { extractR3, r3Commit } from './r3-fixture.mjs';

const run = promisify(execFile);
const executable = process.env.MIND_NATIVE_EXE;
const prefix = 'mind-nativo-runs-relevo-';
const options = { timeout: 15_000, windowsHide: true };

test('Rust escribe un registro que r3 recupera por ID al volver a la misma Base', {
  skip: !executable && 'Indica MIND_NATIVE_EXE',
  timeout: 90_000,
}, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(RUNS, prefix)));
  t.after(async () => {
    assert.equal(path.dirname(root), RUNS);
    assert.ok(path.basename(root).startsWith(prefix));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const base = path.join(root, 'Base');
  const moduleUrl = await extractR3(root);
  const imports = [
    'const { openMotor } = await import(' + moduleUrl('motor.js') + ');',
    'const { ensureBase, readBaseMarker } = await import(' + moduleUrl('base-format.js') + ');',
    'const base = process.argv[1];',
  ];
  async function runR3(code, args = []) {
    const source = [...imports, ...code].join('\n');
    const result = await run(process.execPath, ['--input-type=module', '-e', source, base, ...args], options);
    return JSON.parse(result.stdout);
  }

  const initial = await runR3([
    "const marker = await ensureBase(base, { motorVersion: '1.0.4' });",
    'const motor = await openMotor({ baseDirectory: base });',
    "const entry = await motor.recordContinuity({ content: 'Nota ficticia anterior al relevo' });",
    'console.log(JSON.stringify({ entry, baseId: marker.baseId }));',
  ]);
  const filename = id => 'continuity-' + id + '.json';
  const marker = path.join(base, 'mind-base.json');
  const priorFile = path.join(base, filename(initial.entry.id));
  const [filesBefore, markerBefore, priorBefore] = await Promise.all([
    fs.readdir(base), fs.readFile(marker), fs.readFile(priorFile),
  ]);
  assert.equal(JSON.parse(markerBefore).version, 3);
  const nativeBinary = path.resolve(executable);
  const create = ['crear-continuidad-prueba', '--base', base, '--referencia', initial.entry.id];

  // Comprueba que la prueba rechaza una Base ocupada y conserva el bloqueo.
  const lock = path.join(base, 'conector.lock');
  await fs.writeFile(lock, 'Bloqueo ficticio del Motor', { flag: 'wx' });
  await assert.rejects(run(nativeBinary, create, options), error => /^BASE_OCUPADA\r?\n?$/.test(error.stderr));
  assert.equal(await fs.readFile(lock, 'utf8'), 'Bloqueo ficticio del Motor');
  await fs.unlink(lock);
  assert.deepEqual((await fs.readdir(base)).sort(), filesBefore.sort());

  // Los procesos se esperan en serie. Rust escribe entre las dos aperturas con r3.
  const written = await run(nativeBinary, create, options);
  const native = JSON.parse(written.stdout);
  assert.match(native.id, /^[0-9a-f-]{36}$/);
  assert.notEqual(native.id, initial.entry.id);
  const nativeFile = path.join(base, filename(native.id));
  const nativeBefore = await fs.readFile(nativeFile);
  const { format, version, ...record } = JSON.parse(nativeBefore);
  assert.equal(format, 'mind-continuity-entry');
  assert.equal(version, 1);
  assert.equal(record.id, native.id);
  assert.equal(record.revision, 1);
  assert.deepEqual(record.content, {
    nota: 'Comprobación de continuidad en el área norte', pasos: ['guardar', 'retomar'], verificado: true,
  });
  assert.deepEqual(record.references, [{ entry: initial.entry.id, relation: 'continúa' }]);
  assert.deepEqual((await fs.readdir(base)).sort(), [...filesBefore, filename(native.id)].sort());

  const reopened = await runR3([
    'const marker = await readBaseMarker(base);',
    'const motor = await openMotor({ baseDirectory: base });',
    'const entry = await motor.getContinuity(process.argv[2]);',
    'const previous = await motor.getContinuity(process.argv[3]);',
    'console.log(JSON.stringify({ entry, previous, baseId: marker.baseId, pid: process.pid }));',
  ], [native.id, initial.entry.id]);
  assert.deepEqual(reopened.entry, record);
  assert.deepEqual(reopened.previous, initial.entry);
  assert.equal(reopened.baseId, initial.baseId);
  assert.deepEqual(await fs.readFile(marker), markerBefore);
  assert.deepEqual(await fs.readFile(priorFile), priorBefore);
  assert.deepEqual(await fs.readFile(nativeFile), nativeBefore);
  t.diagnostic('r3 ' + r3Commit.slice(0, 7) + ' | Rust PID ' + native.pid
    + ' | r3 recuperó ' + native.id + ' en PID ' + reopened.pid);
});
