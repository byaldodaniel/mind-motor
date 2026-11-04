import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openMotor, MotorError } from '../src/motor.js';
import { createFolderIndexer } from '../src/indexer.js';
import { mergeScan } from '../src/index-scan.js';

const motorDirectory = fileURLToPath(new URL('..', import.meta.url));
const developmentDirectory = path.dirname(motorDirectory);
const linkType = process.platform === 'win32' ? 'junction' : 'dir';

/** Adaptador de prueba: el registro del Incremento 02 como única fuente de ámbitos. */
function registryResolver(motor) {
  return async (id) => {
    const folder = (await motor.listAuthorizedFolders()).find((item) => item.id === id);
    if (!folder) throw new MotorError('FOLDER_NOT_AUTHORIZED', 'La carpeta no está autorizada.');
    return folder;
  };
}

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(developmentDirectory, '.mind-index-test-'));
  t.after(async () => {
    assert.equal(path.dirname(root), developmentDirectory);
    assert.ok(path.basename(root).startsWith('.mind-index-test-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const base = path.join(root, 'Base');
  const folder = path.join(root, 'Información ficticia');
  await fs.mkdir(base);
  await fs.mkdir(path.join(folder, 'Proyectos', 'Fotos'), { recursive: true });
  await fs.writeFile(path.join(folder, 'notas.txt'), 'Notas ficticias');
  await fs.writeFile(path.join(folder, 'Proyectos', 'plan.md'), '# Plan ficticio');
  const motor = await openMotor({ baseDirectory: base });
  const scope = await motor.authorizeFolder(folder);
  const indexer = createFolderIndexer({
    baseDirectory: motor.baseDirectory, resolveScope: registryResolver(motor), ...options,
  });
  return { root, base, folder: scope.path, motor, scope, indexer };
}

/** Denegación real del SO para listar una carpeta; devuelve cómo restaurarla. */
async function denyListing(directory) {
  if (process.platform === 'win32') {
    // Rutas del sistema: evita herramientas homónimas de otros entornos en PATH.
    const system = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
    const who = spawnSync(path.join(system, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' });
    const sid = who.stdout.trim().split(',').at(-1).replaceAll('"', '');
    const icacls = (...args) => assert.equal(
      spawnSync(path.join(system, 'icacls.exe'), [directory, ...args]).status, 0);
    icacls('/deny', `*${sid}:(RD)`);
    return async () => icacls('/remove:d', `*${sid}`);
  }
  await fs.chmod(directory, 0);
  return () => fs.chmod(directory, 0o755);
}

function record(relative, values = {}) {
  return { path: relative, type: 'file', size: 1, modifiedMs: 0, changedMs: 0,
    createdMs: null, listing: null, ...values };
}

function paths(index) {
  return index.entries.map((entry) => entry.path);
}

function entry(index, relative) {
  return index.entries.find((item) => item.path === relative);
}

async function snapshot(folder) {
  const result = {};
  for (const name of await fs.readdir(folder, { recursive: true })) {
    const absolute = path.join(folder, name);
    const stats = await fs.lstat(absolute);
    result[name] = { mtimeMs: stats.mtimeMs, size: stats.size,
      bytes: stats.isFile() ? (await fs.readFile(absolute)).toString('base64') : null };
  }
  return result;
}

test('la indexación inicial guarda rutas relativas, tipos, tamaños y fechas', async (t) => {
  const { base, folder, scope, indexer } = await fixture(t);
  assert.equal(await indexer.readFolderIndex(scope.id), null);
  const result = await indexer.indexFolder(scope.id);
  assert.equal(result.mode, 'initial');
  assert.equal(result.generation, 1);
  assert.equal(result.changes, null);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.totals, {
    entries: 4, files: 2, directories: 2, links: 0, other: 0, notListed: 0, unverified: 0,
  });
  const index = await indexer.readFolderIndex(scope.id);
  assert.equal(index.root, folder);
  assert.deepEqual(paths(index), ['Proyectos', 'Proyectos/Fotos', 'Proyectos/plan.md', 'notas.txt']);
  const notes = entry(index, 'notas.txt');
  // Con bigint, Node trunca a milisegundos en lugar de redondear.
  const stats = await fs.stat(path.join(folder, 'notas.txt'), { bigint: true });
  assert.equal(notes.type, 'file');
  assert.equal(notes.size, Buffer.byteLength('Notas ficticias'));
  assert.equal(notes.modifiedAt, stats.mtime.toISOString());
  assert.equal(notes.changedAt, stats.ctime.toISOString());
  assert.equal(notes.state, 'indexed');
  assert.equal(notes.reason, null);
  assert.equal(entry(index, 'Proyectos').type, 'directory');
  assert.equal(entry(index, 'Proyectos').size, null);
  assert.ok(index.entries.every((item) => !path.isAbsolute(item.path) && !item.path.includes('\\')));
  const files = (await fs.readdir(base)).filter((name) => name.startsWith('folder-index-'));
  assert.deepEqual(files, [`folder-index-${scope.id}.json`]);
});

test('no lee el contenido ni modifica, copia o mueve los originales', async (t) => {
  const { base, folder, scope, indexer } = await fixture(t);
  // Que el auxiliar solo abre carpetas se verifica en test/native_index_test.py.
  const before = await snapshot(folder);
  await indexer.indexFolder(scope.id);
  await indexer.indexFolder(scope.id);
  assert.deepEqual(await snapshot(folder), before);
  const stored = await fs.readFile(path.join(base, `folder-index-${scope.id}.json`), 'utf8');
  assert.ok(!stored.includes('ficticio'), 'El índice no contiene texto de los documentos');
});

test('la reconciliación detecta altas, cambios, bajas y cambios de tipo', async (t) => {
  const { folder, scope, indexer } = await fixture(t);
  await indexer.indexFolder(scope.id);
  const unchanged = await indexer.indexFolder(scope.id);
  assert.equal(unchanged.mode, 'reconciliation');
  assert.deepEqual(unchanged.changes, { added: [], modified: [], removed: [] });

  await fs.writeFile(path.join(folder, 'nuevo.txt'), 'nuevo');
  await fs.writeFile(path.join(folder, 'Proyectos', 'plan.md'), '# Plan ficticio ampliado');
  await fs.rm(path.join(folder, 'Proyectos', 'Fotos'), { recursive: true });
  await fs.rm(path.join(folder, 'notas.txt'));
  await fs.mkdir(path.join(folder, 'notas.txt'));
  const result = await indexer.indexFolder(scope.id);
  assert.equal(result.generation, 3);
  assert.deepEqual(result.changes, {
    added: ['nuevo.txt'], modified: ['Proyectos/plan.md', 'notas.txt'], removed: ['Proyectos/Fotos'],
  });
  const index = await indexer.readFolderIndex(scope.id);
  assert.equal(entry(index, 'notas.txt').type, 'directory');
  assert.equal(entry(index, 'Proyectos/plan.md').size, Buffer.byteLength('# Plan ficticio ampliado'));
});

test('detecta un cambio de fecha con el mismo tamaño y elimina subárboles completos', async (t) => {
  const { folder, scope, indexer } = await fixture(t);
  await indexer.indexFolder(scope.id);
  const plan = path.join(folder, 'Proyectos', 'plan.md');
  await fs.writeFile(plan, '# Plan FICTICIO');
  const later = new Date(Date.now() + 60_000);
  await fs.utimes(plan, later, later);
  assert.deepEqual((await indexer.indexFolder(scope.id)).changes.modified, ['Proyectos/plan.md']);
  await fs.rm(path.join(folder, 'Proyectos'), { recursive: true });
  assert.deepEqual((await indexer.indexFolder(scope.id)).changes.removed,
    ['Proyectos', 'Proyectos/Fotos', 'Proyectos/plan.md']);
});

test('el índice se recupera y reconcilia después de reiniciar el Motor', async (t) => {
  const { base, folder, scope } = await fixture(t);
  const script = `
    import { openMotor, MotorError } from ${JSON.stringify(pathToFileURL(path.join(motorDirectory, 'src', 'motor.js')).href)};
    import { createFolderIndexer } from ${JSON.stringify(pathToFileURL(path.join(motorDirectory, 'src', 'indexer.js')).href)};
    const [base, id] = process.argv.slice(1);
    const motor = await openMotor({ baseDirectory: base });
    const indexer = createFolderIndexer({ baseDirectory: motor.baseDirectory, resolveScope: async (scopeId) => {
      const folder = (await motor.listAuthorizedFolders()).find((item) => item.id === scopeId);
      if (!folder) throw new MotorError('FOLDER_NOT_AUTHORIZED', 'No autorizada.');
      return folder;
    } });
    process.stdout.write(JSON.stringify(await indexer.indexFolder(id)));
  `;
  const run = () => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, base, scope.id], {
      cwd: developmentDirectory, encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  assert.equal(run().mode, 'initial');
  await fs.writeFile(path.join(folder, 'tras-reinicio.txt'), 'ficticio');

  // Proceso nuevo e instancias nuevas: no hay estado en memoria compartido.
  const motor = await openMotor({ baseDirectory: base });
  const fresh = createFolderIndexer({ baseDirectory: motor.baseDirectory, resolveScope: registryResolver(motor) });
  const recovered = await fresh.readFolderIndex(scope.id);
  assert.equal(recovered.generation, 1);
  assert.ok(!paths(recovered).includes('tras-reinicio.txt'), 'Leer no recorre la carpeta');
  const second = run();
  assert.equal(second.mode, 'reconciliation');
  assert.deepEqual(second.changes.added, ['tras-reinicio.txt']);
  assert.equal((await fresh.readFolderIndex(scope.id)).generation, 2);
});

test('registra los enlaces sin seguirlos ni guardar su destino', async (t) => {
  const { root, base, folder, scope, indexer } = await fixture(t);
  const outside = path.join(root, 'Fuera del ámbito');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'secreto-ajeno.txt'), 'ajeno');
  await fs.symlink(outside, path.join(folder, 'enlace-carpeta'), linkType);
  if (process.platform !== 'win32') {
    await fs.symlink(path.join(outside, 'secreto-ajeno.txt'), path.join(folder, 'enlace-archivo'));
  }
  const result = await indexer.indexFolder(scope.id);
  const index = await indexer.readFolderIndex(scope.id);
  assert.equal(entry(index, 'enlace-carpeta').type, 'link');
  assert.equal(entry(index, 'enlace-carpeta').size, null);
  if (process.platform !== 'win32') assert.equal(entry(index, 'enlace-archivo').type, 'link');
  assert.equal(result.totals.links, process.platform === 'win32' ? 1 : 2);
  assert.ok(!paths(index).some((item) => item.includes('secreto-ajeno')));
  const stored = await fs.readFile(path.join(base, `folder-index-${scope.id}.json`), 'utf8');
  assert.ok(!stored.includes('Fuera del'), 'No se guarda el destino del enlace');
});

test('una subcarpeta inaccesible no se confunde con una eliminación', async (t) => {
  const { folder, scope, indexer } = await fixture(t);
  await indexer.indexFolder(scope.id);
  await fs.writeFile(path.join(folder, 'otro.txt'), 'ficticio');
  const restore = await denyListing(path.join(folder, 'Proyectos'));
  let denied;
  try {
    denied = await indexer.indexFolder(scope.id);
  } finally {
    await restore();
  }
  assert.deepEqual(denied.changes, { added: ['otro.txt'], modified: [], removed: [] });
  assert.equal(denied.totals.notListed, 1);
  assert.equal(denied.totals.unverified, 2);
  assert.deepEqual(denied.issues, [
    { path: 'Proyectos', code: 'EACCES' },
    { path: 'Proyectos/Fotos', code: 'EACCES' },
    { path: 'Proyectos/plan.md', code: 'EACCES' },
  ]);
  const index = await indexer.readFolderIndex(scope.id);
  assert.equal(entry(index, 'Proyectos').state, 'not-listed');
  assert.equal(entry(index, 'Proyectos/plan.md').state, 'unverified');
  assert.equal(entry(index, 'Proyectos/plan.md').size, Buffer.byteLength('# Plan ficticio'));

  const restored = await indexer.indexFolder(scope.id);
  assert.deepEqual(restored.changes, { added: [], modified: [], removed: [] });
  assert.deepEqual(restored.issues, []);
  assert.equal(entry(await indexer.readFolderIndex(scope.id), 'Proyectos/plan.md').state, 'indexed');
});

test('los registros no comprobables del recorrido quedan sin verificar, sin falsas bajas', () => {
  const previous = [
    { path: 'A', type: 'directory', size: null, modifiedAt: null, changedAt: null, createdAt: null, state: 'indexed', reason: null },
    { path: 'A/viejo.txt', type: 'file', size: 3, modifiedAt: null, changedAt: null, createdAt: null, state: 'indexed', reason: null },
    { path: 'B', type: 'directory', size: null, modifiedAt: null, changedAt: null, createdAt: null, state: 'indexed', reason: null },
    { path: 'B/dentro.txt', type: 'file', size: 1, modifiedAt: null, changedAt: null, createdAt: null, state: 'indexed', reason: null },
  ];
  const { entries, issues } = mergeScan({
    records: [
      { path: 'A', error: 'EPERM' },
      record('B', { type: 'directory', size: null, listing: 'OTHER_VOLUME' }),
      { path: 'nuevo', error: 'EACCES' },
    ],
    issues: [{ path: '', code: 'NAME_NOT_UTF8' }],
  }, { previous, maxEntries: 10 });
  assert.deepEqual(entries.map((item) => [item.path, item.type, item.state, item.reason]), [
    ['A', 'directory', 'unverified', 'EPERM'],
    ['A/viejo.txt', 'file', 'unverified', 'EPERM'],
    ['B', 'directory', 'not-listed', 'OTHER_VOLUME'],
    ['B/dentro.txt', 'file', 'unverified', 'OTHER_VOLUME'],
    ['nuevo', 'unknown', 'unverified', 'EACCES'],
  ]);
  assert.equal(entries[1].size, 3);
  assert.deepEqual(issues, [{ path: '', code: 'NAME_NOT_UTF8' }]);
  assert.throws(() => mergeScan({ records: [{ path: 'A', error: 'EPERM' }], issues: [] },
    { previous, maxEntries: 1 }), { code: 'INDEX_LIMIT_EXCEEDED' });
});

test('una carpeta sustituida por un enlace hacia fuera no aporta nombres ajenos', async (t) => {
  const { root, base, folder, scope, indexer } = await fixture(t);
  await indexer.indexFolder(scope.id);
  const outside = path.join(root, 'Fuera del ámbito');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'nombre-ajeno.txt'), 'ajeno');
  await fs.rename(path.join(folder, 'Proyectos'), path.join(root, 'Proyectos movidos'));
  await fs.symlink(outside, path.join(folder, 'Proyectos'), linkType);
  const result = await indexer.indexFolder(scope.id);
  assert.deepEqual(result.changes, {
    added: [], modified: ['Proyectos'], removed: ['Proyectos/Fotos', 'Proyectos/plan.md'],
  });
  const stored = await fs.readFile(path.join(base, `folder-index-${scope.id}.json`), 'utf8');
  assert.ok(!stored.includes('nombre-ajeno'));
});

