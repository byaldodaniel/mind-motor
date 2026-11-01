#!/usr/bin/env node
// Los 12 casos esenciales de la Etapa F, ejecutados contra una carpeta de Mind
// EXTRAÍDA (no el repositorio). El servidor se lanza exactamente como lo declara
// el .mcp.json del paquete, con la carpeta de Mind como directorio de trabajo.
//
//   node scripts/producto-12-casos.mjs --mind <carpeta-de-Mind> [--informe <archivo.json>]
//
// Solo usa datos ficticios, en temporales fuera de la carpeta de Mind que se
// eliminan al terminar. Un caso que todavía no puede ejecutarse se informa como
// "pendiente", nunca como superado.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startMcp } from '../test/helpers/mcp-client.js';

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const mindArgument = option('--mind');
if (!mindArgument) {
  process.stderr.write('Uso: node scripts/producto-12-casos.mjs --mind <carpeta-de-Mind> [--informe <archivo.json>]\n');
  process.exit(2);
}
const mind = await fs.realpath(path.resolve(mindArgument));
const reportFile = option('--informe');
const results = [];
const clients = [];

function check(condition, message) {
  if (!condition) throw new Error(message);
}

async function step(number, name, task) {
  const started = Date.now();
  try {
    const detail = await task();
    if (detail?.pending) {
      results.push({ caso: number, nombre: name, resultado: 'pendiente', motivo: detail.pending, ms: Date.now() - started });
      process.stdout.write(`⏳ ${number}. ${name}: pendiente — ${detail.pending}\n`);
      return;
    }
    results.push({ caso: number, nombre: name, resultado: 'superado', ms: Date.now() - started, ...(detail ? { detalle: detail } : {}) });
    process.stdout.write(`✔ ${number}. ${name} (${Date.now() - started} ms)\n`);
  } catch (error) {
    results.push({ caso: number, nombre: name, resultado: 'fallido', error: String(error?.stack ?? error), ms: Date.now() - started });
    process.stdout.write(`✖ ${number}. ${name}: ${error?.message ?? error}\n`);
  }
}

async function eventually(probe, { timeoutMs = 20_000, intervalMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value || Date.now() > deadline) return value;
    await delay(intervalMs);
  }
}

/** Lanza el servidor tal como lo haría el agente a partir del .mcp.json del paquete. */
async function launch({ clientInfo, onElicit = null } = {}) {
  const config = JSON.parse(await fs.readFile(path.join(mind, '.mcp.json'), 'utf8')).mcpServers.mind;
  check(config && typeof config.command === 'string', 'El .mcp.json del paquete no declara el servidor "mind".');
  const command = path.isAbsolute(config.command) ? config.command : path.join(mind, config.command);
  const client = startMcp({
    command, commandArgs: config.args ?? [], cwd: mind, env: config.env ?? {},
    clientInfo: clientInfo ?? { name: 'agente-de-prueba-A', version: '1.0' },
    onElicit,
  });
  clients.push(client);
  return client;
}

const acceptAll = (params) => (params.requestedSchema.properties.acceso
  ? { action: 'accept', content: { acceso: 'completo' } }
  : params.requestedSchema.properties.confirmar
    ? { action: 'accept', content: { confirmar: true } }
    : { action: 'accept', content: { leer: true, registrar: true } });

const names = (result) => (result.data?.resultados ?? []).map((item) => item.ruta).sort();

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'mind-producto-'));
const information = path.join(temporary, 'Información ficticia');
const base = path.join(mind, 'Base');
let session = null;
let folderId = null;
let baseId = null;

