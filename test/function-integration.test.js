import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openMotor } from '../src/motor.js';

const motorDirectory = fileURLToPath(new URL('..', import.meta.url));
const development = path.dirname(motorDirectory);
const motorUrl = pathToFileURL(path.join(motorDirectory, 'src', 'motor.js')).href;

/** Catálogo explícito del anfitrión: el único código ejecutable. */
function catalog(calls = []) {
  return {
    'contar-palabras': {
      validateInput: (input) => typeof input?.text === 'string' && input.text.length <= 1000,
      acceptsDefinition: (definition) => Number.isInteger(definition.parameters?.maxWords),
      run: (request) => {
        const { input, definition, capabilities, signal } = request;
        calls.push({ keys: Object.keys(request).sort(), capabilities: Object.keys(capabilities) });
        assert.ok(signal instanceof AbortSignal);
        const count = input.text.split(/\s+/u).filter(Boolean).length;
        return { count, truncated: count > definition.parameters.maxWords };
      },
    },
    'leer-nota': {
      capabilities: ['readNote'],
      validateInput: (input) => input === null,
      run: async ({ capabilities }) => ({ text: await capabilities.readNote() }),
    },
  };
}

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(development, '.mind-function-integration-test-'));
  t.after(async () => {
    assert.equal(path.dirname(root), development);
    assert.ok(path.basename(root).startsWith('.mind-function-integration-test-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const base = path.join(root, 'Base ficticia');
  const folder = path.join(root, 'Información ficticia');
  await fs.mkdir(base);
  await fs.mkdir(folder);
  const calls = [];
  const motor = await openMotor({ baseDirectory: base, functionExecutors: catalog(calls), ...options });
  return { root, base, folder, motor, calls };
}

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

test('registro → autorización → ejecución → actualización → retirada, con vínculos obsoletos rechazados', async (t) => {
  const { base, motor, calls } = await fixture(t);
  const definition = { descripcion: 'Contar palabras ficticias', parameters: { maxWords: 3 } };
  assert.deepEqual(await motor.createFunction('resumen', definition), { id: 'resumen', definition });
  await assert.rejects(motor.createFunction('resumen', definition), { code: 'FUNCTION_EXISTS' });
  assert.deepEqual(await motor.listFunctions(), [{ id: 'resumen', definition }]);

  // Registrar no autoriza: hace falta el vínculo explícito del anfitrión.
  const binding = await motor.bindFunction({ functionId: 'resumen', executor: 'contar-palabras' });
  const baseBefore = (await fs.readdir(base)).sort();
  const first = await motor.runFunction({ binding, input: { text: 'uno dos tres cuatro' } });
  assert.deepEqual(first, { functionId: 'resumen', executor: 'contar-palabras', result: { count: 4, truncated: true } });
  // El vínculo se reutiliza mientras la definición no cambie; ejecutar no escribe en la Base.
  assert.equal((await motor.runFunction({ binding, input: { text: 'uno' } })).result.count, 1);
  assert.deepEqual((await fs.readdir(base)).sort(), baseBefore);
  assert.deepEqual(calls[0], { keys: ['capabilities', 'definition', 'input', 'signal'], capabilities: [] });

  // Actualizar (aunque sea con datos idénticos) invalida el vínculo para siempre.
  await motor.updateFunction('resumen', definition);
  await assert.rejects(motor.runFunction({ binding, input: { text: 'x' } }), { code: 'FUNCTION_CHANGED' });
  await assert.rejects(motor.runFunction({ binding, input: { text: 'x' } }), { code: 'FUNCTION_NOT_BOUND' });

  // A → B → A sin ejecutar entre medias tampoco reactiva un vínculo anterior.
  const second = await motor.bindFunction({ functionId: 'resumen', executor: 'contar-palabras' });
  await motor.updateFunction('resumen', { ...definition, parameters: { maxWords: 10 } });
  await motor.updateFunction('resumen', definition);
  await assert.rejects(motor.runFunction({ binding: second, input: { text: 'x' } }), { code: 'FUNCTION_CHANGED' });

  // Retirar y recrear el mismo id con el mismo contenido: el vínculo previo no vale.
  const third = await motor.bindFunction({ functionId: 'resumen', executor: 'contar-palabras' });
  assert.equal(await motor.retireFunction('resumen'), true);
  await assert.rejects(motor.runFunction({ binding: third, input: { text: 'x' } }), { code: 'FUNCTION_NOT_FOUND' });
  await motor.createFunction('resumen', definition);
  await assert.rejects(motor.runFunction({ binding: third, input: { text: 'x' } }), { code: 'FUNCTION_NOT_BOUND' });
  assert.equal(await motor.retireFunction('resumen'), true);
  assert.equal(await motor.retireFunction('resumen'), false);
  await assert.rejects(motor.bindFunction({ functionId: 'resumen', executor: 'contar-palabras' }), { code: 'FUNCTION_NOT_FOUND' });
});

test('las definiciones persisten entre procesos y un cambio desde otro proceso invalida el vínculo', async (t) => {
  const { base, motor } = await fixture(t);
  hostProcess(base, `return motor.createFunction('informe', { parameters: { maxWords: 50 } });`);
  const binding = await motor.bindFunction({ functionId: 'informe', executor: 'contar-palabras' });
  assert.equal((await motor.runFunction({ binding, input: { text: 'hola mundo' } })).result.count, 2);
  // Otro proceso actualiza la definición: la generación persistente cambia.
  hostProcess(base, `return motor.updateFunction('informe', { parameters: { maxWords: 50 } });`);
  await assert.rejects(motor.runFunction({ binding, input: { text: 'x' } }), { code: 'FUNCTION_CHANGED' });
  // Un proceso sin catálogo administra definiciones pero no puede vincularlas.
  assert.deepEqual(hostProcess(base, `
    try { await motor.bindFunction({ functionId: 'informe', executor: 'contar-palabras' }); return 'vinculada'; }
    catch (error) { return error.code; }
  `), 'EXECUTOR_NOT_FOUND');
});

test('una definición no elige ejecutor, permisos ni código; el catálogo queda fijo al abrir', async (t) => {
  const { root, base, motor, calls } = await fixture(t);
  const marker = path.join(root, 'no-debe-existir.txt');
  const hostile = {
    parameters: { maxWords: 5 },
    executor: 'leer-nota',
    code: `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x')`,
    handler: 'process.exit(1)',
    permissions: ['*'],
    capabilities: { readNote: true },
  };
  await motor.createFunction('hostil', hostile);
  // El ejecutor lo elige el anfitrión; el campo executor de la definición es un dato.
  const binding = await motor.bindFunction({ functionId: 'hostil', executor: 'contar-palabras' });
  const { result } = await motor.runFunction({ binding, input: { text: 'solo datos' } });
  assert.deepEqual(result, { count: 2, truncated: false });
  assert.deepEqual(calls.at(-1).capabilities, []);
  await assert.rejects(fs.access(marker));
  // No se pueden entregar capacidades que el ejecutor no declaró.
  await assert.rejects(motor.runFunction({ binding, input: { text: 'x' }, capabilities: { readNote: () => 'x' } }),
    { code: 'INVALID_CAPABILITIES' });
  // Un ejecutor que no está en el catálogo no existe, aunque la definición lo nombre.
  await assert.rejects(motor.bindFunction({ functionId: 'hostil', executor: 'eval' }), { code: 'EXECUTOR_NOT_FOUND' });

  // Catálogo fijado al abrir: modificar después el objeto del anfitrión no añade ejecutores.
  const executors = catalog();
  const fixed = await openMotor({ baseDirectory: base, functionExecutors: executors });
  executors.tardio = { validateInput: () => true, run: () => 'no autorizado' };
  await assert.rejects(fixed.bindFunction({ functionId: 'hostil', executor: 'tardio' }), { code: 'EXECUTOR_NOT_FOUND' });
  // Un catálogo mal formado impide abrir el Motor; sin catálogo no hay ejecución posible.
  await assert.rejects(openMotor({ baseDirectory: base, functionExecutors: { malo: { run: 'código' } } }), { code: 'INVALID_EXECUTOR' });
  const bare = await openMotor({ baseDirectory: base });
  await assert.rejects(bare.bindFunction({ functionId: 'hostil', executor: 'contar-palabras' }), { code: 'EXECUTOR_NOT_FOUND' });
  // Un ejecutor puede rechazar una definición que no cumple su contrato.
  await motor.createFunction('sin-parametros', { descripcion: 'x' });
  await assert.rejects(motor.bindFunction({ functionId: 'sin-parametros', executor: 'contar-palabras' }),
    { code: 'FUNCTION_DEFINITION_REJECTED' });
});

test('autorización por invocación: vínculos por instancia, retirada y capacidades del anfitrión', async (t) => {
  const { base, folder, motor } = await fixture(t);
  await fs.writeFile(path.join(folder, 'nota.txt'), 'Nota ficticia para la función');
  const scope = await motor.authorizeFolder(folder);
  await motor.createFunction('lector', { descripcion: 'Leer una nota concedida' });
  const binding = await motor.bindFunction({ functionId: 'lector', executor: 'leer-nota' });

  // El vínculo no se falsifica ni sirve en otra instancia del Motor.
  const other = await openMotor({ baseDirectory: base, functionExecutors: catalog() });
  for (const candidate of [{}, { ...binding }, 'lector', undefined]) {
    await assert.rejects(motor.runFunction({ binding: candidate, input: null }), { code: 'FUNCTION_NOT_BOUND' });
  }
  await assert.rejects(other.runFunction({ binding, input: null }), { code: 'FUNCTION_NOT_BOUND' });

  // Capacidad de esta invocación: un permiso de lectura de un solo intento del anfitrión.
  const requester = Object.freeze({});
  const readPermission = await motor.grantTextRead({ requester, folderId: scope.id, relativePath: 'nota.txt' });
  const readNote = async () => (await motor.readTextFile({ requester, authorization: readPermission })).content;
  assert.deepEqual((await motor.runFunction({ binding, input: null, capabilities: { readNote } })).result,
    { text: 'Nota ficticia para la función' });
  // El permiso ya se consumió: la siguiente invocación necesita otra concesión.
  await assert.rejects(motor.runFunction({ binding, input: null, capabilities: { readNote } }), { code: 'FUNCTION_FAILED' });
  // Sin capacidades el ejecutor no recibe nada.
  await assert.rejects(motor.runFunction({ binding, input: null }), { code: 'FUNCTION_FAILED' });

  assert.equal(motor.unbindFunction(binding), true);
  assert.equal(motor.unbindFunction(binding), false);
  await assert.rejects(motor.runFunction({ binding, input: null }), { code: 'FUNCTION_NOT_BOUND' });
});

test('administración separada: el Motor no expone la lectura interna de versiones', async (t) => {
  const { motor } = await fixture(t);
  for (const name of ['createFunction', 'getFunction', 'listFunctions', 'updateFunction', 'retireFunction',
    'bindFunction', 'unbindFunction', 'runFunction']) {
    assert.equal(typeof motor[name], 'function', name);
  }
  assert.equal(Object.hasOwn(motor, 'getFunctionVersion'), false);
  await motor.createFunction('datos', { parameters: { maxWords: 1 } });
  // getFunction devuelve el contrato normal, sin la generación interna.
  assert.deepEqual(Object.keys(await motor.getFunction('datos')).sort(), ['definition', 'id']);
  assert.ok(Object.isFrozen(motor));
});
