import fs from 'node:fs/promises';
import path from 'node:path';
import { MotorError } from '../errors.js';
import { requireInteractive, createPrompter } from '../console.js';
import { readJson } from '../storage.js';
import { BASE_MARKER } from '../base-format.js';
import {
  createSystemScheduler, launcherCommand, displayCommand, readInstallation, writeInstallation, removeInstallation,
} from '../automations/system.js';

/**
 * mind programador instalar | estado | desinstalar
 *
 * Ejecución fuera de sesión (decisión aprobada): una entrada en el programador
 * del sistema operativo del usuario (crontab o systemd --user en Linux, un
 * LaunchAgent en macOS, el Programador de tareas en Windows) que cada 15 minutos
 * ejecuta "mind programadas" con el iniciador de la carpeta de Mind. No hay un
 * servicio propio residente ni hacen falta permisos de administrador. Instalar
 * exige la confirmación del usuario en un terminal; desinstalar, no.
 */

const USAGE = 'Uso: mind programador instalar | estado | desinstalar';

async function baseId(baseDirectory) {
  const marker = await readJson(path.join(baseDirectory, BASE_MARKER)).catch(() => null);
  const id = marker?.data?.baseId;
  if (typeof id !== 'string') throw new MotorError('BASE_NOT_FOUND', 'La Base todavía no existe: abre Mind con tu agente una vez antes de instalar el programador.');
  return id;
}

/** Núcleo probado sin terminal: el anfitrión inyecta el diálogo y el programador. */
export async function install({ layout, prompt, scheduler = createSystemScheduler() }) {
  const existing = await readInstallation(layout.baseDirectory);
  if (existing?.state === 'instalado') {
    prompt.write('El programador de Mind ya está instalado.');
    return { status: 'ya-instalado', record: existing.record };
  }
  const command = await launcherCommand(layout);
  const plan = await scheduler.plan({ baseId: await baseId(layout.baseDirectory), command });
  prompt.write('Mind ejecutará las funciones automáticas que hayas autorizado también con Mind cerrado.');
  prompt.write(`Orden: ${displayCommand(command)} (cada 15 minutos, con tu usuario, sin permisos de administrador).`);
  for (const line of plan.description ?? []) prompt.write(line);
  prompt.write('Puedes retirarlo cuando quieras con "mind programador desinstalar".');
  if (!(await prompt.yes('¿Instalar el programador de Mind?', false))) {
    prompt.write('No se instaló nada.');
    return { status: 'cancelado' };
  }
  await writeInstallation(layout.baseDirectory, { state: 'instalando', record: plan });
  const record = await scheduler.install(plan);
  await writeInstallation(layout.baseDirectory, { state: 'instalado', record, installedAt: new Date().toISOString() });
  prompt.write('Programador instalado.');
  return { status: 'instalado', record };
}

export async function uninstall({ layout, scheduler = createSystemScheduler() }) {
  const existing = await readInstallation(layout.baseDirectory);
  if (!existing) return { status: 'no-instalado' };
  const result = await scheduler.uninstall(existing.record);
  await removeInstallation(layout.baseDirectory);
  return { status: 'desinstalado', ...result };
}

export async function status({ layout, scheduler = createSystemScheduler() }) {
  const existing = await readInstallation(layout.baseDirectory);
  if (!existing) return { instalado: false, disponible: await scheduler.detect() };
  return { instalado: existing.state === 'instalado', tipo: existing.record.kind, desde: existing.installedAt, ...(await scheduler.status(existing.record)) };
}

export async function run({ parameters, layout, print }) {
  const installed = await layout();
  const [action, ...rest] = parameters;
  if (rest.length > 0) throw new MotorError('INVALID_ARGUMENTS', USAGE);
  switch (action) {
    case 'instalar': {
      requireInteractive();
      const prompt = createPrompter();
      try {
        await install({ layout: installed, prompt });
      } finally {
        prompt.close();
      }
      return 0;
    }
    case 'estado':
      print(await status({ layout: installed }));
      return 0;
    case 'desinstalar':
      print(await uninstall({ layout: installed }));
      return 0;
    default:
      throw new MotorError('INVALID_ARGUMENTS', USAGE);
  }
}

/** Para el comando "programadas" (lo ejecuta el programador del sistema): no crea una Base nueva. */
export async function baseExists(baseDirectory) {
  return fs.access(path.join(baseDirectory, BASE_MARKER)).then(() => true, () => false);
}