test('sin el recorrido seguro se deniega la indexación y no se escribe nada', async (t) => {
  const { base, motor, scope } = await fixture(t);
  const unavailable = createFolderIndexer({
    baseDirectory: base, resolveScope: registryResolver(motor),
    pythonExecutable: path.join(base, 'python-inexistente'),
  });
  await assert.rejects(unavailable.indexFolder(scope.id), { code: 'SAFE_SCAN_UNAVAILABLE' });
  assert.deepEqual((await fs.readdir(base)).filter((name) => name.startsWith('folder-index-')), []);
});

test('una raíz desaparecida, redirigida o denegada falla sin alterar el índice anterior', async (t) => {
  const { root, base, folder, scope, indexer } = await fixture(t);
  await indexer.indexFolder(scope.id);
  const filename = path.join(base, `folder-index-${scope.id}.json`);
  const saved = await fs.readFile(filename, 'utf8');
  const moved = path.join(root, 'movida');
  await fs.rename(folder, moved);
  await assert.rejects(indexer.indexFolder(scope.id), { code: 'SCOPE_UNAVAILABLE' });
  await fs.symlink(moved, folder, linkType);
  await assert.rejects(indexer.indexFolder(scope.id), { code: 'SCOPE_CHANGED' });
  assert.equal(await fs.readFile(filename, 'utf8'), saved);
  assert.equal((await indexer.readFolderIndex(scope.id)).generation, 1);

  await fs.unlink(folder).catch(() => fs.rmdir(folder));
  await fs.rename(moved, folder);
  const restore = await denyListing(folder);
  try {
    await assert.rejects(indexer.indexFolder(scope.id), { code: 'SCOPE_UNAVAILABLE' });
  } finally {
    await restore();
  }
  assert.equal(await fs.readFile(filename, 'utf8'), saved);
});

