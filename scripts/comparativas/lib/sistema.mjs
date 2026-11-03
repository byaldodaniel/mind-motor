import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

/**
 * Alternativas del sistema que usaría un agente con terminal: find y
 * ripgrep (rg --files). Se ejecutan sin shell, con argumentos explícitos.
 */

export function disponible(comando) {
  const salida = spawnSync(comando, ['--version'], { encoding: 'utf8' });
  return !salida.error && salida.status === 0;
}

/** Ejecuta un comando y devuelve stdout (líneas), duración total del proceso (ms) y código. */
export function ejecutar(comando, argumentos, { env = {}, cwd } = {}) {
  return new Promise((resolver, rechazar) => {
    const inicio = performance.now();
    const hijo = spawn(comando, argumentos, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    const partes = [];
    let error = '';
    hijo.stdout.on('data', (trozo) => partes.push(trozo));
    hijo.stderr.on('data', (trozo) => { if (error.length < 2000) error += trozo; });
    hijo.on('error', rechazar);
    hijo.on('close', (codigo) => {
      const milisegundos = performance.now() - inicio;
      const texto = Buffer.concat(partes).toString('utf8');
      resolver({ lineas: texto === '' ? [] : texto.replace(/\n$/u, '').split('\n'), milisegundos, codigo, error });
    });
  });
}

function patron(consulta) {
  // Los metacaracteres de glob no aparecen en las consultas de las comparativas.
  return `*${consulta}*`;
}

/** Instante absoluto para -newermt (segundos desde 1970 con milisegundos). */
function fechaFind(milisegundos) {
  return `@${(milisegundos / 1000).toFixed(3)}`;
}

/**
 * Argumentos de find equivalentes a una búsqueda por nombre con filtros.
 * -iname compara sin mayúsculas solo donde la configuración regional lo permite.
 */
export function argumentosFind(raiz, { consulta = '', extension = null, desde = null, hasta = null, minBytes = null }) {
  const argumentos = [raiz, '-type', 'f'];
  if (consulta) argumentos.push('-iname', patron(consulta));
  if (extension) argumentos.push('-iname', `*${extension.startsWith('.') ? extension : `.${extension}`}`);
  // -size +Nc y -newermt son estrictos (mayor que): restar 1 da "al menos" y "antes de".
  if (minBytes !== null) argumentos.push('-size', `+${minBytes - 1}c`);
  if (desde !== null) argumentos.push('-newermt', fechaFind(desde - 1));
  if (hasta !== null) argumentos.push('!', '-newermt', fechaFind(hasta - 1));
  return argumentos;
}

export function argumentosRg(raiz, { consulta = '', extension = null, ocultos = false }) {
  const argumentos = ['--files'];
  if (ocultos) argumentos.push('--hidden', '--no-ignore');
  const glob = `*${consulta}*${extension ? `${extension.startsWith('.') ? extension : `.${extension}`}` : ''}`;
  if (consulta || extension) argumentos.push('--iglob', glob.replace(/\*\*+/gu, '*'));
  argumentos.push(raiz);
  return argumentos;
}

/** Convierte rutas absolutas de la salida en rutas relativas con "/". */
export function relativas(raiz, lineas) {
  const prefijo = raiz.endsWith(path.sep) ? raiz : `${raiz}${path.sep}`;
  return lineas.filter(Boolean).map((linea) => (linea.startsWith(prefijo) ? linea.slice(prefijo.length) : linea).split(path.sep).join('/'));
}

export const LLAMADAS_FS = ['getdents64', 'openat', 'newfstatat', 'statx', 'fstat', 'lstat', 'stat', 'read', 'close'];

/**
 * Cuenta llamadas al sistema de archivos con strace -f -c (incluye procesos
 * hijos, como el auxiliar de Python de Mind). Devuelve null si no hay strace.
 */
export function contarLlamadas(comando, argumentos, { env = {}, directorioTemporal }) {
  if (!disponible('strace')) return null;
  const salida = path.join(directorioTemporal, `strace-${process.pid}-${Date.now()}.txt`);
  const resultado = spawnSync('strace', ['-f', '-c', '-o', salida, '-e', `trace=${LLAMADAS_FS.join(',')}`, comando, ...argumentos], {
    env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
  });
  if (resultado.error) return null;
  const cuentas = Object.fromEntries(LLAMADAS_FS.map((nombre) => [nombre, 0]));
  try {
    for (const linea of fs.readFileSync(salida, 'utf8').split('\n')) {
      const partes = linea.trim().split(/\s+/u);
      const nombre = partes.at(-1);
      if (partes.length >= 5 && Object.hasOwn(cuentas, nombre) && /^\d+$/u.test(partes[3])) cuentas[nombre] = Number(partes[3]);
    }
  } finally {
    fs.rmSync(salida, { force: true });
  }
  return { cuentas, codigo: resultado.status };
}

/** Resta un recuento base (arranque del proceso) a otro. */
export function restarLlamadas(total, base) {
  if (!total || !base) return null;
  const resultado = {};
  for (const nombre of LLAMADAS_FS) resultado[nombre] = Math.max(0, total.cuentas[nombre] - base.cuentas[nombre]);
  resultado.directorios = resultado.getdents64;
  resultado.metadatos = resultado.newfstatat + resultado.statx + resultado.lstat + resultado.stat + resultado.fstat;
  return resultado;
}
