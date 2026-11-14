import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const require = createRequire(import.meta.url);
const { bootstrap } = require('../packaging/iniciadores/arranque.cjs');
const source = fileURLToPath(new URL('../packaging/iniciadores/arranque.cjs', import.meta.url));
const mutable = ['snapshotting', 'snapshotted', 'restoring-base', 'aside', 'placing', 'base', 'verifying'];
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mind-bootstrap-test-'));
  t.after(async () => {
    assert.equal(path.dirname(root), os.tmpdir());
    assert.ok(path.basename(root).startsWith('mind-bootstrap-test-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const system = path.join(root, 'Sistema');
  await fs.mkdir(system);
  const file = path.join(system, 'Actualizaciones', 'transaccion.json');
  const worker = path.join(system, 'Actualizaciones', 'Trabajo', 'actual', 'recuperador');
  const entry = path.join(system, 'Programa', 'Motor', 'bin', 'mind.js');
  const manifest = path.join(system, 'mind-producto.json');
  async function ready() {
    await fs.mkdir(path.dirname(entry), { recursive: true });
    await fs.writeFile(entry, '// fixture ready');
    await fs.writeFile(manifest, '{}');
  }
  async function journal(phase) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ format: 'mind-update-transaction', version: 1,
      phase, work: 'Sistema/Actualizaciones/Trabajo/actual', operations: [] }));
  }
  async function snapshot() {
    const node = path.join(worker, 'Node', ...(process.platform === 'win32' ? ['node.exe'] : ['bin', 'node']));
    const python = path.join(worker, 'Python', ...(process.platform === 'win32' ? ['python.exe'] : ['bin', 'python3']));
    const runner = path.join(worker, 'Motor', 'bin', 'recuperar-actualizacion.js');
    for (const p of [node, python, runner]) {
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, 'fixture');
    }
    return { node, python, runner };
  }
  return { root, system, file, worker, entry, manifest, ready, journal, snapshot };
}

test('normal startup and prepared journal import directly without probing a recovery worker', async t => {
  const f = await fixture(t);
  await f.ready();
  let imports = 0;
  const options = { systemDirectory: f.system, runRecovery: async () => assert.fail('unnecessary worker'),
    importProgram: async entry => { assert.equal(entry, f.entry); imports++; } };
  await bootstrap(options);
  await f.journal('prepared');
  await bootstrap(options);
  assert.equal(imports, 2);
});

for (const phase of mutable) test('bootstrap restores a missing program after phase ' + phase, async t => {
  const f = await fixture(t);
  await f.journal(phase);
  const snapshot = await f.snapshot();
  let called = 0, imported = false;
  await bootstrap({ systemDirectory: f.system, runRecovery: async (node, runner, root, python) => {
    called++;
    assert.equal(node, snapshot.node);
    assert.equal(runner, snapshot.runner);
    assert.equal(python, snapshot.python);
    assert.equal(root, f.root);
    await assert.rejects(fs.access(f.entry), { code: 'ENOENT' });
    await f.ready();
    await f.journal('rolled-back');
  }, importProgram: async () => { imported = true; } });
  assert.equal(called, 1);
  assert.equal(imported, true);
});

test('busy recovery or an unchanged mutating journal never imports a partial program', async t => {
  const f = await fixture(t);
  await f.snapshot();
  await f.journal('placing');
  await assert.rejects(bootstrap({ systemDirectory: f.system, runRecovery: async () => {
    throw Object.assign(new Error('busy'), { code: 'LOCK_BUSY' });
  }, importProgram: async () => assert.fail('partial program') }), { code: 'LOCK_BUSY' });
  await assert.rejects(bootstrap({ systemDirectory: f.system, runRecovery: async () => {},
    importProgram: async () => assert.fail('partial program') }), { code: 'UPDATE_RECOVERY_BLOCKED' });
});

test('malformed journal is retained and does not execute the program', async t => {
  const f = await fixture(t);
  await f.ready();
  await fs.mkdir(path.dirname(f.file), { recursive: true });
  await fs.writeFile(f.file, '{broken');
  await assert.rejects(bootstrap({ systemDirectory: f.system, importProgram: async () => assert.fail() }),
    { code: 'UPDATE_JOURNAL_INVALID' });
  assert.equal(await fs.readFile(f.file, 'utf8'), '{broken');
});

