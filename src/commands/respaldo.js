import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { MotorError } from '../errors.js';
import { requireInteractive, createPrompter } from '../console.js';
import { liveSessions } from '../session.js';
import {
  assertNotRestoring, canonicalBaseDirectory, checkHealthyConnector, connectorPaths, postRpc, readConsoleToken,
  restoreLockPath, stopCentralMotor,
} from '../connector.js';
import { acquireOwnerFileLock } from '../process-identity.js';
import { BASE_MARKER, BASE_FORMAT_VERSION } from '../base-format.js';
import { readJson } from '../storage.js';
import {
  prepareBackupSetup, describeBackupKey, checkRecoveryLocation, saveRecoveryFile, configureBackupDestination,
  checkBackupDestination,
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

async function withBackupWriter(baseDirectory, { rust, legacy }) {
  const base = await canonicalBaseDirectory(baseDirectory);
  await assertNotRestoring(base);
  const conn = await checkHealthyConnector(base);
  if (conn?.health?.backend === 'rust') return await rust(conn);
  // La consola de r3 conserva su flujo habitual. Si no hay conector sano,
  // la propiedad se decide por el candado, también durante un arranque.
  if (conn) return await legacy();
  let release;
  try {
    release = await acquireOwnerFileLock(connectorPaths(base).lockFile, { timeoutMs: 0 });
  } catch (error) {
    if (error.code !== 'LOCK_BUSY') throw error;
    throw fail('BASE_IN_USE', 'El propietario de la Base todavía está activo.');
  }
  try {
    await assertNotRestoring(base);
    return await legacy();
  } finally {
    await release();
  }
}

async function consoleRpc(conn, payload) {
  const consoleToken = await readConsoleToken(conn.baseDirectory);
  if (!consoleToken) {
    throw new MotorError('CONSOLE_CREDENTIAL_UNAVAILABLE', 'El Motor activo no ofrece credencial de consola.');
  }
  return await postRpc({
    port: conn.state.port,
    token: conn.token,
    headers: { 'X-Mind-Consola': consoleToken },
    payload,
  });
}

/** Configuración: frase, archivo de recuperación guardado, clave en la Base y código mostrado una vez. */
export async function configure({ prompt, baseDirectory, destination }) {
  await assertNotRestoring(baseDirectory);
  await fs.mkdir(baseDirectory, { recursive: true });
  // Rechazar destinos inválidos antes de pedir secretos o guardar la clave:
  // una configuración parcial impediría repetir esta orden con otro destino.
  destination = await checkBackupDestination({ baseDirectory, destinationDirectory: destination });
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
  await withBackupWriter(baseDirectory, {
    rust: async (conn) => prepared.commit(baseDirectory, async (keyRecord) => {
      await consoleRpc(conn, {
        accion: 'consola',
        operacion: 'respaldo_configurar',
        clave: keyRecord,
        destino: destination,
      });
    }),
    legacy: async () => {
      await prepared.commit(baseDirectory);
      await configureBackupDestination({ baseDirectory, destinationDirectory: destination });
    },
  });
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

async function ensureBaseIdleForRestore(baseDirectory) {
  if ((await liveSessions(baseDirectory)).live.length > 0) return false;
  const conn = await checkHealthyConnector(baseDirectory);
  if ((conn?.health?.sessions ?? 0) > 0 || (conn?.health?.activeRequests ?? 0) > 0) return false;
  return true;
}

/** Restaurar: nunca sobre una Base en uso ni reemplazando datos; la anterior se conserva. */
export async function restore({ prompt, baseDirectory, file, recovery, onSwap = null }) {
  const header = await inspectBackup(file);
  prompt.write(`Respaldo ${header.backupId} del ${header.createdAt} (Mind ${header.motorVersion}).`);
  const canonicalBase = await canonicalBaseDirectory(baseDirectory);
  const parentReady = await fs.stat(path.dirname(canonicalBase)).then((info) => info.isDirectory(), () => false);
  let releaseRestoreLock = null;
  if (parentReady) {
    try {
      releaseRestoreLock = await acquireOwnerFileLock(restoreLockPath(canonicalBase), { timeoutMs: 0 });
    } catch (error) {
      if (error?.code === 'LOCK_BUSY') {
        throw fail('BASE_IN_USE', 'Ya hay una restauración en curso sobre esta Base.');
      }
      throw error;
    }
  }
  try {
    const occupied = await fs.readdir(canonicalBase).then((names) => names.length > 0, () => false);
    if (occupied && !(await ensureBaseIdleForRestore(canonicalBase))) {
      throw fail('BASE_IN_USE', 'Hay agentes usando Mind: ciérralos antes de restaurar la Base.');
    }
    const suffix = `${stamp()}-${randomUUID().slice(0, 8)}`;
    const staging = occupied ? `${canonicalBase}.restaurada-${suffix}` : baseDirectory;
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
    if (!(await ensureBaseIdleForRestore(canonicalBase))) {
      throw fail('BASE_IN_USE', `Se abrió un agente mientras tanto: no se cambió nada. La copia restaurada queda en ${staging}.`);
    }
    if (await checkHealthyConnector(canonicalBase)) {
      const stopped = await stopCentralMotor({ baseDirectory: canonicalBase, onlyIfIdle: true, reason: 'restaurar-base' }).catch(() => false);
      if (!stopped) {
        throw fail('BASE_IN_USE', `No se pudo detener el Motor activo para sustituir la Base. La copia restaurada queda en ${staging}.`);
      }
    }
    const { lockFile } = connectorPaths(canonicalBase);
    let releaseBaseLock = null;
    try {
      releaseBaseLock = await acquireOwnerFileLock(lockFile, { timeoutMs: 0 });
    } catch (error) {
      if (error?.code === 'LOCK_BUSY') {
        throw fail('BASE_IN_USE', `Otro Motor tomó la Base antes de sustituirla. La copia restaurada queda en ${staging}.`);
      }
      throw error;
    }
    const previous = `${canonicalBase}.anterior-${suffix}`;
    let swapped = false;
    try {
      await fs.rename(canonicalBase, previous);
      try {
        if (onSwap) await onSwap({ baseDirectory: canonicalBase, previous, staging });
        await fs.rename(staging, canonicalBase);
        swapped = true;
      } catch (error) {
        let reverted = false;
        try {
          await fs.rename(previous, canonicalBase);
          reverted = true;
        } catch {}
        if (!reverted) {
          error.message = `${error.message} La Base anterior quedó intacta en ${previous}.`;
        }
        throw error;
      }
    } finally {
      if (swapped) {
        await fs.rm(path.join(previous, path.basename(lockFile)), { force: true }).catch(() => {});
      } else {
        await releaseBaseLock?.().catch(() => {});
      }
    }
    prompt.write(`Base restaurada. La anterior queda en ${previous} (bórrala cuando compruebes que todo está bien).`);
    return { status: 'restaurada', previous, ...restored };
  } finally {
    await releaseRestoreLock?.().catch(() => {});
  }
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
      const created = await withBackupWriter(baseDirectory, {
        rust: async (conn) => {
          const { respaldo } = await consoleRpc(conn, {
            accion: 'consola',
            operacion: 'respaldo_crear',
            ...(positional.length === 1 ? { destino: absolute(positional[0], 'la carpeta') } : {}),
          });
          return { file: respaldo.ruta, files: respaldo.archivos, createdAt: respaldo.fecha };
        },
        legacy: () => positional.length === 1
          ? createBackup({ baseDirectory, destinationDirectory: absolute(positional[0], 'la carpeta') })
          : createConfiguredBackup({ baseDirectory }),
      });
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
