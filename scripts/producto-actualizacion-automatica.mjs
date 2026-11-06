#!/usr/bin/env node
// Prueba el iniciador del producto y su reinicio con paquetes reales.
// Solo se simula el transporte HTTPS. La Base de prueba y la clave son ficticias.
import { generateKeyPairSync, sign } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { extractEntries, readArchive } from '../src/archive.js';
import { githubDownload, verifyFeed } from '../src/auto-update.js';
import { compareVersions, hashFile, MANIFEST_NAME, readManifestFile } from '../src/product-files.js';
import { startMcp } from '../test/helpers/mcp-client.js';

const [mindArgument, archiveArgument, thirdArgument, fourthArgument, ...extra] = process.argv.slice(2);
if (!mindArgument || !archiveArgument || !thirdArgument || extra.length) {
  throw new Error('Uso: <Mind extraído> <paquete nuevo> [canal firmado local] <informe.json>');
}
const feedArgument = fourthArgument ? thirdArgument : null;
const reportPath = path.resolve(fourthArgument ?? thirdArgument);
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'mind-auto-producto-'));
const report = { resultado: 'fallido', plataforma: `${process.platform}-${process.arch}`,
  iniciador: 'producto real, con runtime incluido y reinicio',
  canal: 'HTTPS simulado, sin publicación',
  firma: feedArgument ? 'Ed25519, canal suministrado' : 'Ed25519, clave efímera de prueba' };

async function readIncomingProduct(archive) {
  const metadata = path.join(temporary, 'metadatos');
  const files = [MANIFEST_NAME, 'Motor/package.json'];
  await extractEntries(readArchive(archive), metadata, {
    map(name, entry) {
      if (entry.type !== 'file') return null;
      const relative = name.split('/').slice(1).join('/');
      return files.find(file => file === name || file === relative) ?? null;
    },
  });
  const manifest = await readManifestFile(metadata);
  assert.ok(manifest, `El archivo no contiene ${MANIFEST_NAME}.`);
  const { version } = JSON.parse(await fs.readFile(path.join(metadata, 'Motor', 'package.json'), 'utf8'));
  // --version-paquete cambia el manifiesto de prueba sin editar la versión del Motor.
  return { manifest, motorVersion: version };
}

async function prepareFetch(mind, archive, incoming) {
  const channelFile = path.join(mind, 'Motor', 'src', 'update-channel.json');
  const channel = JSON.parse(await fs.readFile(channelFile, 'utf8'));
  const [sha256, { size: bytes }] = await Promise.all([hashFile(archive), fs.stat(archive)]);
  let feed;
  if (feedArgument) {
    feed = await fs.realpath(feedArgument);
  } else {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    channel.publicKey = publicKey.export({ type: 'spki', format: 'pem' });
    await fs.writeFile(channelFile, JSON.stringify(channel) + '\n');
    const url = `https://github.com/${channel.repository}/releases/download/v${incoming.mindVersion}/${encodeURIComponent(path.basename(archive))}`;
    const payload = Buffer.from(JSON.stringify({ format: 'mind-update', version: 1, mindVersion: incoming.mindVersion,
      packages: [{ platform: incoming.platform, arch: incoming.arch, url, bytes, sha256 }] }));
    feed = path.join(temporary, 'stable.json');
    await fs.writeFile(feed, JSON.stringify({ payload: payload.toString('base64'),
      signature: sign(null, payload, privateKey).toString('base64') }));
  }
  const verified = verifyFeed(JSON.parse(await fs.readFile(feed, 'utf8')), channel.publicKey);
  assert.equal(verified.mindVersion, incoming.mindVersion, 'El canal debe indicar la versión del paquete nuevo.');
  const matching = verified.packages.filter(entry => entry.platform === incoming.platform && entry.arch === incoming.arch);
  assert.equal(matching.length, 1, 'El canal debe contener un solo paquete para esta plataforma.');
  const [selected] = matching;
  assert.equal(selected.sha256, sha256, 'La huella firmada no corresponde al paquete.');
  assert.equal(selected.bytes, bytes, 'El tamaño firmado no corresponde al paquete.');
  const routes = [
    [githubDownload(channel.url, channel.repository), feed],
    [githubDownload(selected.url, channel.repository), archive],
  ];
  const preload = path.join(temporary, 'canal-local.mjs');
  await fs.writeFile(preload, [
    "import { createReadStream } from 'node:fs';",
    "import { Readable } from 'node:stream';",
    `const files = new Map(${JSON.stringify(routes)});`,
    "globalThis.fetch = async (url, { signal } = {}) => {",
    "  const file = files.get(String(url));",
    "  if (!file) throw new Error(`URL no prevista en el ensayo local: ${url}`);",
    "  const stream = Readable.toWeb(createReadStream(file, { signal }), {",
    "    strategy: { highWaterMark: 64 * 1024, size: chunk => chunk.byteLength },",
    "  });",
    "  return new Response(stream);",
    '};',
    '',
  ].join('\n'));
  return preload;
}

