import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createDeflate, createInflate } from 'node:zlib';
import {
  createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual,
} from 'node:crypto';
import { MotorError } from './errors.js';
import { readJson, writeJson } from './storage.js';
import { contains } from './paths.js';
import { MOTOR_VERSION } from './version.js';

/**
 * Respaldos cifrados de la Base (véase docs/RESPALDO.md).
 *
 * Solo primitivas de node:crypto y construcciones estándar:
 * - Clave maestra K (32 bytes aleatorios) en la Base, en backup-key.json. Nunca
 *   entra en un respaldo.
 * - Cada respaldo: clave de datos DK aleatoria; la carga útil (registros de la
 *   Base y manifiesto con el SHA-256 de cada archivo) se comprime con zlib y se
 *   cifra con AES-256-GCM bajo DK. La cabecera JSON va en claro y se autentica
 *   como datos asociados (AAD) del cifrado de la carga útil.
 * - DK va envuelta con K (AES-256-GCM, como A256GCMKW de RFC 7518 §4.7) y K va
 *   envuelta con una clave derivada por scrypt (RFC 7914) del código de
 *   recuperación; ambas envolturas viajan en la cabecera.
 * - Archivo de recuperación: K envuelta con scrypt(frase) + AES-256-GCM.
 *
 * Cada envoltura usa un nonce aleatorio de 96 bits y datos asociados con su
 * propósito, para que una envoltura no pueda usarse en lugar de otra.
 *
 * API sin estado global: cada función recibe rutas absolutas.
 */

export const BACKUP_EXTENSION = '.mindbak';
export const KEY_FILE = 'backup-key.json';
export const CONFIG_FILE = 'backup-config.json';
export const PASSPHRASE_MIN_LENGTH = 12;
/** Parámetros scrypt de los respaldos y archivos de recuperación nuevos. */
export const DEFAULT_SCRYPT = Object.freeze({ N: 2 ** 17, r: 8, p: 1 });
/**
 * Opción interna, solo para pruebas: { N } reducido al crear y aceptación de N
 * reducidos al leer. Al ser un Symbol, no puede llegar desde JSON (agentes,
 * CLI ni archivos); la CLI y las herramientas nunca la pasan.
 */
export const TEST_ONLY_KDF = Symbol('mind.respaldo.kdf-solo-pruebas');

const MAGIC = Buffer.from('MINDBAK1', 'ascii');
const PREFIX_BYTES = MAGIC.length + 4;
const HEADER_MAX_BYTES = 64 * 1024;
const KEY_BYTES = 32; // AES-256
const NONCE_BYTES = 12; // 96 bits: tamaño recomendado para GCM (NIST SP 800-38D §8.2.2)
const TAG_BYTES = 16; // etiqueta completa de 128 bits
const SALT_BYTES = 32; // ≥ 128 bits (NIST SP 800-132; RFC 7914 recomienda ≥ 16 bytes)
const KEY_ID_BYTES = 16;
const CODE_SECRET_BYTES = 20; // 160 bits aleatorios
const CODE_DATA_CHARS = 32; // 160 bits / 5 bits por carácter
const CODE_CHECK_CHARS = 4; // 20 bits de SHA-256
const CODE_GROUP = 4;
const PASSPHRASE_MAX_LENGTH = 1024;
const ACCEPTED_N = Object.freeze({ min: 2 ** 17, max: 2 ** 18 });
const TEST_MIN_N = 2 ** 10;
const READ_CHUNK = 1024 * 1024;
const MAX_DEPTH = 64;
const MAX_ENTRIES = 200_000;
const MAX_TOTAL_BYTES = 32 * 1024 ** 3; // muy por debajo del límite de GCM (2^36 − 32 bytes por mensaje)
const MAX_RECORD_BYTES = 64 * 1024;
const MAX_MANIFEST_BYTES = 128 * 1024 * 1024;
const MAX_RECOVERY_FILE_BYTES = 64 * 1024;
const MAX_NAME_ATTEMPTS = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY_ID = /^[0-9a-f]{32}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TEMPORARY = /^\.mind-.*\.tmp$/u;
const BACKUP_NAME = /^mind-respaldo-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z)(?:-(\d{1,3}))?\.mindbak$/;
const NO_HARD_LINKS = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EMLINK', 'EINVAL']);
const FOLD_CASE = process.platform === 'win32' || process.platform === 'darwin';
const UTF8 = new TextDecoder('utf-8', { fatal: true });
const MOTOR_DIRECTORY = fileURLToPath(new URL('..', import.meta.url));
const scrypt = promisify(scryptCallback);

// ---------------------------------------------------------------------------
// Errores
// ---------------------------------------------------------------------------

function corrupt(detail) {
  return new MotorError('BACKUP_CORRUPT', `El respaldo está dañado, incompleto o fue alterado${detail ? ` (${detail})` : ''}.`);
}

function keyInvalid() {
  // Mismo código y mensaje para cualquier fallo de las envolturas: no revela qué parte falló.
  return new MotorError('BACKUP_KEY_INVALID', 'No se pudo abrir el respaldo con lo indicado: el código o la frase no son correctos, el archivo de recuperación o la clave pertenecen a otra configuración, o el respaldo fue alterado.');
}

function unsupported(detail) {
  return new MotorError('BACKUP_UNSUPPORTED', `El respaldo usa ${detail} que esta versión de Mind no admite. Si lo creó una versión posterior, actualiza Mind.`);
}

function notConfigured() {
  return new MotorError('BACKUP_NOT_CONFIGURED', 'Los respaldos no están configurados en esta Base. Solo el usuario puede configurarlos, con "mind respaldo configurar <carpeta-de-destino>" en un terminal.');
}

function invalidCode(message) {
  return new MotorError('RECOVERY_CODE_INVALID', message);
}

function invalidRecoveryFile(detail) {
  return new MotorError('RECOVERY_FILE_INVALID', `El archivo de recuperación no es válido${detail ? `: ${detail}` : ''}.`);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !Buffer.isBuffer(value);
}

function hasOnly(value, keys) {
  return Object.keys(value).every((key) => keys.includes(key));
}

// ---------------------------------------------------------------------------
// Primitivas: AEAD, derivación y codificaciones
// ---------------------------------------------------------------------------

/** Datos asociados con propósito: separan cada uso de AES-GCM (formato, versión, propósito, campos). */
function context(purpose, ...fields) {
  return Buffer.from(JSON.stringify(['mind-respaldo', 1, purpose, ...fields]), 'utf8');
}

function seal(key, plaintext, aad) {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { nonce, ciphertext, tag: cipher.getAuthTag() };
}

/** Devuelve el texto en claro o null si la etiqueta no coincide (sin distinguir la causa). */
function unseal(key, sealed, aad) {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, sealed.nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad);
    decipher.setAuthTag(sealed.tag);
    return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]);
  } catch {
    return null;
  }
}

function toBase64(bytes) {
  return bytes.toString('base64');
}

/** Base64 canónico y de longitud exacta; null en otro caso. */
function fromBase64(value, length) {
  if (typeof value !== 'string' || !BASE64.test(value)) return null;
  const bytes = Buffer.from(value, 'base64');
  return bytes.length === length && bytes.toString('base64') === value ? bytes : null;
}

function sealedOut({ nonce, ciphertext, tag }) {
  return { nonce: toBase64(nonce), ciphertext: toBase64(ciphertext), tag: toBase64(tag) };
}

function sealedIn(value, ciphertextLength) {
  if (!isPlainObject(value)) return null;
  const nonce = fromBase64(value.nonce, NONCE_BYTES);
  const ciphertext = fromBase64(value.ciphertext, ciphertextLength);
  const tag = fromBase64(value.tag, TAG_BYTES);
  return nonce && ciphertext && tag ? { nonce, ciphertext, tag } : null;
}

function isPowerOfTwo(value) {
  return Number.isSafeInteger(value) && value > 1 && (value & (value - 1)) === 0;
}

/** Parámetros de escritura: los predeterminados o, solo en pruebas, un N reducido. */
function writingKdf(options) {
  const weak = options?.[TEST_ONLY_KDF];
  if (weak === undefined) return { ...DEFAULT_SCRYPT };
  if (!isPlainObject(weak) || !isPowerOfTwo(weak.N) || weak.N < TEST_MIN_N || weak.N > ACCEPTED_N.max) {
    throw new MotorError('INVALID_ARGUMENTS', 'Parámetros scrypt de prueba no válidos.');
  }
  return { N: weak.N, r: DEFAULT_SCRYPT.r, p: DEFAULT_SCRYPT.p };
}