test('stable bootstrap executes the snapshot runner when Motor and manifest are absent, then imports in its original process', async t => {
  const f = await fixture(t);
  await f.journal('placing');
  const snapshot = await f.snapshot();
  await fs.copyFile(process.execPath, snapshot.node);
  if (process.platform !== 'win32') await fs.chmod(snapshot.node, 0o755);
  const installedBootstrap = path.join(f.system, 'arranque.cjs');
  await fs.copyFile(source, installedBootstrap);
  await fs.writeFile(path.join(f.worker, 'Motor', 'package.json'), '{"type":"module"}');
  const stubMain = "process.stdout.write(JSON.stringify({pid:process.pid,args:process.argv.slice(2)})+'\\n');";
  const runner = [
    "import fs from 'node:fs/promises';",
    "import path from 'node:path';",
    "const root = process.argv[2];",
    "const system = path.join(root,'Sistema');",
    "const motor = path.join(system,'Programa','Motor');",
    "await fs.mkdir(path.join(motor,'bin'),{recursive:true});",
    "await fs.writeFile(path.join(motor,'package.json'),'{\"type\":\"module\"}');",
    "await fs.writeFile(path.join(motor,'bin','mind.js')," + JSON.stringify(stubMain) + ");",
    "await fs.writeFile(path.join(system,'mind-producto.json'),'{}');",
    "const journal = path.join(system,'Actualizaciones','transaccion.json');",
    "const j = JSON.parse(await fs.readFile(journal,'utf8'));j.phase='rolled-back';",
    "await fs.writeFile(journal,JSON.stringify(j));",
  ].join('\n');
  await fs.writeFile(snapshot.runner, runner);
  const child = spawn(process.execPath, [installedBootstrap, 'mcp', '--fixture'], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_OPTIONS: '' },
  });
  let output = '', errors = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { errors += data; });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(code, 0, errors);
  const result = JSON.parse(output.trim());
  assert.equal(result.pid, child.pid);
  assert.deepEqual(result.args, ['mcp', '--fixture']);
});

test('a module-load race reports INSTALLATION_BUSY while a preparation lease is present', async t => {
  const f = await fixture(t);
  await f.ready();
  await f.journal('prepared');
  await assert.rejects(bootstrap({ systemDirectory: f.system, importProgram: async () => {
    await fs.writeFile(path.join(f.system, 'Actualizaciones', 'preparacion.lock'), '{}');
    throw Object.assign(new Error('concurrent module move'), { code: 'ERR_MODULE_NOT_FOUND' });
  } }), { code: 'INSTALLATION_BUSY' });
});

test('a missing module outside an update preserves its original diagnosis', async t => {
  const f = await fixture(t);
  await f.ready();
  await assert.rejects(bootstrap({ systemDirectory: f.system, importProgram: async () => {
    throw Object.assign(new Error('missing module'), { code: 'ERR_MODULE_NOT_FOUND' });
  } }), { code: 'ERR_MODULE_NOT_FOUND' });
});

async function handoffFixture(f, phase = 'aplicando') {
  const { randomUUID } = await import('node:crypto');
  const id = randomUUID(), marker = path.join(f.system, 'Actualizaciones/relevo.json');
  const worker = path.join(f.system, 'Actualizaciones/Relevos', id);
  const helper = path.join(worker, 'Motor/src/update-handoff-state.js');
  const python = path.join(worker, 'Python', process.platform === 'win32' ? 'python.exe' : 'bin/python3');
  await fs.mkdir(path.dirname(helper), { recursive: true });
  await fs.mkdir(path.dirname(python), { recursive: true });
  await fs.writeFile(python, 'python ficticio');
  await fs.writeFile(path.join(worker, 'Motor/package.json'), '{"type":"module"}');
  // El bootstrap usa un helper estable fuera de Programa; la identidad/recuperación
  // nativa del helper real se ensaya en update-handoff-state.test.js.
  await fs.writeFile(helper, [
    'import fs from "node:fs/promises";',
    'import path from "node:path";',
    'export async function waitForHandoff({root,pythonExecutable}) {',
    'if (!pythonExecutable.includes("Relevos")) throw Error("Python del programa mutable");',
    'const file=path.join(root,"Sistema/Actualizaciones/relevo.json");',
    'while (["aplicando","verificando"].includes(JSON.parse(await fs.readFile(file,"utf8")).phase)) await new Promise(r=>setTimeout(r,10));',
    'return {waited:true};}',
  ].join('\n'));
  const record = { format: 'mind-update-handoff', version: 1, id, phase };
  async function write(next) { await fs.writeFile(marker, JSON.stringify({ ...record, phase: next })); }
  await write(phase);
  return { marker, worker, helper, write };
}

