import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashFile, scanTree } from '../src/product-files.js';
import { BASE_FORMAT_VERSION } from '../src/base-format.js';
import { updateMind } from '../src/commands/actualizar.js';
import { checkHealthyConnector, stopCentralMotor } from '../src/connector.js';
import { startMcp } from './helpers/mcp-client.js';

// Escenario: un chat deja abierto su puente stdio (proceso `arranque.cjs mcp` con el
// Node incluido), el Motor Central se apaga por inactividad y se aplica una
// actualización. Después el mismo puente vuelve a llamar a una herramienta.

const repo = fileURLToPath(new URL('..', import.meta.url));
const target = `${process.platform}-${process.arch}`;
const windows = process.platform === 'win32';
const nodeRel = ['Sistema', 'Componentes', 'Node', target, ...(windows ? ['node.exe'] : ['bin', 'node'])];
const pythonRel = ['Sistema', 'Componentes', 'Python', target, ...(windows ? ['python.exe'] : ['bin', 'python3'])];
const systemPython = process.env.MIND_TEST_PYTHON ?? process.env.MIND_PYTHON ?? (windows ? 'python' : 'python3');

async function resolvePython() {
  if (path.isAbsolute(systemPython)) return systemPython;
  const { execFileSync } = await import('node:child_process');
  return execFileSync(systemPython, ['-c', 'import sys;print(sys.executable)'], { encoding: 'utf8', windowsHide: true }).trim();
}

function childEnv(python) {
  const env = { ...process.env, NODE_OPTIONS: '', MIND_AGENT_STARTUP: '0', MIND_PYTHON: python };
  for (const key of ['MIND_BASE', 'MIND_UPDATE_RESTART', 'MIND_TEST_PYTHON']) delete env[key];
  return env;
}

async function seal(root, { mindVersion, revision }) {
  const files = {};
  for (const entry of await scanTree(root)) if (entry.type === 'file') files[entry.path] = await hashFile(path.join(root, entry.path));
  delete files['Sistema/mind-producto.json'];
  await fs.writeFile(path.join(root, 'Sistema', 'mind-producto.json'), JSON.stringify({
    format: 'mind-product', version: 1, mindVersion,
    packageRevision: revision, layoutVersion: 2, updateProtocolVersion: 2,
    platform: process.platform, arch: process.arch, baseFormatVersion: BASE_FORMAT_VERSION,
    files, links: {},
  }));
}

/** Instalación de producto real (Motor del repositorio, Node real, Python ficticio) sin canal de actualización. */
async function buildProduct(root, { mindVersion, revision, nodeSuffix = null }) {
  const system = path.join(root, 'Sistema');
  const motor = path.join(system, 'Programa', 'Motor');
  for (const name of ['src', 'bin']) await fs.cp(path.join(repo, name), path.join(motor, name), { recursive: true });
  const pkg = JSON.parse(await fs.readFile(path.join(repo, 'package.json'), 'utf8'));
  await fs.writeFile(path.join(motor, 'package.json'), JSON.stringify({ ...pkg, version: mindVersion }, null, 2));
  // Sin clave pública: el Motor no consulta la red al arrancar.
  await fs.writeFile(path.join(motor, 'src', 'update-channel.json'), JSON.stringify({ repository: 'ficticio/ficticio', url: 'https://github.com/ficticio/ficticio/releases/latest/download/stable.json' }));
  await fs.copyFile(path.join(repo, 'packaging', 'iniciadores', 'arranque.cjs'), path.join(system, 'arranque.cjs'));
  const node = path.join(root, ...nodeRel);
  await fs.mkdir(path.dirname(node), { recursive: true });
  await fs.copyFile(process.execPath, node);
  // Bytes añadidos al final: el ejecutable sigue funcionando y su huella cambia.
  if (nodeSuffix) await fs.appendFile(node, nodeSuffix);
  await fs.chmod(node, 0o755);
  const python = path.join(root, ...pythonRel);
  await fs.mkdir(path.dirname(python), { recursive: true });
  await fs.writeFile(python, 'python-ficticio; el Motor usa MIND_PYTHON\n');
  await seal(root, { mindVersion, revision });
}

async function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}

async function describeLeftovers(root) {
  const updates = path.join(root, 'Sistema', 'Actualizaciones');
  const journal = await fs.readFile(path.join(updates, 'transaccion.json'), 'utf8').then(JSON.parse, () => null);
  const work = await fs.readdir(path.join(updates, 'Trabajo')).catch(() => []);
  if (work.length) console.error('RESTOS', (await scanTree(path.join(updates, 'Trabajo'))).filter(e => e.type === 'file').map(e => e.path).slice(0, 20));
  if (journal?.cleanupError) console.error('LIMPIEZA PENDIENTE', journal.cleanupError, journal.cleanupDetail ?? '');
  return { journalPhase: journal?.phase ?? null, journalOps: journal?.operations?.length ?? 0, cleanupError: journal?.cleanupError ?? null, work };
}

