import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { RUNS } from './runs.mjs';
import { createAgentTools } from '../../src/agent-tools.js';
import { resolveLayout } from '../../src/layout.js';
import { openMotor } from '../../src/motor.js';
import { createSemanticEncoder } from '../../src/semantic-encoder.js';
import { openSession } from '../../src/session.js';

const nativeMeaningExecutable = process.env.MIND_TEST_NATIVE_MEANING || process.env.MIND_NATIVE_EXE;
const e5Directory = process.env.MIND_TEST_E5_DIRECTORY;
const enabled = { skip: !nativeMeaningExecutable && 'Indica MIND_TEST_NATIVE_MEANING o MIND_NATIVE_EXE' };
const independentProject = 'Validación independiente';

// Consultas fijas de examples/evaluar-busqueda-hibrida.mjs, sin ajuste posterior.
const heldout = [
  ['Recuperación de cuenta','Si olvida su contraseña, solicite un enlace de restablecimiento por correo electrónico.','¿Cómo vuelvo a entrar si no recuerdo la clave de acceso?'],
  ['Plantas','Regar las macetas dos veces por semana y mantenerlas lejos del sol directo.','¿Con qué frecuencia debo echar agua a las plantas?'],
  ['Batería','Conectar el cargador cuando la batería baje del veinte por ciento.','¿Cuándo debería enchufar el dispositivo para recargarlo?'],
  ['Comida del encuentro','La cena del evento debe ofrecer un menú vegetariano sin carne ni pescado.','¿Qué comida serviremos a quienes no comen animales?'],
  ['Atención al cliente','El servicio de soporte atiende de lunes a viernes entre las nueve y las dieciocho horas.','¿En qué horario puedo contactar al equipo de ayuda?'],
  ['Traducción','Preparar la documentación en español e inglés para los dos grupos de lectores.','¿En qué idiomas necesitamos escribir las instrucciones?'],
  ['Imprenta','Imprimir el documento en papel A4 y orientación horizontal.','¿Qué tamaño de hoja y disposición usamos al imprimir?'],
  ['Viaje','El tren sale a las ocho desde la estación central. Llegar quince minutos antes.','¿A qué hora y desde dónde parte el ferrocarril?'],
  ['Video','La pieza audiovisual tendrá formato panorámico 16:9 y resolución de 1920 por 1080 píxeles.','¿Qué proporción y calidad tendrá la película que vamos a crear?'],
  ['Factura','Enviar al comprador la factura en PDF adjunta al correo después de confirmar el pago.','¿Cómo entregamos el comprobante de compra una vez abonado?'],
];
const negatives = ['¿Cuál es la temperatura de la superficie de Neptuno?', '¿Cómo se reproducen las medusas del Ártico?',
  '¿Qué estructura tiene el ADN de una mariposa?', '¿Cuántos volcanes activos hay en Venus?'];

const evidence = [
  'enlace de restablecimiento', 'dos veces por semana', 'veinte por ciento', 'menú vegetariano',
  'de lunes a viernes entre las nueve y las dieciocho horas', 'en español e inglés',
  'papel A4 y orientación horizontal', 'a las ocho desde la estación central',
  '16:9 y resolución de 1920 por 1080', 'la factura en PDF',
];

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(RUNS, 'mind-significado-'));
  const cleanup = [];
  t.after(async () => {
    try {
      for (const close of cleanup.reverse()) await close();
    } finally {
      assert.equal(await fs.realpath(base), base);
      assert.equal(path.dirname(base), RUNS);
      assert.ok(path.basename(base).startsWith('mind-significado-'));
      await fs.rm(base, { recursive: true, force: true });
    }
  });
  return {
    base,
    cleanup,
    async motor(options = {}) {
      const motor = await openMotor({ baseDirectory: base, ...options });
      cleanup.push(() => motor.closeConversationSearch());
      return motor;
    },
  };
}

function forbiddenEncoder() {
  let attempts = 0;
  const unexpected = () => {
    attempts++;
    throw new Error('La prueba del candidato no debe invocar E5.');
  };
  return {
    encoder: { model: 'e5-excluido-del-ensayo', available: unexpected, embed: unexpected, close() {} },
    check() { assert.equal(attempts, 0); },
  };
}

