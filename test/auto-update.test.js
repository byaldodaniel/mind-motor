import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, createHash, sign } from 'node:crypto';
import { checkForUpdate, discoverUpdate, downloadUpdate, installDownloaded, launch, githubDownload, verifyFeed, readUpdateState } from '../src/auto-update.js';
import { UNIVERSAL_TARGETS } from '../src/product-files.js';

async function fixture(t, { legacy = false, revision = 1 } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mind-update-channel-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const motor = path.join(root, ...(legacy ? ['Motor'] : ['Sistema', 'Programa', 'Motor']));
  await fs.mkdir(path.join(motor, 'src'), { recursive: true });
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const key = publicKey.export({ type: 'spki', format: 'pem' });
  const manifest = { format: 'mind-product', version: 1, mindVersion: legacy ? '1.0.2' : '1.0.3', platform: 'win32', arch: 'x64', targets: UNIVERSAL_TARGETS, files: {},
    ...(legacy ? {} : { layoutVersion: 2, packageRevision: revision, updateProtocolVersion: 2 }) };
  const manifestBytes = JSON.stringify(manifest), manifestSha256 = createHash('sha256').update(manifestBytes).digest('hex');
  await fs.writeFile(path.join(root, ...(legacy ? [] : ['Sistema']), 'mind-producto.json'), manifestBytes);
  await fs.writeFile(path.join(motor, 'src', 'update-channel.json'), JSON.stringify({ repository: 'owner/distribution', url: 'https://github.com/owner/distribution/releases/latest/download/stable.json', publicKey: key }));
  const bytes = Buffer.from('paquete ficticio');
  const feed = { format: 'mind-update', version: 2, mindVersion: '1.0.3', packageRevision: revision + 1, layoutVersion: 2, updateProtocolVersion: 2, manifestSha256,
    packages: [{ platform: 'win32', arch: 'x64', targets: UNIVERSAL_TARGETS, url: 'https://github.com/owner/distribution/releases/download/v1.0.3/mind-r2.zip', sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }] };
  const envelope = () => { const payload = Buffer.from(JSON.stringify(feed)); return { payload: payload.toString('base64'), signature: sign(null, payload, privateKey).toString('base64') }; };
  let installed = 0, requests = 0, source, clock = Date.now();
  return { root, feed, envelope, key, manifestSha256, bytes,
    advance(ms) { clock += ms; }, get requests() { return requests; }, get installed() { return installed; }, get source() { return source; },
    options: { root, now: () => clock, random: () => 0, acquireLock: async () => async () => {},
      fetcher: async url => { requests++; return String(url).endsWith('stable.json') ? new Response(JSON.stringify(envelope())) : new Response(bytes); },
      install: async options => { installed++; source = options.source; assert.deepEqual(await fs.readFile(source), bytes); assert.equal(options.expectedRelease.mindVersion, '1.0.3'); assert.equal(options.expectedRelease.packageRevision, revision + 1); },
    },
  };
}

test('firma v2, revisión superior de misma 1.0.3, descarga única e instalación verificada', async t => {
  const f = await fixture(t);
  const result = await checkForUpdate(f.options);
  assert.equal(result.status, 'actualizada'); assert.equal(f.installed, 1); assert.equal(f.requests, 2);
  await assert.rejects(fs.stat(f.source), { code: 'ENOENT' });
  assert.equal((await readUpdateState(f.root)).phase, 'actualizada');
});

test('misma revisión y manifiesto es al día; no descarga paquete y limita comprobaciones por chat', async t => {
  const f = await fixture(t); f.feed.packageRevision = 1;
  assert.equal((await checkForUpdate(f.options)).status, 'al-dia');
  assert.equal(f.requests, 1); assert.equal(f.installed, 0);
  assert.equal((await checkForUpdate(f.options)).cached, true); assert.equal(f.requests, 1);
});

