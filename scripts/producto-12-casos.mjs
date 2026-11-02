#!/usr/bin/env node
// Pruebas del producto (Hito A) contra una carpeta de Mind EXTRAÍDA de un
// paquete, no contra el repositorio. El servidor se lanza exactamente como lo
// declara el .mcp.json del paquete, con la carpeta de Mind como directorio de
// trabajo y un PATH vacío: si algo dependiera de un Node o un Python instalados
// en el equipo, fallaría.
//
//   <Mind>/Runtime/node/bin/node scripts/producto-12-casos.mjs --mind <carpeta-de-Mind>
//       [--claude <orden>] [--informe <archivo.json>]
//
// --claude comprueba además, con Claude Code real, que descubre y conecta el
// servidor MCP del proyecto (`claude mcp get mind`). La aprobación del servidor,
// que en uso real da la persona una vez, se registra en una configuración de
// Claude Code temporal y aislada (enabledMcpjsonServers): el paquete no la
// preaprueba.
//
// Los demás casos usan un cliente MCP de prueba que simula al agente y, en el
// formulario de autorización, la respuesta del usuario. Se informan como
// simulación. Solo usa datos ficticios, en temporales fuera de la carpeta de
// Mind que se eliminan al terminar. Lo que no puede comprobarse se informa como
// "pendiente", nunca como superado.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startMcp } from '../test/helpers/mcp-client.js';
import { readManifestFile, verifyTree, describeProblems } from '../src/product-files.js';

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const mindArgument = option('--mind');
if (!mindArgument) {
  process.stderr.write('Uso: node scripts/producto-12-casos.mjs --mind <carpeta-de-Mind> [--claude <orden>] [--informe <archivo.json>]\n');
  process.exit(2);
}
const mind = await fs.realpath(path.resolve(mindArgument));
const reportFile = option('--informe');
const claudeCommand = option('--claude');
const windows = process.platform === 'win32';
const results = [];
const clients = [];

/** Herramientas del primer producto. Las del Hito B no deben ofrecerse todavía. */
const HITO_A_TOOLS = ['estado', 'solicitar_acceso', 'retirar_acceso', 'buscar', 'explorar', 'eliminados', 'leer', 'crear',
  'modificar', 'editar', 'continuidad_registrar', 'continuidad_consultar', 'continuidad_actualizar',
  'continuidad_exportar', 'continuidad_importar'];

function check(condition, message) {
  if (!condition) throw new Error(message);
}

async function step(number, name, kind, task) {
  const started = Date.now();
  try {
    const detail = await task();
    if (detail?.pending) {
      results.push({ caso: number, nombre: name, tipo: kind, resultado: 'pendiente', motivo: detail.pending, ms: Date.now() - started });
      process.stdout.write(`⏳ ${number}. ${name}: pendiente — ${detail.pending}\n`);
      return;
    }
    results.push({ caso: number, nombre: name, tipo: kind, resultado: 'superado', ms: Date.now() - started, ...(detail ? { detalle: detail } : {}) });
    process.stdout.write(`✔ ${number}. ${name} (${Date.now() - started} ms)\n`);
  } catch (error) {
    results.push({ caso: number, nombre: name, tipo: kind, resultado: 'fallido', error: String(error?.stack ?? error), ms: Date.now() - started });
    process.stdout.write(`✖ ${number}. ${name}: ${error?.message ?? error}\n`);
  }
}

async function eventually(probe, { timeoutMs = 30_000, intervalMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value || Date.now() > deadline) return value;
    await delay(intervalMs);
  }
}