let client;
let timeout;
try {
  const [origin, archive] = await Promise.all([fs.realpath(mindArgument), fs.realpath(archiveArgument)]);
  const before = await readManifestFile(origin);
  assert.ok(before, 'La instalación de origen debe venir de un paquete extraído.');
  assert.equal(before.platform, process.platform);
  assert.equal(before.arch, process.arch);
  assert.ok(!(await fs.readdir(origin)).some(name => name.toLowerCase() === 'base'),
    'Usa un paquete recién extraído, sin Base del usuario.');
  const { manifest: incoming, motorVersion } = await readIncomingProduct(archive);
  report.desde = before.mindVersion;
  report.hasta = incoming.mindVersion;
  report.motor = motorVersion;
  assert.equal(incoming.platform, before.platform, 'El paquete nuevo debe ser de la misma plataforma.');
  assert.equal(incoming.arch, before.arch, 'El paquete nuevo debe ser de la misma arquitectura.');
  assert.ok(compareVersions(incoming.mindVersion, before.mindVersion) > 0, 'El paquete nuevo debe tener una versión superior.');

  const mind = path.join(temporary, 'Mind de prueba ñ');
  await fs.cp(origin, mind, { recursive: true, verbatimSymlinks: true });
  const preload = await prepareFetch(mind, archive, incoming);
  const { resolveLayout } = await import(pathToFileURL(path.join(mind, 'Motor', 'src', 'layout.js')));
  const { openSession } = await import(pathToFileURL(path.join(mind, 'Motor', 'src', 'session.js')));
  const layout = await resolveLayout({ env: {} });
  const session = await openSession({ layout, motorVersion: before.mindVersion, observe: false });
  const decision = 'Decisión ficticia anterior a actualizar';
  let record;
  try {
    record = await session.motor.recordContinuity({ content: decision });
  } finally {
    await session.close();
  }
  const markerFile = path.join(layout.baseDirectory, 'mind-base.json');
  const marker = JSON.parse(await fs.readFile(markerFile, 'utf8'));
  const project = path.join(temporary, 'Proyecto ficticio ñ');
  await fs.mkdir(project);
  await fs.writeFile(path.join(project, 'nota.txt'), 'Texto ficticio');

  const { mcpServers: { mind: config } } = JSON.parse(await fs.readFile(path.join(mind, '.mcp.json'), 'utf8'));
  const node = path.resolve(mind, config.command);
  const [launcher, ...args] = config.args;
  await fs.access(node, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
  const baseEnv = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !/^(path|node_options|mind_base|mind_python|mind_update_restart)$/iu.test(key)));
  baseEnv.PATH = temporary;
  client = startMcp({ command: node, commandArgs: ['--import', pathToFileURL(preload).href, path.resolve(mind, launcher), ...args],
    cwd: project, capabilities: {}, baseEnv, env: config.env });
  client.child.stderr.on('data', chunk => process.stderr.write(chunk));
  const checks = async () => {
    const initialized = await client.initialize();
    assert.equal(initialized.result?.serverInfo?.name, 'mind');
    assert.equal(initialized.result.serverInfo.version, motorVersion, 'MCP debe responder con el Motor del paquete nuevo.');
    const installed = await readManifestFile(mind);
    assert.deepEqual(installed, incoming, 'El manifiesto instalado debe coincidir con el del paquete nuevo.');
    const state = await client.call('estado');
    assert.equal(state.isError, false, state.text);
    assert.equal(state.data.mind.motor, motorVersion);
    assert.equal(await fs.realpath(state.data.mind.runtime.node), await fs.realpath(node));
    assert.equal(await fs.realpath(state.data.mind.runtime.python), await fs.realpath(layout.pythonExecutable));
    assert.equal(state.data.carpetas.length, 1);
    assert.equal(await fs.realpath(state.data.carpetas[0].ruta), await fs.realpath(project));
    const note = await client.call('leer', { ruta: 'nota.txt' });
    assert.equal(note.data?.contenido, 'Texto ficticio', note.text);
    const content = 'Creado después de actualizar';
    const created = await client.call('crear', { ruta: 'creado.txt', contenido: content });
    assert.equal(created.isError, false, created.text);
    assert.equal(await fs.readFile(path.join(project, 'creado.txt'), 'utf8'), content);
    const continuity = await client.call('continuidad_consultar', { ids: [record.id] });
    assert.equal(continuity.data?.registros?.[0]?.id, record.id, continuity.text);
    assert.equal(continuity.data.registros[0].contenido, decision);
    assert.ok(marker.baseId);
    assert.equal(JSON.parse(await fs.readFile(markerFile, 'utf8')).baseId, marker.baseId);
    assert.equal(client.elicitations.length, 0);
  };
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error('La actualización o las comprobaciones MCP excedieron el plazo.')), 180_000);
    client.child.once('error', reject);
  });
  const prematureExit = client.exited.then(({ code }) => {
    throw new Error(`El iniciador terminó antes de completar la prueba (${code}): ${client.stderr()}`);
  });
  await Promise.race([checks(), prematureExit, deadline]);
  assert.equal((await Promise.race([client.close(), deadline])).code, 0);
  Object.assign(report, { resultado: 'superado', base_conservada: true, lectura_y_creacion: true, formularios: 0 });
} catch (error) {
  report.error = error.message;
  throw error;
} finally {
  clearTimeout(timeout);
  if (client?.child.pid && client.child.exitCode === null && client.child.signalCode === null) {
    client.child.stdin.end();
    client.child.kill();
    await client.exited;
  }
  try {
    await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } finally {
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
    process.stdout.write(JSON.stringify(report) + '\n');
  }
}
