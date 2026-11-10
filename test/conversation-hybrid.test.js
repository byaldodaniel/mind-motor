import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openMotor } from '../src/motor.js';
import { SEMANTIC_DIMENSIONS } from '../src/semantic-encoder.js';

async function fixture(t, encoder) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'mind-conversation-hybrid-'));
  let motor;
  t.after(async () => {
    await motor?.closeConversationSearch();
    assert.equal(path.dirname(base), os.tmpdir());
    assert.ok(path.basename(base).startsWith('mind-conversation-hybrid-'));
    await fs.rm(base, { recursive: true, force: true });
  });
  motor = await openMotor({ baseDirectory: base, semanticEncoder: encoder });
  return { base, motor };
}
// Dobles deterministas para invariantes del índice. La calidad semántica real se
// comprueba por separado con el modelo fijado y el corpus de evaluación.
function encoder() {
  const batches = [];
  return { model: 'test-v1', available: async () => true, close() {}, batches,
    async embed(texts) { batches.push(texts); return texts.map(text => {
      const vector = Array(SEMANTIC_DIMENSIONS).fill(0);
      vector[/amarillo|color del sol/.test(text) ? 0 : 1] = 1;
      return vector;
    }); } };
}
test('híbrida suma coincidencias semánticas, filtra proyecto, indexa cambios y conserva extractos', async t => {
  const fake = encoder();
  const { motor, base } = await fixture(t, fake);
  const first = await motor.saveConversation({ title: 'Paleta', important: 'Elegimos amarillo.', project: 'Ámbar' });
  await motor.saveConversation({ title: 'Otro', important: 'También amarillo.', project: 'Otro' });
  assert.equal((await motor.searchConversations({ query: 'color del sol', mode: 'palabras' })).total, 0);
  await motor.prepareConversationSearch();
  const result = await motor.searchConversations({ query: 'color del sol', project: 'ambar' });
  assert.equal(result.semantic.status, 'activa');
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].id, first.id);
  assert.equal(result.results[0].match, 'significado');
  assert.equal(result.index.read, 0);
  assert.equal((await motor.searchConversations({ query: 'color del sol' })).semantic.embedded, 0);
  const second = await openMotor({ baseDirectory: base, semanticEncoder: fake });
  await second.saveConversation({ id: first.id, expectedRevision: 1, important: 'Elegimos azul.' });
  assert.equal((await motor.searchConversations({ query: 'color del sol', project: 'ambar' })).total, 0);
  await second.retireContinuity(first.id);
  assert.equal((await motor.searchConversations({ query: 'color del sol', project: 'ambar' })).total, 0);
});
test('modelo cambiado reconstruye vectores; fallo degrada explícitamente y conserva palabras', async t => {
  const fake = encoder();
  const { motor, base } = await fixture(t, fake);
  await motor.saveConversation({ title: 'Prueba', important: 'Código SOL742.' });
  await motor.prepareConversationSearch();
  await motor.searchConversations({ query: 'SOL742' });
  const newer = encoder(); newer.model = 'test-v2';
  const other = await openMotor({ baseDirectory: base, semanticEncoder: newer });
  await other.prepareConversationSearch();
  assert.ok(newer.batches.length > 0);
  const broken = await openMotor({ baseDirectory: base, semanticEncoder: { model: 'broken', available: async () => true,
    embed: async () => { throw new Error('modelo roto'); }, close() {} } });
  await broken.prepareConversationSearch();
  const result = await broken.searchConversations({ query: 'SOL742' });
  await broken.closeConversationSearch();
  assert.equal(result.semantic.status, 'fallo');
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].match, 'palabras');
});
test('códigos exactos tienen prioridad y consulta vacía no carga modelo', async t => {
  const fake = encoder();
  const { motor } = await fixture(t, fake);
  const target = await motor.saveConversation({ title: 'Clave', important: 'Código BRISA826.' });
  for (let i=0;i<5;i++) await motor.saveConversation({ title: 'Auxiliar', important: 'Otra conversación.' });
  await motor.searchConversations();
  assert.equal(fake.batches.length, 0);
  await motor.prepareConversationSearch();
  const result = await motor.searchConversations({ query: 'BRISA826' });
  assert.equal(result.results[0].id, target.id);
});

test('una inferencia pendiente no bloquea la búsqueda y no publica revisiones obsoletas', async t => {
  const fake = encoder();
  let release;
  const gate = new Promise(resolve => release = resolve);
  const embed = fake.embed;
  let entered;
  const started = new Promise(resolve => entered = resolve);
  fake.embed = async texts => { entered(); await gate; return embed(texts); };
  const { motor } = await fixture(t, fake);
  const item = await motor.saveConversation({title:'Paleta',important:'Elegimos amarillo.'});
  const first = await motor.searchConversations({query:'amarillo'});
  assert.equal(first.semantic.status,'preparando');
  assert.equal(first.results[0].id,item.id);
  await started;
  // Este await finalizaría solo al liberar gate si la inferencia retuviese el bloqueo.
  const read = await motor.searchConversations({query:'amarillo',mode:'palabras'});
  assert.equal(read.results[0].id,item.id);
  await motor.saveConversation({id:item.id,expectedRevision:1,important:'Elegimos azul.'});
  release();
  assert.equal((await motor.prepareConversationSearch()).error,null);
  assert.equal((await motor.searchConversations({query:'color del sol'})).total,0);
});
