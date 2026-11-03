import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { MotorError } from './errors.js';

/**
 * Archivos de paquete sin dependencias: tar (ustar con cabeceras PAX cuando
 * hacen falta) comprimido con gzip, y zip (deflate raw), para leer y escribir.
 *
 * Escritura reproducible: entradas ordenadas, fecha fija, uid/gid 0, sin
 * nombres de usuario y permisos normalizados (0755 carpetas y ejecutables,
 * 0644 el resto). La cabecera gzip se escribe aquí (sin fecha ni sistema de
 * origen), porque la de zlib incluye el sistema operativo de quien construye.
 *
 * Lectura defensiva: cada ruta se valida antes de escribir nada (ninguna
 * absoluta, con "..", unidades, barras invertidas ni caracteres de control),
 * los enlaces simbólicos solo pueden apuntar dentro del árbol extraído, nunca
 * se escribe a través de un enlace y nada se sobrescribe. Se rechazan tipos
 * especiales (dispositivos, FIFO) y entradas duplicadas.
 */

const BLOCK = 512;
const RECORD = BLOCK * 20;
const CHUNK = 1024 * 1024;
const TYPE_FLAGS = Object.freeze({ file: '0', directory: '5', symlink: '2' });
const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;

export class ArchiveError extends MotorError {
  constructor(message, options) {
    super('PACKAGE_ARCHIVE_INVALID', message, options);
  }
}

/** Permisos normalizados: solo importa si la entrada es ejecutable. */
export function normalizedMode(type, mode = 0o644) {
  if (type === 'directory') return 0o755;
  if (type === 'symlink') return 0o777;
  return mode & 0o111 ? 0o755 : 0o644;
}

const UNSAFE_COMPONENT = /[\u0000-\u001f\u007f<>:"|?*]/u;

/**
 * Ruta relativa segura dentro de un paquete, con "/" entre componentes.
 * Devuelve la ruta normalizada o null si no es aceptable.
 */
export function safeRelativePath(name) {
  if (typeof name !== 'string' || name.length === 0 || name.length > 4096) return null;
  if (name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/u.test(name)) return null;
  const parts = name.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..' || UNSAFE_COMPONENT.test(part)
      || /[. ]$/u.test(part))) return null;
  return parts.join('/');
}

/** Destino de un enlace simbólico resuelto dentro del árbol, o null si sale de él o no es relativo. */
export function resolveLinkTarget(entryPath, target) {
  if (typeof target !== 'string' || target === '' || target.includes('\0') || target.includes('\\')
      || target.startsWith('/') || /^[A-Za-z]:/u.test(target)) return null;
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(entryPath), target));
  if (resolved === '.' || resolved === '..' || resolved.startsWith('../') || path.posix.isAbsolute(resolved)) return null;
  return resolved;
}

function entryName(raw, type) {
  let name = raw.replace(/^(\.\/)+/u, '');
  if (type === 'directory') name = name.replace(/\/+$/u, '');
  if (name === '' || name === '.') return '';
  return name;
}

/* ------------------------------------------------------------------------ */
/* Lectura                                                                   */
/* ------------------------------------------------------------------------ */

/** Lector de bytes exactos sobre un flujo legible. */
class ByteReader {
  constructor(readable) {
    this.iterator = readable[Symbol.asyncIterator]();
    this.chunks = [];
    this.length = 0;
    this.done = false;
  }

  async fill(size) {
    while (this.length < size && !this.done) {
      const { value, done } = await this.iterator.next();
      if (done) {
        this.done = true;
        break;
      }
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      if (chunk.length > 0) {
        this.chunks.push(chunk);
        this.length += chunk.length;
      }
    }
    return this.length >= size;
  }

  take(size) {
    const parts = [];
    let left = size;
    while (left > 0) {
      const chunk = this.chunks[0];
      if (chunk.length <= left) {
        parts.push(chunk);
        this.chunks.shift();
        left -= chunk.length;
      } else {
        parts.push(chunk.subarray(0, left));
        this.chunks[0] = chunk.subarray(left);
        left = 0;
      }
    }
    this.length -= size;
    return parts.length === 1 ? parts[0] : Buffer.concat(parts, size);
  }

  /** Exactamente size bytes; null si el flujo terminó justo antes. */
  async read(size) {
    if (!(await this.fill(size))) {
      if (this.length === 0) return null;
      throw new ArchiveError('El archivo está truncado.');
    }
    return this.take(size);
  }

