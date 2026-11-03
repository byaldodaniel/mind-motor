import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MotorError } from '../errors.js';
import { readJson, writeJson, removeJson } from '../storage.js';

/**
 * Programador del sistema operativo para ejecutar automatizaciones fuera de
 * sesión. Instala UNA sola entrada del usuario (sin administrador) que cada
 * 15 minutos ejecuta `<Mind>/mind programadas`:
 *
 * - Windows: tarea del Programador de tareas (schtasks /SC MINUTE /MO 15).
 * - macOS: LaunchAgent en ~/Library/LaunchAgents (StartInterval 900) cargado
 *   con launchctl en gui/<uid>.
 * - Linux: crontab del usuario si existe la orden; si no, temporizador de
 *   systemd --user. Sin "lingering", systemd --user solo corre con la sesión
 *   del usuario iniciada.
 *
 * Lo instalado se describe en la Base (system-scheduler.json) y desinstalar
 * retira exactamente eso. Las órdenes del sistema se invocan sin shell; para
 * las pruebas, `run` y `programs` permiten inyectar un ejecutor o una orden
 * simulada de forma explícita.
 */

export const INTERVAL_MINUTES = 15;
export const INSTALLATION_FILE = 'system-scheduler.json';
const UUID = /^[a-f0-9-]{36}$/;
const MAX_OUTPUT = 1024 * 1024;
const MAX_TASK_RUN_CHARS = 261;

const unavailable = (message) => new MotorError('SCHEDULER_UNAVAILABLE', message);
const failed = (message) => new MotorError('SCHEDULER_FAILED', message);
const already = () => new MotorError('SCHEDULER_ALREADY_INSTALLED', 'Ya existe una entrada del programador de Mind para esta Base que no figura como instalada por ella. Revísala y retírala a mano antes de instalar.');

/** Ejecuta una orden sin shell. Nunca rechaza: devuelve código, salidas o el error de arranque. */
export function runCommand(program, args, { input = null, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(program, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false });
    } catch (error) {
      resolve({ code: null, stdout: '', stderr: '', error });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ code: null, stdout, stderr, error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) });
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { if (stdout.length < MAX_OUTPUT) stdout += chunk; });
    child.stderr.on('data', (chunk) => { if (stderr.length < MAX_OUTPUT) stderr += chunk; });
    child.on('error', (error) => finish({ code: null, stdout, stderr, error }));
    child.on('close', (code) => finish({ code, stdout, stderr, error: null }));
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}

export function entryName(baseId) {
  if (typeof baseId !== 'string' || !UUID.test(baseId)) throw new MotorError('INVALID_BASE', 'La Base no tiene un identificador válido.');
  return `Mind-${baseId}`;
}

function checkCommandPart(value) {
  if (typeof value !== 'string' || value === '' || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new MotorError('SCHEDULER_PATH_INVALID', 'La ruta de Mind contiene caracteres que el programador del sistema no admite.');
  }
  return value;
}

/**
 * Orden que ejecutará el programador del sistema. En el producto, el iniciador
 * de la carpeta de Mind (src/layout.js); en desarrollo, este Node con
 * bin/mind.js y la Base indicada.
 * @returns {Promise<{ program: string, args: string[], mode: 'producto' | 'desarrollo' }>}
 */
export async function launcherCommand(layout, { baseDirectory = layout.baseDirectory, platform = process.platform, execPath = process.execPath } = {}) {
  const command = layout.product && layout.root
    ? { program: path.join(layout.root, platform === 'win32' ? 'mind.cmd' : 'mind'), args: ['programadas'], mode: 'producto' }
    : { program: execPath, args: [path.join(layout.motorDirectory, 'bin', 'mind.js'), '--base', baseDirectory, 'programadas'], mode: 'desarrollo' };
  [command.program, ...command.args].forEach(checkCommandPart);
  try {
    await fs.access(command.program);
  } catch {
    throw new MotorError('LAUNCHER_MISSING', `No se encuentra el iniciador de Mind (${command.program}). Vuelve a extraer el paquete de Mind.`);
  }
  return command;
}

