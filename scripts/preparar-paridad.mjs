#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashFile } from '../src/product-files.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const [destination, reproducibility] = process.argv.slice(2);
if (!destination || (reproducibility && reproducibility !== '--reproducibilidad')) {
  throw new Error('Uso: preparar-paridad.mjs <carpeta nueva> [--reproducibilidad]');
}
const output = path.resolve(destination);
const { version } = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const patch = /^([0-9]+)\.([0-9]+)\.([0-9]+)$/u.exec(version);
if (!patch) throw new Error('Se requiere una versión estable para ensayar la actualización.');
const next = `${patch[1]}.${patch[2]}.${Number(patch[3]) + 1}`;
const { plataformas } = JSON.parse(await fs.readFile(path.join(root, 'packaging/publicacion.json'), 'utf8'));
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
await fs.mkdir(output);

function script(name, ...args) {
  execFileSync(process.execPath, [`scripts/${name}.mjs`, ...args], { cwd: root, stdio: 'inherit' });
}

const candidates = path.join(output, 'candidatos');
const upgrades = path.join(output, 'ensayo');
const cache = process.env.MIND_COMPONENT_CACHE ? ['--cache', path.resolve(process.env.MIND_COMPONENT_CACHE)] : [];
script('construir-paquetes', '--sumas-oficiales', '--salida', candidates, ...cache);
script('firmar-actualizacion', '--verificar', version, candidates);
script('construir-paquetes', '--version-paquete', next, '--salida', upgrades, ...cache);
script('firmar-actualizacion', '--verificar', next, upgrades);
if (reproducibility) {
  const repeated = path.join(output, 'repeticion');
  script('construir-paquetes', '--salida', repeated, ...cache);
  const [first, second] = await Promise.all([candidates, repeated].map(dir => fs.readFile(path.join(dir, 'SHA256SUMS'), 'utf8')));
  if (first !== second) throw new Error('La segunda construcción produjo archivos diferentes.');
}

// El Motor ya viaja en los paquetes. Este archivo añade solo la batería de
// pruebas, sin historial Git, Base, configuración privada ni claves de firma.
const harness = 'pruebas-mind.zip';
const harnessFile = path.join(output, harness);
execFileSync('git', ['archive', '--format=zip', '--output', harnessFile, commit, 'package.json', 'src',
  'test/helpers/mcp-client.js', 'scripts/probar-paquete.mjs', 'scripts/producto-12-casos.mjs',
  'scripts/producto-actualizacion-automatica.mjs', 'scripts/producto-cuarentena-macos.mjs'], { cwd: root });

const name = `Mind-${version}-universal.zip`;
const upgrade = `Mind-${next}-universal.zip`;
const paquete = { name, sha256: await hashFile(path.join(candidates, name)) };
const actualizacion = { name: upgrade, sha256: await hashFile(path.join(upgrades, upgrade)) };
// La matriz contiene cinco ejecuciones, todas sobre los mismos dos archivos.
const packages = plataformas.map(plataforma => ({ plataforma, paquete, actualizacion }));
const matrix = { version, commit, harness: { name: harness, sha256: await hashFile(harnessFile) }, paquetes: packages };
await fs.writeFile(path.join(output, 'matriz.json'), JSON.stringify(matrix, null, 2) + '\n');
