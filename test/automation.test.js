import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { agentFixture } from './helpers/agent-fixture.js';
import { createFunctionService } from '../src/automations/service.js';
import { createAutomationScheduler } from '../src/automations/scheduler.js';
import { normalizeActivation, dueSlot, nextSlot, matchingChanges } from '../src/automations/schedule.js';
import { createSystemScheduler, launcherCommand } from '../src/automations/system.js';

async function setup(t) {
  const fixture = await agentFixture(t, { prefix: '.mind-automation-test-' });
  const session = await fixture.open();
  const folder = await session.motor.authorizeFolder(fixture.folder);
  await session.policy.set(folder.id, { encontrar: true, leer: true, escribir: true, organizar: true }, { channel: 'consola' });
  await session.ensureIndex(folder.id);
  let clock = Date.parse('2026-11-01T12:00:00Z');
  const service = createFunctionService(session, { now: () => clock });
  const definition = (activation = { tipo: 'manual' }, relative = 'salida.txt') => ({
    nombre: 'Plantilla ficticia', ejecutor: 'plantilla-texto',
    parametros: { destino: { carpeta: folder.id, ruta: relative }, plantilla: 'Texto ficticio {funcion}' },
    activacion: activation,
  });
  const activate = async (id) => {
    const prepared = await service.prepareActivation(id);
    return service.authorize(id, { generation: prepared.generation, fingerprint: prepared.fingerprint, channel: 'consola' });
  };
  return { ...fixture, session, service, folderId: folder.id, definition, activate, advance: (ms) => { clock += ms; }, now: () => clock };
}

test('función manual ejecuta un catálogo fijo, respeta permisos y no sobrescribe', async (t) => {
  const { service, definition, folder, session, folderId } = await setup(t);
  await service.create('prueba', definition());
  const first = await service.execute('prueba', { origin: 'manual' });
  assert.equal(first.estado, 'completada', JSON.stringify(first));
  assert.equal(await fs.readFile(path.join(folder, 'salida.txt'), 'utf8'), 'Texto ficticio prueba');
  assert.equal((await service.execute('prueba', { origin: 'manual' })).codigo, 'FILE_EXISTS');
  await session.policy.remove(folderId);
  await service.create('otra', definition(undefined, 'otra.txt'));
  assert.equal((await service.execute('otra', { origin: 'manual' })).codigo, 'ACCESS_NOT_GRANTED');
  await assert.rejects(fs.access(path.join(folder, 'otra.txt')));
  await assert.rejects(service.create('codigo', { ejecutor: 'eval', parametros: {} }), { code: 'EXECUTOR_NOT_FOUND' });
  const history = await service.history('prueba');
  assert.equal(history.length, 2);
  assert.ok(!JSON.stringify(history).includes('Texto ficticio'));
});

test('horario exige consentimiento y ejecuta un solo turno, incluso entre servicios', async (t) => {
  const fixture = await setup(t);
  const { service, definition, activate, advance, session, now } = fixture;
  await service.create('diaria', definition({ tipo: 'horario', frecuencia: 'intervalo', minutos: 15 }));
  advance(16 * 60_000);
  assert.deepEqual(await service.runDue(), []);
  await activate('diaria');
  assert.deepEqual(await service.runDue(), []);
  advance(31 * 60_000);
  const other = createFunctionService(session, { now });
  const [a, b] = await Promise.all([service.runDue(), other.runDue()]);
  assert.equal([...a, ...b].filter((item) => item.estado === 'completada').length, 1);
  assert.deepEqual(await other.runDue(), []);
  assert.equal((await service.history('diaria')).length, 1);
});

test('cambiar definición o revocar y reautorizar carpeta caduca el consentimiento', async (t) => {
  const { service, definition, activate, advance, session, folder, folderId } = await setup(t);
  const def = definition({ tipo: 'horario', frecuencia: 'intervalo', minutos: 15 });
  await service.create('periodica', def);
  await activate('periodica');
  await service.update('periodica', def);
  advance(16 * 60_000);
  assert.equal((await service.status('periodica')).motivo, 'definicion-cambiada');
  assert.deepEqual(await service.runDue(), []);
  await activate('periodica');
  await session.motor.revokeFolder(folderId);
  await session.motor.authorizeFolder(folder);
  advance(16 * 60_000);
  assert.equal((await service.status('periodica')).motivo, 'carpeta-reautorizada');
  assert.deepEqual(await service.runDue(), []);
  await assert.rejects(fs.access(path.join(folder, 'salida.txt')));
});

