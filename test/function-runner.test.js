import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openMotor } from '../src/motor.js';
import { createFunctionRegistry } from '../src/functions.js';
import { createFunctionRunner, MAX_INPUT_BYTES } from '../src/function-runner.js';

const motorDirectory = fileURLToPath(new URL('..', import.meta.url));
const developmentDirectory = path.dirname(motorDirectory);

// Ejecutor de confianza ficticio: usa la definición solo como datos.
function countWords(calls = []) {
  return {
    validateInput: (input) => typeof input?.text === 'string' && input.text.length <= 1000,
    acceptsDefinition: (definition) => Number.isInteger(definition.parameters?.maxWords),
    run({ input, definition }) {
      calls.push(input);
      const words = input.text.split(/\s+/u).filter(Boolean);
      const limit = definition.parameters.maxWords;
      return { count: words.length, first: words.slice(0, limit), truncated: words.length > limit };
    },
  };
}

async function fixture(t, executors = {}) {
  const root = await mkdtemp(path.join(developmentDirectory, '.mind-runner-test-'));
  t.after(async () => {
    assert.equal(path.dirname(root), developmentDirectory);
    assert.ok(path.basename(root).startsWith('.mind-runner-test-'));
    await rm(root, { recursive: true, force: true });
  });
  const base = path.join(root, 'Base');
  await mkdir(base);
  const motor = await openMotor({ baseDirectory: base });
  const functions = createFunctionRegistry(motor);
  const calls = [];
  const runner = createFunctionRunner({
    functions, executors: { 'contar-palabras': countWords(calls), ...executors },
  });
  await functions.createFunction('resumen', {
    name: 'Resumen ficticio', instruction: 'Contar palabras del texto recibido.',
    parameters: { maxWords: 3 }, activation: { type: 'manual' },
  });
  return { root, base, motor, functions, runner, calls };
}

test('ejecuta manualmente una función vinculada y entrega un resultado JSON aislado', async (t) => {
  const { base, runner, calls, functions } = await fixture(t);
  const binding = await runner.bindFunction({ functionId: 'resumen', executor: 'contar-palabras' });
  assert.ok(Object.isFrozen(binding));
  assert.equal(Object.getPrototypeOf(binding), null);
  const input = { text: 'uno dos tres cuatro cinco' };
  const run = await runner.runFunction({ binding, input });
  assert.deepEqual(run, {
    functionId: 'resumen', executor: 'contar-palabras',
    result: { count: 5, first: ['uno', 'dos', 'tres'], truncated: true },
  });
  input.text = 'cambiado';
  run.result.first.push('mutado');
  assert.deepEqual((await runner.runFunction({ binding, input: { text: 'café 中文' } })).result, {
    count: 2, first: ['café', '中文'], truncated: false,
  });
  assert.equal(calls.length, 2);
  // La ejecución no escribe en la Base ni altera la definición.
  assert.deepEqual(await readdir(base), ['function-definition-resumen.json']);
  assert.equal((await functions.getFunction('resumen')).definition.parameters.maxWords, 3);
});

test('valida entradas antes de ejecutar: datos JSON, tamaño y criterio del ejecutor', async (t) => {
  const { runner, calls } = await fixture(t);
  const binding = await runner.bindFunction({ functionId: 'resumen', executor: 'contar-palabras' });
  const cycle = {}; cycle.self = cycle;
  let invoked = false;
  const getter = Object.defineProperty({}, 'text', { enumerable: true, get() { invoked = true; return 'x'; } });
  for (const input of [
    undefined, null, 'texto', [], {}, { text: 7 }, { text: 'x'.repeat(1001) },
    { text: 'x', fn() {} }, { text: 'x', n: NaN }, { text: 'x', n: 1n }, { text: 'x', date: new Date() },
    cycle, getter, { text: 'x', padding: 'x'.repeat(MAX_INPUT_BYTES) },
  ]) {
    await assert.rejects(runner.runFunction({ binding, input }), { code: 'INVALID_FUNCTION_INPUT' });
  }
  assert.equal(invoked, false);
  assert.equal(calls.length, 0);

  const { runner: strict } = await fixture(t, {
    lanza: { validateInput() { throw new Error('detalle interno'); }, run: () => null },
    promesa: { validateInput: async () => true, run: () => null },
    verdadero: { validateInput: () => 1, run: () => null },
  });
  for (const executor of ['lanza', 'promesa', 'verdadero']) {
    const other = await strict.bindFunction({ functionId: 'resumen', executor });
    await assert.rejects(strict.runFunction({ binding: other, input: {} }), (error) => {
      assert.equal(error.code, 'INVALID_FUNCTION_INPUT');
      assert.doesNotMatch(error.message, /detalle interno/u);
      return true;
    });
  }
});

