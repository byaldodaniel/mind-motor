import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import test from 'node:test';
import { checkHealthyConnector, postRpc, readConsoleToken } from '../../src/connector.js';
import { main } from '../../src/product-cli.js';
import { RUNS } from './runs.mjs';

const binary = process.env.MIND_NATIVE_EXE;
const drive = process.env.MIND_TEST_DRIVEFS_ROOT;
const run = promisify(execFile);
const prefix = 'mind-archivos-prueba-';

async function removeFixture(folder, parent) {
  assert.equal(path.resolve(folder), folder);
  assert.equal(path.dirname(folder), parent);
  assert.match(path.basename(folder), /^mind-archivos-prueba-[A-Za-z0-9]{6}$/u);
  const info = await fs.lstat(folder);
  assert.ok(info.isDirectory() && !info.isSymbolicLink());
  await fs.rm(folder, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });
  await assert.rejects(fs.lstat(folder), { code: 'ENOENT' });
}

async function nativeClient(t, base, workspace) {
  const child = spawn(path.resolve(binary), ['motor', '--base', base, '--conector'], {
    cwd: base, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, MIND_AGENT_STARTUP: '0' },
  });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', part => { stderr = (stderr + part).slice(-2000); });
  const closed = new Promise(resolve => child.once('close', resolve));
  let active;
  t.after(async () => {
    if (active) {
      await postRpc({ port: active.health.port, token: active.token, payload: { accion: 'apagar' }, timeoutMs: 4000 }).catch(() => {});
    }
    if (!await Promise.race([closed.then(() => true), delay(3000, false, { ref: false })])) child.kill();
    await closed;
  });
  child.on('error', error => { stderr = error.message; });
  for (let attempt = 0; attempt < 100; attempt++) {
    assert.ok(child.pid && child.exitCode === null, 'El Motor no arrancó. ' + stderr);
    active = await checkHealthyConnector(base).catch(() => null);
    if (active?.health.pid === child.pid) break;
    await delay(100);
  }
  assert.equal(active?.health.pid, child.pid, stderr);
  const consoleToken = await readConsoleToken(base);
  assert.ok(consoleToken);
  const consoleCall = async (operacion, args) => {
    const reply = await postRpc({
      port: active.health.port, token: active.token, timeoutMs: 8000, headers: { 'X-Mind-Consola': consoleToken },
      payload: { accion: 'consola', operacion, ...args },
    });
    assert.equal(reply.ok, true, JSON.stringify(reply));
    return reply;
  };
  const { carpeta } = await consoleCall('autorizar_carpeta', { ruta: workspace });
  await consoleCall('guardar_acceso', { id: carpeta.id, permisos: ['encontrar', 'leer', 'escribir', 'organizar'], canal: 'consola' });
  const headers = { Authorization: 'Bearer ' + active.token, Accept: 'application/json', 'Content-Type': 'application/json' };
  let id = 0;
  async function send(method, params) {
    const reply = await fetch(active.url + '/mcp', { method: 'POST', headers, redirect: 'error',
      signal: AbortSignal.timeout(10000), body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    });
    assert.equal(reply.status, 200);
    const { error, result } = await reply.json();
    assert.equal(error, undefined, JSON.stringify(error));
    return { result, session: reply.headers.get('mcp-session-id') };
  }
  const initialized = await send('initialize', { protocolVersion: '2025-11-25', capabilities: {},
    clientInfo: { name: 'Laboratorio de archivos', version: '1' } });
  headers['Mcp-Session-Id'] = initialized.session;
  headers['MCP-Protocol-Version'] = initialized.result.protocolVersion;
  return async (name, args, errorCode) => {
    const { result } = await send('tools/call', { name, arguments: { carpeta: carpeta.id, ...args } });
    const data = result.structuredContent;
    if (errorCode) assert.equal(data.error?.codigo, errorCode, JSON.stringify(data));
    else assert.equal(Boolean(result.isError), false, name + ' ' + JSON.stringify(data));
    return data;
  };
}

async function confirmDeletion(base) {
  const input = new PassThrough(), output = new PassThrough();
  input.isTTY = true;
  output.isTTY = true;
  output.columns = 100;
  let transcript = '';
  let approved = false;
  output.on('data', chunk => {
    transcript += chunk;
    if (!approved && transcript.includes('¿Mover a la papelera?')) {
      approved = true;
      setImmediate(() => input.write('s\n'));
    }
  });
  const deadline = setTimeout(() => input.end(), 10000);
  const startup = process.env.MIND_AGENT_STARTUP;
  process.env.MIND_AGENT_STARTUP = '0';
  try {
    const status = await main(['autorizar', '--base', base], { input, output });
    assert.ok(approved, transcript);
    assert.equal(status, 0, transcript);
    assert.match(transcript, /Movido a la papelera de Mind/u);
  } finally {
    clearTimeout(deadline);
    if (startup === undefined) delete process.env.MIND_AGENT_STARTUP;
    else process.env.MIND_AGENT_STARTUP = startup;
    input.end();
    output.end();
  }
}