test('misma versión y revisión con otro manifiesto se rechaza', async t => {
  const f = await fixture(t); f.feed.packageRevision = 1; f.feed.manifestSha256 = 'a'.repeat(64);
  const result = await checkForUpdate(f.options);
  assert.equal(result.kind, 'integridad'); assert.equal(f.installed, 0);
});

test('legacy recibe estado de reparación requerida antes de descargar layout incompatible', async t => {
  const f = await fixture(t, { legacy: true });
  assert.equal((await checkForUpdate(f.options)).status, 'requiere-reparacion'); assert.equal(f.requests, 1); assert.equal(f.installed, 0);
});

test('sesiones reales dejan el paquete pendiente y el siguiente intento lo reutiliza sin red', async t => {
  const f = await fixture(t); let attempts = 0;
  const install = async options => { attempts++; assert.deepEqual(await fs.readFile(options.source), f.bytes); if (attempts === 1) throw Object.assign(new Error('Hay sesiones reales'), { code: 'MIND_IN_USE', prepared: true }); };
  const first = await checkForUpdate({ ...f.options, install });
  assert.equal(first.phase, 'espera-sesiones'); assert.equal(f.requests, 2);
  assert.equal((await checkForUpdate({ ...f.options, install })).cached, true); assert.equal(attempts, 1);
  f.advance(31_000);
  const second = await checkForUpdate({ ...f.options, install, fetcher: async () => { throw new Error('No debe usar la red'); } });
  assert.equal(second.status, 'actualizada'); assert.equal(attempts, 2); assert.equal(f.requests, 2);
});

test('sesión no verificable se informa distinta de sesión activa', async t => {
  const f = await fixture(t);
  const result = await checkForUpdate({ ...f.options, install: async () => { throw Object.assign(new Error('Identidad desconocida'), { code: 'SESSION_IDENTITY_UNKNOWN', prepared: true }); } });
  assert.equal(result.phase, 'espera-verificacion'); assert.equal(result.kind, 'sesiones-no-verificables');
});

test('clasifica DNS, permisos y servidor sin afirmar que la copia está al día', async t => {
  for (const [code, kind] of [['ENOTFOUND', 'dns'], ['EACCES', 'permisos']]) {
    const f = await fixture(t);
    const result = await checkForUpdate({ ...f.options, fetcher: async () => { throw Object.assign(new Error('fetch failed'), { cause: { code } }); } });
    assert.equal(result.status, 'aplazada'); assert.equal(result.kind, kind);
    const state = await readUpdateState(f.root); assert.equal(state.lastError.retryable, code === 'ENOTFOUND'); assert.ok(state.nextCheckAt);
  }
  const f = await fixture(t);
  assert.equal((await checkForUpdate({ ...f.options, fetcher: async () => new Response('fallo', { status: 503 }) })).kind, 'http');
});

test('firma falsa, contenido alterado, URL ajena y universal incompleto no se instalan', async t => {
  for (const scenario of ['firma', 'contenido', 'url', 'destinos']) {
    const f = await fixture(t), options = { ...f.options };
    if (scenario === 'contenido') f.feed.packages[0].sha256 = '0'.repeat(64);
    if (scenario === 'url') f.feed.packages[0].url = 'https://evil.example/mind.zip';
    if (scenario === 'destinos') f.feed.packages[0].targets = UNIVERSAL_TARGETS.slice(1);
    if (scenario === 'firma') options.fetcher = async () => new Response(JSON.stringify({ ...f.envelope(), signature: Buffer.alloc(64).toString('base64') }));
    assert.equal((await checkForUpdate(options)).status, 'aplazada', scenario); assert.equal(f.installed, 0);
  }
});

test('coordinador ocupado no modifica estado ni descarga otro paquete', async t => {
  const f = await fixture(t);
  const result = await checkForUpdate({ ...f.options, acquireLock: async () => { throw Object.assign(new Error('ocupado'), { code: 'LOCK_BUSY' }); } });
  assert.equal(result.phase, 'otra-operacion'); assert.equal(f.requests, 0); assert.equal(await readUpdateState(f.root), null);
});

