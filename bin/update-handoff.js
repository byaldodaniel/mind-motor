#!/usr/bin/env node
import { runHandoff } from '../src/update-handoff.js';
const [root, id, mode] = process.argv.slice(2);
try {
  const result = await runHandoff({ root, id, recoverOnly: mode === '--recover' });
  if (result.status === 'fallida') process.exitCode = 1;
} catch (error) {
  process.stderr.write(JSON.stringify({ code: error.code, message: error.message }) + '\n');
  process.exitCode = 1;
}