test('función inexistente, retirada o modificada no se ejecuta y exige un vínculo nuevo', async (t) => {
  const { base, functions, runner, calls } = await fixture(t);
  await assert.rejects(runner.bindFunction({ functionId: 'ausente', executor: 'contar-palabras' }), { code: 'FUNCTION_NOT_FOUND' });
  for (const functionId of ['../escape', 'A', '', null]) {
    await assert.rejects(runner.bindFunction({ functionId, executor: 'contar-palabras' }), { code: 'INVALID_FUNCTION_ID' });
  }
  const input = { text: 'uno' };
  const original = (await functions.getFunction('resumen')).definition;

  const retired = await runner.bindFunction({ functionId: 'resumen', executor: 'contar-palabras' });
  await functions.retireFunction('resumen');
  await assert.rejects(runner.runFunction({ binding: retired, input }), { code: 'FUNCTION_NOT_FOUND' });
  await functions.createFunction('resumen', original);
  await assert.rejects(runner.runFunction({ binding: retired, input }), { code: 'FUNCTION_NOT_BOUND' });

  const changed = await runner.bindFunction({ functionId: 'resumen', executor: 'contar-palabras' });
  await functions.updateFunction('resumen', { ...original, parameters: { maxWords: 100 } });
  await assert.rejects(runner.runFunction({ binding: changed, input }), { code: 'FUNCTION_CHANGED' });
  await functions.updateFunction('resumen', original);
  await assert.rejects(runner.runFunction({ binding: changed, input }), { code: 'FUNCTION_NOT_BOUND' });
  assert.equal(calls.length, 0);

  const renewed = await runner.bindFunction({ functionId: 'resumen', executor: 'contar-palabras' });
  assert.equal((await runner.runFunction({ binding: renewed, input })).result.count, 1);

  await writeFile(path.join(base, 'function-definition-resumen.json'), '{"format":"otro"}');
  await assert.rejects(runner.runFunction({ binding: renewed, input }), { code: 'FUNCTION_CORRUPT' });
});

test('errores, tiempo excedido y resultados no válidos se informan con códigos estables', async (t) => {
  let signal;
  const fail = (value) => ({ validateInput: () => true, run: () => value });
  const { runner } = await fixture(t, {
    lanza: { validateInput: () => true, run() { throw new Error('fallo ficticio'); } },
    rechaza: { validateInput: () => true, run: async () => { throw new TypeError('rechazo ficticio'); } },
    lento: {
      validateInput: () => true, timeoutMs: 20,
      run: (context) => { signal = context.signal; return new Promise(() => {}); },
    },
    indefinido: fail(undefined), funcion: fail(() => {}), fecha: fail(new Date()), infinito: fail({ n: Infinity }),
    grande: { validateInput: () => true, maxResultBytes: 16, run: () => ({ text: 'x'.repeat(16) }) },
    muta: { validateInput: () => true, run({ input, definition }) { input.text = 'x'; definition.extra = 1; } },
  });
  const run = async (executor) => runner.runFunction({
    binding: await runner.bindFunction({ functionId: 'resumen', executor }), input: { text: 'dato' },
  });
  await assert.rejects(run('lanza'), (error) => {
    assert.equal(error.code, 'FUNCTION_FAILED');
    assert.equal(error.cause.message, 'fallo ficticio');
    assert.doesNotMatch(error.message, /ficticio/u);
    return true;
  });
  await assert.rejects(run('rechaza'), { code: 'FUNCTION_FAILED' });
  await assert.rejects(run('lento'), { code: 'FUNCTION_TIMEOUT' });
  assert.equal(signal.aborted, true);
  for (const executor of ['indefinido', 'funcion', 'fecha', 'infinito']) {
    await assert.rejects(run(executor), { code: 'FUNCTION_RESULT_INVALID' });
  }
  await assert.rejects(run('grande'), { code: 'FUNCTION_RESULT_TOO_LARGE' });
  // Entrada y definición llegan congeladas: el ejecutor no altera lo aprobado.
  await assert.rejects(run('muta'), (error) => error.code === 'FUNCTION_FAILED' && error.cause instanceof TypeError);
});

