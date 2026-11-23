import assert from 'node:assert/strict';
import { auxiliaryProcesses } from './process-children.mjs';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { extractR3, r3Commit } from './r3-fixture.mjs';
import { RUNS } from './runs.mjs';

const executable = process.env.MIND_NATIVE_EXE;
const project = 'Proyecto Órbita';
const createdAt = '2026-01-01T00:00:00.000Z';
const updatedAt = day => new Date(Date.UTC(2026, 0, day)).toISOString();
const idFor = number => '00000000-0000-4000-8000-' + String(number).padStart(12, '0');
const channel = 'administracion-local';

async function fixture(t, { writeAccess = false } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(RUNS, 'buscar-conversaciones-')));
  const base = path.join(root, 'Base');
  const notes = path.join(root, 'Notas');
  const withoutRead = path.join(root, 'Solo encontrar');
  const unregistered = path.join(root, 'No autorizada');
  let stop = async () => {};
  t.after(async () => {
    try {
      await stop();
    } finally {
      const relative = path.relative(RUNS, root);
      assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  await Promise.all([base, notes, withoutRead, unregistered].map(folder => fs.mkdir(folder)));
  const write = (name, value) => fs.writeFile(path.join(base, name), JSON.stringify(value));
  const setContinuity = leer => write('agent-continuity-access.json', {
    format: 'mind-continuity-access', version: 1, leer, registrar: leer && writeAccess, grantedAt: createdAt, channel,
  });
  async function authorize(folder, leer, exclusions = []) {
    const id = createHash('sha256').update(process.platform === 'win32' ? folder.toLowerCase() : folder).digest('hex');
    const generation = randomUUID();
    await write('folder-authorization-' + id + '.json', {
      format: 'mind-folder-authorization', version: 3, id, path: folder, generation, exclusions,
    });
    await write('folder-access-' + id + '.json', {
      format: 'mind-folder-access', version: 1, folderId: id, generation, channel, grantedAt: createdAt,
      access: { encontrar: true, leer, escribir: leer && writeAccess, organizar: false },
    });
    return id;
  }
  await write('mind-base.json', { format: 'mind-base', version: 3, baseId: randomUUID(), createdAt });
  await setContinuity(true);
  const notesId = await authorize(notes, true, ['Privado']);
  const withoutReadId = await authorize(withoutRead, false);

  async function seed(number, title, important, options = {}) {
    const id = idFor(number);
    const file = options.file ?? path.join(notes, id + '.md');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, important);
    await write('continuity-' + id + '.json', {
      format: 'mind-continuity-entry', version: 1, id, revision: 1, createdAt,
      updatedAt: updatedAt(options.day ?? number), kind: 'conversacion', source: 'Prueba',
      content: { format: 'mind-conversation', version: 1, title, important, project: options.project ?? project, file },
      references: [],
    });
  }

  const child = spawn(executable, ['motor', '--base', base], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let diagnostic = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', text => { diagnostic = (diagnostic + text).slice(-2000); });
  child.on('error', error => { diagnostic = String(error); });
  const closed = new Promise(resolve => child.once('close', resolve));
  const lines = createInterface({ input: child.stdout });
  let connector;
  stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return closed;
    if (connector) {
      await fetch(new URL('/rpc', connector.url), {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + connector.token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ accion: 'apagar' }), signal: AbortSignal.timeout(2500),
      }).then(async response => {
        await response.text();
        if (!response.ok) child.kill();
      }).catch(() => child.kill());
    } else {
      child.kill();
    }
    await closed;
  };
  try {
    const firstLine = await Promise.race([
      once(lines, 'line', { signal: AbortSignal.timeout(15_000) }),
      closed.then(() => { throw new Error('El Motor de prueba terminó: ' + diagnostic); }),
    ]);
    connector = JSON.parse(firstLine[0]);
    assert.equal(connector.pid, child.pid);
  } finally {
    lines.close();
  }
  const openSession = name => openMcp(connector, name);
  const client = await openSession('Búsqueda ficticia');
  return { ...client, openSession, seed, setContinuity, stop, root, base, notes, notesId, withoutRead, withoutReadId, unregistered, pid: child.pid };
}

