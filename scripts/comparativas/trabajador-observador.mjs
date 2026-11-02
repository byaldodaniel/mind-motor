/**
 * Proceso auxiliar del observador de índices (motor.openIndexObserver), como
 * lo abriría el anfitrión en una sesión. Fases:
 *
 *   latencia  Tras observe(), crea, modifica y elimina archivos desde fuera de
 *             Mind y mide cuánto tardan en reflejarse en el índice publicado y
 *             en ser encontrables con searchFiles.
 *   recursos  CPU (process.cpuUsage y CPU de los hijos: el auxiliar de Python)
 *             y memoria durante un reposo y durante una ráfaga de escrituras
 *             hecha por otro proceso (escritor-rafaga.mjs), coordinada por stdin.
 *
 * Entrada (JSON en argv[2]): { fase, base, carpeta, raiz, destino, ensayos, reposoMs, prefijo, cantidad, posteriorMs }.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { cpuAhora, diferenciaCpu, esperar } from './lib/medir.mjs';

const entrada = JSON.parse(process.argv[2]);
const { openMotor } = await import('../../src/motor.js');
const motor = await openMotor({ baseDirectory: entrada.base });
const informes = [];
const oyentes = new Set();
const observador = motor.openIndexObserver({
  onReport(informe) {
    const registro = {
      t: Date.now(), tipo: informe.type, motivos: informe.reasons ?? null, codigo: informe.code ?? null,
      cambios: informe.changes ? {
        added: informe.changes.added, modified: informe.changes.modified, removed: informe.changes.removed,
        renamed: informe.changes.renamed.length,
      } : null,
    };
    informes.push(registro);
    for (const oyente of oyentes) oyente(registro);
  },
});

/** Espera a un informe que cumpla la condición; devuelve su instante o null si vence. */
function esperarInforme(condicion, limiteMs = 120_000) {
  return new Promise((resolver) => {
    const reloj = setTimeout(() => {
      oyentes.delete(oyente);
      resolver(null);
    }, limiteMs);
    function oyente(registro) {
      if (!condicion(registro)) return;
      clearTimeout(reloj);
      oyentes.delete(oyente);
      resolver(registro);
    }
    oyentes.add(oyente);
  });
}

function resumenInformes(desde) {
  const lista = informes.slice(desde);
  return {
    reconciliaciones: lista.filter((item) => item.tipo === 'reconciled').length,
    motivos: [...new Set(lista.flatMap((item) => item.motivos ?? []))].sort(),
    otros: lista.filter((item) => item.tipo !== 'reconciled').map((item) => `${item.tipo}${item.codigo ? `:${item.codigo}` : ''}`),
  };
}

const inicio = performance.now();
const cpuInicio = cpuAhora();
const estado = await observador.observe(entrada.carpeta);
const observar = {
  milisegundos: performance.now() - inicio, cpu: diferenciaCpu(cpuInicio, cpuAhora()), modo: estado.mode,
  estrategia: estado.strategy, observaciones: estado.watchers,
};
const salida = { observar };

