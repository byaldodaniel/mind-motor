import assert from 'node:assert/strict';
import { auxiliaryProcesses } from './process-children.mjs';
import { execFile, spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { prepareAgentStartup } from '../../src/agent-startup.js';
import { updateManagedClientConnections } from '../../src/client-connections.js';
import { checkHealthyConnector, postRpc } from '../../src/connector.js';
import { productPaths, productRuntime } from '../../src/layout.js';
import { RUNS } from './runs.mjs';

const binary = process.env.MIND_NATIVE_EXE;
const run = promisify(execFile);
const tools = ['acceso', 'estado', 'retomar', 'buscar', 'leer', 'crear', 'modificar', 'organizar', 'guardar', 'actualizar', 'vista', 'mind', 'mind_cambiar'].sort();
const configs = [
  ['Codex', '.codex/config.toml', 'url'], ['Claude Code', '.claude.json', 'url'],
  ['Gemini CLI', '.gemini/settings.json', 'httpUrl'], ['Antigravity', '.gemini/config/mcp_config.json', 'serverUrl'],
  ['Antigravity', '.gemini/antigravity/mcp_config.json', 'serverUrl'],
];
const missing = error => { if (error.code !== 'ENOENT') throw error; return null; };

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(RUNS, 'mind-clientes-')));
  const home = path.join(root, 'Perfil'), installation = path.join(root, 'Instalacion'), cwd = path.join(root, 'Proyecto');
  const hidden = path.join(root, 'Reservado');
  const manifest = { mindVersion: '1.0.5', layoutVersion: 2, packageRevision: 1 };
  const paths = productPaths(installation, manifest), base = paths.baseDirectory, runtime = productRuntime(installation, manifest);
  const codexHome = path.join(home, '.codex');
  const isolated = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: codexHome, GEMINI_CLI_HOME: home, MIND_AGENT_STARTUP: '0' };
  let child, closed, diagnostics;
  const stop = async () => {
    if (!child) return;
    const active = await checkHealthyConnector(base).catch(() => null);
    if (active?.health.pid === child.pid) {
      await postRpc({ port: active.health.port, token: active.token, payload: { accion: 'apagar' }, timeoutMs: 5000 }).catch(() => {});
      if (!await Promise.race([closed.then(() => true), delay(4000, false, { ref: false })])) child.kill();
    } else if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
    child = null;
  };
  t.after(async () => {
    try { await stop(); } finally {
      assert.equal(path.dirname(root), RUNS);
      assert.ok(path.basename(root).startsWith('mind-clientes-'));
      await fs.rm(root, { recursive: true, force: true, maxRetries: 12, retryDelay: 120 });
    }
  });
  await Promise.all([base, cwd, hidden, codexHome, path.join(home, '.claude'),
    path.join(home, '.gemini/config'), path.join(home, '.gemini/antigravity')].map(dir => fs.mkdir(dir, { recursive: true })));
  await fs.writeFile(path.join(cwd, 'nota.txt'), 'Nota ficticia.');
  await fs.writeFile(path.join(hidden, 'nota.txt'), 'Nota reservada.');
  const options = { root: installation, runtime, manifest, home, baseDirectory: base, env: { CODEX_HOME: codexHome, GEMINI_CLI_HOME: home }, createMissing: true };
  const start = async port => {
    diagnostics = '';
    child = spawn(path.resolve(binary), ['motor', '--base', base, '--conector', ...(port ? ['--port', String(port)] : [])],
      { cwd, env: isolated, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', text => { diagnostics = (diagnostics + text).slice(-1000); });
    child.on('error', error => { diagnostics = error.message; });
    closed = new Promise(resolve => child.once('close', resolve));
    for (let i = 0; i < 120; i++) {
      if (!child.pid || child.exitCode !== null) assert.fail('El Motor no arrancó. ' + diagnostics);
      const active = await checkHealthyConnector(base).catch(() => null);
      if (active?.health.pid === child.pid) return { ...active, url: active.url + '/mcp' };
      await delay(100);
    }
    assert.fail('El Motor no publicó el conector. ' + diagnostics);
  };
  return { root, home, base, cwd, hidden, runtime, paths, isolated, options, start, stop };
}

async function mcp(active, workspace) {
  const headers = { Authorization: 'Bearer ' + active.token, Accept: 'application/json', 'Content-Type': 'application/json' };
  if (workspace) headers['X-Mind-Workspace'] = Buffer.from(JSON.stringify({ paths: [workspace] })).toString('base64url');
  let id = 0;
  async function send(method, params) {
    const requestId = ++id;
    const reply = await fetch(active.url, { method: 'POST', headers, signal: AbortSignal.timeout(8000), redirect: 'error',
      body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) });
    assert.equal(reply.status, 200, method);
    const { error, result, id: received } = await reply.json();
    assert.equal(received, requestId);
    assert.equal(error, undefined, JSON.stringify(error));
    return { result, session: reply.headers.get('mcp-session-id') };
  }
  const initial = await send('initialize', { protocolVersion: '2025-11-25', capabilities: {},
    clientInfo: { name: 'Cliente HTTP ficticio', version: '1' } });
  headers['Mcp-Session-Id'] = initial.session;
  headers['MCP-Protocol-Version'] = initial.result.protocolVersion;
  assert.ok(initial.session);
  return {
    async list() { return (await send('tools/list')).result.tools.map(tool => tool.name).sort(); },
    async call(name, args = {}, denied = false) {
      const { result } = await send('tools/call', { name, arguments: args });
      assert.equal(Boolean(result.isError), denied, JSON.stringify(result.structuredContent));
      return result.structuredContent;
    },
    async close() {
      const reply = await fetch(active.url, { method: 'DELETE', headers, signal: AbortSignal.timeout(5000), redirect: 'error' });
      assert.ok(reply.ok);
      await reply.text();
    },
  };
}