function newKdf(options) {
  return { name: 'scrypt', ...writingKdf(options), keyLength: KEY_BYTES, salt: randomBytes(SALT_BYTES) };
}

function kdfOut(kdf) {
  return { name: 'scrypt', N: kdf.N, r: kdf.r, p: kdf.p, keyLength: KEY_BYTES, salt: toBase64(kdf.salt) };
}

/** Valida la forma; null si está mal formado. Los valores no admitidos se comprueban aparte. */
function kdfIn(value) {
  if (!isPlainObject(value) || !hasOnly(value, ['name', 'N', 'r', 'p', 'keyLength', 'salt'])
      || value.name !== 'scrypt' || value.keyLength !== KEY_BYTES
      || !Number.isSafeInteger(value.N) || !Number.isSafeInteger(value.r) || !Number.isSafeInteger(value.p)) return null;
  const salt = fromBase64(value.salt, SALT_BYTES);
  return salt ? { name: 'scrypt', N: value.N, r: value.r, p: value.p, salt } : null;
}

/** Los parámetros leídos de un archivo no confiable se acotan antes de derivar (memoria y tiempo). */
function requireAcceptedKdf(kdf, options) {
  const minimum = options?.[TEST_ONLY_KDF] !== undefined ? TEST_MIN_N : ACCEPTED_N.min;
  if (!isPowerOfTwo(kdf.N) || kdf.N < minimum || kdf.N > ACCEPTED_N.max || kdf.r !== DEFAULT_SCRYPT.r || kdf.p !== DEFAULT_SCRYPT.p) {
    throw unsupported('parámetros de derivación (scrypt)');
  }
}

function kdfContext(purpose, keyId, kdf) {
  return context(purpose, keyId, kdf.N, kdf.r, kdf.p, toBase64(kdf.salt));
}

async function deriveKey(secret, kdf) {
  // OpenSSL necesita 128·r·(N + p + 2) bytes; se reserva justo eso más 1 MiB.
  const maxmem = 128 * kdf.r * (kdf.N + kdf.p + 2) + 1024 * 1024;
  return scrypt(secret, kdf.salt, KEY_BYTES, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem });
}

function encodeCrockford(bytes, bitCount) {
  let text = '';
  for (let bit = 0; bit < bitCount; bit += 5) {
    let value = 0;
    for (let offset = 0; offset < 5; offset += 1) {
      const position = bit + offset;
      const set = position < bitCount && (bytes[position >> 3] >> (7 - (position & 7))) & 1;
      value = (value << 1) | (set ? 1 : 0);
    }
    text += CROCKFORD[value];
  }
  return text;
}

function decodeCrockford(text) {
  const bytes = Buffer.alloc(Math.ceil((text.length * 5) / 8));
  let position = 0;
  for (const char of text) {
    const value = CROCKFORD.indexOf(char);
    for (let offset = 4; offset >= 0; offset -= 1) {
      if ((value >> offset) & 1) bytes[position >> 3] |= 0x80 >> (position & 7);
      position += 1;
    }
  }
  return bytes;
}

/** Grupo de verificación: los primeros 20 bits de SHA-256 del secreto, con separación de dominio. */
function codeCheck(secret) {
  const digest = createHash('sha256').update('mind-respaldo/codigo-de-recuperacion/v1\0').update(secret).digest();
  return encodeCrockford(digest, CODE_CHECK_CHARS * 5);
}

function groups(text) {
  return text.match(new RegExp(`.{1,${CODE_GROUP}}`, 'g')).join('-');
}

/** Código físico: 160 bits en base32 de Crockford, en grupos de 4, más un grupo de verificación. */
export function formatRecoveryCode(secret) {
  if (!Buffer.isBuffer(secret) || secret.length !== CODE_SECRET_BYTES) {
    throw new MotorError('INVALID_ARGUMENTS', 'El secreto del código debe tener 20 bytes.');
  }
  return groups(`${encodeCrockford(secret, CODE_SECRET_BYTES * 8)}${codeCheck(secret)}`);
}

/**
 * Normaliza un código escrito a mano: admite minúsculas, espacios, guiones y
 * las confusiones O/0 e I/L/1. Detecta longitudes incorrectas, caracteres
 * ajenos y errores de transcripción (grupo de verificación).
 * @returns {{ secret: Buffer, code: string }} El secreto y el código canónico.
 */
export function parseRecoveryCode(text) {
  if (typeof text !== 'string' || text.length > 200) throw invalidCode('Escribe el código de recuperación de 36 caracteres.');
  const compact = text.normalize('NFKC').toUpperCase()
    .replace(/[\s\-‐-―−]/gu, '')
    .replace(/O/g, '0').replace(/[IL]/g, '1');
  const foreign = [...new Set([...compact].filter((char) => !CROCKFORD.includes(char)))];
  if (foreign.length > 0) {
    throw invalidCode(`El código contiene caracteres que no forman parte de él: ${foreign.slice(0, 5).map((char) => `«${char}»`).join(', ')}.`);
  }
  const expected = CODE_DATA_CHARS + CODE_CHECK_CHARS;
  if (compact.length !== expected) {
    throw invalidCode(`El código tiene ${expected} caracteres (9 grupos de 4) y se escribieron ${compact.length}. Revisa si falta o sobra algún grupo.`);
  }
  const secret = decodeCrockford(compact.slice(0, CODE_DATA_CHARS));
  const check = Buffer.from(codeCheck(secret), 'ascii');
  if (!timingSafeEqual(check, Buffer.from(compact.slice(CODE_DATA_CHARS), 'ascii'))) {
    secret.fill(0);
    throw invalidCode('El grupo de verificación no coincide: probablemente hay un carácter mal copiado. Revisa el código con calma.');
  }
  return { secret, code: groups(compact) };
}

/** Normalización NFC sin espacios iniciales ni finales; el resto se usa tal cual. */
function passphraseBytes(passphrase, { setup }) {
  if (typeof passphrase !== 'string') throw new MotorError('PASSPHRASE_INVALID', 'La frase debe ser texto.');
  const normalized = passphrase.normalize('NFC').trim();
  const length = [...normalized].length;
  if (length > PASSPHRASE_MAX_LENGTH) {
    throw new MotorError('PASSPHRASE_INVALID', `La frase admite como máximo ${PASSPHRASE_MAX_LENGTH} caracteres.`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new MotorError('PASSPHRASE_INVALID', 'La frase no puede contener caracteres de control.');
  }
  if (length < PASSPHRASE_MIN_LENGTH) {
    // Al abrir, una frase más corta no puede ser la configurada.
    if (!setup) throw keyInvalid();
    throw new MotorError('PASSPHRASE_TOO_SHORT', `La frase debe tener al menos ${PASSPHRASE_MIN_LENGTH} caracteres. Mejor varias palabras al azar.`);
  }
  return Buffer.from(normalized, 'utf8');
}

// ---------------------------------------------------------------------------
// Rutas y escritura segura
// ---------------------------------------------------------------------------

async function motorDirectory() {
  return fs.realpath(MOTOR_DIRECTORY);
}

async function physicalBase(baseDirectory) {
  if (typeof baseDirectory !== 'string' || !path.isAbsolute(baseDirectory) || baseDirectory.includes('\0')) {
    throw new MotorError('INVALID_BASE', 'La ruta de la Base debe ser absoluta.');
  }
  let base;
  try {
    base = await fs.realpath(baseDirectory);
  } catch (error) {
    if (error.code === 'ENOENT') throw new MotorError('BASE_NOT_FOUND', 'La Base no existe.', { cause: error });
    throw error;
  }
  if (!(await fs.stat(base)).isDirectory()) throw new MotorError('INVALID_BASE', 'La Base debe ser un directorio.');
  const motor = await motorDirectory();
  if (contains(motor, base) || contains(base, motor)) {
    throw new MotorError('BASE_OVERLAPS_MOTOR', 'Motor y Base deben ser directorios independientes, sin contenerse.');
  }
  return base;
}

/** Carpeta existente, accesible y fuera de la Base y del Motor; devuelve la ruta física. */
async function physicalDestination(base, destinationDirectory) {
  if (typeof destinationDirectory !== 'string' || !path.isAbsolute(destinationDirectory) || destinationDirectory.includes('\0')) {
    throw new MotorError('BACKUP_DESTINATION_INVALID', 'Indica la ruta absoluta de la carpeta donde guardar los respaldos.');
  }
  let destination;
  try {
    destination = await fs.realpath(destinationDirectory);
    if (!(await fs.stat(destination)).isDirectory()) {
      throw new MotorError('BACKUP_DESTINATION_UNAVAILABLE', 'El destino de los respaldos debe ser una carpeta.');
    }
  } catch (error) {
    if (error instanceof MotorError) throw error;
    throw new MotorError('BACKUP_DESTINATION_UNAVAILABLE', 'El destino de los respaldos no existe o no es accesible (¿está conectado el disco?).', { cause: error });
  }
  if (contains(base, destination)) {
    throw new MotorError('BACKUP_DESTINATION_INVALID', 'El destino de los respaldos no puede estar dentro de la Base.');
  }
  if (contains(await motorDirectory(), destination)) {
    throw new MotorError('BACKUP_DESTINATION_INVALID', 'El destino de los respaldos no puede estar dentro del Motor (se sustituye al actualizar Mind).');
  }
  return destination;
}

/** Valida el destino sin guardar claves ni configuración. */
export async function checkBackupDestination({ baseDirectory, destinationDirectory }) {
  return physicalDestination(await physicalBase(baseDirectory), destinationDirectory);
}

async function writeAll(handle, buffer) {
  for (let offset = 0; offset < buffer.length;) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset);
    offset += bytesWritten;
  }
}