  async *stream(size) {
    let left = size;
    while (left > 0) {
      if (this.length === 0 && !(await this.fill(1))) throw new ArchiveError('El archivo está truncado.');
      const piece = this.take(Math.min(left, this.chunks[0].length, CHUNK));
      left -= piece.length;
      yield piece;
    }
  }

  async skip(size) {
    // eslint-disable-next-line no-unused-vars
    for await (const _ of this.stream(size));
  }

  async close() {
    await this.iterator.return?.();
  }
}

function field(header, offset, length) {
  const bytes = header.subarray(offset, offset + length);
  const end = bytes.indexOf(0);
  return bytes.subarray(0, end < 0 ? length : end).toString('utf8');
}

function numeric(header, offset, length) {
  const bytes = header.subarray(offset, offset + length);
  if (bytes[0] & 0x80) {
    // Codificación base 256 (GNU) para tamaños grandes.
    let value = BigInt(bytes[0] & 0x7f);
    for (const byte of bytes.subarray(1)) value = (value << 8n) | BigInt(byte);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new ArchiveError('Tamaño de entrada no admitido.');
    return Number(value);
  }
  const text = bytes.toString('latin1').replace(/\0.*$/su, '').trim();
  if (text === '') return 0;
  if (!/^[0-7]+$/u.test(text)) throw new ArchiveError('Cabecera tar no válida.');
  return Number.parseInt(text, 8);
}

function checksumOk(header) {
  const stored = numeric(header, 148, 8);
  let unsigned = 0;
  let signed = 0;
  for (let index = 0; index < BLOCK; index += 1) {
    const byte = index >= 148 && index < 156 ? 0x20 : header[index];
    unsigned += byte;
    signed += byte > 127 ? byte - 256 : byte;
  }
  return stored === unsigned || stored === signed;
}

function parsePax(data) {
  const records = {};
  let position = 0;
  while (position < data.length) {
    const space = data.indexOf(0x20, position);
    if (space < 0) break;
    const length = Number.parseInt(data.subarray(position, space).toString('latin1'), 10);
    if (!Number.isSafeInteger(length) || length <= 0 || position + length > data.length) {
      throw new ArchiveError('Cabecera PAX no válida.');
    }
    const record = data.subarray(space + 1, position + length - 1).toString('utf8');
    const equals = record.indexOf('=');
    if (equals > 0) records[record.slice(0, equals)] = record.slice(equals + 1);
    position += length;
  }
  return records;
}

const padded = (size) => Math.ceil(size / BLOCK) * BLOCK;

/**
 * Entradas de un tar (sin comprimir) leído de un flujo. Cada entrada expone
 * content(), un iterable asíncrono con su contenido; si no se consume, se omite.
 * @param {NodeJS.ReadableStream} readable
 */
export async function* readTar(readable) {
  const reader = new ByteReader(readable);
  let pax = null;
  let longName = null;
  let longLink = null;
  try {
    for (;;) {
      const header = await reader.read(BLOCK);
      if (header === null || header.every((byte) => byte === 0)) return;
      if (!checksumOk(header)) throw new ArchiveError('Suma de comprobación de cabecera tar incorrecta.');
      const flag = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
      let size = numeric(header, 124, 12);
      let name = field(header, 0, 100);
      if (header.subarray(257, 263).toString('latin1') === 'ustar\0') {
        const prefix = field(header, 345, 155);
        if (prefix) name = `${prefix}/${name}`;
      }
      let linkname = field(header, 157, 100);
      const mode = numeric(header, 100, 8) & 0o7777;
      if (flag === 'x' || flag === 'g' || flag === 'L' || flag === 'K') {
        if (size > 1024 * 1024) throw new ArchiveError('Cabecera extendida demasiado grande.');
        const data = (await reader.read(padded(size)) ?? Buffer.alloc(0)).subarray(0, size);
        if (flag === 'x') pax = parsePax(data);
        else if (flag === 'L') longName = field(data, 0, size);
        else if (flag === 'K') longLink = field(data, 0, size);
        // Las cabeceras globales ('g') no aportan nada que Mind use.
        continue;
      }
      if (pax?.path !== undefined) name = pax.path;
      else if (longName !== null) name = longName;
      if (pax?.linkpath !== undefined) linkname = pax.linkpath;
      else if (longLink !== null) linkname = longLink;
      if (pax?.size !== undefined) size = Number.parseInt(pax.size, 10);
      if (!Number.isSafeInteger(size) || size < 0) throw new ArchiveError('Tamaño de entrada no válido.');
      pax = null;
      longName = null;
      longLink = null;
      const type = { 0: 'file', 7: 'file', 5: 'directory', 2: 'symlink', 1: 'hardlink' }[flag];
      if (!type) throw new ArchiveError(`El archivo contiene una entrada de tipo no admitido (${JSON.stringify(flag)}).`);
      if (type !== 'file' && size !== 0) throw new ArchiveError('Una entrada sin contenido declara tamaño.');
      let left = size;
      yield {
        name, type, mode, size, linkname,
        async *content() {
          for await (const piece of reader.stream(left)) {
            left -= piece.length;
            yield piece;
          }
        },
      };
      await reader.skip(left + padded(size) - size);
    }
  } finally {
    await reader.close();
  }
}

