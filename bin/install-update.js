#!/usr/bin/env node
import { updateMind } from '../src/commands/actualizar.js';
import { resolveLayout } from '../src/layout.js';

try {
  const [root, source, version, base] = process.argv.slice(2);
  const layout = await resolveLayout({ base: base || undefined });
  if (!layout.product || layout.root !== root) throw new Error('Instalación incorrecta.');
  const result = await updateMind({ root, source, baseDirectory: layout.baseDirectory,
    confirm: summary => summary.to === version && !summary.downgrade && !summary.reinstall,
  });
  if (result.status !== 'actualizada') throw new Error('El paquete no corresponde a la versión publicada.');
} catch (error) {
  process.stderr.write(`${JSON.stringify({ code: error.code, message: error.message })}\n`);
  process.exitCode = 1;
}
