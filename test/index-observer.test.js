import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { watch as fsWatch } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openMotor } from '../src/motor.js';
import { createIndexObserver, pairRenames } from '../src/index-observer.js';

const motorDirectory = fileURLToPath(new URL('..', import.meta.url));
const development = path.dirname(motorDirectory);
const linkType = process.platform === 'win32' ? 'junction' : 'dir';
// Windows: solo recursiva (la otra bloquearía renombrar subcarpetas). Linux: por
// directorio. macOS admite ambas y se prueban las dos.
const strategies = { win32: ['recursive'], darwin: ['recursive', 'directories'] }[process.platform]
  ?? ['directories'];
const FAST = {
  debounceMs: 80, maxDelayMs: 1_000, minIntervalMs: 150, safetyIntervalMs: 0,
  fallbackIntervalMs: 400, authorizationCheckMs: 200,
};

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(development, '.mind-observer-test-'));
  t.after(async () => {
    assert.equal(path.dirname(root), development);
    assert.ok(path.basename(root).startsWith('.mind-observer-test-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const base = path.join(root, 'Base ficticia');
  const folder = path.join(root, 'Información ficticia');
  await fs.mkdir(base);
  await fs.mkdir(path.join(folder, 'Proyectos', 'Fotos'), { recursive: true });
  await fs.writeFile(path.join(folder, 'notas.txt'), 'Notas ficticias');
  await fs.writeFile(path.join(folder, 'Proyectos', 'plan.md'), '# Plan ficticio');
  const motor = await openMotor({ baseDirectory: base });
  const scope = await motor.authorizeFolder(folder);
  return { root, base, folder: scope.path, motor, scope };
}

async function waitFor(check, { timeout = 15_000, message = 'condición no alcanzada' } = {}) {
  const limit = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > limit) throw new Error(`Tiempo agotado: ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Envoltorio de fs.watch que registra observaciones y permite simular fallos. */
function recordingWatch({ drop = () => false, refuse = () => null } = {}) {
  const opened = [];
  function watch(target, options, listener) {
    const code = refuse(target);
    if (code) throw Object.assign(new Error(code), { code });
    const watcher = fsWatch(target, options, (...args) => {
      if (!drop(target)) listener(...args);
    });
    const record = { target, options, watcher, closed: false, listener };
    const close = watcher.close.bind(watcher);
    watcher.close = () => {
      record.closed = true;
      close();
    };
    opened.push(record);
    return watcher;
  }
  return { watch, opened };
}

function harness(t, motor, options = {}) {
  const reports = [];
  const observer = createIndexObserver({ motor, onReport: (item) => reports.push(item), ...FAST, ...options });
  t.after(() => observer.close());
  const reconciled = () => reports.filter((item) => item.type === 'reconciled');
  return {
    observer,
    reports,
    reconciled,
    /** Espera un informe posterior a `after` que cumpla la condición. */
    next(predicate, after = 0, message) {
      return waitFor(() => reports.slice(after).find(predicate), { message });
    },
    /** Sin trabajo pendiente ni informes nuevos durante un intervalo. */
    async idle(id) {
      let count = -1;
      await waitFor(async () => {
        const state = observer.status(id);
        const stable = state && !state.pending && !state.running && reports.length === count;
        count = reports.length;
        if (!stable) await pause(250);
        return stable;
      }, { message: 'observador en reposo' });
    },
  };
}

const has = (list, value) => Array.isArray(list) && list.includes(value);

for (const strategy of strategies) {
  test(`${strategy}: altas, modificaciones, renombrados y eliminaciones actualizan el índice`, async (t) => {
    const { folder, motor, scope } = await fixture(t);
    const h = harness(t, motor, { strategy });
    const started = await h.observer.observe(scope.id);
    assert.equal(started.mode, 'watching');
    assert.equal(started.strategy, strategy);
    assert.equal(h.reconciled()[0].mode, 'initial');
    assert.deepEqual(h.reconciled()[0].reasons, ['start']);
    await h.idle(scope.id);

    let mark = h.reports.length;
    await fs.writeFile(path.join(folder, 'nuevo.txt'), 'Alta ficticia');
    const added = await h.next((r) => has(r.changes?.added, 'nuevo.txt'), mark, 'alta');
    assert.ok(added.reasons.includes('event'));
    assert.ok(added.hints.overflow || added.hints.paths.some((item) => item.endsWith('nuevo.txt')));
    await h.idle(scope.id);

    mark = h.reports.length;
    await fs.appendFile(path.join(folder, 'notas.txt'), ' con una modificación ficticia');
    await h.next((r) => has(r.changes?.modified, 'notas.txt'), mark, 'modificación');
    await h.idle(scope.id);

    mark = h.reports.length;
    await fs.rename(path.join(folder, 'nuevo.txt'), path.join(folder, 'renombrado.txt'));
    const file = await h.next((r) => r.changes?.renamed.length > 0, mark, 'renombrado de archivo');
    assert.deepEqual(file.changes.renamed, [{ from: 'nuevo.txt', to: 'renombrado.txt', type: 'file' }]);
    assert.deepEqual(file.changes.added, []);
    assert.deepEqual(file.changes.removed, []);
    await h.idle(scope.id);

    mark = h.reports.length;
    await fs.rename(path.join(folder, 'Proyectos'), path.join(folder, 'Archivo'));
    const directory = await h.next((r) => r.changes?.renamed.length > 0, mark, 'renombrado de carpeta');
    assert.deepEqual(directory.changes.renamed, [{ from: 'Proyectos', to: 'Archivo', type: 'directory' }]);
    assert.deepEqual(directory.changes.added, []);
    assert.deepEqual(directory.changes.removed, []);
    await h.idle(scope.id);

    mark = h.reports.length;
    await fs.rm(path.join(folder, 'renombrado.txt'));
    await h.next((r) => has(r.changes?.removed, 'renombrado.txt'), mark, 'eliminación');
    await h.idle(scope.id);

    const index = await motor.readFolderIndex(scope.id);
    assert.deepEqual(index.entries.map((entry) => entry.path),
      ['Archivo', 'Archivo/Fotos', 'Archivo/plan.md', 'notas.txt']);
    if (strategy === 'directories') {
      // La observación sigue a las carpetas del índice, no a las anteriores.
      assert.equal(h.observer.status(scope.id).watchers, 3);
    }
  });

  test(`${strategy}: una ráfaga de cambios se agrupa en pocas reconciliaciones`, async (t) => {
    const { folder, motor, scope } = await fixture(t);
    const h = harness(t, motor, { strategy, maxHints: 16 });
    await h.observer.observe(scope.id);
    await h.idle(scope.id);
    const before = h.reconciled().length;
    for (let i = 0; i < 60; i += 1) {
      await fs.writeFile(path.join(folder, `rafaga-${String(i).padStart(2, '0')}.txt`), `Archivo ficticio ${i}`);
    }
    await waitFor(async () => (await motor.readFolderIndex(scope.id)).entries.length === 64,
      { message: 'ráfaga indexada' });
    await h.idle(scope.id);
    const runs = h.reconciled().slice(before);
    assert.ok(runs.length >= 1 && runs.length <= 4, `reconciliaciones: ${runs.length}`);
    const total = runs.reduce((sum, r) => sum + r.changes.added.length, 0);
    assert.equal(total, 60);
    // Las pistas se acotan y se marcan como desbordadas en lugar de crecer sin límite.
    assert.ok(runs.every((r) => r.hints.paths.length <= 16));
    assert.ok(runs.some((r) => r.hints.overflow));
  });

  test(`${strategy}: los enlaces hacia fuera de la carpeta no se observan`, async (t) => {
    const { root, folder, motor, scope } = await fixture(t);
    const outside = path.join(root, 'Exterior ficticio');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'ajeno.txt'), 'Fuera del ámbito');
    await fs.symlink(outside, path.join(folder, 'enlace'), linkType);
    const recorder = recordingWatch();
    const h = harness(t, motor, { strategy, watch: recorder.watch });
    await h.observer.observe(scope.id);
    await h.idle(scope.id);
    const index = await motor.readFolderIndex(scope.id);
    assert.equal(index.entries.find((entry) => entry.path === 'enlace').type, 'link');
    assert.equal(index.entries.some((entry) => entry.path.startsWith('enlace/')), false);
    for (const { target } of recorder.opened) {
      assert.ok(target === motor.baseDirectory || !path.relative(folder, target).startsWith('..'));
      assert.notEqual(path.basename(target), 'enlace');
    }
    const before = h.reconciled().length;
    for (let i = 0; i < 3; i += 1) {
      await fs.writeFile(path.join(outside, `ajeno-${i}.txt`), 'Cambio externo ficticio');
      await fs.appendFile(path.join(outside, 'ajeno.txt'), ' más');
    }
    await pause(1_500);
    assert.equal(h.reconciled().length, before, 'un cambio externo no provoca reconciliación');
  });
}

test('al reiniciar se reconcilia lo ocurrido sin observación', async (t) => {
  const { folder, motor, scope } = await fixture(t);
  const first = harness(t, motor);
  await first.observer.observe(scope.id);
  await first.idle(scope.id);
  await first.observer.close();
  assert.equal(first.reports.at(-1).reason, 'closed');

  await fs.writeFile(path.join(folder, 'durante-el-cierre.txt'), 'Alta sin observación');
  await fs.rm(path.join(folder, 'notas.txt'));
  const second = harness(t, motor);
  await second.observer.observe(scope.id);
  const startup = second.reconciled()[0];
  assert.deepEqual(startup.reasons, ['start']);
  assert.equal(startup.mode, 'reconciliation');
  assert.deepEqual(startup.changes.added, ['durante-el-cierre.txt']);
  assert.deepEqual(startup.changes.removed, ['notas.txt']);
});

test('desbordamiento, eventos perdidos y fallo del observador se recuperan reconciliando', async (t) => {
  const { folder, motor, scope } = await fixture(t);
  let dropping = false;
  const recorder = recordingWatch({ drop: (target) => dropping && target !== motor.baseDirectory });
  const h = harness(t, motor, { watch: recorder.watch });
  await h.observer.observe(scope.id);
  await h.idle(scope.id);
  const live = () => recorder.opened.filter((item) => !item.closed && item.target !== motor.baseDirectory);

  // Eventos perdidos y después una notificación sin nombre (desbordamiento).
  dropping = true;
  await fs.writeFile(path.join(folder, 'perdido.txt'), 'Evento no entregado');
  await pause(400);
  assert.equal(h.observer.status(scope.id).pending, false);
  dropping = false;
  let mark = h.reports.length;
  live()[0].listener('rename', null);
  const overflow = await h.next((r) => r.type === 'reconciled', mark, 'desbordamiento');
  assert.deepEqual(overflow.reasons, ['overflow']);
  assert.equal(overflow.hints.overflow, true);
  assert.deepEqual(overflow.changes.added, ['perdido.txt']);
  await h.idle(scope.id);

  // Un error cierra esa observación; se reconcilia y se vuelve a abrir.
  const failed = live()[0];
  mark = h.reports.length;
  failed.watcher.emit('error', Object.assign(new Error('fallo simulado'), { code: 'EIO' }));
  const recovered = await h.next((r) => r.type === 'reconciled', mark, 'recuperación');
  assert.ok(recovered.reasons.includes('watch-error'));
  assert.equal(failed.closed, true);
  await h.idle(scope.id);
  assert.ok(live().some((item) => item.target === failed.target && item !== failed));
  // La observación reabierta se verifica con otra pasada y sigue notificando.
  assert.ok(h.reconciled().slice(-1)[0].reasons.includes('verify'));
  mark = h.reports.length;
  await fs.writeFile(path.join(folder, 'despues.txt'), 'Tras la recuperación');
  await h.next((r) => has(r.changes?.added, 'despues.txt'), mark, 'notificación tras recuperar');
});

test('el intervalo de seguridad reconcilia aunque el sistema no notifique nada', async (t) => {
  const { folder, motor, scope } = await fixture(t);
  const recorder = recordingWatch({ drop: () => true });
  const h = harness(t, motor, { watch: recorder.watch, safetyIntervalMs: 1_000 });
  await h.observer.observe(scope.id);
  // Con observación por directorio, las carpetas abiertas tras el recorrido inicial
  // programan una pasada `verify`; el cambio se hace después para que solo el
  // intervalo de seguridad pueda detectarlo.
  await h.idle(scope.id);
  if (h.observer.status(scope.id).strategy === 'directories') {
    assert.ok(h.reconciled().some((r) => r.reasons.includes('verify')));
  }
  assert.ok(h.reconciled().every((r) => !r.reasons.includes('event')));
  const mark = h.reports.length;
  await fs.writeFile(path.join(folder, 'silencioso.txt'), 'Sin notificación');
  const safety = await h.next((r) => has(r.changes?.added, 'silencioso.txt'), mark, 'reconciliación de seguridad');
  assert.deepEqual(safety.reasons, ['safety']);
});

test('sin notificaciones disponibles se degrada a reconciliación periódica', async (t) => {
  const { folder, motor, scope } = await fixture(t);
  const recorder = recordingWatch({ refuse: (target) => (target === motor.baseDirectory ? null : 'ENOSPC') });
  const h = harness(t, motor, { watch: recorder.watch });
  const state = await h.observer.observe(scope.id);
  assert.equal(state.mode, 'polling');
  assert.deepEqual(h.reports.find((r) => r.type === 'degraded'), { type: 'degraded', folderId: scope.id, code: 'ENOSPC' });
  const mark = h.reports.length;
  await fs.writeFile(path.join(folder, 'sondeo.txt'), 'Detectado por sondeo');
  const poll = await h.next((r) => has(r.changes?.added, 'sondeo.txt'), mark, 'sondeo');
  assert.deepEqual(poll.reasons, ['poll']);

  if (process.platform !== 'win32') {
    const limited = harness(t, motor, { strategy: 'directories', maxWatchedDirectories: 2 });
    assert.equal((await limited.observer.observe(scope.id)).mode, 'polling');
    assert.equal(limited.reports.find((r) => r.type === 'degraded').code, 'WATCH_LIMIT');
    assert.equal(limited.observer.status(scope.id).watchers, 0);
  }
});

test('Windows no observa rutas con forma de nombre corto 8.3', async (t) => {
  const { root, motor } = await fixture(t);
  const folder = path.join(root, 'Datos~1');
  await fs.mkdir(folder);
  const scope = await motor.authorizeFolder(folder);
  const recorder = recordingWatch();
  const h = harness(t, motor, { watch: recorder.watch });
  const state = await h.observer.observe(scope.id);
  if (process.platform === 'win32') {
    // libuv aborta el proceso con esas rutas; se usa reconciliación periódica.
    assert.equal(state.mode, 'polling');
    assert.equal(h.reports.find((r) => r.type === 'degraded').code, 'WATCH_PATH_UNSUPPORTED');
    assert.equal(recorder.opened.some((item) => item.target === scope.path), false);
  } else {
    assert.equal(state.mode, 'watching');
  }
});

test('si la carpeta desaparece se liberan sus observaciones y se reintenta', async (t) => {
  const { root, folder, motor, scope } = await fixture(t);
  const recorder = recordingWatch();
  const h = harness(t, motor, { watch: recorder.watch });
  await h.observer.observe(scope.id);
  await h.idle(scope.id);
  const moved = path.join(root, 'Movida');
  await fs.rename(folder, moved);
  const failed = await h.next((r) => r.type === 'error', 0, 'carpeta no disponible');
  assert.equal(failed.code, 'SCOPE_UNAVAILABLE');
  await waitFor(() => h.observer.status(scope.id).mode === 'polling', { message: 'modo periódico' });
  assert.ok(recorder.opened.filter((item) => item.target !== motor.baseDirectory).every((item) => item.closed));
  // Al volver a su ubicación autorizada se reconcilia y se observa de nuevo.
  await fs.rename(moved, folder);
  const mark = h.reports.length;
  await fs.writeFile(path.join(folder, 'regreso.txt'), 'De vuelta');
  await h.next((r) => has(r.changes?.added, 'regreso.txt'), mark, 'reconciliación al volver');
  await waitFor(() => h.observer.status(scope.id).mode === 'watching', { message: 'observación restaurada' });
});

test('retirar la autorización desde otra instancia detiene la observación', async (t) => {
  const { base, folder, motor, scope } = await fixture(t);
  const recorder = recordingWatch();
  const h = harness(t, motor, { watch: recorder.watch, authorizationCheckMs: 60_000 });
  await h.observer.observe(scope.id);
  await h.idle(scope.id);
  const other = await openMotor({ baseDirectory: base });
  assert.equal(await other.revokeFolder(scope.id), true);
  // Sin sondeo frecuente: la detección llega por la observación de la Base.
  const stopped = await h.next((r) => r.type === 'stopped', 0, 'detención por retirada');
  assert.equal(stopped.reason, 'revoked');
  assert.equal(h.observer.status(scope.id), null);
  assert.ok(recorder.opened.filter((item) => item.target !== motor.baseDirectory).every((item) => item.closed));
  const before = h.reconciled().length;
  await fs.writeFile(path.join(folder, 'tras-retirar.txt'), 'No debe indexarse');
  await pause(800);
  assert.equal(h.reconciled().length, before);
  await assert.rejects(motor.readFolderIndex(scope.id), { code: 'FOLDER_NOT_AUTHORIZED' });
  await assert.rejects(h.observer.observe(scope.id), { code: 'FOLDER_NOT_AUTHORIZED' });
});

test('la comprobación periódica detecta la retirada sin observar la Base', async (t) => {
  const { base, motor, scope } = await fixture(t);
  const recorder = recordingWatch({ refuse: (target) => (target === base ? 'EPERM' : null) });
  const h = harness(t, motor, { watch: recorder.watch });
  await h.observer.observe(scope.id);
  await (await openMotor({ baseDirectory: base })).revokeFolder(scope.id);
  const stopped = await h.next((r) => r.type === 'stopped', 0, 'detención periódica');
  assert.equal(stopped.reason, 'revoked');
});

test('retirar y volver a autorizar la misma ruta no hereda la observación', async (t) => {
  const { base, folder, motor, scope } = await fixture(t);
  const h = harness(t, motor, { authorizationCheckMs: 60_000 });
  await h.observer.observe(scope.id);
  await h.idle(scope.id);
  const other = await openMotor({ baseDirectory: base });
  await other.revokeFolder(scope.id);
  assert.equal((await other.authorizeFolder(folder)).id, scope.id);
  const stopped = await h.next((r) => r.type === 'stopped', 0, 'detención por nueva concesión');
  assert.ok(['revoked', 'authorization-changed'].includes(stopped.reason), stopped.reason);
  await fs.writeFile(path.join(folder, 'nueva-concesion.txt'), 'Sin observación heredada');
  await pause(800);
  assert.equal(await motor.readFolderIndex(scope.id), null);
});

test('la observación no mantiene vivo el proceso y close libera todo', async (t) => {
  const { base, scope } = await fixture(t);
  const modules = (name) => JSON.stringify(pathToFileURL(path.join(motorDirectory, 'src', name)).href);
  const script = (closing) => `
    import { openMotor } from ${modules('motor.js')};
    import { createIndexObserver } from ${modules('index-observer.js')};
    const motor = await openMotor({ baseDirectory: ${JSON.stringify(base)} });
    const observer = createIndexObserver({ motor });
    const state = await observer.observe(${JSON.stringify(scope.id)});
    ${closing ? 'await observer.close();' : ''}
    console.log(JSON.stringify(state));
  `;
  for (const closing of [false, true]) {
    const started = Date.now();
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script(closing)],
      { encoding: 'utf8', timeout: 20_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).mode, 'watching');
    // Termina sin esperar al intervalo de seguridad ni a la comprobación periódica.
    assert.ok(Date.now() - started < 15_000);
  }
});

test('valida opciones, ámbitos y el ciclo de vida', async (t) => {
  const { folder, motor, scope } = await fixture(t);
  assert.throws(() => createIndexObserver({}), { code: 'INVALID_OBSERVER_MOTOR' });
  assert.throws(() => createIndexObserver({ motor, intervalo: 1 }), { code: 'INVALID_OBSERVER_OPTION' });
  assert.throws(() => createIndexObserver({ motor, debounceMs: -1 }), { code: 'INVALID_OBSERVER_OPTION' });
  assert.throws(() => createIndexObserver({ motor, strategy: 'polling' }), { code: 'INVALID_OBSERVER_OPTION' });
  if (process.platform === 'win32') {
    assert.throws(() => createIndexObserver({ motor, strategy: 'directories' }), { code: 'INVALID_OBSERVER_OPTION' });
  }
  const h = harness(t, motor);
  for (const invalid of [folder, '../escape', '', null]) {
    await assert.rejects(h.observer.observe(invalid), { code: 'INVALID_SCOPE_ID' });
  }
  await assert.rejects(h.observer.observe('a'.repeat(64)), { code: 'FOLDER_NOT_AUTHORIZED' });
  await assert.rejects(h.observer.reconcile(scope.id), { code: 'NOT_OBSERVED' });
  const [first, second] = await Promise.all([h.observer.observe(scope.id), h.observer.observe(scope.id)]);
  assert.equal(first, second);
  assert.equal(h.reconciled().length, 1);
  const manual = await h.observer.reconcile(scope.id);
  assert.equal(manual.mode, 'watching');
  assert.ok(h.reconciled().at(-1).reasons.includes('manual'));
  assert.equal(await h.observer.unobserve(scope.id), true);
  assert.equal(await h.observer.unobserve(scope.id), false);
  assert.deepEqual(h.observer.list(), []);
  // Dejar de observar conserva el índice publicado.
  assert.ok(await motor.readFolderIndex(scope.id));
  await h.observer.close();
  await assert.rejects(h.observer.observe(scope.id), { code: 'OBSERVER_CLOSED' });
});

test('el módulo solo observa: no abre ni lee originales y solo consulta su raíz', async () => {
  const source = await fs.readFile(fileURLToPath(new URL('../src/index-observer.js', import.meta.url)), 'utf8');
  const imports = [...source.matchAll(/^import .+ from '([^']+)';$/gm)].map((match) => match[0]);
  assert.deepEqual(imports, [
    "import { watch as fsWatch } from 'node:fs';",
    "import { lstat } from 'node:fs/promises';",
    "import path from 'node:path';",
    "import { MotorError } from './errors.js';",
    "import { validateScopeId } from './index-store.js';",
  ]);
  assert.doesNotMatch(source, /\b(readFile|readFileSync|createReadStream|opendir|readdir|stat|realpath|spawn)\s*\(/);
  // La única consulta directa es la identidad de la propia raíz, sin seguir su enlace final.
  assert.deepEqual([...source.matchAll(/\blstat\(([^)]*)\)/g)].map((match) => match[1]),
    ['state.root, { bigint: true }']);
});

test('pairRenames solo empareja firmas únicas y agrupa carpetas renombradas', () => {
  const entry = (item, type, size, modifiedAt, createdAt = null, state = 'indexed') => ({
    path: item, type, size, modifiedAt, changedAt: modifiedAt, createdAt, state, reason: state === 'indexed' ? null : 'EACCES',
  });
  const t1 = '2026-01-01T00:00:00.000Z';
  const t2 = '2026-01-02T00:00:00.000Z';
  const before = [
    entry('A', 'directory', null, t1), entry('A/x.txt', 'file', 3, t1), entry('A/y', 'directory', null, t1),
    entry('A/y/z.txt', 'file', 4, t2), entry('copia1.txt', 'file', 5, t1), entry('copia2.txt', 'file', 5, t1),
    entry('solo.txt', 'file', 9, t2), entry('vacia', 'directory', null, t1),
  ];
  const after = [
    entry('B', 'directory', null, t2), entry('B/x.txt', 'file', 3, t1), entry('B/y', 'directory', null, t1),
    entry('B/y/z.txt', 'file', 4, t2), entry('copia3.txt', 'file', 5, t1), entry('copia4.txt', 'file', 5, t1),
    entry('otro.txt', 'file', 9, t2), entry('vacia2', 'directory', null, t1),
  ];
  const result = pairRenames({
    added: after.map((item) => item.path), modified: [], removed: before.map((item) => item.path),
  }, before, after);
  assert.deepEqual(result.renamed, [
    { from: 'A', to: 'B', type: 'directory' },
    { from: 'solo.txt', to: 'otro.txt', type: 'file' },
  ]);
  // Firmas repetidas o carpetas vacías sin fecha de creación quedan como alta y baja.
  assert.deepEqual(result.removed, ['copia1.txt', 'copia2.txt', 'vacia']);
  assert.deepEqual(result.added, ['copia3.txt', 'copia4.txt', 'vacia2']);

  const unverified = pairRenames({ added: ['n.txt'], modified: [], removed: ['m.txt'] },
    [entry('m.txt', 'file', 1, t1)], [entry('n.txt', 'file', 1, t1, null, 'unverified')]);
  assert.deepEqual(unverified.renamed, []);
});
