import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { stopCentralMotor } from '../../src/connector.js';
import { RUNS } from './runs.mjs';

const executable = process.env.MIND_NATIVE_EXE;
const python = process.env.MIND_TEST_BUNDLED_PYTHON || process.env.MIND_PYTHON;
const motorScript = fileURLToPath(new URL('./real-motor.mjs', import.meta.url));
const run = promisify(execFile);
const fixturePrefix = 'mind-nativo-runs-compilacion-';
const project = 'Atlas ficticio';

const nodeBuilder = [
  "import fs from 'node:fs/promises';",
  "import path from 'node:path';",
  "import { setTimeout as delay } from 'node:timers/promises';",
  "const [value, mode, started, release] = process.argv.slice(2);",
  "const out = process.env.MIND_SALIDA;",
  "if (!out || !path.isAbsolute(out) || path.relative(process.cwd(), out) === '') process.exit(13);",
  "await fs.writeFile(path.join(out, mode === 'invalid' ? 'estilo.css' : 'index.html'), value);",
  "await fs.writeFile(started, out);",
  "if (mode === 'fail') process.exit(7);",
  "if (mode === 'sleep') await delay(30_000);",
  "if (mode === 'wait') {",
  "  for (let attempt = 0; attempt < 200; attempt++) {",
  "    if (await fs.stat(release).then(() => true, (error) => error.code === 'ENOENT' ? false : Promise.reject(error))) process.exit(0);",
  "    await delay(100);",
  "  }",
  "  process.exit(8);",
  "}",
].join('\n');

const pythonBuilder = [
  'import os, pathlib, sys',
  'value, started = sys.argv[1:]',
  'out = pathlib.Path(os.environ["MIND_SALIDA"])',
  'assert out.is_absolute() and out != pathlib.Path.cwd()',
  '(out / "index.html").write_text(value, encoding="utf-8")',
  'pathlib.Path(started).write_text(str(out), encoding="utf-8")',
].join('\n');

function launch(command, args, env) {
  const child = spawn(command, args, { env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let error = '';
  let stopped = false;
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { error = (error + chunk).slice(-2048); });
  const closed = new Promise((resolve) => {
    child.once('close', () => { stopped = true; resolve(); });
    child.once('error', (cause) => { error = String(cause); stopped = true; resolve(); });
  });
  return {
    pid: child.pid,
    async connector(base, filename) {
      for (let attempt = 0; attempt < 100; attempt++) {
        assert.ok(!stopped, filename + ' no arrancó: ' + error);
        const data = await fs.readFile(path.join(base, filename), 'utf8').then(JSON.parse).catch((cause) => {
          if (cause.code !== 'ENOENT') throw cause;
          return null;
        });
        if (data) {
          assert.equal(data.pid, child.pid);
          return data;
        }
        await delay(100);
      }
      assert.fail(filename + ' no se publicó: ' + error);
    },
    async stop() {
      if (!stopped) child.kill();
      await closed;
    },
  };
}

async function assertMissing(file) {
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
}

async function waitForMarker(file) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const present = await fs.stat(file).then(() => true, (error) => {
      if (error.code !== 'ENOENT') throw error;
      return false;
    });
    if (present) return;
    await delay(100);
  }
  assert.fail('La receta no confirmó el arranque: ' + path.basename(file));
}

function report(result, estado) {
  assert.equal(result.code === 0, estado === 'publicada', result.stderr);
  assert.ok(result.stdout.trim(), result.stderr || 'No hubo informe de compilación');
  const body = JSON.parse(result.stdout);
  assert.equal(body.estado, estado, result.stderr);
  assert.ok(body.solicitada, 'Falta la compilación solicitada');
  assert.ok(body.servida, 'Falta la vista servida');
  return body;
}