test('el canal firmado exige identidad nueva válida y origen de distribución confiado', async t => {
  const f = await fixture(t); f.feed.packageRevision = -1;
  assert.throws(() => verifyFeed(f.envelope(), f.key));
  for (const url of ['http://github.com/owner/distribution/releases/a', 'https://github.com.evil/owner/distribution/releases/a', 'https://github.com/other/repo/releases/a']) assert.throws(() => githubDownload(url, 'owner/distribution'));
});

test('la actualización confirmada informa limpieza pendiente sin presentarse como fallo de instalación', async t => {
  const f = await fixture(t);
  const result = await checkForUpdate({ ...f.options, install: async () => ({ cleanupPending: true }) });
  assert.equal(result.status, 'actualizada'); assert.equal(result.cleanupPending, true);
  assert.equal((await readUpdateState(f.root)).phase, 'limpieza-pendiente');
});

test('un estado corrupto se conserva y no provoca otra descarga', async t => {
  const f = await fixture(t);
  const directory = path.join(f.root, 'Sistema', 'Actualizaciones');
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, 'estado.json'), bad = '{corrupto';
  await fs.writeFile(file, bad);
  const result = await checkForUpdate(f.options);
  assert.equal(result.phase, 'estado-no-verificable');
  assert.equal(await fs.readFile(file, 'utf8'), bad); assert.equal(f.requests, 0);
});

test('una copia corregida rechaza canal de protocolo anterior aunque lleve firma válida', async t => {
  const f = await fixture(t); f.feed.version = 1;
  const result = await checkForUpdate(f.options);
  assert.equal(result.code, 'UPDATE_PROTOCOL_INVALID'); assert.equal(f.installed, 0);
});

const resume = (body, calls) => async (url, init) => {
  calls.push({ url: String(url), range: init?.headers?.Range });
  return body(url, init);
};
const partialPath = (f, name = '.zip.parcial') => path.join(f.root, 'Sistema', 'Actualizaciones', 'descargas', createHash('sha256').update(f.bytes).digest('hex') + name);

test('descubrir solo consulta el canal, no descarga el paquete y deja la fase disponible', async t => {
  const f = await fixture(t);
  const result = await discoverUpdate(f.options);
  assert.equal(result.status, 'disponible'); assert.equal(f.requests, 1); assert.equal(f.installed, 0);
  const state = await readUpdateState(f.root);
  assert.equal(state.version, 2); assert.equal(state.phase, 'disponible'); assert.equal(state.lastError, null);
  assert.equal(state.package.sha256, createHash('sha256').update(f.bytes).digest('hex')); assert.equal(state.package.bytes, f.bytes.length);
  assert.ok(state.envelope); assert.equal(state.release.packageRevision, 2);
  await assert.rejects(fs.stat(path.join(f.root, 'Sistema', 'Actualizaciones', 'descargas')), { code: 'ENOENT' });
});

test('descubrir sin red conserva disponible, guarda lastError y un éxito posterior lo limpia', async t => {
  const f = await fixture(t);
  await discoverUpdate(f.options);
  f.advance(7 * 60 * 60 * 1000);
  const failed = await discoverUpdate({ ...f.options, fetcher: async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } }); } });
  assert.equal(failed.status, 'aplazada'); assert.equal(failed.phase, 'disponible');
  let state = await readUpdateState(f.root);
  assert.equal(state.phase, 'disponible'); assert.equal(state.lastError.kind, 'dns'); assert.equal(state.lastError.retryable, true);
  assert.ok(state.envelope); assert.ok(Date.parse(state.nextCheckAt) > Date.parse(state.lastError.at));
  f.advance(2 * 60 * 60 * 1000);
  assert.equal((await discoverUpdate(f.options)).status, 'disponible');
  state = await readUpdateState(f.root);
  assert.equal(state.lastError, null); assert.equal(state.phase, 'disponible');
});