async function* fileRange(handle, start, length) {
  let offset = start;
  let left = length;
  while (left > 0) {
    const buffer = Buffer.allocUnsafe(Math.min(left, CHUNK));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    if (bytesRead === 0) throw new ArchiveError('El archivo zip está truncado.');
    offset += bytesRead;
    left -= bytesRead;
    yield buffer.subarray(0, bytesRead);
  }
}

function zip64Values(extra, wanted) {
  let position = 0;
  while (position + 4 <= extra.length) {
    const id = extra.readUInt16LE(position);
    const size = extra.readUInt16LE(position + 2);
    if (id === 0x0001) {
      const values = {};
      let cursor = position + 4;
      for (const key of wanted) {
        if (cursor + 8 > position + 4 + size) throw new ArchiveError('Campo ZIP64 incompleto.');
        values[key] = Number(extra.readBigUInt64LE(cursor));
        cursor += 8;
      }
      return values;
    }
    position += 4 + size;
  }
  throw new ArchiveError('Falta el campo ZIP64.');
}

/**
 * Entradas de un zip (lee el directorio central; acceso aleatorio).
 * @param {string} file
 */
export async function* readZip(file) {
  const handle = await fsp.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const tailLength = Math.min(size, 65_557);
    const tail = Buffer.alloc(tailLength);
    await handle.read(tail, 0, tailLength, size - tailLength);
    let eocd = -1;
    for (let index = tailLength - 22; index >= 0; index -= 1) {
      if (tail.readUInt32LE(index) === 0x06054b50) {
        eocd = index;
        break;
      }
    }
    if (eocd < 0) throw new ArchiveError('No es un archivo zip válido.');
    let count = tail.readUInt16LE(eocd + 10);
    let directorySize = tail.readUInt32LE(eocd + 12);
    let directoryOffset = tail.readUInt32LE(eocd + 16);
    if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
      const locator = eocd - 20;
      if (locator < 0 || tail.readUInt32LE(locator) !== 0x07064b50) throw new ArchiveError('Zip64 sin localizador.');
      const record = Buffer.alloc(56);
      await handle.read(record, 0, 56, Number(tail.readBigUInt64LE(locator + 8)));
      if (record.readUInt32LE(0) !== 0x06064b50) throw new ArchiveError('Registro Zip64 no válido.');
      count = Number(record.readBigUInt64LE(32));
      directorySize = Number(record.readBigUInt64LE(40));
      directoryOffset = Number(record.readBigUInt64LE(48));
    }
    if (directoryOffset + directorySize > size || count > 1_000_000) throw new ArchiveError('Directorio central del zip no válido.');
    const directory = Buffer.alloc(directorySize);
    await handle.read(directory, 0, directorySize, directoryOffset);
    let position = 0;
    for (let index = 0; index < count; index += 1) {
      if (position + 46 > directory.length || directory.readUInt32LE(position) !== 0x02014b50) {
        throw new ArchiveError('Entrada del directorio central no válida.');
      }
      const madeBy = directory.readUInt16LE(position + 4);
      const flags = directory.readUInt16LE(position + 8);
      const method = directory.readUInt16LE(position + 10);
      const crc = directory.readUInt32LE(position + 16);
      let compressed = directory.readUInt32LE(position + 20);
      let uncompressed = directory.readUInt32LE(position + 24);
      const nameLength = directory.readUInt16LE(position + 28);
      const extraLength = directory.readUInt16LE(position + 30);
      const commentLength = directory.readUInt16LE(position + 32);
      const external = directory.readUInt32LE(position + 38);
      let localOffset = directory.readUInt32LE(position + 42);
      const nameBytes = directory.subarray(position + 46, position + 46 + nameLength);
      const extra = directory.subarray(position + 46 + nameLength, position + 46 + nameLength + extraLength);
      position += 46 + nameLength + extraLength + commentLength;
      const wanted = [];
      if (uncompressed === 0xffffffff) wanted.push('uncompressed');
      if (compressed === 0xffffffff) wanted.push('compressed');
      if (localOffset === 0xffffffff) wanted.push('offset');
      if (wanted.length > 0) {
        const values = zip64Values(extra, wanted);
        uncompressed = values.uncompressed ?? uncompressed;
        compressed = values.compressed ?? compressed;
        localOffset = values.offset ?? localOffset;
      }
      if (flags & 0x1) throw new ArchiveError('El zip contiene entradas cifradas.');
      if (method !== 0 && method !== 8) throw new ArchiveError(`Método de compresión zip no admitido (${method}).`);
      const name = nameBytes.toString(flags & 0x800 ? 'utf8' : 'latin1').replace(/\\/gu, '/');
      const unixMode = (madeBy >> 8) === 3 ? external >>> 16 : 0;
      let type = name.endsWith('/') || (external & 0x10) ? 'directory' : 'file';
      if ((unixMode & S_IFMT) === S_IFLNK) type = 'symlink';
      else if ((unixMode & S_IFMT) === S_IFDIR) type = 'directory';
      else if (unixMode && (unixMode & S_IFMT) !== S_IFREG) throw new ArchiveError('El zip contiene una entrada de tipo no admitido.');
      const header = Buffer.alloc(30);
      async function* raw() {
        await handle.read(header, 0, 30, localOffset);
        if (header.readUInt32LE(0) !== 0x04034b50) throw new ArchiveError('Cabecera local del zip no válida.');
        const start = localOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
        if (start + compressed > size) throw new ArchiveError('El archivo zip está truncado.');
        yield* fileRange(handle, start, compressed);
      }
      async function* content() {
        let total = 0;
        let sum = 0;
        const source = method === 8 ? Readable.from(raw()).pipe(zlib.createInflateRaw()) : Readable.from(raw());
        for await (const chunk of source) {
          total += chunk.length;
          if (total > uncompressed) throw new ArchiveError('Una entrada del zip supera su tamaño declarado.');
          sum = zlib.crc32(chunk, sum);
          yield chunk;
        }
        if (total !== uncompressed || sum !== crc) throw new ArchiveError('Una entrada del zip está dañada (CRC o tamaño).');
      }
      let linkname = '';
      if (type === 'symlink') {
        const parts = [];
        for await (const chunk of content()) parts.push(chunk);
        linkname = Buffer.concat(parts).toString('utf8');
      }
      yield {
        name, type, mode: unixMode & 0o7777 || (type === 'directory' ? 0o755 : 0o644),
        size: type === 'file' ? uncompressed : 0, linkname,
        content: type === 'file' ? content : async function* empty() {},
      };
    }
  } finally {
    await handle.close();
  }
}

