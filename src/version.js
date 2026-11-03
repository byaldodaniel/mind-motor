import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Versión del Motor, tomada de su package.json. */
export const MOTOR_VERSION = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')).version;
