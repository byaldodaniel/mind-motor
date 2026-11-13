import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolveLayout } from '../src/layout.js';
import { startCentralMotor } from '../src/motor-central.js';
import {
  createSmartQueue,
  QUEUE_PRIORITY,
  classifyToolPriority,
  resolveToolResourceKeys,
} from '../src/smart-queue.js';
import { updateMind } from '../src/commands/actualizar.js';
import { UNIVERSAL_TARGETS } from '../src/product-files.js';
import { BASE_FORMAT_VERSION } from '../src/base-format.js';
import {
  ensureCentralMotor,
  stopCentralMotor,
  callCentralRpc,
  checkHealthyConnector,
  connectorPaths,
} from '../src/connector.js';
import { startMcp } from './helpers/mcp-client.js';

const execFileAsync = promisify(execFile);
const BIN_MIND = fileURLToPath(new URL('../bin/mind.js', import.meta.url));

function rawHttp({ port, method = 'GET', pathName = '/health', headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const payload = body === null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({
      agent: false,
      host: '127.0.0.1',
      port,
      method,
      path: pathName,
      headers: {
        Host: `127.0.0.1:${port}`,
        ...(payload === null ? {} : {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': String(Buffer.byteLength(payload, 'utf8')),
        }),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text.trim() ? JSON.parse(text) : null; } catch {}
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

async function createTempBase(t, prefix = 'mind-central-') {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  const base = path.join(root, 'Base');
  t.after(async () => {
    await stopCentralMotor(base).catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, base };
}

test('seguridad HTTP, /health, server/discover y aislamiento por sesión en /mcp', { timeout: 30_000 }, async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mind-central-inproc-')));
  const base = path.join(root, 'Base');
  let motor = null;
  t.after(async () => {
    await motor?.stop('test-end').catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  });
  const dirA = path.join(root, 'ProyectoA');
  const dirB = path.join(root, 'ProyectoB');
  await fs.mkdir(dirA, { recursive: true });
  await fs.mkdir(dirB, { recursive: true });
  await fs.writeFile(path.join(dirA, 'secreto-a.txt'), 'Solo en proyecto A\n');
  await fs.writeFile(path.join(dirB, 'secreto-b.txt'), 'Solo en proyecto B\n');

  const layout = await resolveLayout({ base });
  motor = await startCentralMotor({ layout, preferredPort: 0, observe: false });

  // /health sin token funciona y reporta identidad de la Base.
  const health = await rawHttp({ port: motor.port, pathName: '/health' });
  assert.equal(health.status, 200);
  assert.equal(health.json.ok, true);
  assert.equal(health.json.baseId, motor.baseId);
  assert.equal(health.json.port, motor.port);

  // /mcp y /rpc exigen Bearer válido.
  const noAuth = await rawHttp({ port: motor.port, method: 'POST', pathName: '/mcp', body: { jsonrpc: '2.0', id: 1, method: 'ping' } });
  assert.equal(noAuth.status, 401);
  assert.match(String(noAuth.headers['www-authenticate']), /Bearer/);

  const badAuth = await rawHttp({
    port: motor.port,
    method: 'POST',
    pathName: '/rpc',
    headers: { Authorization: 'Bearer token-incorrecto' },
    body: { accion: 'ping' },
  });
  assert.equal(badAuth.status, 401);

  // Origin presente o Host ajeno -> 403.
  const withOrigin = await rawHttp({
    port: motor.port,
    pathName: '/health',
    headers: { Origin: 'https://evil.example' },
  });
  assert.equal(withOrigin.status, 403);
  assert.equal(withOrigin.json.error, 'ORIGIN_NOT_ALLOWED');

  const badHost = await rawHttp({
    port: motor.port,
    pathName: '/health',
    headers: { Host: 'attacker.example:9999' },
  });
  assert.equal(badHost.status, 403);
  assert.equal(badHost.json.error, 'HOST_NOT_ALLOWED');

  const authHeaders = {
    Authorization: `Bearer ${motor.token}`,
    Accept: 'application/json, text/event-stream',
  };

  // server/discover (protocolo 2026-07-28) -> 404 para fallback a initialize.
  const discover = await rawHttp({
    port: motor.port,
    method: 'POST',
    pathName: '/mcp',
    headers: authHeaders,
    body: { jsonrpc: '2.0', id: 1, method: 'server/discover' },
  });
  assert.equal(discover.status, 404);

  // Mcp-Session-Id desconocido -> 404.
  const staleSession = await rawHttp({
    port: motor.port,
    method: 'POST',
    pathName: '/mcp',
    headers: { ...authHeaders, 'Mcp-Session-Id': 'no-existe' },
    body: { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  });
  assert.equal(staleSession.status, 404);

  // Dos sesiones HTTP simultáneas mantienen ámbitos de WorkspaceAccess aislados.
  async function openHttpSession(cwd) {
    const init = await rawHttp({
      port: motor.port,
      method: 'POST',
      pathName: '/mcp',
      headers: { ...authHeaders, 'X-Mind-Cwd': cwd },
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'http-test', version: '1.0' },
        },
      },
    });
    assert.equal(init.status, 200);
    const sid = init.headers['mcp-session-id'];
    assert.ok(sid);
    await rawHttp({
      port: motor.port,
      method: 'POST',
      pathName: '/mcp',
      headers: { ...authHeaders, 'Mcp-Session-Id': sid },
      body: { jsonrpc: '2.0', method: 'notifications/initialized' },
    });
    return sid;
  }

  const sidA = await openHttpSession(dirA);
  const sidB = await openHttpSession(dirB);
  assert.notEqual(sidA, sidB);
  assert.equal(motor.activeSessionCount(), 2);

  const readAinA = await rawHttp({
    port: motor.port,
    method: 'POST',
    pathName: '/mcp',
    headers: { ...authHeaders, 'Mcp-Session-Id': sidA },
    body: { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'leer', arguments: { carpeta: dirA, ruta: 'secreto-a.txt' } } },
  });
  assert.equal(readAinA.json.result.isError ?? false, false);
  assert.match(readAinA.json.result.content[0].text, /Solo en proyecto A/);

  const readBinA = await rawHttp({
    port: motor.port,
    method: 'POST',
    pathName: '/mcp',
    headers: { ...authHeaders, 'Mcp-Session-Id': sidA },
    body: { jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'leer', arguments: { carpeta: dirB, ruta: 'secreto-b.txt' } } },
  });
  assert.equal(readBinA.json.result.isError, true);

  const readBinB = await rawHttp({
    port: motor.port,
    method: 'POST',
    pathName: '/mcp',
    headers: { ...authHeaders, 'Mcp-Session-Id': sidB },
    body: { jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'leer', arguments: { carpeta: dirB, ruta: 'secreto-b.txt' } } },
  });
  assert.equal(readBinB.json.result.isError ?? false, false);
  assert.match(readBinB.json.result.content[0].text, /Solo en proyecto B/);

  // clearCaches no rompe lecturas posteriores.
  await motor.session.clearCaches();
  const afterClear = await rawHttp({
    port: motor.port,
    method: 'POST',
    pathName: '/mcp',
    headers: { ...authHeaders, 'Mcp-Session-Id': sidA },
    body: { jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'buscar', arguments: { consulta: '' } } },
  });
  assert.equal(afterClear.json.result.isError ?? false, false);
});

