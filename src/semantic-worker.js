import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';

let extractor;
async function load() {
  const directory = workerData.directory;
  const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'));
  // Código y pesos pertenecen al programa de confianza, nunca a la Base del usuario.
  for (const file of manifest.files) {
    const absolute = path.resolve(directory, file.path);
    if (!absolute.startsWith(path.resolve(directory) + path.sep)) throw new Error('Componente fuera del programa.');
    const info = await fs.lstat(absolute);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Componente no regular.');
    const digest = createHash('sha256').update(await fs.readFile(absolute)).digest('hex');
    if (digest !== file.sha256) throw new Error('Componente semántico alterado.');
  }
  const ort = await import(pathToFileURL(path.join(directory, 'ort.mjs')).href);
  globalThis[Symbol.for('onnxruntime')] = ort;
  const { pipeline, env } = await import(pathToFileURL(path.join(directory, 'transformers.mjs')).href);
  env.allowLocalModels = false;
  env.useBrowserCache = false;
  env.useFSCache = false;
  env.useCustomCache = true;
  env.customCache = { async match(key) {
    const pathname = new URL(key).pathname;
    const prefix = '/Xenova/multilingual-e5-small/resolve/main/';
    if (!pathname.startsWith(prefix)) return;
    const relative = pathname.slice(prefix.length);
    if (!['config.json','tokenizer_config.json','tokenizer.json','special_tokens_map.json','onnx/model_uint8.onnx'].includes(relative)) return;
    return new Response(await fs.readFile(path.join(directory, 'model', relative)));
  }, async put() {} };
  // No peticiones remotas, ni siquiera para pesos o archivos opcionales ausentes.
  globalThis.fetch = async () => { throw new Error('Inferencia local: red deshabilitada.'); };
  env.backends.onnx.wasm.numThreads = 1;
  env.backends.onnx.wasm.wasmPaths = pathToFileURL(directory + path.sep).href;
  extractor = await pipeline('feature-extraction', 'Xenova/multilingual-e5-small', {
    dtype: 'uint8', device: 'auto', session_options: { executionProviders: ['wasm'] },
  });
}
parentPort.on('message', async ({ id, texts }) => {
  try {
    if (!extractor) await load();
    const tensor = await extractor(texts, { pooling: 'mean', normalize: true, truncation: true, max_length: 512 });
    parentPort.postMessage({ id, vectors: tensor.tolist() });
  } catch (error) { parentPort.postMessage({ id, error: String(error.message).slice(0, 300) }); }
});
