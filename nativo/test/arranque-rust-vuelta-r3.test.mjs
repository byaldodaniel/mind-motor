import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { checkHealthyConnector } from '../../src/connector.js';
import { probeProcesses } from '../../src/process-identity.js';
import { RUNS } from './runs.mjs';
import { extractR3, r3Commit } from './r3-fixture.mjs';

const run = promisify(execFile);
const repo = fileURLToPath(new URL('../..', import.meta.url));
const executable = process.env.MIND_NATIVE_EXE;
const prefix = 'mind-nativo-runs-arranque-';
const env = { ...process.env, MIND_AGENT_STARTUP: '0' };
if (!env.MIND_PYTHON && env.MIND_TEST_BUNDLED_PYTHON) env.MIND_PYTHON = env.MIND_TEST_BUNDLED_PYTHON;
const options = { cwd: repo, env, timeout: 15_000, windowsHide: true };

async function waitUntil(check, explanation, milliseconds = 16_000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(75);
  }
  assert.fail(explanation);
}

async function openMcp(url, token, name, { onElicit, onRoots, cwd } = {}) {
  const headers = {
    Authorization: 'Bearer ' + token,
    Accept: 'application/json, text/event-stream',
    'Content-Type': 'application/json',
  };
  if (cwd) headers['X-Mind-Workspace'] = Buffer.from(JSON.stringify({ cwd, paths: [] })).toString('base64url');
  let nextId = 0;
  async function send(method, params) {
    const id = method.startsWith('notifications/') ? undefined : ++nextId;
    const response = await post({ id, method, params });
    if (id === undefined) {
      assert.ok(response.ok, method);
      await response.text();
      return {};
    }
    assert.equal(response.status, 200, method);
    const reply = response.headers.get('content-type')?.includes('text/event-stream')
      ? await readReply(response, id) : await response.json();
    assert.equal(reply?.id, id, method);
    assert.equal(reply.error, undefined, method);
    return { response, result: reply.result };
  }
  function post(message) {
    return fetch(url, {
      method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', ...message }),
      signal: AbortSignal.timeout(10_000),
    });
  }

  async function readReply(response, id) {
    const decoder = new TextDecoder();
    let buffered = '';
    for await (const chunk of response.body) {
      buffered += decoder.decode(chunk, { stream: true });
      let end;
      while ((end = buffered.search(/\r?\n\r?\n/u)) >= 0) {
        const event = buffered.slice(0, end);
        buffered = buffered.slice(end).replace(/^\r?\n\r?\n/u, '');
        const data = event.split(/\r?\n/u).filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).trimStart()).join('\n');
        if (!data) continue;
        const message = JSON.parse(data);
        if (message.method === 'elicitation/create' || message.method === 'roots/list') {
          const handle = message.method === 'roots/list' ? onRoots : onElicit;
          assert.ok(handle, 'La sesión declara la capacidad solicitada');
          assert.notEqual(message.id, undefined);
          const result = await handle(message.params, { requestId: id, eventId: message.id });
          if (result !== undefined) assert.equal(await reply(message.id, result), 202, 'El cliente responde en otro POST');
        } else if (message.id === id) {
          return message;
        }
      }
    }
    assert.fail('El servidor terminó el flujo sin responder a la llamada.');
  }

  async function reply(id, result) {
    const response = await post({ id, result });
    await response.text();
    return response.status;
  }

  const capabilities = {
    ...(onElicit ? { elicitation: { form: {} } } : {}),
    ...(onRoots ? { roots: { listChanged: true } } : {}),
  };
  const { response, result } = await send('initialize', {
    protocolVersion: '2025-11-25', capabilities, clientInfo: { name, version: '1' },
  });
  const session = response.headers.get('Mcp-Session-Id');
  assert.ok(session, 'La sesión MCP tiene un ID');
  headers['Mcp-Session-Id'] = session;
  headers['MCP-Protocol-Version'] = result.protocolVersion;
  await send('notifications/initialized');
  return {
    session,
    reply,
    notify: send,
    async call(name, args = {}) {
      const { result } = await send('tools/call', { name, arguments: args });
      assert.equal(Boolean(result.isError), false, JSON.stringify(result.structuredContent));
      return result.structuredContent;
    },
    async denied(name, args, code) {
      const { result } = await send('tools/call', { name, arguments: args });
      assert.equal(result.isError, true, name);
      assert.equal(result.structuredContent.error.codigo, code);
    },
    async close() {
      const response = await fetch(url, { method: 'DELETE', headers, signal: AbortSignal.timeout(5_000) });
      assert.ok(response.ok);
      await response.text();
    },
  };
}