test('solo indexa ámbitos que el Motor resuelve como autorizados', async (t) => {
  const { root, base, folder, motor, scope, indexer } = await fixture(t);
  assert.throws(() => createFolderIndexer({ baseDirectory: base }), { code: 'INVALID_SCOPE_RESOLVER' });
  assert.throws(() => createFolderIndexer({ baseDirectory: 'relativa', resolveScope: async () => {} }), { code: 'INVALID_BASE' });
  assert.throws(() => createFolderIndexer({ baseDirectory: base, resolveScope: async () => {}, maxEntries: 0 }), { code: 'INVALID_INDEX_LIMIT' });
  for (const invalid of [folder, '../escape', '', 'A'.repeat(64), null]) {
    await assert.rejects(indexer.indexFolder(invalid), { code: 'INVALID_SCOPE_ID' });
    await assert.rejects(indexer.readFolderIndex(invalid), { code: 'INVALID_SCOPE_ID' });
  }
  await assert.rejects(indexer.indexFolder('b'.repeat(64)), { code: 'FOLDER_NOT_AUTHORIZED' });

  const forged = (scopePath, id = scope.id) => createFolderIndexer({
    baseDirectory: base, resolveScope: async () => ({ id, path: scopePath }),
  });
  await assert.rejects(forged('relativa').indexFolder(scope.id), { code: 'INVALID_SCOPE' });
  await assert.rejects(forged(folder, 'c'.repeat(64)).indexFolder(scope.id), { code: 'INVALID_SCOPE' });
  await assert.rejects(forged(root).indexFolder(scope.id), { code: 'SCOPE_OVERLAPS_INTERNAL' });
  await assert.rejects(forged(path.join(base, 'dentro')).indexFolder(scope.id), { code: 'SCOPE_OVERLAPS_INTERNAL' });
  assert.deepEqual((await fs.readdir(base)).filter((name) => name.startsWith('folder-index-')), []);

  await indexer.indexFolder(scope.id);
  assert.equal(await motor.revokeFolder(scope.id), true);
  await assert.rejects(indexer.indexFolder(scope.id), { code: 'FOLDER_NOT_AUTHORIZED' });
  await assert.rejects(indexer.readFolderIndex(scope.id), { code: 'FOLDER_NOT_AUTHORIZED' });
  assert.equal(await indexer.removeFolderIndex(scope.id), false); // Motor ya lo eliminó al retirar.
  assert.equal(await indexer.removeFolderIndex(scope.id), false);
});

