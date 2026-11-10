// Preparación de desarrollo/empaquetado; nunca se ejecuta durante una búsqueda.
// Descargas públicas fijadas por revisión e integridad. No envía información del usuario.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { readArchive } from '../src/archive.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const directory = path.join(root, '.cache', 'semantic');
const cache = path.join(root, '.cache', 'semantic-downloads');
const config = JSON.parse(await fs.readFile(path.join(root, 'packaging', 'semantica.json'), 'utf8'));
await fs.mkdir(cache, { recursive: true });
const written = new Map();
async function download(url, filename, algorithm, expected) {
  let data;
  try { data = await fs.readFile(filename); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!data || createHash(algorithm).update(data).digest(algorithm === 'sha512' ? 'base64' : 'hex') !== expected) {
    const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
    if (!response.ok) throw new Error('Descarga fallida: ' + url + ' ' + response.status);
    data = Buffer.from(await response.arrayBuffer());
    if (createHash(algorithm).update(data).digest(algorithm === 'sha512' ? 'base64' : 'hex') !== expected) throw new Error('Integridad incorrecta: ' + url);
    await fs.writeFile(filename, data);
  }
  return data;
}
async function write(relative, data) {
  const target = path.join(directory, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, data);
  written.set(relative, { path: relative, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') });
}
for (const component of config.packages) {
  const archive = path.join(cache, component.url.split('/').pop());
  await download(component.url, archive, 'sha512', component.integrity.slice(7));
  for await (const entry of readArchive(archive)) {
    if (entry.type !== 'file') continue;
    const name = entry.path ?? entry.name;
    let destination;
    if (component.name === '@huggingface/transformers' && name === 'package/dist/transformers.min.js') destination = 'transformers.mjs';
    if (component.name === 'onnxruntime-web') {
      if (name === 'package/dist/ort.node.min.mjs') destination = 'ort.mjs';
      if (/^package\/dist\/ort-wasm-simd-threaded\.(mjs|wasm)$/.test(name)) destination = name.slice('package/dist/'.length);
    }
    if (component.name === 'onnxruntime-common' && name.startsWith('package/dist/esm/') && name.endsWith('.js')) destination = 'common/' + name.slice('package/dist/esm/'.length);
    if (/^package\/LICENSE(?:\.txt)?$/i.test(name)) destination = 'licenses/' + component.name.replaceAll('/','-').replace('@','') + '.txt';
    if (!destination) continue;
    const pieces = [];
    for await (const piece of entry.content()) pieces.push(piece);
    let data = Buffer.concat(pieces);
    if (destination === 'ort.mjs') data = Buffer.from(data.toString('utf8').replaceAll('"onnxruntime-common"', '"./common/index.js"'));
    await write(destination, data);
  }
}
for (const file of config.model.files) {
  const filename = path.join(cache, file.sha256);
  const data = await download(`https://huggingface.co/${config.model.model}/resolve/${config.model.revision}/${file.path}`,
    filename, 'sha256', file.sha256);
  await write('model/' + file.path, data);
}
for (const file of config.extras) {
  const data = await download(file.url, path.join(cache, file.sha256), 'sha256', file.sha256);
  await write(file.path, data);
}
await write('NOTICE.txt', Buffer.from('Modelo: intfloat/multilingual-e5-small (MIT), conversión ONNX Xenova.\nhttps://huggingface.co/intfloat/multilingual-e5-small\nTransformers.js 3.8.1 (Apache-2.0); ONNX Runtime Web y Common (MIT).\nOrt: importaciones de onnxruntime-common reescritas a ./common/index.js, sin otros cambios.\n'));
await write('package.json', Buffer.from('{"type":"module"}\n'));
for (const required of ['transformers.mjs','ort.mjs','common/index.js','ort-wasm-simd-threaded.mjs','ort-wasm-simd-threaded.wasm']) {
  if (!written.has(required)) throw new Error('Componente incompleto: ' + required);
}
const manifest = { format: 'mind-semantic-bundle', version: 1, model: config.model.model,
  revision: config.model.revision, files: [...written.values()].sort((a,b) => a.path.localeCompare(b.path)) };
await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ directory, files: written.size, bytes: [...written.values()].reduce((sum,x) => sum + x.bytes, 0) }));
