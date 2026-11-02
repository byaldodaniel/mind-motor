import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

/** Estadísticos de una serie de tiempos en milisegundos. p95 por rango más cercano. */
export function estadisticas(valores) {
  if (valores.length === 0) return null;
  const ordenados = [...valores].sort((a, b) => a - b);
  const percentil = (p) => ordenados[Math.min(ordenados.length - 1, Math.max(0, Math.ceil(p * ordenados.length) - 1))];
  const redondear = (valor) => Number(valor.toFixed(valor < 10 ? 3 : 1));
  return {
    n: ordenados.length,
    mediana: redondear(ordenados.length % 2 === 1 ? ordenados[(ordenados.length - 1) / 2]
      : (ordenados[ordenados.length / 2 - 1] + ordenados[ordenados.length / 2]) / 2),
    p95: redondear(percentil(0.95)),
    min: redondear(ordenados[0]),
    max: redondear(ordenados[ordenados.length - 1]),
  };
}

/** Ejecuta `tarea` con calentamiento y devuelve las duraciones (ms) y el último resultado. */
export async function cronometrar(tarea, { repeticiones = 10, calentamiento = 1 } = {}) {
  let resultado;
  for (let i = 0; i < calentamiento; i += 1) resultado = await tarea();
  const tiempos = [];
  for (let i = 0; i < repeticiones; i += 1) {
    const inicio = performance.now();
    resultado = await tarea();
    tiempos.push(performance.now() - inicio);
  }
  return { tiempos, resultado };
}

let tick = null;
/** Hercios del reloj de /proc (normalmente 100). */
function hercios() {
  if (tick === null) {
    const salida = spawnSync('getconf', ['CLK_TCK'], { encoding: 'utf8' });
    tick = Number(salida.stdout?.trim()) || 100;
  }
  return tick;
}

/**
 * CPU acumulada de los procesos hijos ya terminados (cutime + cstime de
 * /proc/self/stat), en ms. Solo Linux; null en otros sistemas. Resolución:
 * 1/CLK_TCK s (10 ms con 100 Hz).
 */
export function cpuHijosMs() {
  if (process.platform !== 'linux') return null;
  const texto = fs.readFileSync('/proc/self/stat', 'utf8');
  const campos = texto.slice(texto.lastIndexOf(')') + 2).split(' ');
  // Tras el nombre: estado(3) … utime(14) stime(15) cutime(16) cstime(17).
  const cutime = Number(campos[13]);
  const cstime = Number(campos[14]);
  return ((cutime + cstime) * 1000) / hercios();
}

/**
 * CPU y memoria de otro proceso por su pid (Linux): utime+stime propios,
 * cutime+cstime de sus hijos terminados, VmRSS y VmHWM. null si no se puede leer.
 */
export function recursosDeProceso(pid) {
  if (process.platform !== 'linux') return null;
  try {
    const texto = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const campos = texto.slice(texto.lastIndexOf(')') + 2).split(' ');
    const estado = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const kib = (clave) => Number(estado.match(new RegExp(`^${clave}:\\s+(\\d+) kB`, 'mu'))?.[1] ?? NaN);
    return {
      propioMs: ((Number(campos[11]) + Number(campos[12])) * 1000) / hercios(),
      hijosMs: ((Number(campos[13]) + Number(campos[14])) * 1000) / hercios(),
      rssMiB: kib('VmRSS') / 1024,
      rssMaximoMiB: kib('VmHWM') / 1024,
    };
  } catch {
    return null;
  }
}

/** CPU propia (process.cpuUsage) y de hijos terminados, en ms. */
export function cpuAhora() {
  const propio = process.cpuUsage();
  return { propioMs: (propio.user + propio.system) / 1000, hijosMs: cpuHijosMs() };
}

export function diferenciaCpu(antes, despues) {
  return {
    propioMs: Number((despues.propioMs - antes.propioMs).toFixed(1)),
    hijosMs: antes.hijosMs === null ? null : Number((despues.hijosMs - antes.hijosMs).toFixed(1)),
  };
}

export function megas(bytes) {
  return Number((bytes / (1024 * 1024)).toFixed(1));
}

/** ¿Se puede vaciar la caché de páginas del SO? Requiere root en Linux. */
export function puedeVaciarCache() {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) return false;
  try {
    fs.accessSync('/proc/sys/vm/drop_caches', fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Escribe los datos pendientes y vacía la caché de páginas, dentries e inodos. */
export function vaciarCache() {
  spawnSync('sync');
  fs.writeFileSync('/proc/sys/vm/drop_caches', '3');
}

function version(comando, argumentos, patron = /.*/u) {
  const salida = spawnSync(comando, argumentos, { encoding: 'utf8' });
  if (salida.error || salida.status !== 0) return null;
  return (salida.stdout || salida.stderr).trim().split('\n')[0].match(patron)?.[0] ?? null;
}

function sistemaDeArchivos(directorio) {
  const salida = spawnSync('df', ['-T', directorio], { encoding: 'utf8' });
  return salida.stdout?.trim().split('\n')[1]?.split(/\s+/u)[1] ?? null;
}

/** Descripción del entorno de medición. */
export function describirEntorno({ directorio, python = 'python3' } = {}) {
  let osRelease = null;
  try {
    osRelease = fs.readFileSync('/etc/os-release', 'utf8').match(/^PRETTY_NAME="?([^"\n]+)"?/mu)?.[1] ?? null;
  } catch { /* no es Linux */ }
  const cpus = os.cpus();
  return {
    fecha: new Date().toISOString(),
    cpu: cpus[0]?.model ?? null,
    nucleos: cpus.length,
    memoriaTotalMiB: Math.round(os.totalmem() / (1024 * 1024)),
    sistema: osRelease ?? `${os.type()} ${os.release()}`,
    kernel: os.release(),
    plataforma: `${process.platform}-${process.arch}`,
    virtualizacion: process.platform === 'linux' ? version('systemd-detect-virt', []) ?? version('lscpu', [], /KVM|VMware|Xen|Microsoft/u) : null,
    usuario: { uid: process.getuid?.() ?? null, nombre: os.userInfo().username },
    node: process.version,
    python: version(python, ['--version']),
    find: version('find', ['--version']),
    ripgrep: version('rg', ['--version']),
    grep: version('grep', ['--version']),
    claude: version('claude', ['--version']),
    configuracionRegional: process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG || 'POSIX (sin definir)',
    sistemaDeArchivos: directorio ? sistemaDeArchivos(directorio) : null,
    inotify: process.platform === 'linux' ? {
      maxUserWatches: Number(fs.readFileSync('/proc/sys/fs/inotify/max_user_watches', 'utf8')),
      maxQueuedEvents: Number(fs.readFileSync('/proc/sys/fs/inotify/max_queued_events', 'utf8')),
    } : null,
    cargaAlInicio: os.loadavg().map((valor) => Number(valor.toFixed(2))),
    vaciadoDeCache: puedeVaciarCache(),
  };
}

/** Carga media del sistema (1, 5, 15 min) para anotar junto a cada bloque. */
export function carga() {
  return os.loadavg().map((valor) => Number(valor.toFixed(2)));
}

export const esperar = (ms) => new Promise((resolver) => setTimeout(resolver, ms));
