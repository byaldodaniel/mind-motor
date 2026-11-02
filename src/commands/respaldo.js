import fs from 'node:fs/promises';
import path from 'node:path';
import { MotorError } from '../errors.js';
import { requireInteractive, createPrompter } from '../console.js';
import { liveSessions } from '../session.js';
import { BASE_MARKER, BASE_FORMAT_VERSION } from '../base-format.js';
import { readJson } from '../storage.js';
import {
  prepareBackupSetup, describeBackupKey, checkRecoveryLocation, saveRecoveryFile, configureBackupDestination,
  readBackupConfig, createBackup, createConfiguredBackup, listBackups, inspectBackup, verifyBackup, restoreBackup,
  PASSPHRASE_MIN_LENGTH,
} from '../backup.js';

/**
 * mind respaldo — respaldos cifrados de la Base y su recuperación (véase
 * docs/RESPALDO.md). Las operaciones que configuran o restauran, o que piden
 * una frase o el código de recuperación, exigen un terminal interactivo: los
 * secretos nunca llegan por argumentos, variables de entorno ni registros.
 *
 *   mind respaldo configurar <carpeta-de-respaldos>
 *   mind respaldo crear [<carpeta>]
 *   mind respaldo estado
 *   mind respaldo verificar <archivo> [--codigo | --archivo-recuperacion <ruta>]
 *   mind respaldo restaurar <archivo> (--codigo | --archivo-recuperacion <ruta> | --clave-local)
 */

const USAGE = `Uso:
  mind respaldo configurar <carpeta-de-respaldos>   Crea la clave, el código físico y el archivo de recuperación.
  mind respaldo crear [<carpeta>]                    Crea un respaldo cifrado (por defecto, en la carpeta configurada).
  mind respaldo estado                               Configuración, clave y respaldos existentes.
  mind respaldo verificar <archivo> [--codigo | --archivo-recuperacion <ruta>]
  mind respaldo restaurar <archivo> (--codigo | --archivo-recuperacion <ruta> | --clave-local)`;

const fail = (code, message) => new MotorError(code, message);
const absolute = (value, what) => {
  if (typeof value !== 'string' || value === '') throw fail('INVALID_ARGUMENTS', `Falta ${what}.\n${USAGE}`);
  return path.resolve(value);
};

function stamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/gu, '-').slice(0, 19);
}

/** Material de recuperación pedido sin eco; nunca por argumentos. */
async function material(prompt, flags, values, baseDirectory) {
  if (flags.has('--codigo')) return { recoveryCode: await prompt.secret('Código de recuperación (se acepta con o sin guiones): ') };
  if (flags.has('--archivo-recuperacion')) {
    const file = absolute(values.get('--archivo-recuperacion'), 'la ruta del archivo de recuperación');
    return { recoveryFile: file, passphrase: await prompt.secret('Frase del archivo de recuperación: ') };
  }
  if (flags.has('--clave-local') || flags.size === 0) return { baseDirectory };
  throw fail('INVALID_ARGUMENTS', USAGE);
}

function parse(parameters) {
  const flags = new Set();
  const values = new Map();
  const positional = [];
  for (let index = 0; index < parameters.length; index += 1) {
    const item = parameters[index];
    if (item === '--archivo-recuperacion') {
      flags.add(item);
      values.set(item, parameters[++index]);
    } else if (['--codigo', '--clave-local'].includes(item)) {
      flags.add(item);
    } else if (item.startsWith('--')) {
      throw fail('INVALID_ARGUMENTS', `Opción desconocida: ${item}\n${USAGE}`);
    } else {
      positional.push(item);
    }
  }
  if ([...flags].filter((flag) => flag !== '--clave-local').length > 1 || (flags.has('--clave-local') && flags.size > 1)) {
    throw fail('INVALID_ARGUMENTS', 'Indica una sola forma de recuperación.');
  }
  return { flags, values, positional };
}

