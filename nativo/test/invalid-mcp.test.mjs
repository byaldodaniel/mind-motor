import {RUNS} from './runs.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pilot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runs = RUNS;
const executable = process.env.MIND_NATIVE_EXE;

test('bridge rejects malformed and unsafe MCP IDs and remains usable', { timeout: 15000, skip: !executable }, async (t) => {
  assert.ok(path.isAbsolute(executable), 'MIND_NATIVE_EXE must be absolute');
  await fs.mkdir(runs, { recursive: true });
  const root = await fs.mkdtemp(path.join(runs, 'invalid-mcp-'));
  const base = path.join(root, 'Base');
  await fs.mkdir(base);
  const child = spawn(executable, ['bridge', '--base', base, '--cwd', root, '--paths', '[]',
    '--launch-command', path.join(root, 'intentionally-missing-launcher.exe')], {
    cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
  });
  let stderr = '', buffer = '', terminal = null;
  const queued = [], readers = [];
  let exited = false;
  const exit = new Promise(resolve => child.once('exit', (code, signal) => {
    exited = true; terminal ??= new Error('Bridge exited: ' + code + ' / ' + signal + '; ' + stderr);
    while (readers.length) readers.shift().reject(terminal);
    resolve();
  }));
  child.once('error', error => {
    terminal = error;
    while (readers.length) readers.shift().reject(error);
  });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-8000); });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    for (;;) {
      const at = buffer.indexOf('\n');
      if (at < 0) break;
      const line = buffer.slice(0, at).trim(); buffer = buffer.slice(at + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); }
      catch { terminal = new Error('Invalid JSON stdout: ' + line.slice(0, 300)); }
      const reader = readers.shift();
      if (reader) terminal ? reader.reject(terminal) : reader.resolve(message);
      else if (!terminal) queued.push(message);
    }
  });
  const next = () => new Promise((resolve, reject) => {
    if (terminal) return reject(terminal);
    if (queued.length) return resolve(queued.shift());
    const wait = { resolve: message => { clearTimeout(timer); resolve(message); },
                   reject: error => { clearTimeout(timer); reject(error); } };
    const timer = setTimeout(() => {
      const index = readers.indexOf(wait); if (index >= 0) readers.splice(index, 1);
      reject(new Error('No JSON-RPC reply within 2500ms; ' + stderr));
    }, 2500);
    readers.push(wait);
  });
  t.after(async () => {
    child.stdin.destroy();
    if (!exited) child.kill();
    await Promise.race([exit, new Promise(resolve => setTimeout(resolve, 1500))]);
    const absolute = path.resolve(root);
    const relative = path.relative(runs, absolute);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'cleanup must remain under RUNS');
    await fs.rm(absolute, { recursive: true, force: true });
  });
  for (const id of [{ object: 'invalid' }, ['invalid'], 9007199254740992, -9007199254740992, 1.5]) {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'ping' }) + '\n');
    const response = await next();
    assert.equal(response.jsonrpc, '2.0');
    assert.equal(response.id, null, 'invalid id must not be echoed');
    assert.equal(response.error?.code, -32600, 'invalid id needs INVALID_REQUEST, not notification/silence');
    assert.equal(exited, false, 'invalid id must not crash bridge');
  }
  child.stdin.write('{"jsonrpc":"2.0","id":7,"method":"ping"}\n');
  const valid = await next();
  assert.equal(valid.id, 7);
  assert.deepEqual(valid.result, {});
  assert.equal(exited, false);
});