async function listen(port = 0) {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port, host: '127.0.0.1', exclusive: true }, resolve);
  });
  return { port: server.address().port, close: () => new Promise((resolve, reject) =>
    server.close(error => error ? reject(error) : resolve())) };
}

test('6: puerto, token, permisos y dos sesiones HTTP directas en un único Motor Rust', {
  skip: !binary && 'Indica MIND_NATIVE_EXE', timeout: 90000,
}, async t => {
  const f = await fixture(t);
  const probe = await listen();
  const preferred = probe.port;
  await probe.close();
  const before = await f.start(preferred);
  assert.equal(before.health.port, preferred);
  const one = await mcp(before), two = await mcp(before, f.cwd);
  for (const client of [one, two]) {
    assert.deepEqual(await client.list(), tools);
    assert.equal((await client.call('estado')).motor_central.pid, before.health.pid);
  }
  assert.equal((await checkHealthyConnector(f.base)).health.sessions, 2);
  assert.deepEqual(await auxiliaryProcesses(before.health.pid), []);
  await one.call('leer', { ruta: 'nota.txt' }, true);
  assert.equal((await two.call('leer', { ruta: 'nota.txt' })).contenido, 'Nota ficticia.');
  await two.call('leer', { carpeta: f.hidden, ruta: 'nota.txt' }, true);
  await one.close();
  await two.close();
  await f.stop();
  assert.equal(await fs.stat(path.join(f.base, 'conector.json')).catch(missing), null);
  const after = await f.start();
  assert.equal(after.url, before.url);
  assert.equal(after.token === before.token, true);
  const resumed = await mcp(before, f.cwd);
  assert.equal((await resumed.call('estado')).motor_central.pid, after.health.pid);
  assert.deepEqual(await auxiliaryProcesses(after.health.pid), []);
  await resumed.close();
  await f.stop();

  const reserved = await listen(preferred);
  try {
    const fallback = await f.start();
    assert.notEqual(fallback.health.port, preferred);
    assert.equal(fallback.token === before.token, true);
    await f.stop();
    const confirmed = await f.start();
    assert.equal(confirmed.health.port, fallback.health.port);
    t.diagnostic('Dos sesiones en PID ' + before.health.pid + ', reinicio en PID ' + after.health.pid + ', 0 auxiliares.');
  } finally { await reserved.close(); }
});

