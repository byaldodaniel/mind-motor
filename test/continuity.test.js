import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openMotor } from '../src/motor.js';
import {
  createContinuity, parseContinuityExport, formatContinuityMarkdown, CONTINUITY_LIMITS,
} from '../src/continuity.js';

const motorDirectory = fileURLToPath(new URL('..', import.meta.url));
const developmentDirectory = path.dirname(motorDirectory);
const moduleUrl = pathToFileURL(path.join(motorDirectory, 'src', 'continuity.js')).href;
const motorUrl = pathToFileURL(path.join(motorDirectory, 'src', 'motor.js')).href;

async function fixture(t, ...names) {
  const root = await fs.mkdtemp(path.join(developmentDirectory, '.mind-continuity-test-'));
  t.after(async () => {
    assert.equal(path.dirname(root), developmentDirectory);
    assert.ok(path.basename(root).startsWith('.mind-continuity-test-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const bases = [];
  for (const name of names.length > 0 ? names : ['Base']) {
    const base = path.join(root, name);
    await fs.mkdir(base);
    const motor = await openMotor({ baseDirectory: base });
    bases.push({ base, motor, continuity: createContinuity(motor) });
  }
  return { root, bases };
}

/** Ejecuta una operación en un proceso nuevo que termina al finalizar. */
function inProcess(base, body) {
  const script = `
    const { openMotor } = await import(${JSON.stringify(motorUrl)});
    const { createContinuity } = await import(${JSON.stringify(moduleUrl)});
    const continuity = createContinuity(await openMotor({ baseDirectory: ${JSON.stringify(base)} }));
    const result = await (async () => { ${body} })();
    process.stdout.write(JSON.stringify(result ?? null));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: developmentDirectory, encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function storedFile(base, id) {
  return path.join(base, `continuity-${id}.json`);
}

test('registra contenido flexible y lo recupera por id sin crear nada al abrir', async (t) => {
  const { bases: [{ base, continuity }] } = await fixture(t);
  assert.deepEqual(await fs.readdir(base), []);
  assert.deepEqual(await continuity.listContinuityIds(), []);

  const decision = await continuity.recordContinuity({
    kind: 'decisión', source: 'Anfitrión de prueba',
    content: { resumen: 'Usar formato JSON portable', motivos: ['legible', 'sin dependencias'], prioridad: 2, vigente: true, nota: null },
  });
  const instruction = await continuity.recordContinuity({ content: 'Responder en español 🙂' });
  const result = await continuity.recordContinuity({ content: [1, 'dos', { tres: 3 }], kind: 'resultado' });

  assert.match(decision.id, /^[a-f0-9-]{36}$/);
  assert.equal(decision.revision, 1);
  assert.equal(decision.createdAt, decision.updatedAt);
  assert.deepEqual(instruction.references, []);
  assert.equal(instruction.kind, null);
  assert.equal(instruction.source, null);
  assert.deepEqual(await continuity.getContinuity(decision.id), decision);
  assert.deepEqual(await continuity.getContinuity(instruction.id), instruction);
  assert.deepEqual(await continuity.getContinuity(result.id), result);
  assert.equal(await continuity.getContinuity('00000000-0000-4000-8000-000000000000'), null);
  assert.deepEqual(
    await continuity.listContinuityIds(),
    [decision.id, instruction.id, result.id].sort(),
  );
  const stored = JSON.parse(await fs.readFile(storedFile(base, decision.id), 'utf8'));
  assert.equal(stored.format, 'mind-continuity-entry');
  assert.equal(stored.version, 1);
});

test('los registros persisten entre procesos terminados y Motores distintos', async (t) => {
  const { bases: [{ base }] } = await fixture(t);
  const created = inProcess(base, `
    const first = await continuity.recordContinuity({ kind: 'instrucción', content: 'Texto ficticio persistente' });
    return continuity.recordContinuity({ content: { paso: 2 }, references: [{ entry: first.id, relation: 'continúa' }] });
  `);
  const reread = inProcess(base, `return continuity.getContinuity(${JSON.stringify(created.id)});`);
  assert.deepEqual(reread, created);
  const updated = inProcess(base, `
    return continuity.updateContinuity(${JSON.stringify(created.id)}, { content: { paso: 3 } }, { expectedRevision: 1 });
  `);
  assert.equal(updated.revision, 2);
  const motor = await openMotor({ baseDirectory: base });
  assert.deepEqual(await createContinuity(motor).getContinuity(created.id), updated);
});

test('dos Bases mantienen continuidad independiente', async (t) => {
  const { bases: [first, second] } = await fixture(t, 'Base A', 'Base B');
  const entry = await first.continuity.recordContinuity({ content: 'solo en A' });
  assert.equal(await second.continuity.getContinuity(entry.id), null);
  assert.deepEqual(await second.continuity.listContinuityIds(), []);
});

test('actualiza campos indicados, conserva los demás y detecta revisiones obsoletas', async (t) => {
  const { bases: [{ continuity }] } = await fixture(t);
  const entry = await continuity.recordContinuity({ kind: 'resultado', source: 'Agente A', content: 'v1' });
  const updated = await continuity.updateContinuity(entry.id, { content: 'v2' }, { expectedRevision: 1 });
  assert.equal(updated.revision, 2);
  assert.equal(updated.kind, 'resultado');
  assert.equal(updated.source, 'Agente A');
  assert.equal(updated.createdAt, entry.createdAt);
  assert.ok(updated.updatedAt >= entry.updatedAt);
  await assert.rejects(
    continuity.updateContinuity(entry.id, { content: 'perdido' }, { expectedRevision: 1 }),
    { code: 'CONTINUITY_REVISION_CONFLICT' },
  );
  const cleared = await continuity.updateContinuity(entry.id, { kind: null });
  assert.equal(cleared.kind, null);
  assert.equal(cleared.content, 'v2');
  await assert.rejects(continuity.updateContinuity(entry.id, {}), { code: 'INVALID_CONTINUITY_FIELD' });
  await assert.rejects(
    continuity.updateContinuity('00000000-0000-4000-8000-000000000000', { content: 'x' }),
    { code: 'CONTINUITY_NOT_FOUND' },
  );
  await assert.rejects(continuity.updateContinuity(entry.id, { proyecto: 'x' }), { code: 'INVALID_CONTINUITY_FIELD' });
});

test('relaciona referencias con registros existentes y localizadores externos', async (t) => {
  const { bases: [{ continuity }] } = await fixture(t);
  const decision = await continuity.recordContinuity({ kind: 'decisión', content: 'A' });
  const task = await continuity.recordContinuity({ content: 'B' });

  const related = await continuity.relateContinuity(task.id, [
    { entry: decision.id, relation: 'depende de' },
    { locator: 'https://example.invalid/issue/1' },
    { entry: decision.id, relation: 'depende de' },
  ]);
  assert.equal(related.revision, 2);
  assert.deepEqual(related.references, [
    { entry: decision.id, relation: 'depende de' },
    { locator: 'https://example.invalid/issue/1' },
  ]);
  // Repetir la misma relación no crea una revisión nueva.
  assert.deepEqual(await continuity.relateContinuity(task.id, [{ locator: 'https://example.invalid/issue/1' }]), related);

  await assert.rejects(
    continuity.relateContinuity(task.id, [{ entry: '00000000-0000-4000-8000-000000000000' }]),
    { code: 'CONTINUITY_REFERENCE_NOT_FOUND' },
  );
  await assert.rejects(continuity.relateContinuity(task.id, [{ entry: task.id }]), { code: 'INVALID_CONTINUITY_REFERENCE' });
  await assert.rejects(
    continuity.relateContinuity(task.id, [{ entry: decision.id, locator: 'x' }]),
    { code: 'INVALID_CONTINUITY_REFERENCE' },
  );
  await assert.rejects(continuity.relateContinuity(task.id, [{ locator: '' }]), { code: 'INVALID_CONTINUITY_FIELD' });
  await assert.rejects(continuity.relateContinuity(task.id, []), { code: 'INVALID_CONTINUITY_REFERENCE' });
  await assert.rejects(
    continuity.relateContinuity(task.id, [{ locator: 'otra' }], { expectedRevision: 1 }),
    { code: 'CONTINUITY_REVISION_CONFLICT' },
  );
  await assert.rejects(
    continuity.recordContinuity({ content: 'x', references: [{ entry: '00000000-0000-4000-8000-000000000000' }] }),
    { code: 'CONTINUITY_REFERENCE_NOT_FOUND' },
  );
  const many = Array.from({ length: CONTINUITY_LIMITS.references + 1 }, (_, index) => ({ locator: `ref-${index}` }));
  await assert.rejects(continuity.relateContinuity(task.id, many), { code: 'INVALID_CONTINUITY_REFERENCE' });
});

test('retira registros; las referencias restantes quedan como no disponibles', async (t) => {
  const { bases: [{ base, continuity }] } = await fixture(t);
  const target = await continuity.recordContinuity({ content: 'se retirará' });
  const holder = await continuity.recordContinuity({ content: 'conserva', references: [{ entry: target.id }] });
  await assert.rejects(continuity.retireContinuity(target.id, { expectedRevision: 2 }), { code: 'CONTINUITY_REVISION_CONFLICT' });
  assert.equal(await continuity.retireContinuity(target.id, { expectedRevision: 1 }), true);
  assert.equal(await continuity.retireContinuity(target.id), false);
  assert.equal(await continuity.getContinuity(target.id), null);
  assert.deepEqual(await fs.readdir(base), [path.basename(storedFile(base, holder.id))]);
  const pack = await continuity.exportContinuity({ ids: [holder.id] });
  assert.deepEqual(pack.missing, [target.id]);
});

test('rechaza contenido no portable, campos no admitidos e ids inválidos', async (t) => {
  const { bases: [{ base, continuity }] } = await fixture(t);
  for (const content of [undefined, Number.NaN, Infinity, () => 1, new Date(), new Map(), 1n, Symbol('x'),
    'mal\uD800formado', { [Symbol('x')]: 1 }, [undefined]]) {
    await assert.rejects(continuity.recordContinuity({ content }), { code: 'INVALID_CONTINUITY_CONTENT' });
  }
  let deep = 'fondo';
  for (let index = 0; index <= CONTINUITY_LIMITS.contentDepth + 1; index += 1) deep = [deep];
  await assert.rejects(continuity.recordContinuity({ content: deep }), { code: 'INVALID_CONTINUITY_CONTENT' });
  await assert.rejects(
    continuity.recordContinuity({ content: 'x'.repeat(CONTINUITY_LIMITS.contentBytes) }),
    { code: 'CONTINUITY_TOO_LARGE' },
  );
  await assert.rejects(continuity.recordContinuity({ content: 'x', proyecto: 'p' }), { code: 'INVALID_CONTINUITY_FIELD' });
  await assert.rejects(continuity.recordContinuity({ content: 'x', kind: 'a\nb' }), { code: 'INVALID_CONTINUITY_FIELD' });
  await assert.rejects(continuity.recordContinuity({ content: 'x', source: '' }), { code: 'INVALID_CONTINUITY_FIELD' });
  await assert.rejects(continuity.recordContinuity('texto'), { code: 'INVALID_CONTINUITY_FIELD' });
  for (const id of ['../x', 'con', '', 'ABCDEF00-0000-4000-8000-000000000000', null]) {
    await assert.rejects(continuity.getContinuity(id), { code: 'INVALID_CONTINUITY_ID' });
  }
  assert.throws(() => createContinuity({}), { code: 'INVALID_BASE' });
  assert.throws(() => createContinuity({ baseDirectory: 'relativa' }), { code: 'INVALID_BASE' });
  // Los objetos con prototipo nulo y claves especiales se conservan como datos.
  const odd = JSON.parse('{"__proto__": {"x": 1}, "constructor": "y"}');
  const entry = await continuity.recordContinuity({ content: odd });
  assert.deepEqual(JSON.parse(JSON.stringify((await continuity.getContinuity(entry.id)).content)), odd);
  assert.equal(Object.getPrototypeOf((await continuity.getContinuity(entry.id)).content), Object.prototype);
  assert.deepEqual(await fs.readdir(base), [path.basename(storedFile(base, entry.id))]);
});

test('detecta registros corruptos, enlazados o de versiones no compatibles', async (t) => {
  const { root, bases: [{ base, continuity }] } = await fixture(t);
  const entry = await continuity.recordContinuity({ content: 'íntegro' });
  const file = storedFile(base, entry.id);
  const original = JSON.parse(await fs.readFile(file, 'utf8'));

  await fs.writeFile(file, '{no es json');
  await assert.rejects(continuity.getContinuity(entry.id), { code: 'RECORD_CORRUPT' });

  for (const variant of [
    { ...original, id: '00000000-0000-4000-8000-000000000000' },
    { ...original, revision: 0 },
    { ...original, extra: true },
    { ...original, content: undefined },
    { ...original, references: [{ entry: 'no-es-id' }] },
    { ...original, references: [{ locator: 'a' }, { locator: 'a' }] },
    { ...original, updatedAt: '2000-01-01T00:00:00.000Z' },
    { ...original, format: 'otro' },
    [original],
  ]) {
    await fs.writeFile(file, JSON.stringify(variant));
    await assert.rejects(continuity.getContinuity(entry.id), { code: 'CONTINUITY_CORRUPT' });
  }
  await fs.writeFile(file, JSON.stringify({ ...original, version: 2 }));
  await assert.rejects(continuity.getContinuity(entry.id), { code: 'CONTINUITY_UNSUPPORTED_VERSION' });
  // Un fallo de lectura no repara ni reescribe el archivo.
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).version, 2);

  await fs.rm(file);
  const outside = path.join(root, 'fuera.json');
  await fs.writeFile(outside, JSON.stringify(original));
  try {
    await fs.symlink(outside, file, 'file');
  } catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') {
      t.diagnostic('Windows sin privilegio para enlaces de archivo; se omite la comprobación del enlace.');
      return;
    }
    throw error;
  }
  await assert.rejects(continuity.getContinuity(entry.id), { code: 'RECORD_LINK' });
  await assert.rejects(continuity.updateContinuity(entry.id, { content: 'x' }), { code: 'RECORD_LINK' });
  assert.equal(JSON.parse(await fs.readFile(outside, 'utf8')).content, 'íntegro');
});

test('exporta selección portable, sigue referencias si se pide e importa en otra Base', async (t) => {
  const { bases: [origin, destination] } = await fixture(t, 'Base origen', 'Base destino');
  const root = await origin.continuity.recordContinuity({ kind: 'instrucción', content: 'Contexto base' });
  const middle = await origin.continuity.recordContinuity({
    kind: 'decisión', content: { elegido: 'B' }, references: [{ entry: root.id, relation: 'parte de' }],
  });
  const leaf = await origin.continuity.recordContinuity({
    kind: 'resultado', source: 'Agente ficticio', content: 'Hecho', references: [
      { entry: middle.id }, { locator: 'carpeta:abc/notas/ejemplo.txt', relation: 'archivo' },
    ],
  });
  const unrelated = await origin.continuity.recordContinuity({ content: 'no seleccionado' });

  const only = await origin.continuity.exportContinuity({ ids: [leaf.id] });
  assert.deepEqual(only.entries.map((entry) => entry.id), [leaf.id]);
  assert.deepEqual(only.missing, []);

  const pack = await origin.continuity.exportContinuity({ ids: [leaf.id, leaf.id], includeReferenced: true });
  assert.deepEqual(pack.entries.map((entry) => entry.id), [leaf.id, middle.id, root.id]);
  assert.ok(!pack.entries.some((entry) => entry.id === unrelated.id));
  assert.equal(pack.format, 'mind-continuity-export');

  const text = JSON.stringify(pack, null, 2);
  assert.deepEqual(parseContinuityExport(text), parseContinuityExport(pack));

  const markdown = formatContinuityMarkdown(text);
  assert.match(markdown, /^# Continuidad exportada de Mind/);
  assert.match(markdown, /## resultado · /);
  assert.match(markdown, /Origen declarado: Agente ficticio/);
  assert.match(markdown, /archivo: carpeta:abc\/notas\/ejemplo\.txt/);
  assert.ok(markdown.includes('"elegido": "B"'));

  assert.deepEqual(await destination.continuity.importContinuity(text), {
    imported: [leaf.id, middle.id, root.id], unchanged: [],
  });
  for (const entry of [leaf, middle, root]) {
    assert.deepEqual(await destination.continuity.getContinuity(entry.id), entry);
  }
  assert.deepEqual(await destination.continuity.importContinuity(pack), {
    imported: [], unchanged: [leaf.id, middle.id, root.id],
  });

  // Ante un conflicto no se escribe ningún registro del paquete.
  await destination.continuity.updateContinuity(root.id, { content: 'editado en destino' });
  await destination.continuity.retireContinuity(leaf.id);
  await assert.rejects(destination.continuity.importContinuity(pack), { code: 'CONTINUITY_CONFLICT' });
  assert.equal(await destination.continuity.getContinuity(leaf.id), null);

  await assert.rejects(origin.continuity.exportContinuity({ ids: [] }), { code: 'INVALID_CONTINUITY_FIELD' });
  await assert.rejects(
    origin.continuity.exportContinuity({ ids: ['00000000-0000-4000-8000-000000000000'] }),
    { code: 'CONTINUITY_NOT_FOUND' },
  );
});

test('el Markdown no permite que el contenido rompa su bloque', async (t) => {
  const { bases: [{ continuity }] } = await fixture(t);
  const entry = await continuity.recordContinuity({ kind: '# título falso', content: 'antes\n````\n# encabezado inyectado\n```' });
  const markdown = formatContinuityMarkdown(await continuity.exportContinuity({ ids: [entry.id] }));
  assert.match(markdown, /\n`````\nantes\n````\n# encabezado inyectado\n```\n`````/);
  assert.match(markdown, /## \\# título falso/);
});

test('rechaza paquetes de exportación inválidos o de versiones no compatibles', async (t) => {
  const { bases: [{ continuity }] } = await fixture(t);
  const entry = await continuity.recordContinuity({ content: 'x' });
  const pack = await continuity.exportContinuity({ ids: [entry.id] });
  for (const invalid of [
    '{', '[]', { ...pack, format: 'otro' }, { ...pack, extra: 1 }, { ...pack, entries: {} },
    { ...pack, entries: [pack.entries[0], pack.entries[0]] },
    { ...pack, missing: [entry.id] }, { ...pack, missing: ['x'] },
    { ...pack, entries: [{ ...pack.entries[0], content: undefined }] },
  ]) {
    assert.throws(() => parseContinuityExport(invalid), { code: 'CONTINUITY_EXPORT_INVALID' });
  }
  assert.throws(() => parseContinuityExport({ ...pack, version: 2 }), { code: 'CONTINUITY_UNSUPPORTED_VERSION' });
  assert.throws(
    () => parseContinuityExport({ ...pack, entries: [{ ...pack.entries[0], version: 9 }] }),
    { code: 'CONTINUITY_UNSUPPORTED_VERSION' },
  );
  // Un paquete importado no puede escribir fuera de la Base mediante su id.
  const escape = { ...pack, entries: [{ ...pack.entries[0], id: '../../fuera' }] };
  await assert.rejects(continuity.importContinuity(escape), { code: 'CONTINUITY_EXPORT_INVALID' });
});
