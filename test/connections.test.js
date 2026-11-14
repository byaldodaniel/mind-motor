import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  createConnectionRegistry, quietness, describeActivity, connectionSummary, announcePresence, listPresence,
  connectionsDirectory, clientLabel, newConnectionId,
} from '../src/connections.js';
import { parseWorkspaceHeader } from '../src/motor-central.js';

test('el registro agrupa las sesiones del mismo chat y distingue trabajo, formulario y reposo', () => {
  let clock = 1_000_000;
  const registry = createConnectionRegistry({ now: () => clock });
  const chat = newConnectionId();
  registry.open('s1', { conexion: chat, transporte: 'puente', carpeta: '/p' });
  registry.open('s2', { conexion: chat, transporte: 'puente', carpeta: '/p' }); // reabierta tras reiniciar el Motor
  registry.open('h1', { conexion: null, transporte: 'http', carpeta: null });
  registry.identify('s1', { name: 'codex', version: '0.169.0' }, { roots: { listChanged: true } });
  registry.identify('h1', { name: 'otro', version: '1' }, {});
  assert.equal(registry.list().length, 2);
  assert.equal(registry.list().find((entry) => entry.conexion === chat).raices, true);
  assert.equal(registry.list().find((entry) => entry.transporte === 'http').raices, false);
  assert.deepEqual(registry.list().find((entry) => entry.conexion === chat).cliente, { nombre: 'codex', version: '0.169.0' });

  const end = registry.begin('s2');
  assert.equal(describeActivity(registry.list().find((entry) => entry.conexion === chat), { at: clock }), 'trabajando');
  end(); end(); // cerrar dos veces no descuenta de más
  clock += 1_000;
  assert.equal(describeActivity(registry.list().find((entry) => entry.conexion === chat), { at: clock }), 'activa');
  clock += 31_000;
  assert.equal(describeActivity(registry.list().find((entry) => entry.conexion === chat), { at: clock }), 'inactiva');

  const answered = registry.asking('h1');
  assert.equal(describeActivity(registry.list().find((entry) => entry.transporte === 'http'), { at: clock }), 'esperando-al-usuario');
  answered();
  registry.close('h1');
  assert.equal(registry.list().length, 1);
});

test('la regla de quietud dice qué chat la impide y cuánto falta', () => {
  const at = 100_000;
  const base = { conexion: 'c', cliente: { nombre: 'claude-code', version: '2' }, carpeta: '/x', transporte: 'puente', desde: 0, enCurso: 0, formularios: 0 };
  assert.deepEqual(quietness([{ ...base, ultimaPeticion: at - 40_000 }], { at }), { quieto: true, impiden: [] });
  const recent = quietness([{ ...base, ultimaPeticion: at - 10_000 }], { at });
  assert.equal(recent.quieto, false);
  assert.equal(recent.impiden[0].actividad, 'activa');
  assert.equal(recent.impiden[0].libre_en_ms, 20_000);
  assert.equal(quietness([{ ...base, formularios: 1, ultimaPeticion: 0 }], { at }).impiden[0].actividad, 'esperando-al-usuario');
  // Trabajo por /rpc (consola, agente sin MCP) también impide.
  assert.equal(quietness([], { at, activeWork: 1 }).quieto, false);
  // La propia consulta no se cuenta a sí misma.
  const registry = createConnectionRegistry({ now: () => at });
  registry.open('yo', { conexion: null, transporte: 'http' });
  registry.begin('yo');
  assert.equal(registry.list({ asking: 'yo' })[0].enCurso, 0);
});

test('el nombre del cliente se limpia antes de mostrarse', () => {
  assert.deepEqual(clientLabel({ name: 'Claude Code', version: '2.1.321' }), { nombre: 'Claude Code', version: '2.1.321' });
  assert.deepEqual(clientLabel({ name: 'x\n\u001b[31mrojo', version: 42 }), { nombre: null, version: null });
  assert.deepEqual(clientLabel(null), { nombre: null, version: null });
});

test('la cabecera de ámbito lleva el chat de forma compatible', () => {
  const id = newConnectionId();
  const encode = (value) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  assert.equal(parseWorkspaceHeader(encode({ cwd: '/a', paths: [], conexion: id })).conexion, id);
  assert.equal(parseWorkspaceHeader(encode({ cwd: '/a', paths: [], conexion: '../../x' })).conexion, null);
  assert.equal(parseWorkspaceHeader(encode({ cwd: '/a', paths: [] })).declared, true, 'un puente anterior sigue reconociéndose como puente');
  assert.equal(parseWorkspaceHeader(undefined).declared, false);
});

test('presencia: un puente vivo se ve con el Motor apagado y uno muerto se retira', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mind-presencia-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const layout = { product: true, installationStateDirectory: path.join(root, 'Sistema', 'Estado'), baseDirectory: path.join(root, 'Sistema', 'Base') };
  assert.equal(connectionsDirectory(layout), path.join(root, 'Sistema', 'Estado', 'conexiones'));
  const mine = await announcePresence({ layout, id: newConnectionId(), cwd: '/proyecto' });
  await mine.update({ cliente: { nombre: 'codex', version: '1' } });

  // Un puente que murió sin despedirse.
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((resolve) => child.once('exit', resolve));
  const dead = await announcePresence({ layout, id: newConnectionId(), pid: child.pid });

  const listed = await listPresence(layout);
  assert.deepEqual(listed.map((entry) => entry.carpeta), ['/proyecto']);
  assert.deepEqual(listed[0].cliente, { nombre: 'codex', version: '1' });
  await assert.rejects(fs.stat(dead.file), { code: 'ENOENT' });

  const summary = connectionSummary([], listed);
  assert.equal(summary[0].actividad, 'sin-sesion');
  assert.equal(summary[0].transporte, 'puente');
  await mine.remove();
  assert.deepEqual(await listPresence(layout), []);
});

test('en desarrollo la presencia vive fuera de la Base, en el temporal', () => {
  const directory = connectionsDirectory({ product: false, baseDirectory: path.join(os.tmpdir(), 'base-x') });
  assert.equal(path.dirname(directory), os.tmpdir());
});