/** Configuración: frase, archivo de recuperación guardado, clave en la Base y código mostrado una vez. */
export async function configure({ prompt, baseDirectory, destination }) {
  await fs.mkdir(baseDirectory, { recursive: true });
  if (await describeBackupKey(baseDirectory)) {
    throw fail('BACKUP_ALREADY_CONFIGURED', 'Los respaldos ya están configurados en esta Base; el código y el archivo de recuperación actuales siguen valiendo.');
  }
  prompt.write('Mind cifrará los respaldos de la Base. Podrás recuperarlos de dos formas independientes:');
  prompt.write('  1) un CÓDIGO que imprimes o escribes en papel;');
  prompt.write('  2) un ARCHIVO de recuperación protegido con una frase, que guardas separado de los respaldos.');
  prompt.write('Si pierdes los dos, nadie (tampoco Mind) podrá abrir los respaldos.');
  const recoveryDirectory = absolute(await prompt.ask('Carpeta donde guardar el archivo de recuperación (por ejemplo, una memoria USB): '), 'la carpeta del archivo de recuperación');
  await checkRecoveryLocation({ directory: recoveryDirectory, baseDirectory, destinationDirectory: destination });
  let passphrase;
  for (let attempt = 0; attempt < 3 && passphrase === undefined; attempt += 1) {
    const first = await prompt.secret(`Frase para el archivo de recuperación (mínimo ${PASSPHRASE_MIN_LENGTH} caracteres): `);
    const second = await prompt.secret('Repite la frase: ');
    if (first !== second) prompt.write('Las frases no coinciden.');
    else passphrase = first;
  }
  if (passphrase === undefined) throw fail('PASSPHRASE_MISMATCH', 'No se configuró nada: las frases no coincidieron.');
  const prepared = await prepareBackupSetup({ passphrase });
  // Primero el archivo de recuperación; solo después la clave en la Base.
  const saved = await saveRecoveryFile({ recoveryFile: prepared.recoveryFile, directory: recoveryDirectory, baseDirectory, destinationDirectory: destination });
  await prepared.commit(baseDirectory);
  await configureBackupDestination({ baseDirectory, destinationDirectory: destination });
  prompt.write('');
  prompt.write('CÓDIGO DE RECUPERACIÓN (se muestra solo esta vez; no se guarda en ningún sitio):');
  prompt.write('');
  prompt.write(`    ${prepared.recoveryCode}`);
  prompt.write('');
  prompt.write('Imprímelo o cópialo a mano y guárdalo en un lugar seguro, separado del equipo y de los respaldos.');
  const noted = await prompt.yes('¿Lo has anotado?', false);
  prompt.write(`Archivo de recuperación: ${saved}`);
  prompt.write(`Respaldos en: ${destination}`);
  if (!noted) prompt.write('Sin el código puedes recuperar con el archivo y su frase. Para tener también el código, guárdalo ahora: no volverá a mostrarse.');
  return { keyId: prepared.keyId, recoveryFile: saved, destination };
}

