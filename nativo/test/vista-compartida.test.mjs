import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createAccessPolicy } from '../../src/access-policy.js';
import { createNativeContinuityStore } from '../../src/continuity-reader.js';
import { stopCentralMotor } from '../../src/connector.js';
import { resolveLayout } from '../../src/layout.js';
import { openSession } from '../../src/session.js';
import { RUNS } from './runs.mjs';
import { extractR3 } from './r3-fixture.mjs';

const executable = process.env.MIND_NATIVE_EXE;
const nativeSave = process.env.MIND_TEST_NATIVE_SAVE === '1';
const nativeContinuity = nativeSave || process.env.MIND_TEST_NATIVE_CONTINUITY === '1';
const motorScript = fileURLToPath(new URL('./real-motor.mjs', import.meta.url));
const run = promisify(execFile);
const fixturePrefix = 'mind-nativo-runs-vista-';
const project = 'Atlas ficticio';
const firstMap = '<!doctype html><title>Mapa Atlas</title><link rel="stylesheet" href="mapa.css"><main>Centro Atlas</main>';
const nextMap = firstMap.replace('Centro Atlas', 'Centro y puerto Atlas');
const mapStyle = 'main { padding: 2rem; }';
const assetName = 'capas/región norte.json';
const assetContent = JSON.stringify({ region: 'Norte ficticio' });

function start(command, args, env) {
  const child = spawn(command, args, {
    env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
  });
  let diagnostic = '';
  let stopped = false;
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (text) => { diagnostic = (diagnostic + text).slice(-2048); });
  const closed = new Promise((resolve) => {
    child.once('close', () => { stopped = true; resolve(); });
    child.once('error', (error) => {
      diagnostic = String(error);
      stopped = true;
      resolve();
    });
  });
  return {
    pid: child.pid,
    async connector(base, name) {
      for (let attempt = 0; attempt < 100; attempt++) {
        assert.ok(!stopped, name + ' no arrancó: ' + diagnostic);
        const record = await fs.readFile(path.join(base, name), 'utf8').then(JSON.parse).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
          return null;
        });
        if (record) {
          assert.equal(record.pid, child.pid, name + ' pertenece al proceso de la prueba');
          return record;
        }
        await delay(100);
      }
      throw new Error('No se publicó ' + name + ': ' + diagnostic);
    },
    async stop() {
      if (!stopped) child.kill();
      await closed;
    },
  };
}

async function openMcp(url, auth, name) {
  const headers = { ...auth, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' };
  let nextId = 1;
  async function post(method, params, notification = false) {
    const id = notification ? {} : { id: nextId++ };
    const response = await fetch(url, {
      method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', ...id, method, params }),
      signal: AbortSignal.timeout(10_000),
    });
    if (notification) {
      assert.ok(response.ok, 'Notificación MCP: ' + response.status);
      await response.text();
      return {};
    }
    assert.equal(response.status, 200, method);
    const data = await response.text();
    const sse = response.headers.get('content-type')?.includes('text/event-stream');
    const result = sse ? data.split(/\r?\n/u).filter((line) => line.startsWith('data:'))
      .map((line) => JSON.parse(line.slice(5))).find((message) => message.id === id.id) : JSON.parse(data);
    assert.equal(result?.id, id.id);
    assert.equal(result.error, undefined);
    return { response, result: result.result };
  }

  const { response } = await post('initialize', {
    protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name, version: '1' },
  });
  const id = response.headers.get('mcp-session-id');
  assert.ok(id);
  headers['Mcp-Session-Id'] = id;
  await post('notifications/initialized', undefined, true);
  return {
    id,
    async call(tool, args, expectedError) {
      const { result } = await post('tools/call', { name: tool, arguments: args });
      if (expectedError) {
        assert.equal(result.isError, true);
        assert.equal(result.structuredContent?.error?.codigo, expectedError);
        return;
      }
      assert.equal(Boolean(result.isError), false, JSON.stringify(result.structuredContent));
      return result.structuredContent;
    },
    async close() {
      const reply = await fetch(url, { method: 'DELETE', headers, signal: AbortSignal.timeout(5_000) });
      assert.ok(reply.ok, 'Cierre MCP: ' + reply.status);
      await reply.text();
    },
  };
}