/** Formato por extensión o por firma: 'zip', 'tar.gz' o 'tar.xz'. */
export async function archiveFormat(file) {
  const lower = file.toLowerCase();
  if (lower.endsWith('.zip')) return 'zip';
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) return 'tar.gz';
  if (lower.endsWith('.tar.xz')) return 'tar.xz';
  const handle = await fsp.open(file, 'r');
  try {
    const magic = Buffer.alloc(6);
    await handle.read(magic, 0, 6, 0);
    if (magic.readUInt32LE(0) === 0x04034b50) return 'zip';
    if (magic[0] === 0x1f && magic[1] === 0x8b) return 'tar.gz';
    if (magic.equals(Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]))) return 'tar.xz';
  } finally {
    await handle.close();
  }
  throw new ArchiveError('Formato de archivo no reconocido: usa .zip o .tar.gz.');
}

/**
 * Entradas de un archivo según su formato. Para .tar.xz hace falta un
 * descompresor externo (decompressXz), porque Node no incluye xz.
 */
export async function* readArchive(file, { decompressXz } = {}) {
  const format = await archiveFormat(file);
  if (format === 'zip') {
    yield* readZip(file);
    return;
  }
  if (format === 'tar.gz') {
    const source = fs.createReadStream(file);
    const gunzip = zlib.createGunzip();
    source.on('error', (error) => gunzip.destroy(error));
    yield* readTar(source.pipe(gunzip));
    return;
  }
  if (!decompressXz) throw new ArchiveError('Este archivo .tar.xz necesita un descompresor xz.');
  yield* readTar(decompressXz(file));
}