/** fsync del directorio para que el nombre publicado sobreviva a un corte (no existe en Windows). */
async function syncDirectory(directory) {
  if (process.platform === 'win32') return;
  let handle;
  try {
    handle = await fs.open(directory, 'r');
    await handle.sync();
  } catch {
    // Algunos sistemas de archivos no admiten fsync de directorios.
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Publica un temporal completo con un nombre nuevo, sin reemplazar nunca lo
 * existente (EEXIST). Con enlace duro es atómico; en volúmenes sin enlaces
 * duros (FAT/exFAT, algunas unidades de red o sincronizadas) se reserva el
 * nombre con una creación exclusiva y se sustituye esa reserva propia con rename.
 */
async function publishExclusive(temporary, target) {
  try {
    await fs.link(temporary, target);
    await fs.unlink(temporary).catch(() => {});
    return;
  } catch (error) {
    if (error.code === 'EEXIST' || !NO_HARD_LINKS.has(error.code)) throw error;
  }
  const reservation = await fs.open(target, 'wx', 0o600);
  const reserved = await reservation.stat({ bigint: true });
  await reservation.close();
  try {
    await fs.rename(temporary, target);
  } catch (error) {
    const current = await fs.lstat(target, { bigint: true }).catch(() => null);
    if (current && current.ino === reserved.ino && current.dev === reserved.dev) await fs.unlink(target).catch(() => {});
    throw error;
  }
}

async function readExactly(handle, position, length) {
  const buffer = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    let bytesRead;
    try {
      ({ bytesRead } = await handle.read(buffer, offset, length - offset, position + offset));
    } catch (error) {
      throw new MotorError('BACKUP_READ_FAILED', 'No se pudo leer el archivo de respaldo.', { cause: error });
    }
    if (bytesRead === 0) throw corrupt('archivo truncado');
    offset += bytesRead;
  }
  return buffer;
}

function stamp(iso) {
  return iso.slice(0, 19).replace(/:/g, '-') + 'Z';
}

// ---------------------------------------------------------------------------
// Clave maestra y configuración en la Base
// ---------------------------------------------------------------------------

function keyRecordOut({ keyId, key, codeWrap, createdAt }) {
  return {
    format: 'mind-respaldo-clave', version: 1, keyId, createdAt, key: toBase64(key),
    recoveryCode: { kdf: kdfOut(codeWrap.kdf), ...sealedOut(codeWrap.sealed) },
  };
}

function codeWrapIn(value) {
  if (!isPlainObject(value) || !hasOnly(value, ['kdf', 'nonce', 'ciphertext', 'tag'])) return null;
  const kdf = kdfIn(value.kdf);
  const sealed = sealedIn(value, KEY_BYTES);
  return kdf && sealed ? { kdf, sealed } : null;
}

async function loadKey(base) {
  let stored;
  try {
    stored = await readJson(path.join(base, KEY_FILE));
  } catch (error) {
    throw new MotorError('BACKUP_KEY_CORRUPT', 'La clave de respaldos de la Base (backup-key.json) está dañada o es un enlace; no se crean respaldos con ella.', { cause: error });
  }
  if (stored === null) throw notConfigured();
  const data = stored.data;
  const key = isPlainObject(data) ? fromBase64(data.key, KEY_BYTES) : null;
  const codeWrap = isPlainObject(data) ? codeWrapIn(data.recoveryCode) : null;
  if (!key || !codeWrap || data.format !== 'mind-respaldo-clave' || data.version !== 1
      || typeof data.keyId !== 'string' || !KEY_ID.test(data.keyId) || typeof data.createdAt !== 'string') {
    throw new MotorError('BACKUP_KEY_CORRUPT', 'La clave de respaldos de la Base (backup-key.json) no tiene el formato esperado; no se crean respaldos con ella.');
  }
  return { keyId: data.keyId, key, codeWrap, createdAt: data.createdAt };
}

/** Escribe backup-key.json sin reemplazar uno existente (BACKUP_ALREADY_CONFIGURED). */
async function writeKeyFile(directory, record) {
  const target = path.join(directory, KEY_FILE);
  const temporary = path.join(directory, `.mind-${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, `${JSON.stringify(record)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600, flush: true });
    await publishExclusive(temporary, target);
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new MotorError('BACKUP_ALREADY_CONFIGURED', 'Los respaldos ya están configurados en esta Base; el código y el archivo de recuperación actuales siguen valiendo.');
    }
    throw error;
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

/**
 * Información pública de la clave (sin la clave): null si no está configurada.
 * @returns {Promise<{ keyId: string, createdAt: string } | null>}
 */
export async function describeBackupKey(baseDirectory) {
  const base = await physicalBase(baseDirectory);
  try {
    const { keyId, createdAt, key } = await loadKey(base);
    key.fill(0);
    return { keyId, createdAt };
  } catch (error) {
    if (error.code === 'BACKUP_NOT_CONFIGURED') return null;
    throw error;
  }
}

/**
 * Prepara la configuración en memoria (K, código y archivo de recuperación) sin
 * escribir nada. commit(baseDirectory) guarda K en la Base. Así una orden puede
 * guardar antes el archivo de recuperación donde el usuario elija.
 * @param {{ passphrase: string }} options
 */
export async function prepareBackupSetup(options = {}) {
  const passphrase = passphraseBytes(options.passphrase, { setup: true });
  const key = randomBytes(KEY_BYTES);
  const keyId = randomBytes(KEY_ID_BYTES).toString('hex');
  const createdAt = new Date().toISOString();
  const secret = randomBytes(CODE_SECRET_BYTES);
  const recoveryCode = formatRecoveryCode(secret);

  const codeKdf = newKdf(options);
  const codeKey = await deriveKey(secret, codeKdf);
  const codeWrap = { kdf: codeKdf, sealed: seal(codeKey, key, kdfContext('codigo-de-recuperacion', keyId, codeKdf)) };
  const fileKdf = newKdf(options);
  const fileKey = await deriveKey(passphrase, fileKdf);
  const fileWrap = seal(fileKey, key, kdfContext('archivo-de-recuperacion', keyId, fileKdf));
  for (const buffer of [secret, codeKey, fileKey, passphrase]) buffer.fill(0);

  const recoveryFile = `${JSON.stringify({
    format: 'mind-respaldo-recuperacion', version: 1, keyId, createdAt,
    aviso: 'Archivo de recuperación de los respaldos cifrados de Mind. Con su frase permite abrir cualquier respaldo de esta configuración. Guárdalo fuera del equipo y separado de los respaldos.',
    kdf: kdfOut(fileKdf), ...sealedOut(fileWrap),
  }, null, 2)}\n`;
  let committed = false;
  return Object.freeze({
    keyId,
    recoveryCode,
    recoveryFile,
    async commit(baseDirectory) {
      if (committed) throw new MotorError('BACKUP_ALREADY_CONFIGURED', 'Esta configuración ya se guardó.');
      const base = await physicalBase(baseDirectory);
      await writeKeyFile(base, keyRecordOut({ keyId, key, codeWrap, createdAt }));
      committed = true;
      key.fill(0);
      return { keyId };
    },
  });
}

/**
 * Crea la clave maestra K en la Base. Devuelve el código físico (se muestra una
 * sola vez; no se guarda) y el contenido del archivo de recuperación.
 * @param {{ baseDirectory: string, passphrase: string }} options
 * @returns {Promise<{ recoveryCode: string, recoveryFile: string, keyId: string }>}
 */
export async function setupBackup(options = {}) {
  const base = await physicalBase(options.baseDirectory);
  if (await describeBackupKey(base)) {
    throw new MotorError('BACKUP_ALREADY_CONFIGURED', 'Los respaldos ya están configurados en esta Base; el código y el archivo de recuperación actuales siguen valiendo.');
  }
  const prepared = await prepareBackupSetup(options);
  await prepared.commit(base);
  return { recoveryCode: prepared.recoveryCode, recoveryFile: prepared.recoveryFile, keyId: prepared.keyId };
}

/**
 * Comprueba que una carpeta sirve para guardar el archivo de recuperación:
 * existe y no está dentro de la Base, del destino de los respaldos ni del Motor.
 * @returns {Promise<string>} Ruta física.
 */
export async function checkRecoveryLocation({ directory, baseDirectory, destinationDirectory = null }) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || directory.includes('\0')) {
    throw new MotorError('RECOVERY_LOCATION_INVALID', 'Indica la ruta absoluta de una carpeta existente.');
  }
  let physical;
  try {
    physical = await fs.realpath(directory);
    if (!(await fs.stat(physical)).isDirectory()) throw new Error('no es una carpeta');
  } catch (error) {
    throw new MotorError('RECOVERY_LOCATION_INVALID', 'La carpeta para el archivo de recuperación no existe o no es accesible.', { cause: error });
  }
  const base = await physicalBase(baseDirectory);
  if (contains(base, physical)) {
    throw new MotorError('RECOVERY_LOCATION_INVALID', 'El archivo de recuperación no puede guardarse dentro de la Base: quien tiene la Base ya tiene la clave.');
  }
  if (destinationDirectory !== null) {
    const destination = await fs.realpath(destinationDirectory).catch(() => path.resolve(destinationDirectory));
    if (contains(destination, physical)) {
      throw new MotorError('RECOVERY_LOCATION_INVALID', 'El archivo de recuperación no puede guardarse dentro del destino de los respaldos: debe estar separado de ellos.');
    }
  }
  if (contains(await motorDirectory(), physical)) {
    throw new MotorError('RECOVERY_LOCATION_INVALID', 'El archivo de recuperación no puede guardarse dentro del Motor (se sustituye al actualizar Mind).');
  }
  return physical;
}

