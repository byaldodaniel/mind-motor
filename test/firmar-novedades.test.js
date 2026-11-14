import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { validateNovedades, validateAuthorNotes, validateBaseImpact, deriveComprobado, buildNovedades, groupOf, changedGroups, cleanText } from '../src/release-notes.js';

const author = () => ({ nombre: 'Entrega', resumen: 'Qué trae.', cambios: [{ titulo: 'Algo', tipo: 'seguridad' }], importancia: 'seguridad',
  impacto_datos: { base: 'migracion-automatica', conversaciones: 'intactas', carpetas_autorizadas: 'revisar' } });
const H = n => String(n).repeat(64).slice(0, 64);
const manifest = (files, extra = {}) => ({ format: 'mind-product', version: 1, files, ...extra });

test('el ejemplo del repositorio es una nota de autor válida', async () => {
  const example = JSON.parse(await fs.readFile(new URL('../packaging/novedades.ejemplo.json', import.meta.url), 'utf8'));
  assert.equal(validateAuthorNotes(example).importancia, 'recomendada');
});

test('autor: normaliza opcionales, recorta y sanea controles', () => {
  const n = validateAuthorNotes({ ...author(), nombre: '  Hola\u0000mundo ', resumen: 'a\r\nb\u0007' });
  assert.equal(n.nombre, 'Hola mundo');
  assert.equal(n.resumen, 'a\nb');
  assert.deepEqual(n.cambios[0], { titulo: 'Algo', detalle: '', tipo: 'seguridad' });
  assert.equal(n.impacto_datos.nota, '');
});

test('autor: rechaza límites, enumerados y campos desconocidos con mensaje claro', () => {
  const bad = [
    n => { n.nombre = ''; }, n => { n.nombre = 'x'.repeat(81); }, n => { n.resumen = 'x'.repeat(401); },
    n => { n.cambios = []; }, n => { n.cambios = Array(31).fill({ titulo: 't', tipo: 'mejora' }); },
    n => { n.cambios[0].tipo = 'otro'; }, n => { n.cambios[0].titulo = 'x'.repeat(121); }, n => { n.cambios[0].detalle = 'x'.repeat(401); },
    n => { n.importancia = 'urgente'; }, n => { n.impacto_datos.base = 'borra'; }, n => { n.impacto_datos.conversaciones = 'revisar'; },
    n => { n.impacto_datos.carpetas_autorizadas = 'cambian'; }, n => { n.impacto_datos.nota = 'x'.repeat(401); },
    n => { n.otro = 1; }, n => { n.nombre = 5; }, n => { delete n.impacto_datos; },
  ];
  for (const mutate of bad) {
    const n = author(); mutate(n);
    assert.throws(() => validateAuthorNotes(n), error => error.code === 'UPDATE_NOTES_INVALID' && /Novedades no válidas/u.test(error.message));
  }
  assert.throws(() => validateAuthorNotes(null), { code: 'UPDATE_NOTES_INVALID' });
});

test('el autor no puede fijar comprobado', () => {
  assert.throws(() => validateAuthorNotes({ ...author(), comprobado: { archivos: 1 } }), /comprobado/u);
  assert.throws(() => buildNovedades({ ...author(), comprobado: {} }, {}), { code: 'UPDATE_NOTES_INVALID' });
});

test('cleanText: saltos solo en campos multilínea', () => {
  assert.equal(cleanText('a\nb', 'x', { max: 10 }), 'a b');
  assert.equal(cleanText('a\nb', 'x', { max: 10, multiline: true }), 'a\nb');
  assert.equal(cleanText('a\u202Eb', 'x', { max: 10 }), 'ab');
});

test('grupos de nivel alto', () => {
  assert.equal(groupOf('Sistema/Programa/Motor/src/a.js'), 'Sistema/Programa/Motor');
  assert.equal(groupOf('Sistema/Componentes/Node/win32-x64/node.exe'), 'Sistema/Componentes/Node/win32-x64');
  assert.equal(groupOf('Sistema/Componentes/Python/linux-x64/bin/python'), 'Sistema/Componentes/Python/linux-x64');
  assert.equal(groupOf('Sistema/Componentes/Semantica/modelo/x.onnx'), 'Sistema/Componentes/Semantica');
  assert.equal(groupOf('Sistema/Licencias/AVISOS.md'), 'Sistema/Licencias');
  assert.equal(groupOf('Sistema/mind.cmd'), 'Sistema/mind.cmd');
});