/**
 * Extrae entradas validando cada una antes de escribir.
 *
 * @param {AsyncIterable<object>} entries Resultado de readTar/readZip/readArchive.
 * @param {string} destination Carpeta vacía o inexistente.
 * @param {object} [options]
 * @param {(name: string, entry: object) => string | null} [options.map]
 *   Ruta de destino relativa (o null para omitir), a partir de la ruta validada.
 * @param {'create' | 'record'} [options.links] Crear los enlaces simbólicos o solo anotarlos.
 * @returns {Promise<Array<{ path: string, type: 'file' | 'directory' | 'symlink', mode: number, size: number, target?: string }>>}
 */
export async function extractEntries(entries, destination, { map = (name) => name, links = 'create' } = {}) {
  await fsp.mkdir(destination, { recursive: true });
  const existing = await fsp.readdir(destination);
  if (existing.length > 0) throw new ArchiveError('La carpeta de extracción debe estar vacía.');
  const seen = new Map();
  const linkPaths = new Set();
  const archived = new Map();
  const absolute = (relative) => path.join(destination, ...relative.split('/'));
  const throughLink = (relative) => {
    const parts = relative.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      if (linkPaths.has(parts.slice(0, index).join('/'))) return true;
    }
    return false;
  };
  const insensitive = (value) => value.normalize('NFC').toLowerCase();
  const folded = new Set();

  for await (const entry of entries) {
    const name = entryName(entry.name, entry.type);
    if (name === '') continue;
    const safe = safeRelativePath(name);
    if (!safe) throw new ArchiveError(`Ruta no válida en el archivo: ${JSON.stringify(entry.name).slice(0, 200)}`);
    if (entry.type === 'symlink' && !resolveLinkTarget(safe, entry.linkname)) {
      throw new ArchiveError(`Enlace que sale del paquete: ${safe}`);
    }
    let hardlinkSource = null;
    if (entry.type === 'hardlink') {
      const source = safeRelativePath(entryName(entry.linkname, 'file'));
      if (!source || !archived.has(source)) throw new ArchiveError(`Enlace duro no válido: ${safe}`);
      hardlinkSource = archived.get(source);
    }
    const mapped = map(safe, entry);
    if (mapped === null || mapped === undefined) continue;
    const target = safeRelativePath(mapped);
    if (!target) throw new ArchiveError(`Ruta de destino no válida: ${mapped}`);
    if (entry.type === 'symlink' && !resolveLinkTarget(target, entry.linkname)) {
      throw new ArchiveError(`Enlace que sale del paquete: ${target}`);
    }
    if (hardlinkSource === null && entry.type === 'hardlink') continue;
    if (throughLink(target)) throw new ArchiveError(`Entrada dentro de un enlace simbólico: ${target}`);
    const type = entry.type === 'hardlink' ? 'file' : entry.type;
    const previous = seen.get(target);
    if (previous) {
      if (previous.type === 'directory' && type === 'directory') continue;
      throw new ArchiveError(`Entrada duplicada en el archivo: ${target}`);
    }
    if (folded.has(insensitive(target)) && !seen.has(target)) {
      throw new ArchiveError(`Dos entradas difieren solo en mayúsculas: ${target}`);
    }
    // Las carpetas padre implícitas no pueden ser archivos ya extraídos.
    const parts = target.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      const parent = seen.get(parts.slice(0, index).join('/'));
      if (parent && parent.type !== 'directory') throw new ArchiveError(`Entrada dentro de un archivo: ${target}`);
    }
    const file = absolute(target);
    const mode = normalizedMode(type, entry.mode);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const record = { path: target, type, mode, size: 0 };
    if (type === 'directory') {
      await fsp.mkdir(file);
    } else if (type === 'symlink') {
      record.target = entry.linkname;
      if (links === 'create') {
        if (process.platform === 'win32') throw new ArchiveError('El paquete contiene enlaces simbólicos, que no se admiten en Windows.');
        await fsp.symlink(entry.linkname, file);
      }
      linkPaths.add(target);
    } else if (hardlinkSource) {
      await fsp.copyFile(absolute(hardlinkSource.path), file, fs.constants.COPYFILE_EXCL);
      record.size = hardlinkSource.size;
    } else {
      const handle = await fsp.open(file, 'wx', mode);
      try {
        for await (const chunk of entry.content()) {
          await handle.write(chunk);
          record.size += chunk.length;
        }
      } finally {
        await handle.close();
      }
      if (record.size !== entry.size) throw new ArchiveError(`Tamaño inesperado en ${target}.`);
    }
    if (type !== 'symlink' && process.platform !== 'win32') await fsp.chmod(file, mode);
    seen.set(target, record);
    folded.add(insensitive(target));
    if (type === 'file') archived.set(safe, record);
  }
  return [...seen.values()].sort((a, b) => compareBytes(a.path, b.path));
}

