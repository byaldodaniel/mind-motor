#!/usr/bin/env node
// Integración independiente de Mind 1.0.1. Cliente MCP real por stdio, datos
// ficticios y artefactos conservados fuera del repositorio para archivarlos.
// node scripts/verificar-recursos.mjs --salida <directorio absoluto externo>
//   [--python <ejecutable>] [--clientes 4] [--ciclos 10] [--mind <paquete extraído>]
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { startMcp } from '../test/helpers/mcp-client.js';

const args = process.argv.slice(2);
const option = (name) => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; };
const repo = await fs.realpath(fileURLToPath(new URL('..', import.meta.url)));
const output = option('--salida');
if (!output || !path.isAbsolute(output)) throw new Error('--salida requiere un directorio absoluto externo al repositorio.');
const outputRoot = path.resolve(output);
const relative = path.relative(repo, outputRoot);
if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
  throw new Error('Los datos de prueba deben estar fuera del repositorio.');
}
const count = Number(option('--clientes') ?? 4);
const cycles = Number(option('--ciclos') ?? 10);
assert.ok(Number.isInteger(count) && count >= 2 && count <= 8, '--clientes: 2..8');
assert.ok(Number.isInteger(cycles) && cycles >= 2 && cycles <= 50, '--ciclos: 2..50');
const root = path.join(outputRoot, `verificacion-recursos-${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${process.pid}`);
await fs.mkdir(root, { recursive: true });
const base = path.join(root, 'Base ficticia');
const information = path.join(root, 'Proyecto ficticio');
const logs = path.join(root, 'logs');
await fs.mkdir(information);
await fs.mkdir(logs);
const packageRoot = option('--mind') ? await fs.realpath(option('--mind')) : null;
const python = option('--python') ?? (packageRoot
  ? path.join(packageRoot, 'Runtime', 'python', process.platform === 'win32' ? 'python.exe' : 'bin/python3')
  : process.env.MIND_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3'));
const launcher = packageRoot ? path.join(packageRoot, 'Motor', 'bin', 'mind.js') : path.join(repo, 'bin', 'mind.js');
const node = packageRoot ? path.join(packageRoot, 'Runtime', 'node', process.platform === 'win32' ? 'node.exe' : 'bin/node') : process.execPath;
const clients = [];
const ownedPids = new Set();
const ownedLifetimes = [];
const results = [];
const measurements = [];
const begun = Date.now();
const env = { MIND_PYTHON: python, TEMP: root, TMP: root, TMPDIR: root, NODE_OPTIONS: '' };
let fatal = null;

async function bounded(promise, label, ms = 30_000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Tiempo agotado: ${label}`)), ms); })]); }
  finally { clearTimeout(timer); }
}
async function eventually(check, label, timeout = 30_000, interval = 200) {
  const deadline = Date.now() + timeout;
  do { const value = await check(); if (value) return value; await delay(interval); } while (Date.now() < deadline);
  throw new Error(`No se cumplió: ${label}`);
}
async function step(name, action) {
  const start = Date.now();
  try {
    const detail = await action();
    results.push({ nombre: name, resultado: 'superado', ms: Date.now() - start, detalle: detail ?? null });
    process.stdout.write(`PASS ${name}\n`);
    return detail;
  } catch (error) {
    results.push({ nombre: name, resultado: 'fallido', ms: Date.now() - start, error: String(error.stack ?? error) });
    process.stderr.write(`FAIL ${name}: ${error.message}\n`);
    throw error;
  }
}
async function readJson(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }
async function indices() {
  const names = await fs.readdir(base).catch(() => []);
  return Promise.all(names.filter(name => /^folder-index-.*\.json$/.test(name)).map(name => readJson(path.join(base, name))));
}
async function currentIndex() {
  const values = await indices();
  return values.find(index => path.resolve(index.root) === path.resolve(information)) ?? null;
}
async function owner() { return readJson(path.join(base, 'background-owner.json')).catch(() => null); }
async function stableGeneration() {
  let generation = null; let stableAt = Date.now();
  return eventually(async () => {
    const index = await currentIndex();
    if (!index) return null;
    if (generation !== index.generation) { generation = index.generation; stableAt = Date.now(); }
    return Date.now() - stableAt >= 4_000 ? index : null;
  }, 'generación del índice estable', 45_000);
}
async function status(client) {
  const response = await bounded(client.call('estado'), 'estado');
  assert.equal(response.isError, false, JSON.stringify(response));
  return response.data;
}
async function open(label) {
  const startedAt = Date.now();
  const client = startMcp({ command: node, commandArgs: [launcher, 'mcp'], args: ['--base', base], cwd: packageRoot ?? repo,
    env, onElicit: () => ({ action: 'accept', content: { acceso: 'completo' } }),
    clientInfo: { name: `validacion-recursos-${label}`, version: '1.0.1' },
  });
  client.label = label;
  clients.push(client);
  if (client.child.pid) ownedPids.add(client.child.pid);
  const lifetime = { pid: client.child.pid, startedAt, endedAt: Infinity };
  ownedLifetimes.push(lifetime);
  client.child.once('exit', () => { lifetime.endedAt = Date.now(); });
  client.child.on('error', () => {});
  client.child.stdin.on('error', () => {});
  const initialized = await bounded(client.initialize(), `initialize ${label}`);
  assert.equal(initialized.result?.serverInfo?.name, 'mind', client.stderr());
  assert.equal(initialized.result?.serverInfo?.version, '1.0.1', 'Esta verificación corresponde al Motor 1.0.1');
  client.serverInfo = initialized.result.serverInfo;
  return client;
}
async function close(client) {
  const exit = await bounded(client.close(), `cierre ${client.label}`, 15_000);
  assert.equal(exit.code, 0, `${client.label}: ${JSON.stringify(exit)} ${client.stderr().slice(-1500)}`);
  return exit;
}
// Enumerar una sola vez por comprobación. No se imprimen líneas de órdenes.
// El conjunto se limita a los PID que este script creó y sus descendientes.
async function processRows() {
  if (process.platform !== 'win32') return null;
  const ps = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const command = '$ErrorActionPreference="Stop"; @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,@{Name="CreatedAtMs";Expression={if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { $null }}},WorkingSetSize,PrivatePageCount) | ConvertTo-Json -Compress';
  const child = spawn(ps, ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exit = await bounded(new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }), 'inventario de procesos', 20_000);
  assert.equal(exit, 0, stderr);
  const all = JSON.parse(stdout);
  // A PID can be reused immediately by Windows. Attribute a root or a direct
  // child only when it was created during one of our recorded root lifetimes.
  const during = (pid, createdAt) => Number.isFinite(createdAt) && ownedLifetimes.some(item => item.pid === pid && createdAt >= item.startedAt - 2 && createdAt <= item.endedAt);
  const selected = new Map(all.filter(item => during(item.ProcessId, item.CreatedAtMs)
    || during(item.ParentProcessId, item.CreatedAtMs)).map(item => [item.ProcessId, item.CreatedAtMs]));
  for (let repeat = 0; repeat < 20; repeat += 1) {
    let added = false;
    for (const item of all) {
      if (selected.has(item.ParentProcessId) && item.CreatedAtMs >= selected.get(item.ParentProcessId) && !selected.has(item.ProcessId)) {
        selected.set(item.ProcessId, item.CreatedAtMs); added = true;
      }
    }
    if (!added) break;
  }
  for (const client of clients) {
    if (client.child.pid && client.child.exitCode === null && client.child.signalCode === null) {
      assert.ok(selected.has(client.child.pid), `El censo no identificó el cliente propio activo ${client.child.pid}`);
    }
  }
  return all.filter(item => selected.has(item.ProcessId)).map(item => ({
    pid: item.ProcessId, padre: item.ParentProcessId, nombre: item.Name, creado: new Date(item.CreatedAtMs).toISOString(),
    memoria_privada_MB: Math.round(Number(item.PrivatePageCount) / 1024 / 1024 * 10) / 10,
    memoria_residente_MB: Math.round(Number(item.WorkingSetSize) / 1024 / 1024 * 10) / 10,
  }));
}
async function noResidents(label) {
  let processes = await processRows();
  if (processes === null) {
    for (const pid of ownedPids) {
      let alive = true; try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; }
      assert.equal(alive, false, `Proceso MCP propio todavía vivo: ${pid}`);
    }
    return { plataforma: process.platform, procesos_MCP_restantes: 0, auxiliares: 'inventario completo solo implementado para Windows' };
  }
  const observed = processes;
  const started = Date.now();
  while (processes.length && Date.now() - started < 10_000) {
    await delay(200);
    processes = await processRows();
  }
  assert.deepEqual(processes, [], `${label}: procesos propios residentes ${JSON.stringify(processes)}`);
  return { procesos_propios_restantes: 0, espera_retirada_ms: Date.now() - started, procesos_transitorios: observed };
}
async function measure(label) {
  const processes = await processRows();
  const value = { etapa: label, fecha: new Date().toISOString(), procesos: processes,
    memoria_privada_total_MB: processes?.reduce((sum, item) => sum + item.memoria_privada_MB, 0) ?? null };
  measurements.push(value); return value;
}

try {
  await step('Datos ficticios aislados y conservados', async () => {
    for (let i = 0; i < 500; i += 1) await fs.writeFile(path.join(information, `nota-${String(i).padStart(4, '0')}.txt`), `Documento ficticio ${i}\n`);
    return { archivos: 500, raiz: root };
  });
  let first;
  await step('Primer cliente indexa y toma la coordinación', async () => {
    first = await open('propietario-inicial');
    const access = await bounded(first.call('solicitar_acceso', { ruta: information, acceso: 'completo' }), 'autorización ficticia');
    assert.equal(access.data?.estado, 'autorizado', JSON.stringify(access));
    const found = await bounded(first.call('buscar', { consulta: 'nota-' }), 'búsqueda inicial', 60_000);
    assert.equal(found.data?.total, 500, JSON.stringify(found).slice(0, 500));
    const record = await eventually(async () => { const value = await owner(); return value?.pid === first.child.pid && value; }, 'propietario inicial');
    const index = await stableGeneration();
    return { propietario: record.pid, generacion: index.generation, entradas: index.entries.length };
  });
  const group = [first];
  await step('Varias conexiones comparten una única indexación', async () => {
    const before = await stableGeneration();
    for (let i = 1; i < count; i += 1) group.push(await open(`seguidor-${i}`));
    for (const client of group) {
      const found = await bounded(client.call('buscar', { consulta: 'nota-' }), 'consulta compartida');
      assert.equal(found.data?.total, 500, JSON.stringify(found).slice(0, 500));
    }
    await delay(3_000);
    const after = await currentIndex();
    assert.equal(after.generation, before.generation, 'Conectar/consultar seguidores volvió a recorrer el ámbito');
    const statuses = await Promise.all(group.map(status));
    const roles = statuses.map(item => item.sesion?.coordinacion?.role);
    assert.equal(roles.filter(value => value === 'owner').length, 1, JSON.stringify(roles));
    assert.equal(roles.filter(value => value === 'follower').length, count - 1, JSON.stringify(roles));
    for (const value of statuses) {
      assert.ok(value.recursos, 'Falta el diagnóstico de recursos');
      assert.ok(value.procesos, 'Falta el diagnóstico de procesos propios');
    }
    await fs.writeFile(path.join(root, 'diagnostico-conexiones.json'), JSON.stringify(statuses, null, 2));
    return { clientes: count, propietarios: 1, seguidores: count - 1, generacion_sin_repetir: after.generation };
  });
  await step('Consultas repetidas mantienen el índice y consumo acotados', async () => {
    const before = await currentIndex();
    const latencies = [];
    await measure('antes de carga');
    for (let wave = 0; wave < 3; wave += 1) {
      for (let round = 0; round < 25; round += 1) {
        for (const client of group) {
          const started = performance.now();
          const result = await bounded(client.call('buscar', { consulta: `nota-${String(round).padStart(4, '0')}` }), 'consulta repetida');
          latencies.push(performance.now() - started);
          assert.equal(result.data?.total, 1);
        }
      }
      await measure(`después de ${25 * (wave + 1) * count} consultas`);
    }
    const after = await currentIndex();
    assert.equal(after.generation, before.generation, 'Las consultas deben reutilizar el índice');
    const warm = measurements.at(1).memoria_privada_total_MB;
    const final = measurements.at(-1).memoria_privada_total_MB;
    if (warm !== null && final !== null) assert.ok(final <= warm + Math.max(128, warm * 0.25), `Crecimiento excesivo después del calentamiento: ${warm} → ${final} MB`);
    latencies.sort((a, b) => a - b);
    return { consultas: 75 * count, mediciones: measurements.length,
      latencia_consulta_p95_ms: Math.round(latencies[Math.ceil(latencies.length * 0.95) - 1]),
      latencia_consulta_maxima_ms: Math.round(latencies.at(-1)),
      memoria_privada_tras_calentamiento_MB: warm, memoria_privada_final_MB: final,
      limite_crecimiento_MB: warm === null ? null : Math.max(128, warm * 0.25),
      limite_de_evidencia: 'Prueba finita de crecimiento acotado; no demuestra ausencia de toda fuga de memoria a largo plazo.' };
  });
  await step('Un cambio externo se reconcilia una vez para todos los clientes', async () => {
    const before = await currentIndex();
    await fs.writeFile(path.join(information, 'cambio-externo.txt'), 'Cambio ficticio controlado\n');
    await eventually(async () => (await currentIndex())?.entries.some(item => item.path === 'cambio-externo.txt'), 'incorporación del cambio externo');
    const after = await stableGeneration();
    assert.equal(after.generation, before.generation + 1, 'El mismo cambio disparó más de una reconciliación');
    for (const client of group) assert.equal((await bounded(client.call('buscar', { consulta: 'cambio-externo' }), 'consulta del cambio')).data?.total, 1);
    return { antes: before.generation, despues: after.generation };
  });
  await step('Otro cliente toma el trabajo tras la caída del propietario', async () => {
    const previous = await owner();
    const leader = group.find(client => client.child.pid === previous?.pid);
    assert.ok(leader, 'El propietario debe pertenecer a esta prueba');
    leader.child.kill('SIGKILL');
    await bounded(leader.exited, 'terminación forzada del propietario');
    const next = await eventually(async () => { const value = await owner(); return value?.pid !== previous.pid && group.some(client => client.child.pid === value?.pid) && value; }, 'nuevo propietario', 20_000);
    await fs.writeFile(path.join(information, 'tras-caida.txt'), 'Dato ficticio tras recuperación\n');
    await eventually(async () => (await currentIndex())?.entries.some(item => item.path === 'tras-caida.txt'), 'indexación tras recuperación');
    for (const client of group.filter(client => client !== leader)) assert.equal((await bounded(client.call('buscar', { consulta: 'tras-caida' }), 'consulta tras caída')).data?.total, 1);
    await stableGeneration();
    for (const client of group.filter(client => client !== leader)) await close(client);
    await delay(1_000);
    await noResidents('recuperación');
    return { propietario_anterior: previous.pid, propietario_nuevo: next.pid, recuperacion: 'verificada' };
  });
  await step('Abrir y cerrar repetidamente no acumula procesos ni sesiones vivas', async () => {
    const detail = [];
    for (let i = 0; i < cycles; i += 1) {
      const client = await open(`ciclo-${i + 1}`);
      const result = await bounded(client.call('buscar', { consulta: 'nota-0001' }), 'consulta del ciclo');
      assert.equal(result.data?.total, 1, JSON.stringify(result).slice(0, 500));
      const started = Date.now();
      await close(client);
      await delay(200);
      const residents = await noResidents(`ciclo ${i + 1}`);
      const record = await owner();
      assert.equal(record, null, 'Quedó propietario después del último cierre');
      const sessions = (await fs.readdir(path.join(base, 'sesiones'))).filter(name => /^sesion-/.test(name));
      // El registro de una caída abrupta puede conservarse como obsoleto; nunca
      // se acepta que un registro de una sesión cerrada normalmente se acumule.
      const stale = await Promise.all(sessions.map(name => readJson(path.join(base, 'sesiones', name))));
      assert.ok(stale.every(record => !clients.some(item => item.child.pid === record.pid && item.child.exitCode === 0)), 'Quedó una sesión que cerró normalmente');
      detail.push({ ciclo: i + 1, pid: client.child.pid, cierre_ms: Date.now() - started, ...residents, registros_obsoletos: sessions.length });
    }
    return detail;
  });
} catch (error) { fatal = error; }
finally {
  if (fatal) {
    const diagnostics = await Promise.all(clients.filter(client => client.child.exitCode === null && client.child.signalCode === null).map(async client => {
      try { return { cliente: client.label, pid: client.child.pid, estado: await bounded(client.call('estado'), 'diagnóstico tras fallo', 10_000) }; }
      catch (error) { return { cliente: client.label, pid: client.child.pid, error: error.message }; }
    }));
    await fs.writeFile(path.join(root, 'diagnostico-fallo.json'), JSON.stringify(diagnostics, null, 2));
  }
  for (const client of clients) {
    if (client.child.exitCode === null && client.child.signalCode === null) {
      client.child.stdin.end();
      await bounded(client.exited, 'limpieza de cliente propio', 5_000).catch(async () => {
        client.child.kill('SIGKILL');
        await bounded(client.exited, 'terminación de cliente propio', 5_000);
      });
    }
    await fs.writeFile(path.join(logs, `${client.label}.stderr.jsonl`), client.stderr());
  }
  const report = { fecha: new Date().toISOString(), plataforma: `${process.platform}-${process.arch}`,
    node: process.version, motor: clients[0]?.serverInfo ?? null, fuente: packageRoot ?? repo, root, ms: Date.now() - begun,
    superados: results.filter(item => item.resultado === 'superado').length,
    fallidos: results.filter(item => item.resultado === 'fallido').length,
    casos: results, mediciones: measurements,
    nota: 'Clientes MCP reales por stdio con agente/consentimiento simulados. Datos ficticios conservados para archivado. Solo procesos creados por esta prueba se terminan.' };
  await fs.writeFile(path.join(root, 'informe.json'), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`Informe: ${path.join(root, 'informe.json')}\n`);
  if (fatal) process.exitCode = 1;
}