test('comprobado se deriva del manifiesto y los tamaños; sin anterior los grupos son null', () => {
  const m = manifest({ 'Sistema/Programa/Motor/a.js': H(1), 'Sistema/Programa/Motor/b.js': H(2), 'Sistema/mind.cmd': H(3) },
    { baseFormatVersion: 2, components: [{ name: 'node', version: '24.1.0', source: 'https://x', sha256: H(9), target: 'win32-x64' }] });
  const sizes = { 'Sistema/Programa/Motor/a.js': 10, 'Sistema/Programa/Motor/b.js': 20, 'Sistema/mind.cmd': 5 };
  const c = deriveComprobado({ manifest: m, sizes, packageBytes: 999 });
  assert.deepEqual(c, { baseFormatVersion: 2, paqueteBytes: 999, programaBytes: 35, archivos: 3,
    componentes: [{ name: 'node', version: '24.1.0', target: 'win32-x64' }], gruposCambiados: null, descargaParcialBytes: null });
  assert.equal(deriveComprobado({ manifest: manifest({}), sizes: {}, packageBytes: 1 }).baseFormatVersion, null);
  assert.throws(() => deriveComprobado({ manifest: m, sizes: {}, packageBytes: 1 }), { code: 'UPDATE_NOTES_INVALID' });
});

test('con paquete anterior deriva gruposCambiados y descargaParcialBytes', () => {
  const previous = manifest({ 'Sistema/Programa/Motor/a.js': H(1), 'Sistema/Componentes/Node/win32-x64/node.exe': H(4), 'Sistema/Licencias/a.md': H(5), 'Sistema/viejo.txt': H(6) });
  const next = manifest({ 'Sistema/Programa/Motor/a.js': H(7), 'Sistema/Programa/Motor/nuevo.js': H(8), 'Sistema/Componentes/Node/win32-x64/node.exe': H(4), 'Sistema/Licencias/a.md': H(5) });
  const sizes = { 'Sistema/Programa/Motor/a.js': 10, 'Sistema/Programa/Motor/nuevo.js': 15, 'Sistema/Componentes/Node/win32-x64/node.exe': 1000, 'Sistema/Licencias/a.md': 3 };
  assert.deepEqual(changedGroups(previous.files, next.files), ['Sistema/Programa/Motor', 'Sistema/viejo.txt']);
  const c = deriveComprobado({ manifest: next, sizes, packageBytes: 50, previousManifest: previous });
  assert.deepEqual(c.gruposCambiados, ['Sistema/Programa/Motor', 'Sistema/viejo.txt']);
  assert.equal(c.descargaParcialBytes, 25);
  assert.equal(c.programaBytes, 1028);
});

test('buildNovedades produce un bloque que valida el canal; comprobado malformado se rechaza', () => {
  const derived = deriveComprobado({ manifest: manifest({ 'Sistema/a': H(1) }), sizes: { 'Sistema/a': 1 }, packageBytes: 2 });
  const block = buildNovedades(author(), derived);
  assert.deepEqual(validateNovedades(JSON.parse(JSON.stringify(block))), block);
  assert.throws(() => validateNovedades({ ...block, comprobado: { ...block.comprobado, archivos: -1 } }), { code: 'UPDATE_NOTES_INVALID' });
  assert.throws(() => validateNovedades({ ...block, comprobado: { ...block.comprobado, extra: 1 } }), { code: 'UPDATE_NOTES_INVALID' });
  assert.throws(() => validateNovedades({ ...block, comprobado: { ...block.comprobado, gruposCambiados: [] } }), /juntos/u);
});

test('impacto de Base: sin-cambios no contradice el formato frente al anterior', () => {
  const notes = { ...author(), impacto_datos: { ...author().impacto_datos, base: 'sin-cambios' } };
  for (const [previous, next] of [[1, 2], [2, 1], [undefined, 2], [2, undefined]]) {
    assert.throws(() => validateBaseImpact(notes, { baseFormatVersion: next }, { baseFormatVersion: previous }),
      error => error.code === 'UPDATE_NOTES_INVALID' && /baseFormatVersion.*--anterior/u.test(error.message));
  }
  assert.doesNotThrow(() => validateBaseImpact(notes, { baseFormatVersion: 2 }, { baseFormatVersion: 2 }));
  assert.doesNotThrow(() => validateBaseImpact(notes, {}, {}));
  assert.doesNotThrow(() => validateBaseImpact(notes, { baseFormatVersion: 2 }));
  for (const base of ['migracion-automatica', 'requiere-copia']) {
    assert.doesNotThrow(() => validateBaseImpact({ ...notes, impacto_datos: { ...notes.impacto_datos, base } }, { baseFormatVersion: 2 }, { baseFormatVersion: 1 }));
  }
});
