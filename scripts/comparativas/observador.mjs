import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { crearAzar } from './lib/azar.mjs';
import { carga, esperar, recursosDeProceso } from './lib/medir.mjs';
import { ejecutar } from './lib/sistema.mjs';
import { iniciarMcp } from './lib/mcp.mjs';

const OBSERVADOR = fileURLToPath(new URL('./trabajador-observador.mjs', import.meta.url));
const ESCRITOR = fileURLToPath(new URL('./escritor-rafaga.mjs', import.meta.url));
const SESION = fileURLToPath(new URL('./trabajador-sesion.mjs', import.meta.url));

function carpetasDestino(plan, cantidad, semilla) {
  const azar = crearAzar(semilla);
  const candidatas = plan.entradas.filter((entrada) => entrada.tipo === 'carpeta' && !entrada.oculta).map((entrada) => entrada.ruta);
  const elegidas = new Set();
  while (elegidas.size < Math.min(cantidad, candidatas.length)) elegidas.add(azar.elegir(candidatas));
  return [...elegidas];
}

/**
 * Recursos del observador (motor.openIndexObserver) en reposo y durante una
 * ráfaga de escrituras externas.
 */
export async function medirObservador({ plan, raiz, base, carpeta, reposoMs = 60_000, cantidad = 500, posteriorMs = 10_000, log = () => {} }) {
  log(`  observador: ${reposoMs / 1000} s de reposo y ráfaga de ${cantidad} escrituras`);
  const prefijo = 'rafaga-';
  const hijo = spawn(process.execPath, [OBSERVADOR, JSON.stringify({
    fase: 'recursos', base, carpeta, raiz, reposoMs, prefijo, cantidad, posteriorMs,
  })], { stdio: ['pipe', 'pipe', 'pipe'] });
  let error = '';
  hijo.stderr.on('data', (trozo) => { error += trozo; });
  const lineas = readline.createInterface({ input: hijo.stdout });
  const cargaAntes = carga();
  let final = null;
  for await (const linea of lineas) {
    if (linea === 'LISTO') {
      const escritor = await ejecutar(process.execPath, [ESCRITOR, JSON.stringify({
        raiz, carpetas: carpetasDestino(plan, 50, `rafaga:${plan.total}`), cantidad, prefijo,
      })]);
      if (escritor.codigo !== 0) throw new Error(`El escritor falló: ${escritor.error.slice(0, 300)}`);
      hijo.stdin.write(`${escritor.lineas.at(-1)}\n`);
    } else if (linea.startsWith('{')) {
      final = JSON.parse(linea);
    }
  }
  const salida = await new Promise((resolver) => hijo.on('close', resolver));
  if (salida !== 0 || !final) throw new Error(`El observador terminó con ${salida}: ${error.slice(0, 500)}`);
  return { ...final, carga: { inicio: cargaAntes, fin: carga() } };
}

/**
 * Sesión completa de agente: desglose del inicio en el propio proceso y
 * recursos del proceso `mind mcp` real, medidos desde fuera (/proc), en reposo
 * y tras una ráfaga.
 */
export async function medirSesionAgente({ plan, raiz, base, reposoMs = 60_000, cantidad = 500, ventanaRafagaMs = 30_000, log = () => {} }) {
  log('  sesión de agente: desglose del inicio y de las primeras búsquedas');
  const desglose = await ejecutar(process.execPath, [SESION, JSON.stringify({ base, consulta: 'informacion', llamadas: 3 })]);
  if (desglose.codigo !== 0) throw new Error(`La sesión falló: ${desglose.error.slice(0, 500)}`);
  const resultado = { inicioYBusquedas: JSON.parse(desglose.lineas.at(-1)) };

  log(`  proceso mind mcp: ${reposoMs / 1000} s de reposo y ráfaga de ${cantidad} escrituras (medido desde /proc)`);
  const cliente = iniciarMcp({ base });
  try {
    const inicio = performance.now();
    await cliente.inicializar();
    const primera = await cliente.llamar('buscar', { consulta: 'informacion', limite: 1 });
    resultado.primeraBusquedaMs = Number((performance.now() - inicio).toFixed(1));
    // Margen para que terminen las anotaciones posteriores a la reconciliación inicial.
    await esperar(5_000);
    const pid = cliente.hijo.pid;
    const antes = recursosDeProceso(pid);
    await esperar(reposoMs);
    const despues = recursosDeProceso(pid);
    resultado.reposo = antes && despues ? {
      milisegundos: reposoMs, cpuPropioMs: Number((despues.propioMs - antes.propioMs).toFixed(1)),
      cpuHijosMs: Number((despues.hijosMs - antes.hijosMs).toFixed(1)), rssMiB: Number(despues.rssMiB.toFixed(1)),
    } : null;
    const escritor = await ejecutar(process.execPath, [ESCRITOR, JSON.stringify({
      raiz, carpetas: carpetasDestino(plan, 50, `rafaga-mcp:${plan.total}`), cantidad, prefijo: 'rafagamcp-',
    })]);
    await esperar(ventanaRafagaMs);
    const tras = recursosDeProceso(pid);
    const comprobacion = await cliente.llamar('buscar', { consulta: 'rafagamcp-', limite: 1 });
    resultado.rafaga = tras && despues ? {
      escritor: JSON.parse(escritor.lineas.at(-1)), ventanaMs: ventanaRafagaMs,
      cpuPropioMs: Number((tras.propioMs - despues.propioMs).toFixed(1)), cpuHijosMs: Number((tras.hijosMs - despues.hijosMs).toFixed(1)),
      encontradas: comprobacion.datos?.total ?? null, rssMaximoMiB: Number(tras.rssMaximoMiB.toFixed(1)),
    } : null;
    resultado.primeraBusquedaError = primera.datos?.error ?? null;
  } finally {
    await cliente.cerrar();
  }
  return resultado;
}
