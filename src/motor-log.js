import fs from 'node:fs';
import path from 'node:path';

export const MOTOR_LOG_FILE = 'motor-central.log';
const DEFAULT_MAX_BYTES = 512 * 1024;

/**
 * Registro en disco del Motor Central. El Motor corre sin terminal ni salida
 * estándar, así que sin este archivo un fallo en el equipo del usuario no deja
 * rastro. Una línea JSON por evento, con una sola rotación (`.1`) al superar el
 * tamaño. Escribir el registro nunca interrumpe al Motor.
 */
export function createFileLog(baseDirectory, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const file = path.join(baseDirectory, MOTOR_LOG_FILE);
  let size = null;
  return (level, message, data) => {
    try {
      const line = `${JSON.stringify({ fecha: new Date().toISOString(), nivel: level, mensaje: message, ...(data ? { datos: data } : {}) })}\n`;
      const bytes = Buffer.byteLength(line, 'utf8');
      if (size === null) {
        try { size = fs.statSync(file).size; } catch { size = 0; }
      }
      if (size > 0 && size + bytes > maxBytes) {
        try { fs.renameSync(file, `${file}.1`); } catch { /* se sigue escribiendo en el actual */ }
        size = 0;
      }
      fs.appendFileSync(file, line, { encoding: 'utf8', mode: 0o600 });
      size += bytes;
    } catch {
      // Sin registro (disco lleno, Base no disponible): el Motor continúa.
    }
  };
}
