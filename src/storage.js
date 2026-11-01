import { lstat, readFile, writeFile, rename, rm, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { MotorError } from './errors.js';

async function rejectLink(filename) {
  try {
    if ((await lstat(filename)).isSymbolicLink()) {
      throw new MotorError('RECORD_LINK', 'Un registro técnico no puede ser un enlace.');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

export async function readJson(filename) {
  await rejectLink(filename);
  let text;
  try {
    text = await readFile(filename, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    // El envoltorio distingue un archivo que contiene null de uno inexistente.
    return { data: JSON.parse(text) };
  } catch (error) {
    throw new MotorError('RECORD_CORRUPT', 'El registro técnico no contiene JSON válido.', { cause: error });
  }
}

export async function writeJson(filename, data) {
  await rejectLink(filename);
  const temporary = path.join(path.dirname(filename), `.mind-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(data)}\n`, {
      encoding: 'utf8', flag: 'wx', mode: 0o600, flush: true,
    });
    await rename(temporary, filename);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function removeJson(filename) {
  await rejectLink(filename);
  try {
    await unlink(filename);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
