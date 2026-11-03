import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openMotor, parseContinuityExport, formatContinuityMarkdown } from '../src/motor.js';

const motorDirectory = fileURLToPath(new URL('..', import.meta.url));
const development = path.dirname(motorDirectory);
const motorUrl = pathToFileURL(path.join(motorDirectory, 'src', 'motor.js')).href;

async function fixture(t, ...names) {
  const root = await fs.mkdtemp(path.join(development, '.mind-continuity-integration-test-'));
  t.after(async () => {
    assert.equal(path.dirname(root), development);
    assert.ok(path.basename(root).startsWith('.mind-continuity-integration-test-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const bases = [];
  for (const name of names.length > 0 ? names : ['Base ficticia']) {
    const base = path.join(root, name);
    await fs.mkdir(base);
    bases.push(base);
  }
  return { root, bases };
}

/** Un anfitrión en su propio proceso: abre el Motor, actúa y termina. */
function hostProcess(base, body) {
  const script = `
    const { openMotor } = await import(${JSON.stringify(motorUrl)});
    const motor = await openMotor({ baseDirectory: ${JSON.stringify(base)} });
    const result = await (async () => { ${body} })();
    process.stdout.write(JSON.stringify(result ?? null));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: development, encoding: 'utf8', timeout: 20_000,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('un agente registra un resultado y otro, autorizado en otro proceso, lo recupera y continúa', async (t) => {
  const { bases: [base] } = await fixture(t);

  // Anfitrión A (proceso propio): el agente A trabaja y registra; el proceso termina.
  const first = hostProcess(base, `
    const agentA = Object.freeze({});
    const permission = await motor.grantContinuityAccess({ requester: agentA, allowRecord: true, source: 'Anfitrión A · Agente A' });
    const view = motor.bindContinuityAgent({ requester: agentA, authorization: permission });
    const decision = await view.recordResult({ kind: 'decisión', content: { resumen: 'Usar el formato portable', pendiente: ['redactar informe'] } });
    const result = await view.recordResult({
      kind: 'resultado', content: 'Borrador ficticio terminado; falta revisar el informe.',
      references: [{ entry: decision.id, relation: 'aplica' }, { locator: 'carpeta:ficticia/notas/informe.txt', relation: 'archivo' }],
    });
    const note = await view.recordResult({ kind: 'nota interna', content: 'No compartir con otros agentes.' });
    return { decision: decision.id, result: result.id, note: note.id };
  `);

  // Anfitrión B (otro proceso y otro Motor): el usuario autoriza solo el resultado y lo que cita.
  const motor = await openMotor({ baseDirectory: base });
  const agentB = Object.freeze({});
  const permission = await motor.grantContinuityAccess({
    requester: agentB, ids: [first.result], includeReferenced: true, allowRecord: true, source: 'Anfitrión B · Agente B',
  });
  assert.deepEqual(motor.describeContinuityAccess(permission), {
    ids: [first.decision, first.result].sort(), allowRecord: true, source: 'Anfitrión B · Agente B', revoked: false,
  });
  const view = motor.bindContinuityAgent({ requester: agentB, authorization: permission });

  const context = parseContinuityExport(await view.readContext());
  assert.deepEqual(context.entries.map((entry) => entry.id), [first.decision, first.result]);
  assert.equal(context.entries[1].source, 'Anfitrión A · Agente A');
  assert.ok(!JSON.stringify(context).includes('No compartir'), 'La nota no seleccionada no se entrega');
  assert.deepEqual(context.missing, []);

  // El agente B continúa el trabajo citando lo que recibió.
  const continuation = await view.recordResult({
    kind: 'resultado', content: 'Informe ficticio revisado.',
    references: [{ entry: first.result, relation: 'continúa' }],
  });
  assert.equal(continuation.source, 'Anfitrión B · Agente B');
  await assert.rejects(view.recordResult({ content: 'x', references: [{ entry: first.note }] }), { code: 'CONTINUITY_ACCESS_DENIED' });

  // Un tercer proceso confirma lo persistido mediante la administración del Motor.
  const persisted = hostProcess(base, `
    const entry = await motor.getContinuity(${JSON.stringify(continuation.id)});
    return { entry, ids: await motor.listContinuityIds() };
  `);
  assert.deepEqual(persisted.entry, continuation);
  assert.deepEqual(persisted.ids, [first.decision, first.result, first.note, continuation.id].sort());
  // Solo registros de continuidad: ningún original ni copia en la Base.
  assert.deepEqual((await fs.readdir(base)).sort(),
    persisted.ids.map((id) => `continuity-${id}.json`).sort());
});

test('administración y funciones del agente están separadas', async (t) => {
  const { bases: [base] } = await fixture(t);
  const motor = await openMotor({ baseDirectory: base });
  for (const name of ['recordContinuity', 'getContinuity', 'updateContinuity', 'relateContinuity', 'retireContinuity',
    'listContinuityIds', 'exportContinuity', 'importContinuity', 'grantContinuityAccess', 'describeContinuityAccess',
    'revokeContinuityAccess', 'bindContinuityAgent']) {
    assert.equal(typeof motor[name], 'function', name);
  }
  // La lectura y el registro con permiso solo llegan al agente a través de su vista.
  assert.equal(Object.hasOwn(motor, 'readContinuityContext'), false);
  assert.equal(Object.hasOwn(motor, 'recordContinuityResult'), false);

  const agent = Object.freeze({});
  const entry = await motor.recordContinuity({ content: 'Contexto ficticio' });
  const view = motor.bindContinuityAgent({
    requester: agent, authorization: await motor.grantContinuityAccess({ requester: agent, ids: [entry.id] }),
  });
  assert.ok(Object.isFrozen(view));
  assert.deepEqual(Object.keys(view).sort(), ['readContext', 'recordResult']);
  // Sin allowRecord el agente solo consulta.
  await assert.rejects(view.recordResult({ content: 'x' }), { code: 'CONTINUITY_ACCESS_DENIED' });
  assert.deepEqual(await motor.listContinuityIds(), [entry.id]);
});

test('revocación, aislamiento de identidades y de instancias, y acceso denegado', async (t) => {
  const { bases: [base] } = await fixture(t);
  const motor = await openMotor({ baseDirectory: base });
  const shared = await motor.recordContinuity({ kind: 'instrucción', content: 'Compartible' });
  const secret = await motor.recordContinuity({ kind: 'nota', content: 'Privada' });
  const agentA = Object.freeze({ name: 'Agente' });
  const agentB = Object.freeze({ name: 'Agente' }); // Mismo nombre, otra identidad.
  const permission = await motor.grantContinuityAccess({ requester: agentA, ids: [shared.id], allowRecord: true });

  // Identidad por objeto: ni otro agente, ni una copia, ni un permiso copiado.
  for (const [requester, authorization] of [[agentB, permission], [{ ...agentA }, permission], [agentA, { ...permission }], [agentA, {}]]) {
    assert.throws(() => motor.bindContinuityAgent({ requester, authorization }), { code: 'CONTINUITY_ACCESS_DENIED' });
  }
  // Otra instancia del Motor sobre la misma Base no reconoce permisos ajenos.
  const other = await openMotor({ baseDirectory: base });
  assert.throws(() => other.bindContinuityAgent({ requester: agentA, authorization: permission }), { code: 'CONTINUITY_ACCESS_DENIED' });
  assert.equal(other.describeContinuityAccess(permission), null);

  const view = motor.bindContinuityAgent({ requester: agentA, authorization: permission });
  // Registros fuera de la selección o inexistentes: misma respuesta, sin revelar la Base.
  for (const entry of [secret.id, '00000000-0000-4000-8000-000000000000', 'no-es-id']) {
    await assert.rejects(view.recordResult({ content: 'x', references: [{ entry }] }), { code: 'CONTINUITY_ACCESS_DENIED' });
  }
  // Conceder exige una selección o el registro de resultados.
  await assert.rejects(motor.grantContinuityAccess({ requester: agentB }), { code: 'INVALID_CONTINUITY_FIELD' });
  await assert.rejects(motor.grantContinuityAccess({ requester: 'agente', ids: [shared.id] }), { code: 'INVALID_REQUESTER' });

  assert.equal(motor.revokeContinuityAccess(permission), true);
  assert.equal(motor.revokeContinuityAccess(permission), false);
  assert.equal(motor.describeContinuityAccess(permission).revoked, true);
  await assert.rejects(view.readContext(), { code: 'CONTINUITY_ACCESS_DENIED' });
  await assert.rejects(view.recordResult({ content: 'tras retirar' }), { code: 'CONTINUITY_ACCESS_DENIED' });
  assert.deepEqual((await motor.listContinuityIds()).sort(), [shared.id, secret.id].sort());
});

test('conserva los formatos flexibles y la exportación portable entre Bases', async (t) => {
  const { bases: [origin, destination] } = await fixture(t, 'Base origen', 'Base destino');
  const motor = await openMotor({ baseDirectory: origin });
  const agent = Object.freeze({});
  // Contenido sin estructura impuesta: texto, objeto y lista.
  const text = await motor.recordContinuity({ content: 'Solo texto' });
  const object = await motor.recordContinuity({ kind: 'decisión', content: { elegido: 'B', motivos: ['legible'] } });
  const list = await motor.recordContinuity({ content: [1, 'dos'], references: [{ entry: object.id }] });
  const view = motor.bindContinuityAgent({
    requester: agent, authorization: await motor.grantContinuityAccess({ requester: agent, ids: [text.id, list.id] }),
  });

  const json = await view.readContext();
  const pack = parseContinuityExport(json);
  assert.equal(pack.format, 'mind-continuity-export');
  // La referencia a un registro no seleccionado se conserva como id, sin contenido.
  assert.deepEqual(pack.entries.map((entry) => entry.id), [text.id, list.id]);
  assert.deepEqual(pack.entries[1].references, [{ entry: object.id }]);
  assert.ok(!json.includes('"elegido"'));
  const asObject = await view.readContext({ format: 'object' });
  assert.deepEqual(parseContinuityExport({ ...asObject, exportedAt: pack.exportedAt }), pack);
  const markdown = await view.readContext({ format: 'markdown' });
  assert.match(markdown, /^# Continuidad exportada de Mind/);
  assert.equal(formatContinuityMarkdown(json).split('\n')[0], markdown.split('\n')[0]);

  // El paquete del agente se importa en otra Base con la administración del Motor.
  const target = await openMotor({ baseDirectory: destination });
  assert.deepEqual(await target.importContinuity(json), { imported: [text.id, list.id], unchanged: [] });
  assert.deepEqual(await target.getContinuity(list.id), list);
  // La exportación administrativa completa sigue disponible para el anfitrión.
  const full = await motor.exportContinuity({ ids: [list.id], includeReferenced: true });
  assert.deepEqual(full.entries.map((entry) => entry.id), [list.id, object.id]);
});
