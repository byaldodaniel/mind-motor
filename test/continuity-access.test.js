import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openMotor } from '../src/motor.js';
import { createContinuity, parseContinuityExport } from '../src/continuity.js';
import { createContinuityAccess } from '../src/continuity-access.js';

const motorDirectory = fileURLToPath(new URL('..', import.meta.url));
const developmentDirectory = path.dirname(motorDirectory);
const demo = path.join(motorDirectory, 'examples', 'continuidad-entre-agentes.mjs');
const PREFIX = '.mind-continuity-access-test-';

async function fixture(t, ...names) {
  const root = await fs.mkdtemp(path.join(developmentDirectory, PREFIX));
  t.after(async () => {
    assert.equal(path.dirname(root), developmentDirectory);
    assert.ok(path.basename(root).startsWith(PREFIX));
    await fs.rm(root, { recursive: true, force: true });
  });
  const bases = [];
  for (const name of names.length > 0 ? names : ['Base']) {
    const base = path.join(root, name);
    await fs.mkdir(base);
    const continuity = createContinuity(await openMotor({ baseDirectory: base }));
    bases.push({ base, continuity, access: createContinuityAccess(continuity) });
  }
  return { root, bases };
}

async function rejectsWith(promiseOrFn, code) {
  await assert.rejects(typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn, (error) => error.code === code);
}

/** Decisión → resultado (con localizador) y una nota no relacionada, como en un trabajo real. */
async function seed(continuity) {
  const decision = await continuity.recordContinuity({ kind: 'decisión', content: { resumen: 'Usar JSON' } });
  const result = await continuity.recordContinuity({
    kind: 'resultado', content: 'Esquema redactado',
    references: [{ entry: decision.id, relation: 'aplica' }, { locator: 'carpeta/esquema.md', relation: 'documento' }],
  });
  const note = await continuity.recordContinuity({ kind: 'nota privada', content: 'No compartir' });
  return { decision, result, note };
}

test('conectar un agente no concede nada: hace falta una selección o el permiso de registro', async (t) => {
  const { bases: [{ continuity, access }] } = await fixture(t);
  const { note } = await seed(continuity);
  const agent = {};
  await rejectsWith(access.grantContinuityAccess({ requester: agent }), 'INVALID_CONTINUITY_FIELD');
  await rejectsWith(access.grantContinuityAccess({ requester: agent, ids: [] }), 'INVALID_CONTINUITY_FIELD');
  await rejectsWith(access.grantContinuityAccess({ ids: [note.id] }), 'INVALID_REQUESTER');
  await rejectsWith(access.grantContinuityAccess({ requester: 'Agente B', ids: [note.id] }), 'INVALID_REQUESTER');
  await rejectsWith(access.grantContinuityAccess({ requester: agent, ids: ['todo'] }), 'INVALID_CONTINUITY_ID');
  await rejectsWith(access.grantContinuityAccess({ requester: agent, ids: ['00000000-0000-4000-8000-000000000000'] }), 'CONTINUITY_NOT_FOUND');
  await rejectsWith(access.grantContinuityAccess({ requester: agent, ids: [note.id], scope: 'all' }), 'INVALID_CONTINUITY_FIELD');
  await rejectsWith(access.grantContinuityAccess({ requester: agent, allowRecord: true, source: 'a\nb' }), 'INVALID_CONTINUITY_FIELD');
  assert.throws(() => createContinuityAccess({}), (error) => error.code === 'INVALID_CONTINUITY_FIELD');

  // Una concesión de solo registro no expone registros previos.
  const authorization = await access.grantContinuityAccess({ requester: agent, allowRecord: true });
  const view = access.bindContinuityAgent({ requester: agent, authorization });
  assert.deepEqual(Object.keys(view).sort(), ['readContext', 'recordResult']);
  assert.ok(Object.isFrozen(view));
  const pack = await view.readContext({ format: 'object' });
  assert.deepEqual(pack.entries, []);
  assert.deepEqual(pack.missing, []);
  parseContinuityExport(pack);
});

