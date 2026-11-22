import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { productPaths, productRuntime, resolveLayout } from '../../src/layout.js';
import { openSession } from '../../src/session.js';
import { releaseOf } from '../../src/package-descriptor.js';
import { UNIVERSAL_TARGETS } from '../../src/product-files.js';
import { updateConsentPaths } from '../../src/update-consent.js';
import { updateStatePaths, writeUpdateState } from '../../src/update-state.js';
import { extractR3, r3Commit } from './r3-fixture.mjs';
import { RUNS } from './runs.mjs';

const binary = process.env.MIND_NATIVE_EXE && path.resolve(process.env.MIND_NATIVE_EXE);
const python = process.env.MIND_TEST_BUNDLED_PYTHON || process.env.MIND_PYTHON;
const env = { ...process.env, MIND_AGENT_STARTUP: '0', MIND_QUIETUD_MS: '1000', MIND_UPDATE_VERIFY: '' };
const run = promisify(execFile);
const repo = fileURLToPath(new URL('../../', import.meta.url));
const stamp = '2026-01-01T00:00:00.000Z';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const cleanupByRoot = new Map();

async function scratch(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(RUNS, 'mind-5c-')));
  const cleanups = [];
  cleanupByRoot.set(root, cleanups);
  t.after(async () => {
    try {
      for (const close of cleanups.reverse()) await close();
    } finally {
      cleanupByRoot.delete(root);
      assert.equal(path.dirname(root), RUNS);
      assert.ok(path.basename(root).startsWith('mind-5c-'));
      await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
  return root;
}

async function startNative(root, base, flags = [], overrides = {}) {
  const child = spawn(binary, ['motor', '--base', base, ...flags], {
    cwd: root, env: { ...env, ...overrides }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let diagnostics = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', text => { diagnostics = (diagnostics + text).slice(-3000); });
  child.on('error', error => { diagnostics = error.message; });
  const closed = new Promise(resolve => child.once('close', resolve));
  cleanupByRoot.get(root).push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
  });
  const lines = createInterface({ input: child.stdout });
  let config;
  try {
    const [line] = await Promise.race([
      once(lines, 'line', { signal: AbortSignal.timeout(12_000) }),
      closed.then(() => { throw Error('Terminó el Motor de prueba. ' + diagnostics); }),
    ]);
    config = JSON.parse(line);
  } finally {
    lines.close();
  }
  assert.equal(config.pid, child.pid);
  return {
    ...config,
    async rpc(accion, extra = {}) {
      const response = await fetch(new URL('/rpc', config.url), {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + config.token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ accion, ...extra }), signal: AbortSignal.timeout(5000),
      });
      assert.ok(response.ok, accion);
      return response.json();
    },
    async stop() {
      await this.rpc('apagar');
      await closed;
      assert.equal(child.exitCode, 0, diagnostics);
    },
  };
}

async function connect({ url, token }, form = false) {
  const headers = {
    Authorization: 'Bearer ' + token, Accept: 'application/json', 'Content-Type': 'application/json',
  };
  let nextId = 0;
  function post(message, extra = {}) {
    return fetch(url, {
      method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify({ jsonrpc: '2.0', ...message }),
      signal: AbortSignal.timeout(40_000),
    });
  }
  const response = await post({ id: ++nextId, method: 'initialize', params: {
    protocolVersion: '2025-11-25', clientInfo: { name: 'Cliente ficticio 5C', version: '1' },
    capabilities: form ? { elicitation: { form: {} } } : {},
  } });
  assert.equal(response.status, 200);
  headers['Mcp-Session-Id'] = response.headers.get('Mcp-Session-Id');
  assert.ok(headers['Mcp-Session-Id']);
  headers['MCP-Protocol-Version'] = (await response.json()).result.protocolVersion;

  function unwrap(reply, id, error) {
    assert.equal(reply.id, id);
    assert.equal(reply.error, undefined, JSON.stringify(reply));
    const result = reply.result;
    assert.equal(Boolean(result.isError), Boolean(error), JSON.stringify(result.structuredContent));
    if (error) assert.equal(result.structuredContent.error.codigo, error, JSON.stringify(result.structuredContent));
    return result;
  }
  return {
    async callResult(name, args = {}, error) {
      const id = ++nextId;
      const reply = await post({ id, method: 'tools/call', params: { name, arguments: args } });
      assert.equal(reply.status, 200, name);
      return unwrap(await reply.json(), id, error);
    },
    async call(name, args = {}, error) {
      return (await this.callResult(name, args, error)).structuredContent;
    },
    async list() {
      const id = ++nextId;
      const reply = await post({ id, method: 'tools/list' });
      return unwrap(await reply.json(), id).tools.map(tool => tool.name);
    },
    async applyWithForm(onForm) {
      const id = ++nextId;
      const reply = await post({
        id, method: 'tools/call',
        params: { name: 'mind_cambiar', arguments: { operacion: 'actualizacion_aplicar' } },
      }, { Accept: 'application/json, text/event-stream' });
      assert.match(reply.headers.get('content-type'), /text\/event-stream/);
      let buffered = '';
      for await (const part of reply.body.pipeThrough(new TextDecoderStream())) {
        buffered += part;
        while (buffered.includes('\n\n')) {
          const end = buffered.indexOf('\n\n');
          const frame = buffered.slice(0, end);
          buffered = buffered.slice(end + 2);
          const data = JSON.parse(frame.split('\n').find(line => line.startsWith('data: ')).slice(6));
          if (data.method === 'elicitation/create') {
            const result = await onForm(data.params);
            const answer = await post({ id: data.id, result });
            assert.equal(answer.status, 202);
          } else {
            return unwrap(data, id).structuredContent;
          }
        }
      }
      assert.fail('La confirmación MCP terminó sin respuesta.');
    },
    async close() {
      const reply = await fetch(url, { method: 'DELETE', headers, signal: AbortSignal.timeout(5000) });
      assert.ok(reply.ok);
      await reply.text();
    },
  };
}