test('descubrir no pisa una operación en curso', async t => {
  const f = await fixture(t);
  await discoverUpdate(f.options);
  f.advance(7 * 60 * 60 * 1000);
  const before = f.requests;
  for (const phase of ['instalando', 'descargando']) {
    const file = path.join(f.root, 'Sistema', 'Actualizaciones', 'estado.json');
    const state = JSON.parse(await fs.readFile(file, 'utf8')); state.phase = phase; await fs.writeFile(file, JSON.stringify(state));
    assert.equal((await discoverUpdate(f.options)).status, 'en-curso');
    assert.equal((await readUpdateState(f.root)).phase, phase);
  }
  assert.equal(f.requests, before);
});

test('descarga reanudable: 206 con Range anexa al parcial y deja descargada sin instalar', async t => {
  const f = await fixture(t); await discoverUpdate(f.options);
  await fs.mkdir(path.dirname(partialPath(f)), { recursive: true });
  await fs.writeFile(partialPath(f), f.bytes.subarray(0, 5));
  const calls = [];
  const fetcher = resume(async () => new Response(f.bytes.subarray(5), { status: 206, headers: { 'content-range': `bytes 5-${f.bytes.length - 1}/${f.bytes.length}` } }), calls);
  const result = await downloadUpdate({ ...f.options, fetcher });
  assert.equal(result.status, 'descargada'); assert.equal(calls.length, 1); assert.equal(calls[0].range, 'bytes=5-');
  assert.deepEqual(await fs.readFile(partialPath(f, '.zip')), f.bytes);
  await assert.rejects(fs.stat(partialPath(f)), { code: 'ENOENT' });
  assert.equal((await readUpdateState(f.root)).phase, 'descargada'); assert.equal(f.installed, 0);
});

test('descarga reanudable: un servidor que ignora Range y responde 200 reinicia desde cero', async t => {
  const f = await fixture(t); await discoverUpdate(f.options);
  await fs.mkdir(path.dirname(partialPath(f)), { recursive: true });
  await fs.writeFile(partialPath(f), Buffer.from('basura'));
  const calls = [];
  const result = await downloadUpdate({ ...f.options, fetcher: resume(async () => new Response(f.bytes), calls) });
  assert.equal(result.status, 'descargada'); assert.equal(calls[0].range, 'bytes=6-');
  assert.deepEqual(await fs.readFile(partialPath(f, '.zip')), f.bytes);
});

test('un parcial cuya huella final no coincide se rechaza y no queda como descargado', async t => {
  const f = await fixture(t); await discoverUpdate(f.options);
  await fs.mkdir(path.dirname(partialPath(f)), { recursive: true });
  await fs.writeFile(partialPath(f), Buffer.from('XXXXX'));
  const result = await downloadUpdate({ ...f.options, fetcher: async () => new Response(f.bytes.subarray(5), { status: 206 }) });
  assert.equal(result.status, 'aplazada'); assert.equal(result.kind, 'integridad');
  await assert.rejects(fs.stat(partialPath(f, '.zip')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(partialPath(f)), { code: 'ENOENT' });
  const state = await readUpdateState(f.root);
  assert.equal(state.phase, 'disponible'); assert.equal(state.lastError.kind, 'integridad'); assert.equal(f.installed, 0);
});

test('descargar e instalar exigen su fase y no se saltan etapas', async t => {
  const f = await fixture(t);
  assert.equal((await downloadUpdate(f.options)).status, 'fase-incorrecta');
  await discoverUpdate(f.options);
  assert.equal((await installDownloaded(f.options)).status, 'fase-incorrecta'); assert.equal(f.installed, 0);
  assert.equal((await downloadUpdate(f.options)).status, 'descargada'); assert.equal(f.installed, 0);
  assert.equal((await installDownloaded(f.options)).status, 'actualizada'); assert.equal(f.installed, 1);
  assert.equal((await readUpdateState(f.root)).phase, 'actualizada');
});

test('un estado versión 1 con kind y retryable se lee como versión 2 con la fase limpia', async t => {
  const f = await fixture(t);
  const directory = path.join(f.root, 'Sistema', 'Actualizaciones');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'estado.json'), JSON.stringify({ format: 'mind-update-state', version: 1, phase: 'al-dia',
    reason: 'fetch failed', code: 'ECONNRESET', kind: 'conexion', retryable: true, attempts: 2, updatedAt: '2026-01-01T00:00:00.000Z' }));
  const state = await readUpdateState(f.root);
  assert.equal(state.version, 2); assert.equal(state.phase, 'al-dia');
  assert.deepEqual(state.lastError, { code: 'ECONNRESET', kind: 'conexion', retryable: true, message: 'fetch failed', at: '2026-01-01T00:00:00.000Z' });
  for (const key of ['reason', 'code', 'kind', 'retryable']) assert.equal(key in state, false);
  const { writeUpdateState } = await import('../src/update-state.js');
  await writeUpdateState(f.root, state);
  assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'estado.json'), 'utf8')).version, 2);
});

