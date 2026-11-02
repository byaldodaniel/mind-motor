import { MotorError } from './errors.js';

/**
 * Límite de tamaño de la creación y modificación de texto. Por defecto es 1 MiB;
 * solo el anfitrión puede ampliarlo al conceder el permiso (opción maxBytes),
 * hasta un máximo absoluto de 16 MiB. Los auxiliares nativos aplican además el
 * mínimo entre lo pedido y su propio máximo.
 */
export const DEFAULT_TEXT_BYTES = 1024 * 1024;
export const ABSOLUTE_MAX_TEXT_BYTES = 16 * 1024 * 1024;

/** @returns {number} El límite validado; el predeterminado si no se indica. */
export function textLimit(value) {
  if (value === undefined) return DEFAULT_TEXT_BYTES;
  if (!Number.isSafeInteger(value) || value < 1 || value > ABSOLUTE_MAX_TEXT_BYTES) {
    throw new MotorError('INVALID_SIZE_LIMIT', 'maxBytes debe ser un entero entre 1 y 16 MiB (16777216 bytes).');
  }
  return value;
}

/** Tamaño legible para los mensajes: "1 MiB", "512 KiB" o "N bytes". */
export function describeBytes(bytes) {
  if (bytes % (1024 * 1024) === 0) return `${bytes / (1024 * 1024)} MiB`;
  if (bytes % 1024 === 0) return `${bytes / 1024} KiB`;
  return `${bytes} bytes`;
}
