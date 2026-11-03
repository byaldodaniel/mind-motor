/**
 * Proceso auxiliar: inicio de una sesión de agente de Mind (la misma que abre
 * `mind mcp`: observación activa y reconciliación inicial) y primeras llamadas
 * a "buscar", en el propio proceso, para desglosar su coste: tiempo, CPU y
 * cuántas veces se lee o escribe el índice completo (> 1 MiB).
 * Entrada (JSON en argv[2]): { base, consulta, llamadas }.
 */
const entrada = JSON.parse(process.argv[2]);
const contador = await import('./lib/contador-fs.mjs');
const { cpuAhora, diferenciaCpu } = await import('./lib/medir.mjs');
const { openSession } = await import('../../src/session.js');
const { resolveLayout } = await import('../../src/layout.js');
const { createAgentTools } = await import('../../src/agent-tools.js');
const { MOTOR_VERSION } = await import('../../src/version.js');

const conexion = { clientInfo: { name: 'comparativas-mind' }, supportsFormElicitation: () => false, protocolVersion: null };
const antes = contador.instantanea();
const cpuAntes = cpuAhora();
const inicio = performance.now();
const sesion = await openSession({ layout: await resolveLayout({ base: entrada.base }), motorVersion: MOTOR_VERSION, observe: true, log: () => {} });
await sesion.start();
const herramientas = createAgentTools({ session: sesion, connection: conexion });
const llamadas = [];
for (let i = 0; i < entrada.llamadas; i += 1) {
  const previo = contador.instantanea();
  const cpuPrevia = cpuAhora();
  const t = performance.now();
  const resultado = await herramientas.call('buscar', { consulta: entrada.consulta, limite: 50 }, {});
  const delta = contador.diferencia(previo, contador.instantanea());
  llamadas.push({
    milisegundos: performance.now() - t, desdeElInicioMs: performance.now() - inicio, total: resultado.total,
    cpu: diferenciaCpu(cpuPrevia, cpuAhora()),
    lecturasDelIndice: delta.lecturasGrandes ?? 0, escriturasDelIndice: delta.escriturasGrandes ?? 0,
  });
}
// Espera a que la sesión anote lo reconciliado antes de cerrar.
for (const carpeta of await sesion.motor.listAuthorizedFolders()) await sesion.settled(carpeta.id);
const total = contador.diferencia(antes, contador.instantanea());
await sesion.close();
process.stdout.write(`${JSON.stringify({
  llamadas, cpuTotal: diferenciaCpu(cpuAntes, cpuAhora()),
  lecturasDelIndice: total.lecturasGrandes ?? 0, escriturasDelIndice: total.escriturasGrandes ?? 0,
  rssMaximoMiB: process.resourceUsage().maxRSS / 1024,
})}\n`);