/**
 * Guarda el archivo de recuperación con un nombre nuevo (nunca reemplaza),
 * modo 0600 en macOS/Linux.
 * @returns {Promise<string>} Ruta del archivo guardado.
 */
export async function saveRecoveryFile({ recoveryFile, directory, baseDirectory, destinationDirectory = null }) {
  const physical = await checkRecoveryLocation({ directory, baseDirectory, destinationDirectory });
  const parsed = parseRecoveryFileText(recoveryFile);
  const temporary = path.join(physical, `.mind-recuperacion-${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, recoveryFile, { encoding: 'utf8', flag: 'wx', mode: 0o600, flush: true });
    for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt += 1) {
      const name = `mind-recuperacion-${parsed.keyId.slice(0, 8)}${attempt === 1 ? '' : `-${attempt}`}.json`;
      try {
        await publishExclusive(temporary, path.join(physical, name));
        await syncDirectory(physical);
        return path.join(physical, name);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }
    throw new MotorError('RECOVERY_LOCATION_INVALID', 'No se encontró un nombre libre para el archivo de recuperación.');
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

function parseRecoveryFileText(text) {
  let data;
  try {
    data = typeof text === 'string' ? JSON.parse(text) : text;
  } catch {
    throw invalidRecoveryFile('no contiene JSON válido');
  }
  if (!isPlainObject(data) || data.format !== 'mind-respaldo-recuperacion') throw invalidRecoveryFile('no es un archivo de recuperación de Mind');
  if (data.version !== 1) throw unsupported('un archivo de recuperación de formato');
  const kdf = kdfIn(data.kdf);
  const sealed = sealedIn(data, KEY_BYTES);
  if (typeof data.keyId !== 'string' || !KEY_ID.test(data.keyId) || !kdf || !sealed) throw invalidRecoveryFile('faltan datos o están dañados');
  return { keyId: data.keyId, kdf, sealed };
}

/** Acepta el contenido (texto JSON u objeto) o la ruta absoluta del archivo. */
async function loadRecoveryFile(value) {
  if (isPlainObject(value)) return parseRecoveryFileText(value);
  if (typeof value !== 'string') throw invalidRecoveryFile('indica su ruta absoluta');
  if (value.trimStart().startsWith('{')) return parseRecoveryFileText(value);
  if (!path.isAbsolute(value)) throw invalidRecoveryFile('indica su ruta absoluta');
  let handle;
  try {
    handle = await fs.open(value, 'r');
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_RECOVERY_FILE_BYTES) throw invalidRecoveryFile('no es un archivo de recuperación de Mind');
    return parseRecoveryFileText(await handle.readFile('utf8'));
  } catch (error) {
    if (error instanceof MotorError) throw error;
    throw new MotorError('RECOVERY_FILE_INVALID', 'No se pudo leer el archivo de recuperación (¿existe esa ruta?).', { cause: error });
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Configuración del destino (backup-config.json): destino elegido por el
 * usuario y último respaldo creado. null si no hay configuración.
 */
export async function readBackupConfig(baseDirectory) {
  const base = await physicalBase(baseDirectory);
  let stored;
  try {
    stored = await readJson(path.join(base, CONFIG_FILE));
  } catch (error) {
    throw new MotorError('BACKUP_CONFIG_CORRUPT', 'La configuración de respaldos (backup-config.json) está dañada o es un enlace.', { cause: error });
  }
  if (stored === null) return null;
  const data = stored.data;
  const last = data?.lastBackup;
  if (!isPlainObject(data) || data.format !== 'mind-respaldo-config' || data.version !== 1
      || typeof data.destination !== 'string' || !path.isAbsolute(data.destination)
      || (last !== null && !(isPlainObject(last) && typeof last.at === 'string' && typeof last.file === 'string'))) {
    throw new MotorError('BACKUP_CONFIG_CORRUPT', 'La configuración de respaldos (backup-config.json) no tiene el formato esperado.');
  }
  return { destination: data.destination, configuredAt: data.configuredAt ?? null, lastBackup: last };
}

/**
 * Guarda el destino elegido por el usuario (ruta física). Conserva el último respaldo anotado.
 * @returns {Promise<{ destination: string }>}
 */
export async function configureBackupDestination({ baseDirectory, destinationDirectory }) {
  const base = await physicalBase(baseDirectory);
  const destination = await physicalDestination(base, destinationDirectory);
  const previous = await readBackupConfig(base).catch(() => null);
  await writeJson(path.join(base, CONFIG_FILE), {
    format: 'mind-respaldo-config', version: 1, destination,
    configuredAt: new Date().toISOString(), lastBackup: previous?.lastBackup ?? null,
  });
  return { destination };
}

async function recordLastBackup(base, created) {
  const config = await readBackupConfig(base);
  if (!config) return;
  // Si otro proceso anotó uno posterior, se conserva el más reciente.
  if (config.lastBackup && config.lastBackup.at > created.createdAt) return;
  await writeJson(path.join(base, CONFIG_FILE), {
    format: 'mind-respaldo-config', version: 1, destination: config.destination,
    configuredAt: config.configuredAt, lastBackup: { at: created.createdAt, file: created.name },
  });
}

// ---------------------------------------------------------------------------
// Contenido de la Base: recorrido, exclusiones y registros de la carga útil
// ---------------------------------------------------------------------------

/**
 * Exclusiones: temporales y bloqueos (en cualquier nivel); la clave de
 * respaldos, las sesiones vivas y las solicitudes de consentimiento (en la raíz).
 */
export function isExcludedFromBackup(name, { topLevel }) {
  if (TEMPORARY.test(name) || name.endsWith('.lock') || name.includes('.lock.abandonado-')) return true;
  return topLevel && (name === KEY_FILE || name === 'sesiones' || name === 'conector.json'
    || name === 'conector-secreto.json' || name === 'motor-central.log' || name === 'motor-central.log.1'
    || name.startsWith('consent-request-')
    || /^conversation-index\.sqlite(?:-journal|-wal|-shm)?$/.test(name));
}

function validName(name) {
  return name !== '' && name !== '.' && name !== '..' && Buffer.byteLength(name, 'utf8') <= 255
    && !/[\u0000-\u001f\u007f/\\]/u.test(name);
}

function validRelativePath(value) {
  if (typeof value !== 'string' || value === '' || Buffer.byteLength(value, 'utf8') > 4096) return false;
  const parts = value.split('/');
  return parts.length <= MAX_DEPTH && parts.every(validName);
}

function unreadable(relative, error) {
  return new MotorError('BACKUP_SOURCE_UNREADABLE', `No se pudo leer «${relative || '.'}» de la Base${error?.code ? ` (${error.code})` : ''}; no se publicó ningún respaldo.`, { cause: error });
}

/** Recorrido en preorden, ordenado y sin seguir enlaces. */
async function* walk(base, relative, stats, depth) {
  const absolute = relative === '' ? base : path.join(base, ...relative.split('/'));
  let entries;
  try {
    entries = await fs.readdir(absolute, { withFileTypes: true });
  } catch (error) {
    // Una subcarpeta retirada durante el respaldo simplemente ya no está.
    if (relative !== '' && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return;
    throw unreadable(relative, error);
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
    if (isExcludedFromBackup(entry.name, { topLevel: relative === '' })) continue;
    if (!validName(entry.name)) {
      stats.skipped.push({ path: child, reason: 'nombre-no-admitido' });
      continue;
    }
    if (entry.isSymbolicLink()) {
      stats.skipped.push({ path: child, reason: 'enlace' });
      continue;
    }
    if (entry.isDirectory()) {
      // Se comprueba de nuevo justo antes de recorrerla: no se sigue un enlace que la sustituya.
      const info = await fs.lstat(path.join(absolute, entry.name)).catch((error) => {
        if (error.code === 'ENOENT') return null;
        throw unreadable(child, error);
      });
      if (!info) continue;
      if (!info.isDirectory()) {
        stats.skipped.push({ path: child, reason: info.isSymbolicLink() ? 'enlace' : 'tipo-no-admitido' });
        continue;
      }
      if (depth + 1 >= MAX_DEPTH) throw new MotorError('BACKUP_TOO_LARGE', 'La Base tiene subcarpetas demasiado profundas para respaldarla.');
      yield { type: 'directory', path: child };
      yield* walk(base, child, stats, depth + 1);
    } else if (entry.isFile()) {
      yield { type: 'file', path: child, absolute: path.join(absolute, entry.name) };
    } else {
      stats.skipped.push({ path: child, reason: 'tipo-no-admitido' });
    }
  }
}

/** Un registro: longitud (uint32 big-endian) + JSON UTF-8. */
function frame(record, limit = MAX_RECORD_BYTES) {
  const body = Buffer.from(JSON.stringify(record), 'utf8');
  if (body.length > limit) throw new MotorError('BACKUP_TOO_LARGE', 'La Base tiene demasiadas entradas para un respaldo.');
  const head = Buffer.allocUnsafe(4);
  head.writeUInt32BE(body.length, 0);
  return Buffer.concat([head, body]);
}

/**
 * Carga útil en claro: registros de carpeta y de archivo (cabecera + contenido)
 * en preorden y, al final, el manifiesto con el SHA-256 de cada archivo. El
 * manifiesto va al final para crear el respaldo en una sola pasada.
 */
async function* payloadRecords(base, stats) {
  const entries = [];
  for await (const item of walk(base, '', stats, 0)) {
    if (entries.length >= MAX_ENTRIES) throw new MotorError('BACKUP_TOO_LARGE', 'La Base tiene demasiadas entradas para un respaldo.');
    if (item.type === 'directory') {
      entries.push({ path: item.path, type: 'directory' });
      stats.directories += 1;
      yield frame({ type: 'directory', path: item.path });
      continue;
    }
    let handle;
    try {
      handle = await fs.open(item.absolute, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    } catch (error) {
      if (error.code === 'ENOENT') continue; // retirado durante el respaldo
      if (error.code === 'ELOOP') {
        stats.skipped.push({ path: item.path, reason: 'enlace' });
        continue;
      }
      throw unreadable(item.path, error);
    }
    try {
      const info = await handle.stat();
      if (!info.isFile()) {
        stats.skipped.push({ path: item.path, reason: 'tipo-no-admitido' });
        continue;
      }
      // Los JSON de la Base se publican con rename: el descriptor conserva una versión
      // coherente. En archivos que solo crecen (auditoría) se toma el tamaño al abrir.
      const size = info.size;
      if (stats.bytes + size > MAX_TOTAL_BYTES) throw new MotorError('BACKUP_TOO_LARGE', 'La Base es demasiado grande para un respaldo.');
      yield frame({ type: 'file', path: item.path, size });
      const hash = createHash('sha256');
      for (let remaining = size; remaining > 0;) {
        const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK, remaining));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null).catch((error) => {
          throw unreadable(item.path, error);
        });
        if (bytesRead === 0) {
          throw new MotorError('BACKUP_SOURCE_CHANGED', 'Un archivo de la Base se acortó durante el respaldo; vuelve a intentarlo.');
        }
        const chunk = buffer.subarray(0, bytesRead);
        hash.update(chunk);
        remaining -= bytesRead;
        yield chunk;
      }
      entries.push({ path: item.path, type: 'file', size, sha256: hash.digest('hex') });
      stats.files += 1;
      stats.bytes += size;
    } finally {
      await handle.close();
    }
  }
  yield frame({ type: 'manifest', entries, files: stats.files, directories: stats.directories, bytes: stats.bytes }, MAX_MANIFEST_BYTES);
}

// ---------------------------------------------------------------------------
// Crear
// ---------------------------------------------------------------------------

function headerOut({ backupId, createdAt, keyId, baseId, wrappedDataKey, codeWrap, payloadNonce }) {
  return {
    format: 'mind-respaldo', version: 1, backupId, createdAt, keyId, baseId, motorVersion: MOTOR_VERSION,
    cipher: 'aes-256-gcm', compression: 'zlib',
    dataKey: sealedOut(wrappedDataKey),
    recoveryCode: { kdf: kdfOut(codeWrap.kdf), ...sealedOut(codeWrap.sealed) },
    payload: { nonce: toBase64(payloadNonce) },
  };
}

async function readBaseId(base) {
  const stored = await readJson(path.join(base, 'mind-base.json')).catch(() => null);
  const id = stored?.data?.baseId;
  return typeof id === 'string' && UUID.test(id) ? id : null;
}

function writeFailed(error) {
  if (error instanceof MotorError) return error;
  if (['EACCES', 'EPERM', 'EROFS'].includes(error?.code)) {
    return new MotorError('BACKUP_DESTINATION_UNAVAILABLE', 'No se puede escribir en el destino de los respaldos.', { cause: error });
  }
  if (error?.name === 'AbortError') return new MotorError('BACKUP_CANCELLED', 'Se canceló el respaldo; no se publicó ningún archivo.', { cause: error });
  return new MotorError('BACKUP_WRITE_FAILED', `No se pudo escribir el respaldo${error?.code ? ` (${error.code})` : ''}; no se publicó ningún archivo.`, { cause: error });
}

/**
 * Crea mind-respaldo-<fecha>.mindbak en el destino: temporal exclusivo,
 * fsync y publicación atómica sin reemplazar ningún respaldo existente.
 * @param {{ baseDirectory: string, destinationDirectory: string, signal?: AbortSignal }} options
 */
export async function createBackup({ baseDirectory, destinationDirectory, signal } = {}) {
  const base = await physicalBase(baseDirectory);
  const destination = await physicalDestination(base, destinationDirectory);
  const master = await loadKey(base);
  const backupId = randomUUID();
  const createdAt = new Date().toISOString();
  const dataKey = randomBytes(KEY_BYTES);
  const payloadNonce = randomBytes(NONCE_BYTES);
  const header = headerOut({
    backupId, createdAt, keyId: master.keyId, baseId: await readBaseId(base), payloadNonce,
    wrappedDataKey: seal(master.key, dataKey, context('clave-de-datos', master.keyId, backupId)),
    codeWrap: master.codeWrap,
  });
  master.key.fill(0);
  const headerBytes = Buffer.from(JSON.stringify(header), 'utf8');
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(headerBytes.length, 0);
  const prefix = Buffer.concat([MAGIC, length, headerBytes]);

  const temporary = path.join(destination, `.mind-respaldo-${randomUUID()}.tmp`);
  const stats = { files: 0, directories: 0, bytes: 0, skipped: [] };
  let handle = null;
  let size = prefix.length;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await writeAll(handle, prefix);
    const cipher = createCipheriv('aes-256-gcm', dataKey, payloadNonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(prefix);
    await pipeline(
      Readable.from(payloadRecords(base, stats)),
      createDeflate({ level: 6 }),
      async function encrypt(compressed) {
        for await (const chunk of compressed) {
          const encrypted = cipher.update(chunk);
          await writeAll(handle, encrypted);
          size += encrypted.length;
        }
        const tail = cipher.final();
        await writeAll(handle, tail);
        const tag = cipher.getAuthTag();
        await writeAll(handle, tag);
        size += tail.length + tag.length;
      },
      ...(signal ? [{ signal }] : []),
    );
    await handle.sync();
    await handle.close();
    handle = null;
    let name = null;
    for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS && name === null; attempt += 1) {
      const candidate = `mind-respaldo-${stamp(createdAt)}${attempt === 1 ? '' : `-${attempt}`}${BACKUP_EXTENSION}`;
      try {
        await publishExclusive(temporary, path.join(destination, candidate));
        name = candidate;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }
    if (name === null) throw new MotorError('BACKUP_WRITE_FAILED', 'No se encontró un nombre libre para el respaldo.');
    await syncDirectory(destination);
    return {
      file: path.join(destination, name), name, destination, backupId, createdAt, keyId: master.keyId,
      files: stats.files, directories: stats.directories, bytes: stats.bytes, size, skipped: stats.skipped,
    };
  } catch (error) {
    throw writeFailed(error);
  } finally {
    dataKey.fill(0);
    await handle?.close().catch(() => {});
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

/**
 * Crea un respaldo en el destino configurado por el usuario y anota la fecha.
 * Es lo que usan la orden "crear", la herramienta de agente y las automatizaciones.
 */
export async function createConfiguredBackup({ baseDirectory, signal } = {}) {
  const base = await physicalBase(baseDirectory);
  const config = await readBackupConfig(base);
  if (!config) throw notConfigured();
  const created = await createBackup({ baseDirectory: base, destinationDirectory: config.destination, signal });
  await recordLastBackup(base, created);
  return created;
}

/** Respaldos de un destino, del más antiguo al más reciente según su nombre. */
export async function listBackups(destinationDirectory) {
  const entries = await fs.readdir(destinationDirectory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && BACKUP_NAME.test(entry.name))
    .map((entry) => {
      const [, when, suffix] = BACKUP_NAME.exec(entry.name);
      return { name: entry.name, file: path.join(destinationDirectory, entry.name), when, order: Number(suffix ?? 1) };
    })
    .sort((a, b) => (a.when < b.when ? -1 : a.when > b.when ? 1 : a.order - b.order))
    .map(({ name, file }) => ({ name, file }));
}

// ---------------------------------------------------------------------------
// Leer: cabecera, desbloqueo y carga útil
// ---------------------------------------------------------------------------

function parseHeader(bytes) {
  let header;
  try {
    header = JSON.parse(UTF8.decode(bytes));
  } catch {
    throw corrupt('cabecera ilegible');
  }
  if (!isPlainObject(header) || header.format !== 'mind-respaldo') throw corrupt('no es un respaldo de Mind');
  if (header.version !== 1) throw unsupported('un formato de respaldo');
  if (header.cipher !== 'aes-256-gcm' || header.compression !== 'zlib') throw unsupported('un cifrado o una compresión');
  const keys = ['format', 'version', 'backupId', 'createdAt', 'keyId', 'baseId', 'motorVersion', 'cipher', 'compression', 'dataKey', 'recoveryCode', 'payload'];
  const dataKey = sealedIn(header.dataKey, KEY_BYTES);
  const recoveryCode = codeWrapIn(header.recoveryCode);
  const payloadNonce = isPlainObject(header.payload) && hasOnly(header.payload, ['nonce']) ? fromBase64(header.payload.nonce, NONCE_BYTES) : null;
  if (!hasOnly(header, keys) || typeof header.backupId !== 'string' || !UUID.test(header.backupId)
      || typeof header.createdAt !== 'string' || !Number.isFinite(Date.parse(header.createdAt))
      || typeof header.keyId !== 'string' || !KEY_ID.test(header.keyId)
      || !(header.baseId === null || (typeof header.baseId === 'string' && UUID.test(header.baseId)))
      || !(header.motorVersion === null || (typeof header.motorVersion === 'string' && header.motorVersion.length <= 64))
      || !dataKey || !recoveryCode || !payloadNonce) {
    throw corrupt('cabecera no válida');
  }
  return {
    backupId: header.backupId, createdAt: header.createdAt, keyId: header.keyId, baseId: header.baseId,
    motorVersion: header.motorVersion, dataKey, recoveryCode, payloadNonce,
  };
}

async function openBackup(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0')) {
    throw new MotorError('BACKUP_FILE_INVALID', 'Indica la ruta absoluta del archivo de respaldo.');
  }
  let handle;
  try {
    handle = await fs.open(file, 'r');
  } catch (error) {
    if (error.code === 'ENOENT') throw new MotorError('BACKUP_FILE_NOT_FOUND', 'El archivo de respaldo no existe.', { cause: error });
    throw new MotorError('BACKUP_READ_FAILED', 'No se pudo abrir el archivo de respaldo.', { cause: error });
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new MotorError('BACKUP_FILE_INVALID', 'El respaldo debe ser un archivo.');
    if (info.size < PREFIX_BYTES) throw corrupt('archivo truncado');
    const start = await readExactly(handle, 0, PREFIX_BYTES);
    if (!start.subarray(0, MAGIC.length).equals(MAGIC)) throw corrupt('no es un respaldo de Mind');
    const headerLength = start.readUInt32BE(MAGIC.length);
    if (headerLength < 2 || headerLength > HEADER_MAX_BYTES) throw corrupt('cabecera no válida');
    const payloadStart = PREFIX_BYTES + headerLength;
    if (info.size < payloadStart + 1 + TAG_BYTES) throw corrupt('archivo truncado');
    const headerBytes = await readExactly(handle, PREFIX_BYTES, headerLength);
    const header = parseHeader(headerBytes);
    const tag = await readExactly(handle, info.size - TAG_BYTES, TAG_BYTES);
    return {
      handle, header, size: info.size, prefix: Buffer.concat([start, headerBytes]),
      payloadStart, payloadEnd: info.size - TAG_BYTES, tag,
    };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

/**
 * Datos visibles sin clave (cabecera en claro). No descifra ni verifica la carga útil.
 * @param {string} file Ruta absoluta del respaldo.
 */
export async function inspectBackup(file) {
  const opened = await openBackup(file);
  await opened.handle.close();
  const { header } = opened;
  return {
    format: 'mind-respaldo', version: 1, backupId: header.backupId, createdAt: header.createdAt,
    keyId: header.keyId, baseId: header.baseId, motorVersion: header.motorVersion,
    cipher: 'aes-256-gcm', compression: 'zlib',
    kdf: { name: 'scrypt', N: header.recoveryCode.kdf.N, r: header.recoveryCode.kdf.r, p: header.recoveryCode.kdf.p },
    size: opened.size,
  };
}

/**
 * Obtiene K y DK con una sola de las modalidades: código, archivo de
 * recuperación + frase, o la clave de la Base local.
 */
async function unlock(opened, options) {
  const { header } = opened;
  const chosen = ['recoveryCode', 'recoveryFile', 'baseDirectory'].filter((name) => options[name] !== undefined && options[name] !== null);
  if (chosen.length !== 1) {
    throw new MotorError('INVALID_ARGUMENTS', 'Indica una sola forma de abrir el respaldo: recoveryCode, recoveryFile con passphrase, o baseDirectory.');
  }
  let key = null;
  let method;
  if (chosen[0] === 'recoveryCode') {
    method = 'codigo';
    const { secret } = parseRecoveryCode(options.recoveryCode);
    const { kdf, sealed } = header.recoveryCode;
    requireAcceptedKdf(kdf, options);
    const wrapping = await deriveKey(secret, kdf);
    key = unseal(wrapping, sealed, kdfContext('codigo-de-recuperacion', header.keyId, kdf));
    secret.fill(0);
    wrapping.fill(0);
  } else if (chosen[0] === 'recoveryFile') {
    method = 'archivo';
    const recovery = await loadRecoveryFile(options.recoveryFile);
    requireAcceptedKdf(recovery.kdf, options);
    const passphrase = passphraseBytes(options.passphrase, { setup: false });
    const wrapping = await deriveKey(passphrase, recovery.kdf);
    key = unseal(wrapping, recovery.sealed, kdfContext('archivo-de-recuperacion', recovery.keyId, recovery.kdf));
    passphrase.fill(0);
    wrapping.fill(0);
  } else {
    method = 'base';
    key = (await loadKey(await physicalBase(options.baseDirectory))).key;
  }
  if (!key) throw keyInvalid();
  const dataKey = unseal(key, header.dataKey, context('clave-de-datos', header.keyId, header.backupId));
  if (!dataKey) {
    key.fill(0);
    throw keyInvalid();
  }
  return { key, dataKey, method };
}

/** Lector de bytes exactos sobre un iterador asíncrono de Buffers. */
function byteReader(source) {
  const iterator = source[Symbol.asyncIterator]();
  const queue = [];
  let available = 0;
  let ended = false;
  async function fill(minimum) {
    while (available < minimum && !ended) {
      const { value, done } = await iterator.next();
      if (done) ended = true;
      else if (value.length > 0) {
        queue.push(value);
        available += value.length;
      }
    }
    return available >= minimum;
  }
  function take(count) {
    const parts = [];
    let missing = count;
    while (missing > 0) {
      const head = queue[0];
      if (head.length <= missing) {
        parts.push(queue.shift());
        missing -= head.length;
      } else {
        parts.push(head.subarray(0, missing));
        queue[0] = head.subarray(missing);
        missing = 0;
      }
    }
    available -= count;
    return parts.length === 1 ? parts[0] : Buffer.concat(parts, count);
  }
  return {
    async exactly(count) {
      return (await fill(count)) ? take(count) : null;
    },
    async upTo(count) {
      if (!(await fill(1))) return null;
      return take(Math.min(count, queue[0].length));
    },
    async atEnd() {
      return !(await fill(1));
    },
  };
}

function parseRecord(bytes) {
  try {
    const record = JSON.parse(UTF8.decode(bytes));
    if (isPlainObject(record)) return record;
  } catch {
    // Se informa abajo.
  }
  throw corrupt('registro ilegible');
}

function parentOf(relative) {
  const index = relative.lastIndexOf('/');
  return index === -1 ? '' : relative.slice(0, index);
}

/**
 * Interpreta la carga útil descomprimida. sink recibe carpetas y archivos (o
 * nada, al verificar). Solo devuelve el resumen si el manifiesto coincide con
 * todo lo leído, incluido el SHA-256 de cada archivo.
 */
async function parsePayload(source, sink) {
  const reader = byteReader(source);
  const seen = [];
  const paths = new Set();
  const directories = new Set(['']);
  let bytes = 0;
  for (;;) {
    const head = await reader.exactly(4);
    if (!head) throw corrupt('falta el manifiesto');
    const length = head.readUInt32BE(0);
    if (length < 2 || length > MAX_MANIFEST_BYTES) throw corrupt('registro no válido');
    const body = await reader.exactly(length);
    if (!body) throw corrupt('registro incompleto');
    const record = parseRecord(body);
    if (record.type === 'manifest') {
      checkManifest(record, seen, bytes);
      if (!(await reader.atEnd())) throw corrupt('datos después del manifiesto');
      return {
        files: seen.filter((entry) => entry.type === 'file').length,
        directories: seen.filter((entry) => entry.type === 'directory').length,
        bytes,
        entries: record.entries.map((entry) => ({ ...entry })),
      };
    }
    if (length > MAX_RECORD_BYTES || seen.length >= MAX_ENTRIES) throw corrupt('registro no válido');
    if (!['file', 'directory'].includes(record.type) || !validRelativePath(record.path) || paths.has(record.path)
        || !directories.has(parentOf(record.path)) || record.path.toLowerCase() === KEY_FILE
        || !hasOnly(record, record.type === 'file' ? ['type', 'path', 'size'] : ['type', 'path'])) {
      throw corrupt('entrada no válida');
    }
    paths.add(record.path);
    if (record.type === 'directory') {
      directories.add(record.path);
      seen.push({ type: 'directory', path: record.path });
      await sink.directory?.(record.path);
      continue;
    }
    if (!Number.isSafeInteger(record.size) || record.size < 0 || bytes + record.size > MAX_TOTAL_BYTES) throw corrupt('tamaño no válido');
    bytes += record.size;
    const hash = createHash('sha256');
    const writer = await sink.file?.(record.path);
    for (let remaining = record.size; remaining > 0;) {
      const chunk = await reader.upTo(remaining);
      if (!chunk) throw corrupt('archivo incompleto');
      hash.update(chunk);
      remaining -= chunk.length;
      await writer?.write(chunk);
    }
    await writer?.close();
    seen.push({ type: 'file', path: record.path, size: record.size, sha256: hash.digest() });
  }
}

function checkManifest(manifest, seen, bytes) {
  const entries = manifest.entries;
  const files = seen.filter((entry) => entry.type === 'file').length;
  if (!hasOnly(manifest, ['type', 'entries', 'files', 'directories', 'bytes']) || !Array.isArray(entries)
      || entries.length !== seen.length || manifest.files !== files
      || manifest.directories !== seen.length - files || manifest.bytes !== bytes) {
    throw corrupt('el manifiesto no coincide con el contenido');
  }
  entries.forEach((entry, position) => {
    const actual = seen[position];
    const matches = isPlainObject(entry) && entry.path === actual.path && entry.type === actual.type
      && (actual.type === 'directory'
        ? hasOnly(entry, ['path', 'type'])
        : hasOnly(entry, ['path', 'type', 'size', 'sha256']) && entry.size === actual.size
          && typeof entry.sha256 === 'string' && SHA256_HEX.test(entry.sha256)
          && timingSafeEqual(Buffer.from(entry.sha256, 'hex'), actual.sha256));
    if (!matches) throw corrupt(`el SHA-256 o los datos de «${String(actual.path).slice(0, 200)}» no coinciden con el manifiesto`);
  });
}

/**
 * Descifra y descomprime la carga útil por partes. El último fragmento en claro
 * solo se entrega después de verificar la etiqueta GCM, y el resultado solo se
 * devuelve si la etiqueta y el manifiesto son correctos.
 */
async function readPayload(opened, dataKey, sink) {
  const decipher = createDecipheriv('aes-256-gcm', dataKey, opened.header.payloadNonce, { authTagLength: TAG_BYTES });
  decipher.setAAD(opened.prefix);
  decipher.setAuthTag(opened.tag);
  let authenticated = false;
  async function* plaintext() {
    let held = null;
    for (let position = opened.payloadStart; position < opened.payloadEnd;) {
      const length = Math.min(READ_CHUNK, opened.payloadEnd - position);
      const encrypted = await readExactly(opened.handle, position, length);
      position += length;
      const decrypted = decipher.update(encrypted);
      if (held) yield held;
      held = decrypted;
    }
    let tail;
    try {
      tail = decipher.final();
    } catch {
      throw corrupt('la etiqueta de autenticación no coincide');
    }
    authenticated = true;
    yield held ? Buffer.concat([held, tail]) : tail;
  }
  let summary = null;
  try {
    await pipeline(Readable.from(plaintext()), createInflate(), async (source) => {
      summary = await parsePayload(source, sink);
    });
  } catch (error) {
    if (error instanceof MotorError) throw error;
    throw corrupt('no se pudo descomprimir');
  }
  if (!authenticated || !summary) throw corrupt();
  return summary;
}

/**
 * Comprueba un respaldo completo sin escribir nada: etiqueta GCM, manifiesto y
 * SHA-256 de cada archivo.
 * @param {{ file: string, recoveryCode?: string, recoveryFile?: string | object, passphrase?: string, baseDirectory?: string }} options
 */
export async function verifyBackup(options = {}) {
  const opened = await openBackup(options.file);
  let unlocked = null;
  try {
    unlocked = await unlock(opened, options);
    const summary = await readPayload(opened, unlocked.dataKey, {});
    return {
      valid: true, method: unlocked.method, backupId: opened.header.backupId, createdAt: opened.header.createdAt,
      keyId: opened.header.keyId, ...summary,
    };
  } finally {
    unlocked?.key.fill(0);
    unlocked?.dataKey.fill(0);
    await opened.handle.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Restaurar
// ---------------------------------------------------------------------------

function targetInvalid(message, options) {
  return new MotorError('RESTORE_TARGET_INVALID', message, options);
}

/** Directorio nuevo o vacío, fuera del Motor; devuelve su ruta física. */
async function prepareTarget(targetDirectory) {
  if (typeof targetDirectory !== 'string' || !path.isAbsolute(targetDirectory) || targetDirectory.includes('\0')) {
    throw targetInvalid('Indica la ruta absoluta de la Base que se va a crear.');
  }
  const requested = path.resolve(targetDirectory);
  const parentPath = path.dirname(requested);
  if (parentPath === requested) throw targetInvalid('No se puede restaurar en la raíz de un disco.');
  let parent;
  try {
    parent = await fs.realpath(parentPath);
    if (!(await fs.stat(parent)).isDirectory()) throw new Error('no es una carpeta');
  } catch (error) {
    throw targetInvalid('La carpeta que contendrá la Base restaurada no existe.', { cause: error });
  }
  const target = path.join(parent, path.basename(requested));
  const motor = await motorDirectory();
  if (contains(motor, target) || contains(target, motor)) throw targetInvalid('La Base restaurada no puede estar dentro del Motor ni contenerlo.');
  const info = await fs.lstat(target).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (info) {
    if (info.isSymbolicLink() || !info.isDirectory()) throw targetInvalid('El destino de la restauración existe y no es una carpeta.');
    if ((await fs.readdir(target)).length > 0) {
      throw new MotorError('RESTORE_TARGET_NOT_EMPTY', 'Solo se restaura en una carpeta nueva o vacía; esa carpeta tiene contenido y no se ha tocado.');
    }
  }
  return { target, parent };
}

function restoreFailed(error) {
  if (error instanceof MotorError) return error;
  return new MotorError('RESTORE_FAILED', `No se pudo escribir la Base restaurada${error?.code ? ` (${error.code})` : ''}; no quedó nada a medias.`, { cause: error });
}

/** Escribe carpetas y archivos en el temporal; nunca reemplaza (wx). */
function restoreSink(root) {
  const folded = new Set();
  let open = null;
  const absolute = (relative) => path.join(root, ...relative.split('/'));
  const claim = (relative) => {
    const key = FOLD_CASE ? relative.normalize('NFC').toLowerCase() : relative;
    if (folded.has(key)) {
      throw new MotorError('RESTORE_FAILED', 'El respaldo tiene nombres que solo difieren en mayúsculas o acentos y este sistema no los distingue.');
    }
    folded.add(key);
  };
  return {
    async directory(relative) {
      claim(relative);
      await fs.mkdir(absolute(relative), { mode: 0o700 }).catch((error) => { throw restoreFailed(error); });
    },
    async file(relative) {
      claim(relative);
      try {
        open = await fs.open(absolute(relative), 'wx', 0o600);
      } catch (error) {
        throw restoreFailed(error);
      }
      const handle = open;
      return {
        async write(chunk) {
          await writeAll(handle, chunk).catch((error) => { throw restoreFailed(error); });
        },
        async close() {
          try {
            await handle.sync();
            await handle.close();
            open = null;
          } catch (error) {
            throw restoreFailed(error);
          }
        },
      };
    },
    async cleanup() {
      await open?.close().catch(() => {});
      open = null;
    },
  };
}

/** Sustituye el destino vacío por el temporal completo (Windows no reemplaza carpetas con rename). */
async function publishDirectory(temporary, target) {
  try {
    await fs.rename(temporary, target);
    return;
  } catch (error) {
    if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES', 'EISDIR'].includes(error.code)) throw error;
  }
  const entries = await fs.readdir(target).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (entries !== null) {
    if (entries.length > 0) {
      throw new MotorError('RESTORE_TARGET_NOT_EMPTY', 'La carpeta de destino recibió contenido durante la restauración; no se ha tocado.');
    }
    await fs.rmdir(target);
  }
  await fs.rename(temporary, target);
}

/**
 * Restaura un respaldo en un directorio nuevo o vacío. Escribe en un temporal
 * hermano, verifica la etiqueta GCM, el manifiesto y el SHA-256 de cada archivo,
 * y solo entonces lo renombra al destino. Si algo falla, borra el temporal: no
 * deja una Base parcial. Con restoreKey (por defecto) guarda en la Base
 * restaurada la clave K recuperada, para seguir creando respaldos que se abren
 * con el mismo código y el mismo archivo de recuperación.
 * @param {{ file: string, targetDirectory: string, restoreKey?: boolean, recoveryCode?: string, recoveryFile?: string | object, passphrase?: string, baseDirectory?: string }} options
 */
export async function restoreBackup(options = {}) {
  const { target, parent } = await prepareTarget(options.targetDirectory);
  const opened = await openBackup(options.file);
  let unlocked = null;
  let temporary = null;
  let sink = null;
  try {
    unlocked = await unlock(opened, options);
    temporary = path.join(parent, `.mind-restauracion-${randomUUID()}.tmp`);
    await fs.mkdir(temporary, { mode: 0o700 });
    sink = restoreSink(temporary);
    const summary = await readPayload(opened, unlocked.dataKey, sink);
    if (options.restoreKey !== false) {
      await writeKeyFile(temporary, keyRecordOut({
        keyId: opened.header.keyId, key: unlocked.key, codeWrap: opened.header.recoveryCode, createdAt: new Date().toISOString(),
      }));
    }
    await syncDirectory(temporary);
    await publishDirectory(temporary, target);
    temporary = null;
    await syncDirectory(parent);
    return {
      targetDirectory: target, method: unlocked.method, backupId: opened.header.backupId,
      createdAt: opened.header.createdAt, keyId: opened.header.keyId, keyRestored: options.restoreKey !== false,
      files: summary.files, directories: summary.directories, bytes: summary.bytes,
    };
  } catch (error) {
    throw restoreFailed(error);
  } finally {
    unlocked?.key.fill(0);
    unlocked?.dataKey.fill(0);
    await sink?.cleanup();
    await opened.handle.close().catch(() => {});
    if (temporary) await fs.rm(temporary, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Automatizaciones
// ---------------------------------------------------------------------------

/**
 * Ejecutores de confianza para automatizaciones (contrato de
 * src/function-runner.js). "respaldo" crea un respaldo en el destino que el
 * usuario configuró; no recibe parámetros y no configura ni restaura nada.
 * @param {{ motor: { baseDirectory: string }, audit?: Function }} session
 */
export function createBackupExecutors(session) {
  const baseDirectory = session?.motor?.baseDirectory;
  if (typeof baseDirectory !== 'string') {
    throw new MotorError('INVALID_ARGUMENTS', 'Los ejecutores de respaldo necesitan una sesión abierta del Motor.');
  }
  return Object.freeze({
    respaldo: Object.freeze({
      timeoutMs: 60_000,
      etiqueta: 'Crear un respaldo cifrado de la Base',
      descripcion: 'Crea un respaldo cifrado en la carpeta configurada con "mind respaldo configurar". No admite parámetros.',
      parametros: {},
      validarDefinicion: (definition) => {
        if (definition?.parametros && Object.keys(definition.parametros).length > 0) {
          throw new MotorError('INVALID_FUNCTION_DEFINITION', 'El ejecutor "respaldo" no admite parámetros.');
        }
      },
      requisitos: () => ({ carpetas: [], continuidad: [] }),
      describir: () => ['Crea un respaldo cifrado de la Base en la carpeta de respaldos que configuraste.'],
      // Entrada del anfitrión ({ funcion, origen, fecha, cambios? }) o vacía; nunca parámetros del agente.
      validateInput: (input) => input === null || (isPlainObject(input) && Object.keys(input).every((key) => ['funcion', 'origen', 'fecha', 'cambios'].includes(key))),
      async run({ signal } = {}) {
        const created = await createConfiguredBackup({ baseDirectory, signal });
        await Promise.resolve(session.audit?.('respaldo-creado', { archivo: created.name, destino: created.destination, origen: 'automatizacion' }))
          .catch(() => {});
        return { estado: 'creado', archivo: created.name, destino: created.destination, fecha: created.createdAt };
      },
    }),
  });
}
