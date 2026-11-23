import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { runInNewContext } from 'node:vm';
import { createAccessPolicy } from '../../src/access-policy.js';
import { createNativeContinuityStore } from '../../src/continuity-reader.js';
import { stopCentralMotor } from '../../src/connector.js';
import { resolveLayout } from '../../src/layout.js';
import { openSession } from '../../src/session.js';
import { RUNS } from './runs.mjs';
import { assertViewHtml } from './vista-html.mjs';
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
  const env = { ...process.env, MIND_AGENT_STARTUP: '0', MIND_VISTA_INACTIVA_MS: '999' };
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
  assert.equal(published.mantener_abierta, false);
  assert.equal(published.inactividad_ms, 1_800_000);
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
    assertViewHtml(html, firstMap);
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
    assertViewHtml(await (await get(conversacion.referencias[0].ubicacion)).text(), firstMap);
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
  assertViewHtml(await (await get(preview)).text(), nextMap);

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


test('las vistas inactivas liberan la copia en RAM y las páginas visibles o fijadas siguen abiertas', {
  skip: !executable && 'Indica MIND_NATIVE_EXE',
  timeout: 45_000,
}, async t => {
  const idle = 2000;
  const root = await fs.realpath(await fs.mkdtemp(path.join(RUNS, 'vista-inactividad-')));
  const base = path.join(root, 'Base');
  const notes = path.join(root, 'Sitio');
  const index = path.join(notes, 'index.html');
  const env = { ...process.env, MIND_AGENT_STARTUP: '0', MIND_VISTA_INACTIVA_MS: String(idle) };
  let motor, client;
  t.after(async () => {
    try {
      await client?.close().catch(() => {});
      await motor?.stop();
    } finally {
      assert.equal(path.dirname(root), RUNS);
      assert.ok(path.basename(root).startsWith('vista-inactividad-'));
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
  await fs.mkdir(notes);
  await fs.writeFile(index, firstMap);
  await fs.writeFile(path.join(notes, 'mapa.css'), mapStyle);

  motor = start(path.resolve(executable), ['motor', '--base', base, '--conector'], env);
  const connector = await motor.connector(base, 'conector.json');
  const { token } = JSON.parse(await fs.readFile(path.join(base, 'conector-secreto.json'), 'utf8'));
  client = await openMcp(connector.url, {
    Authorization: 'Bearer ' + token,
    'X-Mind-Workspace': Buffer.from(JSON.stringify({ cwd: notes, paths: [] })).toString('base64url'),
  }, 'Vista inactiva ficticia');
  const get = (url, options) => fetch(url, { signal: AbortSignal.timeout(5000), ...options });
  const health = async () => (await (await get(new URL('/health', connector.url))).json()).vistas;
  const call = (accion, args = {}, error) => client.call('vista', { accion, ...args }, error);
  const publish = { carpeta: notes, proyecto: project };
  const bytes = Buffer.byteLength(firstMap) + Buffer.byteLength(mapStyle);
  const usage = { activas: 1, bytes };
  const empty = { activas: 0, bytes: 0 };

  async function assertExpired(view) {
    const deadline = performance.now() + idle * 3;
    let current;
    do {
      current = await health();
      if (current.activas === 0) break;
      await delay(75);
    } while (performance.now() < deadline);
    assert.deepEqual(current, empty, 'el barrido libera la copia sin peticiones a la vista');
    assert.equal((await get(view.url)).status, 404);
    await call('consultar', { id: view.id }, 'VIEW_NOT_FOUND');
    assert.equal(await fs.readFile(index, 'utf8'), firstMap);
    assert.equal(await fs.readFile(path.join(notes, 'mapa.css'), 'utf8'), mapStyle);
  }

  const idleView = await call('abrir', publish);
  assert.equal(idleView.mantener_abierta, false);
  assert.equal(idleView.inactividad_ms, idle);
  assert.deepEqual(await health(), usage);
  await delay(idle * 0.75);
  const css = await get(new URL('mapa.css', idleView.url));
  assert.equal(css.status, 200);
  assert.equal(await css.text(), mapStyle);
  await delay(idle * 0.5);
  assert.deepEqual(await health(), usage, 'la petición de un recurso renueva la actividad');
  await assertExpired(idleView);

  const visible = await call('abrir', publish);
  assert.notEqual(visible.id, idleView.id);
  assert.equal(visible.huella, idleView.huella);
  const preview = new URL(visible.url);
  const signalUrl = new URL('_mind/actividad', preview);
  const page = await get(preview);
  const html = await page.text();
  const script = assertViewHtml(html, firstMap);
  const policy = page.headers.get('content-security-policy');
  assert.match(policy, /script-src 'self' 'unsafe-inline'/u);
  assert.match(policy, /connect-src 'self'/u);
  assert.equal(Number(page.headers.get('content-length')), Buffer.byteLength(html));
  const head = await get(preview, { method: 'HEAD' });
  assert.equal(head.headers.get('content-length'), page.headers.get('content-length'));
  assert.equal(await head.text(), '');

  assert.equal((await get(signalUrl, { method: 'POST' })).status, 403);
  assert.equal((await get(signalUrl, { method: 'POST', headers: { Origin: 'https://otro.example' } })).status, 403);
  assert.equal((await get(signalUrl, {
    method: 'POST', headers: { Origin: preview.origin }, body: 'sin cuerpo',
  })).status, 413);

  const listeners = {};
  const document = {
    visibilityState: 'visible',
    addEventListener(name, callback) { listeners[name] = callback; },
  };
  let callback, interval;
  const signals = [];
  runInNewContext(script, {
    document,
    window: { addEventListener(name, handler) { listeners[name] = handler; } },
    setInterval(handler, ms) { callback = handler; interval = ms; },
    fetch(route, options) {
      const url = new URL(route, preview);
      assert.equal(url.href, signalUrl.href);
      assert.equal(options.method, 'POST');
      assert.equal(options.body, undefined);
      const signal = get(url, { method: options.method, headers: { Origin: preview.origin } });
      signals.push(signal);
      return signal;
    },
  });
  assert.equal(interval, idle / 4);
  async function verifySignals() {
    const requests = signals.splice(0);
    assert.ok(requests.length > 0);
    for (const pending of requests) {
      const response = await pending;
      assert.equal(response.status, 204);
      assert.equal(await response.text(), '');
    }
  }
  const started = performance.now();
  listeners.pageshow();
  await verifySignals();
  for (let i = 0; i < Math.ceil(idle / interval) + 1; i++) {
    await delay(interval);
    callback();
    await verifySignals();
  }
  assert.ok(performance.now() - started > idle);
  assert.deepEqual(await call('consultar', { id: visible.id }), visible);
  assert.deepEqual(await health(), usage);
  assert.equal(await fs.readFile(index, 'utf8'), firstMap);

  document.visibilityState = 'hidden';
  listeners.visibilitychange();
  callback();
  assert.equal(signals.length, 0);
  await assertExpired(visible);
  assert.equal((await get(signalUrl, { method: 'POST', headers: { Origin: preview.origin } })).status, 404);

  const kept = await client.call('vista_abrir', { ...publish, mantener_abierta: true });
  await delay(idle + interval);
  assert.deepEqual(await health(), usage);
  assert.deepEqual(await call('consultar', { id: kept.id }), kept);
  const updated = await call('abrir', { ...publish, id: kept.id, version: kept.version });
  assert.equal(updated.mantener_abierta, true);
  assert.equal(updated.huella, kept.huella);
  const released = await call('mantener', { id: kept.id, mantener_abierta: false });
  assert.deepEqual(released, { ...updated, mantener_abierta: false });
  await assertExpired(released);

  async function cliOpen(...flags) {
    const { stdout } = await run(path.resolve(executable), [
      'vista', 'abrir', '--base', base, '--proyecto', project, '--copia', notes, '--contenido', notes, ...flags,
    ], { env, windowsHide: true, timeout: 10_000 });
    return JSON.parse(stdout);
  }
  const cliKept = await cliOpen('--mantener-abierta');
  assert.equal(cliKept.mantener_abierta, true);
  const cliReleased = await cliOpen('--id', cliKept.id, '--version', String(cliKept.version), '--no-mantener-abierta');
  assert.equal(cliReleased.mantener_abierta, false);
  assert.equal((await call('mantener', { id: cliKept.id, mantener_abierta: true })).mantener_abierta, true);
  assert.deepEqual(await call('cerrar', { id: cliKept.id }), { id: cliKept.id, cerrada: true });
  await assertExpired(cliKept);
});


test('un sitio grande conserva una copia estable y sirve el video por tramos', {
  skip: !executable && 'Indica MIND_NATIVE_EXE',
  timeout: 60_000,
}, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(RUNS, 'vista-grande-')));
  const base = path.join(root, 'Base');
  const site = path.join(root, 'Sitio ficticio');
  const temp = path.join(root, 'Temporal');
  const media = 'recursos/demostración grande.mp4';
  let motor, client;
  t.after(async () => {
    try {
      await client?.close().catch(() => {});
      await motor?.stop();
    } finally {
      assert.equal(path.dirname(root), RUNS);
      assert.ok(path.basename(root).startsWith('vista-grande-'));
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  await fs.mkdir(path.join(site, 'recursos'), { recursive: true });
  await fs.mkdir(path.join(site, 'recursos', '.cache'));
  await fs.mkdir(path.join(site, 'recursos', 'node_modules'));
  await fs.mkdir(temp);
  const original = Buffer.alloc(9 * 1024 * 1024 + 15);
  original.write('marca de video', 140_000);
  await fs.writeFile(path.join(site, media), original);
  await fs.writeFile(path.join(site, '.gitignore'), 'generado/');
  await fs.writeFile(path.join(site, 'recursos', '.cache', 'nota.txt'), 'dato ficticio');
  await fs.writeFile(path.join(site, 'recursos', 'node_modules', 'interno.js'), 'void 0');
  await fs.writeFile(path.join(site, 'index.html'), firstMap);
  await fs.writeFile(path.join(site, 'mapa.css'), mapStyle);
  for (let n = 0; n < 258; n++) {
    await fs.writeFile(path.join(site, 'recursos', n + '.glb'), String(n));
  }

  motor = start(path.resolve(executable), ['motor', '--base', base, '--conector'], {
    ...process.env, MIND_AGENT_STARTUP: '0', TEMP: temp, TMP: temp, TMPDIR: temp,
  });
  const connector = await motor.connector(base, 'conector.json');
  const { token } = JSON.parse(await fs.readFile(path.join(base, 'conector-secreto.json'), 'utf8'));
  client = await openMcp(connector.url, {
    Authorization: 'Bearer ' + token,
    'X-Mind-Workspace': Buffer.from(JSON.stringify({ cwd: site, paths: [] })).toString('base64url'),
  }, 'Vista local grande ficticia');
  const open = { accion: 'abrir', carpeta: site, proyecto: project };
  const view = await client.call('vista', open);
  const get = (asset, options) => fetch(new URL(asset, view.url), { signal: AbortSignal.timeout(5000), ...options });
  const homepage = await get('');
  const csp = homepage.headers.get('content-security-policy');
  assert.match(csp, /img-src 'self' data: blob:;/u);
  assert.match(csp, /connect-src 'self' blob:;/u);
  assertViewHtml(await homepage.text(), firstMap);
  assert.equal(await (await get('mapa.css')).text(), mapStyle);
  for (const hidden of ['.gitignore', 'recursos/.cache/nota.txt', 'recursos/node_modules/interno.js']) {
    const res = await get(hidden);
    assert.equal(res.status, 404);
    await res.arrayBuffer();
  }
  assert.equal(await fs.readFile(path.join(site, '.gitignore'), 'utf8'), 'generado/');
  const model = await get('recursos/257.glb');
  assert.equal(model.headers.get('content-type'), 'model/gltf-binary');
  assert.equal(await model.text(), '257');

  // Each read belongs to the published revision even if the source changes.
  await fs.writeFile(path.join(site, media), 'otra revisión');
  const head = await get(media, { method: 'HEAD' });
  assert.equal(head.headers.get('content-type'), 'video/mp4');
  assert.equal(Number(head.headers.get('content-length')), original.length);
  const [slice, suffix] = await Promise.all([
    get(media, { headers: { Range: 'bytes=139999-140025' } }),
    get(media, { headers: { Range: 'bytes=-19' } }),
  ]);
  assert.equal(slice.status, 206);
  assert.equal(slice.headers.get('content-range'), 'bytes 139999-140025/' + original.length);
  assert.deepEqual(Buffer.from(await slice.arrayBuffer()), original.subarray(139999, 140026));
  assert.equal(suffix.status, 206);
  assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), original.subarray(-19));
  const missing = await get(media, { headers: { Range: 'bytes=' + original.length + '-' } });
  assert.equal(missing.status, 416);
  assert.equal(missing.headers.get('content-range'), 'bytes */' + original.length);
  assert.deepEqual(Buffer.from(await (await get(media)).arrayBuffer()), original);

  const update = { ...open, id: view.id, version: view.version };
  const index = path.join(site, 'index.html');
  await fs.rename(index, path.join(site, 'otro.html'));
  await client.call('vista', update, 'INVALID_VIEW');
  assertViewHtml(await (await get('')).text(), firstMap);
  await fs.rename(path.join(site, 'otro.html'), index);
  const next = await client.call('vista', update);
  assert.equal(next.url, view.url);
  assert.notEqual(next.huella, view.huella);
  assert.equal(await (await get(media)).text(), 'otra revisión');
  await client.call('vista', { accion: 'cerrar', id: next.id });
  assert.deepEqual((await fs.readdir(temp)).filter(n => n.startsWith('mind-vista-')), []);
});
