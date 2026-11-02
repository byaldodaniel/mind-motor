/**
 * Proceso auxiliar: una indexación o reconciliación en un proceso nuevo, para
 * medir tiempo, CPU (propia y del auxiliar de Python) y memoria máxima de esa
 * operación sin arrastrar el estado de otras.
 * Entrada (JSON en argv[2]): { base, raiz?, carpeta? }. Con raiz y sin carpeta,
 * autoriza la carpeta en esa Base (como anfitrión) antes de indexar.
 */
import fs from 'node:fs';
import path from 'node:path';
import { cpuAhora, diferenciaCpu } from './lib/medir.mjs';

const entrada = JSON.parse(process.argv[2]);
const { openMotor } = await import('../../src/motor.js');
const motor = await openMotor({ baseDirectory: entrada.base });
const carpeta = entrada.carpeta ?? (await motor.authorizeFolder(entrada.raiz)).id;
const rssAntes = process.memoryUsage().rss;
const cpuAntes = cpuAhora();
const inicio = performance.now();
const resultado = await motor.indexFolder(carpeta);
const milisegundos = performance.now() - inicio;
const cpu = diferenciaCpu(cpuAntes, cpuAhora());
const indice = fs.statSync(path.join(motor.baseDirectory, `folder-index-${carpeta}.json`)).size;
process.stdout.write(`${JSON.stringify({
  carpeta, milisegundos, cpu, modo: resultado.mode, generacion: resultado.generation, totales: resultado.totals,
  incidencias: resultado.issues.length, cambios: resultado.changes,
  rssAntesMiB: rssAntes / 1048576, rssMaximoMiB: process.resourceUsage().maxRSS / 1024, indiceBytes: indice,
})}\n`);