async function runScenario(t, { name, changeNode }) {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mind-upd-bridge-')));
  const root = path.join(temporary, 'My Mind');
  const incoming = path.join(temporary, 'Entrega');
  const project = path.join(temporary, 'Proyecto');
  const base = path.join(root, 'Sistema', 'Base');
  const python = await resolvePython();
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(path.join(project, 'nota.txt'), 'Nota ficticia para el escenario de actualización.\n');
  await buildProduct(root, { mindVersion: '1.0.3', revision: 1 });
  await buildProduct(incoming, { mindVersion: '1.0.4', revision: 1, nodeSuffix: changeNode ? '\n// cambio de Node\n' : null });

  const bridge = startMcp({
    command: path.join(root, ...nodeRel),
    commandArgs: [path.join(root, 'Sistema', 'arranque.cjs'), 'mcp'],
    cwd: project,
    baseEnv: childEnv(python),
  });
  const pids = new Set([bridge.child.pid]);
  t.after(async () => {
    await bridge.close().catch(() => {});
    if (await processAlive(bridge.child.pid)) bridge.child.kill();
    await stopCentralMotor(base).catch(() => {});
    for (const pid of pids) if (await processAlive(pid)) { try { process.kill(pid); } catch {} }
    await fs.rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  const init = await bridge.initialize();
  assert.ok(init.result, `initialize: ${JSON.stringify(init)} ${bridge.stderr()}`);
  const first = await bridge.call('estado');
  assert.equal(first.isError, false, first.text);
  const before = await checkHealthyConnector(base);
  assert.ok(before, 'El puente despertó al Motor Central.');
  pids.add(before.health.pid);
  t.diagnostic(`[${name}] antes: Motor ${before.health.motorVersion} pid ${before.health.pid}; puente pid ${bridge.child.pid}`);

  // Autoapagado simulado: el Motor se va, el puente sigue vivo.
  assert.equal(await stopCentralMotor(base), true);
  assert.equal(await processAlive(bridge.child.pid), true);

  let outcome;
  try {
    outcome = await updateMind({ root, source: incoming, baseDirectory: base, confirm: () => true, pythonExecutable: python });
  } catch (error) {
    outcome = { status: 'error', code: error.code, message: error.message, cause: error.cause?.code ?? null };
  }
  const leftovers = await describeLeftovers(root);
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'Sistema', 'mind-producto.json'), 'utf8'));
  t.diagnostic(`[${name}] actualización: ${JSON.stringify({ status: outcome.status, code: outcome.code ?? null, message: outcome.message ?? null, cause: outcome.cause ?? null, cleanupPending: outcome.cleanupPending ?? null })}`);
  t.diagnostic(`[${name}] instalada: ${manifest.mindVersion}; restos: ${JSON.stringify(leftovers)}`);

  const second = await bridge.call('estado');
  const after = await checkHealthyConnector(base);
  if (after) pids.add(after.health.pid);
  t.diagnostic(`[${name}] llamada por el mismo puente: isError=${second.isError ?? null} rpcError=${JSON.stringify(second.rpcError ?? null)}; Motor después: ${after?.health.motorVersion ?? 'ninguno'}`);

  // El puente del chat abierto ejecuta el programa anterior: cede el trabajo a uno del
  // programa instalado, y por él siguen funcionando lecturas, escrituras y el cierre.
  // En una instalación de producto, `crear` escribe en el destino configurado (Conversaciones).
  const write = await bridge.call('crear', { ruta: 'tras-actualizar.txt', contenido: 'escrito por el chat abierto\n' });
  const read = await bridge.call('leer', { carpeta: project, ruta: 'nota.txt' });
  const ping = await bridge.request('ping');
  const closed = await bridge.close();
  const created = write.data?.ruta_absoluta ? await fs.readFile(write.data.ruta_absoluta, 'utf8').catch(() => null) : null;

  // Con el chat cerrado ya nadie usa el programa anterior: lo apartado se borra.
  await stopCentralMotor(base);
  const { purgeRetiredUpdates } = await import('../src/update-transaction.js');
  const purge = await purgeRetiredUpdates(root, { pythonExecutable: python });
  const retired = await fs.readdir(path.join(root, 'Sistema', 'Actualizaciones', 'Retirados')).catch(() => []);
  t.diagnostic(`[${name}] apartado durante la actualización: ${outcome.retiredPending === true}; tras cerrar el chat quedan ${retired.length}`);
  return { outcome, leftovers, manifest, second, after, bridge, write, read, ping, closed, created, purge, retired };
}

function assertBridgeKeptWorking(r) {
  assert.equal(r.second.isError, false, r.second.text);
  assert.equal(r.second.data.motor_central.version, '1.0.4', 'el chat abierto habla con el Motor actualizado');
  assert.match(r.bridge.stderr(), /cede el trabajo al programa instalado/, 'el puente antiguo no cedió el trabajo');
  assert.equal(r.write.isError, false, r.write.text);
  assert.equal(r.created, 'escrito por el chat abierto\n');
  assert.equal(r.read.isError, false, r.read.text);
  assert.deepEqual(r.ping.result, {});
  assert.equal(r.closed.code, 0, 'el puente y su relevo terminan limpiamente al cerrarse el chat');
  assert.deepEqual({ pending: r.purge.pending, retired: r.retired }, { pending: 0, retired: [] }, 'quedaron restos del programa anterior');
}

test('actualización con un puente abierto: solo cambia el programa', { timeout: 180_000 }, async (t) => {
  const r = await runScenario(t, { name: 'programa', changeNode: false });
  assert.equal(r.outcome.status, 'actualizada', JSON.stringify(r.outcome));
  assert.equal(r.outcome.cleanupPending, false);
  assert.deepEqual(r.leftovers, { journalPhase: null, journalOps: 0, cleanupError: null, work: [] });
  assert.equal(r.manifest.mindVersion, '1.0.4');
  assert.equal(r.after?.health.motorVersion, '1.0.4');
  assertBridgeKeptWorking(r);
});

test('actualización con un puente abierto: también cambia el Node incluido', { timeout: 180_000 }, async (t) => {
  const r = await runScenario(t, { name: 'node', changeNode: true });
  assert.equal(r.outcome.status, 'actualizada', JSON.stringify(r.outcome));
  assert.deepEqual(r.leftovers, { journalPhase: null, journalOps: 0, cleanupError: null, work: [] });
  assert.equal(r.manifest.mindVersion, '1.0.4');
  assert.equal(r.after?.health.motorVersion, '1.0.4');
  assertBridgeKeptWorking(r);
});
