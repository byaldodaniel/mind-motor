#!/usr/bin/env node
// Construye exclusivamente artefactos de ensayo con clave efimera. Nunca publica.
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashFile } from '../src/product-files.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const [destination, reproducibility] = process.argv.slice(2);
if (!destination || (reproducibility && reproducibility !== '--reproducibilidad')) throw new Error('Uso: preparar-paridad.mjs <carpeta nueva> [--reproducibilidad]');
const output = path.resolve(destination);
const { version } = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+$/u.test(version)) throw new Error('El ensayo requiere una version estable.');
const { plataformas } = JSON.parse(await fs.readFile(path.join(root, 'packaging', 'publicacion.json'), 'utf8'));
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
await fs.mkdir(output);
const ephemeral = await fs.mkdtemp(path.join(os.tmpdir(), 'mind-firma-ensayo-'));
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const keyFile = path.join(ephemeral, 'privada.pem'), publicFile = path.join(output, 'clave-ensayo-publica.pem');
await fs.writeFile(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
await fs.writeFile(publicFile, publicKey.export({ type: 'spki', format: 'pem' }));
const script = (name, ...args) => execFileSync(process.execPath, [`scripts/${name}.mjs`, ...args], { cwd: root, stdio: 'inherit' });
const candidates = path.join(output, 'candidatos'), upgrades = path.join(output, 'ensayo');
const cache = process.env.MIND_COMPONENT_CACHE ? ['--cache', path.resolve(process.env.MIND_COMPONENT_CACHE)] : [];
try {
  const build = (directory, revision, official = false) => {
    script('construir-paquetes', ...(official ? ['--sumas-oficiales'] : []), '--revision-paquete', String(revision), '--clave-publicacion', keyFile, '--salida', directory, ...cache);
    script('firmar-actualizacion', '--verificar', version, directory, '--clave-ensayo', publicFile);
  };
  build(candidates, 1, true); build(upgrades, 2);
  if (reproducibility) {
    const repeated = path.join(output, 'repeticion'); build(repeated, 1);
    const sums = await Promise.all([candidates, repeated].map(dir => fs.readFile(path.join(dir, 'SHA256SUMS'), 'utf8')));
    if (sums[0] !== sums[1]) throw new Error('La segunda construccion no es reproducible.');
  }
  const harness = 'pruebas-mind.zip', harnessFile = path.join(output, harness);
  execFileSync('git', ['archive', '--format=zip', '--output', harnessFile, commit, 'package.json', 'src',
    'test/helpers/mcp-client.js', 'scripts/probar-paquete.mjs', 'scripts/producto-12-casos.mjs',
    'scripts/probar-continuidad-nueva.mjs', 'scripts/producto-actualizacion-automatica.mjs', 'scripts/producto-cuarentena-macos.mjs'], { cwd: root });
  const name = `Mind-${version}-universal-r1.zip`, upgrade = `Mind-${version}-universal-r2.zip`;
  const paquete = { name, sha256: await hashFile(path.join(candidates, name)), revision: 1 };
  const actualizacion = { name: upgrade, sha256: await hashFile(path.join(upgrades, upgrade)), revision: 2 };
  const metadata = { formato: 'mind-ensayo-universal', version, commit, firma: 'Ed25519 efimera de ensayo; no es una entrega publicable',
    claveEnsayo: path.basename(publicFile), harness: { name: harness, sha256: await hashFile(harnessFile) },
    // Composicion de cinco destinos; una sola ejecucion funcional en el entorno disponible.
    paquetes: plataformas.map(plataforma => ({ plataforma, paquete, actualizacion })) };
  await fs.writeFile(path.join(output, 'matriz.json'), JSON.stringify(metadata, null, 2) + '\n');
} finally { await fs.rm(ephemeral, { recursive: true, force: true }); }