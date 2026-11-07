import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { openMotor } from '../src/motor.js';
import { CONVERSATION_INDEX } from '../src/conversations.js';
import { isExcludedFromBackup } from '../src/backup.js';
import { agentFixture, connection } from './helpers/agent-fixture.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mind-conversations-'));
  t.after(async () => {
    assert.equal(path.dirname(root), os.tmpdir());
    assert.ok(path.basename(root).startsWith('mind-conversations-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { base: root, motor: await openMotor({ baseDirectory: root }) };
}
const saved = (motor, important = 'Decisión: café verde. Entrega el viernes.') =>
  motor.saveConversation({ title: 'Ensayo ficticio', important, project: 'Proyecto Ámbar' });

test('conversación sin carpeta, referencias dispersas e ID independiente del chat nativo', async t => {
  const { motor, base } = await fixture(t);
  const item = await motor.saveConversation({ title: 'Compra ficticia', important: 'Aprobadas 23 unidades.',
    externalId: 'chat-declarado', references: [
      { locator: '/escritorio/resumen.md', relation: 'resumen' },
      { locator: '/otra-carpeta/imagen.png', relation: 'multimedia' }] });
  assert.notEqual(item.id, 'chat-declarado');
  assert.equal(item.references.length, 2);
  assert.equal((await motor.listAuthorizedFolders()).length, 0);
  assert.equal((await fs.readdir(base)).some(name => name.endsWith('.sqlite')), false);
  const other = await openMotor({ baseDirectory: base });
  assert.deepEqual(await other.getConversation(item.id), item);
  const changed = await other.saveConversation({ id: item.id, expectedRevision: 1,
    references: [{ locator: '/proyecto/resumen.md' }] });
  assert.equal(changed.id, item.id);
  assert.equal(changed.revision, 2);
  assert.equal(changed.important, item.important);
  await assert.rejects(other.saveConversation({ id: item.id, expectedRevision: 1, important: 'tarde' }),
    { code: 'CONTINUITY_REVISION_CONFLICT' });
});

test('FTS busca contenido y acentos, filtra proyecto y entrega extractos limitados', async t => {
  const { motor } = await fixture(t);
  const first = await saved(motor);
  await motor.saveConversation({ title: 'Otro ensayo', important: 'Café tostado.', project: 'Otro' });
  await motor.recordContinuity({ content: 'café verde no es conversación' });
  const found = await motor.searchConversations({ query: 'CAFE verde', project: 'proyecto ambar' });
  assert.equal(found.total, 1);
  assert.equal(found.results[0].id, first.id);
  assert.match(found.results[0].excerpt, /café verde/);
  assert.equal(Object.hasOwn(found.results[0], 'important'), false);
  assert.equal((await motor.searchConversations({ query: 'inexistente' })).total, 0);
  assert.equal((await motor.searchConversations({ query: '' })).total, 2);
  await assert.rejects(motor.searchConversations({ query: '"""' }), { code: 'INVALID_CONVERSATION_QUERY' });
  // Operadores FTS se tratan como palabras, no como SQL ni sintaxis ejecutable.
  assert.equal((await motor.searchConversations({ query: 'cafe OR inexistente' })).total, 0);
});

test('índice incremental entre instancias, cambios genéricos, importación y reconstrucción', async t => {
  const { motor, base } = await fixture(t);
  const first = await saved(motor, 'Código inicial NUBE.');
  assert.equal((await motor.searchConversations({ query: 'nube' })).index.read, 1);
  const other = await openMotor({ baseDirectory: base });
  assert.equal((await other.searchConversations({ query: 'nube' })).index.read, 0);
  await other.saveConversation({ id: first.id, expectedRevision: 1, important: 'Código vigente SIERRA.' });
  assert.equal((await motor.searchConversations({ query: 'nube' })).total, 0);
  assert.equal((await motor.searchConversations({ query: 'sierra' })).total, 1);
  const raw = await motor.getContinuity(first.id);
  await motor.updateContinuity(first.id, { content: { ...raw.content, important: 'Cambio genérico SOL.' } },
    { expectedRevision: raw.revision });
  assert.equal((await other.searchConversations({ query: 'sol' })).total, 1);
  const pack = await motor.exportContinuity({ ids: [first.id] });
  const second = await fixture(t);
  await second.motor.importContinuity(pack);
  assert.equal((await second.motor.searchConversations({ query: 'sol' })).total, 1);
  await fs.unlink(path.join(base, CONVERSATION_INDEX));
  assert.equal((await motor.searchConversations({ query: 'sol' })).total, 1);
  await other.retireContinuity(first.id);
  assert.equal((await motor.searchConversations({ query: 'sol' })).total, 0);
});

test('registros corruptos no conservan resultados antiguos en el índice', async t => {
  const { motor, base } = await fixture(t);
  const item = await saved(motor, 'Marcador CAMPO.');
  await motor.searchConversations({ query: 'campo' });
  const source = path.join(base, 'continuity-' + item.id + '.json');
  await fs.writeFile(source, 'invalido');
  const result = await motor.searchConversations({ query: 'campo' });
  assert.equal(result.total, 0);
  assert.equal(result.index.omitted, 1);
  await assert.rejects(motor.getConversation(item.id), { code: 'RECORD_CORRUPT' });
  assert.equal(await fs.readFile(source, 'utf8'), 'invalido');
});

test('actualizaciones concurrentes por revisión conservan un solo ganador', async t => {
  const { motor, base } = await fixture(t);
  const item = await saved(motor);
  const module = pathToFileURL(path.resolve('src/motor.js')).href;
  const run = important => new Promise((resolve, reject) => {
    const code = `const {openMotor}=await import(${JSON.stringify(module)});
      const m=await openMotor({baseDirectory:${JSON.stringify(base)}});
      try {await m.saveConversation({id:${JSON.stringify(item.id)},expectedRevision:1,important:${JSON.stringify(important)}});console.log('OK')}
      catch(e){console.log(e.code)}`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { windowsHide: true });
    let out = '';
    child.stdout.on('data', b => out += b);
    child.on('error', reject);
    child.on('exit', code => code ? reject(new Error('child exit ' + code)) : resolve(out.trim()));
  });
  const outcomes = await Promise.all([run('A'),run('B')]);
  assert.equal(outcomes.filter(x => x === 'OK').length, 1);
  assert.equal(outcomes.filter(x => x === 'CONTINUITY_REVISION_CONFLICT').length, 1);
  assert.equal((await motor.getConversation(item.id)).revision, 2);
});

test('validación y límites no escriben conversaciones inválidas', async t => {
  const { motor } = await fixture(t);
  await assert.rejects(motor.saveConversation({ title: 'sin contenido' }), { code: 'INVALID_CONVERSATION' });
  await assert.rejects(motor.saveConversation({ title: 'x', important: 'a'.repeat(65537) }), { code: 'INVALID_CONVERSATION' });
  await assert.rejects(motor.getConversation('../otra'), { code: 'INVALID_CONVERSATION_ID' });
  const generic = await motor.recordContinuity({ content: 'no conversación' });
  await assert.rejects(motor.saveConversation({ id: generic.id, expectedRevision: 1, important: 'x' }),
    { code: 'CONVERSATION_NOT_FOUND' });
  assert.equal((await motor.listContinuityIds()).length, 1);
});

test('el índice no sigue enlaces ni se incluye en el respaldo de los JSON originales', async t => {
  const { motor, base } = await fixture(t);
  await saved(motor);
  const target = path.join(base, 'ajeno.sqlite');
  await fs.writeFile(target, 'no modificar');
  // Hardlink evita necesitar privilegio de symlink en Windows.
  await fs.link(target, path.join(base, CONVERSATION_INDEX));
  await assert.rejects(motor.searchConversations(), { code: 'CONVERSATION_INDEX_UNSAFE' });
  assert.equal(await fs.readFile(target, 'utf8'), 'no modificar');
  assert.equal(isExcludedFromBackup(CONVERSATION_INDEX, { topLevel: true }), true);
  assert.equal(isExcludedFromBackup(CONVERSATION_INDEX + '-journal', { topLevel: true }), true);
  assert.equal(isExcludedFromBackup('continuity-abc.json', { topLevel: true }), false);
});

test('herramientas requieren continuidad y una referencia no concede lectura de originales', async t => {
  const f = await agentFixture(t);
  const session = await f.open();
  const call = f.agent(session, connection());
  assert.equal((await call('conversaciones_buscar', { consulta: 'x' })).code, 'ACCESS_NOT_GRANTED');
  assert.equal((await call('conversacion_guardar', { titulo: 'x', importante: 'x' })).code, 'ACCESS_NOT_GRANTED');
  await session.policy.setContinuity(['leer','registrar'], { channel: 'administracion-local' });
  const created = await call('conversacion_guardar', { titulo: 'Brisa', importante: '23 unidades. Clave ABC.',
    referencias: [{ ubicacion: '/no-autorizado/resumen.md' }] });
  assert.equal(created.isError, false, created.text);
  const item = created.data.conversacion;
  assert.equal((await call('conversaciones_buscar', { consulta: 'clave abc' })).data.total, 1);
  assert.equal((await call('conversacion_leer', { id: item.id })).data.conversacion.importante, item.importante);
  assert.equal((await session.motor.listAuthorizedFolders()).length, 0);
  await session.policy.setContinuity(['leer'], { channel: 'administracion-local' });
  assert.equal((await call('conversacion_guardar', { id: item.id, revision: 1, importante: 'tarde' })).code, 'ACCESS_NOT_GRANTED');
  assert.equal((await call('conversacion_leer', { id: item.id })).isError, false);
  await session.policy.setContinuity([], { channel: 'administracion-local' });
  assert.equal((await call('conversacion_leer', { id: item.id })).code, 'ACCESS_NOT_GRANTED');
});

test('MCP real expone las herramientas, persiste entre procesos y recupera solo lo importante', { timeout: 30000 }, async t => {
  const { startMcp } = await import('./helpers/mcp-client.js');
  const { base } = await fixture(t);
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'mind-conversations-work-'));
  const clients = [];
  t.after(async () => {
    for (const client of clients) { if (client.child.exitCode === null) await client.close(); }
    assert.equal(path.dirname(workspace), os.tmpdir());
    assert.ok(path.basename(workspace).startsWith('mind-conversations-work-'));
    await fs.rm(workspace, { recursive: true, force: true });
  });
  const start = () => {
    const client = startMcp({ args: ['--base',base,'--carpeta',workspace], capabilities: {} });
    clients.push(client); return client;
  };
  const first = start();
  const init = await first.initialize();
  assert.match(init.result.instructions, /conversacion_guardar/);
  const tools = await first.request('tools/list');
  assert.ok(tools.result.tools.some(tool => tool.name === 'conversaciones_buscar'));
  const created = await first.call('conversacion_guardar', { titulo: 'MCP ficticio',
    importante: 'Confirmado: código SIERRA, 23 unidades.', referencias: [{ ubicacion: '/recurso/no-abierto.md' }] });
  assert.equal(created.isError, false, created.text);
  const id = created.data.conversacion.id;
  assert.equal((await first.close()).code, 0);
  const second = start(); await second.initialize();
  const found = await second.call('conversaciones_buscar', { consulta: 'sierra' });
  assert.equal(found.data.total, 1, found.text);
  assert.equal(found.data.conversaciones[0].id, id);
  assert.equal(Object.hasOwn(found.data.conversaciones[0], 'importante'), false);
  assert.equal((await second.call('conversacion_leer', { id })).data.conversacion.importante,
    'Confirmado: código SIERRA, 23 unidades.');
  assert.equal((await second.call('conversacion_guardar', { id, revision: 1, importante: 'Vigente: código MAR.' })).isError, false);
  assert.equal((await second.call('conversaciones_buscar', { consulta: 'sierra' })).data.total, 0);
  assert.equal((await second.call('conversaciones_buscar', { consulta: 'mar' })).data.total, 1);
});
