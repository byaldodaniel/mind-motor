import assert from 'node:assert/strict';
import { auxiliaryProcesses } from './process-children.mjs';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
  setupBackup, saveRecoveryFile, configureBackupDestination, verifyBackup, restoreBackup, listBackups,
  readBackupConfig,
} from '../../src/backup.js';
import { checkHealthyConnector } from '../../src/connector.js';
import { probeProcesses } from '../../src/process-identity.js';
import { main as cliMain } from '../../src/product-cli.js';
import { RUNS } from './runs.mjs';
import { assertViewHtml } from './vista-html.mjs';
import { extractR3, r3Commit } from './r3-fixture.mjs';

const run = promisify(execFile);
const repo = fileURLToPath(new URL('../..', import.meta.url));
const executable = process.env.MIND_NATIVE_EXE;
const testWindowsScheduler = process.platform === 'win32' && process.env.MIND_TEST_WINDOWS_SCHEDULER === '1';
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

async function runWindowsScheduledFixture(root, base, nativeEnv, at) {
  const taskName = 'Mind-Prueba-Etapa3-' + path.basename(root);
  const taskScript = path.join(root, 'turno.mjs');
  const results = path.join(root, 'turnos.jsonl');
  const node = process.execPath;
  const shell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const env = {
    ...options.env,
    MIND_TEST_TASK_NAME: taskName, MIND_TEST_TASK_RUNTIME: node, MIND_TEST_TASK_SCRIPT: taskScript,
    MIND_TEST_TASK_REPO: repo, MIND_TEST_TASK_WHEN: at.toISOString(),
  };
  const powershell = command => run(shell, ['-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference = 'Stop'; " + command], { ...options, env });
  await fs.writeFile(taskScript, [
    "import { spawnSync } from 'node:child_process';",
    "import fs from 'node:fs';",
    "const result = spawnSync(process.execPath, " + JSON.stringify([path.join(repo, 'bin', 'mind.js'), 'programadas', '--base', base]) + ", {",
    "  cwd: " + JSON.stringify(repo) + ", encoding: 'utf8', timeout: 30000, windowsHide: true,",
    "  env: { ...process.env, ..."+JSON.stringify({
      MIND_MOTOR_NATIVO: '1', MIND_MOTOR_NATIVO_EXE: nativeEnv.MIND_MOTOR_NATIVO_EXE,
      MIND_AGENT_STARTUP: '0', MIND_PYTHON: nativeEnv.MIND_PYTHON,
    })+" },",
    "});",
    "fs.appendFileSync("+JSON.stringify(results)+", JSON.stringify({ status: result.status, stdout: result.stdout, stderr: result.stderr, at: Date.now() }) + '\\n');",
    "process.exitCode = result.status ?? 1;",
  ].join('\n'));
  const readResults = async () => (await fs.readFile(results, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '';
    throw error;
  })).split('\n').filter(Boolean).map(line => JSON.parse(line));

  let registered = false;
  try {
    await powershell([
      'if (Get-ScheduledTask -TaskName $env:MIND_TEST_TASK_NAME -ErrorAction SilentlyContinue) { throw "La tarea de prueba ya existe." }',
      '$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name',
      "$at = [DateTimeOffset]::Parse($env:MIND_TEST_TASK_WHEN).LocalDateTime",
      "if ($at -le (Get-Date)) { throw 'La hora del ensayo ya pasó.' }",
      "$argument = [char]34 + $env:MIND_TEST_TASK_SCRIPT + [char]34",
      '$action = New-ScheduledTaskAction -Execute $env:MIND_TEST_TASK_RUNTIME -Argument $argument -WorkingDirectory $env:MIND_TEST_TASK_REPO',
      '$trigger = New-ScheduledTaskTrigger -Once -At $at',
      '$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited',
      '$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries',
      'Register-ScheduledTask -TaskName $env:MIND_TEST_TASK_NAME -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null',
    ].join('\n'));
    registered = true;
    const first = await waitUntil(async () => (await readResults())[0],
      'Windows debe ejecutar la tarea a la hora programada.', Math.max(5_000, at.getTime() - Date.now() + 45_000));
    assert.equal(first.status, 0, first.stderr);
    assert.equal(JSON.parse(first.stdout).ejecutadas, 1);
    assert.ok(first.at >= at.getTime());
    const { stdout: lastRun } = await powershell(
      '$info = Get-ScheduledTaskInfo -TaskName $env:MIND_TEST_TASK_NAME; $info.LastRunTime.ToUniversalTime().ToString("o")');
    assert.ok(Date.parse(lastRun.trim()) >= at.getTime(), 'El Programador acredita el turno por horario');
    await waitUntil(async () => {
      const { stdout } = await powershell('(Get-ScheduledTask -TaskName $env:MIND_TEST_TASK_NAME).State');
      return stdout.trim() !== 'Running';
    }, 'La tarea programada termina antes de volver a invocarla.');
    await powershell('Start-ScheduledTask -TaskName $env:MIND_TEST_TASK_NAME');
    const second = await waitUntil(async () => (await readResults())[1],
      'Windows debe completar una segunda invocación del mismo turno.', 40_000);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(JSON.parse(second.stdout).ejecutadas, 0);
    await waitUntil(async () => !(await checkHealthyConnector(base)), 'El Motor temporal sale tras programadas.');
  } finally {
    if (registered) await powershell('Unregister-ScheduledTask -TaskName $env:MIND_TEST_TASK_NAME -Confirm:$false');
  }
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
      return result.structuredContent.error;
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

function fields(value) {
  const { id, revision, titulo, importante, archivo, referencias } = value;
  return { id, revision, titulo, importante, archivo, referencias };
}

async function runInteractiveCli(args, respond, { native = true } = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = true;
  output.isTTY = true;
  output.columns = 100;
  let captured = '';
  let seen = 0;
  output.setEncoding('utf8');
  output.on('data', chunk => {
    captured += chunk;
    const tail = captured.slice(seen);
    if (/(?:\[[sS]\/[nN]\]|\[0-3\]:|\(Enter para ninguna\):|para siempre:)\s$/u.test(tail)) {
      const answer = respond(tail, captured);
      seen = captured.length;
      setImmediate(() => input.write(`${answer}\n`));
    }
  });
  const saved = {
    MIND_AGENT_STARTUP: process.env.MIND_AGENT_STARTUP,
    MIND_MOTOR_NATIVO: process.env.MIND_MOTOR_NATIVO,
    MIND_MOTOR_NATIVO_EXE: process.env.MIND_MOTOR_NATIVO_EXE,
  };
  process.env.MIND_AGENT_STARTUP = '0';
  if (native) {
    process.env.MIND_MOTOR_NATIVO = '1';
    process.env.MIND_MOTOR_NATIVO_EXE = path.resolve(executable);
  } else {
    delete process.env.MIND_MOTOR_NATIVO;
    delete process.env.MIND_MOTOR_NATIVO_EXE;
  }
  try {
    const code = await cliMain(args, { input, output });
    assert.equal(code, 0, captured);
    return captured;
  } finally {
    input.end();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function openStdioMcp(args, envVars, clientInfo) {
  const child = spawn(process.execPath, args, {
    cwd: repo,
    env: envVars,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4096); });
  const pending = new Map();
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (message.id !== undefined && pending.has(message.id)) {
      const resolve = pending.get(message.id);
      pending.delete(message.id);
      resolve(message);
    }
  });
  const exited = once(child, 'exit');
  let nextId = 0;
  function send(method, params) {
    const id = method.startsWith('notifications/') ? undefined : ++nextId;
    const payload = JSON.stringify({ jsonrpc: '2.0', ...(id !== undefined ? { id } : {}), method, ...(params !== undefined ? { params } : {}) });
    if (id === undefined) {
      child.stdin.write(payload + '\n');
      return Promise.resolve(null);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timeout esperando respuesta stdio MCP para ${method}: ${stderr}`));
      }, 15_000);
      pending.set(id, message => {
        clearTimeout(timer);
        assert.equal(message.error, undefined, JSON.stringify(message.error));
        resolve(message.result);
      });
      child.stdin.write(payload + '\n');
    });
  }
  await send('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo });
  await send('notifications/initialized');
  return {
    listTools: () => send('tools/list', {}),
    async call(name, argsObj) {
      const result = await send('tools/call', { name, arguments: argsObj });
      assert.equal(Boolean(result.isError), false, JSON.stringify(result.structuredContent));
      return result.structuredContent;
    },
    async close() {
      child.stdin.end();
      const [code] = await Promise.race([
        exited,
        delay(10_000).then(() => {
          child.kill();
          return ['timeout'];
        }),
      ]);
      lines.close();
      assert.equal(code, 0, stderr);
    },
  };
}

test('el arranque habitual entrega la Base al Motor Rust y r3 la recupera tras un corte', {
  skip: !executable && 'Indica MIND_NATIVE_EXE',
  timeout: testWindowsScheduler ? 272_000 : 152_000,
}, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(RUNS, prefix)));
  const base = path.join(root, 'Base');
  const notes = path.join(root, 'Notas ficticias');
  const extra = path.join(root, 'Notas extra ficticias');
  const elicitFolder = path.join(root, 'Carpeta formulario ficticia');
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

  await Promise.all([fs.mkdir(notes), fs.mkdir(extra), fs.mkdir(elicitFolder), fs.mkdir(cwd)]);
  await Promise.all([
    fs.writeFile(path.join(notes, 'Apunte.txt'), 'Nota inicial en carpeta.\n'),
    fs.writeFile(path.join(extra, 'Extra.txt'), 'Contenido en carpeta extra.\n'),
  ]);
  const old = await extractR3(root);

  const markerPath = path.join(base, 'mind-base.json');
  const consentPath = path.join(base, 'agent-continuity-access.json');
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
  assert.equal(connector.health.backend, 'rust');
  const marker = await fs.readFile(markerPath);
  const markerJson = JSON.parse(marker.toString('utf8'));
  assert.equal(markerJson.format, 'mind-base');
  assert.equal(markerJson.version, 3);
  assert.match(markerJson.baseId, /^[a-f0-9-]{36}$/u);

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
  await checkStdio(base, notes, nativeEnv, owner.pid);

  const url = new URL('/mcp', connector.url).href;
  const first = await openMcp(url, connector.token, 'primer cliente de arranque habitual');
  const second = await openMcp(url, connector.token, 'segundo cliente de arranque habitual');
  assert.notEqual(first.session, second.session);
  assert.equal((await first.call('estado')).motor_central.pid, owner.pid);
  assert.equal((await second.call('estado')).motor_central.pid, owner.pid);

  // Solicitudes pendientes y rechazo desde consola con Rust activo.
  const continuityReq = { accion: 'solicitar', continuidad: ['leer', 'registrar'], motivo: 'Conservar notas de trabajo.' };
  const notesReq = { accion: 'solicitar', ruta: notes, acceso: 'completo', motivo: 'Leer y editar notas ficticias.' };
  const pendingContinuity = await first.call('acceso', continuityReq);
  const pendingNotes = await first.call('acceso', notesReq);
  assert.equal(pendingContinuity.estado, 'pendiente');
  assert.equal(pendingNotes.estado, 'pendiente');
  for (const client of [first, second]) {
    const state = await client.call('estado');
    assert.equal(state.solicitudes_pendientes.length, 2);
  }

  // El cliente MCP no puede aprobar su propia solicitud ni operar la consola.
  const consoleToken = JSON.parse(await fs.readFile(path.join(base, 'conector-consola.json'), 'utf8')).token;
  assert.notEqual(consoleToken, connector.token);
  async function rpcAs(extraHeaders, payload) {
    const response = await fetch(new URL('/rpc', connector.url), {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + connector.token,
        'Content-Type': 'application/json',
        ...extraHeaders,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5_000),
    });
    return { status: response.status, body: await response.json() };
  }
  for (const payload of [
    { accion: 'consola', operacion: 'autorizar_carpeta', ruta: notes },
    { accion: 'consola', operacion: 'guardar_acceso', id: 'x', permisos: ['encontrar'] },
    { accion: 'consola', operacion: 'guardar_continuidad', permisos: ['leer', 'registrar'] },
    { accion: 'consola', operacion: 'retirar_solicitud', id: pendingNotes.solicitud },
    { accion: 'consola', operacion: 'listar_solicitudes' },
  ]) {
    const deniedRpc = await rpcAs({}, payload);
    assert.equal(deniedRpc.status, 403, JSON.stringify(payload));
    assert.equal(deniedRpc.body?.error?.codigo, 'CONSOLE_CREDENTIAL_REQUIRED');
  }
  const spoofedHeader = await rpcAs(
    { 'X-Mind-Consola': connector.token },
    { accion: 'consola', operacion: 'autorizar_carpeta', ruta: notes },
  );
  assert.equal(spoofedHeader.status, 403);
  assert.equal(spoofedHeader.body?.error?.codigo, 'CONSOLE_CREDENTIAL_REQUIRED');
  const approveViaTool = await rpcAs({}, {
    accion: 'herramienta',
    tool: 'acceso',
    args: { accion: 'aprobar', solicitud: pendingNotes.solicitud },
  });
  assert.equal(approveViaTool.body?.isError, true);
  await first.denied('acceso', { accion: 'aprobar', solicitud: pendingNotes.solicitud }, 'INVALID_ARGUMENTS');
  for (const client of [first, second]) {
    const state = await client.call('estado');
    assert.equal(state.solicitudes_pendientes.length, 2);
  }
  await assert.rejects(fs.stat(consentPath), { code: 'ENOENT' });
  const baseFiles = await fs.readdir(base);
  assert.equal(baseFiles.some(file => file.startsWith('folder-authorization-') || file.startsWith('folder-access-')), false);
  const { stdout: mcpHeaders } = await run(
    process.execPath, ['bin/mind.js', 'despertar', '--headers', '--base', base],
    { ...options, env: nativeEnv },
  );
  assert.equal(mcpHeaders.includes(connector.token), true);
  assert.equal(mcpHeaders.includes(consoleToken), false);

  await assert.rejects(
    run(process.execPath, ['bin/mind.js', 'autorizar', '--base', base], { ...options, env: nativeEnv }),
    error => JSON.parse(error.stderr).error.codigo === 'CONSOLE_REQUIRED',
  );
  const rejectedConsole = await runInteractiveCli(['autorizar', '--base', base], tail => {
    if (tail.includes('Elige una opción')) return '0';
    if (tail.includes('¿Autorizar?')) return 'n';
    assert.fail('Pregunta inesperada al rechazar: ' + tail);
  });
  assert.match(rejectedConsole, /Rechazada\./);
  await assert.rejects(fs.stat(consentPath), { code: 'ENOENT' });
  for (const client of [first, second]) {
    const state = await client.call('estado');
    assert.deepEqual(state.solicitudes_pendientes, []);
    assert.deepEqual(state.carpetas, []);
    assert.deepEqual(state.continuidad.permisos, []);
  }
  const deniedPath = path.join(notes, 'Falta confirmar.md');
  await first.denied('guardar', { titulo: 'Sin autorización', importante: 'Sigue faltando el permiso.', destino: deniedPath },
    'ACCESS_NOT_GRANTED');
  await first.denied('leer', { carpeta: notes, ruta: 'Apunte.txt' }, 'FOLDER_NOT_AUTHORIZED');
  await assert.rejects(fs.stat(deniedPath), { code: 'ENOENT' });

  // Aprobación desde consola con Rust como único escritor.
  assert.equal((await first.call('acceso', continuityReq)).estado, 'pendiente');
  assert.equal((await first.call('acceso', notesReq)).estado, 'pendiente');
  const extraReq = { accion: 'solicitar', ruta: extra, acceso: 'leer', motivo: 'Leer notas extra.' };
  assert.equal((await first.call('acceso', extraReq)).estado, 'pendiente');
  await runInteractiveCli(['autorizar', '--base', base], tail => {
    if (tail.includes('Elige una opción')) {
      if (tail.includes(notes)) return '3';
      if (tail.includes(extra)) return '2';
      assert.fail('Carpeta desconocida: ' + tail);
    }
    if (tail.includes('Subcarpetas a excluir')) return '';
    if (tail.includes('¿Autorizar?')) return 's';
    if (tail.includes('¿Permitir:')) return 's';
    assert.fail('Pregunta inesperada al aprobar: ' + tail);
  });

  let notesId, extraId;
  for (const client of [first, second]) {
    const state = await client.call('estado');
    assert.deepEqual(state.solicitudes_pendientes, []);
    assert.deepEqual(state.continuidad.permisos, ['leer', 'registrar']);
    const notesEntry = state.carpetas.find(item => sameExecutable(item.ruta, notes));
    const extraEntry = state.carpetas.find(item => sameExecutable(item.ruta, extra));
    assert.deepEqual(notesEntry?.permisos, ['encontrar', 'leer', 'escribir', 'organizar']);
    assert.deepEqual(extraEntry?.permisos, ['encontrar', 'leer']);
    notesId = notesEntry.id;
    extraId = extraEntry.id;
  }
  const consent = JSON.parse(await fs.readFile(consentPath, 'utf8'));
  assert.equal(consent.channel, 'consola');
  assert.equal(consent.leer, true);
  assert.equal(consent.registrar, true);

  // Operaciones en las carpetas autorizadas y continuidad entre ambas sesiones.
  const seed = (await first.call('guardar', {
    en: 'continuidad', tipo: 'contexto', contenido: 'Registro previo guardado con Rust',
  })).registro;
  let markdownPath = path.join(notes, 'Retoma.md');
  let saved = (await first.call('guardar', {
    titulo: 'Arranque habitual en Rust', importante: 'Esta conversación debe recuperarse en r3.',
    destino: markdownPath, referencias: [{ registro: seed.id, relacion: 'continúa' }],
  })).conversacion;
  const written = await first.call('crear', { carpeta: notesId, ruta: 'Nota.txt', contenido: 'Escrita en Rust.\n' });
  assert.equal(written.estado, 'creado');
  assert.equal(written.indice, 'ok');
  assert.deepEqual(fields((await second.call('retomar', { id: saved.id })).conversacion), fields(saved));
  assert.equal((await second.call('leer', { carpeta: notesId, ruta: 'Nota.txt' })).contenido, 'Escrita en Rust.\n');
  assert.equal((await second.call('leer', { carpeta: extraId, ruta: 'Extra.txt' })).contenido, 'Contenido en carpeta extra.\n');
  const outside = path.join(root, 'Fuera de permiso.md');
  await first.denied('guardar', { titulo: 'Sin permiso', importante: 'No sale de la carpeta autorizada.', destino: outside },
    'FOLDER_NOT_AUTHORIZED');
  await assert.rejects(fs.stat(outside), { code: 'ENOENT' });

  // Etapa 2: edición puntual, lectura por sección, organización, papelera e índice compartido.
  const edited = await first.call('modificar', {
    carpeta: notesId,
    ruta: 'Nota.txt',
    ediciones: [{ buscar: 'Escrita en Rust.', reemplazar: 'Editada en Rust.' }],
  });
  assert.equal(edited.estado, 'modificado');
  assert.equal(edited.indice, 'ok');
  assert.equal((await second.call('leer', { carpeta: notesId, ruta: 'Nota.txt' })).contenido, 'Editada en Rust.\n');
  const sectionList = await second.call('leer', { carpeta: notesId, ruta: 'Retoma.md', seccion: '?' });
  assert.equal(sectionList.indice.length, 1);
  assert.equal(sectionList.indice[0].titulo, 'Arranque habitual en Rust');
  const sectionRead = await second.call('leer', { carpeta: notesId, ruta: 'Retoma.md', seccion: 'arranque habitual' });
  assert.ok(sectionRead.contenido.includes('Esta conversación debe recuperarse en r3.'));

  const createdDir = await first.call('crear', { accion: 'carpeta', carpeta: notesId, ruta: 'Archivo' });
  assert.equal(createdDir.estado, 'creada');
  const renamed = await first.call('organizar', {
    accion: 'renombrar', carpeta: notesId, ruta: 'Nota.txt', nuevo_nombre: 'Nota-v2.txt',
  });
  assert.equal(renamed.estado, 'renombrado');
  const moved = await first.call('organizar', {
    accion: 'mover', carpeta: notesId, desde: 'Nota-v2.txt', hasta: 'Archivo/Nota-v2.txt',
  });
  assert.equal(moved.estado, 'movido');
  const searchMoved = await second.call('buscar', { en: 'archivos', carpeta: notesId, consulta: 'nota-v2' });
  assert.deepEqual(searchMoved.resultados.map(item => item.ruta), ['Archivo/Nota-v2.txt']);
  const searchOld = await second.call('buscar', { en: 'archivos', carpeta: notesId, consulta: 'Nota.txt', modo: 'exacto' });
  assert.equal(searchOld.total, 0);
  const explored = await second.call('buscar', { en: 'carpeta', carpeta: notesId, ruta: 'Archivo' });
  assert.deepEqual(explored.entradas.map(item => item.ruta), ['Archivo/Nota-v2.txt']);

  // Compartir el índice sin reescribirlo y detectar cambios externos al refrescarlo.
  const lookupExternal = (client) => client.call('buscar', { en: 'archivos', carpeta: notesId, consulta: 'Externo' });
  const indexPath = path.join(base, 'folder-index-' + notesId + '.json');
  const currentIndex = await fs.readFile(indexPath);
  for (const client of [first, second, first]) {
    assert.equal((await lookupExternal(client)).total, 0);
    assert.deepEqual(await fs.readFile(indexPath), currentIndex);
  }
  const externalPath = path.join(notes, 'Externo.txt');
  await fs.writeFile(externalPath, 'Creado fuera.\n');
  await waitUntil(async () => (await lookupExternal(second)).resultados[0]?.bytes === Buffer.byteLength('Creado fuera.\n'),
    'La búsqueda incorpora el archivo creado fuera de Mind.', 5_000);
  await fs.writeFile(externalPath, 'Modificado fuera de Mind.\n');
  await waitUntil(async () => (await lookupExternal(first)).resultados[0]?.bytes === Buffer.byteLength('Modificado fuera de Mind.\n'),
    'La búsqueda actualiza el tamaño modificado fuera de Mind.', 5_000);
  await fs.unlink(externalPath);
  await waitUntil(async () => (await lookupExternal(second)).total === 0,
    'La búsqueda retira el archivo borrado fuera de Mind.', 5_000);
  const externalRemoved = (await second.call('buscar', { en: 'eliminados', carpeta: notesId }))
    .eliminados.find(item => item.ruta === 'Externo.txt');
  assert.equal(externalRemoved?.por, 'externo');

  const recordPath = path.join(base, 'continuity-' + saved.id + '.json');
  const relocationPath = path.join(base, 'conversation-relocation.json');

  // La Base ficticia simula un registro dañado antes de tocar el archivo enlazado.
  const initialRecord = await fs.readFile(recordPath);
  await fs.writeFile(recordPath, '{dañado');
  try {
    await first.denied('organizar', {
      accion: 'mover', carpeta: notesId, desde: 'Retoma.md', hasta: 'Archivo/Retoma-invalida.md',
    }, 'RECORD_CORRUPT');
    await fs.stat(markdownPath);
    await assert.rejects(fs.stat(path.join(notes, 'Archivo', 'Retoma-invalida.md')), { code: 'ENOENT' });
    await assert.rejects(fs.stat(relocationPath), { code: 'ENOENT' });
  } finally {
    await fs.writeFile(recordPath, initialRecord);
  }

  async function moveMarkdown(client, from, to, holdRecord) {
    const expected = await fs.readFile(path.join(notes, from));
    const locked = holdRecord ? await fs.open(recordPath, 'r+') : null;
    try {
      const movedConv = await client.call('organizar', { accion: 'mover', carpeta: notesId, desde: from, hasta: to });
      assert.equal(movedConv.estado, 'movido');
      assert.deepEqual(await fs.readFile(path.join(notes, to)), expected);
      await assert.rejects(fs.stat(path.join(notes, from)), { code: 'ENOENT' });
      if (locked) {
        assert.equal(movedConv.continuidad?.estado, 'pendiente');
        const request = JSON.parse(await fs.readFile(relocationPath, 'utf8'));
        assert.equal(request.phase, 'moved');
        assert.ok(request.ids.includes(saved.id));
        const identity = await fs.stat(path.join(notes, to), { bigint: true });
        assert.deepEqual(request.identity, { dev: String(identity.dev), ino: String(identity.ino) });
        assert.equal(JSON.parse(await fs.readFile(recordPath, 'utf8')).content.file, path.join(notes, from));
        await second.denied('retomar', { id: saved.id }, 'CONVERSATION_RELOCATION_PENDING');
      } else {
        assert.equal(movedConv.continuidad?.estado, 'actualizada');
      }
    } finally {
      await locked?.close();
    }
  }

  // Comprobar también el reintento real si está ocupado el registro de la conversación.
  let markdownRelative = 'Archivo/Retoma-movida.md';
  await moveMarkdown(first, 'Retoma.md', markdownRelative, process.platform === 'win32');
  markdownPath = path.join(notes, markdownRelative);
  const resumedMoved = (await second.call('retomar', { id: saved.id })).conversacion;
  assert.equal(resumedMoved.archivo, markdownPath);
  assert.equal(resumedMoved.revision, saved.revision + 1);
  saved = resumedMoved;
  await assert.rejects(fs.stat(relocationPath), { code: 'ENOENT' });
  assert.equal(
    (await second.call('leer', { carpeta: notesId, ruta: markdownRelative })).contenido,
    await fs.readFile(markdownPath, 'utf8'),
  );

  // Papelera y confirmaciones por consola (incluida doble confirmación para vaciar).
  await first.call('crear', { carpeta: notesId, ruta: 'Borrar.txt', contenido: 'Para papelera.\n' });
  assert.equal((await second.call('buscar', { en: 'archivos', carpeta: notesId, consulta: 'Borrar.txt' })).total, 1);
  const delPending1 = await first.call('organizar', {
    accion: 'borrar', carpeta: notesId, ruta: 'Borrar.txt', motivo: 'Probar rechazo de borrado.',
  });
  assert.equal(delPending1.estado, 'pendiente');
  const delRejectedOut = await runInteractiveCli(['autorizar', '--base', base], tail => {
    if (tail.includes('¿Mover a la papelera?')) return 'n';
    assert.fail('Pregunta inesperada al rechazar borrado: ' + tail);
  });
  assert.match(delRejectedOut, /Rechazado\./);
  assert.equal((await second.call('buscar', { en: 'archivos', carpeta: notesId, consulta: 'Borrar.txt' })).total, 1);

  const delPending2 = await first.call('organizar', {
    accion: 'borrar', carpeta: notesId, ruta: 'Borrar.txt', motivo: 'Mover a papelera desde consola.',
  });
  assert.equal(delPending2.estado, 'pendiente');
  const delApprovedOut = await runInteractiveCli(['autorizar', '--base', base], tail => {
    if (tail.includes('¿Mover a la papelera?')) return 's';
    assert.fail('Pregunta inesperada al aprobar borrado: ' + tail);
  });
  assert.match(delApprovedOut, /Movido a la papelera de Mind/);
  assert.equal((await second.call('buscar', { en: 'archivos', carpeta: notesId, consulta: 'Borrar.txt' })).total, 0);
  const removedList = await second.call('buscar', { en: 'eliminados', carpeta: notesId });
  assert.ok(removedList.eliminados.some(item => item.ruta === 'Borrar.txt'));
  const trashList1 = await second.call('organizar', { accion: 'papelera', carpeta: notesId });
  assert.equal(trashList1.total, 1);
  const firstTrashId = trashList1.elementos[0].id;

  // Restaurar desde la papelera actualiza el índice en ambas sesiones.
  const restored = await second.call('organizar', { accion: 'restaurar', carpeta: notesId, id: firstTrashId });
  assert.equal(restored.estado, 'restaurado');
  assert.equal(restored.ruta, 'Borrar.txt');
  assert.equal((await first.call('buscar', { en: 'archivos', carpeta: notesId, consulta: 'Borrar.txt' })).total, 1);
  assert.equal((await first.call('organizar', { accion: 'papelera', carpeta: notesId })).total, 0);

  // Volver a borrar y probar la doble confirmación de vaciar_papelera en consola.
  await first.call('organizar', { accion: 'borrar', carpeta: notesId, ruta: 'Borrar.txt', motivo: 'Para vaciar.' });
  await runInteractiveCli(['autorizar', '--base', base], tail => (tail.includes('¿Mover a la papelera?') ? 's' : 'n'));
  const trashToPurgeId = (await second.call('organizar', { accion: 'papelera', carpeta: notesId })).elementos[0].id;
  const purgePending1 = await first.call('organizar', {
    accion: 'vaciar_papelera', carpeta: notesId, id: trashToPurgeId, motivo: 'Intento sin escribir VACIAR.',
  });
  assert.equal(purgePending1.estado, 'pendiente');
  const purgeAbortedOut = await runInteractiveCli(['autorizar', '--base', base], tail => {
    if (tail.includes('¿Eliminar definitivamente?')) return 's';
    if (tail.includes('escribe VACIAR')) return 'CANCELAR';
    assert.fail('Pregunta inesperada en doble confirmación de vaciado: ' + tail);
  });
  assert.match(purgeAbortedOut, /No se escribió VACIAR: no se elimina nada\./);
  assert.equal((await second.call('organizar', { accion: 'papelera', carpeta: notesId })).total, 1);

  const purgePending2 = await first.call('organizar', {
    accion: 'vaciar_papelera', carpeta: notesId, id: trashToPurgeId, motivo: 'Vaciado confirmado dos veces.',
  });
  assert.equal(purgePending2.estado, 'pendiente');
  const purgeConfirmedOut = await runInteractiveCli(['autorizar', '--base', base], tail => {
    if (tail.includes('¿Eliminar definitivamente?')) return 's';
    if (tail.includes('escribe VACIAR')) return 'VACIAR';
    assert.fail('Pregunta inesperada al confirmar vaciado: ' + tail);
  });
  assert.match(purgeConfirmedOut, /Eliminado definitivamente\./);
  assert.equal((await second.call('organizar', { accion: 'papelera', carpeta: notesId })).total, 0);

  // Formulario del cliente (elicitación), cancelación y ámbitos dinámicos.
  const decisions = [
    async ({ eventId }) => {
      assert.equal(await first.reply(eventId, { action: 'accept', content: { acceso: 'leer', excluir: '' } }), 202);
      return { action: 'decline' };
    },
    async ({ requestId }) => {
      await formClient.notify('notifications/cancelled', { requestId });
    },
    () => ({ action: 'accept', content: { acceso: 'leer', excluir: '' } }),
    () => ({ action: 'decline' }),
    () => ({ action: 'accept', content: { confirmar: true } }),
    () => ({ action: 'accept', content: { confirmar: true } }),
    () => ({ action: 'accept', content: { texto: 'NO' } }),
    () => ({ action: 'accept', content: { confirmar: true } }),
    () => ({ action: 'accept', content: { texto: 'VACIAR' } }),
    () => ({ action: 'accept', content: { confirmar: true } }),
  ];
  const formClient = await openMcp(url, connector.token, 'cliente con formularios', {
    onElicit(params, identifiers) {
      assert.equal(params.mode, 'form');
      assert.ok(decisions.length > 0, 'No se abre un formulario adicional');
      return decisions.shift()(identifiers);
    },
  });
  let r3TrashId;
  let retriedTrashId;
  try {
    const elicitReq = { accion: 'solicitar', ruta: elicitFolder, acceso: 'leer', motivo: 'Probar formulario.' };
    assert.equal((await formClient.call('acceso', elicitReq)).estado, 'rechazado');
    await formClient.denied('acceso', elicitReq, 'REQUEST_CANCELLED');
    const elicitGranted = await formClient.call('acceso', elicitReq);
    assert.equal(elicitGranted.estado, 'autorizado');
    const retiredFormFolder = await formClient.call('acceso', { accion: 'retirar', carpeta: elicitFolder, todo: true });
    assert.equal(retiredFormFolder.estado, 'retirada');

    // Borrado y doble confirmación de vaciado por formulario MCP (elicitación).
    await first.call('crear', { carpeta: notesId, ruta: 'Formulario.txt', contenido: 'Borrar con formulario.\n' });
    await first.call('crear', { carpeta: notesId, ruta: 'PapeleraR3.txt', contenido: 'Conservar en papelera para r3.\n' });
    const declinedDel = await formClient.call('organizar', {
      accion: 'borrar', carpeta: notesId, ruta: 'Formulario.txt', motivo: 'Rechazar en formulario.',
    });
    assert.equal(declinedDel.estado, 'rechazado');
    const acceptedDel = await formClient.call('organizar', {
      accion: 'borrar', carpeta: notesId, ruta: 'Formulario.txt', motivo: 'Aceptar en formulario.',
    });
    assert.equal(acceptedDel.estado, 'en_papelera');
    assert.equal((await second.call('buscar', { en: 'archivos', carpeta: notesId, consulta: 'Formulario.txt' })).total, 0);
    const rejectedPurge = await formClient.call('organizar', {
      accion: 'vaciar_papelera', carpeta: notesId, id: acceptedDel.id, motivo: 'Segundo paso fallido.',
    });
    assert.equal(rejectedPurge.estado, 'rechazado');
    assert.equal((await second.call('organizar', { accion: 'papelera', carpeta: notesId })).total, 1);
    const acceptedPurge = await formClient.call('organizar', {
      accion: 'vaciar_papelera', carpeta: notesId, id: acceptedDel.id, motivo: 'Doble confirmación válida.',
    });
    assert.equal(acceptedPurge.estado, 'eliminado');
    assert.equal((await second.call('organizar', { accion: 'papelera', carpeta: notesId })).total, 0);
    const keepInTrash = await formClient.call('organizar', {
      accion: 'borrar', carpeta: notesId, ruta: 'PapeleraR3.txt', motivo: 'Queda en papelera al volver a r3.',
    });
    assert.equal(keepInTrash.estado, 'en_papelera');
    r3TrashId = keepInTrash.id;

    // Si el registro de papelera está ocupado, el original queda intacto.
    // Tras liberar el registro, se pide confirmación de nuevo y r3 lo restaura.
    if (process.platform === 'win32') {
      const retryName = 'SinRegistro.txt';
      const retryContent = 'Conservar recuperable.\n';
      await first.call('crear', { carpeta: notesId, ruta: retryName, contenido: retryContent });
      const trashRegistryPath = path.join(base, 'trash-' + notesId + '.json');
      const previousTrash = await fs.readFile(trashRegistryPath);
      const args = { accion: 'borrar', carpeta: notesId, ruta: retryName, motivo: 'Probar fallo del registro de papelera.' };
      decisions.push(() => ({ action: 'accept', content: { confirmar: true } }));
      const trashLock = await fs.open(trashRegistryPath, 'r+');
      try {
        const error = await formClient.denied('organizar', args, 'FILE_IN_USE');
        assert.match(error.mensaje, /original sigue en su ubicación/);
      } finally {
        await trashLock.close();
      }
      assert.equal(await fs.readFile(path.join(notes, retryName), 'utf8'), retryContent);
      assert.deepEqual(await fs.readFile(trashRegistryPath), previousTrash);
      assert.equal((await second.call('buscar', { en: 'archivos', carpeta: notesId, consulta: retryName })).total, 1);
      assert.deepEqual((await second.call('organizar', { accion: 'papelera', carpeta: notesId })).elementos.map(item => item.id), [r3TrashId]);

      decisions.push(() => ({ action: 'accept', content: { confirmar: true } }));
      const retried = await formClient.call('organizar', args);
      assert.equal(retried.estado, 'en_papelera');
      assert.equal(retried.papelera?.estado, 'registrado');
      assert.equal(await fs.readFile(retried.ubicacion_en_papelera, 'utf8'), retryContent);
      retriedTrashId = retried.id;
    }
    assert.deepEqual(decisions, []);
  } finally {
    await formClient.close();
  }

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

  // Etapa 3: automatizaciones con escritor único, permisos y confirmación obligatoria.
  const helpCatalog = await first.call('mind', { operacion: 'ayuda' });
  assert.ok(helpCatalog.mind.some(item => item.nombre === 'funciones'));
  assert.ok(helpCatalog.mind_cambiar.some(item => item.nombre === 'crear_respaldo'));
  await first.denied('mind', { operacion: 'crear_funcion' }, 'USE_MIND_CAMBIAR');
  await first.denied('mind_cambiar', { operacion: 'funciones' }, 'USE_MIND');

  const templateDef = (ruta, siExiste = 'error') => ({
    nombre: 'Resumen etapa 3',
    ejecutor: 'plantilla-texto',
    parametros: { destino: { carpeta: notesId, ruta }, si_existe: siExiste, plantilla: 'Generado por {funcion}' },
    activacion: { tipo: 'horario', frecuencia: 'intervalo', minutos: 15 },
  });
  const indexAutoDef = {
    nombre: 'Índice etapa 3',
    ejecutor: 'indexar',
    parametros: { carpetas: [notesId] },
    activacion: { tipo: 'horario', frecuencia: 'intervalo', minutos: 30 },
  };
  const fnCreated = await first.call('mind_cambiar', {
    operacion: 'crear_funcion',
    argumentos: { id: 'resumen-etapa3', definicion: templateDef('Resumen-etapa3.md') },
  });
  assert.equal(fnCreated.estado, 'creada');
  assert.equal(fnCreated.automatica, 'sin-autorizar');
  assert.equal((await second.call('mind_cambiar', {
    operacion: 'crear_funcion',
    argumentos: { id: 'indice-etapa3', definicion: indexAutoDef },
  })).estado, 'creada');

  const listedInSecond = await second.call('mind', { operacion: 'funciones' });
  assert.equal(listedInSecond.funciones.find(item => item.id === 'resumen-etapa3')?.estado, 'sin-autorizar');

  // Sin formulario MCP, activar queda pendiente para consola (rechazo y luego aprobación).
  const autoPending = await first.call('mind_cambiar', {
    operacion: 'activar_funcion',
    argumentos: { id: 'resumen-etapa3', motivo: 'Resumen automático.' },
  });
  assert.equal(autoPending.estado, 'pendiente');
  assert.ok((await second.call('estado')).solicitudes_pendientes.some(item => item.id === autoPending.solicitud && item.tipo === 'automatizacion'));
  const rejectedAutoConsole = await runInteractiveCli(['autorizar', '--base', base], tail => {
    if (tail.includes('¿Activar esta automatización?')) return 'n';
    assert.fail('Pregunta inesperada al rechazar automatización: ' + tail);
  });
  assert.match(rejectedAutoConsole, /Rechazada\./);
  assert.equal((await second.call('mind', { operacion: 'funciones' })).funciones.find(item => item.id === 'resumen-etapa3')?.estado, 'sin-autorizar');

  await first.call('mind_cambiar', { operacion: 'activar_funcion', argumentos: { id: 'resumen-etapa3' } });
  await first.call('mind_cambiar', { operacion: 'activar_funcion', argumentos: { id: 'indice-etapa3' } });
  const approvedAutoConsole = await runInteractiveCli(['autorizar', '--base', base], tail => {
    if (tail.includes('¿Activar esta automatización?')) return 's';
    assert.fail('Pregunta inesperada al aprobar automatización: ' + tail);
  });
  assert.match(approvedAutoConsole, /Automatización activada\./);
  for (const client of [first, second]) {
    const fns = (await client.call('mind', { operacion: 'funciones' })).funciones;
    const summaryFn = fns.find(item => item.id === 'resumen-etapa3');
    const indexFn = fns.find(item => item.id === 'indice-etapa3');
    assert.equal(summaryFn?.estado, 'activa');
    assert.equal(summaryFn?.consent?.channel, 'consola');
    assert.equal(indexFn?.estado, 'activa');
    assert.equal(indexFn?.consent?.channel, 'consola');
  }

  // Confirmación interactiva MCP (elicitation) por mind_cambiar -> activar_funcion.
  const autoDecisions = [
    () => ({ action: 'decline' }),
    () => ({ action: 'accept', content: { activar: true } }),
  ];
  const autoForm = await openMcp(url, connector.token, 'cliente formularios automatización', {
    onElicit(params) {
      assert.equal(params.mode, 'form');
      assert.ok(autoDecisions.length > 0);
      return autoDecisions.shift()();
    },
  });
  try {
    assert.equal((await autoForm.call('mind_cambiar', {
      operacion: 'desactivar_funcion', argumentos: { id: 'resumen-etapa3' },
    })).estado, 'desactivada');
    assert.equal((await autoForm.call('mind_cambiar', {
      operacion: 'activar_funcion', argumentos: { id: 'resumen-etapa3', motivo: 'Rechazo en formulario' },
    })).estado, 'rechazado');
    const formActivated = await autoForm.call('mind_cambiar', {
      operacion: 'activar_funcion', argumentos: { id: 'resumen-etapa3', motivo: 'Aprobación en formulario' },
    });
    assert.equal(formActivated.estado, 'activada');
    assert.equal(formActivated.autorizada_por, 'formulario-del-cliente');
    assert.deepEqual(autoDecisions, []);
  } finally {
    await autoForm.close();
  }

  // Ejecución manual controlada de plantilla-texto y reflejo en índice e historial.
  const executedTemplate = await first.call('mind_cambiar', {
    operacion: 'ejecutar_funcion', argumentos: { id: 'resumen-etapa3' },
  });
  assert.equal(executedTemplate.estado, 'completada');
  assert.equal(await fs.readFile(path.join(notes, 'Resumen-etapa3.md'), 'utf8'), 'Generado por resumen-etapa3');
  assert.equal((await second.call('buscar', { en: 'archivos', carpeta: notesId, consulta: 'Resumen-etapa3.md' })).total, 1);
  const autoHistory = await second.call('mind', { operacion: 'historial_funcion', argumentos: { id: 'resumen-etapa3' } });
  assert.equal(autoHistory.ejecuciones.length, 1);
  assert.equal(autoHistory.ejecuciones[0].estado, 'completada');
  assert.equal(JSON.stringify(autoHistory).includes('Generado por'), false);

  // Una edición externa activa el trabajo, incluso si Mind escribió ese mismo archivo antes.
  const eventId = 'evento-etapa3';
  const eventOutput = path.join(notes, 'Salida-etapa3.evt');
  const eventHistoryFile = path.join(base, 'function-history-' + eventId + '.json');
  const eventHistory = async () => (await fs.readFile(eventHistoryFile, 'utf8').then(JSON.parse, error => {
    if (error.code === 'ENOENT') return { entries: [] };
    throw error;
  })).entries;
  await first.call('mind_cambiar', {
    operacion: 'crear_funcion',
    argumentos: { id: eventId, definicion: {
      ...templateDef('Salida-etapa3.evt', 'reemplazar'),
      activacion: { tipo: 'evento', carpeta: notesId, extensiones: ['.evt'], espera_segundos: 5 },
    } },
  });
  assert.equal((await first.call('mind_cambiar', {
    operacion: 'activar_funcion', argumentos: { id: eventId },
  })).estado, 'pendiente');
  await runInteractiveCli(['autorizar', '--base', base], tail => {
    assert.match(tail, /¿Activar esta automatización\?/);
    return 's';
  });
  await fs.writeFile(path.join(notes, 'Entrada-etapa3.evt'), 'Cambio fuera de Mind');
  await waitUntil(async () => (await eventHistory()).length === 1, 'La edición externa activa la función.');
  assert.equal(await fs.readFile(eventOutput, 'utf8'), 'Generado por evento-etapa3');
  await delay(6500);
  assert.equal((await eventHistory()).length, 1, 'La escritura propia no dispara otra ejecución');
  await fs.writeFile(eventOutput, 'Edición manual posterior en el mismo archivo');
  await waitUntil(async () => (await eventHistory()).length === 2, 'La edición posterior del mismo archivo vuelve a activar la función.');
  assert.equal(await fs.readFile(eventOutput, 'utf8'), 'Generado por evento-etapa3');
  // Las escrituras MCP actualizan el índice antes de responder; la automatización
  // debe recibir el cambio aunque el siguiente sondeo ya encuentre los mismos datos.
  const eventInput = 'Entrada-agente.evt';
  const indexedInput = async () => JSON.parse(await fs.readFile(indexPath, 'utf8')).entries
    .find(entry => entry.path === eventInput);
  assert.equal(await indexedInput(), undefined);
  const createdInput = await first.call('crear', { carpeta: notesId, ruta: eventInput, contenido: 'uno' });
  assert.equal(createdInput.indice, 'ok');
  assert.equal((await indexedInput())?.size, Buffer.byteLength('uno'));
  await waitUntil(async () => (await eventHistory()).length === 3, 'Crear desde MCP activa la función.');

  const changedInput = await second.call('modificar', {
    carpeta: notesId, ruta: eventInput, ediciones: [{ buscar: 'uno', reemplazar: 'cuatro' }],
  });
  assert.equal(changedInput.indice, 'ok');
  assert.equal((await indexedInput())?.size, Buffer.byteLength('cuatro'));
  await waitUntil(async () => (await eventHistory()).length === 4, 'Modificar desde MCP vuelve a activar la función.');
  await delay(6500);
  assert.equal((await eventHistory()).length, 4, 'Cada cambio se ejecutó una sola vez');
  assert.ok((await eventHistory()).every(entry => entry.estado === 'completada' && entry.origen === 'evento'));
  await first.call('mind_cambiar', { operacion: 'desactivar_funcion', argumentos: { id: eventId } });

  // Listado y retirada de permisos desde consola con Rust activo.
  for (const environment of [env, nativeEnv]) {
    const { stdout: listing } = await run(process.execPath, ['bin/mind.js', 'permisos', '--base', base],
      { ...options, env: environment });
    assert.ok(listing.includes(notes));
    assert.ok(listing.includes(extra));
    assert.match(listing, /Continuidad: leer, registrar/);
  }
  await assert.rejects(
    run(process.execPath, ['bin/mind.js', 'permisos', 'retirar', extraId, '--base', base], { ...options, env: nativeEnv }),
    error => JSON.parse(error.stderr).error.codigo === 'CONSOLE_REQUIRED',
  );
  // Cancelar la confirmación conserva la carpeta intacta.
  await runInteractiveCli(['permisos', 'retirar', extraId, '--base', base], tail => {
    assert.match(tail, /¿Retirar /);
    return 'n';
  }, { native: false });
  assert.equal((await second.call('leer', { carpeta: extraId, ruta: 'Extra.txt' })).contenido, 'Contenido en carpeta extra.\n');

  // Retirar por completo la carpeta extra y comprobar en ambas sesiones.
  const revokedOut = await runInteractiveCli(['permisos', 'retirar', extraId, '--base', base], tail => {
    assert.match(tail, /¿Retirar /);
    return 's';
  }, { native: false });
  assert.match(revokedOut, /Retirada\./);
  for (const client of [first, second]) {
    const state = await client.call('estado');
    assert.equal(state.carpetas.some(item => item.id === extraId), false);
    await client.denied('leer', { carpeta: extraId, ruta: 'Extra.txt' }, 'FOLDER_NOT_AUTHORIZED');
  }

  // Retirar solo escritura y organización en notes y comprobar en ambas sesiones.
  const reducedOut = await runInteractiveCli(
    ['permisos', 'retirar', notesId, 'escribir', 'organizar', '--base', base],
    tail => {
      assert.match(tail, /¿Retirar escribir, organizar/);
      return 's';
    },
  );
  assert.match(reducedOut, /Permisos en .*?: encontrar, leer\./);
  for (const client of [first, second]) {
    const state = await client.call('estado');
    const entry = state.carpetas.find(item => item.id === notesId);
    assert.deepEqual(entry?.permisos, ['encontrar', 'leer']);
    assert.equal(entry?.indice?.estado, 'vigente');
    assert.equal((await client.call('leer', { carpeta: notesId, ruta: 'Archivo/Nota-v2.txt' })).contenido, 'Editada en Rust.\n');
    assert.deepEqual(fields((await client.call('retomar', { id: saved.id })).conversacion), fields(saved));
  }
  await first.denied('crear', { carpeta: notesId, ruta: 'Denegado.txt', contenido: 'x' }, 'ACCESS_NOT_GRANTED');
  const currentNote = await second.call('leer', { carpeta: notesId, ruta: 'Archivo/Nota-v2.txt' });
  await second.denied('modificar', {
    carpeta: notesId, ruta: 'Archivo/Nota-v2.txt', version: currentNote.version, contenido: 'No permitido',
  }, 'ACCESS_NOT_GRANTED');

  // Al retirar escritura en notes, las funciones de escritura fallan por falta de permiso y la de lectura sigue activa.
  const deniedAutoExec = await first.call('mind_cambiar', {
    operacion: 'ejecutar_funcion', argumentos: { id: 'resumen-etapa3' },
  });
  assert.equal(deniedAutoExec.estado, 'fallida');
  assert.equal(deniedAutoExec.codigo, 'ACCESS_NOT_GRANTED');
  await first.denied('mind_cambiar', {
    operacion: 'activar_funcion', argumentos: { id: 'resumen-etapa3' },
  }, 'ACCESS_NOT_GRANTED');
  assert.equal((await second.call('mind', { operacion: 'funciones' })).funciones.find(item => item.id === 'indice-etapa3')?.estado, 'activa');

  // Sitio ficticio abierto con Mind desde una sesión de prueba de Claude; tras cerrarla sigue recargable en navegador.
  const siteDir = path.join(root, 'Sitio ficticio');
  const siteHtml = '<!doctype html><title>Sitio ficticio</title><link rel="stylesheet" href="estilos.css"><main>Vista etapa 3</main>';
  const siteCss = 'main { color: #123456; }';
  await fs.mkdir(siteDir);
  await fs.writeFile(path.join(siteDir, 'index.html'), siteHtml);
  await fs.writeFile(path.join(siteDir, 'estilos.css'), siteCss);
  const claude = await openStdioMcp(
    ['bin/mind.js', 'mcp', '--base', base, '--carpeta', siteDir],
    nativeEnv,
    { name: 'claude-code', title: 'Claude Code', version: '1.0' },
  );
  let openedView;
  try {
    const listed = await claude.listTools();
    const names = listed.tools.map(tool => tool.name);
    assert.ok(names.includes('vista'));
    assert.ok(names.includes('mind'));
    assert.ok(names.includes('mind_cambiar'));
    openedView = await claude.call('vista', { accion: 'abrir', carpeta: siteDir, proyecto: 'Sitio ficticio' });
    assert.equal(openedView.proyecto, 'Sitio ficticio');
    const viewUrl = new URL(openedView.url);
    assert.equal(viewUrl.port, String(connector.health.puertoVistas));
    assert.equal(connector.state.puertoVistas, connector.health.puertoVistas);
    const page = await fetch(viewUrl, { signal: AbortSignal.timeout(5_000) });
    assert.equal(page.status, 200);
    assertViewHtml(await page.text(), siteHtml);
    const style = await fetch(new URL('estilos.css', viewUrl), { signal: AbortSignal.timeout(5_000) });
    assert.equal(style.status, 200);
    assert.equal(await style.text(), siteCss);
    const crossMcp = await fetch(new URL('/mcp', viewUrl), { signal: AbortSignal.timeout(5_000) });
    assert.equal(crossMcp.status, 404);
    await crossMcp.text();
  } finally {
    await claude.close();
  }
  assert.equal((await checkHealthyConnector(base)).health.pid, owner.pid);
  const reloadedPage = await fetch(openedView.url, { signal: AbortSignal.timeout(5_000) });
  assert.equal(reloadedPage.status, 200);
  assertViewHtml(await reloadedPage.text(), siteHtml);
  const reloadedCss = await fetch(new URL('estilos.css', openedView.url), { signal: AbortSignal.timeout(5_000) });
  assert.equal(reloadedCss.status, 200);
  assert.equal(await reloadedCss.text(), siteCss);
  assert.deepEqual(
    await second.call('mind', { operacion: 'vista_consultar', argumentos: { id: openedView.id } }),
    openedView,
  );

  // Respaldo cifrado (MINDBAK1) creado por el Motor Rust, verificado y restaurado sin fugas.
  const backupsDir = path.join(root, 'Respaldos ficticios');
  const recoveryDir = path.join(root, 'Recuperacion ficticia');
  const restoredBase = path.join(root, 'Base restaurada');
  await fs.mkdir(backupsDir);
  await fs.mkdir(recoveryDir);
  await first.denied('mind_cambiar', { operacion: 'crear_respaldo', argumentos: {} }, 'BACKUP_NOT_CONFIGURED');
  const backupSetup = await setupBackup({ baseDirectory: base, passphrase: 'Frase ficticia segura etapa 3' });
  await saveRecoveryFile({
    recoveryFile: backupSetup.recoveryFile,
    directory: recoveryDir,
    baseDirectory: base,
    destinationDirectory: backupsDir,
  });
  await configureBackupDestination({ baseDirectory: base, destinationDirectory: backupsDir });
  const createdBackup = await first.call('mind_cambiar', { operacion: 'crear_respaldo', argumentos: {} });
  assert.equal(createdBackup.estado, 'creado');
  const backupFilePath = path.join(createdBackup.destino, createdBackup.archivo);
  const rawBackup = await fs.readFile(backupFilePath);
  assert.equal(rawBackup.subarray(0, 8).toString('ascii'), 'MINDBAK1');
  assert.equal(rawBackup.includes(Buffer.from(saved.titulo)), false);
  await first.denied('crear_respaldo', {}, 'BACKUP_TOO_FREQUENT');
  const verifiedBackup = await verifyBackup({ file: backupFilePath, recoveryCode: backupSetup.recoveryCode });
  assert.equal(verifiedBackup.valid, true);
  assert.equal(verifiedBackup.method, 'codigo');
  const restoredBackup = await restoreBackup({
    file: backupFilePath,
    targetDirectory: restoredBase,
    recoveryCode: backupSetup.recoveryCode,
  });
  assert.equal(restoredBackup.keyRestored, true);
  await fs.stat(path.join(restoredBase, 'mind-base.json'));
  await fs.stat(path.join(restoredBase, 'continuity-' + saved.id + '.json'));
  await fs.stat(path.join(restoredBase, 'function-definition-resumen-etapa3.json'));
  await fs.stat(path.join(restoredBase, 'function-definition-indice-etapa3.json'));
  await fs.stat(path.join(restoredBase, 'automation-consent-indice-etapa3.json'));

  let scheduledAt;
  const scheduledId = 'horario-windows-etapa3';
  if (testWindowsScheduler) {
    scheduledAt = new Date(Math.ceil((Date.now() + 24_000) / 60_000) * 60_000);
    const hora = [scheduledAt.getHours(), scheduledAt.getMinutes()].map(value => String(value).padStart(2, '0')).join(':');
    await first.call('mind_cambiar', {
      operacion: 'crear_funcion',
      argumentos: { id: scheduledId, definicion: {
        ...indexAutoDef,
        nombre: 'Programador Windows etapa 3',
        activacion: { tipo: 'horario', frecuencia: 'diaria', hora },
      } },
    });
    assert.equal((await first.call('mind_cambiar', {
      operacion: 'activar_funcion', argumentos: { id: scheduledId },
    })).estado, 'pendiente');
    await runInteractiveCli(['autorizar', '--base', base], tail => {
      assert.match(tail, /¿Activar esta automatización\?/);
      return 's';
    });
  }

  // Dejar una solicitud pendiente nueva para comprobar que r3 la conserva tras el corte.
  const pendingForR3 = await first.call('acceso', {
    accion: 'solicitar', ruta: extra, acceso: 'leer', motivo: 'Conservar pendiente tras corte.',
  });
  assert.equal(pendingForR3.estado, 'pendiente');
  const pendingPath = path.join(base, 'consent-request-' + pendingForR3.solicitud + '.json');
  const pendingRecord = JSON.parse(await fs.readFile(pendingPath, 'utf8'));

  // Otra interrupción deliberada, ahora con un vínculo que debe resolver r3.
  // La raíz abierta solo concede permiso durante esa conexión.
  let recovered = saved;
  if (process.platform === 'win32') {
    const editingSession = await openMcp(url, connector.token, 'traslado pendiente para r3', { cwd: notes });
    const nextRelative = 'Archivo/Retoma-r3.md';
    try {
      await moveMarkdown(editingSession, markdownRelative, nextRelative, true);
    } finally {
      await editingSession.close();
    }
    markdownRelative = nextRelative;
    markdownPath = path.join(notes, markdownRelative);
    recovered = { ...saved, archivo: markdownPath, revision: saved.revision + 1 };
  }
  await assert.rejects(fs.stat(path.join(base, 'sesiones')), { code: 'ENOENT' });
  const [record, markdown] = await Promise.all([fs.readFile(recordPath), fs.readFile(markdownPath)]);
  assert.deepEqual(await auxiliaryProcesses(owner.pid), []);
  await fs.stat(path.join(base, 'conector-consola.json'));

  await interrupt(owner);
  nativeOwner = undefined;
  if (scheduledAt) {
    assert.equal(await checkHealthyConnector(base), null);
    await runWindowsScheduledFixture(root, base, nativeEnv, scheduledAt);
    const { entries } = JSON.parse(await fs.readFile(path.join(base, 'function-history-' + scheduledId + '.json'), 'utf8'));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].estado, 'completada');
    assert.equal(entries[0].origen, 'programada');
    assert.equal(Date.parse(entries[0].programada), scheduledAt.getTime());
    t.diagnostic('Programador de Windows: un turno con los chats cerrados y una segunda llamada sin duplicados.');
  }
  const { startCentralMotor } = await import(JSON.parse(old('motor-central.js')));
  const { resolveLayout } = await import(JSON.parse(old('layout.js')));
  const r3Layout = await resolveLayout({ base, env });
  rollback = await startCentralMotor({
    layout: r3Layout, motorVersion: '1.0.4', observe: false, discoverUpdates: null, preferredPort: 0,
  });
  assert.equal(rollback.alreadyRunning, false);
  const r3 = await openMcp(rollback.url, rollback.token, 'retoma tras volver a r3');
  try {
    assert.deepEqual(fields((await r3.call('conversacion_leer', { id: saved.id })).conversacion), fields(recovered));
    await assert.rejects(fs.stat(relocationPath), { code: 'ENOENT' });
    assert.deepEqual(fields((await r3.call('conversacion_leer', { id: saved.id })).conversacion), fields(recovered));
    assert.equal(await rollback.session.policy.get(extraId), null);
    const notesPolicy = await rollback.session.policy.get(notesId);
    assert.deepEqual(notesPolicy?.access, { encontrar: true, leer: true, escribir: false, organizar: false });
    assert.equal(notesPolicy?.channel, 'consola');
    assert.equal((await r3.call('leer', { carpeta: notesId, ruta: 'Archivo/Nota-v2.txt' })).contenido, 'Editada en Rust.\n');
    assert.equal((await r3.call('leer', { carpeta: notesId, ruta: markdownRelative })).contenido, markdown.toString('utf8'));
    const r3Search = await r3.call('buscar', { carpetas: [notesId], consulta: 'nota-v2' });
    assert.deepEqual(r3Search.resultados.map(item => item.ruta), ['Archivo/Nota-v2.txt']);
    const r3Trash = await r3.call('papelera', { carpeta: notesId });
    assert.deepEqual(r3Trash.elementos.map(item => ({ id: item.id, ruta: item.ruta })), [
      ...(retriedTrashId ? [{ id: retriedTrashId, ruta: 'SinRegistro.txt' }] : []),
      { id: r3TrashId, ruta: 'PapeleraR3.txt' },
    ]);
    if (retriedTrashId) {
      const restoring = await openMcp(rollback.url, rollback.token, 'restaura desde la carpeta abierta', { cwd: notes });
      try {
        assert.equal((await restoring.call('restaurar', { carpeta: notesId, id: retriedTrashId })).estado, 'restaurado');
        assert.equal(await fs.readFile(path.join(notes, 'SinRegistro.txt'), 'utf8'), 'Conservar recuperable.\n');
      } finally {
        await restoring.close();
      }
      assert.deepEqual((await r3.call('papelera', { carpeta: notesId })).elementos.map(item => item.id), [r3TrashId]);
    }
    const r3Removed = await r3.call('eliminados', { carpeta: notesId });
    assert.ok(r3Removed.eliminados.some(item => item.ruta === 'PapeleraR3.txt'));
    await r3.denied('crear', { carpeta: notesId, ruta: 'Denegado-r3.txt', contenido: 'x' }, 'ACCESS_NOT_GRANTED');
    assert.deepEqual(await rollback.session.policy.getContinuity(), {
      leer: true, registrar: true, channel: 'consola', grantedAt: consent.grantedAt,
    });
    const { createConsentRequests } = await import(JSON.parse(old('consent.js')));
    const oldPending = await createConsentRequests(base).list();
    assert.deepEqual(oldPending.find(item => item.id === pendingForR3.solicitud), pendingRecord);

    // r3 reconoce funciones, autorizaciones e historial y el respaldo creado por Rust.
    const r3Functions = (await r3.call('funciones', {})).funciones;
    const r3IndexFn = r3Functions.find(item => item.id === 'indice-etapa3');
    assert.equal(r3IndexFn?.estado, 'activa');
    assert.equal(r3IndexFn?.consent?.channel, 'consola');
    assert.equal((await r3.call('ejecutar_funcion', { id: 'indice-etapa3' })).estado, 'completada');
    const r3History = await r3.call('historial_funcion', { id: 'resumen-etapa3' });
    assert.equal(r3History.ejecuciones.some(item => item.estado === 'completada'), true);
    const oldEvents = await r3.call('historial_funcion', { id: eventId });
    assert.equal(oldEvents.ejecuciones.length, 4);
    if (scheduledAt) {
      const oldSchedule = await r3.call('historial_funcion', { id: scheduledId });
      assert.equal(oldSchedule.ejecuciones.length, 1);
      assert.equal(Date.parse(oldSchedule.ejecuciones[0].programada), scheduledAt.getTime());
    }
    const r3Config = await readBackupConfig(base);
    assert.equal(r3Config?.lastBackup?.file, createdBackup.archivo);
    const listedBackups = await listBackups(backupsDir);
    assert.equal(listedBackups.some(item => item.name === createdBackup.archivo), true);
  } finally {
    await r3.close();
  }
  assert.deepEqual(await fs.readFile(markerPath), marker);
  if (recovered === saved) {
    assert.deepEqual(await fs.readFile(recordPath), record);
  } else {
    const result = JSON.parse(await fs.readFile(recordPath, 'utf8'));
    assert.equal(result.content.file, markdownPath);
    assert.equal(result.revision, JSON.parse(record.toString('utf8')).revision + 1);
    assert.deepEqual(result.references, JSON.parse(record.toString('utf8')).references);
  }
  assert.deepEqual(await fs.readFile(markdownPath), markdown);
  t.diagnostic('El lanzador salió | consola 403 MCP con PID Rust ' + owner.pid + ' | r3 ' + r3Commit.slice(0, 7) + ' retomó ' + saved.id);
});