test('el primero enciende de forma concurrente, despertar --headers, /rpc y apagar limpio', { timeout: 30_000 }, async (t) => {
  const { root, base } = await createTempBase(t);
  const workDir = path.join(root, 'Trabajo');
  const outsideDir = path.join(root, 'Externo');
  await fs.mkdir(workDir, { recursive: true });
  await fs.mkdir(outsideDir, { recursive: true });
  await fs.writeFile(path.join(workDir, 'doc.txt'), 'Documento autorizado\n');
  await fs.writeFile(path.join(outsideDir, 'privado.txt'), 'Fuera de ámbito\n');

  const layout = await resolveLayout({ base });

  // Arranque concurrente en frío: debe converger en un solo PID y puerto.
  const booted = await Promise.all([
    ensureCentralMotor({ layout, baseDirectory: layout.baseDirectory }),
    ensureCentralMotor({ layout, baseDirectory: layout.baseDirectory }),
    ensureCentralMotor({ layout, baseDirectory: layout.baseDirectory }),
  ]);
  const pids = new Set(booted.map((entry) => entry.state.pid));
  const ports = new Set(booted.map((entry) => entry.state.port));
  assert.equal(pids.size, 1);
  assert.equal(ports.size, 1);

  // Reutilización caliente sin volver a arrancar.
  const warmStart = Date.now();
  const warm = await ensureCentralMotor({ layout, baseDirectory: layout.baseDirectory });
  assert.equal(warm.spawned, false);
  assert.equal(warm.state.pid, booted[0].state.pid);
  assert.ok(Date.now() - warmStart < 500, `Reutilización caliente tardó demasiado: ${Date.now() - warmStart}ms`);

  // CLI `despertar --headers` devuelve exactamente la cabecera Bearer válida.
  const { stdout: headersStdout } = await execFileAsync(process.execPath, [BIN_MIND, 'despertar', '--headers', '--base', base], {
    cwd: os.tmpdir(),
    windowsHide: true,
  });
  const parsedHeaders = JSON.parse(headersStdout.trim());
  assert.equal(parsedHeaders.Authorization, `Bearer ${warm.token}`);

  // /rpc compartido respeta aislamiento por cwd.
  const rpcAllowed = await callCentralRpc({
    layout,
    baseDirectory: base,
    payload: { accion: 'herramienta', tool: 'leer', args: { ruta: 'doc.txt' }, cwd: workDir },
  });
  assert.equal(rpcAllowed.isError, false);
  assert.match(rpcAllowed.text, /Documento autorizado/);

  const rpcDenied = await callCentralRpc({
    layout,
    baseDirectory: base,
    payload: { accion: 'herramienta', tool: 'leer', args: { ruta: path.join(outsideDir, 'privado.txt') }, cwd: workDir },
  });
  assert.equal(rpcDenied.isError, true);

  // CLI `apagar` detiene limpiamente el proceso único y limpia estado y bloqueo.
  const { stdout: stopStdout } = await execFileAsync(process.execPath, [BIN_MIND, 'apagar', '--base', base], {
    cwd: os.tmpdir(),
    windowsHide: true,
  });
  assert.equal(JSON.parse(stopStdout.trim()).apagado, true);
  assert.equal(await checkHealthyConnector(base), null);
  const { stateFile, lockFile } = connectorPaths(await ensureRealPathOrSelf(base));
  assert.equal(await fs.lstat(stateFile).then(() => true, () => false), false);
  assert.equal(await fs.lstat(lockFile).then(() => true, () => false), false);
});

