import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openMotor } from '../src/motor.js';
import { agentFixture, connection } from './helpers/agent-fixture.js';

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'mind-conversation-preferences-'));
  t.after(async () => {
    assert.equal(path.dirname(base), os.tmpdir());
    assert.ok(path.basename(base).startsWith('mind-conversation-preferences-'));
    await fs.rm(base, { recursive: true, force: true });
  });
  return { base, motor: await openMotor({ baseDirectory: base }) };
}
test('predeterminado esencial sin configuración y persistencia con control de revisión', async t => {
  const { motor, base } = await fixture(t);
  const initial = await motor.getConversationPreferences();
  assert.equal(initial.revision, 0);
  assert.equal(initial.effective.mode, 'esencial');
  assert.equal(initial.effective.automatic, true);
  assert.match(initial.effective.guidance, /decisiones/i);
  await motor.configureConversationPreferences({ expectedRevision: 0, preferences: { mode: 'detallado', rules: 'Conservar cifras.' } });
  const other = await openMotor({ baseDirectory: base });
  assert.equal((await other.getConversationPreferences()).effective.mode, 'detallado');
  await assert.rejects(other.configureConversationPreferences({ expectedRevision: 0, preferences: { mode: 'manual', rules: '' } }),
    { code: 'CONVERSATION_PREFERENCES_CONFLICT' });
  const item = await other.saveConversation({ title: 'Prueba', important: 'Resultado ficticio.' });
  assert.equal((await other.getConversationPreferences(item.id)).inherited, true);
});
test('modo manual rechaza guardado automático nuevo y actualizado, permite petición expresa', async t => {
  const { motor } = await fixture(t);
  const item = await motor.saveConversation({ title: 'Prueba', important: 'Conservar esto.' });
  await motor.configureConversationPreferences({ expectedRevision: 0, preferences: { mode: 'manual', rules: '' } });
  const count = (await motor.listContinuityIds()).length;
  await assert.rejects(motor.saveConversation({ title: 'No escribir', important: 'No guardar.' }), { code: 'CONVERSATION_MANUAL_ONLY' });
  await assert.rejects(motor.saveConversation({ id: item.id, expectedRevision: 1, important: 'No guardar.' }), { code: 'CONVERSATION_MANUAL_ONLY' });
  assert.equal((await motor.listContinuityIds()).length, count);
  assert.equal((await motor.getConversation(item.id)).important, 'Conservar esto.');
  const next = await motor.saveConversation({ id: item.id, expectedRevision: 1, important: 'Petición expresa.', explicit: true });
  assert.equal(next.revision, 2);
});
test('excepción por conversación, reglas propias, herencia restaurada y portabilidad', async t => {
  const { motor } = await fixture(t);
  const item = await motor.saveConversation({ title: 'Prueba', important: 'Conservar esto.' });
  await motor.configureConversationPreferences({ id: item.id, expectedRevision: 1, preferences: { mode: 'personalizado', rules: 'Solo decisiones y cifras.' } });
  let effective = await motor.getConversationPreferences(item.id);
  assert.equal(effective.inherited, false);
  assert.equal(effective.effective.rules, 'Solo decisiones y cifras.');
  assert.equal((await motor.getConversation(item.id)).important, 'Conservar esto.');
  await motor.configureConversationPreferences({ expectedRevision: 0, preferences: { mode: 'manual', rules: '' } });
  assert.equal((await motor.getConversationPreferences(item.id)).effective.mode, 'personalizado');
  const other = await fixture(t);
  await other.motor.importContinuity(await motor.exportContinuity({ ids: [item.id] }));
  assert.equal((await other.motor.getConversationPreferences(item.id)).effective.rules, 'Solo decisiones y cifras.');
  await motor.configureConversationPreferences({ id: item.id, expectedRevision: 2, preferences: null });
  effective = await motor.getConversationPreferences(item.id);
  assert.equal(effective.inherited, true);
  assert.equal(effective.effective.mode, 'manual');
  await assert.rejects(motor.saveConversation({ id: item.id, expectedRevision: 3, important: 'No guardar.' }), { code: 'CONVERSATION_MANUAL_ONLY' });
});
test('concurrencia de preferencias: un ganador; reglas inválidas no se escriben', async t => {
  const { motor, base } = await fixture(t);
  const other = await openMotor({ baseDirectory: base });
  const result = await Promise.allSettled([motor,other].map(m => m.configureConversationPreferences({ expectedRevision: 0, preferences: { mode: 'manual', rules: '' } })));
  assert.equal(result.filter(x => x.status === 'fulfilled').length, 1);
  await assert.rejects(motor.configureConversationPreferences({ expectedRevision: 1, preferences: { mode: 'personalizado', rules: '' } }), { code: 'INVALID_CONVERSATION_PREFERENCES' });
  assert.equal((await motor.getConversationPreferences()).revision, 1);
});
test('MCP aplica permisos, manual y excepciones sin cambiar contenido', async t => {
  const f = await agentFixture(t);
  const session = await f.open();
  const call = f.agent(session, connection());
  assert.equal((await call('conversacion_preferencias')).code, 'ACCESS_NOT_GRANTED');
  await session.policy.setContinuity(['leer','registrar'], { channel: 'administracion-local' });
  const work = await session.motor.authorizeFolder(f.folder);
  await session.policy.set(work.id,['encontrar','leer','escribir','organizar'],{channel:'administracion-local'});
  assert.equal((await call('conversacion_preferencias')).data.efectiva.modo, 'esencial');
  assert.equal((await call('conversacion_configurar', { revision: 0, preferencias: { modo: 'manual' } })).isError, false);
  assert.equal((await call('conversacion_guardar', { titulo: 'No guardar', importante: 'No.' })).code, 'CONVERSATION_MANUAL_ONLY');
  const saved = await call('conversacion_guardar', { titulo: 'Expreso', importante: '23 unidades.', solicitado: true });
  assert.equal(saved.isError, false, saved.text);
  await session.policy.setContinuity(['leer'], { channel: 'administracion-local' });
  assert.equal((await call('conversacion_configurar', { revision: 1, preferencias: { modo: 'esencial' } })).code, 'ACCESS_NOT_GRANTED');
});
