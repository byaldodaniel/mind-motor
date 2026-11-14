import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { takeNotice, describeUpdate, postponeUpdate, decisionsFile } from '../src/update-assistant.js';
import { createUpdateTools } from '../src/tools/actualizacion.js';
import { writeUpdateState } from '../src/update-state.js';
import { productPaths, resolveLayout } from '../src/layout.js';
import { startCentralMotor } from '../src/motor-central.js';
import { BASE_MARKER } from '../src/base-format.js';
import { classifyToolPriority, QUEUE_PRIORITY } from '../src/smart-queue.js';

const DAY = 24 * 60 * 60_000;
const AT = Date.parse('2026-11-14T12:00:00.000Z');
const motorDirectory = fileURLToPath(new URL('..', import.meta.url));

async function fixture(t, { importance = 'normal', incoming = 2, current = 2 } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mind-update-assistant-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const manifest = { format: 'mind-product', version: 1, mindVersion: '1.0.4',
    packageRevision: 1, layoutVersion: 2, updateProtocolVersion: 2 };
  const layout = { product: true, root, manifest, ...productPaths(root, manifest), motorDirectory,
    pythonExecutable: process.env.MIND_TEST_BUNDLED_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3'), protectedDirectories: [root] };
  await fs.mkdir(layout.baseDirectory, { recursive: true });
  if (current !== null) await fs.writeFile(path.join(layout.baseDirectory, BASE_MARKER), JSON.stringify({
    format: 'mind-base', version: current, baseId: '11111111-2222-4333-8444-555555555555', createdAt: '2026-01-01T00:00:00.000Z',
  }));
  const state = {
    phase: 'disponible', release: { ...manifest, mindVersion: '1.0.5' },
    lastCheckedAt: new Date(AT).toISOString(),
    package: { bytes: 100, sha256: 'a'.repeat(64) },
    novedades: { nombre: 'Actualización asistida', resumen: 'El usuario decide cuándo instalar.',
      cambios: ['Aviso y consentimiento'], importancia: importance,
      impacto_datos: { base: 'sin-cambios', detalle: 'Conserva los datos.' },
      comprobado: { baseFormatVersion: incoming, paqueteBytes: 100, programaBytes: 200, gruposCambiados: ['motor'] } },
  };
  const write = () => writeUpdateState(root, state);
  await write();
  return { root, layout, state, write };
}

test('avisa una vez por conexión y entrega, persiste la decisión y distingue conversaciones', async t => {
  const f = await fixture(t);
  const call = conexion => takeNotice({ layout: f.layout, conexion, now: () => AT });
  const first = await call('chat-a');
  assert.equal(first.texto, 'Hay una nueva versión de Mind (1.0.5) (Actualización asistida)');
  assert.equal(await call('chat-a'), null);
  assert.ok(await call('chat-b'));
  const stored = JSON.parse(await fs.readFile(decisionsFile(f.layout), 'utf8'));
  assert.equal(stored.avisadas['chat-a'].entrega, '1.0.5-r1');
  f.state.release.packageRevision = 2;
  await f.write();
  assert.ok(await call('chat-a'), 'una revisión nueva tiene su propio aviso');
  assert.equal(await call('chat-a'), null);
});

test('las llamadas simultáneas de la misma conexión solo toman un aviso', async t => {
  const f = await fixture(t);
  const results = await Promise.all(Array.from({ length: 8 }, () => takeNotice({ layout: f.layout, conexion: 'chat', now: () => AT })));
  assert.equal(results.filter(Boolean).length, 1);
});

test('sin identificador de conexión repite como máximo cada doce horas', async t => {
  const f = await fixture(t);
  assert.ok(await takeNotice({ layout: f.layout, now: () => AT }));
  assert.equal(await takeNotice({ layout: f.layout, now: () => AT + DAY / 2 - 1 }), null);
  assert.ok(await takeNotice({ layout: f.layout, now: () => AT + DAY / 2 }));
});

test('posponer 1, 3 o 7 días silencia todos los chats y al vencer vuelve a avisar una vez', async t => {
  for (const dias of [1, 3, 7]) {
    const f = await fixture(t);
    await takeNotice({ layout: f.layout, conexion: 'chat-visto', now: () => AT });
    const result = await postponeUpdate({ layout: f.layout, dias, now: () => AT });
    assert.equal(result.hasta, new Date(AT + dias * DAY).toISOString());
    assert.equal(await takeNotice({ layout: f.layout, conexion: 'chat-nuevo', now: () => AT + dias * DAY - 1 }), null);
    assert.equal(await takeNotice({ layout: f.layout, conexion: 'chat-visto', now: () => AT + dias * DAY - 1 }), null);
    assert.ok(await takeNotice({ layout: f.layout, conexion: 'chat-visto', now: () => AT + dias * DAY }));
    assert.equal(await takeNotice({ layout: f.layout, conexion: 'chat-visto', now: () => AT + dias * DAY }), null);
  }
});

test('una entrega de seguridad se pospone como máximo un día', async t => {
  const f = await fixture(t, { importance: 'seguridad' });
  const result = await postponeUpdate({ layout: f.layout, dias: 7, now: () => AT });
  assert.equal(result.hasta, new Date(AT + DAY).toISOString());
  assert.match(result.nota, /seguridad/);
  assert.ok(await takeNotice({ layout: f.layout, conexion: 'chat', now: () => AT + DAY }));
});

test('posponer una entrega no silencia otra versión ni admite plazos ajenos', async t => {
  const f = await fixture(t);
  await assert.rejects(postponeUpdate({ layout: f.layout, dias: 2 }), { code: 'INVALID_ARGUMENTS' });
  await postponeUpdate({ layout: f.layout, dias: 7, now: () => AT });
  f.state.release.mindVersion = '1.0.6';
  await f.write();
  assert.ok(await takeNotice({ layout: f.layout, conexion: 'chat', now: () => AT + 1 }));
});

test('sin entrega nueva no avisa ni permite posponer; desarrollo tampoco avisa', async t => {
  const f = await fixture(t);
  for (const phase of ['al-dia', 'actualizada', 'fallida', 'instalando']) {
    f.state.phase = phase;
    await f.write();
    assert.equal(await takeNotice({ layout: f.layout, conexion: 'chat' }), null);
    assert.equal((await describeUpdate({ layout: f.layout })).disponible, null);
    await assert.rejects(postponeUpdate({ layout: f.layout }), { code: 'UPDATE_NOT_AVAILABLE' });
  }
  f.state.phase = 'disponible';
  f.state.release = f.layout.manifest;
  await f.write();
  assert.equal(await takeNotice({ layout: f.layout, conexion: 'chat' }), null);
  assert.equal(await takeNotice({ layout: { ...f.layout, product: false } }), null);
  assert.equal((await describeUpdate({ layout: { ...f.layout, product: false } })).estado, 'no-aplica');
});

test('un estado o decisiones dañados no interrumpen el trabajo ni provocan un aviso falso', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.dirname(decisionsFile(f.layout)), { recursive: true });
  await fs.writeFile(decisionsFile(f.layout), '{dañado');
  assert.ok(await takeNotice({ layout: f.layout, conexion: 'chat' }));
  await fs.writeFile(path.join(f.root, 'Sistema', 'Actualizaciones', 'estado.json'), '{dañado');
  assert.equal(await takeNotice({ layout: f.layout, conexion: 'otro' }), null);
  const description = await describeUpdate({ layout: f.layout });
  assert.equal(description.fase, 'estado-no-verificable');
  assert.equal(description.ultimo_error.codigo, 'UPDATE_STATE_INVALID');
});

