import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openMotor } from '../src/motor.js';
import { createFunctionRegistry } from '../src/functions.js';

const motorDirectory = fileURLToPath(new URL('..', import.meta.url));
const developmentDirectory = path.dirname(motorDirectory);
const registryUrl = new URL('../src/functions.js', import.meta.url).href;
const motorUrl = new URL('../src/motor.js', import.meta.url).href;
const recordPath = (base, id = 'ejemplo') => path.join(base, `function-definition-${id}.json`);
const envelope = (definition = { instruction: 'Texto ficticio' }) => ({
  format: 'mind-function-definition', version: 1, id: 'ejemplo', definition,
});

async function fixture(t) {
  const root = await mkdtemp(path.join(developmentDirectory, '.mind-functions-test-'));
  t.after(async () => {
    assert.equal(path.dirname(root), developmentDirectory);
    assert.ok(path.basename(root).startsWith('.mind-functions-test-'));
    await rm(root, { recursive: true, force: true });
  });
  const base = path.join(root, 'Base');
  await mkdir(base);
  const motor = await openMotor({ baseDirectory: base });
  return { root, base, motor, registry: createFunctionRegistry(motor) };
}

test('consultas vacías no crean registros ni carpetas de recursos', async (t) => {
  const { base, registry } = await fixture(t);
  assert.equal(await registry.getFunction('ausente'), null);
  assert.deepEqual(await registry.listFunctions(), []);
  assert.equal(await registry.retireFunction('ausente'), false);
  await assert.rejects(registry.updateFunction('ausente', {}), { code: 'FUNCTION_NOT_FOUND' });
  assert.deepEqual(await readdir(base), []);
  for (const context of [undefined, {}, { baseDirectory: 'relativa' }, { baseDirectory: `${base}\0` }]) {
    assert.throws(() => createFunctionRegistry(context), { code: 'INVALID_BASE' });
  }
});

test('crea, consulta, lista ordenadamente, sustituye y retira definiciones extensibles', async (t) => {
  const { base, motor, registry } = await fixture(t);
  const definition = {
    name: 'Resumen ficticio 🧠', kind: 'custom', instruction: 'Resumir café\n中文',
    parameters: { optional: null, flags: [true, false], count: 3 },
    activation: { type: 'manual' }, extension: { future: 'dato opaco' },
  };
  assert.deepEqual(await registry.createFunction('z-resumen', definition), { id: 'z-resumen', definition });
  await registry.createFunction('a-nativa', { provider: 'native', reference: 'futura' });
  await registry.createFunction('externa', { provider: 'external', reference: { adapter: 'pendiente' } });
  await motor.writeRecord('ejemplo', 'Conservar');
  assert.deepEqual((await registry.listFunctions()).map((item) => item.id), ['a-nativa', 'externa', 'z-resumen']);
  assert.deepEqual(await registry.getFunction('z-resumen'), { id: 'z-resumen', definition });
  await assert.rejects(registry.createFunction('z-resumen', {}), { code: 'FUNCTION_EXISTS' });
  const replacement = { instruction: 'Nueva versión ficticia' };
  assert.deepEqual(await registry.updateFunction('z-resumen', replacement), { id: 'z-resumen', definition: replacement });
  assert.equal(await registry.retireFunction('z-resumen'), true);
  assert.equal(await registry.getFunction('z-resumen'), null);
  assert.equal(await registry.retireFunction('z-resumen'), false);
  assert.deepEqual(await motor.readRecord('ejemplo'), { id: 'ejemplo', value: 'Conservar' });
  assert.deepEqual(await readdir(base), [
    'function-definition-a-nativa.json', 'function-definition-externa.json', 'record-ejemplo.json',
  ]);
});