async function ensureRealPathOrSelf(dir) {
  return fs.realpath(dir).catch(() => dir);
}

test('puente stdio: reconexión transparente tras caída, elicitation/create SSE y BASE_TOO_NEW', { timeout: 45_000 }, async (t) => {
  const { root, base } = await createTempBase(t);
  const motorRepoDir = fileURLToPath(new URL('..', import.meta.url));
  const requestedFolder = path.join(root, 'Extra');
  await fs.mkdir(requestedFolder, { recursive: true });
  await fs.writeFile(path.join(requestedFolder, 'extra.txt'), 'Archivo tras formulario HTTP/SSE\n');

  const client = startMcp({
    args: ['--base', base],
    cwd: motorRepoDir,
    capabilities: { elicitation: { form: {} } },
    onElicit: () => ({ action: 'accept', content: { acceso: 'leer' } }),
  });
  let futureClient = null;
  try {
    await client.initialize();

    // Elicitation SSE sobre HTTP/puente para solicitar acceso a carpeta externa.
    const grant = await client.call('solicitar_acceso', { ruta: requestedFolder, permisos: ['leer'] });
    assert.equal(grant.isError, false);
    assert.equal(grant.data.estado, 'autorizado');
    const firstRead = await client.call('leer', { carpeta: requestedFolder, ruta: 'extra.txt' });
    assert.equal(firstRead.isError, false);
    assert.match(firstRead.text, /Archivo tras formulario/);

    const beforeHealth = await checkHealthyConnector(base);
    assert.ok(beforeHealth);
    const firstPid = beforeHealth.state.pid;

    // Simular apagado del Motor Central con el cliente stdio aún abierto.
    assert.equal(await stopCentralMotor(base), true);
    assert.equal(await checkHealthyConnector(base), null);

    // Pings keepalive del puente con el Motor apagado NO deben despertarlo; tools/call posterior sí.
    assert.deepEqual((await client.request('ping')).result, {});
    assert.deepEqual((await client.request('ping')).result, {});
    assert.equal(await checkHealthyConnector(base), null);

    // El mismo cliente debe reconectar transparentemente y despertar nuevo Motor Central.
    const recovered = await client.call('estado');
    assert.equal(recovered.isError, false);
    const afterHealth = await checkHealthyConnector(base);
    assert.ok(afterHealth);
    assert.notEqual(afterHealth.state.pid, firstPid);

    // Prueba separada: BASE_TOO_NEW a través del puente stdio mantiene Base intacta y expone instructions.
    const { base: futureBase } = await createTempBase(t, 'mind-future-');
    await fs.mkdir(futureBase, { recursive: true });
    const marker = `${JSON.stringify({
      format: 'mind-base',
      version: 99,
      baseId: '00000000-0000-4000-8000-000000000000',
      createdAt: '2030-01-01T00:00:00.000Z',
    })}\n`;
    await fs.writeFile(path.join(futureBase, 'mind-base.json'), marker);
    futureClient = startMcp({ args: ['--base', futureBase], cwd: motorRepoDir });
    const init = await futureClient.initialize();
    assert.match(init.result.instructions, /BASE_TOO_NEW/);
    const tools = (await futureClient.request('tools/list')).result.tools.map((tool) => tool.name);
    assert.deepEqual(tools, ['estado']);
    const status = await futureClient.call('estado');
    assert.equal(status.data.error.codigo, 'BASE_TOO_NEW');
    assert.deepEqual(await fs.readdir(futureBase), ['mind-base.json']);
    assert.equal(await fs.readFile(path.join(futureBase, 'mind-base.json'), 'utf8'), marker);
  } finally {
    await futureClient?.close().catch(() => {});
    await client.close().catch(() => {});
  }
});