test('una retirada durante el recorrido impide publicar el índice', async (t) => {
  const { base, motor, scope } = await fixture(t);
  const resolve = registryResolver(motor);
  let calls = 0;
  const indexer = createFolderIndexer({ baseDirectory: base, resolveScope: async (id) => {
    calls += 1;
    if (calls === 3) await motor.revokeFolder(id);
    return resolve(id);
  } });
  await assert.rejects(indexer.indexFolder(scope.id), { code: 'FOLDER_NOT_AUTHORIZED' });
  assert.deepEqual((await fs.readdir(base)).filter((name) => name.startsWith('folder-index-')), []);
});

test('superar el límite de entradas no publica un índice parcial', async (t) => {
  const { base, folder, motor, scope, indexer } = await fixture(t);
  await indexer.indexFolder(scope.id);
  const saved = await fs.readFile(path.join(base, `folder-index-${scope.id}.json`), 'utf8');
  const limited = createFolderIndexer({ baseDirectory: base, resolveScope: registryResolver(motor), maxEntries: 4 });
  await fs.writeFile(path.join(folder, 'quinto.txt'), 'ficticio');
  await assert.rejects(limited.indexFolder(scope.id), { code: 'INDEX_LIMIT_EXCEEDED' });
  assert.equal(await fs.readFile(path.join(base, `folder-index-${scope.id}.json`), 'utf8'), saved);
});