test('la descripción cruza el formato real de Base con el firmado y separa lo declarado', async t => {
  for (const [current, incoming, effect] of [[2, 2, 'sin-cambios'], [1, 2, 'migracion'], [2, 1, 'incompatible'], [null, 2, 'desconocido'], [2, null, 'desconocido']]) {
    const f = await fixture(t, { current, incoming });
    const description = await describeUpdate({ layout: f.layout, statfs: async () => ({ bavail: 1_000_000, bsize: 4096 }), now: () => AT });
    assert.equal(description.comprobado_en_este_equipo.base.efecto, effect);
    assert.equal(description.comprobado_en_este_equipo.base.formato_actual, current);
    assert.equal(description.comprobado_en_este_equipo.base.formato_entrega, incoming);
    assert.deepEqual(description.disponible.impacto_declarado, f.state.novedades.impacto_datos);
    assert.equal(description.comprobado_en_este_equipo.espacio.suficiente, true);
    assert.equal(description.comprobado_en_este_equipo.descarga_bytes, 100);
  }
});

test('la descripción informa falta de espacio, espacio desconocido, último error y aplazamiento', async t => {
  const f = await fixture(t);
  f.state.lastError = { code: 'ENOSPC', kind: 'espacio', message: 'Espacio insuficiente' };
  await f.write();
  const postponed = await postponeUpdate({ layout: f.layout, dias: 3, now: () => AT });
  const description = await describeUpdate({ layout: f.layout, statfs: async () => ({ bavail: 0, bsize: 4096 }), now: () => AT });
  assert.equal(description.comprobado_en_este_equipo.espacio.suficiente, false);
  assert.equal(description.pospuesta_hasta, postponed.hasta);
  assert.equal(description.ultimo_error.codigo, 'ENOSPC');
  const unknown = await describeUpdate({ layout: f.layout, statfs: async () => { throw new Error('No disponible'); }, now: () => AT + 4 * DAY });
  assert.equal(unknown.comprobado_en_este_equipo.espacio.suficiente, null);
  assert.equal(unknown.pospuesta_hasta, null);
});

