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
const prefix = 'mind-nativo-runs-servicios-';
const project = 'Servicio Atlas ficticio';

const app = [
  "import fs from 'node:fs';",
  "import { spawn } from 'node:child_process';",
  "import { createServer } from 'node:http';",
  "import { DatabaseSync } from 'node:sqlite';",
  "const [version, mode, marker, stop, gate] = process.argv.slice(2);",
  "const { MIND_SQLITE: file, MIND_LISTO: ready, MIND_LISTO_TOKEN: token } = process.env;",
  "if (!file || !ready || !token) process.exit(19);",
  "const db = new DatabaseSync(file);",
  "db.exec('PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS cuenta (id INTEGER PRIMARY KEY, valor INTEGER NOT NULL); INSERT OR IGNORE INTO cuenta VALUES (1,0)');",
  "const add = db.prepare('UPDATE cuenta SET valor = valor + 7 WHERE id = 1');",
  "const read = db.prepare('SELECT valor FROM cuenta WHERE id = 1');",
  "const child = spawn(process.execPath, ['-e', \"const fs = require('node:fs'); setInterval(() => { if (fs.existsSync(process.argv[1])) process.exit(0); }, 100); setTimeout(() => process.exit(0), 45_000);\", stop], { stdio: 'ignore', windowsHide: true });",
  "const server = createServer((req, res) => {",
  "  if (req.url === '/health') {",
  "    res.writeHead(200, { 'X-Mind-Listo': mode === 'salud-falsa' ? 'token-equivocado' : token });",
  "    res.end('ok');",
  "    return;",
  "  }",
  "  if (req.url !== '/') { res.writeHead(404).end(); return; }",
  "  if (req.method === 'POST') add.run();",
  "  res.writeHead(200, { 'Content-Type': 'application/json' });",
  "  res.end(JSON.stringify({ version, valor: read.get().valor }));",
  "});",
  "server.listen(Number(process.env.MIND_PORT), process.env.MIND_HOST, () => {",
  "  const { port } = server.address();",
  "  fs.writeFileSync(marker, JSON.stringify({ pid: process.pid, hijo: child.pid, puerto: port, archivo: file }));",
  "  const notify = () => {",
  "    fs.writeFileSync(ready + '.tmp', JSON.stringify({ puerto: port }));",
  "    fs.renameSync(ready + '.tmp', ready);",
  "  };",
  "  if (mode === 'esperar') {",
  "    const wait = setInterval(() => {",
  "      if (fs.existsSync(gate)) { clearInterval(wait); notify(); }",
  "    }, 100);",
  "  } else { notify(); }",
  "});",
  "setInterval(() => { if (fs.existsSync(stop)) process.exit(0); }, 100);",
  "setTimeout(() => process.exit(0), 45_000);",
].join('\n');

function start(command, args, env) {
  const child = spawn(command, args, { env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let stderr = '';
  let stopped = false;
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-2048); });
  const closed = new Promise((resolve) => {
    child.once('close', () => { stopped = true; resolve(); });
    child.once('error', (error) => { stderr = String(error); stopped = true; resolve(); });
  });
  return {
    pid: child.pid,
    async connector(file) {
      for (let attempt = 0; attempt < 100; attempt++) {
        assert.ok(!stopped, path.basename(file) + ' no arrancó: ' + stderr);
        const data = await readJson(file);
        if (data) {
          assert.equal(data.pid, child.pid);
          return data;
        }
        await delay(100);
      }
      assert.fail(path.basename(file) + ' no se publicó: ' + stderr);
    },
    async stop() {
      if (!stopped) child.kill();
      await closed;
    },
  };
}

