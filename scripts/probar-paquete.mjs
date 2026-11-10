#!/usr/bin/env node
// Comprueba dos paquetes en el destino nativo, con datos y firma de ensayo.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractEntries, readArchive } from '../src/archive.js';
import { hashFile, readManifestFile, supportsProductTarget } from '../src/product-files.js';
import { productRuntime } from '../src/layout.js';

import { verifyPackageDescriptor } from '../src/package-descriptor.js';
const [archive, update, archiveHash, updateHash, reportDir, ...options] = process.argv.slice(2);
let claude, testPublicKeyFile, updatePublicKeyFile;
for (let index = 0; index < options.length; index += 2) {
  if (!options[index + 1]) throw new Error('Falta el valor de una opcion de prueba.');
  if (options[index] === '--claude') claude = options[index + 1];
  else if (options[index] === '--clave-ensayo') testPublicKeyFile = options[index + 1];
  else if (options[index] === '--clave-actualizacion-ensayo') updatePublicKeyFile = options[index + 1];
  else throw new Error('Opcion de prueba no reconocida.');
}
if (!archive || !update || !archiveHash || !updateHash || !reportDir) {
  throw new Error('Uso: probar-paquete.mjs <paquete> <actualización de ensayo> <sha256 paquete> <sha256 actualización> <informes> [--claude <orden>]');
}
const hashes = await Promise.all([hashFile(archive), hashFile(update)]);
if (hashes[0] !== archiveHash || hashes[1] !== updateHash) throw new Error('Los paquetes no coinciden con las huellas esperadas.');

const platform = `${process.platform}-${process.arch}`;
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'Mind prueba ñ-'));
const report = { plataforma: platform, paquete_sha256: hashes[0], actualizacion_sha256: hashes[1], resultado: 'fallido' };
const readReport = async name => JSON.parse(await fs.readFile(path.join(temporary, name), 'utf8'));

const publicKey = testPublicKeyFile ? await fs.readFile(testPublicKeyFile, 'utf8') : JSON.parse(await fs.readFile(fileURLToPath(new URL('../src/update-channel.json', import.meta.url)), 'utf8')).publicKey;

async function extract(folder, source = archive) {
  const destination = path.join(temporary, folder);
  await extractEntries(readArchive(source), destination);
  const product = path.join(destination, 'My Mind');
  const trustedKey=source===update&&updatePublicKeyFile?await fs.readFile(updatePublicKeyFile,'utf8'):publicKey;
  await verifyPackageDescriptor({ root: product, publicKey:trustedKey });
  return product;
}

function run(node, script, args) {
  const result = spawnSync(node, [fileURLToPath(new URL(script, import.meta.url)), ...args], {
    stdio: 'inherit', windowsHide: true, timeout: 1_200_000,
  });
  if (result.error) throw result.error;
  return result.status === 0;
}

try {
  const mind = await extract('Producto');
  const updateRoot = await extract('Actualizacion', update);
  const next = await readManifestFile(updateRoot);
  const initial = await readManifestFile(mind);
  if (next.mindVersion !== initial.mindVersion || next.packageRevision <= initial.packageRevision) throw new Error('El ensayo debe aumentar revision manteniendo la version publica.');
  report.firma = testPublicKeyFile ? 'clave efimera de ensayo' : 'clave de distribucion fijada';
  const manifest = await readManifestFile(mind);
  if (!supportsProductTarget(manifest)) {
    throw new Error(`El paquete no corresponde al destino nativo ${platform}.`);
  }
  report.version = manifest.mindVersion;
  report.commit = manifest.builtFrom;
  const { nodeExecutable: node } = productRuntime(mind, manifest);

  const newUser = run(node, './probar-continuidad-nueva.mjs', ['--mind', mind, '--informe', path.join(temporary, 'usuario-nuevo.json')]);
  const newUserReport = await readReport('usuario-nuevo.json');
  report.usuario_nuevo = newUserReport;

  const auto = run(node, './producto-actualizacion-automatica.mjs', [mind, path.resolve(update), path.join(temporary, 'auto.json')]);
  const autoReport = await readReport('auto.json');
  report.actualizacion_automatica = {
    resultado: autoReport.resultado, desde: autoReport.desde, hasta: autoReport.hasta, transporte: 'HTTPS de ensayo',
  };

  const product = run(node, './producto-12-casos.mjs', [
    '--mind', mind, '--actualizacion', path.resolve(update), '--informe', path.join(temporary, 'producto.json'),
    ...(claude ? ['--claude', claude] : []),
  ]);
  const productReport = await readReport('producto.json');
  report.casos = productReport.casos.map(({ caso, nombre, tipo, resultado }) => ({ caso, nombre, tipo, resultado }));
  const allRequired = productReport.casos.length === 25 && productReport.casos.every(
    ({ caso, resultado }) => resultado === 'superado' || (caso === 4 && resultado === 'pendiente' && !claude),
  );

  let quarantine = true;
  if (process.platform === 'darwin') {
    const fresh = await extract('Cuarentena');
    execFileSync('/usr/bin/xattr', ['-r', '-w', 'com.apple.quarantine', '0083;00000000;Safari;', fresh]);
    quarantine = run(productRuntime(fresh, manifest).nodeExecutable, './producto-cuarentena-macos.mjs', ['--mind', fresh]);
    report.cuarentena_simulada = quarantine ? 'superada' : 'fallida';
    report.primera_apertura_grafica = 'pendiente de comprobación independiente';
  }

  if (!newUser || newUserReport.resultado !== 'superado' || !auto || !product || !allRequired || !quarantine) throw new Error(`Pruebas de producto incompletas en ${platform}.`);
  report.resultado = 'superado';
} finally {
  await fs.mkdir(reportDir, { recursive: true });
  await fs.writeFile(path.join(reportDir, `informe-${platform}.json`), JSON.stringify(report, null, 2) + '\n');
  await fs.rm(temporary, { recursive: true, force: true });
}
