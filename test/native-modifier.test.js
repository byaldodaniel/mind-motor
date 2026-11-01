import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Ejecuta las pruebas nativas desde la suite JS para cubrirlas en CI sin
// modificar el lanzador compartido scripts/test.mjs.
test('pruebas nativas de modificación segura', () => {
  const script = fileURLToPath(new URL('./native_modifier_test.py', import.meta.url));
  const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-I', '-B', script], {
    encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, timeout: 120_000, windowsHide: true,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