test('launch ya no descubre, descarga ni instala por su cuenta', () => {
  assert.equal(/checkForUpdate|discoverUpdate|downloadUpdate|installDownloaded|MIND_UPDATE_RESTART:/u.test(launch.toString()), false);
});

const notes = () => ({ nombre: 'Novedades', resumen: 'Resumen claro.', cambios: [{ titulo: 'Mejora', detalle: '', tipo: 'mejora' }], importancia: 'normal',
  impacto_datos: { base: 'sin-cambios', conversaciones: 'intactas', carpetas_autorizadas: 'intactas', nota: '' },
  comprobado: { baseFormatVersion: 2, paqueteBytes: 16, programaBytes: 100, archivos: 3, componentes: [{ name: 'node', version: '24.0.0', target: 'win32-x64' }], gruposCambiados: null, descargaParcialBytes: null } });

test('canal sin novedades sigue siendo válido y devuelve novedades null', async t => {
  const f = await fixture(t);
  assert.equal(verifyFeed(f.envelope(), f.key).novedades, null);
});

test('canal con novedades válidas las devuelve normalizadas y saneadas', async t => {
  const f = await fixture(t); f.feed.novedades = { ...notes(), nombre: '  Con\u0007trol  ' };
  const feed = verifyFeed(f.envelope(), f.key);
  assert.equal(feed.novedades.nombre, 'Con trol');
  assert.equal(feed.novedades.comprobado.archivos, 3);
});

test('novedades inválidas rechazan el canal como integridad', async t => {
  for (const mutate of [n => { n.cambios = []; }, n => { n.importancia = 'urgente'; }, n => { delete n.comprobado; }, n => { n.extra = 1; }]) {
    const f = await fixture(t); f.feed.novedades = notes(); mutate(f.feed.novedades);
    assert.throws(() => verifyFeed(f.envelope(), f.key), { code: 'UPDATE_NOTES_INVALID' });
    const result = await discoverUpdate(f.options);
    assert.equal(result.status, 'aplazada'); assert.equal(result.kind, 'integridad'); assert.equal(f.installed, 0);
  }
});

test('descubrir guarda las novedades con la oferta y las limpia al quedar al día o actualizada', async t => {
  const f = await fixture(t); f.feed.novedades = notes();
  const result = await discoverUpdate(f.options);
  assert.equal(result.novedades.nombre, 'Novedades');
  assert.equal((await readUpdateState(f.root)).novedades.comprobado.programaBytes, 100);
  assert.equal((await discoverUpdate(f.options)).novedades.resumen, 'Resumen claro.');
  assert.equal((await downloadUpdate(f.options)).status, 'descargada');
  assert.equal((await installDownloaded(f.options)).status, 'actualizada');
  assert.equal((await readUpdateState(f.root)).novedades, null);
  const g = await fixture(t); g.feed.novedades = notes(); await discoverUpdate(g.options);
  g.feed.packageRevision = 1; g.advance(7 * 60 * 60 * 1000);
  assert.equal((await discoverUpdate(g.options)).status, 'al-dia');
  assert.equal((await readUpdateState(g.root)).novedades, null);
});