async function checkStdio(base, folder, nativeEnv, pid) {
  const child = spawn(process.execPath, ['bin/mind.js', 'mcp', '--base', base, '--carpeta', folder], {
    ...options, env: nativeEnv, stdio: ['pipe', 'pipe', 'ignore'],
  });
  const lines = createInterface({ input: child.stdout });
  const closed = once(child, 'close');
  let id = 0;
  function send(message) {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  }
  async function request(method, params) {
    const incoming = once(lines, 'line', { signal: AbortSignal.timeout(10_000) });
    const expected = ++id;
    send({ id: expected, method, params });
    const [line] = await Promise.race([
      incoming,
      closed.then(() => { throw new Error('El puente stdio terminó antes de responder.'); }),
    ]);
    const response = JSON.parse(line);
    assert.equal(response.id, expected);
    assert.equal(response.error, undefined);
    return response.result;
  }
  try {
    await request('initialize', {
      protocolVersion: '2025-11-25', clientInfo: { name: 'cliente stdio ficticio', version: '1' }, capabilities: {},
    });
    send({ method: 'notifications/initialized' });
    const status = await request('tools/call', { name: 'estado', arguments: {} });
    assert.equal(status.structuredContent.motor_central.pid, pid);
    const opened = status.structuredContent.carpetas.find(item => sameExecutable(item.ruta, folder));
    assert.ok(opened?.permisos.includes('organizar'), 'La carpeta que pasa el iniciador tiene permiso de sesión completo');
    const closing = once(child, 'close', { signal: AbortSignal.timeout(8_000) });
    child.stdin.end();
    const [code] = await closing;
    assert.equal(code, 0);
  } finally {
    lines.close();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
  }
}

async function processIdentity(pid) {
  const [identity] = await probeProcesses([pid], { pythonExecutable: env.MIND_PYTHON });
  return identity;
}

function sameExecutable(actual, expected) {
  if (typeof actual !== 'string') return false;
  const normalize = value => process.platform === 'win32' ? path.normalize(value).toLowerCase() : path.normalize(value);
  return normalize(actual) === normalize(expected);
}

