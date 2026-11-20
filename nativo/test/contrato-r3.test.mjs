// El contrato observable de r3 no cambia sin decidirlo.
// Si esta prueba falla, el Motor cambió algo que una pieza nativa debe respetar:
// revisar el cambio y, si es intencionado, regenerar con
//   node nativo/contracts/r3/capturar.mjs --escribir
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { CONTRACT_FILE, captureContract } from '../contracts/r3/capturar.mjs';

test('contrato r3: Base, catálogo SQLite, HTTP y MCP coinciden con contrato-r3.json', { timeout: 120_000 }, async () => {
  const fixed = JSON.parse(await fs.readFile(CONTRACT_FILE, 'utf8'));
  const live = await captureContract();
  assert.deepEqual(live, fixed);
});
