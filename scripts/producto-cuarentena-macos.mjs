#!/usr/bin/env node
// macOS: comprueba con una carpeta de Mind recién extraída y marcada en
// cuarentena (como la deja un navegador) que, al iniciar Mind como lo hace el
// agente, Mind verifica sus runtimes y retira la marca SOLO de su carpeta
// Runtime, y que después el Python incluido funciona (indexa una carpeta).
//
//   <Mind>/Runtime/node/bin/node scripts/producto-cuarentena-macos.mjs --mind <carpeta-de-Mind>
//
// Requisito: los archivos de <Mind> ya llevan com.apple.quarantine
// (xattr -r -w com.apple.quarantine ... <Mind>). Esto no reproduce el aviso
// gráfico de Gatekeeper; comprueba el tratamiento que Mind hace de la marca.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startMcp } from '../test/helpers/mcp-client.js';
import { readManifestFile } from '../src/product-files.js';
import { productPaths, productRuntime } from '../src/layout.js';

const at = process.argv.indexOf('--mind');
if (process.platform !== 'darwin' || at < 0) {
  process.stderr.write('Uso (solo macOS): node scripts/producto-cuarentena-macos.mjs --mind <carpeta-de-Mind>\n');
  process.exit(2);
}
const mind = await fs.realpath(process.argv[at + 1]);
const ATTRIBUTE = 'com.apple.quarantine';
const marked = (target) => spawnSync('/usr/bin/xattr', ['-p', ATTRIBUTE, target]).status === 0;
const quarantinedIn = (directory) => spawnSync('/usr/bin/find', [directory, '-xattrname', ATTRIBUTE, '-print'], { encoding: 'utf8' })
  .stdout.split('\n').filter(Boolean);
const fail = (message) => {
  process.stdout.write(`✖ ${message}\n`);
  process.exit(1);
};

const manifest = await readManifestFile(mind);
const runtime = productRuntime(mind, manifest);
const python = await fs.realpath(runtime.pythonExecutable);
if (!marked(python) || !marked(path.join(mind, 'LEEME.md'))) fail('La carpeta no está marcada en cuarentena: no hay nada que comprobar.');
process.stdout.write(`Antes: ${(runtime.directories ?? [runtime.directory]).flatMap(quarantinedIn).length} entradas del runtime activo en cuarentena.\n`);

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'mind-cuarentena-'));
const folder = path.join(temporary, 'Ficticia');
await fs.mkdir(folder);
await fs.writeFile(path.join(folder, 'nota.txt'), 'Nota ficticia\n');
if (manifest.targets) {
  const prepared = spawnSync(runtime.nodeExecutable, [productPaths(mind,manifest).entrypoint, 'preparar'], { encoding: 'utf8' });
  if (prepared.status !== 0) fail(`No se preparó la configuración del agente: ${prepared.stderr}`);
}
const config = JSON.parse(await fs.readFile(path.join(mind, '.mcp.json'), 'utf8')).mcpServers.mind;
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(path|node_options|mind_base|mind_python)$/iu.test(key)));
env.PATH = temporary;
const client = startMcp({
  command: path.join(mind, config.command), commandArgs: config.args, cwd: mind, baseEnv: env, env: config.env,
  onElicit: () => ({ action: 'accept', content: { acceso: 'leer' } }),
});
try {
  const init = await client.initialize();
  if (init.result?.serverInfo?.name !== 'mind') fail(`El servidor no respondió: ${client.stderr().slice(-500)}`);
  if (/cuarentena/iu.test(init.result.instructions ?? '')) fail(`Mind avisó de un problema con la cuarentena: ${init.result.instructions}`);
  const granted = await client.call('solicitar_acceso', { ruta: folder, acceso: 'leer' });
  if (granted.data?.estado !== 'autorizado') fail(`Autorización: ${JSON.stringify(granted.data)}`);
  let indexed = null;
  for (let attempt = 0; attempt < 150 && !indexed; attempt += 1) {
    const status = (await client.call('estado')).data;
    if (status.carpetas[0]?.indice?.estado === 'vigente') indexed = status.carpetas[0].indice;
    else await delay(200);
  }
  if (!indexed) fail(`El Python incluido no indexó la carpeta: ${client.stderr().slice(-800)}`);
  const read = await client.call('leer', { ruta: 'nota.txt' });
  if (!/Nota ficticia/u.test(read.data?.contenido ?? '')) fail(`Lectura: ${JSON.stringify(read.data)}`);
} finally {
  await client.close();
  await fs.rm(temporary, { recursive: true, force: true });
}

const remaining = (runtime.directories ?? [runtime.directory]).flatMap(quarantinedIn);
if (remaining.length > 0) fail(`Quedan archivos de Runtime en cuarentena: ${remaining.slice(0, 5).join(', ')}`);
if (!marked(path.join(mind, 'LEEME.md')) || !marked(path.join(productPaths(mind,manifest).launcherDirectory, 'mind'))) fail('Mind retiró la cuarentena fuera de su carpeta Runtime.');
if (manifest.targets && !marked(productRuntime(mind,manifest,'win32','x64').nodeExecutable)) fail('Mind retiró la cuarentena del runtime de Windows.');
if (!/Cuarentena de macOS retirada/u.test(client.stderr())) fail('El registro de Mind no anota la retirada verificada.');
process.stdout.write('✔ Mind verificó sus runtimes, retiró la cuarentena solo de Runtime y el Python incluido indexó y leyó una carpeta ficticia.\n');
