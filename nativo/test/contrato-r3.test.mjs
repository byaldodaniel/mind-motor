// El contrato observable no cambia sin decidirlo.
// - contrato-r3.json: catálogo completo de r3 (?catalogo=completo), que debe
//   seguir idéntico para poder volver a r3 cliente por cliente.
// - contrato-nucleo.json: catálogo núcleo de 1.0.5 (diez herramientas).
// Si falla y el cambio es intencionado, regenerar con
//   node nativo/contracts/r3/capturar.mjs [--nucleo] --escribir
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { CONTRACT_FILE, CORE_CONTRACT_FILE, captureContract } from '../contracts/r3/capturar.mjs';

for (const [catalogo, file] of [['completo', CONTRACT_FILE], ['nucleo', CORE_CONTRACT_FILE]]) {
  test(`contrato ${catalogo}: Base, catálogo SQLite, HTTP y MCP coinciden con ${file.split(/[\/]/).pop()}`, { timeout: 120_000 }, async () => {
    const fixed = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.deepEqual(await captureContract({ catalogo }), fixed);
  });
}
