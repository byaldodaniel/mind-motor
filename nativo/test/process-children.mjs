import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const options = { timeout: 10000, windowsHide: true };

export async function directChildren(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  if (process.platform === 'win32') {
    const python = process.env.MIND_PYTHON || process.env.MIND_TEST_BUNDLED_PYTHON || 'python';
    const script = fileURLToPath(new URL('./windows-process-children.py', import.meta.url));
    const { stdout } = await run(python, ['-I', '-B', script, String(pid)], options);
    const children = JSON.parse(stdout);
    const consolePath = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'conhost.exe').toLowerCase();
    const auxiliaries = children.filter(child => child.path.toLowerCase() !== consolePath);
    return { auxiliaries, systemConsoles: children.length - auxiliaries.length };
  }
  const { stdout } = await run('ps', ['-eo', 'pid=,ppid='], options);
  const auxiliaries = stdout.trim().split('\n').map(line => line.trim().split(/\s+/u).map(Number))
    .filter(([, parent]) => parent === pid).map(([child]) => child);
  return { auxiliaries, systemConsoles: 0 };
}

export async function auxiliaryProcesses(pid) {
  return (await directChildren(pid)).auxiliaries;
}
