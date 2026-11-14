import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { writeZip } from '../src/archive.js';
import { UNIVERSAL_TARGETS } from '../src/product-files.js';
import { createSignedPackageDescriptor } from '../src/package-descriptor.js';

const source = fileURLToPath(new URL('..', import.meta.url));
const hash = data => createHash('sha256').update(data).digest('hex');
const author = base => ({ nombre: 'Ensayo ficticio', resumen: 'Entrega para comprobar el firmante.',
  cambios: [{ titulo: 'Cambio ficticio', tipo: 'mejora' }], importancia: 'normal',
  impacto_datos: { base, conversaciones: 'intactas', carpetas_autorizadas: 'intactas' } });

// El script se ejecuta sin alteraciones en un repositorio de ensayo con su propia
// ancla de confianza. No se lee ni se escribe la clave/configuración del canal real.
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mind-firmar-integracion-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const directory of ['src', 'scripts', 'packaging', 'paquetes']) await fs.mkdir(path.join(root, directory));
  for (const relative of ['scripts/firmar-actualizacion.mjs', 'src/archive.js', 'src/errors.js', 'src/product-files.js',
    'src/layout.js', 'src/package-descriptor.js', 'src/release-notes.js', 'packaging/publicacion.json']) {
    await fs.copyFile(path.join(source, relative), path.join(root, relative));
  }
  await fs.writeFile(path.join(root, 'package.json'), '{"type":"module"}');
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Ensayo', '-c', 'user.email=ensayo@example.invalid', 'commit', '--allow-empty', '--quiet', '-m', 'Ensayo ficticio'], { cwd: root });
  const builtFrom = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  await fs.writeFile(path.join(root, 'ensayo.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }));
  await fs.writeFile(path.join(root, 'src/update-channel.json'), JSON.stringify({ repository: 'ensayo/mind', publicKey: publicKey.export({ type: 'spki', format: 'pem' }) }));
  async function archive(file, { version = '1.0.5', baseFormatVersion = 2, changed = true } = {}) {
    const content = { 'Sistema/Programa/Motor/bin/mind.js': changed ? 'console.log("nuevo ficticio");' : 'console.log("anterior ficticio");',
      'Sistema/mind': '#!/bin/sh\n', 'Sistema/mind.cmd': '@echo off\r\n', 'Sistema/Autorizar Mind.command': '#!/bin/sh\n' };
    for (const target of UNIVERSAL_TARGETS) {
      content[`Sistema/Componentes/Node/${target}/${target.startsWith('win32') ? 'node.exe' : 'bin/node'}`] = 'node ficticio';
      content[`Sistema/Componentes/Python/${target}/${target.startsWith('win32') ? 'python.exe' : 'bin/python3'}`] = 'python ficticio';
    }
    const manifest = { format: 'mind-product', version: 1, mindVersion: version, platform: 'win32', arch: 'x64',
      targets: UNIVERSAL_TARGETS, layoutVersion: 2, updateProtocolVersion: 2, packageRevision: 1, baseFormatVersion, builtFrom,
      files: Object.fromEntries(Object.entries(content).map(([name, data]) => [name, hash(data)])) };
    const manifestBytes = JSON.stringify(manifest) + '\n';
    const entries = Object.entries({ ...content, 'Sistema/mind-producto.json': manifestBytes,
      'Sistema/entrega-firmada.json': JSON.stringify(createSignedPackageDescriptor({ manifest, manifestBytes, privateKey })) })
      .map(([name, data]) => ({ path: name, type: 'file', mode: name.endsWith('.exe') || name.endsWith('.cmd') || name.endsWith('.json') || name.endsWith('.js') ? 0o644 : 0o755, source: { data } }));
    await writeZip(file, entries, { root: 'My Mind', mtime: 1700000000 });
    return { manifest, programaBytes: Object.values(content).reduce((sum, data) => sum + Buffer.byteLength(data), 0) };
  }
  const currentZip = path.join(root, 'paquetes/Mind-1.0.5-universal-r1.zip');
  const previousZip = path.join(root, 'anterior.zip');
  const current = await archive(currentZip);
  await archive(previousZip, { version: '1.0.4', baseFormatVersion: 1, changed: false });
  return { root, publicKey, previousZip, currentZip, current, archive,
    async run(base, output, extra = []) {
      await fs.writeFile(path.join(root, 'novedades.json'), JSON.stringify(author(base)));
      return spawnSync(process.execPath, [path.join(root, 'scripts/firmar-actualizacion.mjs'), '1.0.5', path.join(root, 'ensayo.pem'),
        path.join(root, 'paquetes'), path.join(root, output), '--novedades', path.join(root, 'novedades.json'), ...extra], { cwd: root, encoding: 'utf8' });
    },
  };
}

test('firmante completo: ZIP universal real, firma efímera y contraste con --anterior', async t => {
  const f = await fixture(t);
  const rejected = await f.run('sin-cambios', 'rechazado.json', ['--anterior', f.previousZip]);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /impacto_datos.base.*baseFormatVersion cambia de 1 a 2.*--anterior/u);
  await assert.rejects(fs.stat(path.join(f.root, 'rechazado.json')), { code: 'ENOENT' });
  for (const base of ['migracion-automatica', 'requiere-copia']) {
    const output = base + '.json', result = await f.run(base, output, ['--anterior', f.previousZip]);
    assert.equal(result.status, 0, result.stderr);
    const envelope = JSON.parse(await fs.readFile(path.join(f.root, output), 'utf8'));
    const payloadBytes = Buffer.from(envelope.payload, 'base64');
    assert.equal(verify(null, payloadBytes, f.publicKey, Buffer.from(envelope.signature, 'base64')), true);
    const payload = JSON.parse(payloadBytes);
    assert.equal(payload.novedades.impacto_datos.base, base);
    assert.equal(payload.novedades.comprobado.baseFormatVersion, 2);
    assert.equal(payload.novedades.comprobado.programaBytes, f.current.programaBytes);
    assert.equal(payload.novedades.comprobado.paqueteBytes, (await fs.stat(f.currentZip)).size);
    assert.deepEqual(payload.novedades.comprobado.gruposCambiados, ['Sistema/Programa/Motor']);
    assert.equal(payload.novedades.comprobado.descargaParcialBytes, Buffer.byteLength('console.log("nuevo ficticio");'));
    assert.equal(payload.packages[0].sha256, hash(await fs.readFile(f.currentZip)));
  }
  const sameFormatZip = path.join(f.root, 'anterior-mismo-formato.zip');
  await f.archive(sameFormatZip, { version: '1.0.4', baseFormatVersion: 2, changed: false });
  const unchanged = await f.run('sin-cambios', 'sin-cambios.json', ['--anterior', sameFormatZip]);
  assert.equal(unchanged.status, 0, unchanged.stderr);
  const noPrevious = await f.run('sin-cambios', 'sin-anterior.json');
  assert.equal(noPrevious.status, 0, noPrevious.stderr);
  const noPreviousPayload = JSON.parse(Buffer.from(JSON.parse(await fs.readFile(path.join(f.root, 'sin-anterior.json'), 'utf8')).payload, 'base64'));
  assert.equal(noPreviousPayload.novedades.comprobado.gruposCambiados, null);
});
