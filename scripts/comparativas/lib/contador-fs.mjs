import { createRequire, syncBuiltinESMExports } from 'node:module';

/**
 * Cuenta las llamadas a node:fs/promises de todo el proceso. Debe importarse
 * antes que los módulos del Motor (que se cargan después con import()), para
 * que sus importaciones con nombre vean las funciones instrumentadas.
 */
const require = createRequire(import.meta.url);
const promesas = require('node:fs/promises');
const NOMBRES = ['lstat', 'stat', 'readFile', 'readdir', 'opendir', 'open', 'writeFile', 'appendFile', 'rename', 'rm', 'unlink', 'mkdir', 'realpath', 'access', 'link'];

export const cuentas = Object.fromEntries(NOMBRES.map((nombre) => [nombre, 0]));
export let bytesLeidos = 0;
/** Lecturas y escrituras de más de 1 MiB: en la Base, solo los índices completos. */
export let lecturasGrandes = 0;
export let escriturasGrandes = 0;
const GRANDE = 1024 * 1024;

for (const nombre of NOMBRES) {
  const original = promesas[nombre];
  if (typeof original !== 'function') continue;
  promesas[nombre] = async function instrumentada(...argumentos) {
    cuentas[nombre] += 1;
    if (nombre === 'writeFile' && typeof argumentos[1] === 'string' && argumentos[1].length > GRANDE / 4
        && Buffer.byteLength(argumentos[1], 'utf8') > GRANDE) escriturasGrandes += 1;
    const resultado = await original.apply(this, argumentos);
    if (nombre === 'readFile') {
      const bytes = typeof resultado === 'string' ? Buffer.byteLength(resultado, 'utf8') : resultado.length;
      bytesLeidos += bytes;
      if (bytes > GRANDE) lecturasGrandes += 1;
    }
    return resultado;
  };
}
syncBuiltinESMExports();

/** Instantánea de los contadores para calcular diferencias. */
export function instantanea() {
  return { ...cuentas, bytesLeidos, lecturasGrandes, escriturasGrandes };
}

export function diferencia(antes, despues) {
  const resultado = {};
  for (const [nombre, valor] of Object.entries(despues)) {
    const delta = valor - (antes[nombre] ?? 0);
    if (delta !== 0) resultado[nombre] = delta;
  }
  return resultado;
}