test('persiste creación, actualización y retirada entre procesos terminados', async (t) => {
  const { base } = await fixture(t);
  function run(operation) {
    const script = `import { openMotor } from ${JSON.stringify(motorUrl)};
      import { createFunctionRegistry } from ${JSON.stringify(registryUrl)};
      const registry = createFunctionRegistry(await openMotor({ baseDirectory: process.argv[1] }));
      ${operation}`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, base], {
      encoding: 'utf8', timeout: 10_000, windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  run("await registry.createFunction('ejemplo', { instruction: 'Persistente ficticio' });");
  const created = JSON.parse(await readFile(recordPath(base), 'utf8'));
  assert.equal(created.version, 2);
  assert.deepEqual(JSON.parse(run("console.log(JSON.stringify(await registry.getFunction('ejemplo')));")), {
    id: 'ejemplo', definition: { instruction: 'Persistente ficticio' },
  });
  run("await registry.updateFunction('ejemplo', { instruction: 'Actualizado' });");
  const updated = JSON.parse(await readFile(recordPath(base), 'utf8'));
  assert.notEqual(updated.generation, created.generation);
  assert.deepEqual(JSON.parse(run('console.log(JSON.stringify(await registry.listFunctions()));')), [
    { id: 'ejemplo', definition: { instruction: 'Actualizado' } },
  ]);
  assert.equal(run("console.log(await registry.retireFunction('ejemplo'));"), 'true');
  assert.equal(run("console.log(await registry.getFunction('ejemplo'));"), 'null');
  assert.deepEqual(await readdir(base), []);
});

test('cada creación y actualización, incluso idéntica, persiste un UUID nuevo sin cambiar resultados públicos', async (t) => {
  const { base, registry } = await fixture(t);
  const definition = { instruction: 'Ficticia', generation: 'dato opaco de la definición' };
  const generations = new Set();
  for (const operation of ['create', 'update', 'update', 'recreate']) {
    if (operation === 'recreate') await registry.retireFunction('ejemplo');
    const result = await registry[operation === 'update' ? 'updateFunction' : 'createFunction']('ejemplo', definition);
    assert.deepEqual(result, { id: 'ejemplo', definition });
    assert.deepEqual(await registry.getFunction('ejemplo'), result);
    assert.deepEqual(await registry.listFunctions(), [result]);
    const stored = JSON.parse(await readFile(recordPath(base), 'utf8'));
    assert.equal(stored.version, 2);
    assert.match(stored.generation, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u);
    assert.ok(!generations.has(stored.generation));
    generations.add(stored.generation);
  }
});

test('v1 sigue legible sin migración implícita y solo actualizar publica v2', async (t) => {
  const { base, registry } = await fixture(t);
  const legacy = envelope();
  const text = JSON.stringify(legacy);
  await writeFile(recordPath(base), text);
  assert.deepEqual(await registry.getFunction('ejemplo'), { id: legacy.id, definition: legacy.definition });
  assert.deepEqual(await registry.listFunctions(), [{ id: legacy.id, definition: legacy.definition }]);
  assert.equal(await readFile(recordPath(base), 'utf8'), text);
  assert.deepEqual(await registry.updateFunction('ejemplo', legacy.definition), { id: legacy.id, definition: legacy.definition });
  assert.equal(JSON.parse(await readFile(recordPath(base), 'utf8')).version, 2);
  // Retirar un registro v1 tampoco exige migrarlo.
  await writeFile(recordPath(base), text);
  assert.equal(await registry.retireFunction('ejemplo'), true);
});

test('Bases independientes y otra instancia sobre la misma Base sin caché', async (t) => {
  const { root, base, motor, registry } = await fixture(t);
  const otherBase = path.join(root, 'Otra Base');
  await mkdir(otherBase);
  const other = createFunctionRegistry(await openMotor({ baseDirectory: otherBase }));
  const reopened = createFunctionRegistry(await openMotor({ baseDirectory: base }));
  await registry.createFunction('ejemplo', { value: 'uno' });
  assert.equal(await other.getFunction('ejemplo'), null);
  await other.createFunction('ejemplo', { value: 'dos' });
  await reopened.updateFunction('ejemplo', { value: 'tres' });
  assert.deepEqual((await registry.getFunction('ejemplo')).definition, { value: 'tres' });
  await registry.retireFunction('ejemplo');
  assert.equal(await reopened.getFunction('ejemplo'), null);
  assert.deepEqual((await other.getFunction('ejemplo')).definition, { value: 'dos' });
  // El mismo id puede existir en otro tipo de registro sin colisión.
  await motor.writeRecord('ejemplo', 'Técnico ficticio');
  assert.equal(await registry.getFunction('ejemplo'), null);
});

test('valida ids en cada operación antes de E/S y permite nombres reservados prefijados', async (t) => {
  const { base, registry } = await fixture(t);
  for (const id of ['', '../escape', 'a/b', 'a\\b', 'A', '.', 'a'.repeat(65), null, 7, 'a\0', 'a:b', 'a\n', 'a\r\n']) {
    for (const operation of [
      () => registry.createFunction(id, {}), () => registry.getFunction(id),
      () => registry.updateFunction(id, {}), () => registry.retireFunction(id),
    ]) await assert.rejects(operation, { code: 'INVALID_FUNCTION_ID' });
  }
  assert.deepEqual(await readdir(base), []);
  for (const id of ['con', 'a'.repeat(64), 'a_-0']) await registry.createFunction(id, {});
  assert.equal((await registry.listFunctions()).length, 3);
});

test('rechaza datos que JSON perdería o ejecutaría; los fallos preservan el registro', async (t) => {
  const { base, registry } = await fixture(t);
  await registry.createFunction('ejemplo', { instruction: 'Conservar' });
  const before = await readFile(recordPath(base), 'utf8');
  const cycle = {}; cycle.self = cycle;
  let invoked = false;
  const getter = Object.defineProperty({}, 'value', { enumerable: true, get() { invoked = true; return 1; } });
  const toJson = { toJSON() { invoked = true; return {}; } };
  const symbol = { [Symbol('dato')]: 1 };
  const hidden = Object.defineProperty({}, 'hidden', { value: 1 });
  const extraArray = []; extraArray.custom = 1;
  for (const definition of [
    null, [], 'texto', 1, undefined, () => {}, { n: NaN }, { n: Infinity }, { n: 1n },
    { n: undefined }, { fn() {} }, { date: new Date() }, cycle, getter, toJson, symbol, hidden,
    { list: Array(2) }, { list: extraArray }, { n: Symbol('dato') },
  ]) {
    await assert.rejects(registry.createFunction('nuevo', definition), { code: 'INVALID_FUNCTION_DEFINITION' });
    await assert.rejects(registry.updateFunction('ejemplo', definition), { code: 'INVALID_FUNCTION_DEFINITION' });
    assert.equal(await readFile(recordPath(base), 'utf8'), before);
  }
  assert.equal(invoked, false);
  assert.deepEqual(await readdir(base), ['function-definition-ejemplo.json']);
});

test('copia entradas y salidas sin compartir estado y conserva claves JSON especiales', async (t) => {
  const { registry } = await fixture(t);
  const definition = JSON.parse('{"__proto__":{"ficticio":true},"constructor":"dato","nested":{"value":1}}');
  const created = await registry.createFunction('ejemplo', definition);
  definition.nested.value = 2;
  created.definition.nested.value = 3;
  const loaded = await registry.getFunction('ejemplo');
  assert.equal(loaded.definition.nested.value, 1);
  assert.equal(Object.hasOwn(loaded.definition, '__proto__'), true);
  loaded.definition.nested.value = 4;
  assert.equal((await registry.getFunction('ejemplo')).definition.nested.value, 1);
});

test('corrupción explícita en consulta, listado y mutaciones sin reparar ni borrar', async (t) => {
  const { base, registry } = await fixture(t);
  const valid = envelope();
  const v2 = { ...valid, version: 2, generation: '8f875ea4-d844-4ea9-804b-dc66ca9ac0da' };
  for (const content of [
    '{incompleto', 'null', '[]', '{}', JSON.stringify({ ...valid, version: 2 }),
    JSON.stringify({ ...valid, format: 'otro' }), JSON.stringify({ ...valid, id: 'otro' }),
    JSON.stringify({ ...valid, extra: 1 }), JSON.stringify({ ...valid, definition: [] }),
    JSON.stringify({ ...valid, definition: null }), JSON.stringify({ ...valid, definition: { n: Infinity } }).replace('null', '1e999'),
    ...[null, 7, '', 'no-uuid', `${v2.generation}\n`].map((generation) => JSON.stringify({ ...v2, generation })),
    JSON.stringify({ ...v2, version: 1 }), JSON.stringify({ ...v2, version: 3 }),
    JSON.stringify({ ...v2, extra: 1 }),
  ]) {
    await writeFile(recordPath(base), content);
    for (const operation of [
      () => registry.getFunction('ejemplo'), () => registry.listFunctions(),
      () => registry.createFunction('ejemplo', {}), () => registry.updateFunction('ejemplo', {}),
      () => registry.retireFunction('ejemplo'),
    ]) await assert.rejects(operation, { code: content === '{incompleto' ? 'RECORD_CORRUPT' : 'FUNCTION_CORRUPT' });
    assert.equal(await readFile(recordPath(base), 'utf8'), content);
  }
});

test('listado ignora registros ajenos y denuncia nombres de función inválidos', async (t) => {
  const { base, registry } = await fixture(t);
  await writeFile(path.join(base, 'record-ajeno.json'), 'no es JSON');
  await writeFile(path.join(base, '.mind-ignorado.tmp'), 'incompleto');
  await registry.createFunction('ejemplo', {});
  assert.equal((await registry.listFunctions()).length, 1);
  await writeFile(path.join(base, 'function-definition-MAYUSCULAS.json'), JSON.stringify(envelope()));
  await assert.rejects(registry.listFunctions(), { code: 'FUNCTION_CORRUPT' });
});

test('rechaza registros enlazados y no altera el destino externo', async (t) => {
  const { root, base, registry } = await fixture(t);
  const outside = path.join(root, 'Externo');
  await mkdir(outside);
  const target = recordPath(base);
  // Junction soportada sin privilegios de symlink en Windows.
  await symlink(outside, target, process.platform === 'win32' ? 'junction' : 'dir');
  for (const operation of [
    () => registry.getFunction('ejemplo'), () => registry.listFunctions(),
    () => registry.createFunction('ejemplo', {}), () => registry.updateFunction('ejemplo', {}),
    () => registry.retireFunction('ejemplo'),
  ]) await assert.rejects(operation, { code: 'RECORD_LINK' });
  assert.deepEqual(await readdir(outside), []);
});

test('un destino no regular falla sin publicar temporales ni eliminarlo', async (t) => {
  const { base, registry } = await fixture(t);
  await mkdir(recordPath(base));
  await assert.rejects(registry.createFunction('ejemplo', {}));
  assert.deepEqual(await readdir(base), ['function-definition-ejemplo.json']);
});

test('crear funciones con ids distintos simultáneamente conserva todos los registros', async (t) => {
  const { base, registry } = await fixture(t);
  await Promise.all(Array.from({ length: 12 }, (_, i) => registry.createFunction(`f-${i}`, { number: i })));
  assert.equal((await registry.listFunctions()).length, 12);
  assert.equal((await readdir(base)).length, 12);
});
