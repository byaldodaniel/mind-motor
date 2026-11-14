import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { EventEmitter } from 'node:events';
import {
  quoteWindowsArgument, windowsCommandLine, independenceOf, launchIndependent, launchWithWmi,
} from '../src/independent-launch.js';

const windows = process.platform === 'win32';

async function waitFor(file, ms = 20_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch {}
    await delay(100);
  }
  throw new Error(`No apareció ${file}`);
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

test('las comillas de Windows conservan cualquier argumento', { skip: !windows && 'solo Windows interpreta CommandLineToArgvW' }, () => {
  const values = ['simple', 'con espacio', 'C:\\Users\\Aldo Daniel\\My Mind', 'termina\\', 'comilla"dentro', 'barras\\\\"y comilla', '', 'acentos ñandú 日本語', 'C:\\ruta con espacio\\'];
  const script = 'process.stdout.write(JSON.stringify(process.argv.slice(1)))';
  // La línea citada por nosotros se entrega tal cual (como hace WMI) y debe llegar idéntica.
  const line = windowsCommandLine(process.execPath, ['-e', script, ...values]);
  const result = spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], { encoding: 'utf8', windowsVerbatimArguments: true });
  assert.deepEqual(JSON.parse(result.stdout), values);
});

test('solo el puente de un chat se aligera a un hilo de libuv', async () => {
  const { lightenBridge } = await import('../src/auto-update.js');
  const env = {};
  assert.equal(lightenBridge(['mcp'], env), true);
  assert.deepEqual(env, { UV_THREADPOOL_SIZE: '1', MIND_PUENTE_LIGERO: '1' });
  assert.equal(lightenBridge(['--carpeta', 'mcp', 'mcp'], {}), true, 'una carpeta llamada mcp no se confunde con la orden');
  assert.equal(lightenBridge(['--carpeta', 'mcp', 'estado'], {}), false);
  assert.equal(lightenBridge(['mcp', '--direct'], {}), false, 'la sesión directa trabaja con disco');
  assert.equal(lightenBridge(['motor'], {}), false);
  const chosen = { UV_THREADPOOL_SIZE: '8' };
  assert.equal(lightenBridge(['mcp'], chosen), false, 'se respeta un valor elegido por el usuario');
  assert.equal(chosen.UV_THREADPOOL_SIZE, '8');
});

test('el Motor que enciende un puente no hereda su hilo único ni su chat', async () => {
  const { ensureCentralMotor } = await import('../src/connector.js');
  const saved = { ...process.env };
  Object.assign(process.env, { UV_THREADPOOL_SIZE: '1', MIND_PUENTE_LIGERO: '1', MIND_CONEXION: '11111111-2222-4333-8444-555555555555', MIND_BRIDGE_RELAYED: '1' });
  let seen;
  try {
    await assert.rejects(ensureCentralMotor({
      baseDirectory: path.join(os.tmpdir(), `mind-sin-motor-${process.pid}`), startupTimeoutMs: 200,
      launch: async ({ env }) => { seen = env; return { pid: 1, mecanismo: 'sesion-nueva', independencia: 'plena', exited: () => ({ code: 1 }) }; },
    }));
  } finally {
    for (const key of ['UV_THREADPOOL_SIZE', 'MIND_PUENTE_LIGERO', 'MIND_CONEXION', 'MIND_BRIDGE_RELAYED']) {
      if (key in saved) process.env[key] = saved[key]; else delete process.env[key];
    }
  }
  for (const key of ['UV_THREADPOOL_SIZE', 'MIND_PUENTE_LIGERO', 'MIND_CONEXION', 'MIND_BRIDGE_RELAYED']) assert.equal(seen[key], undefined, key);
  assert.ok(seen.MIND_MOTOR_ERROR_FILE);
});

test('cita lo mínimo y escapa barras antes de comillas', () => {
  assert.equal(quoteWindowsArgument('abc'), 'abc');
  assert.equal(quoteWindowsArgument(''), '""');
  assert.equal(quoteWindowsArgument('a b'), '"a b"');
  assert.equal(quoteWindowsArgument('a\\'), 'a\\');
  assert.equal(quoteWindowsArgument('a b\\'), '"a b\\\\"');
  assert.equal(quoteWindowsArgument('a"b'), '"a\\"b"');
  assert.equal(quoteWindowsArgument('a\\"b'), '"a\\\\\\"b"');
});

test('la independencia se publica según el mecanismo y el sistema', () => {
  assert.equal(independenceOf('wmi', 'win32'), 'plena');
  assert.equal(independenceOf('sesion-nueva', 'win32'), 'heredada');
  assert.equal(independenceOf('sesion-nueva', 'linux'), 'plena');
  assert.equal(independenceOf('sesion-nueva', 'darwin'), 'plena');
  assert.equal(independenceOf('directo', 'linux'), 'desconocida');
});