async function openMcp(connector, name) {
  const headers = {
    Authorization: 'Bearer ' + connector.token, Accept: 'application/json', 'Content-Type': 'application/json',
  };
  let nextId = 0;
  async function request(method, params) {
    const id = ++nextId;
    const response = await fetch(connector.url, {
      method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200, method);
    const reply = await response.json();
    assert.equal(reply.id, id);
    assert.equal(reply.error, undefined);
    return { ...reply.result, session: response.headers.get('mcp-session-id') };
  }
  const initialized = await request('initialize', {
    protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name, version: '1' },
  });
  assert.ok(initialized.session);
  headers['Mcp-Session-Id'] = initialized.session;
  headers['MCP-Protocol-Version'] = initialized.protocolVersion;
  async function call(name, args, error) {
    const result = await request('tools/call', { name, arguments: args });
    if (error) {
      assert.equal(result.isError, true, name);
      assert.equal(result.structuredContent.error.codigo, error);
    } else {
      assert.ok(!result.isError, JSON.stringify(result.structuredContent));
    }
    return result.structuredContent;
  }
  async function close() {
    const reply = await fetch(connector.url, { method: 'DELETE', headers, signal: AbortSignal.timeout(5000) });
    assert.equal(reply.status, 200);
    await reply.text();
  }
  return { call, request, close, session: initialized.session };
}

test('las consultas léxicas conservan la consulta clásica, ordenan alternativas y centran el extracto', {
  skip: !executable && 'Indica MIND_NATIVE_EXE', timeout: 45_000,
}, async t => {
  const f = await fixture(t);
  const body = ('🌿 contexto a\u0301ntiguo ').repeat(30) + 'ANTES CÓBRE DESPUÉS y litoral. ' + 'Contexto final. '.repeat(20);
  await f.seed(1, 'Puérto', body);
  await f.seed(2, 'Puerto Cobre', 'Solo coincide el título.', { day: 5 });
  await f.seed(3, 'Informe', 'El zafiro está en custodia.', { day: 8 });
  await f.seed(4, 'Puerto', 'Parte de una alternativa.', { day: 9 });
  await f.seed(5, 'Puerto Cobre', 'Empate de fecha y título.', { day: 5 });

  const { tools } = await f.request('tools/list');
  assert.ok(!tools.some(tool => tool.name === 'conversaciones_buscar'));
  for (const name of ['buscar', 'retomar']) {
    const tool = tools.find(tool => tool.name === name);
    assert.ok(tool, name + ' debe figurar en el catálogo visible');
    const schema = tool.inputSchema;
    assert.equal(schema.properties.consultas.maxItems, 8, name);
    assert.equal(schema.properties.consultas.items.maxLength, 256, name);
    assert.ok(schema.properties.consulta);
    if (name === 'retomar') assert.ok(schema.anyOf.some(item => item.required.includes('consultas')));
  }

  const classic = await f.call('buscar', { en: 'conversaciones', consulta: 'pUÉRTo cObRé' });
  assert.equal(classic.total, 3);
  assert.deepEqual(classic.conversaciones.map(item => item.id), [idFor(2), idFor(5), idFor(1)]);
  assert.equal(classic.conversaciones[0].extracto, 'Solo coincide el título.');
  assert.ok(!Object.hasOwn(classic, 'recientes'));
  const excerpt = classic.conversaciones[2].extracto;
  assert.equal([...excerpt].length, 240);
  assert.ok(excerpt.includes('ANTES CÓBRE DESPUÉS'));
  assert.ok([...excerpt.slice(0, excerpt.indexOf('CÓBRE'))].length > 100);

  const combined = await f.call('conversaciones_buscar', {
    consulta: 'zaFÍRo', consultas: ['puerto cobre', 'LITORÁL', 'contexto inexistente'], limite: 3,
  });
  assert.equal(combined.total, 4);
  assert.equal(combined.mostradas, 3);
  assert.deepEqual(combined.conversaciones.map(item => item.id), [idFor(1), idFor(2), idFor(5)]);
  assert.ok(combined.conversaciones[0].extracto.includes('CÓBRE'));

  const unique = await f.call('buscar', { en: 'conversaciones', consultas: ['zafiro', 'puerto cobre'] });
  assert.equal(unique.conversaciones[0].id, idFor(2));
  const repeated = await f.call('conversaciones_buscar', {
    consulta: 'ZAFÍRO', consultas: ['zafiro', 'PUERTO   COBRE', 'puerto cobre', 'zaFÍRo'],
  });
  assert.deepEqual(repeated, unique);

  const { conversacion, candidatos } = await f.call('retomar', { consultas: ['zafiro', 'litoral'] });
  assert.equal(conversacion.id, idFor(3));
  assert.deepEqual(candidatos.map(item => item.id), [idFor(1)]);
  assert.equal((await f.call('retomar', { id: idFor(4) })).conversacion.id, idFor(4));

  for (const consultas of [[], Array(9).fill('cobre'), ['  '], [42], ['á'.repeat(129)], ['texto\0']]) {
    await f.call('conversaciones_buscar', { consultas }, 'INVALID_ARGUMENTS');
  }
  assert.equal((await f.call('conversaciones_buscar', { consultas: ['á'.repeat(128)] })).total, 0);
});

