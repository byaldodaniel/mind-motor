import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

// Includes nested technical metadata, so adding a Base subdirectory cannot
// silently weaken the assertion that original contents are never persisted.
export async function readBaseContents(directory) {
  const contents = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) contents.push(await readBaseContents(filename));
    else {
      assert.ok(entry.isFile(), `Unexpected non-regular entry in test Base: ${filename}`);
      contents.push(await fs.readFile(filename, 'utf8'));
    }
  }
  return contents.join('');
}
