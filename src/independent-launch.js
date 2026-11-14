import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';

/**
 * Lanzador independiente: enciende un proceso de Mind (el Motor Central o el
 * relevista de una actualización) que no dependa de quien lo pide.
 *
 * Un solo contrato y un mecanismo por sistema, porque el problema solo existe en
 * Windows:
 *
 * - Windows: los clientes de agentes (Codex, Claude Code…) ponen sus procesos en un
 *   Job Object que mata a todos sus descendientes al cerrarse. Un proceso
 *   desacoplado lo hereda, y la salida del job (breakaway) no está permitida.
 *   Comprobado el 14-nov-2026: al cerrar el job muere el puente y su hijo
 *   desacoplado; sobrevive el creado por el servicio del sistema (WMI,
 *   `Win32_Process.Create`), que nace fuera de todo job, en la misma sesión, con el
 *   mismo usuario y acceso a sus unidades.
 * - macOS y Linux: no hay Job Objects. Un proceso desacoplado abre una sesión nueva
 *   (setsid): no recibe las señales del grupo del cliente y queda huérfano, adoptado
 *   por init, cuando el cliente termina.
 *
 * Si el mecanismo de Windows falla (PowerShell o WMI no disponibles o bloqueados),
 * se lanza desacoplado como antes. Mind funciona igual; solo que el proceso puede
 * morir con el cliente, y así se informa (`independencia: 'heredada'`).
 */

export const LAUNCH_ENV = 'MIND_LANZAMIENTO';
const WMI_TIMEOUT_MS = 15_000;

/** Comillas de una línea de órdenes de Windows según las reglas de CommandLineToArgvW. */
export function quoteWindowsArgument(value) {
  const text = String(value);
  if (text && !/[\s"]/u.test(text)) return text;
  let out = '"', slashes = 0;
  for (const char of text) {
    if (char === '\\') { slashes++; continue; }
    if (char === '"') { out += '\\'.repeat(slashes * 2 + 1) + '"'; slashes = 0; continue; }
    out += '\\'.repeat(slashes) + char; slashes = 0;
  }
  return out + '\\'.repeat(slashes * 2) + '"';
}

export function windowsCommandLine(executable, args) {
  return [executable, ...args].map(quoteWindowsArgument).join(' ');
}

/** Qué significa cada mecanismo para la vida del proceso. */
export function independenceOf(mechanism, platform = process.platform) {
  if (mechanism === 'wmi') return 'plena';
  if (mechanism === 'sesion-nueva') return platform === 'win32' ? 'heredada' : 'plena';
  return 'desconocida';
}

// El guion es fijo; los datos viajan por una variable de entorno en JSON, nunca
// interpolados en el código de PowerShell.
const WMI_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$d = $env:MIND_LANZAR_JSON | ConvertFrom-Json',
  '$s = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0; CreateFlags = [uint32]8; EnvironmentVariables = [string[]]$d.env }',
  '$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = [string]$d.cmd; CurrentDirectory = [string]$d.cwd; ProcessStartupInformation = $s }',
  "[Console]::Out.Write((@{ codigo = [int]$r.ReturnValue; pid = [int]$r.ProcessId } | ConvertTo-Json -Compress))",
].join('\n');

function powershellExecutable(env) {
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows';
  const candidate = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return fs.existsSync(candidate) ? candidate : 'powershell.exe';
}

function environmentBlock(env) {
  return Object.entries(env)
    .filter(([key, value]) => typeof value === 'string' && key && !key.includes('=') && key !== 'MIND_LANZAR_JSON')
    .map(([key, value]) => `${key}=${value}`);
}

/** Crea el proceso mediante el servicio del sistema. Devuelve su PID o lanza. */
export function launchWithWmi({ executable, args, cwd, env, run = execFile }) {
  const payload = JSON.stringify({ cmd: windowsCommandLine(executable, args), cwd, env: environmentBlock(env) });
  const encoded = Buffer.from(WMI_SCRIPT, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    run(powershellExecutable(env), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      env: { ...env, MIND_LANZAR_JSON: payload }, windowsHide: true, timeout: WMI_TIMEOUT_MS, encoding: 'utf8', maxBuffer: 64 * 1024,
    }, (error, stdout) => {
      if (error) return reject(Object.assign(new Error(`El servicio del sistema no lanzó el proceso: ${error.message}`), { code: 'LAUNCH_WMI_FAILED' }));
      let result;
      try { result = JSON.parse(String(stdout).trim()); } catch { result = null; }
      if (result?.codigo !== 0 || !Number.isSafeInteger(result.pid) || result.pid <= 0) {
        return reject(Object.assign(new Error(`El servicio del sistema rechazó el lanzamiento (código ${result?.codigo ?? 'desconocido'}).`), { code: 'LAUNCH_WMI_FAILED' }));
      }
      resolve(result.pid);
    });
  });
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}

/**
 * Lanza `executable args` sin ventana, sin heredar la salida de quien lo pide y,
 * cuando el sistema lo permite, fuera del ciclo de vida de su cliente.
 *
 * Devuelve `{ pid, mecanismo, independencia, aviso?, exited() }`. `exited()` es null
 * mientras el proceso vive y un objeto (`{ code, signal }` o `{ error }` cuando se
 * conocen) cuando terminó; con WMI solo se conoce por su PID.
 */
export async function launchIndependent({
  executable, args = [], cwd, env = process.env, platform = process.platform,
  wmi = launchWithWmi, spawnImpl = spawn,
} = {}) {
  if (platform === 'win32' && env.MIND_LANZAMIENTO_DIRECTO !== '1') {
    try {
      const childEnv = { ...env, [LAUNCH_ENV]: 'wmi' };
      const pid = await wmi({ executable, args, cwd, env: childEnv });
      return { pid, mecanismo: 'wmi', independencia: 'plena', exited: () => (processAlive(pid) ? null : {}) };
    } catch (error) {
      return { ...detached({ executable, args, cwd, env, spawnImpl, platform }), aviso: error.message };
    }
  }
  return detached({ executable, args, cwd, env, spawnImpl, platform });
}

function detached({ executable, args, cwd, env, spawnImpl, platform }) {
  const child = spawnImpl(executable, args, {
    detached: true, windowsHide: true, cwd, stdio: 'ignore', env: { ...env, [LAUNCH_ENV]: 'sesion-nueva' },
  });
  let ended = null;
  child.once('error', (error) => { ended = { error }; });
  child.once('exit', (code, signal) => { ended ??= { code, signal }; });
  child.unref();
  return {
    pid: child.pid ?? null,
    mecanismo: 'sesion-nueva',
    independencia: independenceOf('sesion-nueva', platform),
    exited: () => ended,
  };
}