test('sin vínculo del anfitrión no hay ejecución, aunque la definición nombre un ejecutor', async (t) => {
  const { functions, runner, calls } = await fixture(t);
  const { runner: otherRunner } = await fixture(t);
  await functions.createFunction('autoejecutable', {
    executor: 'contar-palabras', handler: 'contar-palabras', autorun: true,
  });
  const foreign = await otherRunner.bindFunction({ functionId: 'resumen', executor: 'contar-palabras' });
  for (const binding of [
    undefined, null, 'resumen', 'autoejecutable', { functionId: 'resumen', executor: 'contar-palabras' },
    Object.freeze(Object.create(null)), foreign,
  ]) {
    await assert.rejects(runner.runFunction({ binding, input: { text: 'uno' } }), { code: 'FUNCTION_NOT_BOUND' });
  }
  await assert.rejects(runner.runFunction(), { code: 'FUNCTION_NOT_BOUND' });

  const binding = await runner.bindFunction({ functionId: 'resumen', executor: 'contar-palabras' });
  assert.equal(runner.unbindFunction(binding), true);
  assert.equal(runner.unbindFunction(binding), false);
  assert.equal(runner.unbindFunction({}), false);
  await assert.rejects(runner.runFunction({ binding, input: { text: 'uno' } }), { code: 'FUNCTION_NOT_BOUND' });
  assert.equal(calls.length, 0);

  for (const executor of ['ausente', 'constructor', '__proto__', 'toString', undefined, 'Contar-Palabras']) {
    await assert.rejects(runner.bindFunction({ functionId: 'resumen', executor }), { code: 'EXECUTOR_NOT_FOUND' });
  }
  // El ejecutor rechaza definiciones que no le corresponden al vincular.
  await assert.rejects(
    runner.bindFunction({ functionId: 'autoejecutable', executor: 'contar-palabras' }),
    { code: 'FUNCTION_DEFINITION_REJECTED' },
  );
});

test('el catálogo de confianza es fijo y valida su configuración', async (t) => {
  const { functions } = await fixture(t);
  const valid = { validateInput: () => true, run: () => null };
  for (const executors of [
    undefined, null, [], { 'Mayus': valid }, { '../x': valid }, { x: null }, { x: { run: () => null } },
    { x: { validateInput: () => true } }, { x: { ...valid, run: 'return 1' } },
    { x: { ...valid, acceptsDefinition: 'true' } }, { x: { ...valid, timeoutMs: 0 } },
    { x: { ...valid, timeoutMs: 60_001 } }, { x: { ...valid, maxResultBytes: 64 * 1024 + 1 } },
    { x: { ...valid, capabilities: 'readText' } }, { x: { ...valid, capabilities: ['leer texto'] } }, { x: { ...valid, capabilities: ['__proto__'] } },
  ]) assert.throws(() => createFunctionRunner({ functions, executors }), { code: 'INVALID_EXECUTOR' });
  for (const options of [undefined, {}, { functions: {}, executors: {} }]) {
    assert.throws(() => createFunctionRunner(options), { code: 'INVALID_FUNCTION_REGISTRY' });
  }
  const executors = { eco: { ...valid, run: ({ input }) => input } };
  const runner = createFunctionRunner({ functions, executors });
  executors.eco.run = () => 'sustituido';
  executors.nuevo = valid;
  const binding = await runner.bindFunction({ functionId: 'resumen', executor: 'eco' });
  assert.equal((await runner.runFunction({ binding, input: 'original' })).result, 'original');
  await assert.rejects(runner.bindFunction({ functionId: 'resumen', executor: 'nuevo' }), { code: 'EXECUTOR_NOT_FOUND' });
});