test('6: los cuatro formatos se crean, actualizan y revierten preservando servidores ajenos', {
  skip: !binary && 'Indica MIND_NATIVE_EXE', timeout: 90000,
}, async t => {
  const f = await fixture(t);
  const read = relative => fs.readFile(path.join(f.home, relative), 'utf8');
  const codexOther = '# comentario ajeno\r\n[mcp_servers.temporal]\r\ncommand = "servidor-ficticio"\r\n';
  const jsonOther = '{ "otroAjuste": true, "mcpServers": {"temporal": {"command": "servidor-ficticio"}} }\n';
  await fs.writeFile(path.join(f.home, '.codex/config.toml'), codexOther);
  for (const [, file] of configs.slice(1)) await fs.writeFile(path.join(f.home, file), jsonOther);
  await fs.writeFile(path.join(f.home, '.claude.json'), JSON.stringify({ mcpServers: {
    temporal: { command: 'servidor-ficticio' },
    mind: { type: 'stdio', command: f.runtime.nodeExecutable, args: [f.paths.agentEntrypoint, 'mcp'], alwaysLoad: false },
  } }));
  await fs.writeFile(path.join(f.home, '.claude/CLAUDE.md'), 'Regla local ficticia.\n');

  const before = await f.start();
  const installed = await prepareAgentStartup(f.options);
  assert.equal(installed.estado, 'preparado', JSON.stringify(installed));
  assert.deepEqual(installed.conexiones.map(item => item.estado), ['creada', 'actualizada', 'creada', 'creada', 'creada']);
  assert.equal(installed.clientes.length, 4);
  assert.ok(!JSON.stringify(installed).includes(before.token));
  const rules = await read('.claude/CLAUDE.md');
  assert.ok(rules.startsWith('Regla local ficticia.\n'));
  for (const word of [...tools, 'consultas', 'recientes', 'mantener_abierta']) {
    assert.ok(rules.includes(String.fromCharCode(96) + word + String.fromCharCode(96)), word);
  }
  for (const [client, file, key] of configs) {
    const text = await read(file);
    if (client === 'Codex') {
      assert.ok(text.startsWith(codexOther) && text.includes('url = "' + before.url + '"'));
      assert.ok(text.includes('http_headers') && text.includes('Authorization'));
    } else {
      const value = JSON.parse(text);
      assert.deepEqual(value.mcpServers.temporal, { command: 'servidor-ficticio' });
      assert.equal(value.mcpServers.mind[key], before.url);
      assert.equal(value.mcpServers.mind.headers.Authorization === 'Bearer ' + before.token, true);
      if (client === 'Claude Code') assert.equal(value.mcpServers.mind.type, 'http');
    }
  }
  assert.ok((await updateManagedClientConnections(f.options)).every(item => item.estado === 'vigente'));

  await f.stop();
  const busy = await listen(before.health.port);
  let fallback;
  try { fallback = await f.start(); } finally { await busy.close(); }
  assert.notEqual(fallback.url, before.url);
  assert.ok((await updateManagedClientConnections(f.options)).every(item => item.estado === 'actualizada'));

  const foreign = path.join(f.home, '.gemini/config/mcp_config.json');
  const current = await fs.readFile(foreign, 'utf8');
  const altered = current.replace(fallback.url, 'http://localhost:7777/mcp');
  await fs.writeFile(foreign, altered);
  assert.equal((await updateManagedClientConnections(f.options)).find(item => item.archivo === foreign).estado, 'ajena');
  assert.equal(await fs.readFile(foreign, 'utf8'), altered);
  await fs.writeFile(foreign, current);

  const linked = path.join(f.home, '.gemini/antigravity/mcp_config.json');
  const original = path.join(f.root, 'config-enlazada.json');
  const saved = await fs.readFile(linked, 'utf8');
  await fs.rename(linked, original);
  await fs.link(original, linked);
  assert.equal((await updateManagedClientConnections(f.options)).find(item => item.archivo === linked).codigo, 'CLIENT_CONNECTION_UNSAFE');
  assert.equal(await fs.readFile(original, 'utf8'), saved);
  await fs.unlink(linked);
  await fs.rename(original, linked);
  await f.stop();

  const reverted = await prepareAgentStartup({ ...f.options, mode: 'r3' });
  assert.ok(reverted.conexiones.every(item => item.estado === 'revertida'), JSON.stringify(reverted));
  assert.ok((await read('.claude/CLAUDE.md')).includes('Regla local ficticia.\n'));
  assert.ok(!(await read('.claude/CLAUDE.md')).includes('Mind 1.0.5'));
  for (const [client, file] of configs) {
    const text = await read(file);
    assert.ok(!text.includes(fallback.token));
    if (client === 'Codex') assert.ok(text.startsWith(codexOther) && text.includes('command = ' + JSON.stringify(f.runtime.nodeExecutable)));
    else {
      const value = JSON.parse(text);
      assert.deepEqual(value.mcpServers.temporal, { command: 'servidor-ficticio' });
      assert.equal(value.mcpServers.mind.command, f.runtime.nodeExecutable);
      assert.deepEqual(value.mcpServers.mind.args, [f.paths.agentEntrypoint, 'mcp']);
    }
  }

  await f.start();
  const relative = '.codex/config.toml';
  const codexFile = path.join(f.home, relative);
  const originalConfig = await read(relative);
  const concurrentEdit = '# cambio concurrente ficticio\r\n';
  let changed = false;
  const runtime = {
    ...f.runtime,
    get nodeExecutable() {
      // El configurador ya tomó la primera lectura al resolver el comando anterior.
      if (!changed) {
        appendFileSync(codexFile, concurrentEdit);
        changed = true;
      }
      return f.runtime.nodeExecutable;
    },
  };
  const results = await updateManagedClientConnections({ ...f.options, runtime });
  assert.equal(results.find(item => item.archivo === codexFile).codigo, 'CLIENT_CONNECTION_CHANGED');
  assert.equal(await read(relative), originalConfig + concurrentEdit);
});

