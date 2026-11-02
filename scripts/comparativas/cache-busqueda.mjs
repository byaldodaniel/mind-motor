#!/usr/bin/env node
// B6 — Búsqueda con y sin el índice validado en memoria, sobre un árbol
// ficticio reproducible (semilla fija). Mide desde la herramienta del agente
// ("buscar"), que incluye la comprobación del índice y de los permisos.
//
//   node scripts/comparativas/cache-busqueda.mjs --entradas 100000 [--repeticiones 10] [--salida informe.json]
//
// Ejecuta dos procesos hijos idénticos, uno con MIND_SIN_CACHE_INDICE=1 (antes)
// y otro sin él (después), y compara con find y rg con un criterio equivalente
// (consulta sin tildes ni mayúsculas en la que todas las herramientas coinciden).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planificarArbol, escribirArbol, verdad } from './lib/arbol.mjs';
import { estadisticas } from './lib/medir.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : fallback;
};
const SELF = fileURLToPath(import.meta.url);

if (args.includes('--hijo')) {
  await child(JSON.parse(option('--hijo')));
  process.exit(0);
}

const total = Number(option('--entradas', '100000'));
const repetitions = Number(option('--repeticiones', '10'));
const report = option('--salida', null);
const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'mind-cache-busqueda-'));
try {
  const plan = planificarArbol({ entradas: total });
  const tree = path.join(work, 'Árbol ficticio');
  fs.mkdirSync(tree);
  const written = escribirArbol(tree, plan);
  const query = 'informe';
  const truth = verdad(plan, { consulta: query });
  const results = {};
  for (const [label, disabled] of [['antes (sin caché)', true], ['después (con caché)', false]]) {
    const base = path.join(work, `Base ${disabled ? 'antes' : 'despues'}`);
    const out = spawnSync(process.execPath, ['--expose-gc', SELF, '--hijo', JSON.stringify({ tree, base, query, repetitions })], {
      env: { ...process.env, ...(disabled ? { MIND_SIN_CACHE_INDICE: '1' } : {}) }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    });
    if (out.status !== 0) throw new Error(`${label}: ${out.stderr}`);
    results[label] = JSON.parse(out.stdout.trim().split('\n').at(-1));
    results[label].exhaustividad = results[label].encontrados / truth.size;
  }
  const direct = {};
  const time = (command, commandArgs) => {
    const times = [];
    let count = null;
    for (let i = 0; i < repetitions + 1; i += 1) {
      const start = performance.now();
      const run = spawnSync(command, commandArgs, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
      if (run.error) return null;
      if (i > 0) times.push(performance.now() - start);
      count = run.stdout.split('\n').filter(Boolean).length;
    }
    return { ms: estadisticas(times), encontrados: count, exhaustividad: count / truth.size };
  };
  direct['find -iname'] = time('find', [tree, '-type', 'f', '-iname', `*${query}*`]);
  direct['rg --files --iglob'] = time('rg', ['--files', '--hidden', '--no-ignore', '--iglob', `*${query}*`, tree]);
  const summary = {
    fecha: new Date().toISOString(), equipo: { cpu: os.cpus()[0]?.model, nucleos: os.cpus().length, sistema: `${process.platform}-${process.arch}`, node: process.version },
    arbol: { entradas: total, escritura_s: Number(written.segundos.toFixed(2)), consulta: query, verdad: truth.size },
    mind: results, directo: direct,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (report) await fsp.writeFile(report, `${JSON.stringify(summary, null, 2)}\n`);
} finally {
  await fsp.rm(work, { recursive: true, force: true });
}

async function child({ tree, base, query, repetitions: n }) {
  const { openSession } = await import('../../src/session.js');
  const { createAgentTools } = await import('../../src/agent-tools.js');
  const layout = {
    product: false, manifest: null, root: null, motorDirectory: fileURLToPath(new URL('../..', import.meta.url)),
    baseDirectory: base, pythonExecutable: process.platform === 'win32' ? 'python' : 'python3', protectedDirectories: [],
  };
  // Con observación, como la sesión MCP de un agente.
  const session = await openSession({ layout, motorVersion: 'comparativa', observe: true, log: () => {} });
  await session.start();
  const folder = await session.motor.authorizeFolder(tree);
  await session.policy.set(folder.id, ['encontrar', 'leer'], { channel: 'administracion-local' });
  const heap = () => { globalThis.gc?.(); return process.memoryUsage().heapUsed; };
  const heapBefore = heap();
  let start = performance.now();
  await session.motor.indexFolder(folder.id);
  const indexMs = performance.now() - start;
  const agent = (name) => createAgentTools({ session, connection: { clientInfo: { name }, supportsFormElicitation: () => false, protocolVersion: '2025-11-25' } });
  const a = agent('agente-a');
  const b = agent('agente-b');
  const search = async (tools) => {
    const t0 = performance.now();
    const found = await tools.call('buscar', { consulta: query, limite: 500 }, {});
    return { ms: performance.now() - t0, total: found.total };
  };
  const first = await search(a);
  const repeated = [];
  for (let i = 0; i < n; i += 1) repeated.push((await search(a)).ms);
  const twoAgents = [];
  for (let i = 0; i < n; i += 1) {
    const t0 = performance.now();
    await Promise.all([search(a), search(b)]);
    twoAgents.push(performance.now() - t0);
  }
  const heapAfter = heap();
  // Cambio externo y reconciliación: la búsqueda siguiente lo refleja.
  const added = path.join(tree, `informe-nuevo-${Date.now()}.txt`);
  fs.writeFileSync(added, 'x');
  start = performance.now();
  await session.reindex(folder.id);
  const reconcileMs = performance.now() - start;
  const afterChange = await search(a);
  // Revocación: la búsqueda siguiente ya no devuelve nada de esa carpeta.
  await session.motor.revokeFolder(folder.id);
  const revoked = await a.call('buscar', { consulta: query }, {}).then((value) => value.total, (error) => error.code);
  process.stdout.write(`${JSON.stringify({
    indexacion_ms: Math.round(indexMs), reconciliacion_tras_cambio_ms: Math.round(reconcileMs),
    primera_busqueda_ms: Math.round(first.ms), repetida_ms: estadisticas(repeated), dos_agentes_simultaneos_ms: estadisticas(twoAgents),
    tras_modificacion_ms: Math.round(afterChange.ms), encontrados: first.total, encontrados_tras_modificacion: afterChange.total,
    tras_revocar: revoked, memoria_heap_mb: Number(((heapAfter - heapBefore) / 1048576).toFixed(1)),
  })}\n`);
  await session.close();
  fs.rmSync(added);
}
