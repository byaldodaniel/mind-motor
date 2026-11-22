import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { extractR3, r3Commit } from './r3-fixture.mjs';
import { RUNS } from './runs.mjs';

const executable = process.env.MIND_NATIVE_EXE;
const env = { ...process.env, MIND_AGENT_STARTUP: '0' };
const operations = ['propiedades', 'agrupar', 'indices_personalizados', 'asignar_propiedades',
  'crear_indice', 'actualizar_indice', 'modificar_indice', 'retirar_indice'];

async function connect({ url, token }) {
  const headers = {
    Authorization: 'Bearer ' + token, Accept: 'application/json', 'Content-Type': 'application/json',
  };
  let id = 0;
  async function request(method, params) {
    const response = await fetch(url, {
      method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
      signal: AbortSignal.timeout(15_000),
    });
    assert.equal(response.status, 200, method);
    const data = await response.json();
    assert.equal(data.id, id, method);
    assert.equal(data.error, undefined, JSON.stringify(data.error));
    return { result: data.result, session: response.headers.get('Mcp-Session-Id') };
  }
  const initialized = await request('initialize', {
    protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'Prueba 5B', version: '1' },
  });
  assert.ok(initialized.session);
  headers['Mcp-Session-Id'] = initialized.session;
  headers['MCP-Protocol-Version'] = initialized.result.protocolVersion;
  return {
    async call(name, args = {}, error) {
      const { result } = await request('tools/call', { name, arguments: args });
      const value = result.structuredContent;
      assert.equal(Boolean(result.isError), Boolean(error), name + ' ' + JSON.stringify(value));
      if (error) assert.equal(value.error.codigo, error, JSON.stringify(value));
      return value;
    },
    async list() {
      return (await request('tools/list')).result.tools;
    },
    async close() {
      const response = await fetch(url, { method: 'DELETE', headers, signal: AbortSignal.timeout(5000) });
      assert.ok(response.ok);
      await response.text();
    },
  };
}

async function stopNative(connector) {
  const response = await fetch(new URL('/rpc', connector.url), {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + connector.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ accion: 'apagar' }), signal: AbortSignal.timeout(5000),
  });
  assert.ok(response.ok);
  await response.text();
}

async function waitForFile(filename, predicate) {
  const end = Date.now() + 12_000;
  do {
    const content = await fs.readFile(filename, 'utf8');
    if (predicate(content)) return content;
    await delay(200);
  } while (Date.now() < end);
  assert.fail('No se actualizó el CSV al cambiar la carpeta de origen.');
}

