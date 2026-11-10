import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { hashFile, scanTree } from '../src/product-files.js';
import { BASE_FORMAT_VERSION } from '../src/base-format.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const pythonSource = process.env.MIND_TEST_BUNDLED_PYTHON;
const target = process.platform + '-' + process.arch;
const skip = !pythonSource ? 'Set MIND_TEST_BUNDLED_PYTHON to an included native Python executable for this real-runtime fixture.' : false;

function childEnv() {
  const env = { ...process.env, NODE_OPTIONS: '', MIND_AGENT_STARTUP: '0' };
  for (const key of ['MIND_PYTHON', 'MIND_TEST_PYTHON', 'MIND_BASE', 'MIND_UPDATE_RESTART']) delete env[key];
  return env;
}
async function run(node, args, cwd) {
  const child = spawn(node, args, { cwd, env: childEnv(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', part => { stdout += part; });
  child.stderr.on('data', part => { stderr += part; });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  return { code, stdout, stderr };
}
async function seal(root, revision) {
  const files = {};
  for (const entry of await scanTree(root)) if (entry.type === 'file') files[entry.path] = await hashFile(path.join(root, entry.path));
  delete files['Sistema/mind-producto.json'];
  await fs.writeFile(path.join(root, 'Sistema', 'mind-producto.json'), JSON.stringify({
    format: 'mind-product', version: 1, mindVersion: '1.0.3',
    packageRevision: revision, layoutVersion: 2, updateProtocolVersion: 2,
    platform: process.platform, arch: process.arch, baseFormatVersion: BASE_FORMAT_VERSION,
    files, links: {},
  }));
}

test('real interrupted product restores itself through installed bootstrap and its own snapshot worker', { skip, timeout: 180_000 }, async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'mind-real-bootstrap-'));
  t.after(async () => {
    assert.equal(path.dirname(temporary), os.tmpdir());
    assert.ok(path.basename(temporary).startsWith('mind-real-bootstrap-'));
    await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  assert.ok(path.isAbsolute(pythonSource), 'The fixture must use a specific included interpreter.');
  const root = path.join(temporary, 'My Mind'), incoming = path.join(temporary, 'Incoming');
  const system = path.join(root, 'Sistema');
  const motor = path.join(system, 'Programa', 'Motor');
  for (const name of ['src', 'bin']) await fs.cp(path.join(repo, name), path.join(motor, name), { recursive: true });
  await fs.copyFile(path.join(repo, 'package.json'), path.join(motor, 'package.json'));
  await fs.copyFile(path.join(repo, 'packaging', 'iniciadores', 'arranque.cjs'), path.join(system, 'arranque.cjs'));
  const node = path.join(system, 'Componentes', 'Node', target, ...(process.platform === 'win32' ? ['node.exe'] : ['bin', 'node']));
  const pythonDirectory = path.join(system, 'Componentes', 'Python', target);
  const sourceDirectory = process.platform === 'win32' ? path.dirname(pythonSource) : path.dirname(path.dirname(pythonSource));
  await fs.mkdir(path.dirname(node), { recursive: true });
  await fs.copyFile(process.execPath, node);
  await fs.chmod(node, 0o755);
  await fs.cp(sourceDirectory, pythonDirectory, { recursive: true });
  await fs.writeFile(path.join(motor, 'fixture-release.txt'), 'Original revision; fictional data only.\n');
  await seal(root, 0);
  await fs.cp(root, incoming, { recursive: true });
  await fs.writeFile(path.join(incoming, 'Sistema', 'Programa', 'Motor', 'fixture-release.txt'), 'Changed revision; fictional data only.\n');
  await seal(incoming, 1);
  const base = path.join(system, 'Base');
  await fs.mkdir(base);
  const data = path.join(base, 'continuidad-ficticia.json');
  await fs.writeFile(data, '{"decision":"preserve this fictional continuity"}\n');
  const before = await hashFile(data);
  const driver = path.join(temporary, 'interrupt.mjs');
  await fs.writeFile(driver, [
    "import path from 'node:path';",
    "import {pathToFileURL} from 'node:url';",
    "const [root,source]=process.argv.slice(2);",
    "const module=path.join(root,'Sistema','Programa','Motor','src','commands','actualizar.js');",
    "const {updateMind}=await import(pathToFileURL(module).href);",
    "await updateMind({root,source,baseDirectory:path.join(root,'Sistema','Base'),confirm:()=>true,",
    "testing:{afterMove(kind,item){if(kind==='aside'&&item==='Sistema/Programa/Motor')process.exit(74);}}});",
    "throw new Error('The expected interruption did not occur');",
  ].join('\n'));
  const stopped = await run(node, [driver, root, incoming], temporary);
  assert.equal(stopped.code, 74, stopped.stderr);
  await assert.rejects(fs.access(path.join(motor, 'bin', 'mind.js')), { code: 'ENOENT' });
  const journalFile = path.join(system, 'Actualizaciones', 'transaccion.json');
  const interrupted = JSON.parse(await fs.readFile(journalFile, 'utf8'));
  assert.equal(interrupted.phase, 'aside');
  const worker = path.join(system, 'Actualizaciones', 'Trabajo', 'actual', 'recuperador');
  await fs.access(path.join(worker, 'Motor', 'bin', 'recuperar-actualizacion.js'));
  await fs.access(path.join(worker, 'Node', ...(process.platform === 'win32' ? ['node.exe'] : ['bin', 'node'])));
  // Actual installed bootstrap; the product's Motor is absent and cannot import a repository runner.
  const first = await run(node, [path.join(system, 'arranque.cjs'), 'version'], temporary);
  assert.equal(first.code, 0, first.stderr);
  const version = JSON.parse(first.stdout.trim());
  assert.equal(version.mind, '1.0.3');
  assert.equal(version.estructura, 2);
  assert.equal(version.producto, true);
  assert.equal(version.revision, 0, 'Interrupted delivery rolled back to its original revision.');
  assert.equal(await hashFile(data), before);
  const second = await run(node, [path.join(system, 'arranque.cjs'), 'version'], temporary);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout.trim()).mind, '1.0.3');
  assert.equal(await hashFile(data), before);
  await assert.rejects(fs.access(path.join(system, 'Actualizaciones', 'Trabajo', 'actual')), { code: 'ENOENT' });
  await assert.rejects(fs.access(journalFile), { code: 'ENOENT' });
  t.diagnostic('Real native fixture: interrupted updater exited 74; installed bootstrap recovered revision 0; Base hash unchanged; transaction payload removed after worker closure.');
});