test('recientes respeta el tope, el proyecto y los permisos de carpeta y continuidad', {
  skip: !executable && 'Indica MIND_NATIVE_EXE', timeout: 45_000,
}, async t => {
  const f = await fixture(t);
  for (let i = 1; i <= 12; i++) {
    await f.seed(i, 'Nota ' + i, ('Plan ficticio para la feria. ').repeat(13));
  }
  await f.seed(20, 'Otro proyecto', 'Tokenvisible', { project: 'Atlas' });
  await f.seed(21, 'Excluida', 'Tokenprivado', { file: path.join(f.notes, 'Privado', 'nota.md') });
  await f.seed(22, 'Sin permiso de lectura', 'Tokenprivado', { file: path.join(f.withoutRead, 'nota.md') });
  await f.seed(23, 'Sin autorización', 'Tokenprivado', { file: path.join(f.unregistered, 'nota.md') });

  const projectFilter = { proyecto: 'proyecto orbita' };
  const miss = await f.call('buscar', { en: 'conversaciones', consulta: 'tokenprivado', ...projectFilter });
  assert.equal(miss.total, 0);
  assert.equal(miss.mostradas, 0);
  assert.deepEqual(miss.conversaciones, []);
  assert.deepEqual(miss.recientes.map(item => item.id), Array.from({ length: 10 }, (_, i) => idFor(12 - i)));
  assert.deepEqual(Object.keys(miss.recientes[0]).sort(), ['actualizado', 'extracto', 'id', 'proyecto', 'revision', 'titulo']);
  assert.equal(miss.recientes[0].proyecto, project);
  assert.equal([...miss.recientes[0].extracto].length, 240);
  const fallback = await f.call('conversaciones_buscar', { consultas: ['tokenvisible', 'tokenprivado'], limite: 1, ...projectFilter });
  assert.equal(fallback.total, 0);
  assert.deepEqual(fallback.recientes.map(item => item.id), [idFor(12)]);
  const noProject = await f.call('conversaciones_buscar', { consultas: ['tokenvisible', 'tokenprivado'] });
  assert.deepEqual(noProject.conversaciones.map(item => item.id), [idFor(20)]);

  const resumed = await f.call('retomar', { consultas: ['tokenprivado'], limite: 2, ...projectFilter });
  assert.equal(resumed.encontrada, false);
  assert.deepEqual(resumed.candidatos, []);
  assert.deepEqual(resumed.recientes.map(item => item.id), [idFor(12), idFor(11)]);
  const emptyProject = await f.call('retomar', { consulta: 'tokenvisible', proyecto: 'Vacio' });
  assert.deepEqual(emptyProject, { encontrada: false, consulta: 'tokenvisible', candidatos: [], recientes: [] });

  const listed = await f.call('conversaciones_buscar', { limite: 1, ...projectFilter });
  assert.equal(listed.total, 12);
  assert.deepEqual(listed.conversaciones.map(item => item.id), [idFor(12)]);
  assert.ok(!Object.hasOwn(listed, 'recientes'));
  await f.setContinuity(false);
  await f.call('buscar', { en: 'conversaciones', consulta: 'tokenprivado' }, 'ACCESS_NOT_GRANTED');
  await f.call('retomar', { consultas: ['tokenprivado'] }, 'ACCESS_NOT_GRANTED');
});
test('Etapa 4: dos bancos por MCP en un Motor Rust y vuelta a r3 con la misma Base', {
  skip: !executable && 'Indica MIND_NATIVE_EXE', timeout: 90_000,
}, async t => {
  const f = await fixture(t, { writeAccess: true });
  const first = f;
  const second = await f.openSession('Segunda sesión ficticia');
  assert.notEqual(first.session, second.session);
  const clients = [first, second];
  async function assertSingleMotor() {
    for (const client of clients) {
      assert.equal((await client.call('estado', {})).motor_central.pid, f.pid);
    }
    assert.deepEqual(await auxiliaryProcesses(f.pid), []);
    await assert.rejects(fs.stat(path.join(f.base, 'conversation-index.sqlite')), { code: 'ENOENT' });
  }
  await assertSingleMotor();

  const readFixture = async name => JSON.parse(await fs.readFile(new URL('./fixtures/' + name, import.meta.url), 'utf8'));
  // El banco fijo reproduce las notas y preguntas congeladas en significado.test.mjs.
  const control = await readFixture('busqueda-etapa4.json');
  const independent = await readFixture('significado-es-independiente.json');
  const fixedProject = 'Banco fijo de Etapa 4';
  const independentProject = independent.documents[0].project;
  const records = new Map();
  const markdownFiles = [];
  const recentByProject = new Map();
  async function add(key, title, important, project, { file, visible = true, centered = false } = {}) {
    const number = records.size + 1;
    const excerptContext = 'Inicio del registro. ' + 'Contexto previo de control. '.repeat(12);
    const body = centered ? excerptContext + important + ' Contexto posterior de control.'.repeat(12) : important;
    const id = idFor(number);
    const markdown = file ?? path.join(f.notes, id + '.md');
    await f.seed(number, title, body, { project, file: markdown });
    records.set(key, id);
    markdownFiles.push(markdown);
    if (visible) {
      const recent = recentByProject.get(project) ?? [];
      recent.unshift(id);
      recentByProject.set(project, recent);
    }
  }

  for (const [i, [title]] of control.fixed.entries()) {
    await add('borrador-' + i, 'Borrador ' + title, 'Queda pendiente revisar el tema en la reunión.', fixedProject);
  }
  for (const [i, [title, important]] of control.fixed.entries()) {
    await add('fija-' + i, title, important, fixedProject, { centered: true });
  }
  const independentAnswers = new Set(independent.positives.map(({ key }) => key));
  for (const { key, title, important, project } of independent.documents) {
    await add(key, title, important, project, { centered: independentAnswers.has(key) });
  }

  const hiddenRelative = 'Privado/nota.md';
  const hiddenFile = path.join(f.notes, hiddenRelative);
  const [title, important] = control.fixed[0];
  const secret = 'marcador etaprivada';
  await add('excluida', title, important + ' ' + secret, fixedProject, { file: hiddenFile, visible: false });
  await add('sin-lectura', title, important + ' ' + secret, fixedProject, {
    file: path.join(f.withoutRead, 'sin-lectura.md'), visible: false,
  });
  await add('otro-proyecto', title, important + ' ' + secret, 'Proyecto ajeno ficticio');
  const foreign = await second.call('conversaciones_buscar', { consulta: secret });
  assert.deepEqual(foreign.conversaciones.map(({ id }) => id), [records.get('otro-proyecto')]);

  async function assertEmpty(query, project) {
    const expected = (recentByProject.get(project) ?? []).slice(0, 10);
    const listing = await first.call('buscar', {
      en: 'conversaciones', consulta: query.replace(/[¿?]/gu, ''), proyecto: project,
    });
    assert.equal(listing.total, 0, query);
    assert.deepEqual(listing.conversaciones, [], query);
    assert.equal(listing.semantica.estado, 'no_disponible', query);
    assert.deepEqual(listing.recientes.map(({ id }) => id), expected, query);
    assert.ok(listing.recientes.every(item => item.proyecto === project), query);
    const resumed = await second.call('retomar', { consulta: query, proyecto: project });
    assert.equal(resumed.encontrada, false, query);
    assert.deepEqual(resumed.candidatos, [], query);
    assert.deepEqual(resumed.recientes, listing.recientes, query);
  }

  async function assertAnswer({ key, distractor, query, evidence, consultas, project }) {
    const id = records.get(key);
    const other = records.get(distractor);
    const result = await first.call('conversaciones_buscar', { consultas, proyecto: project });
    const [winner] = result.conversaciones;
    assert.equal(winner?.id, id, query);
    assert.equal(result.semantica.estado, 'no_disponible', query);
    assert.ok(result.conversaciones.slice(1).some(item => item.id === other), query);
    assert.ok(result.conversaciones.every(item => item.proyecto === project
      && item.id !== records.get('excluida') && item.id !== records.get('sin-lectura')), query);
    assert.equal([...winner.extracto].length, 240, query);
    assert.ok(winner.extracto.includes(evidence), query);
    assert.ok(!winner.extracto.startsWith('Inicio del registro.'), query);
    assert.equal((await second.call('retomar', { consultas, proyecto: project })).conversacion.id, id, query);
    await assertEmpty(query, project);
  }

  for (const [i, [, , query, evidence, consultas]] of control.fixed.entries()) {
    await assertAnswer({ key: 'fija-' + i, distractor: 'borrador-' + i, query, evidence, consultas, project: fixedProject });
  }
  for (const answer of independent.positives) {
    const [distractor, consultas] = control.independent[answer.key];
    await assertAnswer({ ...answer, distractor, consultas, project: independentProject });
  }
  for (const query of control.fixedUnanswered) await assertEmpty(query, fixedProject);
  for (const query of [...independent.negatives, ...independent.nearMisses]) await assertEmpty(query, independentProject);
  await assertEmpty(secret, fixedProject);

  await f.setContinuity(false);
  await first.call('buscar', { en: 'conversaciones', consultas: ['factura'], proyecto: fixedProject }, 'ACCESS_NOT_GRANTED');
  await second.call('retomar', { consulta: secret, proyecto: fixedProject }, 'ACCESS_NOT_GRANTED');
  await f.setContinuity(true);

  const saved = (await first.call('conversacion_guardar', {
    titulo: 'Acta ficticia del relevo',
    importante: 'La segunda sesión retoma el mismo registro y conserva el Markdown.',
    proyecto: 'Relevo ficticio',
    destino: path.join(f.notes, 'Acta.md'),
  })).conversacion;
  assert.deepEqual((await second.call('retomar', { id: saved.id })).conversacion, { ...saved, resultados: [] });
  await assertSingleMotor();

  const snapshotPaths = [
    saved.archivo, ...markdownFiles, path.join(f.base, 'mind-base.json'),
    path.join(f.base, 'agent-continuity-access.json'),
    path.join(f.base, 'folder-authorization-' + f.notesId + '.json'),
    path.join(f.base, 'folder-access-' + f.notesId + '.json'),
    path.join(f.base, 'folder-authorization-' + f.withoutReadId + '.json'),
    path.join(f.base, 'folder-access-' + f.withoutReadId + '.json'),
    ...[saved.id, ...records.values()].map(id => path.join(f.base, 'continuity-' + id + '.json')),
  ];
  const snapshot = await Promise.all(snapshotPaths.map(file => fs.readFile(file)));
  await Promise.all(clients.map(client => client.close()));
  await f.stop();

  const old = await extractR3(f.root);
  const { startCentralMotor } = await import(JSON.parse(old('motor-central.js')));
  const { resolveLayout } = await import(JSON.parse(old('layout.js')));
  const layout = await resolveLayout({ base: f.base, env: { ...process.env, MIND_AGENT_STARTUP: '0' } });
  const rollback = await startCentralMotor({
    layout, motorVersion: '1.0.4', observe: false, discoverUpdates: null, preferredPort: 0,
  });
  try {
    assert.equal(rollback.alreadyRunning, false);
    const r3 = await openMcp(rollback, 'Retoma desde r3');
    try {
      const recovered = (await r3.call('conversacion_leer', { id: saved.id })).conversacion;
      for (const field of ['id', 'revision', 'titulo', 'importante', 'archivo', 'referencias']) {
        assert.deepEqual(recovered[field], saved[field], field);
      }
      assert.deepEqual(await rollback.session.policy.getContinuity(), {
        leer: true, registrar: true, channel, grantedAt: createdAt,
      });
      assert.deepEqual((await rollback.session.motor.getAuthorizedFolder(f.notesId)).exclusions, ['Privado']);
      await r3.call('leer', { carpeta: f.notesId, ruta: hiddenRelative }, 'PATH_EXCLUDED');
      await r3.call('leer', { carpeta: f.withoutReadId, ruta: 'sin-lectura.md' }, 'ACCESS_NOT_GRANTED');
      assert.equal((await r3.call('leer', { carpeta: f.notesId, ruta: 'Acta.md' })).contenido, snapshot[0].toString('utf8'));
    } finally {
      await r3.close();
    }
  } finally {
    await rollback.stop('fin-prueba-busqueda-etapa4');
  }
  assert.deepEqual(await Promise.all(snapshotPaths.map(file => fs.readFile(file))), snapshot);
  t.diagnostic('Dos sesiones MCP, PID Rust ' + f.pid + ', sin auxiliares ni índice semántico.');
  t.diagnostic('Alternativas y extracto: 10/10 y 8/8 en primer lugar. Preguntas literales sin coincidencia: 28/28 con recientes (18 reformuladas y 10 sin respuesta).');
  t.diagnostic('r3 ' + r3Commit.slice(0, 7) + ' recuperó el ID ' + saved.id + ' con permisos, exclusiones y Markdown intactos.');
});
