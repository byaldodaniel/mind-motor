import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { agentFixture, connection } from './helpers/agent-fixture.js';
import { createAgentTools } from '../src/agent-tools.js';
import { toolResult, toolError } from '../src/mcp-server.js';
import { CORE_DEFINITIONS, CORE_INSTRUCTIONS, catalogMode, extractSection, markdownHeadings, withCatalog } from '../src/core-catalog.js';

const DOCUMENT = [
  '# Frente', 'Intro.', '## Pendientes', '- [ ] Medir', '```', '# no es encabezado', '```',
  '### Detalle', 'Sub.', '## Decisiones', 'Se aprueba.', '',
].join('\n');

test('secciones Markdown: índice sin bloques de código, apartado hasta el siguiente de igual nivel', () => {
  const { headings } = markdownHeadings(DOCUMENT);
  assert.deepEqual(headings.map((h) => h.titulo), ['Frente', 'Pendientes', 'Detalle', 'Decisiones']);
  const part = extractSection(DOCUMENT, 'pendientes');
  assert.equal(part.encontrado, true);
  assert.equal(part.contenido, ['## Pendientes', '- [ ] Medir', '```', '# no es encabezado', '```', '### Detalle', 'Sub.'].join('\n'));
  assert.deepEqual(part.seccion, { titulo: 'Pendientes', nivel: 2, desde_linea: 3, hasta_linea: 9 });
  // Coincidencia parcial sin tildes: «decisión» encuentra «Decisiones».
  assert.equal(extractSection(DOCUMENT, 'Decisión').seccion.titulo, 'Decisiones');
  assert.equal(extractSection(DOCUMENT, 'Presupuesto').encontrado, false);
  assert.equal(extractSection(DOCUMENT, 'decisiones').contenido, '## Decisiones\nSe aprueba.\n');
});

test('modo de catálogo: núcleo por defecto, completo solo si se pide', () => {
  assert.equal(catalogMode(null, {}), 'nucleo');
  assert.equal(catalogMode('completo', {}), 'completo');
  assert.equal(catalogMode(null, { MIND_CATALOGO: 'completo' }), 'completo');
  assert.equal(catalogMode('cualquiera', {}), 'nucleo');
  const inner = { definitions: [{ name: 'estado' }], call: () => 'interno' };
  assert.equal(withCatalog(inner, 'completo'), inner);
  assert.equal(CORE_DEFINITIONS.length, 12);
  assert.equal(CORE_DEFINITIONS.find((d) => d.name === 'guardar').annotations.destructiveHint, false);
  assert.equal(CORE_DEFINITIONS.find((d) => d.name === 'actualizar').annotations.destructiveHint, true);
  assert.equal(CORE_DEFINITIONS.find((d) => d.name === 'mind').annotations.readOnlyHint, true);
  assert.equal(CORE_DEFINITIONS.find((d) => d.name === 'mind_cambiar').annotations.destructiveHint, true);
  assert.ok(Buffer.byteLength(CORE_INSTRUCTIONS) < 2048);
});