const codexExe = process.env.MIND_TEST_CODEX_EXE;
const geminiEntry = process.env.MIND_TEST_GEMINI_ENTRY;

async function liveEnv(f) {
  const { PATH, Path, SystemRoot, WINDIR, ComSpec, PATHEXT } = process.env;
  const appData = path.join(f.home, 'AppData');
  const temp = path.join(f.root, 'ClienteTemp');
  await Promise.all([appData, temp].map(dir => fs.mkdir(dir, { recursive: true })));
  return {
    PATH: PATH ?? Path, SystemRoot, WINDIR, ComSpec, PATHEXT,
    HOME: f.home, USERPROFILE: f.home, CODEX_HOME: f.isolated.CODEX_HOME,
    GEMINI_CLI_HOME: f.home, APPDATA: appData, LOCALAPPDATA: appData, TMP: temp, TEMP: temp,
    CI: '1', GEMINI_CLI_NO_RELAUNCH: '1',
  };
}

async function codexTools(f, env, active, t) {
  const { createInterface } = await import('node:readline');
  const child = spawn(codexExe, ['app-server', '--listen', 'stdio://'], {
    cwd: f.cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.resume();
  const ended = new Promise(resolve => child.once('close', resolve));
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  child.on('error', error => { for (const { reject } of pending.values()) reject(error); });
  child.on('close', code => { for (const { reject } of pending.values()) reject(Error('Codex terminó con ' + code)); });
  lines.on('line', line => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    const request = pending.get(msg.id);
    if (!request) return;
    if (msg.error) request.reject(Error(JSON.stringify(msg.error)));
    else request.resolve(msg.result);
  });
  let nextId = 0;
  async function request(method, params) {
    const id = ++nextId;
    let timer;
    try {
      return await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(Error('Codex no respondió a ' + method)), 20000);
        pending.set(id, { resolve, reject });
        child.stdin.write(JSON.stringify({ id, method, params }) + '\n', error => { if (error) reject(error); });
      });
    } finally { clearTimeout(timer); pending.delete(id); }
  }
  try {
    await request('initialize', { clientInfo: { name: 'prueba_mind', title: 'Prueba local de Mind', version: '1' } });
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    const { thread } = await request('thread/start', { cwd: f.cwd, ephemeral: true });
    const result = await request('mcpServerStatus/list', { threadId: thread.id });
    const server = result.data?.find(item => item.name === 'mind');
    assert.ok(server, 'Codex no registró el servidor Mind.');
    const call = (tool, args = {}) => request('mcpServer/tool/call', {
      threadId: thread.id, server: 'mind', tool, arguments: args,
    });
    const state = await call('estado');
    assert.equal(state.structuredContent.motor_central.pid, active.health.pid);
    const local = await call('leer', { ruta: 'nota.txt' });
    if (!local.isError) assert.equal(local.structuredContent.contenido, 'Nota ficticia.');
    const denied = await call('leer', { carpeta: f.hidden, ruta: 'nota.txt' });
    assert.equal(denied.isError, true);
    t.diagnostic('Codex en PID ' + active.health.pid + ': lectura de la carpeta abierta '
      + (local.isError ? 'requiere autorización' : 'permitida') + ', carpeta reservada denegada.');
    return Object.values(server.tools ?? {}).map(tool => tool.name).sort();
  } finally {
    lines.close();
    child.stdin.end();
    if (!await Promise.race([ended.then(() => true), delay(1500, false, { ref: false })])) child.kill();
    await ended;
  }
}