test('compilación aislada con Node y Python conserva la última vista válida', {
  skip: (!executable || !python) && 'Indica MIND_NATIVE_EXE y MIND_TEST_BUNDLED_PYTHON o MIND_PYTHON',
  timeout: 75_000,
}, async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(RUNS, fixturePrefix)));
  const base = path.join(root, 'Base');
  const copy = path.join(root, 'Proyecto ficticio');
  const binary = path.resolve(executable);
  const env = { ...process.env, MIND_PYTHON: python, MIND_AGENT_STARTUP: '0' };
  const execOptions = { env, timeout: 25_000, windowsHide: true };
  let motor, motorRecord, host;
  t.after(async () => {
    try {
      await host?.stop();
      if (motorRecord?.pid && motorRecord.pid === motor?.pid) {
        await stopCentralMotor(base, { timeoutMs: 4_000, reason: 'fin-prueba-compilacion' }).catch(() => {});
      }
      await motor?.stop();
    } finally {
      assert.equal(path.dirname(root), RUNS);
      assert.ok(path.basename(root).startsWith(fixturePrefix));
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  await fs.mkdir(base);
  await fs.mkdir(copy);
  await fs.writeFile(path.join(copy, 'build.mjs'), nodeBuilder);
  await fs.writeFile(path.join(copy, 'build.py'), pythonBuilder);
  motor = launch(process.execPath, [motorScript, base], env);
  motorRecord = await motor.connector(base, 'conector.json');
  host = launch(binary, ['anfitrion', '--base', base, '--puerto-vistas', '0'], env);
  await host.connector(base, 'anfitrion.json');

  const vista = (...args) => run(binary, ['vista', ...args], execOptions).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    ({ code, stdout, stderr }) => ({ code, stdout: stdout || '', stderr: stderr || '' }),
  );
  const shared = ['--proyecto', project, '--copia', copy];
  async function recipe(name, value, { mode = '', deadline = 12_000, runtime = 'node' } = {}) {
    const started = path.join(root, name + '.iniciada');
    const release = path.join(root, name + '.continua');
    const file = path.join(copy, name + '.json');
    const data = runtime === 'node'
      ? { programa: process.execPath, argumentos: ['build.mjs', value, mode, started, release] }
      : { programa: python, argumentos: ['-I', '-B', 'build.py', value, started] };
    await fs.writeFile(file, JSON.stringify({ ...data, plazo_ms: deadline }));
    const result = await vista('receta', ...shared, '--receta', file);
    assert.equal(result.code, 0, result.stderr);
    const { autorizacion } = JSON.parse(result.stdout);
    assert.ok(autorizacion);
    return { file, started, release, autorizacion };
  }
  function build(recipe, options = {}) {
    const authorization = options.authorization ?? recipe.autorizacion;
    const args = ['--base', base, ...shared, '--receta', recipe.file];
    if (authorization) args.push('--autorizar', authorization);
    if (options.id) args.push('--id', options.id);
    return vista('construir', ...args);
  }
  async function assertServed(view, contents) {
    const status = await vista('consultar', '--base', base, '--id', view.id);
    assert.equal(status.code, 0, status.stderr);
    assert.deepEqual(JSON.parse(status.stdout), view);
    const response = await fetch(view.url, { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), contents);
  }

  const initial = await recipe('inicial-node', '<h1>Primera versión</h1>');
  const denied = await build(initial, { authorization: '' });
  assert.notEqual(denied.code, 0);
  const invalidAuthorization = await build(initial, { authorization: '0'.repeat(64) });
  assert.notEqual(invalidAuthorization.code, 0);
  const originalRecipe = await fs.readFile(initial.file, 'utf8');
  await fs.writeFile(initial.file, originalRecipe + '\n');
  assert.notEqual((await build(initial)).code, 0, 'La receta cambió después de revisarla');
  await fs.writeFile(initial.file, originalRecipe);
  const otherProject = await vista('construir', '--base', base, '--proyecto', 'Otro proyecto',
    '--copia', copy, '--receta', initial.file, '--autorizar', initial.autorizacion);
  assert.notEqual(otherProject.code, 0, 'La autorización pertenece al proyecto original');
  await assertMissing(initial.started);

  const first = report(await build(initial), 'publicada').servida;
  assert.ok(first.id);
  await assertServed(first, '<h1>Primera versión</h1>');

  const secondRecipe = await recipe('segunda-python', '<h1>Versión con Python</h1>', { runtime: 'python' });
  const second = report(await build(secondRecipe, { id: first.id }), 'publicada').servida;
  assert.equal(second.url, first.url);
  assert.equal(second.version, first.version + 1);
  assert.notEqual(second.huella, first.huella);
  await assertServed(second, '<h1>Versión con Python</h1>');
  const firstOutput = await fs.readFile(initial.started, 'utf8');
  const secondOutput = await fs.readFile(secondRecipe.started, 'utf8');
  assert.notEqual(firstOutput, secondOutput);
  await assertMissing(firstOutput);
  await assertMissing(secondOutput);
  await assertMissing(path.join(copy, 'index.html'));

  for (const [name, options, expected] of [
    ['fallo-parcial', { mode: 'fail' }, 'fallo'],
    ['salida-invalida', { mode: 'invalid' }, 'fallo'],
    ['plazo', { mode: 'sleep', deadline: 2_000 }, 'plazo'],
  ]) {
    const broken = await recipe(name, '<h1>Esta versión no debe aparecer</h1>', options);
    const failed = report(await build(broken, { id: second.id }), expected);
    await assertMissing(await fs.readFile(broken.started, 'utf8'));
    assert.equal(failed.solicitada.receta, broken.autorizacion);
    assert.deepEqual(failed.servida, second);
    await assertServed(second, '<h1>Versión con Python</h1>');
  }

  const slow = await recipe('lenta', '<h1>Versión tardía</h1>', { mode: 'wait', deadline: 20_000 });
  const fast = await recipe('rapida', '<h1>Última versión válida</h1>');
  const pending = build(slow, { id: second.id });
  let latest, late;
  try {
    await waitForMarker(slow.started);
    await assertServed(second, '<h1>Versión con Python</h1>');
    latest = report(await build(fast, { id: second.id }), 'publicada').servida;
  } finally {
    await fs.writeFile(slow.release, '');
    late = await pending;
  }
  assert.equal(latest.url, second.url);
  assert.equal(latest.version, second.version + 1);
  assert.deepEqual(report(late, 'desactualizada').servida, latest);
  await assertServed(latest, '<h1>Última versión válida</h1>');
});