test('los índices corruptos o enlazados fallan de forma explícita y no se reparan', async (t) => {
  const { root, base, scope, indexer } = await fixture(t);
  const result = await indexer.indexFolder(scope.id);
  const filename = path.join(base, `folder-index-${scope.id}.json`);
  const valid = JSON.parse(await fs.readFile(filename, 'utf8'));
  const variants = [
    '{incompleto', 'null', '{}',
    JSON.stringify({ ...valid, version: 4 }),
    JSON.stringify({ ...valid, scopeId: 'd'.repeat(64) }),
    JSON.stringify({ ...valid, entries: [...valid.entries].reverse() }),
    JSON.stringify({ ...valid, entries: [{ ...valid.entries[0], path: '../fuera' }] }),
    JSON.stringify({ ...valid, entries: [{ ...valid.entries[0], extra: true }] }),
    JSON.stringify({ ...valid, entries: [{ ...valid.entries[0], identity: 'identidad inventada' }] }),
  ];
  for (const text of variants) {
    await fs.writeFile(filename, text);
    await assert.rejects(indexer.readFolderIndex(scope.id), (error) => ['RECORD_CORRUPT', 'INDEX_CORRUPT'].includes(error.code));
    await assert.rejects(indexer.indexFolder(scope.id), (error) => ['RECORD_CORRUPT', 'INDEX_CORRUPT'].includes(error.code));
    assert.equal(await fs.readFile(filename, 'utf8'), text);
  }
  assert.equal(await indexer.removeFolderIndex(scope.id), true);
  const destination = path.join(root, 'destino-ajeno');
  await fs.mkdir(destination);
  await fs.symlink(destination, filename, linkType);
  await assert.rejects(indexer.readFolderIndex(scope.id), { code: 'RECORD_LINK' });
  await assert.rejects(indexer.indexFolder(scope.id), { code: 'RECORD_LINK' });
  assert.deepEqual(await fs.readdir(destination), []);
  assert.equal(result.generation, 1);
});

