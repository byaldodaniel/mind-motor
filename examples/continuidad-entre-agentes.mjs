// Demostración de la Función 05 con dos anfitriones ficticios, cada uno en su propio proceso.
// Uso: node examples/continuidad-entre-agentes.mjs [directorioRaízAbsoluto]
// Sin argumento crea una Base temporal en el directorio temporal del sistema y la elimina al final.
// Con argumento crea la Base dentro de esa raíz y la conserva para inspeccionarla.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openMotor } from '../src/motor.js';
import { createContinuity, formatContinuityMarkdown } from '../src/continuity.js';
import { createContinuityAccess } from '../src/continuity-access.js';

const script = fileURLToPath(import.meta.url);

async function openHost(base) {
  const continuity = createContinuity(await openMotor({ baseDirectory: base }));
  return { continuity, access: createContinuityAccess(continuity) };
}

/** Agente ficticio A. Solo conoce su vista: registra una decisión, un resultado y una nota interna. */
async function agentA(view) {
  const decision = await view.recordResult({
    kind: 'decisión',
    content: {
      resumen: 'Publicar el catálogo de ejemplo como JSON portable',
      motivos: ['legible por cualquier herramienta', 'sin dependencias de un proveedor'],
    },
  });
  const result = await view.recordResult({
    kind: 'resultado',
    content: {
      hecho: 'Esquema v1 del catálogo redactado',
      pendientes: ['Validar el esquema con tres ejemplos', 'Redactar la guía de uso'],
    },
    references: [
      { entry: decision.id, relation: 'aplica' },
      { locator: 'carpeta-demo/catalogo/esquema-v1.md', relation: 'documento' },
    ],
  });
  const note = await view.recordResult({ kind: 'nota interna', content: 'Borrador descartado; no compartir.' });
  return { decision: decision.id, result: result.id, note: note.id };
}

/** Agente ficticio B. Continúa a partir del contexto recibido, sin saber qué más hay en la Base. */
async function agentB(view) {
  const context = JSON.parse(await view.readContext({ format: 'json' }));
  const previous = context.entries.find((entry) => entry.kind === 'resultado');
  const decision = context.entries.find((entry) => entry.kind === 'decisión');
  const [next, ...rest] = previous.content.pendientes;
  const continuation = await view.recordResult({
    kind: 'resultado',
    content: { hecho: `${next}: completado`, criterio: decision.content.resumen, pendientes: rest },
    references: [{ entry: previous.id, relation: 'continúa' }, { entry: decision.id, relation: 'aplica' }],
  });
  return { received: context.entries.map((entry) => entry.id), continuation: continuation.id };
}

async function hostA(base) {
  const { access } = await openHost(base);
  const agent = Object.freeze({}); // Identidad opaca; el nombre no concede nada.
  // Agente A solo puede registrar resultados nuevos: no recibe ningún registro previo.
  const authorization = await access.grantContinuityAccess({
    requester: agent, allowRecord: true, source: 'Anfitrión A · Agente A',
  });
  return agentA(access.bindContinuityAgent({ requester: agent, authorization }));
}

async function hostB(base, selectedId, unselectedId) {
  const { continuity, access } = await openHost(base);
  const agent = Object.freeze({});
  // El anfitrión B, con autorización del usuario, elige el resultado y lo que este cita.
  const authorization = await access.grantContinuityAccess({
    requester: agent, ids: [selectedId], includeReferenced: true, allowRecord: true, source: 'Anfitrión B · Agente B',
  });
  const granted = access.describeContinuityAccess(authorization).ids;
  const view = access.bindContinuityAgent({ requester: agent, authorization });
  const markdown = await view.readContext({ format: 'markdown' });
  const outcome = await agentB(view);
  let unselected;
  try {
    await view.recordResult({ content: 'Intento de citar la nota', references: [{ entry: unselectedId }] });
    unselected = 'permitido';
  } catch (error) {
    unselected = error.code;
  }
  access.revokeContinuityAccess(authorization);
  let afterRevoke;
  try {
    await view.readContext();
    afterRevoke = 'permitido';
  } catch (error) {
    afterRevoke = error.code;
  }
  const chain = formatContinuityMarkdown(
    await continuity.exportContinuity({ ids: [outcome.continuation], includeReferenced: true }),
  );
  return { ...outcome, granted, markdown, unselected, afterRevoke, chain };
}

function runPhase(...args) {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 20_000, windowsHide: true });
  if (result.status !== 0) throw new Error(`La fase ${args[0]} falló:\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

async function main() {
  const [phase, ...rest] = process.argv.slice(2);
  if (phase === '--anfitrion-a') {
    process.stdout.write(JSON.stringify(await hostA(rest[0])));
    return;
  }
  if (phase === '--anfitrion-b') {
    process.stdout.write(JSON.stringify(await hostB(...rest)));
    return;
  }
  const keep = phase !== undefined;
  if (keep && !path.isAbsolute(phase)) throw new Error('Indica una raíz absoluta, fuera del repositorio.');
  const root = await fs.mkdtemp(path.join(keep ? phase : os.tmpdir(), 'mind-demo-continuidad-'));
  const base = path.join(root, 'Base');
  await fs.mkdir(base);
  try {
    const a = runPhase('--anfitrion-a', base);
    console.log('1. Anfitrión A (proceso propio): Agente A registró decisión, resultado y una nota interna.');
    console.log(`   decisión ${a.decision}\n   resultado ${a.result}\n   nota      ${a.note}`);
    console.log('2. El proceso A terminó. Mind conserva los registros en la Base.');
    const b = runPhase('--anfitrion-b', base, a.result, a.note);
    console.log('3. Anfitrión B (otro proceso) selecciona el resultado y lo que cita.');
    console.log(`   Concedidos: ${b.granted.length} registros, sin la nota interna.`);
    console.log('   Contexto recibido por Agente B:\n');
    console.log(b.markdown.replace(/^/gm, '   | '));
    console.log(`4. Agente B continuó el trabajo: ${b.continuation}`);
    console.log(`   Citar la nota no seleccionada: ${b.unselected}`);
    console.log(`   Lectura tras retirar el permiso: ${b.afterRevoke}`);
    console.log('5. Cadena conservada en Mind:\n');
    console.log(b.chain.replace(/^/gm, '   | '));
    console.log(`RESUMEN ${JSON.stringify({ base, a, b: { ...b, markdown: undefined, chain: undefined } })}`);
  } finally {
    if (!keep) await fs.rm(root, { recursive: true, force: true });
  }
}

await main();