if (entrada.fase === 'latencia') {
  const ensayos = [];
  for (let k = 0; k < entrada.ensayos; k += 1) {
    // Más de minIntervalMs (2 s) desde la reconciliación anterior: se mide el caso habitual.
    await esperar(2_500);
    const relativa = `${entrada.destino}/observado-${k} Información.txt`;
    const absoluta = path.join(entrada.raiz, ...relativa.split('/'));
    const ensayo = { archivo: relativa };
    for (const [accion, aplicar, comprobar] of [
      ['alta', () => fs.writeFileSync(absoluta, 'Archivo ficticio creado fuera de Mind.\n', { flag: 'wx' }), (c) => c.added.includes(relativa)],
      ['modificacion', () => fs.appendFileSync(absoluta, 'Línea añadida fuera de Mind.\n'), (c) => c.modified.includes(relativa)],
      ['baja', () => fs.rmSync(absoluta), (c) => c.removed.includes(relativa)],
    ]) {
      if (accion !== 'alta') await esperar(2_500);
      const espera = esperarInforme((registro) => registro.tipo === 'reconciled' && registro.cambios && comprobar(registro.cambios));
      const momento = Date.now();
      aplicar();
      const informe = await espera;
      if (!informe) {
        ensayo[accion] = { publicadoMs: null };
        continue;
      }
      // Confirmación con una búsqueda real tras el informe.
      const busqueda = await motor.searchFiles({ folderIds: [entrada.carpeta], query: `observado-${k} ` });
      const encontrado = busqueda.results.some((resultado) => resultado.relativePath === relativa);
      ensayo[accion] = {
        publicadoMs: informe.t - momento, encontrableMs: Date.now() - momento,
        coherente: accion === 'baja' ? !encontrado : encontrado,
      };
    }
    ensayos.push(ensayo);
  }
  salida.ensayos = ensayos;
  salida.informes = resumenInformes(0);
} else if (entrada.fase === 'recursos') {
  await esperar(3_000);
  // Reposo: sin cambios en la carpeta.
  const desdeReposo = informes.length;
  const memoria = [];
  const muestreo = setInterval(() => memoria.push(process.memoryUsage()), 1_000);
  const cpuReposo = cpuAhora();
  await esperar(entrada.reposoMs);
  clearInterval(muestreo);
  salida.reposo = {
    milisegundos: entrada.reposoMs, cpu: diferenciaCpu(cpuReposo, cpuAhora()), ...resumenInformes(desdeReposo),
    rssMiB: { min: Math.min(...memoria.map((item) => item.rss)) / 1048576, max: Math.max(...memoria.map((item) => item.rss)) / 1048576 },
    heapMiB: { max: Math.max(...memoria.map((item) => item.heapUsed)) / 1048576 },
  };

  // Ráfaga: el proceso principal lanza el escritor cuando lee LISTO.
  const lineas = readline.createInterface({ input: process.stdin });
  const mensajes = [];
  let avisar = null;
  lineas.on('line', (linea) => {
    mensajes.push(JSON.parse(linea));
    avisar?.();
  });
  const siguienteMensaje = async () => {
    while (mensajes.length === 0) await new Promise((resolver) => { avisar = resolver; });
    avisar = null;
    return mensajes.shift();
  };
  const desdeRafaga = informes.length;
  let vistos = 0;
  const todos = esperarInforme((registro) => {
    if (registro.tipo === 'reconciled' && registro.cambios) {
      vistos += registro.cambios.added.filter((ruta) => ruta.includes(entrada.prefijo)).length;
    }
    return vistos >= entrada.cantidad;
  }, 300_000);
  const memoriaRafaga = [];
  const muestreoRafaga = setInterval(() => memoriaRafaga.push(process.memoryUsage().rss), 100);
  const cpuRafaga = cpuAhora();
  process.stdout.write('LISTO\n');
  const escritor = await siguienteMensaje();
  const ultimo = await todos;
  const busqueda = await motor.searchFiles({ folderIds: [entrada.carpeta], query: entrada.prefijo, limit: 1 });
  const encontrablesMs = Date.now() - escritor.inicio;
  const cpuHastaEncontrables = diferenciaCpu(cpuRafaga, cpuAhora());
  await esperar(entrada.posteriorMs);
  clearInterval(muestreoRafaga);
  salida.rafaga = {
    escritor, publicadasMs: ultimo ? ultimo.t - escritor.inicio : null, encontrablesMs, encontradas: busqueda.total,
    cpuHastaEncontrables, cpuConPosterior: diferenciaCpu(cpuRafaga, cpuAhora()), posteriorMs: entrada.posteriorMs,
    ...resumenInformes(desdeRafaga), rssMaximoMiB: Math.max(...memoriaRafaga) / 1048576,
  };
  lineas.close();
}

await observador.close();
salida.rssMaximoProcesoMiB = process.resourceUsage().maxRSS / 1024;
process.stdout.write(`${JSON.stringify(salida)}\n`);