function fakeSpawn(record) {
  return (executable, args, options) => {
    record.push({ executable, args, options });
    const child = new EventEmitter();
    child.pid = 4242; child.unref = () => {};
    return child;
  };
}

test('si el servicio del sistema falla, lanza desacoplado y lo dice', async () => {
  const calls = [];
  const result = await launchIndependent({
    executable: 'node', args: ['x'], cwd: os.tmpdir(), env: { A: '1' }, platform: 'win32',
    wmi: async () => { throw Object.assign(new Error('WMI bloqueado'), { code: 'LAUNCH_WMI_FAILED' }); },
    spawnImpl: fakeSpawn(calls),
  });
  assert.equal(result.mecanismo, 'sesion-nueva');
  assert.equal(result.independencia, 'heredada');
  assert.match(result.aviso, /WMI bloqueado/u);
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.env.MIND_LANZAMIENTO, 'sesion-nueva');
  assert.equal(result.exited(), null);
});

test('en macOS y Linux lanza en sesión nueva sin pasar por WMI', async () => {
  const calls = [];
  let wmiUsed = false;
  const result = await launchIndependent({
    executable: 'node', args: ['x'], cwd: '/tmp', env: {}, platform: 'linux',
    wmi: async () => { wmiUsed = true; return 1; }, spawnImpl: fakeSpawn(calls),
  });
  assert.equal(wmiUsed, false);
  assert.equal(result.independencia, 'plena');
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.stdio, 'ignore');
});

test('MIND_LANZAMIENTO_DIRECTO=1 evita el servicio del sistema', async () => {
  const calls = [];
  let wmiUsed = false;
  await launchIndependent({ executable: 'node', args: [], env: { MIND_LANZAMIENTO_DIRECTO: '1' }, platform: 'win32',
    wmi: async () => { wmiUsed = true; return 1; }, spawnImpl: fakeSpawn(calls) });
  assert.equal(wmiUsed, false);
  assert.equal(calls.length, 1);
});

test('los datos llegan a PowerShell por el entorno, nunca dentro del guion', async () => {
  let seen;
  const pid = await launchWithWmi({
    executable: 'C:\\Programa\\node.exe', args: ['a b', "x'; Remove-Item C:\\ -Recurse; '"], cwd: 'C:\\t', env: { SystemRoot: 'C:\\NoExiste', CLAVE: 'valor' },
    run: (file, args, options, callback) => { seen = { file, args, options }; callback(null, JSON.stringify({ codigo: 0, pid: 77 })); },
  });
  assert.equal(pid, 77);
  const script = Buffer.from(seen.args.at(-1), 'base64').toString('utf16le');
  assert.doesNotMatch(script, /Remove-Item/u);
  const payload = JSON.parse(seen.options.env.MIND_LANZAR_JSON);
  assert.match(payload.cmd, /Remove-Item/u);
  assert.ok(payload.env.includes('CLAVE=valor'));
  assert.ok(!payload.env.some((entry) => entry.startsWith('MIND_LANZAR_JSON=')));
});

test('un rechazo del servicio del sistema no se toma por éxito', async () => {
  await assert.rejects(launchWithWmi({ executable: 'x', args: [], cwd: 'C:\\', env: {},
    run: (_f, _a, _o, callback) => callback(null, JSON.stringify({ codigo: 9, pid: 0 })) }), { code: 'LAUNCH_WMI_FAILED' });
  await assert.rejects(launchWithWmi({ executable: 'x', args: [], cwd: 'C:\\', env: {},
    run: (_f, _a, _o, callback) => callback(new Error('sin PowerShell')) }), { code: 'LAUNCH_WMI_FAILED' });
});

test('real: el proceso lanzado recibe argumentos, entorno y carpeta, sin ventana', { timeout: 60_000 }, async (t) => {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'mind lanzar ñ '));
  t.after(() => fs.rm(work, { recursive: true, force: true }));
  const out = path.join(work, 'sonda.json');
  const script = "require('node:fs').writeFileSync(process.argv[1], JSON.stringify({ pid: process.pid, cwd: process.cwd(), marca: process.env.MIND_SONDA, lanzamiento: process.env.MIND_LANZAMIENTO, args: process.argv.slice(2) }))";
  const launched = await launchIndependent({ executable: process.execPath, args: ['-e', script, out, 'con espacio', 'comilla"'], cwd: work, env: { ...process.env, MIND_SONDA: 'sí' } });
  const seen = await waitFor(out);
  assert.equal(seen.marca, 'sí');
  assert.deepEqual(seen.args, ['con espacio', 'comilla"']);
  assert.equal(await fs.realpath(seen.cwd), await fs.realpath(work));
  assert.equal(seen.lanzamiento, launched.mecanismo);
  if (windows) assert.equal(launched.mecanismo, 'wmi', launched.aviso);
  else assert.equal(launched.independencia, 'plena');
});