function openSseStream({ port, token, sessionId }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const events = [];
    let buffer = '';
    const waiters = [];
    const req = http.request({
      agent: false,
      host: '127.0.0.1',
      port,
      method: 'GET',
      path: '/mcp',
      headers: {
        Host: `127.0.0.1:${port}`,
        Authorization: `Bearer ${token}`,
        Accept: 'text/event-stream',
        'Mcp-Session-Id': sessionId,
      },
    }, (res) => {
      if (res.statusCode !== 200) {
        if (!settled) {
          settled = true;
          reject(new Error(`SSE devolvió HTTP ${res.statusCode}`));
        }
        res.resume();
        return;
      }
      if (!settled) {
        settled = true;
        resolve({
          events,
          res,
          waitForEvent(predicate, timeoutMs = 5_000) {
            const existing = events.find(predicate);
            if (existing) return Promise.resolve(existing);
            return new Promise((resWait, rejWait) => {
              const timer = setTimeout(() => rejWait(new Error('Tiempo agotado esperando evento SSE')), timeoutMs);
              waiters.push((event) => {
                if (!predicate(event)) return false;
                clearTimeout(timer);
                resWait(event);
                return true;
              });
            });
          },
          close() {
            req.destroy();
          },
        });
      }
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk.replace(/\r\n/g, '\n');
        for (;;) {
          const boundary = buffer.indexOf('\n\n');
          if (boundary === -1) break;
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const dataLines = block
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trim());
          if (dataLines.length === 0) continue;
          try {
            const parsed = JSON.parse(dataLines.join('\n'));
            events.push(parsed);
            for (let i = waiters.length - 1; i >= 0; i -= 1) {
              if (waiters[i](parsed)) waiters.splice(i, 1);
            }
          } catch {}
        }
      });
    });
    req.on('error', (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    req.end();
  });
}

test('Etapa 3: reposo ligero, ping/SSE no prolongan vigilia y autoapagado real', { timeout: 30_000 }, async (t) => {
  const { root, base } = await createTempBase(t, 'mind-idle-');
  const docs = path.join(root, 'Docs');
  await fs.mkdir(docs, { recursive: true });
  await fs.writeFile(path.join(docs, 'nota.txt'), 'Etapa 3 reposo y vigilia\n');

  const layout = await resolveLayout({ base });
  let shutdownReason = null;
  let sse = null;
  const motor = await startCentralMotor({
    layout,
    preferredPort: 0,
    idleLightMs: 90,
    idleShutdownMs: 360,
    observe: true,
    onShutdown(reason) {
      shutdownReason = reason;
    },
  });
  try {
    const auth = { Authorization: `Bearer ${motor.token}` };
    const init = await rawHttp({
      port: motor.port,
      method: 'POST',
      pathName: '/mcp',
      headers: auth,
      body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {} } },
    });
    assert.equal(init.status, 200);
    const sid = init.headers['mcp-session-id'];
    await rawHttp({
      port: motor.port,
      method: 'POST',
      pathName: '/mcp',
      headers: { ...auth, 'Mcp-Session-Id': sid },
      body: { jsonrpc: '2.0', method: 'notifications/initialized' },
    });
    sse = await openSseStream({ port: motor.port, token: motor.token, sessionId: sid });

    const grant = await rawHttp({
      port: motor.port,
      method: 'POST',
      pathName: '/mcp',
      headers: { ...auth, 'Mcp-Session-Id': sid },
      body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'solicitar_acceso', arguments: { ruta: docs, permisos: ['leer'] } } },
    });
    assert.equal(grant.status, 200);

    const h0 = await rawHttp({ port: motor.port, pathName: '/health' });
    assert.equal(h0.json.state, 'active');
    const t0 = h0.json.lastActivityAt;

    // Pings MCP, pings RPC y stream SSE abierto NO reinician temporizadores ni despiertan reposo ligero.
    let lightReached = false;
    for (let i = 0; i < 6; i += 1) {
      await delay(35);
      const mcpPing = await rawHttp({
        port: motor.port,
        method: 'POST',
        pathName: '/mcp',
        headers: { ...auth, 'Mcp-Session-Id': sid },
        body: { jsonrpc: '2.0', id: 10 + i, method: 'ping' },
      });
      assert.equal(mcpPing.status, 200);
      const rpcPing = await rawHttp({
        port: motor.port,
        method: 'POST',
        pathName: '/rpc',
        headers: auth,
        body: { accion: 'ping' },
      });
      assert.equal(rpcPing.status, 200);
      assert.equal(rpcPing.json.ok, true);
      const h = await rawHttp({ port: motor.port, pathName: '/health' });
      assert.equal(h.json.lastActivityAt, t0);
      if (h.json.state === 'light-idle') {
        lightReached = true;
        break;
      }
    }
    assert.equal(lightReached, true, 'Debió entrar en light-idle aunque hubiera ping y SSE abierto');

    // Una petición real sí despierta del reposo ligero.
    const wake = await rawHttp({
      port: motor.port,
      method: 'POST',
      pathName: '/mcp',
      headers: { ...auth, 'Mcp-Session-Id': sid },
      body: { jsonrpc: '2.0', id: 20, method: 'tools/call', params: { name: 'estado', arguments: {} } },
    });
    assert.equal(wake.status, 200);
    const hw = await rawHttp({ port: motor.port, pathName: '/health' });
    assert.notEqual(wake.json.result.isError, true);
    assert.equal(hw.json.state, 'active');
    assert.ok(hw.json.lastActivityAt > t0);

    // Con SSE abierto y pings periódicos continuos, idleShutdownMs (360ms) termina apagando el Motor.
    const shutdownDeadline = Date.now() + 3_000;
    while (!shutdownReason && Date.now() < shutdownDeadline) {
      await delay(75);
      await rawHttp({
        port: motor.port,
        method: 'POST',
        pathName: '/mcp',
        headers: { ...auth, 'Mcp-Session-Id': sid },
        body: { jsonrpc: '2.0', id: 99, method: 'ping' },
      }).catch(() => {});
    }
    assert.equal(shutdownReason, 'idle-timeout');
    assert.equal(await checkHealthyConnector(base), null);
  } finally {
    sse?.close();
    await motor.stop('test').catch(() => {});
  }
});