test('cada herramienta núcleo llega a la operación interna con su nombre original', async () => {
  const calls = [];
  const names = ['estado', 'buscar', 'agrupar', 'conversaciones_buscar', 'continuidad_consultar', 'explorar', 'crear', 'crear_carpeta',
    'editar', 'modificar', 'mover', 'borrar', 'asignar_propiedades', 'conversacion_guardar', 'continuidad_registrar', 'continuidad_actualizar', 'solicitar_acceso',
    'retirar_acceso', 'funciones'];
  const readOnly = new Set(['estado', 'buscar', 'agrupar', 'conversaciones_buscar', 'continuidad_consultar', 'explorar', 'funciones']);
  const inner = { definitions: names.map((name) => ({ name, description: name, inputSchema: {}, annotations: { readOnlyHint: readOnly.has(name) } })), call: async (name, args) => { calls.push([name, args]); return { ok: true }; } };
  const core = withCatalog(inner);
  await core.call('buscar', { consulta: 'x' });
  await core.call('buscar', { en: 'marcas', consulta: 'pendiente', agrupar_por: 'archivo' });
  await core.call('buscar', { en: 'continuidad', consulta: 'cajas' });
  await core.call('crear', { accion: 'carpeta', ruta: 'a' });
  await core.call('modificar', { ruta: 'a', ediciones: [{ buscar: 'x', reemplazar: 'y' }] });
  await core.call('modificar', { ruta: 'a', version: 'v', contenido: 'z' });
  await core.call('organizar', { accion: 'propiedades', ruta: 'a', asignar: { estado: 'ok' } });
  await core.call('guardar', { titulo: 't', importante: 'i' });
  await core.call('acceso', { accion: 'retirar', carpeta: 'c', todo: true });
  await core.call('mind', { operacion: 'funciones' });
  assert.deepEqual(calls, [
    ['buscar', { consulta: 'x' }],
    ['agrupar', { etiqueta: 'pendiente', agrupar_por: 'archivo' }],
    ['continuidad_consultar', { texto: 'cajas' }],
    ['crear_carpeta', { ruta: 'a' }],
    ['editar', { ruta: 'a', ediciones: [{ buscar: 'x', reemplazar: 'y' }] }],
    ['modificar', { ruta: 'a', version: 'v', contenido: 'z' }],
    ['asignar_propiedades', { ruta: 'a', asignar: { estado: 'ok' } }],
    ['conversacion_guardar', { titulo: 't', importante: 'i' }],
    ['retirar_acceso', { carpeta: 'c', todo: true }],
    ['funciones', {}],
  ]);
  // guardar nunca reemplaza: con id o revision remite a actualizar, que sí lo hace.
  await assert.rejects(core.call('guardar', { id: 'c1', revision: 1, importante: 'x' }), { code: 'USE_ACTUALIZAR' });
  await assert.rejects(core.call('actualizar', { importante: 'x' }), { code: 'INVALID_ARGUMENTS' });
  const before = calls.length;
  await core.call('actualizar', { id: 'c1', revision: 2, importante: 'x' });
  await core.call('actualizar', { en: 'continuidad', id: 'r1', revision: 1, contenido: 'y' });
  assert.deepEqual(calls.slice(before), [
    ['conversacion_guardar', { id: 'c1', revision: 2, importante: 'x' }],
    ['continuidad_actualizar', { id: 'r1', revision: 1, contenido: 'y' }],
  ]);
  await assert.rejects(core.call('organizar', { accion: 'quemar' }), { code: 'INVALID_ARGUMENTS' });
  await assert.rejects(core.call('mind', { operacion: 'no_existe' }), { code: 'UNKNOWN_TOOL' });
  await assert.rejects(core.call('agrupar', {}), { code: 'UNKNOWN_TOOL' });
  await assert.rejects(core.call('modificar', { ruta: 'a', ediciones: [], contenido: 'z' }), { code: 'INVALID_ARGUMENTS' });
  const help = await core.call('mind', { operacion: 'ayuda', detalle: 'funciones' });
  assert.equal(help.operacion, 'funciones');
  assert.equal(help.herramienta, 'mind');
  // mind solo consulta; lo que cambia datos va por mind_cambiar, y al revés.
  await assert.rejects(core.call('mind', { operacion: 'borrar', argumentos: { ruta: 'a' } }), { code: 'USE_MIND_CAMBIAR' });
  await assert.rejects(core.call('mind_cambiar', { operacion: 'funciones' }), { code: 'USE_MIND' });
  await core.call('mind_cambiar', { operacion: 'borrar', argumentos: { ruta: 'a' } });
  assert.deepEqual(calls.at(-1), ['borrar', { ruta: 'a' }]);
  const listing = await core.call('mind', { operacion: 'ayuda' });
  assert.ok(listing.mind.some((op) => op.nombre === 'funciones'));
  assert.ok(listing.mind_cambiar.some((op) => op.nombre === 'borrar'));
});