test('el agente recibe únicamente los registros seleccionados, con sus relaciones', async (t) => {
  const { bases: [{ continuity, access }] } = await fixture(t);
  const { decision, result, note } = await seed(continuity);
  const agent = {};

  const onlyResult = await access.grantContinuityAccess({ requester: agent, ids: [result.id] });
  const narrow = await access.readContinuityContext({ requester: agent, authorization: onlyResult, format: 'object' });
  assert.deepEqual(narrow.entries.map((entry) => entry.id), [result.id]);
  // La referencia se conserva como id, sin contenido ni indicio de si existe.
  assert.deepEqual(narrow.entries[0].references, result.references);
  assert.deepEqual(narrow.missing, []);
  assert.ok(!JSON.stringify(narrow).includes('Usar JSON'));

  const withReferenced = await access.grantContinuityAccess({ requester: agent, ids: [result.id], includeReferenced: true });
  assert.deepEqual(access.describeContinuityAccess(withReferenced),
    { ids: [decision.id, result.id].sort(), allowRecord: false, source: null, revoked: false });
  const pack = await access.readContinuityContext({ requester: agent, authorization: withReferenced, format: 'object' });
  assert.deepEqual(pack.entries.map((entry) => entry.id), [decision.id, result.id]);
  assert.deepEqual(pack.entries.map(({ format, version, ...entry }) => entry), [decision, result]);
  assert.ok(!JSON.stringify(pack).includes(note.id));
  assert.ok(!JSON.stringify(pack).includes('No compartir'));
});

test('la selección se fija al conceder: relaciones posteriores no amplían el acceso', async (t) => {
  const { bases: [{ continuity, access }] } = await fixture(t);
  const { decision, result, note } = await seed(continuity);
  const agent = {};
  const authorization = await access.grantContinuityAccess({ requester: agent, ids: [result.id], includeReferenced: true });
  await continuity.relateContinuity(result.id, [{ entry: note.id, relation: 'ver' }]);

  const pack = await access.readContinuityContext({ requester: agent, authorization, format: 'object' });
  assert.deepEqual(pack.entries.map((entry) => entry.id), [decision.id, result.id]);
  // Ve la revisión vigente del registro elegido, incluida la nueva relación, no el contenido citado.
  assert.equal(pack.entries[1].revision, 2);
  assert.deepEqual(pack.entries[1].references.at(-1), { entry: note.id, relation: 'ver' });
  assert.ok(!JSON.stringify(pack).includes('No compartir'));

  // Retirar un registro seleccionado lo informa como no disponible; los ajenos no se mencionan.
  await continuity.retireContinuity(decision.id);
  await continuity.retireContinuity(note.id);
  const after = await access.readContinuityContext({ requester: agent, authorization, format: 'object' });
  assert.deepEqual(after.entries.map((entry) => entry.id), [result.id]);
  assert.deepEqual(after.missing, [decision.id]);
});

test('el permiso está ligado a la identidad del solicitante y a esta instancia', async (t) => {
  const { bases: [{ base, continuity, access }] } = await fixture(t);
  const { result } = await seed(continuity);
  const agent = {};
  const other = {};
  const authorization = await access.grantContinuityAccess({ requester: agent, ids: [result.id], allowRecord: true });
  const read = (request) => access.readContinuityContext(request);

  await rejectsWith(read({ requester: other, authorization }), 'CONTINUITY_ACCESS_DENIED');
  await rejectsWith(read({ requester: { ...agent }, authorization }), 'CONTINUITY_ACCESS_DENIED');
  await rejectsWith(read({ requester: agent, authorization: {} }), 'CONTINUITY_ACCESS_DENIED');
  await rejectsWith(read({ requester: agent, authorization: JSON.parse(JSON.stringify(authorization)) }), 'CONTINUITY_ACCESS_DENIED');
  await rejectsWith(read({ requester: agent, authorization, format: 'html' }), 'INVALID_CONTINUITY_FIELD');
  await rejectsWith(read({ requester: agent, authorization, ids: [result.id] }), 'INVALID_CONTINUITY_FIELD');
  await rejectsWith(access.recordContinuityResult({ requester: other, authorization, result: { content: 'x' } }), 'CONTINUITY_ACCESS_DENIED');
  assert.throws(() => access.bindContinuityAgent({ requester: other, authorization }),
    (error) => error.code === 'CONTINUITY_ACCESS_DENIED');

  // Otra instancia del acceso sobre la misma Base no reconoce el permiso.
  const second = createContinuityAccess(createContinuity(await openMotor({ baseDirectory: base })));
  await rejectsWith(second.readContinuityContext({ requester: agent, authorization }), 'CONTINUITY_ACCESS_DENIED');
  assert.equal(second.describeContinuityAccess(authorization), null);

  const view = access.bindContinuityAgent({ requester: agent, authorization });
  assert.equal(access.revokeContinuityAccess(authorization), true);
  assert.equal(access.revokeContinuityAccess(authorization), false);
  assert.equal(access.revokeContinuityAccess({}), false);
  await rejectsWith(view.readContext(), 'CONTINUITY_ACCESS_DENIED');
  await rejectsWith(view.recordResult({ content: 'tarde' }), 'CONTINUITY_ACCESS_DENIED');
  assert.equal(access.describeContinuityAccess(authorization).revoked, true);
});

