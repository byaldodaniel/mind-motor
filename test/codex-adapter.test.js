import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { openMotor } from '../src/motor.js';
import { prepareCodexRead } from '../src/codex-session.js';
import { codexInvocation, PILOT_PROMPT, runPilot } from '../scripts/codex-mind.mjs';

const development = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const relay = fileURLToPath(new URL('../src/codex-relay.js', import.meta.url));

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(development, '.mind-mcp-test-'));
  const base = path.join(root, 'Base ficticia');
  const folder = path.join(root, 'Información ficticia');
  await fs.mkdir(base);
  await fs.mkdir(folder);
  await fs.writeFile(path.join(folder, 'permitido.txt'), 'Dato ficticio: café 🧠\n');
  await fs.writeFile(path.join(folder, 'ajeno.txt'), 'NO ENTREGAR');
  const motor = await openMotor({ baseDirectory: base });
  const registered = await motor.authorizeFolder(folder);
  const clients = [], sessions = [];
  t.after(async () => {
    for (const client of clients) await client.close();
    for (const session of sessions) await session.close();
    assert.equal(path.dirname(root), development);
    assert.ok(path.basename(root).startsWith('.mind-mcp-test-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const options = { motor, folderId: registered.id, relativePath: 'permitido.txt', confirm: async () => true };
  async function session(overrides = {}) {
    const result = await prepareCodexRead({ ...options, ...overrides });
    sessions.push(result);
    return result;
  }
  async function connect(server) {
    const client = new Client({ name: 'cliente-ficticio', version: '1.0.0' });
    clients.push(client);
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [relay, server.address], stderr: 'pipe' }), { timeout: 3000 });
    return client;
  }
  return { root, base, folder, motor, registered, session, connect };
}

test('el anfitrión exige consentimiento explícito y no concede por rutas o nombres', async (t) => {
  const { motor, registered, session, base } = await fixture(t);
  let grants = 0;
  const observed = { ...motor, grantTextRead: (...args) => { grants++; return motor.grantTextRead(...args); } };
  for (const answer of [false, undefined, 'AUTORIZO', { approved: true }]) {
    await assert.rejects(session({ motor: observed, confirm: async (selection) => {
      assert.equal(selection.folderId, registered.id);
      assert.equal(selection.relativePath, 'permitido.txt');
      assert.equal(selection.recipient, 'Codex CLI y su modelo');
      return answer;
    } }), { code: 'CONSENT_DENIED' });
  }
  assert.equal(grants, 0);
  assert.equal((await fs.readdir(base)).length, 1);
});

test('cliente MCP real por stdio negocia, ve una herramienta y lee una vez sin modificar originales', async (t) => {
  const { session, connect, folder, base } = await fixture(t);
  const original = path.join(folder, 'permitido.txt');
  const before = await fs.stat(original);
  const client = await connect(await session());
  const tools = (await client.listTools()).tools;
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'mind_read_text');
  assert.deepEqual(tools[0].inputSchema, { type: 'object', properties: {}, additionalProperties: false });
  const first = await client.callTool({ name: 'mind_read_text', arguments: {} });
  assert.equal(first.structuredContent.content, 'Dato ficticio: café 🧠\n');
  assert.equal(first.isError, undefined);
  const second = await client.callTool({ name: 'mind_read_text', arguments: {} });
  assert.equal(second.isError, true);
  assert.equal(second.structuredContent.code, 'READ_NOT_AUTHORIZED');
  assert.equal(Object.hasOwn(second.structuredContent, 'content'), false);
  assert.equal(await fs.readFile(original, 'utf8'), 'Dato ficticio: café 🧠\n');
  assert.equal((await fs.stat(original)).mtimeMs, before.mtimeMs);
  assert.equal((await fs.readdir(base)).length, 1);
});

