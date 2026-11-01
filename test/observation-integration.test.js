import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openMotor } from '../src/motor.js';

const motorDirectory = fileURLToPath(new URL('..', import.meta.url));
const development = path.dirname(motorDirectory);
const FAST = Object.freeze({
  debounceMs: 80, maxDelayMs: 1_000, minIntervalMs: 150, safetyIntervalMs: 0,
  fallbackIntervalMs: 400, authorizationCheckMs: 200,
});

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(development, '.mind-observation-integration-test-'));
  const opened = [];
  t.after(async () => {
    await Promise.allSettled(opened.map((observer) => observer.close()));
    assert.equal(path.dirname(root), development);
    assert.ok(path.basename(root).startsWith('.mind-observation-integration-test-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const base = path.join(root, 'Base ficticia');
  const folder = path.join(root, 'Información ficticia');
  await fs.mkdir(base);
  await fs.mkdir(path.join(folder, 'Proyectos'), { recursive: true });
  await fs.writeFile(path.join(folder, 'Proyectos', 'plan.txt'), 'Plan ficticio v1');
  await fs.writeFile(path.join(folder, 'notas.txt'), 'Notas ficticias');
  const motor = await openMotor({ baseDirectory: base });
  const scope = await motor.authorizeFolder(folder);
  const reports = [];
  const open = (options = {}) => {
    const observer = motor.openIndexObserver({ ...FAST, onReport: (report) => reports.push(report), ...options });
    opened.push(observer);
    return observer;
  };
  return { root, base, folder, motor, scope, reports, open };
}

async function waitFor(check, message, timeout = 15_000) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Tiempo agotado: ${message}`);
    await new Promise((resolve) => { setTimeout(resolve, 50); });
  }
}

function reconciledWith(reports, predicate) {
  return reports.find((report) => report.type === 'reconciled' && report.changes && predicate(report.changes));
}

test('registrar → indexar → observar → modificar → detectar → actualizar índice → buscar', async (t) => {
  const { folder, motor, scope, reports, open } = await fixture(t);
  assert.equal((await motor.indexFolder(scope.id)).mode, 'initial');
  const observer = open();
  const started = await observer.observe(scope.id);
  assert.equal(started.mode, 'watching');
  assert.equal(started.indexGeneration, 2);

  // Modificación externa, como la haría el usuario con su editor.
  const plan = path.join(folder, 'Proyectos', 'plan.txt');
  await fs.writeFile(plan, 'Plan ficticio v2, ampliado con más texto');
  const detected = await waitFor(() => reconciledWith(reports, (changes) => changes.modified.includes('Proyectos/plan.txt')),
    'cambio detectado');
  assert.ok(detected.reasons.includes('event'));

  const [found] = (await motor.searchFiles({ folderIds: [scope.id], query: 'plan' })).results;
  assert.equal(found.relativePath, 'Proyectos/plan.txt');
  assert.equal(found.size, Buffer.byteLength('Plan ficticio v2, ampliado con más texto'));
  assert.equal(found.status, 'indexed');

  await fs.writeFile(path.join(folder, 'Proyectos', 'acta nueva.txt'), 'Acta ficticia');
  await waitFor(() => reconciledWith(reports, (changes) => changes.added.includes('Proyectos/acta nueva.txt')), 'alta detectada');
  assert.equal((await motor.searchFiles({ folderIds: [scope.id], query: 'acta' })).total, 1);
  assert.equal(await fs.readFile(path.join(folder, 'notas.txt'), 'utf8'), 'Notas ficticias');
});

test('retirar la autorización con el Motor detiene la observación antes de resolver', async (t) => {
  const { folder, motor, scope, reports, open } = await fixture(t);
  await motor.indexFolder(scope.id);
  const observer = open();
  await observer.observe(scope.id);
  assert.equal(await motor.revokeFolder(scope.id), true);
  assert.equal(observer.status(scope.id), null);
  assert.deepEqual(reports.filter((report) => report.type === 'stopped').map((report) => [report.reason, report.code]),
    [['revoked', 'FOLDER_NOT_AUTHORIZED']]);
  assert.deepEqual(observer.list(), []);

  const before = reports.length;
  await fs.writeFile(path.join(folder, 'tras-retirar.txt'), 'ficticio');
  await new Promise((resolve) => { setTimeout(resolve, 600); });
  assert.equal(reports.length, before, 'Sin reconciliaciones tras la retirada');
  const response = await motor.searchFiles({ folderIds: [scope.id], query: 'tras' });
  assert.deepEqual([response.total, response.scopes[0].status], [0, 'not-authorized']);
  await assert.rejects(observer.observe(scope.id), { code: 'FOLDER_NOT_AUTHORIZED' });
});

test('una retirada desde otra instancia del Motor también detiene la observación', async (t) => {
  const { base, motor, scope, reports, open } = await fixture(t);
  const observer = open();
  await observer.observe(scope.id);
  const other = await openMotor({ baseDirectory: base });
  await other.revokeFolder(scope.id);
  await waitFor(() => observer.status(scope.id) === null, 'detención por retirada externa');
  assert.equal(reports.find((report) => report.type === 'stopped').reason, 'revoked');
});

test('la observación es opcional y no exige un servicio residente', async (t) => {
  const { base, motor, scope, open } = await fixture(t);
  assert.equal(typeof motor.openIndexObserver, 'function');
  // Un Motor no abre observaciones por sí solo; el proceso termina aunque el anfitrión no cierre.
  const source = (observe) => `
    import { openMotor } from ${JSON.stringify(pathToFileURL(path.join(motorDirectory, 'src', 'motor.js')).href)};
    const motor = await openMotor({ baseDirectory: ${JSON.stringify(base)} });
    ${observe ? `const observer = motor.openIndexObserver();
    console.log(JSON.stringify(await observer.observe(${JSON.stringify(scope.id)})));` : 'console.log("{}");'}
  `;
  for (const observe of [false, true]) {
    const started = Date.now();
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source(observe)], {
      encoding: 'utf8', timeout: 20_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(Date.now() - started < 15_000);
    if (observe) assert.equal(JSON.parse(result.stdout).mode, 'watching');
  }

  // El observador no puede apuntar a otro Motor: siempre actúa a través de este.
  const observer = open({ motor: { baseDirectory: base } });
  assert.equal((await observer.observe(scope.id)).mode, 'watching');
  await observer.close();
  assert.deepEqual(observer.list(), []);
  await assert.rejects(observer.observe(scope.id), { code: 'OBSERVER_CLOSED' });
  // Cerrar la sesión no retira nada: la carpeta sigue autorizada e indexada.
  assert.equal((await motor.listAuthorizedFolders()).length, 1);
  assert.notEqual(await motor.readFolderIndex(scope.id), null);
});