async function setup(t, files) {
  const f = await agentFixture(t, { prefix: '.mind-core-catalog-test-', files });
  const session = await f.open();
  const folder = await session.motor.authorizeFolder(f.folder);
  await session.policy.set(folder.id, ['encontrar', 'leer', 'escribir', 'organizar'], { channel: 'administracion-local' });
  await session.policy.setContinuity(['leer', 'registrar'], { channel: 'administracion-local' });
  const tools = withCatalog(createAgentTools({ session, connection: connection() }));
  const call = async (name, args = {}) => {
    try {
      const result = toolResult(await tools.call(name, args, {}));
      return { data: result.structuredContent, text: result.content[0].text, isError: false };
    } catch (error) {
      const result = toolError(error);
      return { data: result.structuredContent, text: result.content[0].text, isError: true, code: result.structuredContent.error.codigo };
    }
  };
  return { ...f, session, call, folderId: folder.id };
}

test('núcleo de extremo a extremo: buscar, leer por sección, modificar, guardar y retomar', async (t) => {
  const f = await setup(t, { 'frente.md': DOCUMENT });
  const listed = await f.call('buscar', { consulta: 'frente' });
  assert.equal(listed.isError, false, listed.text);
  assert.ok(JSON.stringify(listed.data).includes('frente.md'));

  const indice = await f.call('leer', { ruta: 'frente.md', seccion: '?' });
  assert.equal(indice.isError, false, indice.text);
  assert.deepEqual(indice.data.indice.map((h) => h.titulo), ['Frente', 'Pendientes', 'Detalle', 'Decisiones']);
  assert.equal(indice.data.contenido, undefined);

  const section = await f.call('leer', { ruta: 'frente.md', seccion: 'Decisiones' });
  assert.equal(section.data.contenido, '## Decisiones\nSe aprueba.\n');
  assert.match(section.text, /sha256:/);
  assert.match(section.data.version, /^sha256:/);

  const missing = await f.call('leer', { ruta: 'frente.md', seccion: 'Inexistente' });
  assert.equal(missing.data.encontrado, false);

  const edited = await f.call('modificar', { ruta: 'frente.md', version: section.data.version, ediciones: [{ buscar: 'Se aprueba.', reemplazar: 'Se aprueba con cambios.' }] });
  assert.equal(edited.isError, false, edited.text);
  assert.match(await fs.readFile(path.join(f.folder, 'frente.md'), 'utf8'), /Se aprueba con cambios\./);

  const saved = await f.call('guardar', { titulo: 'Ensayo núcleo', importante: 'Pendiente: medir tokens.' });
  assert.equal(saved.isError, false, saved.text);
  const id = saved.data.conversacion.id;

  const resumed = await f.call('retomar', { id });
  assert.equal(resumed.isError, false, resumed.text);
  assert.equal(resumed.data.conversacion.id, id);
  assert.match(resumed.data.conversacion.importante, /medir tokens/);
  assert.ok(resumed.data.destinos.efectivos, JSON.stringify(resumed.data.destinos));

  const byText = await f.call('retomar', { consulta: 'Ensayo núcleo' });
  assert.equal(byText.isError, false, byText.text);
  assert.equal(byText.data.conversacion?.id, id, byText.text);

  const updated = await f.call('actualizar', { id, revision: resumed.data.conversacion.revision, importante: 'Pendiente: medir tokens. Hecho: catálogo núcleo.' });
  assert.equal(updated.isError, false, updated.text);
  assert.match((await f.call('retomar', { id })).data.conversacion.importante, /catálogo núcleo/);
  const stale = await f.call('actualizar', { id, revision: resumed.data.conversacion.revision, importante: 'Revisión vieja.' });
  assert.equal(stale.isError, true);

  const viaMind = await f.call('mind', { operacion: 'conversacion_preferencias' });
  assert.equal(viaMind.isError, false, viaMind.text);
});