const geminiTrace = `
const originalFetch = globalThis.fetch.bind(globalThis);
const url = process.env.MIND_PROBE_URL;
let captured = false, counter = 0;
globalThis.fetch = async (input, init) => {
  const location = typeof input === 'string' ? input : input.url ?? String(input);
  if (location !== url) throw new Error('La prueba del cliente solo usa el Motor de laboratorio.');
  const response = await originalFetch(input, init);
  let message;
  try { message = JSON.parse(init?.body); } catch { return response; }
  const headers = new Headers(init?.headers ?? input?.headers);
  if (captured || message?.method !== 'ping' || !headers.has('mcp-session-id') || !response.ok) return response;
  captured = true;
  headers.set('Accept', 'application/json');
  headers.set('Content-Type', 'application/json');
  const call = async (method, params) => {
    const reply = await originalFetch(url, {
      method: 'POST', headers, redirect: 'error', signal: AbortSignal.timeout(6000),
      body: JSON.stringify({ jsonrpc: '2.0', id: 'prueba-mind-' + ++counter, method, params }),
    });
    if (!reply.ok) throw Error('La sesión instalada rechazó el sondeo.');
    return (await reply.json()).result;
  };
  const tools = (await call('tools/list')).tools.map(tool => tool.name).sort();
  const state = await call('tools/call', { name: 'estado', arguments: {} });
  const denied = await call('tools/call', { name: 'leer', arguments: { ruta: 'nota.txt' } });
  console.error('MIND-PRUEBA ' + JSON.stringify({ tools, pid: state.structuredContent.motor_central.pid, denied: denied.isError === true }));
  return response;
};
`;

async function geminiTools(f, env, active) {
  const probe = path.join(f.root, 'sondeo-gemini.mjs');
  await fs.writeFile(probe, geminiTrace);
  await fs.writeFile(path.join(f.home, '.gemini', 'trustedFolders.json'), JSON.stringify({ [f.cwd]: 'TRUST_FOLDER' }));
  const { stdout, stderr } = await run(process.execPath, ['--import', pathToFileURL(probe).href, geminiEntry, 'mcp', 'list'], {
    cwd: f.cwd, windowsHide: true, env: { ...env, MIND_PROBE_URL: active.url }, timeout: 25000,
  });
  const log = stdout + stderr;
  assert.match(log.replace(/\x1b\[[\d;]+m/gu, ''), /mind: .* \(http\) - Connected/u);
  const banner = stderr.split('\n').find(line => line.startsWith('MIND-PRUEBA '));
  assert.ok(banner, 'Gemini no completó la comprobación de catálogo en su sesión HTTP.');
  const result = JSON.parse(banner.slice('MIND-PRUEBA '.length));
  assert.equal(result.pid, active.health.pid);
  assert.equal(result.denied, true);
  return result.tools;
}

for (const [client, installed, discover] of [
  ['Codex', codexExe, codexTools],
  ['Gemini CLI', geminiEntry, geminiTools],
]) {
  test('6 en vivo: ' + client + ' conecta por HTTP y descubre el catálogo sin llamadas al modelo', {
    skip: (!binary || !installed) && 'Indica el ejecutable del cliente y MIND_NATIVE_EXE', timeout: 90000,
  }, async t => {
    const f = await fixture(t);
    const env = await liveEnv(f);
    const before = await f.start();
    const configured = await updateManagedClientConnections(f.options);
    assert.ok(configured.some(entry => entry.cliente === client && entry.estado === 'creada'));
    const [, relative] = configs.find(config => config[0] === client);
    const filename = path.join(f.home, relative);
    const config = await fs.readFile(filename, 'utf8');
    assert.deepEqual(await discover(f, env, before, t), tools);
    assert.deepEqual(await auxiliaryProcesses(before.health.pid), []);
    await f.stop();
    const after = await f.start();
    assert.equal(after.url, before.url);
    assert.equal(after.token === before.token, true);
    assert.equal(await fs.readFile(filename, 'utf8') === config, true);
    assert.deepEqual(await discover(f, env, after, t), tools);
    assert.deepEqual(await auxiliaryProcesses(after.health.pid), []);
    t.diagnostic(client + ': 13 herramientas, PID Rust ' + before.health.pid + ' → ' + after.health.pid + ' en el mismo puerto y 0 auxiliares.');
  });
}
