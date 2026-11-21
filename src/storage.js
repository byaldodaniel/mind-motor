import { lstat, readFile, writeFile, rename, rm, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { MotorError } from './errors.js';
import { setTimeout as delay } from 'node:timers/promises';

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
  return parseStoredJson(text);
}

export function parseStoredJson(text) {
  try {
    // El envoltorio distingue un archivo que contiene null de uno inexistente.
    return { data: JSON.parse(text) };
  } catch (error) {
    throw new MotorError('RECORD_CORRUPT', 'El registro técnico no contiene JSON válido.', { cause: error });
  }
}

// Sustitución atómica del JSON, no una transacción de lectura-modificación.
// El indexador coordina esa secuencia completa mediante el bloqueo por ámbito.
export async function writeJson(filename, data, {renameFile=rename,pause=delay,platform=process.platform}={}) {
  await rejectLink(filename);
  const temporary = path.join(path.dirname(filename), `.mind-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(data)}\n`, {
      encoding: 'utf8', flag: 'wx', mode: 0o600, flush: true,
    });
    for(let attempt=0;;attempt++){
      await rejectLink(filename);
      try {await renameFile(temporary,filename);break;}
      catch(error){
        if(platform!=='win32'||!['EPERM','EACCES','EBUSY'].includes(error.code)||attempt>=4)throw error;
        // Algunos lectores/antivirus de Windows retienen un handle brevemente.
        // Reintentar la sustitución atómica, sin borrar ni copiar sobre el destino.
        await pause(10*2**attempt);
      }
    }
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