test('no admite cambiar archivo ni identidad, y no publica operaciones administrativas', async (t) => {
  const { session, connect } = await fixture(t);
  const client = await connect(await session());
  for (const args of [{ relativePath: 'ajeno.txt' }, { approved: true }, { requester: 'Codex' }, { authorization: {} }]) {
    const result = await client.callTool({ name: 'mind_read_text', arguments: args });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.code, 'INVALID_ARGUMENTS');
  }
  for (const name of ['authorizeFolder', 'grantTextRead', 'indexFolder', 'readFolderIndex', 'recordContinuity']) {
    const result = await client.callTool({ name, arguments: {} });
    assert.equal(result.structuredContent.code, 'UNKNOWN_TOOL');
  }
  assert.equal((await client.callTool({ name: 'mind_read_text', arguments: {} })).structuredContent.relativePath, 'permitido.txt');
});

test('dos llamadas concurrentes consumen un único permiso del Motor', async (t) => {
  const { session, connect } = await fixture(t);
  const client = await connect(await session());
  const results = await Promise.all([client.callTool({ name: 'mind_read_text', arguments: {} }), client.callTool({ name: 'mind_read_text', arguments: {} })]);
  assert.equal(results.filter((item) => !item.isError).length, 1);
  assert.equal(results.find((item) => item.isError).structuredContent.code, 'READ_NOT_AUTHORIZED');
});

test('retirar la carpeta antes de la lectura deniega y consume el intento', async (t) => {
  const { session, connect, motor, registered } = await fixture(t);
  const client = await connect(await session());
  await motor.revokeFolder(registered.id);
  const first = await client.callTool({ name: 'mind_read_text', arguments: {} });
  assert.equal(first.structuredContent.code, 'FOLDER_NOT_AUTHORIZED');
  const second = await client.callTool({ name: 'mind_read_text', arguments: {} });
  assert.equal(second.structuredContent.code, 'READ_NOT_AUTHORIZED');
});

test('otra conexión o reinicio del relay no hereda ni renueva la aprobación', async (t) => {
  const { session, connect } = await fixture(t);
  const host = await session();
  const client = await connect(host);
  await assert.rejects(connect(host));
  assert.equal((await client.callTool({ name: 'mind_read_text', arguments: {} })).isError, undefined);
  await client.close();
  await host.close();
  await assert.rejects(connect(host));
});

test('cerrar una sesión no usada revoca el permiso sin leer contenido', async (t) => {
  const { session, connect } = await fixture(t);
  const host = await session();
  await host.close();
  await assert.rejects(connect(host));
});

test('el lanzamiento de Codex es efímero y no pasa rutas de archivos ni administra configuración global', () => {
  const invocation = codexInvocation({ address: 'pipe-ficticio', workdir: development, codexExecutable: 'codex' });
  assert.equal(invocation.command, 'codex');
  assert.ok(invocation.args.includes('--ignore-user-config'));
  assert.ok(invocation.args.includes('--ephemeral'));
  assert.ok(invocation.args.includes('read-only'));
  assert.ok(invocation.args.includes('features.shell_tool=false'));
  assert.ok(invocation.args.includes('features.code_mode.direct_only_tool_namespaces=["mcp__mind"]'));
  assert.ok(invocation.args.includes('mcp_servers.mind.required=true'));
  assert.ok(!invocation.args.some((item) => item.includes('permitido.txt') || item.includes('grantTextRead')));
  assert.ok(!PILOT_PROMPT.includes('ALL_TOOLS') && !PILOT_PROMPT.includes('functions.exec'));
});

test('un CLI que termina con código cero sin leer no cuenta como piloto verificado', async (t) => {
  const { root, motor, registered } = await fixture(t);
  const workdir = path.join(root, 'Agente vacío');
  await fs.mkdir(workdir);
  const fakeCli = path.join(root, 'cli-simulado.js');
  await fs.writeFile(fakeCli, 'process.exit(0);');
  await assert.rejects(runPilot({ motor, folderId: registered.id, relativePath: 'permitido.txt', workdir,
    confirm: async () => true, codexExecutable: fakeCli, stdout: new PassThrough(), stderr: new PassThrough(),
  }), /sin verificar la lectura autorizada/);
});
