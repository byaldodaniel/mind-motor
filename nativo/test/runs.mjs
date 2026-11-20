// Las Bases y carpetas ficticias de las pruebas viven fuera del Motor:
// r3 rechaza una Base dentro de su propio programa (BASE_OVERLAPS_MOTOR).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const RAW_RUNS = path.resolve(process.env.MIND_NATIVO_RUNS || path.join(os.tmpdir(), 'mind-nativo-runs'));
fs.mkdirSync(RAW_RUNS, { recursive: true });
// Ruta canónica (sin nombres cortos 8.3 de Windows): el puente deriva el baseId de ella.
export const RUNS = fs.realpathSync.native(RAW_RUNS);