/* ------------------------------------------------------------------------ */
/* Escritura reproducible                                                    */
/* ------------------------------------------------------------------------ */

/** Orden estable por bytes UTF-8, independiente de la configuración regional. */
export function compareBytes(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/**
 * Normaliza y valida la lista de entradas a empaquetar.
 * Entrada: { path, type: 'file'|'directory'|'symlink', mode?, source?: { file } | { data }, target? }
 */
async function prepareEntries(entries) {
  const result = [];
  const names = new Set();
  for (const entry of entries) {
    const safe = safeRelativePath(entry.path);
    if (!safe) throw new ArchiveError(`Ruta no válida para el paquete: ${entry.path}`);
    if (names.has(safe)) throw new ArchiveError(`Entrada duplicada: ${safe}`);
    names.add(safe);
    if (!['file', 'directory', 'symlink'].includes(entry.type)) throw new ArchiveError(`Tipo no admitido: ${entry.type}`);
    if (entry.type === 'symlink' && !resolveLinkTarget(safe, entry.target)) throw new ArchiveError(`Enlace no válido: ${safe}`);
    let size = 0;
    if (entry.type === 'file') {
      if (entry.source?.data !== undefined) size = Buffer.byteLength(entry.source.data);
      else if (typeof entry.source?.file === 'string') size = (await fsp.stat(entry.source.file)).size;
      else throw new ArchiveError(`Falta el contenido de ${safe}.`);
    }
    result.push({ ...entry, path: safe, size, mode: normalizedMode(entry.type, entry.mode) });
  }
  // Las carpetas padre se declaran explícitamente para fijar sus permisos.
  for (const entry of [...result]) {
    const parts = entry.path.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      const parent = parts.slice(0, index).join('/');
      if (!names.has(parent)) {
        names.add(parent);
        result.push({ path: parent, type: 'directory', mode: 0o755, size: 0 });
      }
    }
  }
  return result.sort((a, b) => compareBytes(a.path, b.path));
}

async function* contentOf(entry) {
  if (entry.source.data !== undefined) {
    const data = Buffer.from(entry.source.data);
    for (let offset = 0; offset < data.length; offset += CHUNK) yield data.subarray(offset, offset + CHUNK);
    return;
  }
  const handle = await fsp.open(entry.source.file, 'r');
  try {
    let total = 0;
    for (;;) {
      const buffer = Buffer.allocUnsafe(CHUNK);
      const { bytesRead } = await handle.read(buffer, 0, CHUNK, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      yield buffer.subarray(0, bytesRead);
    }
    if (total !== entry.size) throw new ArchiveError(`El archivo cambió mientras se empaquetaba: ${entry.path}`);
  } finally {
    await handle.close();
  }
}

function octalField(value, length) {
  const text = value.toString(8);
  if (text.length > length - 1) throw new ArchiveError('Valor demasiado grande para una cabecera tar.');
  return `${text.padStart(length - 1, '0')}\0`;
}

function ascii(value) {
  return /^[\x20-\x7e]*$/u.test(value);
}

/** Divide una ruta larga en prefijo y nombre ustar; null si no cabe. */
function splitUstar(name) {
  if (Buffer.byteLength(name) <= 100) return { prefix: '', name };
  for (let index = name.indexOf('/'); index > 0; index = name.indexOf('/', index + 1)) {
    const prefix = name.slice(0, index);
    const rest = name.slice(index + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(rest) <= 100 && rest.length > 0) return { prefix, name: rest };
  }
  return null;
}

function tarHeader({ name, type, mode, size, linkname = '', mtime, prefix = '' }) {
  const header = Buffer.alloc(BLOCK, 0);
  header.write(name, 0, 100, 'utf8');
  header.write(octalField(mode, 8), 100, 8, 'latin1');
  header.write(octalField(0, 8), 108, 8, 'latin1');
  header.write(octalField(0, 8), 116, 8, 'latin1');
  header.write(octalField(size, 12), 124, 12, 'latin1');
  header.write(octalField(mtime, 12), 136, 12, 'latin1');
  header.write('        ', 148, 8, 'latin1');
  header.write(type, 156, 1, 'latin1');
  header.write(linkname, 157, 100, 'utf8');
  header.write('ustar\0', 257, 6, 'latin1');
  header.write('00', 263, 2, 'latin1');
  header.write(octalField(0, 8), 329, 8, 'latin1');
  header.write(octalField(0, 8), 337, 8, 'latin1');
  header.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'latin1');
  return header;
}