/** Restaurar: nunca sobre una Base en uso ni reemplazando datos; la anterior se conserva. */
export async function restore({ prompt, baseDirectory, file, recovery }) {
  const header = await inspectBackup(file);
  prompt.write(`Respaldo ${header.backupId} del ${header.createdAt} (Mind ${header.motorVersion}).`);
  const occupied = await fs.readdir(baseDirectory).then((names) => names.length > 0, () => false);
  if (occupied && (await liveSessions(baseDirectory)).length > 0) {
    throw fail('BASE_IN_USE', 'Hay agentes usando Mind: ciérralos antes de restaurar la Base.');
  }
  const staging = occupied ? `${baseDirectory}.restaurada-${stamp()}` : baseDirectory;
  const restored = await restoreBackup({ file, targetDirectory: staging, ...recovery });
  const marker = await readJson(path.join(staging, BASE_MARKER)).catch(() => null);
  const version = marker?.data?.version;
  if (Number.isSafeInteger(version) && version > BASE_FORMAT_VERSION) {
    prompt.write(`El respaldo es de una Base más reciente (formato ${version}) que este Motor (formato ${BASE_FORMAT_VERSION}).`);
    prompt.write(`Se conserva restaurado en ${staging}, sin usarlo. Actualiza Mind y vuelve a restaurar.`);
    return { status: 'incompatible', staging, ...restored };
  }
  if (!occupied) {
    prompt.write(`Base restaurada en ${baseDirectory} (${restored.files} archivos).`);
    return { status: 'restaurada', previous: null, ...restored };
  }
  prompt.write(`Restaurado en ${staging} (${restored.files} archivos, comprobado con el ${restored.method === 'codigo' ? 'código' : restored.method === 'archivo' ? 'archivo de recuperación' : 'clave local'}).`);
  if (!(await prompt.yes('¿Usarlo como Base? La Base actual se conservará aparte, sin borrarla.', false))) {
    prompt.write(`No se cambió la Base. La copia restaurada queda en ${staging}.`);
    return { status: 'preparada', staging, ...restored };
  }
  if ((await liveSessions(baseDirectory)).length > 0) throw fail('BASE_IN_USE', `Se abrió un agente mientras tanto: no se cambió nada. La copia restaurada queda en ${staging}.`);
  const previous = `${baseDirectory}.anterior-${stamp()}`;
  await fs.rename(baseDirectory, previous);
  try {
    await fs.rename(staging, baseDirectory);
  } catch (error) {
    await fs.rename(previous, baseDirectory).catch(() => {});
    throw error;
  }
  prompt.write(`Base restaurada. La anterior queda en ${previous} (bórrala cuando compruebes que todo está bien).`);
  return { status: 'restaurada', previous, ...restored };
}

export async function run({ parameters, layout, print }) {
  const [action, ...rest] = parameters;
  const installed = await layout();
  const baseDirectory = installed.baseDirectory;
  const { flags, values, positional } = parse(rest);
  switch (action) {
    case 'configurar': {
      if (positional.length !== 1) throw fail('INVALID_ARGUMENTS', USAGE);
      requireInteractive();
      const destination = absolute(positional[0], 'la carpeta de respaldos');
      const prompt = createPrompter();
      try {
        await configure({ prompt, baseDirectory, destination });
      } finally {
        prompt.close();
      }
      return 0;
    }
    case 'crear': {
      if (positional.length > 1 || flags.size > 0) throw fail('INVALID_ARGUMENTS', USAGE);
      const created = positional.length === 1
        ? await createBackup({ baseDirectory, destinationDirectory: absolute(positional[0], 'la carpeta') })
        : await createConfiguredBackup({ baseDirectory });
      print({ estado: 'creado', archivo: created.file, archivos: created.files, fecha: created.createdAt });
      return 0;
    }
    case 'estado': {
      const key = await describeBackupKey(baseDirectory);
      const config = await readBackupConfig(baseDirectory);
      const backups = config ? await listBackups(config.destination).catch(() => null) : null;
      print({
        configurado: Boolean(key), clave: key, destino: config?.destination ?? null, ultimo: config?.lastBackup ?? null,
        respaldos: backups?.map((item) => item.name) ?? null,
      });
      return 0;
    }
    case 'verificar': {
      if (positional.length !== 1) throw fail('INVALID_ARGUMENTS', USAGE);
      const file = absolute(positional[0], 'el archivo de respaldo');
      let prompt = null;
      if (flags.has('--codigo') || flags.has('--archivo-recuperacion')) {
        requireInteractive();
        prompt = createPrompter();
      }
      try {
        const verified = await verifyBackup({ file, ...(await material(prompt, flags, values, baseDirectory)) });
        print({ valido: verified.valid, metodo: verified.method, respaldo: verified.backupId, fecha: verified.createdAt, archivos: verified.files });
      } finally {
        prompt?.close();
      }
      return 0;
    }
    case 'restaurar': {
      if (positional.length !== 1 || flags.size === 0) throw fail('INVALID_ARGUMENTS', USAGE);
      requireInteractive();
      const prompt = createPrompter();
      try {
        const file = absolute(positional[0], 'el archivo de respaldo');
        await restore({ prompt, baseDirectory, file, recovery: await material(prompt, flags, values, baseDirectory) });
      } finally {
        prompt.close();
      }
      return 0;
    }
    default:
      throw fail('INVALID_ARGUMENTS', USAGE);
  }
}
