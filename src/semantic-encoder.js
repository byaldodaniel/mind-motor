import fs from 'node:fs/promises';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { MotorError } from './errors.js';

const motorLocation = fileURLToPath(new URL('..', import.meta.url));
const defaultSemanticDirectory = path.basename(path.dirname(motorLocation)) === 'Programa' && path.basename(path.dirname(path.dirname(motorLocation))) === 'Sistema'
  ? path.join(path.dirname(path.dirname(motorLocation)), 'Componentes', 'Semantica')
  : path.join(motorLocation, '.cache', 'semantic');

export const SEMANTIC_MODEL = 'multilingual-e5-small-uint8-761b726-sentence-v1';
export const SEMANTIC_DIMENSIONS = 384;
export function createSemanticEncoder({ directory = defaultSemanticDirectory, idleMs = 60_000 } = {}) {
  let worker;
  let sequence = 0;
  let idle;
  let chain = Promise.resolve();
  let closed = false;
  let loaded = false;
  const pending = new Map();
  async function available() {
    try { await fs.access(path.join(directory, 'manifest.json')); return true; } catch { return false; }
  }
  function stop() {
    clearTimeout(idle);
    const current = worker;
    worker = undefined;
    loaded = false;
    if (current) return current.terminate();
  }
  function start() {
    if (worker) return;
    const current = new Worker(new URL('./semantic-worker.js', import.meta.url), { workerData: { directory }, execArgv: [] });
    worker = current;
    current.on('message', message => {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      clearTimeout(request.timer);
      message.error ? request.reject(new MotorError('SEMANTIC_FAILED', message.error)) : request.resolve(message.vectors);
    });
    const failed = error => {
      if (worker === current) worker = undefined;
      for (const [id, request] of pending) {
        if (request.worker !== current) continue;
        clearTimeout(request.timer); request.reject(error); pending.delete(id);
      }
    };
    current.on('error', failed);
    current.on('exit', code => failed(new MotorError('SEMANTIC_FAILED', `Inferencia terminada (${code}).`)));
  }
  async function embed(texts, { signal, kind = 'passage' } = {}) {
    const job = chain.catch(() => {}).then(async () => {
      signal?.throwIfAborted();
      if (closed) throw new MotorError('SEMANTIC_CLOSED', 'La inferencia está cerrada.');
      if (!(await available())) throw new MotorError('SEMANTIC_UNAVAILABLE', 'El componente semántico local no está preparado.');
      clearTimeout(idle);
      start();
      worker.ref();
      const vectors = await new Promise((resolve, reject) => {
        const id = ++sequence;
        const abort = () => { stop(); };
        signal?.addEventListener('abort', abort, { once: true });
        const finish = callback => value => { signal?.removeEventListener('abort', abort); callback(value); };
        const timer = setTimeout(() => { stop(); }, 120_000);
        pending.set(id, { resolve: finish(resolve), reject: finish(reject), timer, worker });
        worker.postMessage({ id, texts: texts.map(text => (kind === 'query' ? 'query: ' : 'passage: ') + text) });
      });
      signal?.throwIfAborted();
      loaded = true;
      if (!Array.isArray(vectors) || vectors.length !== texts.length || vectors.some(v =>
        !Array.isArray(v) || v.length !== SEMANTIC_DIMENSIONS || v.some(x => !Number.isFinite(x)))) {
        throw new MotorError('SEMANTIC_FAILED', 'Vectores de inferencia no válidos.');
      }
      idle = setTimeout(stop, idleMs); idle.unref();
      worker?.unref();
      return vectors;
    });
    chain = job;
    return job;
  }
  return { model: SEMANTIC_MODEL, available, embed, isReady: () => Boolean(worker && loaded), close() { closed = true; return stop(); } };
}