function active(result) {
  assert.equal(result.semantic.status, 'activa');
  assert.equal(result.semantic.model, 'mind-estadistico-v1');
  assert.equal(result.semantic.embedded, 0);
  return result;
}

const round = value => Number(value.toFixed(2));

async function score(search, seeds) {
  const times = [];
  const ranks = [];
  let falsePositives = 0;
  async function timed(query) {
    const before = performance.now();
    const result = await search(query);
    times.push(performance.now() - before);
    return result;
  }
  for (const [i, [, , query]] of heldout.entries()) {
    const result = await timed(query);
    const index = result.results.findIndex(row => row.id === seeds[i].id
      && row.revision === seeds[i].revision && row.excerpt.includes(evidence[i]));
    ranks.push(index === -1 ? null : index + 1);
  }
  for (const query of negatives) {
    if ((await timed(query)).total !== 0) falsePositives++;
  }
  times.sort((a, b) => a - b);
  const middle = Math.floor(times.length / 2);
  return {
    top1: ranks.filter(rank => rank === 1).length,
    top3: ranks.filter(rank => rank !== null && rank <= 3).length,
    totalConRespuesta: heldout.length,
    sinRespuestaConCoincidencias: falsePositives,
    totalSinRespuesta: negatives.length,
    medianaMs: round(times.length % 2 ? times[middle] : (times[middle - 1] + times[middle]) / 2),
    puestos: ranks,
  };
}

test('compara el primer pasaje útil en consultas fijas ficticias', { ...enabled, timeout: 120_000 }, async t => {
  const f = await fixture(t);
  const r3 = await f.motor(e5Directory ? { semanticEncoder: createSemanticEncoder({ directory: e5Directory }) } : {});
  const guard = forbiddenEncoder();
  const native = await f.motor({ nativeMeaningExecutable, semanticEncoder: guard.encoder });
  const seeds = [];
  for (const [title, important] of heldout) {
    seeds.push(await r3.saveConversation({ title, important, project: independentProject }));
  }
  const options = { project: independentProject, limit: 3 };
  const firstWords = await r3.searchConversations({ ...options, query: 'contraseña', mode: 'palabras' });
  assert.equal(firstWords.results[0]?.id, seeds[0].id);
  active(await native.searchConversations({ ...options, query: 'contraseña' }));

  const words = await score(query => r3.searchConversations({ ...options, query, mode: 'palabras' }), seeds);
  const candidate = await score(async query => active(await native.searchConversations({ ...options, query })), seeds);
  guard.check();
  let e5 = null;
  if (e5Directory) {
    const preparation = await r3.prepareConversationSearch();
    assert.equal(preparation.error, null, 'El E5 de referencia debe prepararse sin sustituciones.');
    e5 = await score(async query => {
      const result = await r3.searchConversations({ ...options, query });
      assert.equal(result.semantic.status, 'activa', 'Se exige el E5 real, sin búsqueda de respaldo.');
      return result;
    }, seeds);
  }
  t.diagnostic(JSON.stringify({ corpus: '10 conversaciones ficticias, 14 consultas', palabras: words, candidato: candidate, r3E5: e5 }));
});

