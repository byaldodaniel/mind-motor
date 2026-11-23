import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const repo = fileURLToPath(new URL('../../', import.meta.url));
export const r3Commit = 'eabdc3c10ca6e22f3b873b0bbac50a5fe7626f64';
const options = { cwd: repo, timeout: 15_000, windowsHide: true };

export async function extractR3(root) {
  const r3 = path.join(root, 'r3');
  const archive = path.join(root, 'r3.tar');
  await fs.mkdir(r3);
  const revision = await run('git', ['rev-parse', 'v1.0.4-r3'], options);
  assert.equal(revision.stdout.trim(), r3Commit);
  await run('git', ['archive', '--format=tar', '--output=' + archive, r3Commit, '--', 'package.json', 'src'], options);
  // En Windows, el tar de Git interpreta «C:» como un equipo remoto: se usa el del sistema.
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  await run(tar, ['-xf', archive, '-C', r3], options);
  return name => JSON.stringify(pathToFileURL(path.join(r3, 'src', name)).href);
}
