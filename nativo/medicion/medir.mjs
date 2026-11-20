// Ejecuta las tareas de medición con Codex en los dos catálogos y resume.
// Uso: node medir.mjs <carpeta-de-medición> <codex.exe> [repeticiones=2]
// La Base ficticia debe estar preparada (preparar.mjs) y el Motor en marcha (motor.mjs).
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const [root, codex, repsArg] = process.argv.slice(2);
if (!root?.includes('mind-medicion-') || !codex) throw new Error('Uso: node medir.mjs <carpeta mind-medicion-*> <codex.exe> [repeticiones]');
const reps = Number(repsArg ?? 2);
const base = path.join(root, 'Base');
const folder = path.join(root, 'Proyecto Atlas');
const { port } = JSON.parse(await fs.readFile(path.join(base, 'conector.json'), 'utf8'));
const { token } = JSON.parse(await fs.readFile(path.join(base, 'conector-secreto.json'), 'utf8'));
const conversation = '8dad3096-b455-4d56-aa6a-7d7725a9f4e4';
const out = path.join(HERE, 'resultados');
await fs.mkdir(out, { recursive: true });

const PREFIX = 'Usa solo el servidor MCP mindprueba; no ejecutes comandos de shell. ';
const norm = (t) => String(t).normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
const TASKS = [
  { id: 't1-retomar', prompt: `Retoma la conversación de Mind con ID ${conversation} y dime en una sola frase cuál es el siguiente paso.`,
    check: (m) => /cotizacion/.test(norm(m)) && /caja/.test(norm(m)) },
  { id: 't2-pendientes', prompt: 'Lista los pendientes abiertos (sin los cerrados) de las carpetas del Proyecto Atlas en Mind, uno por línea.',
    check: (m) => ['proveedor de cajas', 'presupuesto de transporte', 'muestra', 'logistica'].every((k) => norm(m).includes(k)) && !norm(m).includes('confidencialidad') },
  { id: 't3-seccion', prompt: 'En el archivo frente.md del Proyecto Atlas, ¿qué decisiones están registradas? Responde solo con sus fechas y lo decidido.',
    check: (m) => /2026-11-10|10 de noviembre|10-nov|10\/11/.test(norm(m)) && /reciclad/.test(norm(m)) && /24/.test(m) },
  { id: 't4-guardar', prompt: 'Guarda en Mind una conversación nueva titulada «Atlas · proveedor» con esta información importante: «Decisión: proveedor de cajas elegido, Cajas Norte, el 20-nov.» Confirma cuando esté guardada.',
    check: null },
];

function runOnce(task, catalogo, rep) {
  const args = ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only', '-C', folder,
    '-c', 'model_reasoning_effort="medium"', '-c', 'mcp_servers.mind.enabled=false', '-c', 'mcp_servers.node_repl.enabled=false',
    '-c', `mcp_servers.mindprueba.url="http://127.0.0.1:${port}/mcp?catalogo=${catalogo}"`,
    '-c', 'mcp_servers.mindprueba.bearer_token_env_var="MIND_PRUEBA_TOKEN"', PREFIX + task.prompt];
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(codex, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, MIND_PRUEBA_TOKEN: token } });
    let stdout = '', stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    const timer = setTimeout(() => child.kill(), 600_000);
    child.on('close', async (code) => {
      clearTimeout(timer);
      const file = path.join(out, `${task.id}-${catalogo}-${rep}.jsonl`);
      await fs.writeFile(file, stdout);
      const events = stdout.split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const usage = events.filter((e) => e.type === 'turn.completed').map((e) => e.usage).at(-1) ?? null;
      const calls = events.filter((e) => e.type === 'item.completed' && e.item?.type === 'mcp_tool_call').map((e) => ({ herramienta: e.item.tool, error: Boolean(e.item.error) }));
      const final = events.filter((e) => e.type === 'item.completed' && e.item?.type === 'agent_message').map((e) => e.item.text).at(-1) ?? '';
      resolve({ tarea: task.id, catalogo, rep, code, segundos: Math.round((Date.now() - started) / 100) / 10, usage, llamadas: calls, respuesta: final, error: code === 0 ? null : stderr.slice(-400) });
    });
  });
}

async function conversationsTitled(title) {
  const res = await fetch(`http://127.0.0.1:${port}/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ accion: 'herramienta', tool: 'conversaciones_buscar', args: { consulta: title, modo: 'palabras', limite: 50 } }) });
  const body = await res.json().catch(() => null);
  return (body?.value?.conversaciones ?? []).filter((c) => String(c.titulo).includes('proveedor')).length;
}

const results = [];
for (let rep = 1; rep <= reps; rep++) {
  for (const task of TASKS) {
    // Orden alterno: en la repetición impar va primero el núcleo; en la par, el completo.
    const order = rep % 2 === 1 ? ['nucleo', 'completo'] : ['completo', 'nucleo'];
    for (const catalogo of order) {
      const before = task.check ? null : await conversationsTitled('Atlas proveedor');
      const result = await runOnce(task, catalogo, rep);
      if (task.check) result.acierto = result.code === 0 && task.check(result.respuesta);
      else result.acierto = result.code === 0 && (await conversationsTitled('Atlas proveedor')) > before;
      results.push(result);
      const u = result.usage ?? {};
      console.log(`${task.id} ${catalogo} #${rep}: ${result.acierto ? 'acierta' : 'FALLA'} · ${result.segundos}s · entrada ${u.input_tokens ?? '?'} (caché ${u.cached_input_tokens ?? '?'}) · salida ${u.output_tokens ?? '?'} · llamadas ${result.llamadas.length}`);
      await fs.writeFile(path.join(out, 'resumen.json'), JSON.stringify(results, null, 2));
    }
  }
}