export function displayCommand(command) {
  return [command.program, ...command.args].map((part) => (/[\s"'\\$`]/u.test(part) ? JSON.stringify(part) : part)).join(' ');
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const shellQuote = (value) => `'${value.replace(/'/g, "'\\''")}'`;
const systemdQuote = (value) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, '$$$$')}"`;
const windowsQuote = (value) => (/[\s"]/u.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value);
const xml = (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

async function exists(target) {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

/** Directorios de la lista que aún no existen (en orden, del más externo al más interno). */
async function missingDirectories(directories) {
  const missing = [];
  for (const directory of directories) if (!(await exists(directory))) missing.push(directory);
  return missing;
}

/** Retira solo directorios que creó la instalación y que quedaron vacíos. */
async function removeCreatedDirectories(directories) {
  const removed = [];
  for (const directory of [...directories].reverse()) {
    try {
      await fs.rmdir(directory);
      removed.push(directory);
    } catch (error) {
      if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
    }
  }
  return removed;
}

/** Escribe archivos nuevos (nunca sustituye uno existente). */
async function writeNewFiles(files) {
  const written = [];
  try {
    for (const file of files) {
      await fs.writeFile(file.path, file.content, { encoding: 'utf8', flag: 'wx', mode: file.mode ?? 0o644 });
      written.push(file.path);
    }
  } catch (error) {
    for (const item of written) await fs.rm(item, { force: true });
    if (error.code === 'EEXIST') throw already();
    throw error;
  }
}

/** Elimina un archivo instalado solo si conserva exactamente el contenido instalado. */
async function removeInstalledFile(file) {
  let text;
  try {
    text = await fs.readFile(file.path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { removed: false, warning: null };
    throw error;
  }
  if (sha256(text) !== file.sha256) {
    return { removed: false, warning: `${file.path} cambió desde la instalación; no se elimina. Revísalo a mano.` };
  }
  await fs.rm(file.path, { force: true });
  return { removed: true, warning: null };
}

function brief(result) {
  const text = `${result.stderr ?? ''}${result.stdout ?? ''}`.replace(/[\u0000-\u001f\u007f]+/gu, ' ').trim();
  return text ? `: ${text.slice(0, 200)}` : '';
}

// ------------------------------------------------------------------- crontab

function crontabBackend({ run, programs }) {
  const crontab = programs.crontab ?? 'crontab';

  async function read() {
    const result = await run(crontab, ['-l']);
    if (result.error) throw unavailable('La orden crontab no está disponible.');
    if (result.code === 0) return { exists: true, text: result.stdout };
    if (/no crontab/iu.test(result.stderr)) return { exists: false, text: '' };
    throw failed(`crontab -l terminó con código ${result.code}${brief(result)}`);
  }

  async function write(text) {
    const result = await run(crontab, ['-'], { input: text });
    if (result.error || result.code !== 0) throw failed(`No se pudo escribir el crontab${brief(result)}`);
  }

  return {
    kind: 'crontab',
    async available() {
      try {
        await read();
        return true;
      } catch {
        return false;
      }
    },
    async plan({ name, command }) {
      const current = await read();
      const lines = [
        `# ${name}: programador de Mind (lo retira "mind programador desinstalar"; no edites esta línea ni la siguiente)`,
        `*/${INTERVAL_MINUTES} * * * * ${[command.program, ...command.args].map(shellQuote).join(' ').replace(/%/g, '\\%')} >/dev/null 2>&1`,
      ];
      if (current.text.split('\n').some((line) => lines.includes(line))) throw already();
      return {
        kind: 'crontab', name, lines, createdCrontab: !current.exists,
        description: ['Dos líneas en tu crontab de usuario:', ...lines.map((line) => `  ${line}`)],
      };
    },
    async install(plan) {
      const current = await read();
      if (current.text.split('\n').some((line) => plan.lines.includes(line))) throw already();
      const base = current.text === '' || current.text.endsWith('\n') ? current.text : `${current.text}\n`;
      await write(`${base}${plan.lines.join('\n')}\n`);
      const after = (await read()).text.split('\n');
      if (!plan.lines.every((line) => after.includes(line))) throw failed('El crontab no quedó con la entrada de Mind.');
      return plan;
    },
    async status(record) {
      const lines = (await read()).text.split('\n');
      const found = record.lines.filter((line) => lines.includes(line)).length;
      return { instalado: found === record.lines.length, detalle: `${found} de ${record.lines.length} líneas de Mind en el crontab` };
    },
    async uninstall(record) {
      const current = await read();
      if (!current.exists) return { eliminado: [], avisos: ['El crontab del usuario ya no existía.'] };
      const remaining = current.text.split('\n');
      const removed = [];
      for (const target of record.lines) {
        const index = remaining.indexOf(target);
        if (index >= 0) {
          remaining.splice(index, 1);
          removed.push(target);
        }
      }
      const warnings = removed.length < record.lines.length ? ['Alguna línea instalada por Mind ya no estaba en el crontab.'] : [];
      if (removed.length === 0) return { eliminado: [], avisos: warnings };
      const text = remaining.join('\n');
      if (record.createdCrontab && text.trim() === '') {
        // El crontab no existía antes de instalar: se retira completo, como estaba.
        const result = await run(crontab, ['-r']);
        if (result.error || result.code !== 0) throw failed(`No se pudo retirar el crontab${brief(result)}`);
      } else {
        await write(text === '' || text.endsWith('\n') ? text : `${text}\n`);
      }
      return { eliminado: removed.map((line) => `crontab: ${line}`), avisos: warnings };
    },
  };
}

// ------------------------------------------------------------- systemd --user

function systemdBackend({ run, programs, homedir, env }) {
  const systemctl = programs.systemctl ?? 'systemctl';
  const configHome = typeof env.XDG_CONFIG_HOME === 'string' && path.isAbsolute(env.XDG_CONFIG_HOME)
    ? env.XDG_CONFIG_HOME : path.join(homedir, '.config');
  const unitDirectory = path.join(configHome, 'systemd', 'user');
  const ctl = (...args) => run(systemctl, ['--user', ...args]);

  return {
    kind: 'systemd',
    async available() {
      const result = await ctl('show-environment');
      return !result.error && result.code === 0;
    },
    async plan({ name, command, baseId }) {
      const unit = `mind-programadas-${baseId}`;
      const service = [
        '[Unit]',
        `Description=${name}: automatizaciones programadas de Mind`,
        '',
        '[Service]',
        'Type=oneshot',
        `ExecStart=${[command.program, ...command.args].map(systemdQuote).join(' ')}`,
        '',
      ].join('\n');
      const timer = [
        '[Unit]',
        `Description=${name}: cada ${INTERVAL_MINUTES} minutos`,
        '',
        '[Timer]',
        `OnCalendar=*:0/${INTERVAL_MINUTES}`,
        'Persistent=false',
        `Unit=${unit}.service`,
        '',
        '[Install]',
        'WantedBy=timers.target',
        '',
      ].join('\n');
      const files = [
        { path: path.join(unitDirectory, `${unit}.service`), content: service },
        { path: path.join(unitDirectory, `${unit}.timer`), content: timer },
      ];
      for (const file of files) if (await exists(file.path)) throw already();
      // timers.target.wants lo crea systemctl enable; si no existía, se retira al desinstalar si queda vacío.
      const createdDirectories = await missingDirectories([
        configHome, path.join(configHome, 'systemd'), unitDirectory, path.join(unitDirectory, 'timers.target.wants'),
      ]);
      return {
        kind: 'systemd', name, unit, timer: `${unit}.timer`,
        files: files.map((file) => ({ ...file, sha256: sha256(file.content) })), createdDirectories,
        description: [
          'Un temporizador de systemd del usuario:',
          ...files.map((file) => `  ${file.path}`),
          'Sin "lingering" (loginctl enable-linger) solo se ejecuta mientras tu sesión de usuario está iniciada.',
        ],
      };
    },
    async install(plan) {
      await fs.mkdir(unitDirectory, { recursive: true, mode: 0o755 });
      await writeNewFiles(plan.files);
      try {
        for (const args of [['daemon-reload'], ['enable', '--now', plan.timer]]) {
          const result = await ctl(...args);
          if (result.error || result.code !== 0) throw failed(`systemctl --user ${args.join(' ')} falló${brief(result)}`);
        }
      } catch (error) {
        await this.uninstall(plan).catch(() => {});
        throw error;
      }
      return plan;
    },
    async status(record) {
      const enabled = await ctl('is-enabled', record.timer);
      const files = await Promise.all(record.files.map((file) => exists(file.path)));
      const ok = !enabled.error && enabled.code === 0 && files.every(Boolean);
      return { instalado: ok, detalle: `temporizador ${record.timer}: ${enabled.stdout.trim() || 'desconocido'}` };
    },
    async uninstall(record) {
      const warnings = [];
      const removed = [];
      const disabled = await ctl('disable', '--now', record.timer);
      if (disabled.error || disabled.code !== 0) warnings.push(`systemctl --user disable ${record.timer} no confirmó${brief(disabled)}`);
      for (const file of record.files) {
        const outcome = await removeInstalledFile(file);
        if (outcome.removed) removed.push(file.path);
        if (outcome.warning) warnings.push(outcome.warning);
      }
      await ctl('daemon-reload');
      removed.push(...await removeCreatedDirectories(record.createdDirectories));
      return { eliminado: removed, avisos: warnings };
    },
  };
}

// ------------------------------------------------------------------- launchd

function launchdBackend({ run, programs, homedir, uid }) {
  const launchctl = programs.launchctl ?? 'launchctl';
  const directory = path.join(homedir, 'Library', 'LaunchAgents');
  const domain = `gui/${uid}`;

  return {
    kind: 'launchd',
    async available() {
      if (!Number.isSafeInteger(uid)) return false;
      const result = await run(launchctl, ['print', domain]);
      return !result.error && result.code === 0;
    },
    async plan({ name, command, baseId }) {
      const label = `mind.programadas.${baseId}`;
      const file = path.join(directory, `${label}.plist`);
      const content = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0">',
        '<dict>',
        `  <key>Label</key><string>${xml(label)}</string>`,
        '  <key>ProgramArguments</key>',
        '  <array>',
        ...[command.program, ...command.args].map((part) => `    <string>${xml(part)}</string>`),
        '  </array>',
        `  <key>StartInterval</key><integer>${INTERVAL_MINUTES * 60}</integer>`,
        '  <key>RunAtLoad</key><false/>',
        '  <key>ProcessType</key><string>Background</string>',
        '  <key>StandardOutPath</key><string>/dev/null</string>',
        '  <key>StandardErrorPath</key><string>/dev/null</string>',
        '</dict>',
        '</plist>',
        '',
      ].join('\n');
      if (await exists(file)) throw already();
      return {
        kind: 'launchd', name, label, domain,
        files: [{ path: file, content, sha256: sha256(content) }],
        createdDirectories: await missingDirectories([path.join(homedir, 'Library'), directory]),
        description: [`Un LaunchAgent de tu usuario (${domain}):`, `  ${file}`],
      };
    },
    async install(plan) {
      await fs.mkdir(directory, { recursive: true, mode: 0o755 });
      await writeNewFiles(plan.files);
      const result = await run(launchctl, ['bootstrap', plan.domain, plan.files[0].path]);
      if (result.error || result.code !== 0) {
        await this.uninstall(plan).catch(() => {});
        throw failed(`launchctl bootstrap ${plan.domain} falló${brief(result)}`);
      }
      return plan;
    },
    async status(record) {
      const result = await run(launchctl, ['print', `${record.domain}/${record.label}`]);
      const file = await exists(record.files[0].path);
      return { instalado: !result.error && result.code === 0 && file, detalle: `${record.label} ${result.code === 0 ? 'cargado' : 'no cargado'} en ${record.domain}` };
    },
    async uninstall(record) {
      const warnings = [];
      const removed = [];
      const loaded = await run(launchctl, ['print', `${record.domain}/${record.label}`]);
      if (!loaded.error && loaded.code === 0) {
        const result = await run(launchctl, ['bootout', `${record.domain}/${record.label}`]);
        if (result.error || result.code !== 0) warnings.push(`launchctl bootout no confirmó${brief(result)}`);
      }
      for (const file of record.files) {
        const outcome = await removeInstalledFile(file);
        if (outcome.removed) removed.push(file.path);
        if (outcome.warning) warnings.push(outcome.warning);
      }
      removed.push(...await removeCreatedDirectories(record.createdDirectories));
      return { eliminado: removed, avisos: warnings };
    },
  };
}

// ------------------------------------------------------------------ schtasks

function schtasksBackend({ run, programs }) {
  const schtasks = programs.schtasks ?? 'schtasks';
  const query = (name) => run(schtasks, ['/Query', '/TN', name]);

  return {
    kind: 'schtasks',
    async available() {
      const result = await run(schtasks, ['/?']);
      return !result.error && result.code === 0;
    },
    async plan({ name, command }) {
      const taskRun = [command.program, ...command.args].map(windowsQuote).join(' ');
      if (taskRun.length > MAX_TASK_RUN_CHARS) {
        throw new MotorError('SCHEDULER_PATH_INVALID', `La orden supera los ${MAX_TASK_RUN_CHARS} caracteres que admite el Programador de tareas: mueve Mind a una ruta más corta.`);
      }
      const existing = await query(name);
      if (!existing.error && existing.code === 0) throw already();
      return {
        kind: 'schtasks', name, taskRun,
        description: [`Una tarea de tu usuario en el Programador de tareas: «${name}», cada ${INTERVAL_MINUTES} minutos:`, `  ${taskRun}`],
      };
    },
    async install(plan) {
      const result = await run(schtasks, ['/Create', '/SC', 'MINUTE', '/MO', String(INTERVAL_MINUTES), '/TN', plan.name, '/TR', plan.taskRun, '/F']);
      if (result.error || result.code !== 0) throw failed(`schtasks /Create falló${brief(result)}`);
      return plan;
    },
    async status(record) {
      const result = await query(record.name);
      return { instalado: !result.error && result.code === 0, detalle: `tarea ${record.name}` };
    },
    async uninstall(record) {
      const present = await query(record.name);
      if (present.error || present.code !== 0) return { eliminado: [], avisos: ['La tarea ya no existía en el Programador de tareas.'] };
      const result = await run(schtasks, ['/Delete', '/TN', record.name, '/F']);
      if (result.error || result.code !== 0) throw failed(`schtasks /Delete falló${brief(result)}`);
      return { eliminado: [`tarea ${record.name}`], avisos: [] };
    },
  };
}

/**
 * @param {{ platform?: string, run?: typeof runCommand, programs?: Record<string, string>,
 *   homedir?: string, uid?: number | null, env?: NodeJS.ProcessEnv }} [options]
 *   run y programs son la inyección explícita para pruebas (orden simulada).
 */
export function createSystemScheduler({
  platform = process.platform, run = runCommand, programs = {}, homedir = os.homedir(),
  uid = typeof process.getuid === 'function' ? process.getuid() : null, env = process.env,
} = {}) {
  const backends = {
    crontab: () => crontabBackend({ run, programs }),
    systemd: () => systemdBackend({ run, programs, homedir, env }),
    launchd: () => launchdBackend({ run, programs, homedir, uid }),
    schtasks: () => schtasksBackend({ run, programs }),
  };
  const backend = (kind) => {
    if (!Object.hasOwn(backends, kind)) throw failed('Tipo de programador desconocido.');
    return backends[kind]();
  };

  /** Mecanismo disponible en este sistema, o null. */
  async function detect() {
    const candidates = platform === 'win32' ? ['schtasks'] : platform === 'darwin' ? ['launchd'] : platform === 'linux' ? ['crontab', 'systemd'] : [];
    for (const kind of candidates) {
      const item = backend(kind);
      if (await item.available()) return item;
    }
    return null;
  }

  return Object.freeze({
    platform,
    async detect() {
      return (await detect())?.kind ?? null;
    },
    /** Describe lo que se instalaría, sin cambiar nada. */
    async plan({ baseId, command }) {
      const found = await detect();
      if (!found) {
        throw unavailable(platform === 'linux'
          ? 'No hay crontab ni systemd --user disponibles para tu usuario.'
          : 'El programador del sistema no está disponible para tu usuario.');
      }
      return { ...(await found.plan({ name: entryName(baseId), command, baseId })), baseId, command: { program: command.program, args: [...command.args] } };
    },
    install: (plan) => backend(plan.kind).install(plan),
    status: (record) => backend(record.kind).status(record),
    uninstall: (record) => backend(record.kind).uninstall(record),
  });
}

// ------------------------------------------------------------ Registro en la Base

const STATES = ['instalando', 'instalado'];

export async function readInstallation(baseDirectory) {
  const stored = await readJson(path.join(baseDirectory, INSTALLATION_FILE));
  if (stored === null) return null;
  const data = stored.data;
  if (!data || data.format !== 'mind-system-scheduler' || data.version !== 1 || !STATES.includes(data.state)
      || !data.record || typeof data.record.kind !== 'string' || typeof data.record.name !== 'string') {
    throw new MotorError('SCHEDULER_RECORD_CORRUPT', 'El registro del programador del sistema no tiene el formato esperado.');
  }
  return data;
}

/** state "instalando" se escribe antes de tocar el sistema: si algo se interrumpe, desinstalar sabe qué buscar. */
export async function writeInstallation(baseDirectory, { state, record, installedAt = null }) {
  await writeJson(path.join(baseDirectory, INSTALLATION_FILE), {
    format: 'mind-system-scheduler', version: 1, state, installedAt, record,
  });
}

export function removeInstallation(baseDirectory) {
  return removeJson(path.join(baseDirectory, INSTALLATION_FILE));
}