test('serializa indexaciones del mismo ámbito incluso entre instancias sin recorridos simultáneos', async (t) => {
  const { base, motor, scope, indexer } = await fixture(t);
  const results = await Promise.all([indexer.indexFolder(scope.id), indexer.indexFolder(scope.id)]);
  // Admission is shared across processes: equally ranked requests may arrive
  // in either order, but their publications must remain sequential.
  assert.deepEqual(results.toSorted((a, b) => a.generation - b.generation)
    .map(({ mode, generation }) => ({ mode, generation })), [
    { mode: 'initial', generation: 1 }, { mode: 'reconciliation', generation: 2 },
  ]);

  const resolve = registryResolver(motor);
  const other = createFolderIndexer({ baseDirectory: base, resolveScope: resolve });
  const concurrent = await Promise.all([indexer.indexFolder(scope.id), other.indexFolder(scope.id)]);
  assert.deepEqual(concurrent.map(item => item.generation).sort(), [3, 4]);
  assert.equal((await indexer.readFolderIndex(scope.id)).generation, 4);
});

test('ámbitos distintos mantienen índices independientes', async (t) => {
  const { root, base, motor, scope, indexer } = await fixture(t);
  const second = path.join(root, 'Segunda carpeta');
  await fs.mkdir(second);
  await fs.writeFile(path.join(second, 'unico.txt'), 'ficticio');
  const other = await motor.authorizeFolder(second);
  await Promise.all([indexer.indexFolder(scope.id), indexer.indexFolder(other.id)]);
  assert.deepEqual(paths(await indexer.readFolderIndex(other.id)), ['unico.txt']);
  assert.equal(await indexer.removeFolderIndex(other.id), true);
  assert.equal((await indexer.readFolderIndex(scope.id)).entries.length, 4);
  assert.equal((await fs.readdir(base)).filter((name) => name.startsWith('folder-index-')).length, 1);
});

test('las tuberías y otros especiales se registran sin abrirse', { skip: process.platform === 'win32' && 'FIFO POSIX' }, async (t) => {
  const { folder, scope, indexer } = await fixture(t);
  const fifo = path.join(folder, 'tuberia');
  const made = spawnSync('mkfifo', [fifo]);
  assert.equal(made.status, 0, String(made.stderr));
  const result = await indexer.indexFolder(scope.id);
  assert.equal(result.totals.other, 1);
  const index = await indexer.readFolderIndex(scope.id);
  assert.deepEqual({ type: entry(index, 'tuberia').type, size: entry(index, 'tuberia').size }, { type: 'other', size: null });
});