function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 1;
  while (String(length).length + Buffer.byteLength(body) !== length) length = String(length).length + Buffer.byteLength(body);
  return `${length}${body}`;
}

function padding(size) {
  const rest = size % BLOCK;
  return rest === 0 ? null : Buffer.alloc(BLOCK - rest, 0);
}

async function* tarStream(entries, { root, mtime }) {
  let total = 0;
  const emit = (buffer) => {
    total += buffer.length;
    return buffer;
  };
  for (const entry of entries) {
    const fullName = root ? `${root}/${entry.path}` : entry.path;
    const name = entry.type === 'directory' ? `${fullName}/` : fullName;
    const linkname = entry.type === 'symlink' ? entry.target : '';
    const split = ascii(name) ? splitUstar(name) : null;
    const needsPax = !split || !ascii(linkname) || Buffer.byteLength(linkname) > 100;
    if (needsPax) {
      const records = Buffer.from(paxRecord('path', name) + (linkname && (!ascii(linkname) || Buffer.byteLength(linkname) > 100) ? paxRecord('linkpath', linkname) : ''), 'utf8');
      const base = path.posix.basename(fullName).replace(/[^\x20-\x7e]/gu, '_').slice(0, 80);
      yield emit(tarHeader({ name: `PaxHeaders/${base}`, type: 'x', mode: 0o644, size: records.length, mtime }));
      yield emit(records);
      const pad = padding(records.length);
      if (pad) yield emit(pad);
    }
    const ustar = split ?? { prefix: '', name: Buffer.from(name.replace(/[^\x20-\x7e]/gu, '_')).subarray(0, 100).toString('latin1') };
    yield emit(tarHeader({
      name: ustar.name, prefix: ustar.prefix, type: TYPE_FLAGS[entry.type], mode: entry.mode,
      size: entry.type === 'file' ? entry.size : 0,
      linkname: Buffer.byteLength(linkname) <= 100 && ascii(linkname) ? linkname : '', mtime,
    }));
    if (entry.type === 'file') {
      yield* (async function* counted() {
        for await (const chunk of contentOf(entry)) yield emit(chunk);
      })();
      const pad = padding(entry.size);
      if (pad) yield emit(pad);
    }
  }
  yield emit(Buffer.alloc(BLOCK * 2, 0));
  const rest = total % RECORD;
  if (rest !== 0) yield emit(Buffer.alloc(RECORD - rest, 0));
}

/**
 * Escribe un .tar.gz reproducible.
 * @param {string} destination
 * @param {object[]} entries
 * @param {{ root?: string, mtime: number, level?: number }} options mtime en segundos.
 */
export async function writeTarGz(destination, entries, { root = '', mtime, level = 9 }) {
  if (!Number.isSafeInteger(mtime) || mtime < 0) throw new ArchiveError('Fecha de las entradas no válida.');
  const prepared = await prepareEntries(entries);
  // Cabecera gzip fija: sin nombre, sin fecha (0) y sistema "desconocido" (255).
  const header = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0, level >= 9 ? 0x02 : 0x00, 0xff]);
  await fsp.writeFile(destination, header, { flag: 'wx' });
  let crc = 0;
  let size = 0;
  async function* counted() {
    for await (const chunk of tarStream(prepared, { root, mtime })) {
      crc = zlib.crc32(chunk, crc);
      size += chunk.length;
      yield chunk;
    }
  }
  await pipeline(Readable.from(counted()), zlib.createDeflateRaw({ level }), fs.createWriteStream(destination, { flags: 'a' }));
  const trailer = Buffer.alloc(8);
  trailer.writeUInt32LE(crc >>> 0, 0);
  trailer.writeUInt32LE(size % 0x1_0000_0000, 4);
  await fsp.appendFile(destination, trailer);
  return { entries: prepared.length, uncompressed: size };
}