test('el contenido de la definición nunca se evalúa como código', async (t) => {
  const { functions } = await fixture(t);
  const seen = [];
  const runner = createFunctionRunner({
    functions, executors: { eco: { validateInput: () => true, run: ({ definition }) => { seen.push(definition); return definition; } } },
  });
  const definition = {
    code: 'globalThis.__mindEjecutado = true', instruction: 'process.exit(1)',
    run: '() => { globalThis.__mindEjecutado = true }', module: 'node:child_process',
  };
  await functions.createFunction('codigo', definition);
  const binding = await runner.bindFunction({ functionId: 'codigo', executor: 'eco' });
  assert.deepEqual((await runner.runFunction({ binding })).result, definition);
  assert.equal(globalThis.__mindEjecutado, undefined);
  assert.equal(typeof seen[0].run, 'string');
  const source = await readFile(new URL('../src/function-runner.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\beval\b|new Function|import\((?!'\.\/functions\.js'\))|node:vm|child_process|require\(/u);
});

test('registrar o vincular no concede lectura; solo capacidades del anfitrión declaradas', async (t) => {
  const { root, motor, functions } = await fixture(t);
  const folder = path.join(root, 'Notas ficticias');
  await mkdir(folder);
  await writeFile(path.join(folder, 'nota.txt'), 'Contenido ficticio');
  const scope = await motor.authorizeFolder(folder);
  const received = [];
  const runner = createFunctionRunner({
    functions,
    executors: {
      leer: {
        capabilities: ['readText'],
        validateInput: (input) => input === null,
        async run({ capabilities }) {
          received.push(Object.keys(capabilities));
          if (typeof capabilities.readText !== 'function') throw new Error('sin capacidad');
          return (await capabilities.readText()).content;
        },
      },
    },
  });
  // La definición describe un archivo y "permisos", pero son solo datos opacos.
  await functions.createFunction('lector', {
    folderId: scope.id, relativePath: 'nota.txt', permissions: { read: true }, capabilities: ['readText'],
  });
  const binding = await runner.bindFunction({ functionId: 'lector', executor: 'leer' });
  await assert.rejects(runner.runFunction({ binding }), (error) => error.code === 'FUNCTION_FAILED' && error.cause.message === 'sin capacidad');
  assert.deepEqual(received, [[]]);
  await assert.rejects(
    runner.runFunction({ binding, capabilities: { readText: () => null, writeFile: () => null } }),
    { code: 'INVALID_CAPABILITIES' },
  );
  await assert.rejects(runner.runFunction({ binding, capabilities: [] }), { code: 'INVALID_CAPABILITIES' });
  await assert.rejects(motor.readTextFile({ requester: {}, authorization: scope.id }), { code: 'READ_NOT_AUTHORIZED' });

  // El anfitrión concede una lectura concreta y la entrega como capacidad de esta invocación.
  const requester = {};
  const authorization = await motor.grantTextRead({ requester, folderId: scope.id, relativePath: 'nota.txt' });
  const readText = () => motor.readTextFile({ requester, authorization });
  assert.equal((await runner.runFunction({ binding, capabilities: { readText } })).result, 'Contenido ficticio');
  // El permiso existente sigue siendo de un solo uso.
  await assert.rejects(
    runner.runFunction({ binding, capabilities: { readText } }),
    (error) => error.code === 'FUNCTION_FAILED' && error.cause.code === 'READ_NOT_AUTHORIZED',
  );
  for (const name of ['bindFunction', 'runFunction', 'createFunction']) assert.equal(Object.hasOwn(motor, name), false);
});
