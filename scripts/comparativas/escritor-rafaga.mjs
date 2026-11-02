/**
 * Escritor externo de una ráfaga: crea N archivos nuevos repartidos entre
 * carpetas existentes, tan rápido como puede, como haría otro programa del
 * usuario. Es un proceso aparte para que su CPU no se cuente en el observador.
 * Entrada (JSON en argv[2]): { raiz, carpetas: string[], cantidad, prefijo }.
 */
import fs from 'node:fs';
import path from 'node:path';

const { raiz, carpetas, cantidad, prefijo } = JSON.parse(process.argv[2]);
const inicio = Date.now();
const reloj = performance.now();
for (let i = 0; i < cantidad; i += 1) {
  const carpeta = carpetas[i % carpetas.length];
  const nombre = `${prefijo}${String(i).padStart(4, '0')} Información.txt`;
  fs.writeFileSync(path.join(raiz, ...carpeta.split('/'), nombre), `Escritura ficticia ${i} de la ráfaga.\n`, { flag: 'wx' });
}
const cpu = process.cpuUsage();
process.stdout.write(`${JSON.stringify({ inicio, milisegundos: performance.now() - reloj, cpuMs: (cpu.user + cpu.system) / 1000 })}\n`);