test('vista compartida: retoma entre dos sesiones, copia de trabajo, revisión y cierre', {
  skip: !executable && 'Indica MIND_NATIVE_EXE',
  timeout: 90_000,
}, async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(RUNS, fixturePrefix)));
  const base = path.join(root, 'Base');
  const repo = path.join(root, 'Proyecto Atlas');
  const out = path.join(repo, 'vista');
  const standalone = path.join(root, 'Sin Git');
  const notes = path.join(root, 'Conversaciones ficticias');
  const linked = path.join(root, 'Atlas vinculado');
  const env = { ...process.env, MIND_AGENT_STARTUP: '0' };
  if (!env.MIND_PYTHON && env.MIND_TEST_BUNDLED_PYTHON) env.MIND_PYTHON = env.MIND_TEST_BUNDLED_PYTHON;
  const local = { env, timeout: 10_000, windowsHide: true };
  let motor, motorRecord, host, scope;
  t.after(async () => {
    try {
      await host?.stop();
      if (motorRecord?.pid && motorRecord.pid === motor?.pid) {
        await stopCentralMotor(base, { timeoutMs: 4_000, reason: 'fin-prueba-vista' }).catch(() => {});
      }
      await motor?.stop();
    } finally {
      assert.equal(path.dirname(root), RUNS);
      assert.ok(path.basename(root).startsWith(fixturePrefix));
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  await fs.mkdir(base);
  await fs.mkdir(notes);
  await fs.mkdir(out, { recursive: true });
  await fs.mkdir(path.join(standalone, 'capas'), { recursive: true });
  await fs.mkdir(path.join(out, 'capas'));
  await fs.writeFile(path.join(out, 'index.html'), firstMap);
  await fs.writeFile(path.join(out, 'mapa.css'), mapStyle);
  await fs.writeFile(path.join(standalone, 'index.html'), firstMap);
  await fs.writeFile(path.join(standalone, 'mapa.css'), mapStyle);
  await fs.writeFile(path.join(out, assetName), assetContent);
  await fs.writeFile(path.join(standalone, assetName), assetContent);

  const git = (...args) => run('git', [
    '-c', 'core.hooksPath=' + path.join(root, 'sin-hooks'),
    '-c', 'core.autocrlf=false', '-c', 'user.name=Prueba Mind', '-c', 'user.email=mind@example.test',
    '-c', 'commit.gpgsign=false', '-C', repo, ...args,
  ], local);
  await git('init', '-b', 'principal');
  await git('add', '--', 'vista');
  await git('commit', '-m', 'Mapa ficticio');
  const commit = (await git('rev-parse', 'HEAD')).stdout.trim();
  await git('worktree', 'add', '--detach', linked, commit);

  const setup = await openSession({
    layout: await resolveLayout({ base, env }), motorVersion: '1.0.4', observe: false,
  });
  try {
    await setup.start();
    scope = await setup.motor.authorizeFolder(notes);
    scope = await setup.motor.getAuthorizedFolder(scope.id);
    await setup.policy.set(scope.id, ['encontrar', 'leer', 'escribir', 'organizar'], { channel: 'administracion-local' });
    await setup.policy.setContinuity(['leer', 'registrar'], { channel: 'administracion-local' });
  } finally {
    await setup.close();
  }

  const binary = path.resolve(executable);
  if (nativeContinuity) env.MIND_CLAVE_LECTURA_CONTINUIDAD = randomBytes(32).toString('hex');
  if (nativeSave) env.MIND_ESCRITURA_NATIVA = '1';
  host = start(binary, ['anfitrion', '--base', base, '--puerto-vistas', '0'], env);
  const control = await host.connector(base, 'anfitrion.json');
  if (nativeContinuity) env.MIND_PUERTO_LECTURA_CONTINUIDAD = String(control.port);
  motor = start(process.execPath, [motorScript, base], env);
  motorRecord = await motor.connector(base, 'conector.json');
  const { token } = JSON.parse(await fs.readFile(path.join(base, 'conector-secreto.json'), 'utf8'));
  const auth = { Authorization: 'Bearer ' + token };
  const origin = new URL(control.url).origin;
  const mcp = new URL('/mcp?catalogo=nucleo', origin);
  const get = (url, options = {}) => fetch(url, { signal: AbortSignal.timeout(5_000), ...options });
  const health = async () => (await get(new URL('/health', origin))).json();
  assert.deepEqual(await health().then(({ pid, vistas }) => ({ pid, vistas })), {
    pid: host.pid, vistas: { activas: 0, bytes: 0 },
  });

  async function vista(action, ...args) {
    const { stdout } = await run(binary, ['vista', action, '--base', base, ...args], local);
    return stdout.trim() ? JSON.parse(stdout) : null;
  }
  const abre = (copy, content, ...args) => vista('abrir',
    '--proyecto', project, '--copia', copy, '--contenido', content, ...args);
  const consulta = (id) => vista('consultar', '--id', id);
  const cierra = (id) => vista('cerrar', '--id', id);
  const published = await abre(repo, out);
  assert.equal(published.proyecto, project);
  assert.deepEqual(published.git, { rama: 'principal', revision: commit, cambios: false });
  assert.match(published.huella, /^(?:sha256:)?[a-f0-9]{64}$/u);
  assert.ok(published.copia);
  assert.deepEqual(await consulta(published.id), published);
  const preview = new URL(published.url);
  assert.equal(preview.protocol, 'http:');
  assert.equal(preview.hostname, '127.0.0.1');
  assert.equal(preview.pathname, '/vista/' + published.id + '/');
  assert.equal(preview.search, '');
  assert.notEqual(preview.origin, origin);
  assert.notEqual(preview.port, String(motorRecord.port));

  const first = await openMcp(mcp, auth, 'vista-cliente-uno');
  let saved;
  const reference = { ubicacion: published.url, relacion: 'Mapa abierto del Proyecto Atlas' };
  const remembered = {
    id: published.id, url: published.url, proyecto: project, copia: published.copia,
    git: published.git, huella: published.huella, nota: 'Área norte 🗺️',
  };
  try {
    const created = await first.call('guardar', {
      en: 'conversacion', titulo: 'Atlas abre un mapa ficticio', proyecto: project,
      importante: JSON.stringify(remembered), referencias: [reference],
    });
    const state = await first.call('retomar', { id: created.conversacion.id });
    saved = state.conversacion;
    assert.equal(created.estado, 'registrada');
    const filename = path.join(base, 'continuity-' + saved.id + '.json');
    const persisted = JSON.parse(await fs.readFile(filename, 'utf8'));
    assert.equal(persisted.format, 'mind-continuity-entry');
    assert.equal(persisted.version, 1);
    assert.equal(persisted.content.important, saved.importante);
    assert.ok((await fs.readFile(saved.archivo, 'utf8')).includes(saved.importante));
    const page = await get(preview);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /^text\/html/u);
    assert.equal(page.headers.get('access-control-allow-origin'), null);
    const html = await page.text();
    assert.equal(html, firstMap);
    assert.ok(!html.includes(token));
  } finally {
    await first.close();
  }
  const second = await openMcp(mcp, auth, 'vista-cliente-dos');
  try {
    assert.notEqual(second.id, first.id);
    const { conversacion } = await second.call('retomar', { id: saved.id });
    assert.deepEqual(conversacion, saved);
    assert.deepEqual(conversacion.referencias, [reference]);
    assert.deepEqual(JSON.parse(conversacion.importante), remembered);
    assert.equal(await (await get(conversacion.referencias[0].ubicacion)).text(), firstMap);
    assert.equal((await health()).pid, host.pid);
    assert.deepEqual(await consulta(published.id), published);

    const raw = await get(new URL('/interno/continuidad/' + saved.id, origin), { headers: auth });
    assert.equal(raw.status, nativeContinuity ? 401 : 404);
    assert.ok(!(await raw.text()).includes(saved.importante));
    if (nativeContinuity) {
      const nonce = randomBytes(16).toString('hex');
      const otherBase = control.baseId === '0'.repeat(16) ? '1'.repeat(16) : '0'.repeat(16);
      const proof = createHmac('sha256', env.MIND_CLAVE_LECTURA_CONTINUIDAD)
        .update([otherBase, 'read', nonce, saved.id].join('\n')).digest('hex');
      const crossBase = await get(new URL('/interno/continuidad/' + saved.id, origin), {
        headers: { Authorization: 'Mind-Internal ' + nonce + '.' + proof },
      });
      assert.equal(crossBase.status, 401);
      await crossBase.text();
    }

    await second.call('retomar', { id: 'no-es-un-id' }, 'INVALID_CONVERSATION_ID');
    await second.call('retomar', { id: randomUUID() }, 'CONVERSATION_NOT_FOUND');
    const badId = randomUUID();
    const badFile = path.join(base, 'continuity-' + badId + '.json');
    await fs.writeFile(badFile, '{', { flag: 'wx' });
    try {
      await second.call('retomar', { id: badId }, 'RECORD_CORRUPT');
    } finally {
      await fs.unlink(badFile);
    }

    const policy = createAccessPolicy({
      baseDirectory: base,
      getAuthorizedFolder: async id => id === scope.id ? scope : null,
    });
    await policy.setContinuity([], { channel: 'administracion-local' });
    await second.call('retomar', { id: saved.id }, 'ACCESS_NOT_GRANTED');
    await policy.setContinuity(['leer'], { channel: 'administracion-local' });
    assert.deepEqual((await second.call('retomar', { id: saved.id })).conversacion, saved);

    if (nativeSave) {
      const guard = { channel: 'administracion-local' };
      const storedPath = path.join(base, 'continuity-' + saved.id + '.json');
      const [recordBefore, markdownBefore] = await Promise.all([fs.readFile(storedPath), fs.readFile(saved.archivo)]);
      const update = {
        en: 'conversacion', id: saved.id, revision: saved.revision, importante: 'Continuación ficticia en el área norte.',
      };
      await second.call('actualizar', update, 'ACCESS_NOT_GRANTED');
      await policy.setContinuity(['leer', 'registrar'], guard);
      await policy.set(scope.id, ['encontrar', 'leer'], guard);
      await second.call('actualizar', update, 'ACCESS_NOT_GRANTED');
      assert.deepEqual(await fs.readFile(storedPath), recordBefore);
      assert.deepEqual(await fs.readFile(saved.archivo), markdownBefore);
      await policy.set(scope.id, ['encontrar', 'leer', 'escribir', 'organizar'], guard);

      const privateWrite = await get(new URL('/interno/continuidad/escribir', origin), { method: 'POST', headers: auth });
      assert.equal(privateWrite.status, 401);
      await privateWrite.text();
      const native = createNativeContinuityStore({
        port: control.port, key: env.MIND_CLAVE_LECTURA_CONTINUIDAD, baseId: control.baseId,
      });
      await assert.rejects(native.writeNativeText({
        root: notes, relativePath: 'Cancelado.md', bytes: Buffer.from('Ensayo de revocación'),
        confirm: async () => { throw new Error('Permiso retirado después de abrir'); },
      }), /Permiso retirado después de abrir/u);
      await assert.rejects(fs.stat(path.join(notes, 'Cancelado.md')), { code: 'ENOENT' });

      const updated = await second.call('actualizar', update);
      assert.equal(updated.estado, 'actualizada');
      assert.equal(updated.conversacion.revision, saved.revision + 1);
      assert.equal(updated.conversacion.id, saved.id);
      assert.equal(updated.conversacion.archivo, saved.archivo);
      assert.equal(updated.conversacion.importante, update.importante);
      await second.call('actualizar', update, 'CONTINUITY_REVISION_CONFLICT');
      saved = (await second.call('retomar', { id: saved.id })).conversacion;
      assert.equal(saved.revision, 2);
      assert.equal(JSON.parse(await fs.readFile(storedPath, 'utf8')).revision, saved.revision);
      assert.equal(await fs.readFile(saved.archivo, 'utf8'),
        '<!-- mind-conversation:' + saved.id + ' revision:2 -->\n# ' + saved.titulo + '\n\n' + saved.importante + '\n');

      if (process.platform === 'win32') {
        const oldMarkdown = await fs.readFile(saved.archivo, 'utf8');
        const handle = await fs.open(saved.archivo, 'r+');
        let pending;
        try {
          pending = await second.call('actualizar', { ...update, revision: saved.revision, importante: 'Nota pendiente recuperada.' });
        } finally {
          await handle.close();
        }
        assert.equal(pending.estado, 'pendiente_archivo');
        assert.equal(pending.archivo.codigo, 'FILE_IN_USE');
        assert.deepEqual(pending.reintento, { id: saved.id, revision: 3 });
        assert.equal(await fs.readFile(saved.archivo, 'utf8'), oldMarkdown);
        const record = await fs.readFile(storedPath);
        const ids = (await fs.readdir(base)).filter(name => /^continuity-/.test(name));

        const edited = oldMarkdown + 'Cambio externo que debe conservarse.\n';
        await fs.writeFile(saved.archivo, edited);
        await second.call('actualizar', pending.reintento, 'CONVERSATION_FILE_CONFLICT');
        assert.equal(await fs.readFile(saved.archivo, 'utf8'), edited);
        await fs.unlink(saved.archivo);
        await second.call('actualizar', pending.reintento, 'CONVERSATION_FILE_CONFLICT');
        await assert.rejects(fs.stat(saved.archivo), { code: 'ENOENT' });
        await fs.writeFile(saved.archivo, oldMarkdown, { flag: 'wx' });

        await second.call('actualizar', { ...pending.reintento, revision: 2 }, 'CONTINUITY_REVISION_CONFLICT');
        const repaired = await second.call('actualizar', pending.reintento);
        assert.equal(repaired.estado, 'archivo_completado');
        assert.deepEqual(repaired.conversacion, pending.conversacion);
        const markdown = await fs.readFile(saved.archivo, 'utf8');
        assert.equal(markdown, '<!-- mind-conversation:' + saved.id + ' revision:3 -->\n# '
          + saved.titulo + '\n\n' + pending.conversacion.importante + '\n');
        assert.equal((await second.call('actualizar', pending.reintento)).estado, 'archivo_completado');
        assert.equal(await fs.readFile(saved.archivo, 'utf8'), markdown);
        assert.deepEqual(await fs.readFile(storedPath), record);
        assert.deepEqual((await fs.readdir(base)).filter(name => /^continuity-/.test(name)), ids);
        saved = (await second.call('retomar', { id: saved.id })).conversacion;
        assert.deepEqual(saved, { ...pending.conversacion, resultados: [] });
      }
    }
  } finally {
    await second.close();
  }

  const head = await get(preview, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  const css = await get(new URL('mapa.css', preview));
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /^text\/css/u);
  assert.equal(await css.text(), mapStyle);
  const asset = await get(new URL(assetName, preview));
  assert.equal(asset.status, 200);
  assert.equal(await asset.text(), assetContent);
  for (const privatePath of ['/mcp', '/rpc', '/vistas/' + published.id]) {
    const rejected = await get(new URL(privatePath, preview), { headers: auth });
    assert.equal(rejected.status, 404, privatePath + ' fuera del origen privado');
    assert.ok(!(await rejected.text()).includes(token));
  }
  const denied = await get(mcp, { method: 'DELETE', headers: { ...auth, Origin: preview.origin } });
  assert.equal(denied.status, 403, 'El origen de la vista no entra a la API privada');
  await denied.text();
  const missingAuth = await get(new URL('/vistas/' + published.id, origin));
  assert.equal(missingAuth.status, 401);
  assert.ok(!(await missingAuth.text()).includes(token));
  const wrongOrigin = await get(new URL(preview.pathname, origin));
  assert.equal(wrongOrigin.status, 404);
  await wrongOrigin.text();

  const secondCopy = await abre(linked, path.join(linked, 'vista'));
  assert.notEqual(secondCopy.copia, published.copia);
  assert.equal(secondCopy.git.revision, commit);
  assert.equal(secondCopy.git.rama, null);
  assert.equal(secondCopy.huella, published.huella);
  const withoutGit = await abre(standalone, standalone);
  assert.equal(withoutGit.git, null);
  assert.equal(withoutGit.huella, published.huella);
  await assert.rejects(abre(linked, path.join(linked, 'vista'), '--id', published.id, '--version', String(published.version)),
    /VIEW_COPY_CHANGED/u);
  await cierra(secondCopy.id);
  await cierra(withoutGit.id);

  await fs.writeFile(path.join(out, 'index.html'), nextMap);
  const changed = await abre(repo, out, '--id', published.id, '--version', String(published.version));
  assert.equal(changed.url, published.url);
  assert.equal(changed.copia, published.copia);
  assert.deepEqual(changed.git, { ...published.git, cambios: true });
  assert.notEqual(changed.huella, published.huella);
  assert.ok(changed.version > published.version);
  await assert.rejects(abre(repo, out, '--id', changed.id, '--version', String(published.version)));
  const broken = await get(new URL('/vistas/' + changed.id, origin), {
    method: 'PUT',
    headers: { ...auth, 'Content-Type': 'application/json', 'If-Match': '"' + changed.version + '"' },
    body: JSON.stringify({
      proyecto: project, copia: changed.copia, git: changed.git,
      archivos: [{ ruta: 'index.html', base64: 'contenido no codificado' }],
    }),
  });
  assert.ok(broken.status >= 400 && broken.status < 500, 'La revisión inválida se rechaza');
  await broken.text();
  assert.deepEqual(await consulta(changed.id), changed);
  assert.equal(await (await get(preview)).text(), nextMap);

  await cierra(changed.id);
  assert.equal((await get(preview)).status, 404);
  await assert.rejects(consulta(changed.id));
  assert.deepEqual(await health().then(({ pid, vistas }) => ({ pid, vistas })), {
    pid: host.pid, vistas: { activas: 0, bytes: 0 },
  });

  if (nativeContinuity) {
    await host.stop();
    const direct = new URL('http://127.0.0.1:' + motorRecord.port + '/mcp?catalogo=nucleo');
    const client = await openMcp(direct, auth, 'vista-motor-sin-anfitrion');
    try {
      assert.equal((await client.call('estado', {})).motor_central.pid, motor.pid);
      await client.call('retomar', { id: saved.id }, 'CONTINUITY_READER_UNAVAILABLE');
      if (nativeSave) {
        const records = (await fs.readdir(base)).filter(name => name.startsWith('continuity-'));
        const failed = path.join(notes, 'Sin escritor.md');
        await client.call('guardar', {
          en: 'conversacion', titulo: 'Sin anfitrión', importante: 'Nota ficticia', destino: failed,
        }, 'WRITE_UNAVAILABLE');
        assert.deepEqual((await fs.readdir(base)).filter(name => name.startsWith('continuity-')), records);
        await assert.rejects(fs.stat(failed), { code: 'ENOENT' });
      }
    } finally {
      await client.close();
    }
  }

  if (nativeSave) {
    assert.ok(await stopCentralMotor(base, { timeoutMs: 4_000, reason: 'vuelta-r3' }));
    await motor.stop();
    const recordPath = path.join(base, 'continuity-' + saved.id + '.json');
    const [record, markdown] = await Promise.all([fs.readFile(recordPath), fs.readFile(saved.archivo)]);
    const moduleUrl = await extractR3(root);
    const source = [
      'const { openSession } = await import(' + moduleUrl('session.js') + ');',
      'const { resolveLayout } = await import(' + moduleUrl('layout.js') + ');',
      'const { createAgentTools } = await import(' + moduleUrl('agent-tools.js') + ');',
      "const session = await openSession({ layout: await resolveLayout({ base: process.argv[1] }), motorVersion: '1.0.4', observe: false });",
      'try {',
      '  await session.start();',
      "  const result = await createAgentTools({ session }).call('conversacion_leer', { id: process.argv[2] });",
      '  console.log(JSON.stringify(result.conversacion));',
      '} finally { await session.close(); }',
    ].join('\n');
    const { stdout } = await run(process.execPath, ['--input-type=module', '-e', source, base, saved.id], local);
    assert.deepEqual(JSON.parse(stdout), saved);
    assert.deepEqual(await fs.readFile(recordPath), record);
    assert.deepEqual(await fs.readFile(saved.archivo), markdown);
    t.diagnostic('r3 recuperó la revisión ' + saved.revision + ' de ' + saved.id);
  }
});
