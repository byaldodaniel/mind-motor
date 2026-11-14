#!/usr/bin/env node
// Mide la memoria privada de un puente `mind mcp` real a lo largo de una sesión de trabajo.
// Uso: node scripts/medir-puente.mjs [--opciones-node "<flags>"]
// Usa una Base y un proyecto temporales; no toca ninguna instalación.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { startMcp } from '../test/helpers/mcp-client.js';
import { stopCentralMotor } from '../src/connector.js';

const flagsAt = process.argv.indexOf('--opciones-node');
const nodeFlags = flagsAt >= 0 ? process.argv[flagsAt + 1].split(/\s+/u).filter(Boolean) : [];
const launcher = fileURLToPath(new URL('../bin/mind.js', import.meta.url));

function privateMb(pid) {
  if (process.platform === 'win32') {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).PrivateMemorySize64`], { encoding: 'utf8', windowsHide: true });
    return Number(out.trim()) / 1048576;
  }
  const status = execFileSync('cat', [`/proc/${pid}/status`], { encoding: 'utf8' });
  return Number(/RssAnon:\s+(\d+)/u.exec(status)?.[1] ?? 0) / 1024;
}

const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mind-medir-puente-')));
const base = path.join(root, 'Base');
const project = path.join(root, 'Proyecto');
await fs.mkdir(project, { recursive: true });
for (let i = 0; i < 300; i++) await fs.writeFile(path.join(project, `nota-${i}.md`), `# Nota ${i}\n` + 'texto de prueba '.repeat(200));
await fs.writeFile(path.join(project, 'grande.txt'), 'linea larga de prueba para medir el puente\n'.repeat(200_000)); // ~8,6 MB

const bridge = startMcp({ command: process.execPath, commandArgs: [...nodeFlags, launcher, 'mcp'], args: ['--base', base], cwd: project,
  env: { NODE_OPTIONS: '', MIND_AGENT_STARTUP: '0' } });
const rows = [];
const sample = async (fase) => { await delay(1500); rows.push({ fase, privada_mb: Number(privateMb(bridge.child.pid).toFixed(1)) }); };
try {
  await bridge.initialize();
  await sample('tras initialize');
  for (let i = 0; i < 20; i++) await bridge.call('buscar', { consulta: 'nota' });
  await sample('tras 20 buscar');
  for (let i = 0; i < 20; i++) await bridge.call('leer', { ruta: `nota-${i}.md` });
  await sample('tras 20 leer pequeños');
  const big = await bridge.call('leer', { ruta: 'grande.txt' });
  if (big.isError) rows.push({ fase: 'leer grande', error: big.text.slice(0, 200) });
  await sample('tras leer 8,6 MB');
  for (let i = 0; i < 5; i++) await bridge.call('leer', { ruta: 'grande.txt' });
  await sample('tras 5 lecturas grandes más');
  await delay(15_000);
  await sample('15 s en reposo');
} finally {
  await bridge.close().catch(() => {});
  await stopCentralMotor(base).catch(() => {});
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
console.log(JSON.stringify({ opciones: nodeFlags, filas: rows }, null, 2));