test('Etapa 3: actualización drena Motor Central inactivo y bloquea solo si está ocupado', { timeout: 30_000 }, async (t) => {
  const realBase = await createTempBase(t, 'mind-upd-real-');
  const realLayout = await resolveLayout({ base: realBase.base });
  const sha = (x) => createHash('sha256').update(x).digest('hex');
  const relNode = `Sistema/Componentes/Node/${process.platform}-${process.arch}/${process.platform === 'win32' ? 'node.exe' : 'bin/node'}`;
  const relPy = `Sistema/Componentes/Python/${process.platform}-${process.arch}/${process.platform === 'win32' ? 'python.exe' : 'bin/python3'}`;

  async function buildPackage(dir, revision) {
    const entries = {
      'Sistema/Programa/Motor/app.txt': `app-${revision}`,
      [relNode]: 'node-ficticio',
      [relPy]: 'python-ficticio',
      'LEEME.md': 'paquete ficticio',
    };
    for (const [rel, val] of Object.entries(entries)) {
      const full = path.join(dir, ...rel.split('/'));
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, val);
    }
    const manifest = {
      format: 'mind-product',
      version: 1,
      mindVersion: '1.0.3',
      platform: 'win32',
      arch: 'x64',
      targets: [...UNIVERSAL_TARGETS],
      baseFormatVersion: BASE_FORMAT_VERSION,
      packageRevision: revision,
      layoutVersion: 2,
      updateProtocolVersion: 2,
      files: Object.fromEntries(Object.entries(entries).map(([rel, val]) => [rel, sha(val)])),
      links: {},
    };
    await fs.writeFile(path.join(dir, 'Sistema/mind-producto.json'), JSON.stringify(manifest));
    await fs.writeFile(path.join(dir, 'Sistema/entrega-firmada.json'), JSON.stringify({ ficticio: true, revision }));
  }

  const workRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mind-drain-upd-')));
  t.after(async () => {
    await fs.rm(workRoot, { recursive: true, force: true }).catch(() => {});
  });

  // Caso A: Motor Central inactivo con sesión MCP abierta se drena sin MIND_IN_USE.
  const prodIdle = path.join(workRoot, 'IdleMind');
  const pkg1 = path.join(workRoot, 'Pkg1');
  await buildPackage(prodIdle, 0);
  await buildPackage(pkg1, 1);
  const idleBase = await fs.realpath(prodIdle).then((r) => path.join(r, 'Sistema', 'Base'));
  let idleMotor = await startCentralMotor({
    layout: {
      root: prodIdle,
      motorDirectory: path.join(prodIdle, 'Sistema', 'Programa', 'Motor'),
      baseDirectory: idleBase,
      userDataDirectory: path.join(prodIdle, 'Conversaciones'),
      protectedDirectories: [path.join(prodIdle, 'Sistema')],
      pythonExecutable: realLayout.pythonExecutable,
    },
    observe: false,
    preferredPort: 0,
  });
  try {
    await rawHttp({
      port: idleMotor.port,
      method: 'POST',
      pathName: '/mcp',
      headers: { Authorization: `Bearer ${idleMotor.token}` },
      body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {} } },
    });
    const sessionEntries = await fs.readdir(path.join(idleBase, 'sesiones'));
    assert.ok(sessionEntries.some((name) => name.startsWith('sesion-')));

    const updated = await updateMind({
      root: prodIdle,
      source: pkg1,
      baseDirectory: idleBase,
      confirm: () => true,
      verifyInstalled: async () => {},
      pythonExecutable: realLayout.pythonExecutable,
    });
    assert.equal(updated.status, 'actualizada');
    assert.equal(await checkHealthyConnector(idleBase), null);
    idleMotor = null;
  } finally {
    await idleMotor?.stop('test').catch(() => {});
  }

  // Caso B: Motor Central ocupado (petición en vuelo) responde busy:true y se protege con MIND_IN_USE.
  const prodBusy = path.join(workRoot, 'BusyMind');
  await buildPackage(prodBusy, 0);
  const busyBase = path.join(prodBusy, 'Sistema', 'Base');
  const requestedFolder = path.join(workRoot, 'CarpetaExterna');
  await fs.mkdir(requestedFolder, { recursive: true });
  await fs.writeFile(path.join(requestedFolder, 'objetivo.txt'), 'Archivo para probar bloqueo ocupado\n');
  const busyMotor = await startCentralMotor({
    layout: {
      root: prodBusy,
      motorDirectory: path.join(prodBusy, 'Sistema', 'Programa', 'Motor'),
      baseDirectory: busyBase,
      userDataDirectory: path.join(prodBusy, 'Conversaciones'),
      protectedDirectories: [path.join(prodBusy, 'Sistema')],
      pythonExecutable: realLayout.pythonExecutable,
    },
    observe: false,
    preferredPort: 0,
  });
  let sse = null;
  let pendingCall = null;
  try {
    const auth = { Authorization: `Bearer ${busyMotor.token}` };
    const init = await rawHttp({
      port: busyMotor.port,
      method: 'POST',
      pathName: '/mcp',
      headers: {
        ...auth,
        'x-mind-cwd': requestedFolder,
        'x-mind-workspace-paths': JSON.stringify([requestedFolder]),
      },
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: { elicitation: { form: {} } } },
      },
    });
    const sid = init.headers['mcp-session-id'];
    await rawHttp({
      port: busyMotor.port,
      method: 'POST',
      pathName: '/mcp',
      headers: { ...auth, 'Mcp-Session-Id': sid },
      body: { jsonrpc: '2.0', method: 'notifications/initialized' },
    });
    sse = await openSseStream({ port: busyMotor.port, token: busyMotor.token, sessionId: sid });

    pendingCall = rawHttp({
      port: busyMotor.port,
      method: 'POST',
      pathName: '/mcp',
      headers: { ...auth, 'Mcp-Session-Id': sid },
      body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'borrar', arguments: { carpeta: requestedFolder, ruta: 'objetivo.txt', motivo: 'prueba ocupado' } } },
    });
    const elicitEvent = await Promise.race([
      sse.waitForEvent((ev) => ev?.method === 'elicitation/create'),
      pendingCall.then((res) => {
        throw new Error(`solicitar_acceso respondió antes de emitir elicitación: ${JSON.stringify(res.json)}`);
      }),
    ]);

    assert.equal(await stopCentralMotor(busyBase, { onlyIfIdle: true, timeoutMs: 2_000 }), false);
    assert.ok(await checkHealthyConnector(busyBase));

    await assert.rejects(
      updateMind({
        root: prodBusy,
        source: pkg1,
        baseDirectory: busyBase,
        confirm: () => true,
        verifyInstalled: async () => {},
        pythonExecutable: realLayout.pythonExecutable,
      }),
      (error) => error.code === 'MIND_IN_USE' && error.prepared === true,
    );

    await rawHttp({
      port: busyMotor.port,
      method: 'POST',
      pathName: '/mcp',
      headers: { ...auth, 'Mcp-Session-Id': sid },
      body: { jsonrpc: '2.0', id: elicitEvent.id, result: { action: 'cancel' } },
    });
    await pendingCall;
  } finally {
    sse?.close();
    await busyMotor.stop('test').catch(() => {});
    await pendingCall?.catch(() => {});
  }
});

