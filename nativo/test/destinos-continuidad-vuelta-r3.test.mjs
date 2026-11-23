import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { extractR3, r3Commit } from './r3-fixture.mjs';
import { RUNS } from './runs.mjs';

const executable = process.env.MIND_NATIVE_EXE;
const env = { ...process.env, MIND_AGENT_STARTUP: '0' };
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function openMcp({ url, token }, name) {
  const headers = {
    Authorization: 'Bearer ' + token, Accept: 'application/json', 'Content-Type': 'application/json',
  };
  let nextId = 0;
  async function request(method, params) {
    const id = ++nextId;
    const response = await fetch(url, {
      method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      signal: AbortSignal.timeout(20_000),
    }).catch(error => { throw new Error(method + ' ' + (params?.name ?? '') + ' ' + (params?.arguments?.operacion ?? '') + ': ' + error, { cause: error }); });
    assert.equal(response.status, 200, method);
    const data = await response.json();
    assert.equal(data.id, id, method);
    assert.equal(data.error, undefined, JSON.stringify(data.error));
    return { result: data.result, session: response.headers.get('Mcp-Session-Id') };
  }
  const initialized = await request('initialize', {
    protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name, version: '1' },
  });
  assert.ok(initialized.session);
  headers['Mcp-Session-Id'] = initialized.session;
  headers['MCP-Protocol-Version'] = initialized.result.protocolVersion;
  return {
    async call(name, args = {}, error) {
      const { result } = await request('tools/call', { name, arguments: args });
      if (error) {
        assert.equal(result.isError, true, name);
        assert.equal(result.structuredContent.error.codigo, error, JSON.stringify(result.structuredContent));
      } else {
        assert.ok(!result.isError, name + ' ' + JSON.stringify(result.structuredContent));
      }
      return result.structuredContent;
    },
    async list() {
      return (await request('tools/list')).result.tools.map(tool => tool.name);
    },
    async close() {
      const response = await fetch(url, { method: 'DELETE', headers, signal: AbortSignal.timeout(5000) });
      assert.ok(response.ok);
      await response.text();
    },
  };
}