async function readJson(file) {
  const text = await fs.readFile(file, 'utf8').catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  return text && JSON.parse(text);
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

async function assertStopped(marker) {
  const data = await readJson(marker);
  assert.ok(data?.pid > 0 && data?.hijo > 0, 'Falta el registro del proceso y su hijo en ' + path.basename(marker));
  for (let attempt = 0; attempt < 50; attempt++) {
    if (!alive(data.pid) && !alive(data.hijo)) return;
    await delay(100);
  }
  assert.fail('Sigue activo un proceso del servicio de prueba ' + path.basename(marker));
}

function published(response) {
  assert.equal(response.code, 0, response.stderr);
  const body = JSON.parse(response.stdout);
  assert.equal(body.estado, 'abierta');
  assert.equal(body.solicitada.receta, body.servida.receta);
  assert.ok(body.servida.id);
  assert.ok(body.servida.version > 0);
  return body.servida;
}

function fetchView(location, options) {
  return fetch(location, { signal: AbortSignal.timeout(5000), ...options });
}

for (const backend of ['anfitrión', 'Motor Rust']) {
test('los servicios comparten SQLite y conservan la vista con ' + backend, {
  skip: !executable && 'Indica MIND_NATIVE_EXE',
  timeout: 75_000,
}, async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(RUNS, prefix)));
  const base = path.join(root, 'Base');
  const copy = path.join(root, 'Proyecto ficticio');
  const fallback = path.join(root, 'detener-prueba');
  const binary = path.resolve(executable);
  const env = { ...process.env, MIND_AGENT_STARTUP: '0', ...(python ? { MIND_PYTHON: python } : {}) };
  const markers = [];
  let motor, record, host;
  t.after(async () => {
    try {
      // Fallback cooperativo propio, aun si una aserción impide cerrar mediante Mind.
      await fs.writeFile(fallback, '');
      await host?.stop();
      if (record?.pid && record.pid === motor?.pid) {
        await stopCentralMotor(base, { timeoutMs: 4000, reason: 'fin-prueba-servicios' }).catch(() => {});
      }
      await motor?.stop();
      for (const marker of markers) {
        if (await readJson(marker)) await assertStopped(marker);
      }
    } finally {
      assert.equal(path.dirname(root), RUNS);
      assert.ok(path.basename(root).startsWith(prefix));
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  await fs.mkdir(base);
  await fs.mkdir(copy);
  await fs.writeFile(path.join(copy, 'servicio.mjs'), app);
  const standalone = backend === 'Motor Rust';
  motor = standalone
    ? start(binary, ['motor', '--base', base, '--conector'], env)
    : start(process.execPath, [motorScript, base], env);
  record = await motor.connector(path.join(base, 'conector.json'));
  if (!standalone) {
    host = start(binary, ['anfitrion', '--base', base, '--puerto-vistas', '0', '--servicios-prueba'], env);
  }
  const hostRecord = standalone ? record : await host.connector(path.join(base, 'anfitrion.json'));
  if (standalone) {
    assert.equal(hostRecord.pid, motor.pid);
    assert.equal(await readJson(path.join(base, 'anfitrion.json')), null);
  }
  await assert.rejects(fs.stat(path.join(base, 'servicios-datos')), { code: 'ENOENT' });

  const command = (...args) => run(binary, args, { env, timeout: 20000, windowsHide: true }).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    ({ code, stdout, stderr }) => ({ code, stdout: stdout || '', stderr: stderr || '' }),
  );
  const selected = ['--proyecto', project, '--copia', copy];
  async function recipe(version, mode = '') {
    const file = path.join(copy, version + '.json');
    const marker = path.join(root, version + '.iniciada');
    const gate = path.join(root, version + '.continuar');
    markers.push(marker);
    await fs.writeFile(file, JSON.stringify({
      programa: process.execPath,
      argumentos: ['servicio.mjs', version, mode, marker, fallback, gate],
      // El servicio de salud falsa también debe tener tiempo de arrancar y registrar a su hijo.
      plazo_ms: 10000,
    }));
    const review = await command('vista', 'receta', ...selected, '--receta', file);
    assert.equal(review.code, 0, review.stderr);
    const { autorizacion } = JSON.parse(review.stdout);
    assert.match(autorizacion, /^[0-9a-f]{64}$/u);
    return { file, marker, gate, autorizacion };
  }
  function open(recipe, { id, authorization = recipe.autorizacion } = {}) {
    return command('servicio', 'abrir', '--base', base, ...selected, '--receta', recipe.file,
      ...(authorization ? ['--autorizar', authorization] : []), ...(id ? ['--id', id] : []));
  }
  async function info(id) {
    const response = await command('servicio', 'estado', '--base', base, '--id', id);
    assert.equal(response.code, 0, response.stderr);
    return JSON.parse(response.stdout);
  }
  async function close(view, marker) {
    const response = await command('servicio', 'cerrar', '--base', base, '--id', view.id);
    // The CLI emits the service's structured failure on stdout, including the OS error.
    assert.equal(response.code, 0, [path.basename(marker), response.stderr.trim(), response.stdout.trim()].filter(Boolean).join('\n'));
    const body = JSON.parse(response.stdout);
    assert.equal(body.id, view.id);
    assert.equal(body.cerrada, true);
    assert.deepEqual(body.recursos, { procesos: 0, memoria_bytes: 0 });
    assert.equal((await fetchView(view.url, { redirect: 'manual' })).status, 404);
    await assert.rejects(fetchView(view.url_aplicacion), TypeError);
    await assertStopped(marker);
  }
  async function value(view, total, version, options) {
    const result = await fetchView(view.url_aplicacion, options);
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), { version, valor: total });
  }
  async function managed(view, version, total) {
    const target = await fetchView(view.url, { redirect: 'manual' });
    assert.ok([301, 302, 303, 307, 308].includes(target.status));
    const location = new URL(target.headers.get('location'), view.url);
    assert.equal(location.href, new URL(view.url_aplicacion).href);
    const result = await fetchView(view.url);
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), { version, valor: total });
  }

  const initial = await recipe('primera');
  assert.notEqual((await open(initial, { authorization: '' })).code, 0);
  assert.notEqual((await open(initial, { authorization: '0'.repeat(64) })).code, 0);
  await assert.rejects(fs.stat(initial.marker), { code: 'ENOENT' });

  const first = published(await open(initial));
  const control = new URL(hostRecord.url).origin;
  const { token: motorToken } = await readJson(path.join(base, 'conector-secreto.json'));
  const denied = await fetchView(control + '/servicios/' + first.id, {
    headers: { Authorization: 'Bearer ' + motorToken },
  });
  assert.equal(denied.status, 401, 'La conexión de Mind no administra procesos');
  assert.equal((await fetchView(new URL('/servicios/' + first.id, first.url))).status, 404);
  const owned = await readJson(initial.marker);
  assert.equal(first.pid, owned.pid);
  assert.ok(alive(owned.hijo), 'El hijo del servicio está activo');
  assert.equal(new URL(first.url).hostname, '127.0.0.1');
  assert.equal(new URL(first.url_aplicacion).hostname, '127.0.0.1');
  const localDb = await fs.realpath(owned.archivo);
  assert.equal(await fs.realpath(first.sqlite), localDb);
  const relativeDb = path.relative(root, localDb);
  assert.ok(relativeDb && relativeDb !== '..' && !relativeDb.startsWith('..' + path.sep) && !path.isAbsolute(relativeDb));
  assert.equal((await fs.readFile(localDb)).subarray(0, 16).toString(), 'SQLite format 3\0');

  const live = await info(first.id);
  assert.equal(live.pid, first.pid);
  if (process.platform === 'win32') {
    assert.ok(live.recursos.procesos >= 2, 'El supervisor cuenta el proceso y su hijo');
    assert.ok(live.recursos.memoria_bytes > 0, 'El supervisor mide memoria en proceso');
    t.diagnostic('Windows: ' + live.recursos.procesos + ' procesos, ' + live.recursos.memoria_bytes + ' bytes de memoria.');
  }
  await managed(first, 'primera', 0);
  await value(first, 7, 'primera', { method: 'POST' });

  const broken = await recipe('rota', 'salud-falsa');
  const failed = await open(broken, { id: first.id });
  assert.notEqual(failed.code, 0);
  const report = JSON.parse(failed.stdout);
  assert.equal(report.estado, 'fallo');
  assert.equal(report.solicitada.receta, broken.autorizacion);
  assert.equal(report.servida.id, first.id);
  assert.equal(report.servida.version, first.version);
  assert.equal(report.servida.pid, first.pid);
  await assertStopped(broken.marker);
  await managed(first, 'primera', 7);

  const slow = await recipe('tardia', 'esperar');
  const secondRecipe = await recipe('segunda');
  const lateRequest = open(slow, { id: first.id });
  let second, late;
  try {
    for (let check = 0; check < 50 && !await readJson(slow.marker); check++) await delay(100);
    assert.ok(await readJson(slow.marker), 'La versión tardía comenzó');
    await managed(first, 'primera', 7);
    second = published(await open(secondRecipe, { id: first.id }));
  } finally {
    await fs.writeFile(slow.gate, '');
    late = await lateRequest;
  }
  assert.notEqual(late.code, 0);
  const lateReport = JSON.parse(late.stdout);
  assert.equal(lateReport.estado, 'desactualizada');
  assert.equal(lateReport.servida.pid, second.pid);
  await assertStopped(slow.marker);
  assert.equal(second.id, first.id);
  assert.equal(second.url, first.url);
  assert.equal(second.version, first.version + 1);
  assert.equal(await fs.realpath(second.sqlite), localDb);
  await assertStopped(initial.marker);
  await managed(second, 'segunda', 7);
  await close(second, secondRecipe.marker);

  const reopenedRecipe = await recipe('reabierta');
  const reopened = published(await open(reopenedRecipe));
  assert.equal(await fs.realpath(reopened.sqlite), localDb);
  await managed(reopened, 'reabierta', 7);
  await close(reopened, reopenedRecipe.marker);
});
}