test('activación desactualizada no concede permiso y desactivar impide próximos turnos', async (t) => {
  const { service, definition, activate, advance } = await setup(t);
  const def = definition({ tipo: 'horario', frecuencia: 'intervalo', minutos: 15 });
  await service.create('periodica', def);
  const old = await service.prepareActivation('periodica');
  await service.update('periodica', def);
  await assert.rejects(service.authorize('periodica', { generation: old.generation, fingerprint: old.fingerprint, channel: 'consola' }), { code: 'AUTOMATION_CHANGED' });
  await activate('periodica');
  await service.deactivate('periodica');
  advance(16 * 60_000);
  assert.equal((await service.status('periodica')).estado, 'desactivada');
  assert.deepEqual(await service.runDue(), []);
});

test('eventos se agrupan, filtran escrituras propias y liberan temporizadores al cerrar', async () => {
  let at = 0;
  let changes;
  let serviceChanged;
  const handles = new Set();
  const calls = [];
  let unsubscribed = false;
  const activation = normalizeActivation({ tipo: 'evento', carpeta: 'a'.repeat(64), extensiones: ['txt'], espera_segundos: 5 });
  const scheduler = createAutomationScheduler({
    now: () => at,
    timers: {
      setTimeout(callback, ms) { const item = { callback, ms, unref() { this.unreferenced = true; } }; handles.add(item); return item; },
      clearTimeout(item) { handles.delete(item); },
    },
    subscribe(listener) { changes = listener; return () => { unsubscribed = true; }; },
    service: {
      onChange(listener) { serviceChanged = listener; return () => { serviceChanged = null; }; },
      authorized: async () => [{ id: 'evento', estado: 'activa', activation, due: null, next: null }],
      execute: async (id, options) => { calls.push({ id, ...options }); return { estado: 'completada', resultado: { archivos: [{ carpeta: activation.carpeta, ruta: 'propio.txt' }] } }; },
    },
  });
  scheduler.start();
  await scheduler.tick();
  assert.ok([...handles].every((item) => item.unreferenced));
  changes({ folderId: activation.carpeta, changes: { added: ['a.txt', 'no.md'] } });
  at += 1000;
  changes({ folderId: activation.carpeta, changes: { modified: ['b.txt'] } });
  const burst = [...handles].find((item) => item.ms === 5000);
  assert.ok(burst);
  handles.delete(burst);
  burst.callback();
  await scheduler.idle();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].changes.agregados, ['a.txt']);
  assert.deepEqual(calls[0].changes.modificados, ['b.txt']);
  changes({ folderId: activation.carpeta, changes: { modified: ['propio.txt'] } });
  assert.deepEqual(scheduler.status().rafagas, []);
  await scheduler.close();
  assert.equal(handles.size, 0);
  assert.equal(unsubscribed, true);
  assert.equal(serviceChanged, null);
});

test('horarios y filtros seleccionan solo el último turno pendiente y el ámbito declarado', () => {
  const activation = normalizeActivation({ tipo: 'horario', frecuencia: 'intervalo', minutos: 15 });
  assert.equal(dueSlot(activation, { grantedAtMs: 0, nowMs: 59 * 60_000 }), 45 * 60_000);
  assert.equal(dueSlot(activation, { grantedAtMs: 0, lastSlotMs: 45 * 60_000, nowMs: 59 * 60_000 }), null);
  assert.equal(nextSlot(activation, 0, 59 * 60_000), 60 * 60_000);
  assert.throws(() => normalizeActivation({ tipo: 'horario', frecuencia: 'intervalo', minutos: 0 }), { code: 'INVALID_ACTIVATION' });
  const event = normalizeActivation({ tipo: 'evento', carpeta: 'b'.repeat(64), subcarpeta: 'notas', extensiones: ['md'] });
  assert.deepEqual(matchingChanges(event, { added: ['notas/a.md', 'notas2/b.md', 'notas/c.txt'] }).agregados, ['notas/a.md']);
});

test('programador Windows describe la tarea sin instalarla y rechaza rutas con controles', async () => {
  const invocations = [];
  const scheduler = createSystemScheduler({ platform: 'win32', run: async (program, args) => {
    invocations.push({ program, args });
    return { code: args[0] === '/Query' ? 1 : 0, stdout: '', stderr: '', error: null };
  } });
  const plan = await scheduler.plan({ baseId: '12345678-1234-1234-1234-123456789abc', command: { program: 'C:\\Mind ficticio\\mind.cmd', args: ['programadas'] } });
  assert.equal(plan.kind, 'schtasks');
  assert.ok(plan.taskRun.includes('Mind ficticio'));
  assert.ok(!invocations.some((item) => item.args.includes('/Create')));
  await assert.rejects(launcherCommand({
    product: true, root: 'C:\\Mind\nficticio', baseDirectory: 'C:\\Base',
  }, { platform: 'win32' }), { code: 'SCHEDULER_PATH_INVALID' });
});