function dosDateTime(seconds) {
  const date = new Date(Math.max(seconds, 315_532_800) * 1000);
  const time = (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2);
  const day = ((date.getUTCFullYear() - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();
  return { time, day };
}

/**
 * Escribe un .zip reproducible (deflate raw; almacenado si no reduce).
 * @param {string} destination
 * @param {object[]} entries
 * @param {{ root?: string, mtime: number, level?: number }} options
 */
export async function writeZip(destination, entries, { root = '', mtime, level = 9 }) {
  if (!Number.isSafeInteger(mtime) || mtime < 0) throw new ArchiveError('Fecha de las entradas no válida.');
  const prepared = await prepareEntries(entries);
  if (prepared.length > 0xfffe) throw new ArchiveError('Demasiadas entradas para un zip sin ZIP64.');
  const { time, day } = dosDateTime(mtime);
  const handle = await fsp.open(destination, 'wx');
  const central = [];
  let offset = 0;
  let uncompressedTotal = 0;
  const write = async (buffer) => {
    await handle.write(buffer);
    offset += buffer.length;
  };
  try {
    for (const entry of prepared) {
      const fullName = root ? `${root}/${entry.path}` : entry.path;
      const name = Buffer.from(entry.type === 'directory' ? `${fullName}/` : fullName, 'utf8');
      let data = Buffer.alloc(0);
      if (entry.type === 'file') {
        const parts = [];
        for await (const chunk of contentOf(entry)) parts.push(chunk);
        data = Buffer.concat(parts);
      } else if (entry.type === 'symlink') {
        data = Buffer.from(entry.target, 'utf8');
      }
      const crc = zlib.crc32(data) >>> 0;
      let method = 0;
      let stored = data;
      if (entry.type === 'file' && data.length > 0) {
        const deflated = zlib.deflateRawSync(data, { level });
        if (deflated.length < data.length) {
          method = 8;
          stored = deflated;
        }
      }
      if (offset > 0xfffffffe || stored.length > 0xfffffffe || data.length > 0xfffffffe) {
        throw new ArchiveError('El paquete es demasiado grande para un zip sin ZIP64.');
      }
      const flags = ascii(fullName) ? 0 : 0x800;
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(flags, 6);
      local.writeUInt16LE(method, 8);
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(day, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(stored.length, 18);
      local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(name.length, 26);
      local.writeUInt16LE(0, 28);
      const localOffset = offset;
      await write(local);
      await write(name);
      if (stored.length > 0) await write(stored);
      uncompressedTotal += data.length;
      const type = { file: S_IFREG, directory: S_IFDIR, symlink: S_IFLNK }[entry.type];
      const record = Buffer.alloc(46);
      record.writeUInt32LE(0x02014b50, 0);
      record.writeUInt16LE((3 << 8) | 30, 4);
      record.writeUInt16LE(20, 6);
      record.writeUInt16LE(flags, 8);
      record.writeUInt16LE(method, 10);
      record.writeUInt16LE(time, 12);
      record.writeUInt16LE(day, 14);
      record.writeUInt32LE(crc, 16);
      record.writeUInt32LE(stored.length, 20);
      record.writeUInt32LE(data.length, 24);
      record.writeUInt16LE(name.length, 28);
      record.writeUInt32LE((((type | entry.mode) << 16) >>> 0 | (entry.type === 'directory' ? 0x10 : 0)) >>> 0, 38);
      record.writeUInt32LE(localOffset, 42);
      central.push(record, name);
    }
    const directoryOffset = offset;
    for (const part of central) await write(part);
    const directorySize = offset - directoryOffset;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(prepared.length, 8);
    end.writeUInt16LE(prepared.length, 10);
    end.writeUInt32LE(directorySize, 12);
    end.writeUInt32LE(directoryOffset, 16);
    await write(end);
  } finally {
    await handle.close();
  }
  return { entries: prepared.length, uncompressed: uncompressedTotal };
}
