#!/usr/bin/env node
// Prueba del iniciador completo con un canal firmado local y un paquete real.
// No modifica el canal público. Todos los datos de usuario son ficticios.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { startMcp } from '../test/helpers/mcp-client.js';

const [mindArgument, archiveArgument, feedArgument, reportArgument] = process.argv.slice(2);
if (!mindArgument || !archiveArgument || !feedArgument || !reportArgument) throw new Error('Uso: <Mind extraído> <paquete nuevo> <canal firmado local> <informe.json>');
const mind = await fs.realpath(mindArgument);
const archive = await fs.realpath(archiveArgument);
const feed = await fs.realpath(feedArgument);
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'mind-auto-producto-'));
let client;
const timeout = setTimeout(() => { client?.child.kill(); process.stderr.write('Prueba automática excedida.\n' + (client?.stderr() ?? '')); process.exit(1); }, 120000);
try {
  const before = JSON.parse(await fs.readFile(path.join(mind, 'mind-producto.json'), 'utf8'));
  const { resolveLayout } = await import(pathToFileURL(path.join(mind, 'Motor', 'src', 'layout.js')));
  const { openSession } = await import(pathToFileURL(path.join(mind, 'Motor', 'src', 'session.js')));
  const session = await openSession({ layout: await resolveLayout(), motorVersion: before.mindVersion, observe: false });
  const record = await session.motor.recordContinuity({ content: 'Decisión ficticia anterior a actualizar' });
  await session.close();
  const marker = JSON.parse(await fs.readFile(path.join(mind, 'Base', 'mind-base.json'), 'utf8'));
  const project = path.join(temporary, 'Proyecto ficticio ñ');
  await fs.mkdir(project);
  await fs.writeFile(path.join(project, 'nota.txt'), 'Texto ficticio');
  const mock = path.join(temporary, 'canal-local.mjs');
  await fs.writeFile(mock, `import fs from 'node:fs/promises';\nglobalThis.fetch = async url => new Response(await fs.readFile(String(url).endsWith('stable.json') ? ${JSON.stringify(feed)} : ${JSON.stringify(archive)}));\n`);
  const node = path.join(mind, 'Runtime', 'node', 'node.exe');
  client = startMcp({ command: node, commandArgs: ['--import', mock, path.join(mind, 'Motor', 'bin', 'mind.js'), 'mcp'], cwd: project,
    capabilities: {}, env: { NODE_OPTIONS: '', MIND_UPDATE_RESTART: '' } });
  client.child.stderr.on('data', chunk => process.stderr.write(chunk));
  const initialized = await client.initialize();
  assert.equal(initialized.result.serverInfo.name, 'mind');
  const after = JSON.parse(await fs.readFile(path.join(mind, 'mind-producto.json'), 'utf8'));
  assert.notEqual(after.mindVersion, before.mindVersion);
  const state = await client.call('estado');
  assert.equal(state.isError, false);
  assert.equal(state.data.carpetas.length, 1);
  assert.equal((await client.call('leer', { ruta: 'nota.txt' })).isError, false);
  assert.equal((await client.call('crear', { ruta: 'creado.txt', contenido: 'Creado después de actualizar' })).isError, false);
  const continuity = await client.call('continuidad_consultar', { texto: 'Decisión ficticia anterior' });
  assert.ok(JSON.stringify(continuity.data).includes(record.id));
  assert.equal(JSON.parse(await fs.readFile(path.join(mind, 'Base', 'mind-base.json'), 'utf8')).baseId, marker.baseId);
  assert.equal(client.elicitations.length, 0);
  assert.equal((await client.close()).code, 0);
  const report = { resultado: 'superado', desde: before.mindVersion, hasta: after.mindVersion,
    iniciador: 'real, con runtime incluido y reinicio tras actualizar', canal: 'firmado local, sin publicación',
    base_conservada: true, lectura_y_creacion: true, formularios: 0 };
  await fs.writeFile(reportArgument, JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify(report) + '\n');
} finally {
  clearTimeout(timeout);
  if (client?.child.exitCode === null) { client.child.kill(); await client.exited; }
  await fs.rm(temporary, { recursive: true, force: true });
}