test('bootstrap espera al relevista vivo antes de tocar un diario mutable o importar Programa', async t => {
  const f = await fixture(t);
  await f.journal('placing');
  await f.ready();
  const handoff = await handoffFixture(f);
  let imported = false, recovered = false;
  const request = bootstrap({ systemDirectory: f.system,
    runRecovery: async () => { recovered = true; assert.fail('el relevista todavía vive'); },
    importProgram: async () => { imported = true; } });
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(imported, false);
  assert.equal(recovered, false);
  await f.journal('committed');
  await handoff.write('completada');
  await request;
  assert.equal(imported, true);
});

test('marca terminal no requiere snapshot; marca rota se conserva y no importa Programa', async t => {
  const f = await fixture(t);
  await f.ready();
  const { randomUUID } = await import('node:crypto');
  const file = path.join(f.system, 'Actualizaciones/relevo.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  for (const phase of ['iniciando', 'descargando', 'preparando', 'espera-quietud', 'completada', 'fallida']) {
    await fs.writeFile(file, JSON.stringify({ format: 'mind-update-handoff', version: 1, id: randomUUID(), phase }));
    let imported = false;
    await bootstrap({ systemDirectory: f.system, importProgram: async () => { imported = true; } });
    assert.equal(imported, true, phase);
  }
  for (const broken of ['{roto', JSON.stringify({ format: 'mind-update-handoff', version: 1, id: '../otro', phase: 'aplicando' })]) {
    await fs.writeFile(file, broken);
    await assert.rejects(bootstrap({ systemDirectory: f.system, importProgram: async () => assert.fail() }), { code: 'UPDATE_HANDOFF_INVALID' });
    assert.equal(await fs.readFile(file, 'utf8'), broken);
  }
});

test('snapshot ausente nunca deja que bootstrap importe un programa que se está sustituyendo', async t => {
  const f = await fixture(t);
  await f.ready();
  const handoff = await handoffFixture(f, 'verificando');
  await fs.rm(handoff.helper);
  await assert.rejects(bootstrap({ systemDirectory: f.system, importProgram: async () => assert.fail() }), { code: 'ENOENT' });
  assert.equal(JSON.parse(await fs.readFile(handoff.marker, 'utf8')).phase, 'verificando');
});

test('si el relevo empieza durante import, bootstrap espera y reabre un proceso sin módulos viejos', async t => {
  const f = await fixture(t);
  await f.ready();
  const node = path.join(f.system, 'Componentes/Node', process.platform + '-' + process.arch,
    process.platform === 'win32' ? 'node.exe' : 'bin/node');
  await fs.mkdir(path.dirname(node), { recursive: true });
  await fs.writeFile(node, 'node ficticio');
  const launcher = path.join(f.system, 'arranque.cjs');
  await fs.writeFile(launcher, 'launcher ficticio');
  let imports = 0, relays = 0, complete;
  const result = await bootstrap({ systemDirectory: f.system,
    importProgram: async () => {
      imports++;
      const handoff = await handoffFixture(f);
      complete = new Promise((resolve, reject) => setTimeout(() => handoff.write('completada').then(resolve, reject), 70));
      throw Object.assign(new Error('cambio concurrente de Programa'), { code: 'ERR_MODULE_NOT_FOUND' });
    },
    runUpdated: async (executable, entry, args) => {
      relays++;
      assert.equal(executable, node);
      assert.equal(entry, launcher);
      assert.deepEqual(args, process.argv.slice(2));
      return 0;
    },
  });
  await complete;
  assert.equal(result, 0);
  assert.equal(imports, 1);
  assert.equal(relays, 1);
});