// Reproduce lo que hace un cliente de agentes en Windows: su Job Object mata al
// cerrarse a todos los procesos que contiene. El Motor lanzado por Mind debe
// sobrevivir; un hijo desacoplado normal, no.
test('real: sobrevive al cierre del Job Object del cliente', { skip: !windows && 'Job Objects solo existen en Windows', timeout: 90_000 }, async (t) => {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'mind-job-'));
  t.after(() => fs.rm(work, { recursive: true, force: true }));
  const moduleUrl = new URL('../src/independent-launch.js', import.meta.url).href;
  const bridge = path.join(work, 'puente.mjs');
  await fs.writeFile(bridge, `
    import { spawn } from 'node:child_process';
    import fs from 'node:fs';
    import { launchIndependent } from ${JSON.stringify(moduleUrl)};
    const keep = ['-e', 'setTimeout(() => {}, 120000)'];
    const plain = spawn(process.execPath, keep, { detached: true, stdio: 'ignore', windowsHide: true }); plain.unref();
    const motor = await launchIndependent({ executable: process.execPath, args: keep, cwd: process.cwd(), env: process.env });
    fs.writeFileSync(process.argv[2], JSON.stringify({ puente: process.pid, desacoplado: plain.pid, motor: motor.pid, mecanismo: motor.mecanismo }));
    setTimeout(() => {}, 120000);
  `);
  const ps = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class J {
  [DllImport("kernel32.dll")] public static extern IntPtr CreateJobObject(IntPtr a, string n);
  [DllImport("kernel32.dll")] public static extern bool SetInformationJobObject(IntPtr j, int c, ref E i, uint l);
  [DllImport("kernel32.dll")] public static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint a, bool i, uint p);
  [DllImport("kernel32.dll")] public static extern uint ResumeThread(IntPtr t);
  [StructLayout(LayoutKind.Sequential)] public struct B { public long t1; public long t2; public uint Limites; public UIntPtr m1; public UIntPtr m2; public uint n1; public UIntPtr afinidad; public uint prioridad; public uint clase; }
  [StructLayout(LayoutKind.Sequential)] public struct I { public ulong io1, io2, io3, io4, io5, io6; }
  [StructLayout(LayoutKind.Sequential)] public struct E { public B Basico; public I Io; public UIntPtr p1, p2, p3, p4; }
}
'@
$job = [J]::CreateJobObject([IntPtr]::Zero, $null)
$e = New-Object J+E; $b = $e.Basico; $b.Limites = 0x2000; $e.Basico = $b
[void][J]::SetInformationJobObject($job, 9, [ref]$e, [uint32][Runtime.InteropServices.Marshal]::SizeOf([type][J+E]))
# Esta PowerShell entra al job antes de lanzar el puente: todo lo que nazca de ella queda dentro.
[void][J]::AssignProcessToJobObject($job, [J]::OpenProcess(0x1F0FFF, $false, [uint32]$PID))
$p = Start-Process -FilePath $env:MIND_NODE -ArgumentList @('"' + $env:MIND_PUENTE + '"', '"' + $env:MIND_SALIDA + '"') -PassThru -WindowStyle Hidden
$until = (Get-Date).AddSeconds(30)
while (-not (Test-Path $env:MIND_SALIDA) -and (Get-Date) -lt $until) { Start-Sleep -Milliseconds 100 }
`;
  const out = path.join(work, 'pids.json');
  // Al terminar PowerShell se cierra el último handle del job: el sistema mata lo que contiene.
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
    env: { ...process.env, MIND_NODE: process.execPath, MIND_PUENTE: bridge, MIND_SALIDA: out }, windowsHide: true, timeout: 60_000,
  });
  const pids = await waitFor(out);
  t.after(() => { for (const pid of Object.values(pids)) if (Number.isInteger(pid)) { try { process.kill(pid); } catch {} } });
  await delay(1500);
  assert.equal(pids.mecanismo, 'wmi');
  assert.equal(alive(pids.puente), false, 'el puente muere con el job');
  assert.equal(alive(pids.desacoplado), false, 'un hijo desacoplado normal muere con el job');
  assert.equal(alive(pids.motor), true, 'el proceso lanzado por Mind sobrevive');
});