test('Etapa 4: cola inteligente — unidad de prioridades, claves por recurso y cesión P3', { timeout: 15_000 }, async () => {
  assert.equal(classifyToolPriority('buscar', { consulta: 'hola' }), QUEUE_PRIORITY.READ);
  assert.equal(classifyToolPriority('estado', {}), QUEUE_PRIORITY.READ);
  assert.equal(classifyToolPriority('destino_resolver', { nombre: 'doc.md' }), QUEUE_PRIORITY.READ);
  assert.equal(classifyToolPriority('destino_resolver', { nombre: 'doc.md', preparar: true }), QUEUE_PRIORITY.WRITE);
  assert.equal(classifyToolPriority('crear', { ruta: 'x.txt', contenido: 'a' }), QUEUE_PRIORITY.WRITE);
  assert.equal(classifyToolPriority('crear_respaldo', {}), QUEUE_PRIORITY.WRITE);

  const keysMove = await resolveToolResourceKeys('mover', { carpeta: 'folder-a', carpeta_destino: 'folder-b' }, async (ref) => ref);
  assert.deepEqual(keysMove, ['folder:folder-a', 'folder:folder-b']);
  assert.deepEqual(await resolveToolResourceKeys('crear_respaldo', {}), ['backup']);
  assert.deepEqual(await resolveToolResourceKeys('conversacion_guardar', { id: 'c1' }), ['conversation:c1']);

  const queue = createSmartQueue({ backgroundYieldMs: 10 });

  // Dos recursos distintos (A, B, backup) corren en paralelo sin bloquearse entre sí.
  let activeParallel = 0;
  let maxParallel = 0;
  let releaseBarrier;
  const barrier = new Promise((resolve) => { releaseBarrier = resolve; });
  const pA = queue.runWrite(['folder:A'], async () => {
    activeParallel += 1;
    maxParallel = Math.max(maxParallel, activeParallel);
    if (activeParallel === 3) releaseBarrier();
    await barrier;
    activeParallel -= 1;
    return 'A';
  });
  const pB = queue.runWrite(['folder:B'], async () => {
    activeParallel += 1;
    maxParallel = Math.max(maxParallel, activeParallel);
    if (activeParallel === 3) releaseBarrier();
    await barrier;
    activeParallel -= 1;
    return 'B';
  });
  const pBackup = queue.runWrite(['backup'], async () => {
    activeParallel += 1;
    maxParallel = Math.max(maxParallel, activeParallel);
    if (activeParallel === 3) releaseBarrier();
    await barrier;
    activeParallel -= 1;
    return 'backup';
  });
  assert.deepEqual(await Promise.all([pA, pB, pBackup]), ['A', 'B', 'backup']);
  assert.equal(maxParallel, 3);

  // Mismo recurso se serializa en orden estricto y cancelación por AbortSignal no rompe la cola.
  const order = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const first = queue.runWrite(['folder:same'], async () => {
    order.push('first-start');
    await firstGate;
    order.push('first-end');
  });
  const ac = new AbortController();
  const aborted = queue.runWrite(['folder:same'], async () => {
    order.push('aborted-should-not-run');
  }, { signal: ac.signal });
  const third = queue.runWrite(['folder:same'], async () => {
    order.push('third');
  });
  ac.abort(new Error('cancelada'));
  await assert.rejects(aborted, /cancelada/);
  releaseFirst();
  await Promise.all([first, third]);
  assert.deepEqual(order, ['first-start', 'first-end', 'third']);

  // P3 cede mientras hay demanda P1/P2 y avanza en cuanto queda libre.
  let releaseRead;
  const readGate = new Promise((resolve) => { releaseRead = resolve; });
  const activeRead = queue.runRead(() => readGate);
  assert.equal(queue.hasForegroundDemand(), true);
  let bgRan = false;
  const bgPromise = queue.runBackground(() => {
    bgRan = true;
    return 'bg-ok';
  }, { maxWaitMs: 500 });
  await delay(20);
  assert.equal(bgRan, false);
  releaseRead();
  await activeRead;
  assert.equal(await bgPromise, 'bg-ok');
  assert.equal(bgRan, true);

  // Cruce multirrecurso inverso sin interbloqueo.
  const cross = await Promise.all([
    queue.runWrite(['folder:x', 'folder:y'], async () => 'xy'),
    queue.runWrite(['folder:y', 'folder:x'], async () => 'yx'),
  ]);
  assert.deepEqual(cross, ['xy', 'yx']);
});