test('5B: propiedades, agrupación e índices CSV por MCP y lectura con el tag r3', {
  skip: !executable && 'Indica MIND_NATIVE_EXE', timeout: 120_000,
}, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(RUNS, 'mind-5b-')));
  const base = path.join(root, 'Base');
  const notes = path.join(root, 'Trabajo');
  const limited = path.join(root, 'Solo encontrar');
  const note = path.join(notes, 'Plan', 'agenda.md');
  const privateDir = path.join(notes, 'Privado');
  const text = '# Calendario\n\n- [ ] Preparar presupuesto #seguimiento\n- [x] Cerrar balance #seguimiento\n\n```md\n#seguimiento\n```\n';
  let motor, closed, rollback;
  t.after(async () => {
    try {
      await rollback?.stop('fin-prueba-5b');
      if (motor && motor.exitCode === null && motor.signalCode === null) motor.kill();
      await closed;
    } finally {
      assert.equal(path.dirname(root), RUNS);
      assert.ok(path.basename(root).startsWith('mind-5b-'));
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
  await Promise.all([base, path.dirname(note), privateDir, limited].map(dir => fs.mkdir(dir, { recursive: true })));
  await Promise.all([
    fs.writeFile(note, text),
    fs.writeFile(path.join(privateDir, 'excluida.md'), '- [ ] Confidencial #seguimiento\n'),
    fs.writeFile(path.join(limited, 'sin-lectura.md'), '- [ ] Reservado #seguimiento\n'),
  ]);
  const source = await extractR3(root);
  const { openSession } = await import(JSON.parse(source('session.js')));
  const { resolveLayout } = await import(JSON.parse(source('layout.js')));
  const layout = await resolveLayout({ base, env });
  const setup = await openSession({ layout, motorVersion: '1.0.4', observe: false });
  let folder, findOnly;
  try {
    await setup.start();
    folder = (await setup.motor.authorizeFolder(notes)).id;
    findOnly = (await setup.motor.authorizeFolder(limited)).id;
    await setup.policy.set(folder, ['encontrar', 'leer', 'escribir', 'organizar'], { channel: 'administracion-local' });
    await setup.policy.set(findOnly, ['encontrar'], { channel: 'administracion-local' });
    await setup.motor.setFolderExclusions(folder, ['Privado']);
  } finally {
    await setup.close();
  }

  motor = spawn(path.resolve(executable), ['motor', '--base', base], {
    cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let diagnostics = '';
  motor.stderr.setEncoding('utf8');
  motor.stderr.on('data', text => { diagnostics = (diagnostics + text).slice(-3000); });
  motor.on('error', error => { diagnostics = String(error); });
  closed = new Promise(resolve => motor.once('close', resolve));
  const lines = createInterface({ input: motor.stdout });
  let connector;
  try {
    const [line] = await Promise.race([
      once(lines, 'line', { signal: AbortSignal.timeout(15_000) }),
      closed.then(() => { throw new Error('El Motor Rust de prueba terminó. ' + diagnostics); }),
    ]);
    connector = JSON.parse(line);
  } finally {
    lines.close();
  }
  assert.equal(connector.pid, motor.pid);
  const client = await connect(connector);
  const read = (operacion, argumentos = {}, error) => client.call('mind', { operacion, argumentos }, error);
  const change = (operacion, argumentos = {}, error) => client.call('mind_cambiar', { operacion, argumentos }, error);
  const names = (await client.list()).map(tool => tool.name);
  assert.ok(operations.every(op => !names.includes(op)));
  for (const op of operations) {
    const help = await client.call('mind', { operacion: 'ayuda', detalle: op });
    assert.equal(help.operacion, op);
    assert.equal(help.herramienta, operations.indexOf(op) < 3 ? 'mind' : 'mind_cambiar');
  }

  const target = { carpeta: folder, ruta: 'Plan/agenda.md' };
  const properties = { etapa: 'Revisión', importe: 120.5, urgente: true, cliente: '=1+1' };
  await change('asignar_propiedades', { ...target, asignar: { ...properties, temporal: true } });
  assert.deepEqual((await client.call('asignar_propiedades', { ...target, quitar: ['temporal'] })).propiedades, properties);
  const saved = await read('propiedades', target);
  assert.deepEqual(saved.propiedades, properties);
  assert.deepEqual(await client.call('propiedades', target), saved);
  assert.equal(await fs.readFile(note, 'utf8'), text);
  const propDisk = JSON.parse(await fs.readFile(path.join(base, `folder-properties-${folder}.json`), 'utf8'));
  assert.equal(propDisk.format, 'mind-folder-properties');
  assert.equal(propDisk.version, 2);
  assert.match(propDisk.entries[0].identity, /^(nt|posix):\d+:\d+$/);

  const editable = { carpeta: folder, ruta: 'edicion.txt' };
  const createdText = await client.call('crear', { ...editable, contenido: 'Antes' });
  await change('asignar_propiedades', { ...editable, asignar: { auditor: true } });
  await client.call('modificar', { ...editable, version: createdText.version, contenido: 'Después' });
  assert.deepEqual((await read('propiedades', editable)).propiedades, { auditor: true });
  const renamed = await client.call('organizar', { accion: 'renombrar', ...editable, nuevo_nombre: 'editado.txt' });
  assert.equal(renamed.propiedades_trasladadas, 1);
  assert.deepEqual((await read('propiedades', { ...editable, ruta: 'editado.txt' })).propiedades, { auditor: true });

  const search = { en: 'archivos', carpeta: folder, dentro_de: 'Plan', extensiones: ['md'] };
  const found = await client.call('buscar', { ...search, propiedades: { etapa: 'REVISION', importe: 120.5 } });
  assert.deepEqual(found.resultados.map(({ ruta, propiedades }) => [ruta, propiedades]), [[target.ruta, properties]]);
  assert.equal((await client.call('buscar', { ...search, propiedades: { importe: '120.5' } })).total, 0);

  const groupArgs = { etiqueta: 'pendiente', agrupar_por: 'archivo', estado: 'todos' };
  const grouped = await read('agrupar', { ...groupArgs, alias: { seguimiento: 'pendiente' } });
  assert.equal(grouped.total, 2, JSON.stringify(grouped));
  assert.equal(grouped.grupos[0].abiertos, 1);
  assert.equal(grouped.grupos[0].cerrados, 1);
  assert.ok(grouped.grupos[0].elementos.every(item => item.ruta === target.ruta));
  const cached = await client.call('agrupar', groupArgs);
  assert.deepEqual(cached.grupos, grouped.grupos);
  assert.equal(cached.cobertura.archivos_escaneados_ahora, 0);
  const labeled = await read('agrupar', { etiqueta: 'urgente', propiedades: { importe: 120.5 } });
  assert.equal(labeled.grupos[0].elementos[0].tipo_bloque, 'propiedad');

  assert.deepEqual((await read('propiedades', { carpeta: findOnly, ruta: 'sin-lectura.md' })).propiedades, {});
  await change('asignar_propiedades', { carpeta: findOnly, ruta: 'sin-lectura.md', asignar: properties }, 'ACCESS_NOT_GRANTED');
  await read('agrupar', { carpetas: [findOnly] }, 'ACCESS_NOT_GRANTED');
  await read('propiedades', { carpeta: folder, ruta: 'Privado/excluida.md' }, 'PATH_EXCLUDED');

  const indexArgs = {
    nombre: 'Agenda por etapa', carpeta: folder, dentro_de: 'Plan/', extensiones: ['.md'],
    propiedades: { etapa: 'revision' }, campos: ['ruta', 'propiedad:cliente'], ruta_csv: 'agenda.csv',
  };
  await change('crear_indice', { ...indexArgs, carpeta_csv: findOnly }, 'ACCESS_NOT_GRANTED');
  const excluded = await change('crear_indice', { ...indexArgs, ruta_csv: 'Privado/excluido.csv' });
  assert.equal(excluded.estado, 'error');
  assert.equal(await fs.stat(path.join(privateDir, 'excluido.csv')).catch(() => null), null);
  await client.call('retirar_indice', { id: excluded.id });

  await fs.writeFile(path.join(notes, 'existente.csv'), 'original\n');
  const occupied = await client.call('crear_indice', { ...indexArgs, ruta_csv: 'existente.csv' });
  assert.equal(occupied.error.codigo, 'CUSTOM_INDEX_DESTINATION_EXISTS');
  assert.equal(await fs.readFile(path.join(notes, 'existente.csv'), 'utf8'), 'original\n');
  await change('retirar_indice', { id: occupied.id });

  const created = await change('crear_indice', indexArgs);
  assert.equal(created.filas, 1, JSON.stringify(created));
  const csv = path.join(notes, 'agenda.csv');
  assert.equal(await fs.readFile(csv, 'utf8'), "\ufeffruta,propiedad:cliente\r\nPlan/agenda.md,'=1+1\r\n");
  assert.equal((await client.call('indices_personalizados')).indices[0].id, created.id);
  await change('actualizar_indice', { id: created.id });
  const modified = await client.call('modificar_indice', { id: created.id, campos: ['ruta', 'propiedad:importe'] });
  assert.equal(modified.filas, 1);
  assert.equal(await fs.readFile(csv, 'utf8'), '\ufeffruta,propiedad:importe\r\nPlan/agenda.md,120.5\r\n');
  await fs.writeFile(csv, 'edición externa\n');
  await client.call('actualizar_indice', { id: created.id }, 'CUSTOM_INDEX_MODIFIED_OUTSIDE');
  assert.equal(await fs.readFile(csv, 'utf8'), 'edición externa\n');
  await change('retirar_indice', { id: created.id });
  assert.equal((await read('indices_personalizados')).total, 0);
  assert.equal(await fs.readFile(csv, 'utf8'), 'edición externa\n');

  const automatic = await client.call('crear_indice', {
    nombre: 'Agenda automática', carpeta: folder, extensiones: ['md'],
    campos: ['ruta'], ruta_csv: 'automatico.csv', actualizar: 'al_cambiar',
  });
  assert.equal(automatic.filas, 1, JSON.stringify(automatic));
  const autoPath = path.join(notes, 'automatico.csv');
  await fs.writeFile(path.join(notes, 'Plan', 'extra.md'), '# Sin marcas\n');
  const generated = await waitForFile(autoPath, content => content.includes('Plan/extra.md'));
  assert.equal(generated, '\ufeffruta\r\nPlan/agenda.md\r\nPlan/extra.md\r\n');
  const listed = await read('indices_personalizados');
  const definition = JSON.parse(await fs.readFile(path.join(base, `custom-index-${automatic.id}.json`), 'utf8'));
  assert.equal(definition.format, 'mind-custom-index');
  assert.equal(definition.lastRun.version, 'sha256:' + createHash('sha256').update(generated).digest('hex'));
  await client.close();
  await stopNative(connector);
  await closed;
  assert.equal(motor.exitCode, 0, diagnostics);

  const { startCentralMotor } = await import(JSON.parse(source('motor-central.js')));
  rollback = await startCentralMotor({ layout, motorVersion: '1.0.4', observe: false, discoverUpdates: null, preferredPort: 0 });
  assert.equal(rollback.alreadyRunning, false);
  const r3 = await connect(rollback);
  try {
    assert.deepEqual(await r3.call('propiedades', target), saved);
    assert.deepEqual(await r3.call('indices_personalizados'), listed);
    const r3Group = await r3.call('agrupar', groupArgs);
    assert.equal(r3Group.total, grouped.total);
    const marks = result => result.grupos.flatMap(group => group.elementos.map(({ ruta, linea, estado, etiqueta, tipo_bloque }) =>
      ({ ruta, linea, estado, etiqueta, tipo_bloque })));
    assert.deepEqual(marks(r3Group), marks(grouped));
    assert.equal(await fs.readFile(autoPath, 'utf8'), generated);
  } finally {
    await r3.close();
  }
  t.diagnostic('El tag auténtico ' + r3Commit.slice(0, 7) + ' leyó la misma Base, las propiedades, el índice y el alias.');
});