test('los resultados nuevos se registran con el origen fijado por el anfitrión', async (t) => {
  const { bases: [{ continuity, access }] } = await fixture(t);
  const { decision, result, note } = await seed(continuity);
  const reader = {};
  const readOnly = await access.grantContinuityAccess({ requester: reader, ids: [result.id] });
  await rejectsWith(access.recordContinuityResult({ requester: reader, authorization: readOnly, result: { content: 'x' } }),
    'CONTINUITY_ACCESS_DENIED');

  const agent = {};
  const authorization = await access.grantContinuityAccess({
    requester: agent, ids: [result.id], allowRecord: true, source: 'Anfitrión de prueba · Agente',
  });
  const view = access.bindContinuityAgent({ requester: agent, authorization });
  await rejectsWith(view.recordResult({ content: 'x', source: 'Otro agente' }), 'INVALID_CONTINUITY_FIELD');
  await rejectsWith(view.recordResult('texto suelto'), 'INVALID_CONTINUITY_FIELD');
  await rejectsWith(view.recordResult({ content: undefined }), 'INVALID_CONTINUITY_CONTENT');
  // Citar un registro no seleccionado o inexistente produce la misma respuesta.
  await rejectsWith(view.recordResult({ content: 'x', references: [{ entry: decision.id }] }), 'CONTINUITY_ACCESS_DENIED');
  await rejectsWith(view.recordResult({ content: 'x', references: [{ entry: note.id }] }), 'CONTINUITY_ACCESS_DENIED');
  await rejectsWith(view.recordResult({ content: 'x', references: [{ entry: '00000000-0000-4000-8000-000000000000' }] }),
    'CONTINUITY_ACCESS_DENIED');
  await rejectsWith(view.recordResult({ content: 'x', references: [{ entry: 'no-es-id' }] }), 'CONTINUITY_ACCESS_DENIED');
  await rejectsWith(view.recordResult({ content: 'x', references: [{ entry: result.id, extra: 1 }] }), 'INVALID_CONTINUITY_REFERENCE');
  assert.equal((await continuity.listContinuityIds()).length, 3);

  const first = await view.recordResult({
    kind: 'resultado', content: { hecho: 'Validado' },
    references: [{ entry: result.id, relation: 'continúa' }, { locator: 'https://ejemplo.invalid/acta', relation: 'acta' }],
  });
  assert.equal(first.source, 'Anfitrión de prueba · Agente');
  assert.deepEqual(await continuity.getContinuity(first.id), first);
  // Sus propios resultados quedan dentro de su contexto y puede encadenarlos.
  const second = await view.recordResult({ content: 'Siguiente paso', references: [{ entry: first.id, relation: 'continúa' }] });
  const pack = await view.readContext({ format: 'object' });
  assert.deepEqual(pack.entries.map((entry) => entry.id), [result.id, first.id, second.id]);

  // Otro agente solo los ve si su anfitrión los selecciona.
  const next = {};
  const handoff = await access.grantContinuityAccess({ requester: next, ids: [second.id], includeReferenced: true });
  const received = await access.readContinuityContext({ requester: next, authorization: handoff, format: 'object' });
  assert.deepEqual(received.entries.map((entry) => entry.id).sort(), [decision.id, result.id, first.id, second.id].sort());
  assert.ok(!JSON.stringify(received).includes(note.id));
});

