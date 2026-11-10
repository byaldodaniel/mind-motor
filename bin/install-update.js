#!/usr/bin/env node
import { updateMind } from '../src/commands/actualizar.js';
import { resolveLayout } from '../src/layout.js';
import fs from 'node:fs/promises';

try {
  const [root, source, version, base, revision = '0', expectedJson, expectedManifestSha256] = process.argv.slice(2);
  const layout = await resolveLayout({ base: base || undefined });
  if (!layout.product || layout.root !== await fs.realpath(root)) throw new Error('Instalación incorrecta.');
  const expectedRelease = expectedJson ? JSON.parse(expectedJson) : { mindVersion: version, packageRevision: Number(revision) };
  const result = await updateMind({ root, source, baseDirectory: layout.baseDirectory, expectedRelease, expectedManifestSha256,
    confirm: summary => summary.to === version && !summary.downgrade
      && (summary.toRevision ?? Number(revision)) === Number(revision),
  });
  if (result.status !== 'actualizada') throw new Error('El paquete no corresponde a la entrega publicada.');
  process.stdout.write(JSON.stringify({ status: result.status, cleanupPending: result.cleanupPending === true }) + '\n');
} catch (error) {
  process.stderr.write(`${JSON.stringify({ code: error.code, message: error.message, prepared: error.prepared, stagePath: error.stagePath })}\n`);
  process.exitCode = 1;
}