test('Etapa 4: P1 buscar <50 ms bajo carga, P2 paralela entre carpetas y serializada en la misma', { timeout: 30_000 }, async (t) => {
  const { root, base } = await createTempBase(t, 'mind-queue-live-');
  const projA = path.join(root, 'ProyectoA');
  const projB = path.join(root, 'ProyectoB');
  await fs.mkdir(projA, { recursive: true });
  await fs.mkdir(projB, { recursive: true });
  await fs.writeFile(path.join(projA, 'objetivo-a.txt'), 'Documento objetivo en proyecto A\n');
  await fs.writeFile(path.join(projB, 'objetivo-b.txt'), 'Documento objetivo en proyecto B\n');

  const layout = await resolveLayout({ base });
  const motor = await startCentralMotor({
    layout,
    preferredPort: 0,
    observe: true,
  });
  let sse = null;
  let heldWriteA = null;
  try {
    const auth = { Authorization: `Bearer ${motor.token}` };
    const init = await rawHttp({
      port: motor.port,
      method: 'POST',
      pathName: '/mcp',
      headers: {
        ...auth,
        'x-mind-cwd': projA,
        'x-mind-workspace-paths': JSON.stringify([projA, projB]),
      },
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: { elicitation: { form: {} } } },
      },
    });
    assert.equal(init.status, 200);
    const sid = init.headers['mcp-session-id'];
    await rawHttp({
      port: motor.port,
      method: 'POST',
      pathName: '/mcp',
      headers: { ...auth, 'Mcp-Session-Id': sid },
      body: { jsonrpc: '2.0', method: 'notifications/initialized' },
    });
    sse = await openSseStream({ port: motor.port, token: motor.token, sessionId: sid });

    // Precalienta índice en memoria para medir lecturas P1 en caliente.
    const warmSearch = await rawHttp({
      port: motor.port,
      method: 'POST',
      pathName: '/mcp',
      headers: { ...auth, 'Mcp-Session-Id': sid },
      body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'buscar', arguments: { consulta: 'objetivo' } } },
    });
    assert.equal(warmSearch.status, 200);
    assert.notEqual(warmSearch.json.result.isError, true);

    // Retiene P2 sobre ProyectoA (borrar esperando elicitación SSE).
    heldWriteA = rawHttp({
      port: motor.port,
      method: 'POST',
      pathName: '/mcp',
      headers: { ...auth, 'Mcp-Session-Id': sid },
      body: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'borrar', arguments: { carpeta: projA, ruta: 'objetivo-a.txt', motivo: 'retener P2 en A' } } },
    });
    const elicitEvent = await Promise.race([
      sse.waitForEvent((ev) => ev?.method === 'elicitation/create'),
      heldWriteA.then((res) => {
        throw new Error(`borrar en A terminó antes de emitir elicitación: ${JSON.stringify(res.json)}`);
      }),
    ]);

    // Encolamos otra escritura P2 sobre el MISMO ProyectoA: debe esperar mientras A siga retenido.
    let sameFolderFinished = false;
    const queuedWriteA = rawHttp({
      port: motor.port,
      method: 'POST',
      pathName: '/mcp',
      headers: { ...auth, 'Mcp-Session-Id': sid },
      body: { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'crear', arguments: { carpeta: projA, ruta: 'encolado-a.txt', contenido: 'turno posterior en A\n' } } },
    }).then((res) => {
      sameFolderFinished = true;
      return res;
    });

    await delay(25);
    assert.equal(sameFolderFinished, false, 'La escritura en la misma carpeta A no debe adelantarse');
    assert.ok(motor.queueStatus().activeWrites >= 1);
    assert.ok(motor.queueStatus().queuedWrites >= 1);

    // Mientras A está retenido + encolado, una escritura P2 en ProyectoB (otro recurso) avanza en paralelo.
    const writeB = await rawHttp({
      port: motor.port,
      method: 'POST',
      pathName: '/mcp',
      headers: { ...auth, 'Mcp-Session-Id': sid },
      body: { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'crear', arguments: { carpeta: projB, ruta: 'paralelo-b.txt', contenido: 'escrito en paralelo en B\n' } } },
    });
    assert.equal(writeB.status, 200);
    assert.notEqual(writeB.json.result.isError, true);
    assert.equal(sameFolderFinished, false, 'ProyectoB terminó sin que ProyectoA se liberara');

    // Lecturas P1 concurrentes (buscar en caliente) completan por debajo de 50 ms mientras P2 sigue activo/encolado.
    const readLatencies = [];
    for (let i = 0; i < 4; i += 1) {
      const start = performance.now();
      const res = await rawHttp({
        port: motor.port,
        method: 'POST',
        pathName: '/mcp',
        headers: { ...auth, 'Mcp-Session-Id': sid },
        body: { jsonrpc: '2.0', id: 20 + i, method: 'tools/call', params: { name: 'buscar', arguments: { consulta: 'objetivo' } } },
      });
      readLatencies.push(performance.now() - start);
      assert.equal(res.status, 200);
      assert.notEqual(res.json.result.isError, true);
    }
    const maxReadMs = Math.max(...readLatencies);
    assert.ok(maxReadMs < 50, `Lectura P1 tardó ${maxReadMs.toFixed(1)}ms (>50ms) bajo carga P2`);
    assert.equal(sameFolderFinished, false);

    // Al responder cancel al borrar en A, primero termina borrar y enseguida avanza crear en A.
    await rawHttp({
      port: motor.port,
      method: 'POST',
      pathName: '/mcp',
      headers: { ...auth, 'Mcp-Session-Id': sid },
      body: { jsonrpc: '2.0', id: elicitEvent.id, result: { action: 'cancel' } },
    });
    const [heldRes, queuedRes] = await Promise.all([heldWriteA, queuedWriteA]);
    assert.equal(heldRes.status, 200);
    assert.equal(queuedRes.status, 200);
    assert.notEqual(queuedRes.json.result.isError, true);
    assert.equal(await fs.readFile(path.join(projA, 'encolado-a.txt'), 'utf8'), 'turno posterior en A\n');
    assert.equal(await fs.readFile(path.join(projB, 'paralelo-b.txt'), 'utf8'), 'escrito en paralelo en B\n');
  } finally {
    sse?.close();
    await motor.stop('test').catch(() => {});
    await heldWriteA?.catch(() => {});
  }
});