test('5A: destinos, resultados, continuidad y traslado por MCP con vuelta al tag r3', {
  skip: !executable && 'Indica MIND_NATIVE_EXE', timeout: 120_000,
}, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(RUNS, 'mind-5a-')));
  const base = path.join(root, 'Base');
  const notes = path.join(root, 'Trabajo');
  const unreadable = path.join(root, 'Solo encontrar');
  const outside = path.join(root, 'Sin permiso');
  const excluded = path.join(notes, 'Privado');
  let motor, closed, rollback;
  t.after(async () => {
    try {
      await rollback?.stop('fin-prueba-5a');
      if (motor && motor.exitCode === null && motor.signalCode === null) motor.kill();
      await closed;
    } finally {
      assert.equal(path.dirname(root), RUNS);
      assert.ok(path.basename(root).startsWith('mind-5a-'));
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
  await Promise.all([base, unreadable, outside, excluded].map(dir => fs.mkdir(dir, { recursive: true })));

  const old = await extractR3(root);
  const { openSession } = await import(JSON.parse(old('session.js')));
  const { resolveLayout } = await import(JSON.parse(old('layout.js')));
  const layout = await resolveLayout({ base, env });
  const setup = await openSession({ layout, motorVersion: '1.0.4', observe: false });
  let folder;
  try {
    await setup.start();
    folder = await setup.motor.authorizeFolder(notes);
    const limited = await setup.motor.authorizeFolder(unreadable);
    await setup.policy.set(folder.id, ['encontrar', 'leer', 'escribir', 'organizar'], { channel: 'administracion-local' });
    await setup.policy.set(limited.id, ['encontrar'], { channel: 'administracion-local' });
    await setup.motor.setFolderExclusions(folder.id, ['Privado']);
    await setup.policy.setContinuity(['leer', 'registrar'], { channel: 'administracion-local' });
    await setup.motor.configureWorkDestinations({
      destinations: { carpeta: notes }, expectedRevision: 0,
    });
  } finally {
    await setup.close();
  }

  motor = spawn(path.resolve(executable), ['motor', '--base', base], {
    cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let diagnostics = '';
  t.after(() => { if (diagnostics && motor.exitCode !== 0) t.diagnostic(diagnostics); });
  motor.stderr.setEncoding('utf8');
  motor.stderr.on('data', text => { diagnostics = (diagnostics + text).slice(-3000); });
  motor.on('error', error => { diagnostics = String(error); });
  closed = new Promise(resolve => motor.once('close', resolve));
  const lines = createInterface({ input: motor.stdout });
  let connector;
  try {
    const [line] = await Promise.race([
      once(lines, 'line', { signal: AbortSignal.timeout(15_000) }),
      closed.then(() => { throw new Error('El Motor Rust de prueba terminó: ' + diagnostics); }),
    ]);
    connector = JSON.parse(line);
  } finally {
    lines.close();
  }
  assert.equal(connector.pid, motor.pid);
  const client = await openMcp(connector, 'Cliente ficticio 5A');
  const read = (op, args = {}, error) => client.call('mind', { operacion: op, argumentos: args }, error);
  const change = (op, args = {}, error) => client.call('mind_cambiar', { operacion: op, argumentos: args }, error);

  const readers = ['destinos_consultar', 'destino_resolver', 'continuidad_consultar', 'conversacion_preferencias'];
  const writers = ['destinos_configurar', 'destino_resolver', 'resultado_registrar', 'resultado_importar',
    'conversacion_configurar', 'conversacion_trasladar'];
  const help = await client.call('mind', { operacion: 'ayuda' });
  const visible = await client.list();
  for (const [group, names] of [[help.mind, readers], [help.mind_cambiar, writers]]) {
    for (const name of names) {
      assert.ok(group.some(item => item.nombre === name), name);
      assert.ok(!visible.includes(name), name);
    }
  }
  await read('destinos_configurar', {}, 'USE_MIND_CAMBIAR');
  await change('continuidad_consultar', {}, 'USE_MIND');
  await read('destino_resolver', { nombre: 'prueba.md', preparar: true }, 'USE_MIND_CAMBIAR');

  const first = await read('destinos_consultar');
  assert.equal(first.revision, 1);
  assert.equal(first.predeterminado, notes);
  assert.deepEqual(first.general, { carpeta: notes });
  const general = path.join(notes, 'General');
  const projectDir = path.join(notes, 'Proyecto');
  const reportDir = path.join(notes, 'Informes');
  const project = 'Proyecto Órbita';
  assert.equal((await change('destinos_configurar', { revision: 1, destinos: { carpeta: general } })).revision, 2);
  await change('destinos_configurar', { revision: 1, destinos: null }, 'DESTINATIONS_REVISION_CONFLICT');
  assert.equal((await client.call('destinos_configurar', {
    revision: 2, proyecto: project, destinos: { carpeta: projectDir },
  })).revision, 3);

  const onlyFind = path.join(unreadable, 'origen.png');
  const privateFile = path.join(excluded, 'origen.png');
  const outsideFile = path.join(outside, 'entrega.txt');
  const absent = path.join(notes, 'inexistente.txt');
  await fs.writeFile(outsideFile, 'Entrega ficticia.');
  const related = (await client.call('continuidad_registrar', {
    referencias: [onlyFind, privateFile, outsideFile, absent, reportDir].map(ubicacion => ({ ubicacion })),
    tipo: 'acuerdo', contenido: { resumen: 'Evidencia de Órbita' },
  })).registro;
  const referred = path.join(notes, 'ficha.txt');
  const web = 'https://ejemplo.invalid/registro';
  await fs.writeFile(referred, 'Referencia ficticia.\n');
  const saved = (await client.call('conversacion_guardar', {
    titulo: 'Nota del proyecto', importante: 'Decisión para Órbita.', proyecto: project,
    referencias: [{ registro: related.id }, { ubicacion: referred }, { ubicacion: notes }, { ubicacion: web }],
  })).conversacion;
  const id = saved.id;
  assert.equal(path.dirname(saved.archivo), projectDir);
  const original = await fs.readFile(saved.archivo);
  const initialPreferences = await read('conversacion_preferencias', { id });
  assert.equal(initialPreferences.revision_conversacion, 1);
  assert.equal(initialPreferences.heredada, true);
  assert.equal(initialPreferences.efectiva.modo, 'esencial');
  const modifiedGlobal = await change('conversacion_configurar', { revision: 0, preferencias: { modo: 'detallado' } });
  assert.equal(modifiedGlobal.revision, 1);
  const modifiedConversation = await client.call('conversacion_configurar', {
    id, revision: 1, preferencias: { modo: 'manual', carpeta_destino: general },
  });
  assert.equal(modifiedConversation.revision_conversacion, 2);
  assert.equal(modifiedConversation.efectiva.automatica, false);
  const inheritedAgain = await change('conversacion_configurar', { id, revision: 2, preferencias: null });
  assert.equal(inheritedAgain.revision_conversacion, 3);
  assert.equal(inheritedAgain.efectiva.modo, 'detallado');
  await change('conversacion_configurar', { id, revision: 2, preferencias: null }, 'CONTINUITY_REVISION_CONFLICT');
  const finalPreferences = await change('conversacion_configurar', {
    id, revision: 3, preferencias: { modo: 'personalizado', reglas: 'Guardar acuerdos', carpeta_destino: general },
  });
  assert.deepEqual(await client.call('conversacion_preferencias', { id }), finalPreferences);
  assert.deepEqual(await fs.readFile(saved.archivo), original);

  await change('destinos_configurar', {
    revision: 3, conversacion: id, destinos: { tipos: { documentos: reportDir } },
  });
  const selected = await client.call('destinos_consultar', { conversacion: id, proyecto: 'proyecto orbita' });
  assert.equal(selected.efectivos.documentos, reportDir);
  assert.equal(selected.efectivos.codigo, projectDir);
  assert.deepEqual(selected.memoria, { modo: 'personalizado', reglas: 'Guardar acuerdos', archivo: saved.archivo });
  const resolveArgs = { conversacion: id, nombre: 'nueva/entrega.txt' };
  const resolved = await read('destino_resolver', resolveArgs);
  assert.deepEqual(await client.call('destino_resolver', resolveArgs), resolved);
  assert.equal(resolved.origen, 'preferencia');
  assert.equal(resolved.ruta_absoluta, path.join(reportDir, 'nueva', 'entrega.txt'));
  await assert.rejects(fs.stat(path.dirname(resolved.ruta_absoluta)), { code: 'ENOENT' });
  assert.deepEqual(await change('destino_resolver', { ...resolveArgs, preparar: true }), resolved);
  assert.ok((await fs.stat(path.dirname(resolved.ruta_absoluta))).isDirectory());
  await assert.rejects(fs.stat(resolved.ruta_absoluta), { code: 'ENOENT' });
  await read('destino_resolver', { nombre: '../fuga.txt' }, 'INVALID_DESTINATIONS');
  await read('destino_resolver', { destino: path.join(outside, 'no.txt') }, 'FOLDER_NOT_AUTHORIZED');
  await read('destino_resolver', { destino: path.join(excluded, 'privado.txt') }, 'PATH_EXCLUDED');

  await client.call('crear', { carpeta: resolved.carpeta, ruta: resolved.ruta, contenido: 'Entrega ficticia.' });
  assert.equal((await change('resultado_registrar', { conversacion: id, ruta: resolved.ruta_absoluta })).resultado.bytes, Buffer.byteLength('Entrega ficticia.'));
  assert.equal((await client.call('resultado_registrar', {
    conversacion: id, ruta: resolved.ruta_absoluta,
  })).resultado.path, resolved.ruta_absoluta);
  await change('resultado_registrar', { conversacion: id, ruta: path.join(notes, 'inexistente.txt') }, 'FILE_NOT_FOUND');

  const source = path.join(notes, 'imagen.png');
  const payload = Buffer.alloc(2 * 1024 * 1024 + 71);
  for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
  await fs.writeFile(source, payload);
  await fs.writeFile(path.join(unreadable, 'origen.png'), payload.subarray(0, 10));
  await fs.writeFile(path.join(excluded, 'origen.png'), payload.subarray(0, 10));
  const copied = await change('resultado_importar', { conversacion: id, origen: source });
  assert.equal(copied.registro.estado, 'registrado');
  assert.equal(copied.ruta_absoluta, path.join(projectDir, 'imagen.png'));
  assert.equal(copied.sha256, sha256(payload));
  assert.deepEqual(await fs.readFile(copied.ruta_absoluta), payload);
  assert.deepEqual(await fs.readFile(source), payload);
  assert.equal((await fs.stat(copied.ruta_absoluta)).nlink, 1);
  await client.call('resultado_importar', { conversacion: id, origen: source }, 'FILE_EXISTS');
  await change('resultado_importar', { conversacion: id, origen: path.join(unreadable, 'origen.png') }, 'ACCESS_NOT_GRANTED');
  await change('resultado_importar', { conversacion: id, origen: path.join(excluded, 'origen.png') }, 'PATH_EXCLUDED');
  const hardlink = path.join(notes, 'enlace.png');
  await fs.link(source, hardlink);
  await change('resultado_importar', { conversacion: id, origen: hardlink }, 'UNSAFE_PATH');
  await fs.unlink(hardlink);

  const queried = await read('continuidad_consultar', {
    texto: 'DECISION PARA ORBITA', tipo: 'conversacion', ids: [id], relacionados: true, limite: 3,
  });
  assert.equal(queried.total, 1);
  assert.equal(queried.registros[0].id, id);
  assert.deepEqual(queried.relacionados.map(item => item.id), [related.id]);
  assert.equal(queried.registros[0].referencias.find(ref => ref.ubicacion === referred).estado, 'existe');
  assert.equal(queried.registros[0].referencias.find(ref => ref.ubicacion === web).estado, undefined);
  const states = new Map(queried.relacionados[0].referencias.map(ref => [ref.ubicacion, ref.estado]));
  assert.equal(states.get(onlyFind), 'existe');
  assert.equal(states.get(reportDir), 'existe');
  for (const hidden of [privateFile, outsideFile, absent]) assert.equal(states.get(hidden), 'desconocido');
  await assert.rejects(fs.stat(path.join(base, 'folder-index-' + folder.id + '.json')), { code: 'ENOENT' });
  const byDate = await client.call('continuidad_consultar', { ids: [id], desde: '2000-01-01T04:00:00-05:00' });
  assert.equal(byDate.mostrados, 1);
  await client.call('continuidad_consultar', { desde: '2000-01-01T04:00:00+€1' }, 'INVALID_ARGUMENTS');
  await client.call('continuidad_consultar', { ids: ['00000000-0000-4000-8000-000000000099'] }, 'CONTINUITY_NOT_FOUND');

  const consentPath = path.join(base, 'agent-continuity-access.json');
  const consent = JSON.parse(await fs.readFile(consentPath, 'utf8'));
  await fs.writeFile(consentPath, JSON.stringify({ ...consent, registrar: false }));
  await change('destinos_configurar', { revision: 4, destinos: null }, 'ACCESS_NOT_GRANTED');
  await change('resultado_registrar', { conversacion: id, ruta: resolved.ruta_absoluta }, 'ACCESS_NOT_GRANTED');
  await fs.writeFile(consentPath, JSON.stringify({ ...consent, leer: false, registrar: false }));
  await read('continuidad_consultar', {}, 'ACCESS_NOT_GRANTED');
  await read('conversacion_preferencias', {}, 'ACCESS_NOT_GRANTED');
  await read('destinos_consultar', {}, 'ACCESS_NOT_GRANTED');
  const independentCopy = await client.call('resultado_importar', {
    origen: source, destino: path.join(notes, 'entrega-sin-conversacion.png'),
  });
  assert.deepEqual(independentCopy.registro, { estado: 'sin_conversacion' });
  assert.equal(independentCopy.sha256, sha256(payload));
  await fs.writeFile(consentPath, JSON.stringify(consent));

  const resultsPath = path.join(base, 'conversation-results-' + id + '.json');
  const destinationsPath = path.join(base, 'work-destinations.json');
  const oldResults = await fs.readFile(resultsPath, 'utf8');
  const oldDestinations = await fs.readFile(destinationsPath, 'utf8');
  const destination = path.join(notes, 'Reunido');
  const memoryTarget = path.join(destination, 'memoria', path.basename(saved.archivo));
  await fs.mkdir(path.dirname(memoryTarget), { recursive: true });
  await fs.writeFile(memoryTarget, 'Otro archivo.');
  const move = { id, revision: 4, destino: destination };
  await change('conversacion_trasladar', move, 'FILE_EXISTS');
  assert.equal(await fs.readFile(memoryTarget, 'utf8'), 'Otro archivo.');
  await fs.unlink(memoryTarget);
  const moved = await change('conversacion_trasladar', move);
  assert.equal(moved.estado, 'trasladada', JSON.stringify(moved));
  assert.equal(moved.id, id);
  assert.equal(moved.revision, 5);
  assert.equal(moved.archivo, memoryTarget);
  assert.equal(moved.origenes_conservados, true);
  assert.deepEqual(moved.referencias_externas, [notes]);
  assert.equal(moved.archivos.length, 4);
  for (const { origen, archivo, bytes, sha256: hash } of moved.archivos) {
    const original = await fs.readFile(origen);
    const result = await fs.readFile(archivo);
    assert.deepEqual(result, original);
    assert.equal(hash, sha256(result));
    assert.equal(bytes, result.length);
  }
  assert.deepEqual(await fs.readFile(saved.archivo), original);
  const noChanges = await client.call('conversacion_trasladar', { ...move, revision: moved.revision });
  assert.equal(noChanges.ya_trasladada, true);
  const rustMemory = await client.call('conversacion_leer', { id });
  const rustPreferences = await client.call('conversacion_preferencias', { id });
  const rustDestinations = await client.call('destinos_consultar', { conversacion: id });
  assert.equal(rustMemory.conversacion.resultados.length, 3);
  assert.equal(rustMemory.conversacion.referencias.find(ref => ref.ubicacion?.endsWith('ficha.txt')).ubicacion,
    path.join(destination, 'documentos', 'ficha.txt'));
  assert.equal(rustPreferences.efectiva.carpeta_destino, path.join(destination, 'memoria'));
  assert.equal(rustDestinations.efectivos.imagenes, path.join(destination, 'imagenes'));

  const record = JSON.parse(await fs.readFile(path.join(base, 'continuity-' + id + '.json'), 'utf8'));
  const results = JSON.parse(await fs.readFile(resultsPath, 'utf8'));
  const journalPath = path.join(base, 'conversation-relocation.json');
  const pending = JSON.stringify({
    format: 'mind-conversation-relocation', version: 1, kind: 'metadata', id, revision: move.revision,
    file: record.content.file, references: record.references, preferences: record.content.preferences,
    results: results.results, resultsRevision: JSON.parse(oldResults).revision,
    destinations: rustDestinations.conversacion, destinationsRevision: JSON.parse(oldDestinations).revision,
  });
  // Simula un corte después de publicar la conversación y antes de publicar sus dos registros asociados.
  await fs.writeFile(resultsPath, oldResults);
  await fs.writeFile(destinationsPath, oldDestinations);
  await fs.writeFile(journalPath, pending);
  assert.deepEqual(await client.call('conversacion_leer', { id }), rustMemory);
  assert.deepEqual(await client.call('destinos_consultar', { conversacion: id }), rustDestinations);
  await assert.rejects(fs.stat(journalPath), { code: 'ENOENT' });

  await client.close();
  const stop = await fetch(new URL('/rpc', connector.url), {
    method: 'POST', headers: { Authorization: 'Bearer ' + connector.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ accion: 'apagar' }), signal: AbortSignal.timeout(5000),
  });
  assert.ok(stop.ok);
  await stop.text();
  await closed;
  assert.equal(motor.exitCode, 0);

  // El mismo diario permite a r3 completar el último registro tras el relevo.
  await fs.writeFile(destinationsPath, oldDestinations);
  await fs.writeFile(journalPath, pending);
  const { startCentralMotor } = await import(JSON.parse(old('motor-central.js')));
  rollback = await startCentralMotor({ layout, motorVersion: '1.0.4', observe: false, discoverUpdates: null, preferredPort: 0 });
  assert.equal(rollback.alreadyRunning, false);
  const r3 = await openMcp(rollback, 'Cliente r3 sobre la misma Base');
  try {
    assert.deepEqual(await r3.call('destinos_consultar', { conversacion: id }), rustDestinations);
    await assert.rejects(fs.stat(journalPath), { code: 'ENOENT' });
    assert.deepEqual(await r3.call('conversacion_preferencias', { id }), rustPreferences);
    assert.deepEqual(await r3.call('conversacion_leer', { id }), rustMemory);
    assert.equal((await r3.call('continuidad_consultar', { ids: [id], relacionados: true })).relacionados[0].id, related.id);
    assert.equal((await r3.call('leer', {
      carpeta: folder.id, ruta: path.relative(notes, memoryTarget).split(path.sep).join('/'),
    })).contenido, original.toString('utf8'));
    assert.deepEqual((await rollback.session.motor.getAuthorizedFolder(folder.id)).exclusions, ['Privado']);
  } finally {
    await r3.close();
  }
  t.diagnostic('Nueve operaciones por MCP; r3 ' + r3Commit.slice(0, 7) + ' leyó el mismo ID, revisión, destinos, resultados y preferencias.');
});