async function auxiliaryProcesses(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  if (process.platform === 'win32') {
    const system = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
    const powershell = path.join(system, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const command = [
      "$mindTestOwner = Get-CimInstance Win32_Process -Filter 'ProcessId = " + pid + "' -ErrorAction Stop",
      "if (-not $mindTestOwner) { throw 'El Motor de prueba no existe' }",
      "Get-CimInstance Win32_Process -Filter 'ParentProcessId = " + pid + "' -ErrorAction Stop |",
      '  Where-Object { $_.CreationDate -ge $mindTestOwner.CreationDate } |',
      '  Select-Object ProcessId,Name,ExecutablePath | ConvertTo-Json -Compress',
    ].join('\n');
    const { stdout } = await run(powershell, ['-NoProfile', '-NonInteractive', '-Command', command], options);
    const children = stdout.trim() ? [JSON.parse(stdout)].flat() : [];
    const console = path.join(system, 'conhost.exe').toLowerCase();
    return children.filter(item => item.ExecutablePath?.toLowerCase() !== console);
  }
  const { stdout } = await run('ps', ['-eo', 'pid=,ppid='], options);
  return stdout.trim().split('\n').map(line => line.trim().split(/\s+/u).map(Number))
    .filter(([, parent]) => parent === pid).map(([child]) => child);
}

function fields(value) {
  const { id, revision, titulo, importante, archivo, referencias } = value;
  return { id, revision, titulo, importante, archivo, referencias };
}

test('el arranque habitual entrega la Base al Motor Rust y r3 la recupera tras un corte', {
  skip: !executable && 'Indica MIND_NATIVE_EXE',
  timeout: 90_000,
}, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(RUNS, prefix)));
  const base = path.join(root, 'Base');
  const notes = path.join(root, 'Notas ficticias');
  const cwd = path.join(root, 'Directorio de inicio ficticio');
  const binary = await fs.realpath(path.resolve(executable));
  let launcher;
  let nativeOwner;
  let rollback;
  const lockPath = path.join(base, 'conector.lock');

  async function interrupt(owner) {
    const actual = await processIdentity(owner.pid);
    assert.equal(actual.status, 'present');
    assert.equal(actual.processBirth, owner.processBirth);
    assert.ok(sameExecutable(actual.executable, binary), 'El PID sigue siendo el binario Rust de prueba');
    assert.equal(JSON.parse(await fs.readFile(lockPath, 'utf8')).processBirth, owner.processBirth);
    process.kill(owner.pid, 'SIGKILL');
    await waitUntil(async () => {
      const identity = await processIdentity(owner.pid);
      return identity.status === 'missing'
        || (identity.status === 'present' && identity.processBirth !== owner.processBirth);
    }, 'El Motor Rust debe salir después de la interrupción.');
  }

  t.after(async () => {
    try {
      if (launcher?.exitCode === null && launcher.signalCode === null) launcher.kill('SIGKILL');
      if (launcher && !rollback) {
        const owner = nativeOwner ?? await fs.readFile(lockPath, 'utf8').then(JSON.parse).catch(() => null);
        if (Number.isSafeInteger(owner?.pid) && owner.pid > 0) {
          const current = await processIdentity(owner.pid);
          if (current.status === 'present' && current.processBirth === owner.processBirth
              && sameExecutable(current.executable, binary)) await interrupt(owner);
        }
      }
      await rollback?.stop('fin-ensayo-arranque-rust');
    } finally {
      assert.equal(path.dirname(root), RUNS);
      assert.ok(path.basename(root).startsWith(prefix));
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  await Promise.all([fs.mkdir(notes), fs.mkdir(cwd)]);
  const old = await extractR3(root);
  const { openSession } = await import(JSON.parse(old('session.js')));
  const { resolveLayout } = await import(JSON.parse(old('layout.js')));
  const layout = await resolveLayout({ base, env });
  const prepare = await openSession({ layout, motorVersion: '1.0.4', observe: false });
  let folder, access, before;
  try {
    await prepare.start();
    folder = await prepare.motor.authorizeFolder(notes);
    const grant = { channel: 'administracion-local' };
    await prepare.policy.set(folder.id, ['encontrar', 'leer', 'escribir'], grant);
    await prepare.policy.setContinuity(['leer'], grant);
    access = await prepare.policy.get(folder.id);
    before = await prepare.motor.recordContinuity({ content: 'Registrado con r3 antes del arranque habitual' });
  } finally {
    await prepare.close();
  }
  const markerPath = path.join(base, 'mind-base.json');
  const marker = await fs.readFile(markerPath);
  const consentPath = path.join(base, 'agent-continuity-access.json');
  const readOnly = await fs.readFile(consentPath);
  const nativeEnv = { ...env, MIND_MOTOR_NATIVO: '1', MIND_MOTOR_NATIVO_EXE: binary };
  launcher = spawn(process.execPath, ['bin/mind.js', 'motor', '--base', base], {
    cwd: repo, env: nativeEnv, stdio: 'ignore', windowsHide: true,
  });
  let startupError;
  let launcherDone = false;
  launcher.once('error', error => { startupError = error.code; });
  launcher.once('close', () => { launcherDone = true; });

  const connector = await waitUntil(async () => {
    assert.equal(startupError, undefined, 'Arranca el lanzador habitual');
    const candidate = await checkHealthyConnector(base);
    if (!candidate && launcherDone && launcher.exitCode !== 0) {
      assert.fail('El lanzador habitual terminó con código ' + launcher.exitCode + '.');
    }
    return candidate;
  }, 'El lanzador habitual debe publicar un conector autenticado.');
  assert.notEqual(connector.health.pid, launcher.pid);
  const owner = JSON.parse(await fs.readFile(lockPath, 'utf8'));
  assert.equal(owner.pid, connector.health.pid);
  assert.equal(owner.pid, connector.state.pid);
  const identity = await processIdentity(owner.pid);
  assert.equal(identity.status, 'present');
  assert.equal(identity.processBirth, owner.processBirth);
  assert.ok(sameExecutable(identity.executable, binary), 'El propietario ejecuta Rust');
  nativeOwner = owner;
  await waitUntil(() => launcherDone, 'El lanzador Node debe salir y dejar solo el Motor Rust.');
  assert.equal(launcher.exitCode, 0);
  const { stdout: wake } = await run(process.execPath, ['bin/mind.js', 'despertar', '--base', base],
    { ...options, env: nativeEnv });
  const reused = JSON.parse(wake);
  assert.equal(reused.pid, owner.pid);
  assert.equal(reused.despertado, false);
  const { stdout: status } = await run(process.execPath, ['bin/mind.js', 'estado', '--base', base],
    { ...options, env: nativeEnv });
  assert.equal(JSON.parse(status).motor_central.pid, owner.pid);
  assert.deepEqual(await auxiliaryProcesses(owner.pid), []);
  for (const environment of [env, nativeEnv]) {
    await assert.rejects(run(process.execPath, ['bin/mind.js', 'permisos', '--base', base],
      { ...options, env: environment }), error => JSON.parse(error.stderr).error.codigo === 'BASE_OCUPADA');
  }
  await checkStdio(base, notes, nativeEnv, owner.pid);

  const url = new URL('/mcp', connector.url).href;
  const first = await openMcp(url, connector.token, 'primer cliente de arranque habitual');
  const decisions = [
    async ({ eventId }) => {
      assert.equal(await first.reply(eventId, { action: 'accept', content: { registrar: true } }), 202);
      return { action: 'decline' };
    },
    async ({ requestId }) => {
      await second.notify('notifications/cancelled', { requestId });
    },
    () => ({ action: 'accept', content: { registrar: true } }),
  ];
  const second = await openMcp(url, connector.token, 'segundo cliente de arranque habitual', {
    onElicit(params, identifiers) {
      assert.equal(params.mode, 'form');
      assert.deepEqual(Object.keys(params.requestedSchema.properties), ['registrar']);
      assert.equal(params.requestedSchema.properties.registrar.type, 'boolean');
      assert.match(params.message, /continuidad/i);
      assert.ok(decisions.length > 0, 'No se abre un formulario adicional');
      return decisions.shift()(identifiers);
    },
  });
  assert.notEqual(first.session, second.session);
  assert.equal((await first.call('estado')).motor_central.pid, owner.pid);
  assert.equal((await second.call('estado')).motor_central.pid, owner.pid);
  const request = { accion: 'solicitar', continuidad: ['leer', 'registrar'], motivo: 'Guardar una nota ficticia.' };
  const pending = await first.call('acceso', request);
  assert.equal(pending.estado, 'pendiente');
  assert.match(pending.solicitud, /^[a-f0-9-]{36}$/u);
  const requestPath = path.join(base, 'consent-request-' + pending.solicitud + '.json');
  const requestRecord = JSON.parse(await fs.readFile(requestPath, 'utf8'));
  assert.equal(requestRecord.format, 'mind-consent-request');
  assert.equal(requestRecord.version, 1);
  assert.equal(requestRecord.kind, 'continuidad');
  assert.deepEqual(requestRecord.requested, ['registrar']);
  assert.deepEqual(await fs.readFile(consentPath), readOnly);
  assert.equal((await second.call('acceso', request)).estado, 'rechazado');
  await second.denied('acceso', request, 'REQUEST_CANCELLED');
  assert.deepEqual(await fs.readFile(consentPath), readOnly);
  const deniedPath = path.join(notes, 'Falta confirmar.md');
  await first.denied('guardar', { titulo: 'Sin autorización', importante: 'Sigue faltando el permiso.', destino: deniedPath },
    'ACCESS_NOT_GRANTED');
  await assert.rejects(fs.stat(deniedPath), { code: 'ENOENT' });
  const allowed = await second.call('acceso', request);
  assert.equal(allowed.estado, 'autorizado');
  assert.deepEqual(allowed.continuidad, ['leer', 'registrar']);
  assert.deepEqual(decisions, []);
  const consent = JSON.parse(await fs.readFile(consentPath, 'utf8'));
  assert.equal(consent.channel, 'formulario-del-cliente');
  assert.equal(consent.registrar, true);
  const outside = path.join(root, 'Fuera de permiso.md');
  await first.denied('guardar', { titulo: 'Sin permiso', importante: 'No sale de la carpeta autorizada.', destino: outside },
    'FOLDER_NOT_AUTHORIZED');
  await assert.rejects(fs.stat(outside), { code: 'ENOENT' });
  let roots = [notes];
  let listed = 0;
  const dynamic = await openMcp(url, connector.token, 'cliente con carpetas abiertas dinámicas', {
    cwd,
    onRoots() {
      listed++;
      return { roots: roots.map(folder => ({ uri: pathToFileURL(folder).href })) };
    },
  });
  try {
    const { carpetas } = await dynamic.call('estado');
    assert.ok(carpetas.some(item => sameExecutable(item.ruta, notes) && item.permisos.includes('organizar')));
    assert.ok(carpetas.every(item => !sameExecutable(item.ruta, cwd)), 'El cwd no sustituye las raíces declaradas por el cliente');
    assert.equal(listed, 1);
    roots = [];
    await dynamic.notify('notifications/roots/list_changed');
    await dynamic.denied('leer', { carpeta: notes, ruta: 'Retoma.md' }, 'FOLDER_NOT_AUTHORIZED');
    assert.equal(listed, 2);
  } finally {
    await dynamic.close();
  }

  const markdownPath = path.join(notes, 'Retoma.md');
  const saved = (await first.call('guardar', {
    titulo: 'Arranque habitual en Rust', importante: 'Esta conversación debe recuperarse en r3.',
    destino: markdownPath, referencias: [{ registro: before.id, relacion: 'continúa' }],
  })).conversacion;
  assert.deepEqual(fields((await second.call('retomar', { id: saved.id })).conversacion), fields(saved));
  const recordPath = path.join(base, 'continuity-' + saved.id + '.json');
  const [record, markdown] = await Promise.all([fs.readFile(recordPath), fs.readFile(markdownPath)]);
  assert.deepEqual(await auxiliaryProcesses(owner.pid), []);

  await interrupt(owner);
  nativeOwner = undefined;
  const { startCentralMotor } = await import(JSON.parse(old('motor-central.js')));
  rollback = await startCentralMotor({ layout, motorVersion: '1.0.4', observe: false, discoverUpdates: null, preferredPort: 0 });
  assert.equal(rollback.alreadyRunning, false);
  const r3 = await openMcp(rollback.url, rollback.token, 'retoma tras volver a r3');
  try {
    assert.deepEqual(fields((await r3.call('conversacion_leer', { id: saved.id })).conversacion), fields(saved));
    assert.deepEqual(await rollback.session.policy.get(folder.id), access);
    assert.deepEqual(await rollback.session.policy.getContinuity(), {
      leer: true, registrar: true, channel: 'formulario-del-cliente', grantedAt: consent.grantedAt,
    });
    const { createConsentRequests } = await import(JSON.parse(old('consent.js')));
    const oldPending = await createConsentRequests(base).list();
    assert.deepEqual(oldPending.find(item => item.id === pending.solicitud), requestRecord);
  } finally {
    await r3.close();
  }
  assert.deepEqual(await fs.readFile(markerPath), marker);
  assert.deepEqual(await fs.readFile(recordPath), record);
  assert.deepEqual(await fs.readFile(markdownPath), markdown);
  t.diagnostic('El lanzador salió | dos sesiones en PID Rust ' + owner.pid + ' | r3 ' + r3Commit.slice(0, 7) + ' retomó ' + saved.id);
});