/**
 * Node ejecutable para un producto ficticio. El enlace duro es lo más rápido,
 * pero Windows lo deniega (EPERM) si el Node de la prueba está en una carpeta
 * protegida como Program Files, y no existe entre volúmenes (EXDEV): se copia.
 */
async function linkOrCopyNode(target) {
  try {
    await fs.link(process.execPath, target);
  } catch (error) {
    if (!['EPERM', 'EACCES', 'EXDEV'].includes(error.code)) throw error;
    await fs.copyFile(process.execPath, target);
  }
}

test('el arranque que cargó la entrega anterior cede argumentos y código de salida al iniciador actual', async t => {
  const { relayUpdatedProgram } = await import('../src/auto-update.js');
  const { productRuntime } = await import('../src/layout.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mind-launch-relay-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const manifest = { layoutVersion: 2 };
  const node = productRuntime(root, manifest).nodeExecutable;
  await fs.mkdir(path.dirname(node), { recursive: true });
  await linkOrCopyNode(node);
  const output = path.join(root, 'argumentos.json');
  await fs.writeFile(path.join(root, 'Sistema/arranque.cjs'),
    'require("node:fs").writeFileSync(process.argv[2],JSON.stringify(process.argv.slice(3)));process.exitCode=7;');
  assert.equal(await relayUpdatedProgram(root, manifest, [output, 'mcp', '--carpeta', 'carpeta con espacios']), 7);
  assert.deepEqual(JSON.parse(await fs.readFile(output, 'utf8')), ['mcp', '--carpeta', 'carpeta con espacios']);
});

test('bin directo espera antes de leer Programa o manifiesto y abre la entrega actual', async t => {
  const { pathToFileURL } = await import('node:url');
  const { randomUUID } = await import('node:crypto');
  const { productRuntime } = await import('../src/layout.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mind-direct-handoff-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const motor = path.join(root, 'Sistema/Programa/Motor');
  await fs.mkdir(motor, { recursive: true });
  await fs.cp(new URL('../src', import.meta.url), path.join(motor, 'src'), { recursive: true });
  await fs.writeFile(path.join(motor, 'package.json'), '{"type":"module"}');
  const implementation = await import(pathToFileURL(path.join(motor, 'src/auto-update.js')).href);
  const identity = await import(pathToFileURL(path.join(motor, 'src/process-identity.js')).href);
  const handoff = await import(pathToFileURL(path.join(motor, 'src/update-handoff-state.js')).href);
  const pythonExecutable = process.env.MIND_TEST_BUNDLED_PYTHON || process.env.MIND_TEST_PYTHON;
  const owner = await identity.identifyCurrentProcess({ pythonExecutable });
  assert.ok(owner.processBirth);
  const manifest = { format: 'mind-product', version: 1, mindVersion: '1.0.5', platform: 'win32', arch: 'x64',
    packageRevision: 1, layoutVersion: 2, updateProtocolVersion: 2, files: {} };
  const runtime = productRuntime(root, manifest);
  await fs.mkdir(path.dirname(runtime.nodeExecutable), { recursive: true });
  await linkOrCopyNode(runtime.nodeExecutable);
  const output = path.join(root, 'reabierto.json');
  await fs.writeFile(path.join(root, 'Sistema/arranque.cjs'),
    'require("node:fs").writeFileSync(process.argv[2],JSON.stringify(process.argv.slice(3)));');
  const record = { id: randomUUID(), phase: 'aplicando', owner };
  const snapshotPython = path.join(root, 'Sistema/Actualizaciones/Relevos', record.id, 'Python', process.platform === 'win32' ? 'python.exe' : 'bin/python3');
  await fs.mkdir(path.dirname(snapshotPython), { recursive: true });
  await fs.writeFile(snapshotPython, 'snapshot ficticio: owner es esta instancia');
  await handoff.writeHandoff(root, record);
  const aside = path.join(root, 'Programa-apartado');
  await fs.rename(path.join(root, 'Sistema/Programa'), aside);
  let finished = false;
  const launch = implementation.launch([output, 'mcp']).then(value => { finished = true; return value; });
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(finished, false);
  await fs.rename(aside, path.join(root, 'Sistema/Programa'));
  await fs.writeFile(path.join(root, 'Sistema/mind-producto.json'), JSON.stringify(manifest));
  await handoff.writeHandoff(root, { ...record, phase: 'completada' });
  assert.equal(await launch, 0);
  assert.deepEqual(JSON.parse(await fs.readFile(output, 'utf8')), ['mcp']);
});

test('reanuda un parcial cuyo estado quedó en descargando tras un corte', async t => {
  const { writeUpdateState } = await import('../src/update-state.js');
  const f = await fixture(t);
  await discoverUpdate(f.options);
  await fs.mkdir(path.dirname(partialPath(f)), { recursive: true });
  await fs.writeFile(partialPath(f), f.bytes.subarray(0, 5));
  await writeUpdateState(f.root, { ...await readUpdateState(f.root), phase: 'descargando' });
  const calls = [];
  const result = await downloadUpdate({ ...f.options, fetcher: resume(async () => new Response(f.bytes.subarray(5),
    { status: 206, headers: { 'content-range': `bytes 5-${f.bytes.length - 1}/${f.bytes.length}` } }), calls) });
  assert.equal(result.status, 'descargada');
  assert.equal(calls[0].range, 'bytes=5-');
  assert.deepEqual(await fs.readFile(partialPath(f, '.zip')), f.bytes);
});

test('tras instalación interrumpida reutiliza ZIP sólo después de validar oferta y huella', async t => {
  const { writeUpdateState } = await import('../src/update-state.js');
  const { getVerifiedOffer } = await import('../src/auto-update.js');
  const f = await fixture(t);
  await discoverUpdate(f.options);
  await downloadUpdate(f.options);
  for (const phase of ['instalando', 'espera-sesiones', 'espera-verificacion', 'fallida']) {
    await writeUpdateState(f.root, { ...await readUpdateState(f.root), phase });
    assert.equal((await getVerifiedOffer({ root: f.root })).selected.sha256, f.feed.packages[0].sha256);
    const result = await downloadUpdate({ ...f.options, fetcher: async () => assert.fail('el ZIP intacto ya está disponible') });
    assert.equal(result.status, 'descargada', phase);
  }
  const valid = await readUpdateState(f.root);
  await writeUpdateState(f.root, { ...valid, phase: 'fallida', envelope: { ...valid.envelope, signature: Buffer.alloc(64).toString('base64') } });
  await assert.rejects(getVerifiedOffer({ root: f.root }), /firma/iu);
  const invalid = await downloadUpdate({ ...f.options, fetcher: async () => assert.fail('no descarga una oferta sin firma válida') });
  assert.equal(invalid.kind, 'integridad');
  await writeUpdateState(f.root, { ...valid, phase: 'instalando' });
  await fs.writeFile(partialPath(f, '.zip'), 'ZIP alterado');
  let requests = 0;
  const redownloaded = await downloadUpdate({ ...f.options, fetcher: async () => { requests++; return new Response(f.bytes); } });
  assert.equal(redownloaded.status, 'descargada');
  assert.equal(requests, 1, 'una huella incorrecta exige descargar de nuevo');
  await writeUpdateState(f.root, { ...valid, phase: 'fallida', envelope: null });
  await assert.rejects(getVerifiedOffer({ root: f.root }), { code: 'UPDATE_STATE_INVALID' });
});