test('aprende términos del proyecto, distingue intención y conserva permisos y vigencia', enabled, async t => {
  const f = await fixture(t);
  const guard = forbiddenEncoder();
  const motor = await f.motor({ nativeMeaningExecutable, semanticEncoder: guard.encoder });
  const project = 'Comité de feria ficticio';
  const save = (title, important, scope = project) => motor.saveConversation({ title, important, project: scope });
  const decision = await save('Acuerdo del comité', 'Decisión: estuches de cartón reciclado para la feria.');
  const idea = await save('Borrador del comité', 'Idea: estuches de aluminio para la feria.');
  await save('Glosario de almacén', 'En el inventario se usan cajas y estuches para preparar el envío.');
  await save('Glosario del proveedor', 'El proveedor utiliza cajas y estuches en su embalaje habitual.');
  await save('Proyecto de otro equipo', 'Decisión: cajas de madera.', 'Otro proyecto ficticio');

  const query = 'Decisión cajas';
  const lexical = await motor.searchConversations({ query, project, mode: 'palabras' });
  assert.equal(lexical.total, 0);
  const decisionResult = active(await motor.searchConversations({ query, project }));
  assert.equal(decisionResult.results[0]?.id, decision.id);
  assert.match(decisionResult.results[0].excerpt, /cartón reciclado/u);
  assert.ok(decisionResult.results.every(item => item.project === project && item.id !== idea.id));
  const ideaResult = active(await motor.searchConversations({ query: 'Idea cajas', project }));
  assert.equal(ideaResult.results[0]?.id, idea.id);
  assert.match(ideaResult.results[0].excerpt, /aluminio/u);
  assert.equal(active(await motor.searchConversations({ query: 'hidráulica marciana', project })).total, 0);
  assert.equal(active(await motor.searchConversations({ query, project: 'Proyecto vacío' })).total, 0);
  await assert.rejects(motor.searchConversations({ query: '¡¿?!', project }), { code: 'INVALID_CONVERSATION_QUERY' });

  const previous = await save('Código del stand', 'Identificador vigente: ISLA817.');
  assert.equal(active(await motor.searchConversations({ query: 'ISLA817', project })).results[0]?.id, previous.id);
  const saved = await motor.saveConversation({
    id: previous.id, expectedRevision: previous.revision, title: previous.title, important: 'Identificador vigente: CALA514.', project,
  });
  assert.equal(active(await motor.searchConversations({ query: 'ISLA817', project })).total, 0);
  const latest = active(await motor.searchConversations({ query: 'CALA514', project })).results[0];
  assert.equal(latest?.id, previous.id);
  assert.equal(latest.revision, saved.revision);
  assert.match(latest.excerpt, /CALA514/u);
  guard.check();

  const layout = await resolveLayout({
    base: f.base,
    env: { MIND_PYTHON: process.env.MIND_TEST_BUNDLED_PYTHON || process.env.MIND_PYTHON },
  });
  assert.equal(layout.product, false);
  const session = await openSession({ layout, motorVersion: '1.0.5-prueba', observe: false, nativeMeaningExecutable });
  f.cleanup.push(() => session.close());
  await session.start();
  const tools = createAgentTools({ session, connection: { clientInfo: { name: 'cliente ficticio' } } });
  const call = () => tools.call('conversaciones_buscar', { consulta: query, proyecto: project }, {});
  await assert.rejects(call(), { code: 'ACCESS_NOT_GRANTED' });
  await session.policy.setContinuity(['leer'], { channel: 'administracion-local' });
  const valid = await call();
  assert.equal(valid.semantica.modelo, 'mind-estadistico-v1');
  assert.equal(valid.conversaciones[0]?.id, decision.id);
  assert.ok(valid.conversaciones.every(item => item.proyecto === project));
  await session.policy.setContinuity([], { channel: 'administracion-local' });
  await assert.rejects(call(), { code: 'ACCESS_NOT_GRANTED' });
});

test('si falta el auxiliar o es inválido, conserva búsqueda por palabras sin iniciar E5', enabled, async t => {
  const f = await fixture(t);
  const guard = forbiddenEncoder();
  const r3 = await f.motor();
  const expected = await r3.saveConversation({ title: 'Prueba ficticia', important: 'El cartel es de cobre y marfil.' });
  const invalid = path.join(f.base, 'auxiliar-invalido.exe');
  await fs.writeFile(invalid, 'No es un ejecutable.');
  for (const executable of [path.join(f.base, 'auxiliar-ausente.exe'), invalid]) {
    const motor = await f.motor({ nativeMeaningExecutable: executable, semanticEncoder: guard.encoder });
    const result = await motor.searchConversations({ query: 'cobre marfil' });
    assert.equal(result.semantic.status, 'fallo');
    assert.equal(result.results[0]?.id, expected.id);
    assert.equal(result.results[0].match, 'palabras');
  }
  guard.check();
});