function run(command, commandArgs, { env, cwd, timeoutMs = 120_000, shell = false, verbatim = false } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    // Con shell, la orden se pasa ya compuesta (los argumentos de estas pruebas no llevan espacios).
    const child = shell
      ? spawn([command, ...commandArgs].join(' '), { cwd, env, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn(command, commandArgs, { cwd, env, windowsHide: true, windowsVerbatimArguments: verbatim, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => { clearTimeout(timer); resolve({ code: null, stdout, stderr: `${stderr}${error.message}` }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

// Entorno sin runtimes externos: PATH apunta a una carpeta vacía y se retiran
// las variables que podrían redirigir a otro Node, Python o Base.
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'mind-producto-'));
const emptyBin = path.join(temporary, 'sin-programas');
await fs.mkdir(emptyBin);
function isolatedEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^(path|node_options|node_path|pythonpath|pythonhome|pythonstartup|mind_base|mind_python)$/iu.test(key)) env[key] = value;
  }
  env[windows ? 'Path' : 'PATH'] = emptyBin;
  return env;
}

/** Lanza el servidor tal como lo haría el agente a partir del .mcp.json del paquete. */
async function launch({ clientInfo, onElicit = null } = {}) {
  const config = JSON.parse(await fs.readFile(path.join(mind, '.mcp.json'), 'utf8')).mcpServers.mind;
  check(config && typeof config.command === 'string', 'El .mcp.json del paquete no declara el servidor "mind".');
  const command = path.isAbsolute(config.command) ? config.command : path.join(mind, config.command);
  const client = startMcp({
    command, commandArgs: config.args ?? [], cwd: mind, baseEnv: isolatedEnv(), env: config.env ?? {},
    clientInfo: clientInfo ?? { name: 'agente-de-prueba-A', version: '1.0' },
    onElicit,
  });
  clients.push(client);
  return client;
}

/** Procesos vivos cuya línea de órdenes menciona la carpeta de Mind. */
async function residentProcesses() {
  const listing = windows
    ? await run('powershell.exe', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }'])
    : await run('ps', ['-A', '-o', 'pid=,command=']);
  if (listing.code !== 0) return null;
  const needle = windows ? mind.toLowerCase() : mind;
  return listing.stdout.split(/\r?\n/u)
    .filter((line) => (windows ? line.toLowerCase() : line).includes(needle))
    .filter((line) => !line.includes('producto-12-casos'));
}

// Simula la respuesta del usuario en el formulario del cliente.
const acceptAll = (params) => (params.requestedSchema.properties.acceso
  ? { action: 'accept', content: { acceso: 'completo' } }
  : params.requestedSchema.properties.confirmar
    ? { action: 'accept', content: { confirmar: true } }
    : { action: 'accept', content: { leer: true, registrar: true } });

const names = (result) => (result.data?.resultados ?? []).map((item) => item.ruta).sort();
const SIMULATED = 'cliente MCP de prueba (simulación del agente y del usuario)';
const PACKAGE = 'carpeta extraída';

const information = path.join(temporary, 'Información ficticia');
const base = path.join(mind, 'Base');
let manifest = null;
let session = null;
let baseId = null;

try {
  await fs.mkdir(path.join(information, 'Proyectos'), { recursive: true });
  await fs.writeFile(path.join(information, 'Proyectos', 'presupuesto-2026.md'), '# Presupuesto ficticio\nTotal aprobado: 4.250 EUR\n');
  await fs.writeFile(path.join(information, 'Proyectos', 'acta.txt'), 'Acta ficticia\nPendiente: revisar\n');
  await fs.writeFile(path.join(information, 'antiguo.txt'), 'Se eliminará con Mind cerrado\n');

  await step(1, 'La carpeta se extrae correctamente', PACKAGE, async () => {
    manifest = await readManifestFile(mind);
    check(manifest, 'Falta mind-producto.json.');
    check(manifest.platform === process.platform && manifest.arch === process.arch,
      `Paquete para ${manifest.platform}-${manifest.arch}, equipo ${process.platform}-${process.arch}.`);
    await fs.access(base).then(() => { throw new Error('El paquete no debe contener una Base.'); }, () => {});
    const verified = await verifyTree(mind, manifest);
    check(verified.ok, `La carpeta no coincide con su manifiesto: ${describeProblems(verified.problems)}`);
    const config = await fs.readFile(path.join(mind, '.mcp.json'), 'utf8');
    const server = JSON.parse(config).mcpServers.mind;
    check(!path.isAbsolute(server.command) && !server.args.some((value) => path.isAbsolute(value)), 'El .mcp.json no debe usar rutas absolutas.');
    return { version: manifest.mindVersion, archivos: verified.files, enlaces: verified.links, commit: manifest.builtFrom };
  });

  await step(2, 'Los runtimes incluidos funcionan sin programas externos', PACKAGE, async () => {
    const node = path.join(mind, 'Runtime', 'node', windows ? 'node.exe' : path.join('bin', 'node'));
    const python = path.join(mind, 'Runtime', 'python', windows ? 'python.exe' : path.join('bin', 'python3'));
    const expected = Object.fromEntries(manifest.components.map((item) => [item.name, item.version]));
    const nodeVersion = await run(node, ['--version'], { env: isolatedEnv() });
    check(nodeVersion.code === 0 && nodeVersion.stdout.trim() === `v${expected.node}`, `Node: ${nodeVersion.stdout}${nodeVersion.stderr}`);
    const pythonVersion = await run(python, ['-I', '-B', '-c', 'import sys, ssl, sqlite3, zipfile, ctypes; print(sys.version.split()[0])'], { env: isolatedEnv() });
    check(pythonVersion.code === 0 && pythonVersion.stdout.trim() === expected.python, `Python: ${pythonVersion.stdout}${pythonVersion.stderr}`);
    return { node: nodeVersion.stdout.trim(), python: pythonVersion.stdout.trim() };
  });

  await step(3, 'El iniciador ejecuta Mind', PACKAGE, async () => {
    const result = windows
      // Como lo escribe una persona en cmd: "<Mind>\mind.cmd" version (argumentos literales).
      ? await run(process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe', ['/d', '/s', '/c', `""${path.join(mind, 'mind.cmd')}" version"`], { env: isolatedEnv(), verbatim: true })
      : await run(path.join(mind, 'mind'), ['version'], { env: isolatedEnv() });
    check(result.code === 0, `Código ${result.code}: ${result.stderr}`);
    const reported = JSON.parse(result.stdout);
    check(reported.mind === manifest.mindVersion, `Versión informada: ${result.stdout}`);
    await fs.access(base).then(() => { throw new Error('Consultar la versión no debe crear la Base.'); }, () => {});
    return reported;
  });

  await step(4, 'Claude Code descubre y conecta el servidor MCP del proyecto', 'Claude Code real (sin modelo)', async () => {
    if (!claudeCommand) return { pending: 'no se indicó --claude; esta ejecución no dispone de Claude Code' };
    const config = path.join(temporary, 'config-claude');
    await fs.mkdir(config);
    // Representa la aprobación única que en uso real da la persona.
    await fs.writeFile(path.join(config, 'settings.json'), JSON.stringify({ enabledMcpjsonServers: ['mind'] }));
    const env = { ...process.env, CLAUDE_CONFIG_DIR: config };
    const version = await run(claudeCommand, ['--version'], { env, cwd: mind, shell: windows });
    const result = await run(claudeCommand, ['mcp', 'get', 'mind'], { env, cwd: mind, shell: windows });
    const output = `${result.stdout}\n${result.stderr}`;
    check(result.code === 0 && /connected/iu.test(output) && !/failed|error/iu.test(output), `claude mcp get mind:\n${output}`);
    return { claude: version.stdout.trim(), salida: result.stdout.trim().split('\n').slice(0, 8) };
  });

  await step(5, 'El Motor inicializa la Base en el primer uso', SIMULATED, async () => {
    session = await launch({ onElicit: acceptAll });
    const init = await session.initialize();
    check(init.result?.serverInfo?.name === 'mind', `El servidor no respondió: ${session.stderr().slice(-500)}`);
    check(/solicitar_acceso/.test(init.result.instructions ?? ''), 'Faltan las instrucciones para el agente.');
    const tools = (await session.request('tools/list')).result.tools.map((tool) => tool.name).sort();
    check(JSON.stringify(tools) === JSON.stringify([...HITO_A_TOOLS].sort()), `Herramientas ofrecidas: ${tools.join(', ')}`);
    const marker = JSON.parse(await fs.readFile(path.join(base, 'mind-base.json'), 'utf8'));
    check(marker.format === 'mind-base', 'La Base no tiene su marca de formato.');
    baseId = marker.baseId;
    const status = (await session.call('estado')).data;
    check(status.mind.producto === true, 'Mind no se reconoce en modo producto.');
    for (const runtime of [status.mind.runtime.node, status.mind.runtime.python]) {
      check(path.resolve(runtime).startsWith(mind + path.sep), `Runtime fuera del paquete: ${runtime}`);
    }
    check(path.resolve(status.mind.base) === base, `Base inesperada: ${status.mind.base}`);
    return { protocolo: init.result.protocolVersion, herramientas: tools.length, runtime: status.mind.runtime };
  });

  await step(6, 'Se autoriza una carpeta ficticia (decisión del usuario)', SIMULATED, async () => {
    const inside = await session.call('solicitar_acceso', { ruta: path.join(mind, 'Motor'), acceso: 'leer' });
    check(inside.data?.error?.codigo === 'FOLDER_OVERLAPS_INTERNAL', 'Una carpeta dentro de Mind no debía poder autorizarse.');
    const before = session.elicitations.length;
    const granted = await session.call('solicitar_acceso', { ruta: information, acceso: 'completo', motivo: 'Prueba de producto' });
    check(granted.data.estado === 'autorizado', `Autorización: ${JSON.stringify(granted.data)}`);
    check(session.elicitations.length === before + 1, 'El usuario debía ver exactamente un formulario.');
    return { permisos: granted.data.carpeta.permisos };
  });

  await step(7, 'Se genera su índice', SIMULATED, async () => {
    const status = await eventually(async () => {
      const value = (await session.call('estado')).data;
      return value.carpetas[0]?.indice?.estado === 'vigente' ? value : null;
    });
    check(status, 'El índice inicial no quedó vigente.');
    check(status.carpetas[0].indice.archivos === 3, `Archivos indexados: ${status.carpetas[0].indice.archivos}`);
    return status.carpetas[0].indice;
  });

  await step(8, 'El agente puede buscar y leer', SIMULATED, async () => {
    const found = await session.call('buscar', { consulta: 'presupuesto' });
    check(found.data.total === 1, `Resultados: ${found.data.total}`);
    const read = await session.call('leer', { ruta: 'Proyectos/presupuesto-2026.md' });
    check(/4\.250 EUR/.test(read.data.contenido), 'El contenido leído no es el esperado.');
    check(/^sha256:[0-9a-f]{64}$/.test(read.data.version), 'Falta la versión.');
    const explored = await session.call('explorar', { ruta: 'Proyectos' });
    check(!explored.isError && JSON.stringify(explored.data).includes('acta.txt'), `explorar: ${JSON.stringify(explored.data)}`);
    return { ruta_absoluta: found.data.resultados[0].ruta_absoluta };
  });

  await step(9, 'Puede crear y modificar archivos de prueba', SIMULATED, async () => {
    const created = await session.call('crear', { ruta: 'Proyectos/resumen.md', contenido: 'Total aprobado: 4.250 EUR\n' });
    check(created.data.estado === 'creado', JSON.stringify(created.data));
    check((await session.call('crear', { ruta: 'Proyectos/resumen.md', contenido: 'x' })).data.error?.codigo === 'FILE_EXISTS', 'Crear no debe sobrescribir.');
    const read = await session.call('leer', { ruta: 'Proyectos/acta.txt' });
    const edited = await session.call('editar', { ruta: 'Proyectos/acta.txt', version: read.data.version, ediciones: [{ buscar: 'Pendiente', reemplazar: 'Hecho' }] });
    check(edited.data.estado === 'modificado', JSON.stringify(edited.data));
    const stale = await session.call('modificar', { ruta: 'Proyectos/acta.txt', version: read.data.version, contenido: 'tarde' });
    check(stale.data.error?.codigo === 'VERSION_CONFLICT', 'Una versión antigua no debe escribir.');
    const current = await session.call('leer', { ruta: 'Proyectos/acta.txt' });
    const replaced = await session.call('modificar', { ruta: 'Proyectos/acta.txt', version: current.data.version, contenido: 'Acta ficticia\nHecho: revisado\n' });
    check(replaced.data.estado === 'modificado', JSON.stringify(replaced.data));
    check(await fs.readFile(path.join(information, 'Proyectos', 'acta.txt'), 'utf8') === 'Acta ficticia\nHecho: revisado\n', 'Contenido final inesperado.');
  });

  await step(10, 'Puede registrar continuidad', SIMULATED, async () => {
    const registered = await session.call('solicitar_acceso', { continuidad: ['leer', 'registrar'] });
    check(registered.data.estado === 'autorizado', JSON.stringify(registered.data));
    const decision = await session.call('continuidad_registrar', {
      tipo: 'decisión', contenido: 'El total aprobado del presupuesto 2026 es 4.250 EUR',
      referencias: [{ ubicacion: 'Proyectos/presupuesto-2026.md', relacion: 'fuente' }],
    });
    check(decision.data.estado === 'registrado', JSON.stringify(decision.data));
    const exported = await session.call('continuidad_exportar', {});
    check(exported.data.registros === 1 && typeof exported.data.paquete === 'string', JSON.stringify(exported.data).slice(0, 300));
    const imported = await session.call('continuidad_importar', { paquete: exported.data.paquete });
    check(imported.data.estado === 'importado' && imported.data.sin_cambios.length === 1, JSON.stringify(imported.data));
    return { id: decision.data.registro?.id ?? null };
  });

  await step(11, 'Cierra sin dejar procesos residentes', SIMULATED, async () => {
    const pid = session.child.pid;
    const exit = await session.close();
    check(exit.code === 0, `Código de salida ${exit.code}: ${session.stderr().slice(-500)}`);
    const sessions = await fs.readdir(path.join(base, 'sesiones'));
    check(sessions.length === 0, 'Quedó un registro de sesión.');
    check(!(await fs.readdir(base)).some((entry) => entry.endsWith('.lock')), 'Quedó un bloqueo.');
    const residents = await eventually(async () => {
      const value = await residentProcesses();
      return value === null || value.length === 0 ? value ?? [] : null;
    }, { timeoutMs: 10_000 });
    check(residents, `Procesos de Mind todavía vivos: ${(await residentProcesses())?.join(' | ')}`);
    return { salida: exit.code, pid, residentes: residents.length };
  });

  await step(12, 'Reabre y recupera la continuidad y los cambios externos', SIMULATED, async () => {
    await fs.rm(path.join(information, 'antiguo.txt'));
    await fs.writeFile(path.join(information, 'nuevo-sin-mind.txt'), 'Escrito con Mind cerrado\n');
    await fs.appendFile(path.join(information, 'Proyectos', 'resumen.md'), 'Revisado sin Mind\n');

    session = await launch({ clientInfo: { name: 'agente-de-prueba-B', version: '2.0' } });
    await session.initialize();
    const marker = JSON.parse(await fs.readFile(path.join(base, 'mind-base.json'), 'utf8'));
    check(marker.baseId === baseId, 'Cambió la identidad de la Base.');
    const all = await eventually(async () => {
      const value = names(await session.call('buscar', { consulta: '' }));
      return value.includes('nuevo-sin-mind.txt') && !value.includes('antiguo.txt') ? value : null;
    });
    check(all, 'La reconciliación no recuperó los cambios hechos con Mind cerrado.');
    const removed = await session.call('eliminados');
    check(removed.data.eliminados.some((item) => item.ruta === 'antiguo.txt'), 'El rastro no incluye lo eliminado.');
    const read = await session.call('leer', { ruta: 'Proyectos/resumen.md' });
    check(/Revisado sin Mind/.test(read.data.contenido), 'La lectura no refleja el cambio externo.');
    const found = await session.call('continuidad_consultar', { texto: 'presupuesto 2026' });
    check(found.data.total === 1, `Registros: ${found.data.total}`);
    const entry = found.data.registros[0];
    check(/agente-de-prueba-A/.test(entry.origen), 'El origen registrado no es el del primer agente.');
    check(entry.referencias[0].estado === 'existe', 'La referencia al presupuesto debía existir.');
    const exit = await session.close();
    check(exit.code === 0, `Código de salida ${exit.code}`);
    return { archivos: all, origen: entry.origen };
  });
} finally {
  for (const client of clients) {
    client.child.stdin.end();
    if (client.child.exitCode === null) client.child.kill();
  }
  await fs.rm(temporary, { recursive: true, force: true });
}

const summary = {
  fecha: new Date().toISOString(),
  mind,
  version: manifest?.mindVersion ?? null,
  commit: manifest?.builtFrom ?? null,
  plataforma: `${process.platform}-${process.arch}`,
  node_que_ejecuta_la_prueba: process.execPath,
  manifiesto_sha256: manifest ? createHash('sha256').update(await fs.readFile(path.join(mind, 'mind-producto.json'))).digest('hex') : null,
  superados: results.filter((item) => item.resultado === 'superado').length,
  fallidos: results.filter((item) => item.resultado === 'fallido').length,
  pendientes: results.filter((item) => item.resultado === 'pendiente').length,
  casos: results,
  fuera_del_hito_A: ['organizar y papelera', 'propiedades', 'índices personalizados CSV', 'automatizaciones', 'respaldo cifrado', 'actualización del Motor (mind actualizar)'],
};
if (reportFile) await fs.writeFile(reportFile, `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`\nSuperados: ${summary.superados} · Fallidos: ${summary.fallidos} · Pendientes: ${summary.pendientes}\n`);
process.exitCode = summary.fallidos > 0 ? 1 : 0;