test('las herramientas de consultar y posponer validan argumentos y no alteran el paquete', async t => {
  const f = await fixture(t);
  const tools = createUpdateTools({ session: { layout: f.layout } });
  const consult = tools.find(item => item.definition.name === 'actualizacion_consultar');
  const postpone = tools.find(item => item.definition.name === 'actualizacion_posponer');
  const before = await fs.readFile(path.join(f.root, 'Sistema', 'Actualizaciones', 'estado.json'), 'utf8');
  assert.equal(consult.definition.annotations.readOnlyHint, true);
  assert.equal(classifyToolPriority('actualizacion_consultar'), QUEUE_PRIORITY.READ);
  assert.equal((await consult.handler({})).disponible.mindVersion, '1.0.5');
  await assert.rejects(consult.handler({ descargar: true }), { code: 'INVALID_ARGUMENTS' });
  await assert.rejects(postpone.handler({ dias: 0 }), { code: 'INVALID_ARGUMENTS' });
  await assert.rejects(postpone.handler({ dias: '3' }), { code: 'INVALID_ARGUMENTS' });
  await assert.rejects(postpone.handler({ confirmar: true }), { code: 'INVALID_ARGUMENTS' });
  assert.equal((await postpone.handler({})).estado, 'pospuesta');
  assert.equal(await fs.readFile(path.join(f.root, 'Sistema', 'Actualizaciones', 'estado.json'), 'utf8'), before);
  await assert.rejects(fs.stat(path.join(f.root, 'Sistema', 'Actualizaciones', 'descargas')), { code: 'ENOENT' });
});

function post(motor, endpoint, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: motor.port, path: endpoint, method: 'POST', agent: false,
      headers: { Host: '127.0.0.1:' + motor.port, Authorization: 'Bearer ' + motor.token,
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, data: JSON.parse(Buffer.concat(chunks).toString() || 'null') }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

test('inicio por RPC entrega el aviso una vez; las herramientas funcionan sin MCP', async t => {
  const f = await fixture(t);
  const development = await resolveLayout({ base: f.layout.baseDirectory });
  const motor = await startCentralMotor({ layout: { ...development, ...f.layout }, preferredPort: 0, observe: false, discoverDelayMs: 60_000 });
  t.after(() => motor.stop('test-end'));
  const first = await post(motor, '/rpc', { accion: 'inicio' });
  assert.equal(first.status, 200);
  assert.equal(first.data.aviso_actualizacion.version, '1.0.5');
  assert.equal(first.data.destinos.aviso_actualizacion, undefined);
  assert.equal((await post(motor, '/rpc', { accion: 'inicio' })).data.aviso_actualizacion, undefined);
  const consult = await post(motor, '/rpc', { accion: 'herramienta', tool: 'actualizacion_consultar', args: {} });
  assert.equal(consult.data.value.disponible.mindVersion, '1.0.5');
  const postponed = await post(motor, '/rpc', { accion: 'herramienta', tool: 'actualizacion_posponer', args: { dias: 3 } });
  assert.equal(postponed.data.value.estado, 'pospuesta');
});

test('MCP distingue chats por HTTP directo y conserva un aviso al reconectar el mismo puente', async t => {
  const f = await fixture(t);
  const development = await resolveLayout({ base: f.layout.baseDirectory });
  const motor = await startCentralMotor({ layout: { ...development, ...f.layout }, preferredPort: 0, observe: false, discoverDelayMs: 60_000 });
  t.after(() => motor.stop('test-end'));
  async function connect(conexion = null) {
    const headers = conexion ? { 'X-Mind-Workspace': Buffer.from(JSON.stringify({ conexion, paths: [] })).toString('base64url') } : {};
    const initialized = await post(motor, '/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'cliente-ficticio', version: '1' } } }, headers);
    assert.equal(initialized.status, 200);
    const sessionHeaders = { 'Mcp-Session-Id': initialized.headers['mcp-session-id'] };
    await post(motor, '/mcp', { jsonrpc: '2.0', method: 'notifications/initialized' }, sessionHeaders);
    return async () => {
      const result = await post(motor, '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'destinos_consultar', arguments: {} } }, sessionHeaders);
      assert.equal(result.status, 200);
      return result.data.result.structuredContent.aviso_actualizacion;
    };
  }
  const directA = await connect();
  assert.ok(await directA());
  assert.equal(await directA(), undefined);
  assert.ok(await (await connect())(), 'cada sesión directa es un chat distinto');
  const bridge = '11111111-2222-4333-8444-555555555555';
  assert.ok(await (await connect(bridge))());
  assert.equal(await (await connect(bridge))(), undefined, 'reinicializar el puente no repite el aviso');
});