test('el contexto es portable: JSON importable en otra Base y Markdown legible', async (t) => {
  const { bases: [origin, target] } = await fixture(t, 'Origen', 'Destino');
  const { decision, result, note } = await seed(origin.continuity);
  const agent = {};
  const authorization = await origin.access.grantContinuityAccess({ requester: agent, ids: [result.id], includeReferenced: true });
  const view = origin.access.bindContinuityAgent({ requester: agent, authorization });

  const json = await view.readContext();
  assert.equal(typeof json, 'string');
  const { exportedAt, ...object } = await view.readContext({ format: 'object' });
  assert.deepEqual({ ...JSON.parse(json), exportedAt: undefined }, { ...object, exportedAt: undefined });
  assert.deepEqual(await target.continuity.importContinuity(json), { imported: [decision.id, result.id], unchanged: [] });
  assert.deepEqual(await target.continuity.getContinuity(result.id), result);
  assert.equal(await target.continuity.getContinuity(note.id), null);

  const markdown = await view.readContext({ format: 'markdown' });
  assert.match(markdown, /^# Continuidad exportada de Mind/);
  assert.match(markdown, /## decisión · /);
  assert.match(markdown, /- aplica: registro /);
  assert.match(markdown, /- documento: carpeta\/esquema\.md/);
  assert.ok(!markdown.includes('No compartir'));
});

test('los localizadores no se abren ni se copian originales', async (t) => {
  const { root, bases: [{ base, continuity, access }] } = await fixture(t);
  const original = path.join(root, 'original.txt');
  await fs.writeFile(original, 'CONTENIDO-ORIGINAL-FICTICIO');
  const entry = await continuity.recordContinuity({
    content: 'Revisar el original', references: [{ locator: original, relation: 'original' }],
  });
  const agent = {};
  const authorization = await access.grantContinuityAccess({ requester: agent, ids: [entry.id], allowRecord: true });
  const view = access.bindContinuityAgent({ requester: agent, authorization });
  await view.recordResult({ content: 'Revisado', references: [{ entry: entry.id }, { locator: original }] });
  for (const format of ['json', 'markdown']) {
    assert.ok(!(await view.readContext({ format })).includes('CONTENIDO-ORIGINAL-FICTICIO'));
  }
  const files = await fs.readdir(base);
  assert.equal(files.length, 2);
  assert.ok(files.every((name) => /^continuity-[a-f0-9-]{36}\.json$/.test(name)));
});

test('demostración: dos anfitriones en procesos distintos continúan un trabajo', async (t) => {
  const { root, bases: [{ base: unused }] } = await fixture(t);
  await fs.rmdir(unused);
  const run = spawnSync(process.execPath, [demo, root], { cwd: developmentDirectory, encoding: 'utf8', timeout: 60_000 });
  assert.equal(run.status, 0, run.stderr);
  const line = run.stdout.split(/\r?\n/).find((text) => text.startsWith('RESUMEN '));
  const { base, a, b } = JSON.parse(line.slice('RESUMEN '.length));
  assert.equal(path.dirname(path.dirname(base)), root);

  assert.deepEqual(b.granted, [a.decision, a.result].sort());
  assert.deepEqual(b.received, [a.decision, a.result]);
  assert.equal(b.unselected, 'CONTINUITY_ACCESS_DENIED');
  assert.equal(b.afterRevoke, 'CONTINUITY_ACCESS_DENIED');
  assert.ok(!run.stdout.includes('Borrador descartado'));

  // Lo comprobado proviene de la Base real, abierta de nuevo con el núcleo.
  const continuity = createContinuity(await openMotor({ baseDirectory: base }));
  assert.deepEqual((await continuity.listContinuityIds()).sort(), [a.decision, a.result, a.note, b.continuation].sort());
  const continuation = await continuity.getContinuity(b.continuation);
  assert.equal(continuation.source, 'Anfitrión B · Agente B');
  assert.deepEqual(continuation.references, [
    { entry: a.result, relation: 'continúa' }, { entry: a.decision, relation: 'aplica' },
  ]);
  assert.equal(continuation.content.hecho, 'Validar el esquema con tres ejemplos: completado');
  assert.deepEqual(continuation.content.pendientes, ['Redactar la guía de uso']);
  assert.equal((await continuity.getContinuity(a.result)).source, 'Anfitrión A · Agente A');
});