for (const variant of ['disco local', 'DriveFS']) {
  const virtual = variant === 'DriveFS';
  test('Archivos del Motor en ' + variant, {
    skip: (!binary || (virtual && (process.platform !== 'win32' || !drive))) && 'Indica los ejecutables y el volumen de prueba',
    timeout: 60000,
  }, async t => {
    const lab = await fs.mkdtemp(path.join(RUNS, prefix));
    let sandbox = lab;
    try {
      let parent;
      if (virtual) {
        assert.equal(path.win32.resolve(drive).toLowerCase(), 'g:\\mi unidad');
        const original = await fs.lstat(drive);
        assert.ok(original.isDirectory() && !original.isSymbolicLink());
        parent = path.win32.resolve(drive);
        sandbox = await fs.mkdtemp(path.join(parent, prefix));
      }
      // Stop the Motor before removing the Base or the DriveFS directory.
      const cleanup = [];
      try {
        const folder = path.join(sandbox, 'Documentos');
        const base = path.join(lab, 'Base');
        await fs.mkdir(folder);
        await fs.mkdir(base);
        await fs.writeFile(path.join(folder, 'Semilla.txt'), 'Texto inicial ficticio.\n');
        const call = await nativeClient({ after: fn => cleanup.push(fn) }, base, folder);
        // Index the seed first: browsing must see newly added files without rewriting that index.
        const search = consulta => call('buscar', { en: 'archivos', consulta });
        assert.deepEqual((await search('Semilla')).resultados.map(item => item.ruta), ['Semilla.txt'], 'indexar y buscar');
        const indexes = (await fs.readdir(base)).filter(name => /^folder-index-[a-f0-9]{64}\.json$/u.test(name));
        assert.equal(indexes.length, 1);
        const indexFile = path.join(base, indexes[0]);
        await fs.unlink(indexFile);
        const unindexed = await call('crear', { ruta: 'SinIndice.txt', contenido: 'Contenido.' });
        assert.equal(unindexed.indice, 'not-indexed');
        const seed = await call('leer', { ruta: 'Semilla.txt' });
        const edited = await call('modificar', { ruta: 'Semilla.txt', version: seed.version, contenido: 'Semilla nueva.\n' });
        assert.equal(edited.indice, 'not-indexed');
        const restored = await call('editar', { ruta: 'Semilla.txt', ediciones: [{ buscar: 'Semilla nueva.', reemplazar: 'Texto inicial ficticio.' }] });
        assert.equal(restored.indice, 'not-indexed');
        await assert.rejects(fs.stat(indexFile), { code: 'ENOENT' });
        assert.deepEqual((await search('Semilla')).resultados.map(item => item.ruta), ['Semilla.txt']);
        const indexBefore = await fs.readFile(indexFile);
        await fs.mkdir(path.join(folder, 'Visible', 'Segundo'), { recursive: true });
        await fs.writeFile(path.join(folder, 'Visible', 'Segundo', 'Interior.txt'), 'Prueba');
        const explore = profundidad => call('buscar', { en: 'carpeta', ruta: 'Visible', profundidad });
        const shallow = await explore(1);
        assert.deepEqual(shallow.entradas.map(entry => entry.ruta), ['Visible/Segundo']);
        assert.deepEqual((await explore(2)).entradas.map(entry => entry.ruta), ['Visible/Segundo', 'Visible/Segundo/Interior.txt']);
        assert.deepEqual(await fs.readFile(indexFile), indexBefore, 'explorar conserva el índice anterior');
        assert.equal((await call('leer', { ruta: 'Semilla.txt' })).contenido, 'Texto inicial ficticio.\n');
        const created = await call('crear', { ruta: 'Nueva.txt', contenido: 'Uno.\n' });
        assert.equal(created.estado, 'creado');
        assert.equal(created.indice, 'ok');
        const first = await call('leer', { ruta: 'Nueva.txt' });
        if (!virtual && process.platform !== 'win32') await fs.chmod(path.join(folder, 'Nueva.txt'), 0o640);
        const before = await fs.stat(path.join(folder, 'Nueva.txt'));
        const modified = await call('modificar', { ruta: 'Nueva.txt', version: first.version, contenido: 'Dos.\n' });
        assert.equal(modified.estado, 'modificado');
        assert.equal(modified.indice, 'ok');
        if (process.platform !== 'win32') {
          const after = await fs.stat(path.join(folder, 'Nueva.txt'));
          assert.equal(after.mode & 0o777, before.mode & 0o777);
          assert.equal(after.gid, before.gid);
        }
        await call('modificar', { ruta: 'Nueva.txt', version: first.version, contenido: 'Anterior' }, 'VERSION_CONFLICT');
        const patch = await call('editar', { ruta: 'Nueva.txt', ediciones: [{ buscar: 'Dos.', reemplazar: 'Tres.' }] });
        assert.equal(patch.estado, 'modificado');
        assert.equal(patch.indice, 'ok');
        assert.equal(await fs.readFile(path.join(folder, 'Nueva.txt'), 'utf8'), 'Tres.\n');
        assert.equal((await call('crear', { accion: 'carpeta', ruta: 'Archivo' })).estado, 'creada');
        const incremental = JSON.parse(await fs.readFile(indexFile, 'utf8'));
        const baseline = JSON.parse(indexBefore);
        assert.equal(incremental.updatedAt, baseline.updatedAt, 'una escritura conserva la fecha del último recorrido');
        assert.equal(incremental.generation, baseline.generation + 4);
        assert.equal(incremental.entries.some(entry => entry.path.startsWith('Visible')), false,
          'escribir no incorpora un subárbol ajeno descubierto en el disco');
        const published = index => index.entries.filter(entry => ['Archivo', 'Nueva.txt'].includes(entry.path));
        const [directoryEntry, fileEntry] = published(incremental);
        assert.equal(directoryEntry.type, 'directory');
        assert.equal(fileEntry.size, Buffer.byteLength('Tres.\n'));
        assert.deepEqual((await search('Interior')).resultados.map(item => item.ruta), ['Visible/Segundo/Interior.txt']);
        const reconciled = JSON.parse(await fs.readFile(indexFile, 'utf8'));
        assert.deepEqual(published(reconciled), published(incremental), 'los metadatos puntuales coinciden con el recorrido');


        if (!virtual) {
          await fs.link(path.join(folder, 'Nueva.txt'), path.join(folder, 'EnlaceDuro.txt'));
          await call('leer', { ruta: 'EnlaceDuro.txt' }, 'UNSAFE_PATH');
          await fs.unlink(path.join(folder, 'EnlaceDuro.txt'));
          await fs.mkdir(path.join(lab, 'Reservada'));
          await fs.writeFile(path.join(lab, 'Reservada', 'Privado.txt'), 'Fuera de la raíz.');
          const target = path.join(lab, 'Reservada');
          await fs.symlink(target, path.join(folder, 'Enlace'), process.platform === 'win32' ? 'junction' : 'dir');
          const refused = await call('leer', { ruta: 'Enlace/Privado.txt' }, 'UNSAFE_PATH');
          assert.equal(refused.contenido, undefined);
        }
        if (process.platform === 'darwin') {
          const filename = path.join(folder, 'Nueva.txt');
          const protectedVersion = (await call('leer', { ruta: 'Nueva.txt' })).version;
          const update = { ruta: 'Nueva.txt', version: protectedVersion, contenido: 'No publicar.' };
          await run('/usr/bin/xattr', ['-w', 'com.mind.laboratorio', 'ficticio', filename]);
          await call('modificar', update, 'METADATA_NOT_PRESERVABLE');
          await run('/usr/bin/xattr', ['-d', 'com.mind.laboratorio', filename]);
          await run('/usr/bin/chflags', ['hidden', filename]);
          await call('modificar', update, 'METADATA_NOT_PRESERVABLE');
          await run('/usr/bin/chflags', ['nohidden', filename]);
          await run('/bin/chmod', ['+a', 'everyone allow read', filename]);
          await call('modificar', update, 'METADATA_NOT_PRESERVABLE');
          await run('/bin/chmod', ['-N', filename]);
          assert.equal(await fs.readFile(filename, 'utf8'), 'Tres.\n');
        }

        assert.equal((await call('organizar', { accion: 'renombrar', ruta: 'Nueva.txt', nuevo_nombre: 'Final.txt' })).estado, 'renombrado');
        const moved = { accion: 'mover', desde: 'Final.txt', hasta: 'Archivo/Final.txt' };
        assert.equal((await call('organizar', moved)).estado, 'movido');
        assert.deepEqual((await search('Final')).resultados.map(item => item.ruta), ['Archivo/Final.txt']);
        const deletion = await call('organizar', { accion: 'borrar', ruta: 'Archivo/Final.txt', motivo: 'Prueba local con datos ficticios.' });
        assert.equal(deletion.estado, 'pendiente');
        await confirmDeletion(base);
        assert.equal((await search('Final')).total, 0);
        const trash = await call('organizar', { accion: 'papelera' });
        assert.equal(trash.total, 1);
        assert.equal((await call('organizar', { accion: 'restaurar', id: trash.elementos[0].id })).estado, 'restaurado');
        assert.equal((await call('leer', { ruta: 'Archivo/Final.txt' })).contenido, 'Tres.\n');
        assert.equal((await call('organizar', { accion: 'papelera' })).total, 0);
        t.diagnostic('Índice, búsqueda, lectura, creación, modificación, edición, renombrado, traslado y papelera verificados.');
      } finally {
        try {
          for (const fn of cleanup) await fn();
        } finally {
          if (sandbox !== lab) await removeFixture(sandbox, parent);
        }
      }
    } finally {
      await removeFixture(lab, RUNS);
    }
  });
}
