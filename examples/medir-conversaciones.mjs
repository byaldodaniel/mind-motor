// Medición local reproducible; datos ficticios y Base temporal fuera del repositorio.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { openMotor } from '../src/motor.js';

const base = await fs.mkdtemp(path.join(os.tmpdir(), 'mind-conversation-bench-'));
try {
  const motor = await openMotor({ baseDirectory: base });
  const count = 1000;
  for (let i = 0; i < count; i++) {
    await motor.saveConversation({ title: 'Ensayo ficticio ' + i,
      important: 'Decisión aprobada: conservar 23 unidades. Clave de referencia clave' + i + '.',
      project: 'Proyecto ' + (i % 10) });
  }
  const start = performance.now();
  const cold = await motor.searchConversations({ mode: 'palabras', query: 'clave42' });
  const coldMs = performance.now() - start;
  assert.equal(cold.total, 1);
  const samples = [];
  for (let i = 0; i < 20; i++) {
    const before = performance.now();
    const found = await motor.searchConversations({ mode: 'palabras', query: 'clave' + (i * 43) });
    samples.push(performance.now() - before);
    assert.equal(found.total, 1);
    assert.equal(found.index.read, 0);
  }
  const direct = [];
  for (let i = 0; i < 20; i++) {
    const before = performance.now();
    await motor.getConversation(cold.results[0].id);
    direct.push(performance.now() - before);
  }
  const stats = values => {
    const sorted = [...values].sort((a,b) => a-b);
    return { medianMs: Number(((sorted[9] + sorted[10]) / 2).toFixed(2)),
      p95Ms: Number(sorted[18].toFixed(2)) };
  };
  console.log(JSON.stringify({ count, querySamples: 20, coldMs: Number(coldMs.toFixed(2)),
    coldRecordsRead: cold.index.read, indexedSearch: stats(samples), directRead: stats(direct),
    unchangedRecordsReadPerSearch: 0, excerptMaxChars: 500,
    scope: 'Motor local real: incluye reconciliación de metadatos e índice FTS5 en disco. Sin modelo, sin red, sin búsqueda semántica.' }, null, 2));
} finally {
  assert.equal(path.dirname(base), os.tmpdir());
  assert.ok(path.basename(base).startsWith('mind-conversation-bench-'));
  await fs.rm(base, { recursive: true, force: true });
}
