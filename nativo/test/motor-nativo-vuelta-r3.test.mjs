import assert from 'node:assert/strict';
import { directChildren } from './process-children.mjs';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { RUNS } from './runs.mjs';
import { extractR3, r3Commit } from './r3-fixture.mjs';

const run = promisify(execFile);
const executable = process.env.MIND_NATIVE_EXE;
const prefix = 'mind-nativo-runs-motor-';
const env = { ...process.env, MIND_AGENT_STARTUP: '0' };
if (!env.MIND_PYTHON && env.MIND_TEST_BUNDLED_PYTHON) env.MIND_PYTHON = env.MIND_TEST_BUNDLED_PYTHON;
const options = { env, timeout: 15_000, windowsHide: true };
const protocolVersion = '2025-11-25';

async function openMcp({ url, token }, name) {
  const headers = {
    Authorization: 'Bearer ' + token,
    Accept: 'application/json, text/event-stream',
    'Content-Type': 'application/json',
  };
  let nextId = 1;
  async function post(method, params, notification = false) {
    const id = notification ? undefined : nextId++;
    const response = await fetch(url, {
      method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.text();
    if (notification) {
      assert.ok(response.ok, method);
      return {};
    }
    assert.equal(response.status, 200, method);
    const result = response.headers.get('content-type')?.includes('text/event-stream')
      ? body.split(/\r?\n/u).filter(line => line.startsWith('data:'))
        .map(line => JSON.parse(line.slice(5))).find(message => message.id === id)
      : JSON.parse(body);
    assert.equal(result?.id, id);
    assert.equal(result.error, undefined, method);
    return { response, value: result.result };
  }

  const { response, value } = await post('initialize', {
    protocolVersion, capabilities: {}, clientInfo: { name, version: '1' },
  });
  const session = response.headers.get('mcp-session-id');
  assert.ok(session, 'MCP anuncia una sesión');
  headers['Mcp-Session-Id'] = session;
  headers['MCP-Protocol-Version'] = value.protocolVersion;
  await post('notifications/initialized', undefined, true);

  async function invoke(name, args) {
    return (await post('tools/call', { name, arguments: args })).value;
  }
  return {
    session,
    async names() {
      return (await post('tools/list', {})).value.tools.map(tool => tool.name);
    },
    async call(name, args = {}) {
      const result = await invoke(name, args);
      assert.equal(Boolean(result.isError), false, JSON.stringify(result.structuredContent));
      return result.structuredContent;
    },
    async denied(name, args) {
      const result = await invoke(name, args);
      assert.equal(result.isError, true, name);
      return result.structuredContent.error.codigo;
    },
    async close() {
      const response = await fetch(url, {
        method: 'DELETE', headers, signal: AbortSignal.timeout(5_000),
      });
      assert.ok(response.ok, 'Cierre MCP');
      await response.text();
    },
  };
}

function startRust(base) {
  const process = spawn(path.resolve(executable), ['motor', '--base', base], {
    env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let failure;
  let diagnostic = '';
  process.once('error', error => { failure = error.code; });
  process.stderr.setEncoding('utf8');
  process.stderr.on('data', data => { diagnostic = (diagnostic + data).slice(-2048); });
  const closed = new Promise(resolve => {
    process.once('close', (code, signal) => resolve({ code, signal }));
  });
  return {
    pid: process.pid,
    async announcement() {
      const lines = createInterface({ input: process.stdout });
      try {
        const [line] = await Promise.race([
          once(lines, 'line', { signal: AbortSignal.timeout(10_000) }),
          closed.then(() => { throw new Error('Rust no arrancó: ' + (failure ?? diagnostic)); }),
        ]);
        let record;
        try { record = JSON.parse(line); }
        catch { throw new Error('Rust no anunció un registro JSON válido.'); }
        assert.equal(record.pid, process.pid);
        assert.ok(typeof record.token === 'string' && record.token.length > 0);
        assert.ok(Number.isInteger(record.port) && record.port > 0);
        const url = new URL(record.url);
        assert.equal(url.origin, 'http://127.0.0.1:' + record.port);
        assert.equal(url.pathname, '/mcp');
        return record;
      } finally {
        lines.close();
        process.stdout.resume();
      }
    },
    async refused() {
      const timeout = new AbortController();
      try {
        const result = await Promise.race([
          closed,
          delay(5_000, null, { signal: timeout.signal }),
        ]);
        assert.ok(result && Number.isInteger(result.code) && result.code !== 0,
          'Una segunda instancia debe salir por Base ocupada');
      } finally {
        timeout.abort();
      }
    },
    async interrupt() {
      assert.ok(process.kill('SIGKILL'), 'El proceso Rust de prueba seguía vivo');
      const result = await closed;
      assert.notEqual(result.code, 0);
    },
    async cleanup() {
      if (process.exitCode === null && process.signalCode === null) process.kill('SIGKILL');
      await closed;
    },
  };
}

function fields(value) {
  const { id, revision, titulo, importante, archivo, referencias } = value;
  return { id, revision, titulo, importante, archivo, referencias };
}

test('Motor Rust en un proceso y vuelta a r3 tras interrupción abrupta', {
  skip: !executable && 'Indica MIND_NATIVE_EXE',
  timeout: 90_000,
}, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(RUNS, prefix)));
  let rust;
  let previousMotor;
  t.after(async () => {
    try {
      await rust?.cleanup();
      await previousMotor?.stop('fin-ensayo-vuelta');
    } finally {
      assert.equal(path.dirname(root), RUNS);
      assert.ok(path.basename(root).startsWith(prefix));
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
  const base = path.join(root, 'Base');
  const notes = path.join(root, 'Notas ficticias');
  await fs.mkdir(notes);

  const moduleUrl = await extractR3(root);
  const prepare = [
    'const { openSession } = await import(' + moduleUrl('session.js') + ');',
    'const { resolveLayout } = await import(' + moduleUrl('layout.js') + ');',
    'const [base, notes] = process.argv.slice(1);',
    "const session = await openSession({ layout: await resolveLayout({ base }), motorVersion: '1.0.4', observe: false });",
    'try {',
    '  await session.start();',
    '  const folder = await session.motor.authorizeFolder(notes);',
    "  const guard = { channel: 'administracion-local' };",
    "  await session.policy.set(folder.id, ['encontrar', 'leer', 'escribir'], guard);",
    "  await session.policy.setContinuity(['leer', 'registrar'], guard);",
    "  const seed = await session.motor.recordContinuity({ content: 'Punto de partida guardado en r3' });",
    '  const access = await session.policy.get(folder.id);',
    '  const continuity = await session.policy.getContinuity();',
    '  console.log(JSON.stringify({ seed, folderId: folder.id, access, continuity }));',
    '} finally { await session.close(); }',
  ].join('\n');
  const prepared = JSON.parse((await run(process.execPath,
    ['--input-type=module', '-e', prepare, base, notes], options)).stdout);
  const markerPath = path.join(base, 'mind-base.json');
  const seedPath = path.join(base, 'continuity-' + prepared.seed.id + '.json');
  const [marker, seed] = await Promise.all([fs.readFile(markerPath), fs.readFile(seedPath)]);

  rust = startRust(base);
  const endpoint = await rust.announcement();
  const lockPath = path.join(base, 'conector.lock');
  const lock = await fs.readFile(lockPath);
  const competitor = startRust(base);
  try { await competitor.refused(); }
  finally { await competitor.cleanup(); }
  assert.ok((await fs.readFile(lockPath)).equals(lock), 'La otra instancia conserva el bloqueo propietario');
  const { acquireOwnerFileLock } = await import(JSON.parse(moduleUrl('process-identity.js')));
  await assert.rejects(acquireOwnerFileLock(lockPath, { pythonExecutable: env.MIND_PYTHON, timeoutMs: 0 }),
    { code: 'LOCK_BUSY' });
  assert.ok((await fs.readFile(lockPath)).equals(lock), 'r3 reconoce al propietario nativo en vida');
  const unauthorized = await fetch(endpoint.url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(unauthorized.status, 401);
  await unauthorized.text();

  const first = await openMcp(endpoint, 'primer cliente ficticio');
  const second = await openMcp(endpoint, 'segundo cliente ficticio');
  assert.notEqual(first.session, second.session);
  const names = await first.names();
  for (const name of ['estado', 'guardar', 'actualizar', 'retomar', 'buscar', 'leer', 'crear', 'modificar']) {
    assert.ok(names.includes(name), name);
  }
  const status = await first.call('estado');
  assert.equal(status.motor_central?.pid ?? status.pid, rust.pid);
  const initialChildren = await directChildren(rust.pid);
  assert.deepEqual(initialChildren.auxiliaries, [], 'El Motor atiende sesiones sin procesos auxiliares');

  const unauthorizedPath = path.join(root, 'Fuera.md');
  const denied = await first.denied('guardar', {
    titulo: 'Sin permiso', importante: 'Contenido ficticio', destino: unauthorizedPath,
  });
  assert.ok(['ACCESS_NOT_GRANTED', 'FOLDER_NOT_AUTHORIZED', 'DESTINATION_NOT_AUTHORIZED'].includes(denied), denied);
  await assert.rejects(fs.stat(unauthorizedPath), { code: 'ENOENT' });

  const absentFolder = path.join(notes, 'Subcarpeta sin permiso');
  const cannotOrganize = await first.denied('guardar', {
    titulo: 'Sin permiso de organización', importante: 'Contenido ficticio',
    destino: path.join(absentFolder, 'Nota.md'),
  });
  assert.equal(cannotOrganize, 'ACCESS_NOT_GRANTED');
  await assert.rejects(fs.stat(absentFolder), { code: 'ENOENT' });
  assert.deepEqual((await fs.readdir(base)).filter(name => name.startsWith('continuity-')),
    [path.basename(seedPath)]);

  const file = { carpeta: prepared.folderId, ruta: 'Comprobación.txt' };
  const created = await first.call('crear', { ...file, contenido: 'Primera línea.' });
  const read = await second.call('leer', file);
  assert.equal(read.contenido, 'Primera línea.');
  assert.equal(read.version, created.version);
  const changed = await first.call('modificar', { ...file, version: read.version, contenido: 'Texto actualizado.' });
  assert.notEqual(changed.version, read.version);
  assert.equal((await second.call('leer', file)).contenido, 'Texto actualizado.');
  assert.equal(await first.denied('modificar', { ...file, version: read.version, contenido: 'Obsoleto' }),
    'VERSION_CONFLICT');
  const extraPath = path.join(notes, file.ruta);
  const extra = await fs.readFile(extraPath);

  const recordReferences = [{ registro: prepared.seed.id, relacion: 'resultado de' }];
  const initialRecord = (await first.call('guardar', {
    en: 'continuidad', tipo: 'resultado', contenido: { datos: [1, true, null] }, referencias: recordReferences,
  })).registro;
  assert.equal(initialRecord.revision, 1);
  const updateRecord = { en: 'continuidad', id: initialRecord.id, revision: 1, contenido: { datos: [2, false, null] } };
  const savedRecord = (await second.call('actualizar', updateRecord)).registro;
  assert.equal(savedRecord.revision, 2);
  assert.equal(savedRecord.tipo, initialRecord.tipo);
  assert.equal(savedRecord.creado, initialRecord.creado);
  assert.equal(savedRecord.origen, initialRecord.origen);
  assert.deepEqual(savedRecord.referencias, recordReferences);
  assert.deepEqual(savedRecord.contenido, updateRecord.contenido);
  assert.equal(await first.denied('actualizar', updateRecord), 'CONTINUITY_REVISION_CONFLICT');
  const genericPath = path.join(base, 'continuity-' + savedRecord.id + '.json');
  const genericRecord = await fs.readFile(genericPath);

  const markdownPath = path.join(notes, 'Continuidad.md');
  const references = [{ registro: prepared.seed.id, relacion: 'continúa' }];
  const initial = await first.call('guardar', {
    titulo: 'Continuidad nativa', importante: 'Primera revisión.', destino: markdownPath, referencias: references,
  });
  const id = initial.conversacion.id;
  assert.match(id, /^[0-9a-f-]{36}$/u);
  assert.equal(initial.estado, 'registrada');
  assert.equal(initial.conversacion.revision, 1);
  assert.deepEqual(fields((await second.call('retomar', { id })).conversacion), fields(initial.conversacion));
  const updated = await second.call('actualizar', { id, revision: 1, importante: 'Segunda revisión, lista para retomar.' });
  assert.equal(updated.estado, 'actualizada');
  assert.deepEqual(fields(updated.conversacion), {
    id, revision: 2, titulo: 'Continuidad nativa', importante: 'Segunda revisión, lista para retomar.',
    archivo: markdownPath, referencias: references,
  });
  assert.equal(await first.denied('actualizar', { id, revision: 1, importante: 'Revisión obsoleta.' }),
    'CONTINUITY_REVISION_CONFLICT');
  const hits = await first.call('buscar', { en: 'conversaciones', consulta: 'segunda' });
  assert.deepEqual(hits.conversaciones.map(item => item.id), [id]);
  assert.deepEqual(fields((await second.call('retomar', { consulta: 'segunda' })).conversacion), fields(updated.conversacion));
  const recordPath = path.join(base, 'continuity-' + id + '.json');
  const markdown = await fs.readFile(markdownPath);
  assert.equal(markdown.toString('utf8'), '<!-- mind-conversation:' + id + ' revision:2 -->\n'
    + '# Continuidad nativa\n\nSegunda revisión, lista para retomar.\n');

  let expected = updated.conversacion;
  if (process.platform === 'win32') {
    const handle = await fs.open(markdownPath, 'r+');
    try {
      const pending = await first.call('actualizar', { id, revision: 2, importante: 'Revisión durable con Markdown pendiente.' });
      assert.equal(pending.estado, 'pendiente_archivo');
      assert.equal(pending.archivo.codigo, 'FILE_IN_USE');
      assert.equal(pending.conversacion.revision, 3);
      expected = pending.conversacion;
    } finally {
      await handle.close();
    }
    assert.deepEqual(await fs.readFile(markdownPath), markdown);
  }
  const record = await fs.readFile(recordPath);

  const finalChildren = await directChildren(rust.pid);
  assert.deepEqual(finalChildren.auxiliaries, [], 'Rust conserva un solo proceso antes de la interrupción');
  if (initialChildren.systemConsoles || finalChildren.systemConsoles) {
    t.diagnostic('Windows registró conhost.exe del sistema para esta consola de prueba.');
  }
  const nativePid = rust.pid;
  // Interrumpe el proceso propietario sin cerrar las dos sesiones MCP.
  await rust.interrupt();
  rust = undefined;
  assert.ok((await fs.readFile(lockPath)).equals(lock), 'La interrupción conserva el bloqueo que r3 debe recuperar');

  const { startCentralMotor } = await import(JSON.parse(moduleUrl('motor-central.js')));
  const { resolveLayout } = await import(JSON.parse(moduleUrl('layout.js')));
  const layout = await resolveLayout({ base, env });
  const rollback = await startCentralMotor({
    layout, motorVersion: '1.0.4', observe: false, discoverUpdates: null, preferredPort: 0,
  });
  assert.equal(rollback.alreadyRunning, false);
  previousMotor = rollback;
  assert.equal(JSON.parse(await fs.readFile(lockPath, 'utf8')).pid, process.pid);
  const r3 = await openMcp(rollback, 'retoma en r3');
  try {
    const recovered = await r3.call('conversacion_leer', { id });
    assert.deepEqual(fields(recovered.conversacion), fields(expected));
    assert.deepEqual(await rollback.session.policy.get(prepared.folderId), prepared.access);
    assert.deepEqual(await rollback.session.policy.getContinuity(), prepared.continuity);
    assert.deepEqual(await rollback.session.motor.getContinuity(prepared.seed.id), prepared.seed);
    const oldRecords = await r3.call('continuidad_consultar', { ids: [savedRecord.id] });
    assert.deepEqual(oldRecords.registros, [savedRecord]);
    assert.equal((await r3.call('leer', file)).contenido, 'Texto actualizado.');
  } finally {
    await r3.close();
  }
  assert.deepEqual(await fs.readFile(markerPath), marker);
  assert.deepEqual(await fs.readFile(seedPath), seed);
  assert.deepEqual(await fs.readFile(recordPath), record);
  assert.deepEqual(await fs.readFile(markdownPath), markdown);
  assert.deepEqual(await fs.readFile(genericPath), genericRecord);
  assert.deepEqual(await fs.readFile(extraPath), extra);
  t.diagnostic('Rust PID ' + nativePid + ' interrumpido | r3 ' + r3Commit.slice(0, 7)
    + ' retomó revisión ' + expected.revision);
});
