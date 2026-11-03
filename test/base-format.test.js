import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';
import { openMotor } from '../src/motor.js';
import { ensureBase, prepareBaseFormat, BASE_MARKER, BASE_FORMAT_VERSION } from '../src/base-format.js';
import { createPackageManifest, TARGETS } from '../scripts/construir-paquetes.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(fileURLToPath(new URL('../..', import.meta.url)), '.mind-base-format-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const base = path.join(root, 'Base ficticia');
  const folder = path.join(root, 'Originales ficticios');
  await fs.mkdir(base);
  await fs.mkdir(folder);
  await fs.writeFile(path.join(folder, 'nota.txt'), 'Texto ficticio\n');
  const markerPath = path.join(base, BASE_MARKER);
  const marker = { format: 'mind-base', version: 1, baseId: '00000000-0000-4000-8000-000000000000',
    createdAt: '2026-01-01T00:00:00.000Z', createdBy: 'Motor anterior' };
  return { root, base, folder, markerPath, marker };
}

function interceptRename(t, callback) {
  const original = fs.rename;
  fs.rename = async (source, target) => {
    await callback(source, target);
    return original(source, target);
  };
  syncBuiltinESMExports();
  t.after(() => { fs.rename = original; syncBuiltinESMExports(); });
}

test('consultar con el núcleo no crea marca; abrir una Base v1 conserva sus bytes', async (t) => {
  const f = await fixture(t);
  const motor = await openMotor({ baseDirectory: f.base });
  assert.equal(await motor.readRecord('ausente'), null);
  assert.deepEqual(await fs.readdir(f.base), []);
  const text = `${JSON.stringify(f.marker, null, 2)}\n`;
  await fs.writeFile(f.markerPath, text);
  assert.equal((await ensureBase(f.base)).version, 1);
  await openMotor({ baseDirectory: f.base });
  assert.equal(await fs.readFile(f.markerPath, 'utf8'), text);
  assert.deepEqual(await fs.readdir(f.base), [BASE_MARKER]);
});

test('la marca v2 se publica antes del índice v3, conservando identidad y fecha de la Base', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.markerPath, JSON.stringify(f.marker));
  const motor = await openMotor({ baseDirectory: f.base });
  const scope = await motor.authorizeFolder(f.folder);
  const target = path.join(f.base, `folder-index-${scope.id}.json`);
  let checked = false;
  interceptRename(t, async (_source, destination) => {
    if (destination !== target) return;
    assert.deepEqual(JSON.parse(await fs.readFile(f.markerPath, 'utf8')), { ...f.marker, version: 2 });
    checked = true;
  });
  await motor.indexFolder(scope.id);
  assert.equal(checked, true);
  assert.equal(JSON.parse(await fs.readFile(target, 'utf8')).version, 3);
});

test('la primera publicación de un índice en una Base del núcleo añade protección global', async (t) => {
  const f = await fixture(t);
  const motor = await openMotor({ baseDirectory: f.base });
  const scope = await motor.authorizeFolder(f.folder);
  await assert.rejects(fs.stat(f.markerPath), { code: 'ENOENT' });
  await motor.indexFolder(scope.id);
  assert.equal(JSON.parse(await fs.readFile(f.markerPath, 'utf8')).version, 2);
});

test('las propiedades v2 también elevan la marca antes de publicarse', async (t) => {
  const f = await fixture(t);
  const motor = await openMotor({ baseDirectory: f.base });
  const scope = await motor.authorizeFolder(f.folder);
  await motor.indexFolder(scope.id);
  await fs.writeFile(f.markerPath, JSON.stringify(f.marker));
  const target = path.join(f.base, `folder-properties-${scope.id}.json`);
  let checked = false;
  interceptRename(t, async (_source, destination) => {
    if (destination !== target) return;
    assert.equal(JSON.parse(await fs.readFile(f.markerPath, 'utf8')).version, 2);
    checked = true;
  });
  await motor.setProperties(scope.id, 'nota.txt', { set: { ficticio: true } });
  assert.equal(checked, true);
  assert.equal(JSON.parse(await fs.readFile(target, 'utf8')).version, 2);
});

test('un fallo al elevar la marca impide publicar el nuevo subformato', async (t) => {
  const f = await fixture(t);
  const original = JSON.stringify(f.marker);
  await fs.writeFile(f.markerPath, original);
  const motor = await openMotor({ baseDirectory: f.base });
  const scope = await motor.authorizeFolder(f.folder);
  interceptRename(t, async (_source, destination) => {
    if (destination === f.markerPath) throw Object.assign(new Error('Denegación ficticia de publicación'), { code: 'EACCES' });
  });
  await assert.rejects(motor.indexFolder(scope.id), { code: 'EACCES' });
  assert.equal(await fs.readFile(f.markerPath, 'utf8'), original);
  await assert.rejects(fs.stat(path.join(f.base, `folder-index-${scope.id}.json`)), { code: 'ENOENT' });
});

test('una marca futura impide abrir tanto producto como núcleo y no cambia datos', async (t) => {
  const f = await fixture(t);
  const original = JSON.stringify({ ...f.marker, version: BASE_FORMAT_VERSION + 1 });
  await fs.writeFile(f.markerPath, original);
  await assert.rejects(openMotor({ baseDirectory: f.base }), { code: 'BASE_TOO_NEW' });
  await assert.rejects(ensureBase(f.base), { code: 'BASE_TOO_NEW' });
  assert.equal(await fs.readFile(f.markerPath, 'utf8'), original);
  assert.deepEqual(await fs.readdir(f.base), [BASE_MARKER]);
});

test('preparaciones concurrentes conservan una única identidad y nunca rebajan la marca', async (t) => {
  const f = await fixture(t);
  const markers = await Promise.all([
    prepareBaseFormat(f.base, 2), prepareBaseFormat(f.base, 2), prepareBaseFormat(f.base, 1),
  ]);
  assert.equal(new Set(markers.map((marker) => marker.baseId)).size, 1);
  const marker = JSON.parse(await fs.readFile(f.markerPath, 'utf8'));
  assert.equal(marker.version, 2);
  assert.equal(marker.baseId, markers[0].baseId);
});

test('los manifiestos de las cinco plataformas declaran el formato real del Motor empaquetado', () => {
  for (const target of Object.values(TARGETS)) {
    const manifest = createPackageManifest({
      format: 'mind-product', version: 1, mindVersion: '1.0.0-prueba',
      platform: target.platform, arch: target.arch, files: {}, links: {},
      baseFormatVersion: 1, // Un valor antiguo recibido no puede rebajar la capacidad real.
    });
    assert.equal(manifest.baseFormatVersion, BASE_FORMAT_VERSION);
    assert.equal(manifest.platform, target.platform);
    assert.equal(manifest.arch, target.arch);
  }
});
