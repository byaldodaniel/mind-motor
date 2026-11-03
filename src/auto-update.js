import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MAX_FEED = 128 * 1024;
const MAX_PACKAGE = 512 * 1024 * 1024;
const ROOT = fileURLToPath(new URL('../..', import.meta.url));

export function githubDownload(value, repository) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password
      || !url.pathname.startsWith(`/${repository}/releases/`) || url.search || url.hash) {
    throw new Error('La descarga no pertenece al canal de Mind.');
  }
  return url.href;
}

async function download(url, { fetcher, signal, limit, file }) {
  const response = await fetcher(url, { signal, redirect: 'follow', headers: { 'User-Agent': 'Mind-updater' } });
  if (!response.ok || !response.body) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
  if (Number(response.headers.get('content-length')) > limit) throw new Error('Descarga demasiado grande.');
  const chunks = [];
  const hash = createHash('sha256');
  let bytes = 0;
  const handle = file ? await fs.open(file, 'wx', 0o600) : null;
  try {
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > limit) throw new Error('Descarga demasiado grande.');
      hash.update(chunk);
      if (handle) await handle.write(chunk); else chunks.push(Buffer.from(chunk));
    }
  } finally {
    await handle?.close();
  }
  return { bytes, sha256: hash.digest('hex'), text: file ? null : Buffer.concat(chunks).toString('utf8') };
}

export function verifyFeed(envelope, publicKey) {
  if (typeof envelope?.payload !== 'string' || typeof envelope.signature !== 'string') throw new Error('Canal sin firma.');
  const payload = Buffer.from(envelope.payload, 'base64');
  const key = createPublicKey(publicKey);
  if (key.asymmetricKeyType !== 'ed25519' || !verify(null, payload, key, Buffer.from(envelope.signature, 'base64'))) {
    throw new Error('Firma de actualización incorrecta.');
  }
  const feed = JSON.parse(payload.toString('utf8'));
  if (feed.format !== 'mind-update' || feed.version !== 1 || !Array.isArray(feed.packages)) throw new Error('Canal no válido.');
  return feed;
}

/** No importa código del Motor antes de sustituirlo: la instalación ocurre en otro proceso. */
export async function checkForUpdate({ root = ROOT, fetcher = fetch, install = installPackage, baseDirectory, report = () => {} } = {}) {
  let temporary;
  try {
    const current = JSON.parse(await fs.readFile(path.join(root, 'mind-producto.json'), 'utf8'));
    const channel = JSON.parse(await fs.readFile(path.join(root, 'Motor', 'src', 'update-channel.json'), 'utf8'));
    if (current.format !== 'mind-product' || !channel.publicKey) return { status: 'no-configurado' };
    const { compareVersions, isVersion } = await import('./product-files.js');
    const feedUrl = githubDownload(channel.url, channel.repository);
    let feedResult;
    try { feedResult = await download(feedUrl, { fetcher, signal: AbortSignal.timeout(5000), limit: MAX_FEED }); }
    catch (error) { if (error.status === 404) return { status: 'sin-publicaciones' }; throw error; }
    const feed = verifyFeed(JSON.parse(feedResult.text), channel.publicKey);
    if (!isVersion(feed.mindVersion) || feed.mindVersion.includes('-')) throw new Error('El canal estable no admite versiones preliminares.');
    if (compareVersions(feed.mindVersion, current.mindVersion) <= 0) return { status: 'al-dia' };
    const matching = feed.packages.filter(p => p.platform === current.platform && p.arch === current.arch);
    if (matching.length !== 1) throw new Error('Falta un paquete único para este equipo.');
    const selected = matching[0];
    const url = githubDownload(selected.url, channel.repository);
    if (!/^[a-f0-9]{64}$/.test(selected.sha256) || !Number.isSafeInteger(selected.bytes)
        || selected.bytes < 1 || selected.bytes > MAX_PACKAGE) throw new Error('Paquete no válido.');
    // Este directorio es externo a la instalación y nunca contiene información de la Base.
    temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'mind-descarga-'));
    const source = path.join(temporary, current.platform === 'win32' ? 'mind.zip' : 'mind.tar.gz');
    report(`Descargando Mind ${feed.mindVersion}…`);
    const received = await download(url, { fetcher, signal: AbortSignal.timeout(120000), limit: selected.bytes, file: source });
    if (received.bytes !== selected.bytes || received.sha256 !== selected.sha256) throw new Error('El paquete descargado no coincide con la versión firmada.');
    await install({ root, source, version: feed.mindVersion, baseDirectory });
    report(`Mind se actualizó a ${feed.mindVersion}.`);
    return { status: 'actualizada', version: feed.mindVersion };
  } catch (error) {
    if (error.code === 'UPDATE_ROLLBACK_FAILED') throw error;
    if (error.code === 'ENOENT') return { status: 'no-configurado' };
    report(`No se pudo actualizar Mind; se usará la versión instalada. ${error.message}`);
    return { status: 'aplazada', reason: error.message };
  } finally {
    if (temporary) await fs.rm(temporary, { recursive: true, force: true });
  }
}

function installPackage({ root, source, version, baseDirectory }) {
  return new Promise((resolve, reject) => {
    const worker = spawn(process.execPath, [path.join(root, 'Motor', 'bin', 'install-update.js'), root, source, version, baseDirectory ?? ''], {
      stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, env: { ...process.env, NODE_OPTIONS: '' },
    });
    let errorText = '';
    worker.stderr.on('data', chunk => { errorText = (errorText + chunk).slice(-4096); });
    worker.on('error', reject);
    worker.on('exit', code => {
      if (code === 0) return resolve();
      let details;
      try { details = JSON.parse(errorText); } catch {}
      reject(Object.assign(new Error(details?.message ?? errorText ?? `Actualizador: ${code}`), { code: details?.code }));
    });
  });
}

/** Reinicia con el runtime nuevo, conservando stdio, argumentos y la carpeta del agente. */
export async function launch(args) {
  const filtered = [];
  for (let index = 0; index < args.length; index++) {
    if (['--base', '--carpeta'].includes(args[index])) { index++; continue; }
    filtered.push(args[index]);
  }
  const command = filtered[0];
  if (!process.env.MIND_UPDATE_RESTART && !['version', '--version', 'actualizar', 'ayuda', '--help', '-h'].includes(command ?? args[0])) {
    const baseIndex = args.lastIndexOf('--base');
    const result = await checkForUpdate({ baseDirectory: baseIndex >= 0 ? args[baseIndex + 1] : undefined, report: message => process.stderr.write(`${message}\n`) });
    if (result.status === 'actualizada') {
      const node = process.platform === 'win32' ? path.join(ROOT, 'Runtime', 'node', 'node.exe') : path.join(ROOT, 'Runtime', 'node', 'bin', 'node');
      return new Promise((resolve, reject) => {
        const child = spawn(node, [path.join(ROOT, 'Motor', 'bin', 'mind.js'), ...args], {
          stdio: 'inherit', windowsHide: true, env: { ...process.env, NODE_OPTIONS: '', MIND_UPDATE_RESTART: '1' },
        });
        child.on('error', reject);
        child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
      });
    }
  }
  delete process.env.MIND_UPDATE_RESTART;
  const { main } = await import('./product-cli.js');
  return main(args);
}