try {
  await fs.mkdir(path.join(information, 'Proyectos'), { recursive: true });
  await fs.writeFile(path.join(information, 'Proyectos', 'presupuesto-2026.md'), '# Presupuesto ficticio\nTotal aprobado: 4.250 EUR\n');
  await fs.writeFile(path.join(information, 'Proyectos', 'acta.txt'), 'Acta ficticia\nPendiente: revisar\n');
  await fs.writeFile(path.join(information, 'antiguo.txt'), 'Se eliminará con Mind cerrado\n');

  await step(1, 'Primera apertura de Mind desde un agente compatible', async () => {
    session = await launch({ onElicit: acceptAll });
    const init = await session.initialize();
    check(init.result?.serverInfo?.name === 'mind', 'El servidor no se identificó como mind.');
    check(/solicitar_acceso/.test(init.result.instructions ?? ''), 'Faltan las instrucciones para el agente.');
    const tools = (await session.request('tools/list')).result.tools.map((tool) => tool.name);
    for (const name of ['estado', 'solicitar_acceso', 'buscar', 'leer', 'crear', 'editar', 'continuidad_registrar']) {
      check(tools.includes(name), `Falta la herramienta ${name}.`);
    }
    return { protocolo: init.result.protocolVersion, herramientas: tools.length };
  });

  await step(2, 'Inicialización de la Base', async () => {
    const marker = JSON.parse(await fs.readFile(path.join(base, 'mind-base.json'), 'utf8'));
    check(marker.format === 'mind-base', 'La Base no tiene su marca de formato.');
    baseId = marker.baseId;
    const status = (await session.call('estado')).data;
    check(status.mind.producto === true, 'Mind no se reconoce en modo producto.');
    for (const runtime of [status.mind.runtime.node, status.mind.runtime.python]) {
      check(path.resolve(runtime).startsWith(mind + path.sep), `Runtime fuera del paquete: ${runtime}`);
    }
    return { base: status.mind.base, runtime: status.mind.runtime };
  });

  await step(3, 'Autorización de una carpeta de prueba', async () => {
    const inside = await session.call('solicitar_acceso', { ruta: path.join(mind, 'Motor'), acceso: 'leer' });
    check(inside.data?.error?.codigo === 'FOLDER_OVERLAPS_INTERNAL', 'Una carpeta dentro de Mind no debía poder autorizarse.');
    const granted = await session.call('solicitar_acceso', { ruta: information, acceso: 'completo', motivo: 'Prueba de producto' });
    check(granted.data.estado === 'autorizado', `Autorización: ${JSON.stringify(granted.data)}`);
    folderId = granted.data.carpeta.id;
    check(session.elicitations.length === 1, 'El usuario debía ver exactamente un formulario.');
    return { permisos: granted.data.carpeta.permisos };
  });

  await step(4, 'Indexación inicial', async () => {
    const status = await eventually(async () => {
      const value = (await session.call('estado')).data;
      return value.carpetas[0]?.indice?.estado === 'vigente' ? value : null;
    });
    check(status, 'El índice inicial no quedó vigente.');
    check(status.carpetas[0].indice.archivos === 3, `Archivos indexados: ${status.carpetas[0].indice.archivos}`);
    return status.carpetas[0].indice;
  });

  await step(5, 'Búsqueda y lectura', async () => {
    const found = await session.call('buscar', { consulta: 'presupuesto' });
    check(found.data.total === 1, `Resultados: ${found.data.total}`);
    const read = await session.call('leer', { ruta: 'Proyectos/presupuesto-2026.md' });
    check(/4\.250 EUR/.test(read.data.contenido), 'El contenido leído no es el esperado.');
    check(/^sha256:[0-9a-f]{64}$/.test(read.data.version), 'Falta la versión.');
    return { ruta_absoluta: found.data.resultados[0].ruta_absoluta };
  });

  await step(6, 'Creación y modificación', async () => {
    const created = await session.call('crear', { ruta: 'Proyectos/resumen.md', contenido: 'Total aprobado: 4.250 EUR\n' });
    check(created.data.estado === 'creado', JSON.stringify(created.data));
    check((await session.call('crear', { ruta: 'Proyectos/resumen.md', contenido: 'x' })).data.error?.codigo === 'FILE_EXISTS', 'Crear no debe sobrescribir.');
    const read = await session.call('leer', { ruta: 'Proyectos/acta.txt' });
    const edited = await session.call('editar', { ruta: 'Proyectos/acta.txt', version: read.data.version, ediciones: [{ buscar: 'Pendiente', reemplazar: 'Hecho' }] });
    check(edited.data.estado === 'modificado', JSON.stringify(edited.data));
    const stale = await session.call('modificar', { ruta: 'Proyectos/acta.txt', version: read.data.version, contenido: 'tarde' });
    check(stale.data.error?.codigo === 'VERSION_CONFLICT', 'Una versión antigua no debe escribir.');
    check(await fs.readFile(path.join(information, 'Proyectos', 'acta.txt'), 'utf8') === 'Acta ficticia\nHecho: revisar\n', 'Contenido final inesperado.');
  });

  await step(7, 'Cierre de sesión', async () => {
    const registered = await session.call('solicitar_acceso', { continuidad: ['leer', 'registrar'] });
    check(registered.data.estado === 'autorizado', JSON.stringify(registered.data));
    const decision = await session.call('continuidad_registrar', {
      tipo: 'decisión', contenido: 'El total aprobado del presupuesto 2026 es 4.250 EUR',
      referencias: [{ ubicacion: 'Proyectos/presupuesto-2026.md', relacion: 'fuente' }],
    });
    check(decision.data.estado === 'registrado', JSON.stringify(decision.data));
    const exit = await session.close();
    check(exit.code === 0, `Código de salida ${exit.code}`);
    const sessions = await fs.readdir(path.join(base, 'sesiones'));
    check(sessions.length === 0, 'Quedó un registro de sesión.');
    check(!(await fs.readdir(base)).some((entry) => entry.endsWith('.lock')), 'Quedó un bloqueo.');
    return { salida: exit.code };
  });

  await step(8, 'Cambios de archivos mientras Mind está cerrado', async () => {
    await fs.rm(path.join(information, 'antiguo.txt'));
    await fs.writeFile(path.join(information, 'nuevo-sin-mind.txt'), 'Escrito con Mind cerrado\n');
    await fs.appendFile(path.join(information, 'Proyectos', 'resumen.md'), 'Revisado sin Mind\n');
  });

  await step(9, 'Reapertura y reconciliación', async () => {
    session = await launch({ onElicit: acceptAll });
    await session.initialize();
    const marker = JSON.parse(await fs.readFile(path.join(base, 'mind-base.json'), 'utf8'));
    check(marker.baseId === baseId, 'Cambió la identidad de la Base.');
    const all = await eventually(async () => {
      const value = names(await session.call('buscar', { consulta: '' }));
      return value.includes('nuevo-sin-mind.txt') && !value.includes('antiguo.txt') ? value : null;
    });
    check(all, 'La reconciliación no recuperó los cambios.');
    const removed = await session.call('eliminados');
    check(removed.data.eliminados.some((item) => item.ruta === 'antiguo.txt'), 'El rastro no incluye lo eliminado.');
    const exit = await session.close();
    check(exit.code === 0, `Código de salida ${exit.code}`);
    return { archivos: all };
  });

  await step(10, 'Continuidad entre agentes o sesiones', async () => {
    session = await launch({ clientInfo: { name: 'agente-de-prueba-B', version: '2.0' } });
    await session.initialize();
    const found = await session.call('continuidad_consultar', { texto: 'presupuesto 2026' });
    check(found.data.total === 1, `Registros: ${found.data.total}`);
    const entry = found.data.registros[0];
    check(/agente-de-prueba-A/.test(entry.origen), 'El origen registrado no es el del primer agente.');
    check(entry.referencias[0].estado === 'existe', 'La referencia al presupuesto debía existir.');
    const exit = await session.close();
    check(exit.code === 0, `Código de salida ${exit.code}`);
    return { origen: entry.origen };
  });

  await step(11, 'Actualización del Motor conservando la Base', async () => ({
    pending: 'requiere `mind actualizar` (área de paquetes en integración)',
  }));

  await step(12, 'Restauración de un respaldo', async () => ({
    pending: 'requiere `mind respaldo` (área de respaldo en integración)',
  }));
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
  plataforma: `${process.platform}-${process.arch}`,
  superados: results.filter((item) => item.resultado === 'superado').length,
  fallidos: results.filter((item) => item.resultado === 'fallido').length,
  pendientes: results.filter((item) => item.resultado === 'pendiente').length,
  casos: results,
};
if (reportFile) await fs.writeFile(reportFile, `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`\nSuperados: ${summary.superados} · Fallidos: ${summary.fallidos} · Pendientes: ${summary.pendientes}\n`);
process.exitCode = summary.fallidos > 0 ? 1 : 0;