function entry(content, references = [], id = randomUUID()) {
  return { format: 'mind-continuity-entry', version: 1, id, revision: 1, createdAt: stamp,
    updatedAt: stamp, source: 'Control ficticio', kind: 'Decisión', content, references };
}

function pack(entries, missing = []) {
  return { format: 'mind-continuity-export', version: 1, exportedAt: stamp, entries, missing };
}

function bound(name, operacion, argumentos) {
  return [name, { operacion, argumentos }];
}

test('5C: paquetes, permisos y alias de continuidad en la misma Base con el tag r3', {
  skip: !binary && 'Indica MIND_NATIVE_EXE', timeout: 90_000,
}, async t => {
  const root = await scratch(t);
  const base = path.join(root, 'Base');
  await fs.mkdir(base);
  const r3source = await extractR3(root);
  const { openSession } = await import(JSON.parse(r3source('session.js')));
  const { resolveLayout } = await import(JSON.parse(r3source('layout.js')));
  const { startCentralMotor } = await import(JSON.parse(r3source('motor-central.js')));
  const layout = await resolveLayout({ base, env });
  const setup = await openSession({ layout, motorVersion: '1.0.4', observe: false });
  const missing = randomUUID();
  const legacy = entry({ z: 'Nota conservada por r3', a: 1.5 });
  let r3Package;
  try {
    await setup.start();
    await setup.policy.setContinuity(['leer', 'registrar'], { channel: 'administracion-local' });
    await setup.motor.importContinuity(pack([legacy]));
    r3Package = await setup.motor.exportContinuity({ ids: [legacy.id] });
    await setup.policy.setContinuity(['leer'], { channel: 'administracion-local' });
  } finally {
    await setup.close();
  }
  const readonly = await startNative(root, base);
  const limited = await connect(readonly);
  await limited.call('continuidad_importar', { paquete: JSON.stringify(r3Package) }, 'ACCESS_NOT_GRANTED');
  await limited.close();
  await readonly.stop();
  const allowWrite = await openSession({ layout, motorVersion: '1.0.4', observe: false });
  try {
    await allowWrite.start();
    await allowWrite.policy.setContinuity(['leer', 'registrar'], { channel: 'administracion-local' });
  } finally {
    await allowWrite.close();
  }

  const motor = await startNative(root, base);
  const native = await connect(motor);
  assert.equal((await native.call('actualizacion_consultar')).estado, 'no-aplica');
  await native.call('actualizacion_posponer', {}, 'UPDATE_NOT_AVAILABLE');
  for (const op of ['continuidad_exportar', 'continuidad_importar', 'conversaciones_preparar', 'actualizacion_aplicar']) {
    assert.ok(!(await native.list()).includes(op), op);
  }
  assert.deepEqual((await native.call('conversaciones_preparar')).semantica, { estado: 'no_disponible' });
  const first = await native.call('continuidad_importar', { paquete: JSON.stringify(r3Package) });
  assert.deepEqual(first, { estado: 'importado', importados: [], sin_cambios: [legacy.id] });
  const note = entry('Prueba con ``` en el texto', [{ entry: legacy.id }, { entry: missing }, { locator: 'https://ejemplo.invalid/a', relation: 'Fuente' }]);
  const importArgs = { paquete: JSON.stringify(pack([note], [missing])) };
  assert.deepEqual((await native.call(...bound('mind_cambiar', 'continuidad_importar', importArgs))).importados, [note.id]);

  const details = { ids: [note.id, note.id], relacionados: true };
  const exported = await native.callResult(...bound('mind', 'continuidad_exportar', details));
  assert.equal(exported.content[0].text, exported.structuredContent.paquete);
  const payload = JSON.parse(exported.structuredContent.paquete);
  assert.deepEqual(payload.entries, [note, legacy]);
  assert.deepEqual(payload.missing, [missing]);
  const md = await native.call('continuidad_exportar', { ...details, formato: 'markdown' });
  assert.match(md.paquete, /````\nPrueba con ``` en el texto\n````/);
  const unrelated = entry({ texto: 'Debe quedar fuera tras el conflicto' });
  const conflict = { ...note, content: 'No reemplazar la nota' };
  await native.call('continuidad_importar', { paquete: JSON.stringify(pack([unrelated, conflict])) }, 'CONTINUITY_CONFLICT');
  await native.call('continuidad_importar', { paquete: JSON.stringify(pack([unrelated, unrelated])) }, 'CONTINUITY_EXPORT_INVALID');
  await native.call('continuidad_exportar', { ids: [unrelated.id] }, 'CONTINUITY_NOT_FOUND');
  assert.equal(await fs.stat(path.join(base, 'continuity-' + unrelated.id + '.json')).catch(() => null), null);
  await native.close();
  await motor.stop();

  const oldMotor = await startCentralMotor({
    layout, motorVersion: '1.0.4', observe: false, discoverUpdates: null, preferredPort: 0,
  });
  try {
    const old = await connect(oldMotor);
    const oldExport = await old.call('continuidad_exportar', details);
    assert.deepEqual(JSON.parse(oldExport.paquete).entries, payload.entries);
    assert.deepEqual(oldExport.faltantes, [missing]);
    assert.deepEqual((await old.call('continuidad_importar', { paquete: JSON.stringify(payload) })).sin_cambios, [note.id, legacy.id]);
    await old.close();
  } finally {
    await oldMotor.stop('fin-prueba-5c');
  }
  t.diagnostic('El tag auténtico ' + r3Commit.slice(0, 7) + ' exportó y reconoció los registros de la misma Base.');
});

async function fakeProduct(root) {
  const installation = path.join(root, 'Instalación ficticia');
  const manifest = { format: 'mind-product', version: 1, mindVersion: '1.0.4', packageRevision: 3,
    layoutVersion: 2, updateProtocolVersion: 2, platform: process.platform,
    arch: process.arch, targets: UNIVERSAL_TARGETS, files: {}, links: {} };
  const paths = productPaths(installation, manifest);
  const runtime = productRuntime(installation, manifest);
  await fs.mkdir(paths.motorDirectory, { recursive: true });
  await Promise.all(['bin', 'src'].map(name =>
    fs.cp(path.join(repo, name), path.join(paths.motorDirectory, name), { recursive: true })));
  await fs.copyFile(path.join(repo, 'package.json'), path.join(paths.motorDirectory, 'package.json'));
  await fs.mkdir(path.dirname(runtime.nodeExecutable), { recursive: true });
  await fs.copyFile(process.execPath, runtime.nodeExecutable);
  await fs.writeFile(paths.manifestFile, JSON.stringify(manifest));
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  await fs.writeFile(path.join(paths.motorDirectory, 'src', 'update-channel.json'), JSON.stringify({
    repository: 'ensayo/mind-ficticio', publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
  }));
  return { installation, ...paths, runtime, privateKey, manifest };
}

async function fakePython(pythonRuntime) {
  const source = await fs.realpath(python);
  const destination = path.dirname(pythonRuntime);
  await fs.mkdir(destination, { recursive: true });
  if (process.platform !== 'win32') {
    await fs.symlink(source, pythonRuntime);
    return;
  }
  const original = path.dirname(source);
  const files = await fs.readdir(original);
  const dllName = files.find(name => /^python\d{2,3}\.dll$/i.test(name));
  assert.ok(dllName, 'Falta la DLL del Python de prueba.');
  for (const file of files.filter(name => /^(?:python.*\.(?:dll|zip)|vcruntime.*\.dll|python\.exe)$/i.test(name))) {
    await fs.copyFile(path.join(original, file), path.join(destination, file));
  }
  const bundled = files.find(name => /^python\d{2,3}\.zip$/i.test(name));
  await fs.writeFile(path.join(destination, dllName.replace(/\.dll$/i, '._pth')),
    [bundled && path.join(destination, bundled), path.join(original, 'Lib'), path.join(original, 'DLLs'), original]
      .filter(Boolean).join('\n') + '\n');
}

test('5C: actualización firmada local, consentimiento MCP, código y fallo seguro del paquete', {
  skip: (!binary || !python) && 'Indica MIND_NATIVE_EXE y MIND_PYTHON', timeout: 120_000,
}, async t => {
  const root = await scratch(t);
  const product = await fakeProduct(root);
  await fakePython(product.runtime.pythonExecutable);
  const base = product.baseDirectory;
  await fs.mkdir(base, { recursive: true });
  await fs.writeFile(path.join(base, 'mind-base.json'), JSON.stringify({
    format: 'mind-base', version: 3, baseId: randomUUID(), createdAt: stamp,
  }));
  const manifestBytes = await fs.readFile(product.manifestFile);
  const childEnv = { MIND_PYTHON: product.runtime.pythonExecutable };
  const layout = await resolveLayout({ base, env: { ...env, ...childEnv } });
  const permissions = await openSession({ layout, motorVersion: '1.0.4', observe: false });
  try {
    await permissions.start();
    await permissions.policy.setContinuity(['leer'], { channel: 'administracion-local' });
  } finally {
    await permissions.close();
  }
  const motor = await startNative(root, base, [
    '--raiz-instalacion', product.installation, '--directorio-motor', product.motorDirectory,
  ], childEnv);
  const client = await connect(motor);
  const updateDir = updateStatePaths(product.installation);
  assert.equal((await client.call('actualizacion_consultar')).fase, 'sin-comprobar');
  await client.call('actualizacion_aplicar', {}, 'UPDATE_NOT_AVAILABLE');

  const fakeZip = Buffer.from('Contenido de ensayo, deliberadamente sin un descriptor ni un ZIP válido.');
  const hash = sha256(fakeZip);
  const feed = { format: 'mind-update', version: 2, ...releaseOf({ ...product.manifest, mindVersion: '1.0.5' }),
    manifestSha256: 'a'.repeat(64), packages: [{ platform: 'win32', arch: 'x64', targets: UNIVERSAL_TARGETS,
      url: 'https://github.com/ensayo/mind-ficticio/releases/download/v1.0.5/mind.zip', sha256: hash, bytes: fakeZip.length }] };
  const setOffer = async () => {
    const payload = Buffer.from(JSON.stringify(feed));
    await writeUpdateState(product.installation, {
      phase: 'disponible', release: releaseOf(feed), package: feed.packages[0],
      nextCheckAt: '2099-01-01T00:00:00.000Z',
      envelope: { payload: payload.toString('base64'), signature: sign(null, payload, product.privateKey).toString('base64') },
    });
  };
  await setOffer();
  const consult = () => client.call(...bound('mind', 'actualizacion_consultar', {}));
  assert.equal((await consult()).disponible.mindVersion, '1.0.5');
  const firstNotice = await client.call('destinos_consultar');
  assert.equal(firstNotice.aviso_actualizacion.version, '1.0.5');
  assert.equal((await client.call('destinos_consultar')).aviso_actualizacion, undefined);
  assert.equal((await client.call(...bound('mind_cambiar', 'actualizacion_posponer', { dias: 3 }))).estado, 'pospuesta');
  assert.ok(Date.parse((await consult()).pospuesta_hasta) > Date.now() + 2 * 86_400_000);
  await client.call('actualizacion_posponer', { dias: 2 }, 'INVALID_ARGUMENTS');
  await client.call('actualizacion_aplicar', { codigo: '0'.repeat(24) }, 'UPDATE_CONSENT_REQUIRED');

  const form = await connect(motor, true);
  assert.equal((await form.call('destinos_consultar')).aviso_actualizacion, undefined);
  const denied = await form.applyWithForm(async ({ message, requestedSchema }) => {
    assert.match(message, /Mind 1\.0\.5/);
    assert.equal(requestedSchema.properties.confirmar.default, false);
    const quiet = await motor.rpc('quietud');
    assert.equal(quiet.quieto, false);
    assert.ok(quiet.impiden.some(item => item.actividad === 'esperando-al-usuario'));
    assert.equal((await motor.rpc('apagar', { soloSiQuieto: true, soloSiInactivo: true })).busy, true);
    return { action: 'accept', content: { confirmar: false } };
  });
  assert.equal(denied.estado, 'cancelada');
  await form.close();
  assert.equal((await consult()).aplicacion, null);
  assert.equal(await fs.stat(updateDir.downloads).catch(() => null), null);

  const ask = () => client.call(...bound('mind_cambiar', 'actualizacion_aplicar', {}));
  const first = await ask();
  assert.equal(first.estado, 'requiere-confirmacion');
  assert.match(first.codigo, /^[0-9a-f]{24}$/);
  const consentFile = updateConsentPaths(product.installation).file;
  const stored = await readJson(consentFile);
  assert.equal(stored.codeHash, sha256(first.codigo));
  assert.equal(stored.identity.packageSha256, hash);
  await client.call('actualizacion_aplicar', { codigo: '0'.repeat(24) }, 'UPDATE_CONSENT_INVALID');
  feed.manifestSha256 = 'c'.repeat(64);
  await setOffer();
  await client.call('actualizacion_aplicar', { codigo: first.codigo }, 'UPDATE_CANDIDATE_CHANGED');
  assert.equal((await readJson(consentFile)).status, 'cancelado');

  // Un ZIP local con la huella ofrecida permite probar el relevista real sin red.
  // Su contenido inválido debe fallar antes de sustituir el programa de la copia.
  const next = await ask();
  await fs.mkdir(updateDir.downloads, { recursive: true });
  await fs.writeFile(path.join(updateDir.downloads, hash + '.zip'), fakeZip);
  const submitted = await client.call('actualizacion_aplicar', { codigo: next.codigo });
  assert.match(submitted.id, /^[a-f0-9-]{36}$/);
  assert.equal((await readJson(consentFile)).status, 'consumido');
  await client.call('actualizacion_aplicar', { codigo: next.codigo }, 'UPDATE_CONSENT_REQUIRED');
  let result;
  for (let i = 0; i < 40; i++) {
    result = (await consult()).aplicacion;
    if (result?.fase === 'fallida') break;
    await delay(150);
  }
  assert.equal(result.fase, 'fallida', JSON.stringify(result));
  assert.equal(result.id, submitted.id);
  assert.equal(result.error?.code, 'PACKAGE_ARCHIVE_INVALID');
  assert.deepEqual(await fs.readFile(product.manifestFile), manifestBytes);
  assert.equal((await client.call('actualizacion_consultar')).instalada.mindVersion, '1.0.4');

  const copy = path.join(root, 'Proyecto de vista ficticio');
  await fs.mkdir(copy);
  const recipe = path.join(copy, 'receta.json');
  await fs.writeFile(path.join(copy, 'compilar.mjs'),
    "import fs from 'node:fs'; import path from 'node:path'; fs.writeFileSync(path.join(process.env.MIND_SALIDA, 'index.html'), '<h1>Vista ficticia</h1>');");
  await fs.writeFile(recipe, JSON.stringify({ programa: process.execPath, argumentos: ['compilar.mjs'] }));
  const selected = ['--proyecto', 'Vista ficticia', '--copia', copy, '--receta', recipe];
  const cli = (...args) => run(binary, ['vista', ...args], { env, cwd: root, timeout: 15_000, windowsHide: true });
  const { autorizacion } = JSON.parse((await cli('receta', ...selected)).stdout);
  await assert.rejects(cli('construir', '--base', base, ...selected, '--autorizar', '0'.repeat(64)));
  const view = JSON.parse((await cli('construir', '--base', base, ...selected, '--autorizar', autorizacion)).stdout);
  assert.equal(view.estado, 'publicada');
  const html = await fetch(view.servida.url, { signal: AbortSignal.timeout(5000) });
  assert.equal(html.status, 200);
  assert.match(await html.text(), /<h1>Vista ficticia<\/h1>/);
  await cli('cerrar', '--base', base, '--id', view.servida.id);
  await client.close();
  assert.equal((await motor.rpc('quietud')).quieto, true);
  await motor.stop();
});
