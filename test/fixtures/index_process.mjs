// Barreras exclusivamente en los procesos de prueba; el Motor no incluye hooks.
import fs from 'node:fs/promises';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';

const config = JSON.parse(process.argv[2]);
const indexFile = path.join(config.base, `folder-index-${config.id}.json`);
const lockFile = path.join(config.base, `folder-index-${config.id}.lock`);
const send = (phase, extra = {}) => process.send({ phase, ...extra });
async function barrier(phase) {
  // Instalar el receptor antes de avisar al padre evita perder la liberación.
  const released = new Promise((resolve) => process.once('message', resolve));
  send(phase);
  await released;
}

const realOpen = fs.open;
let notified = false;
fs.open = async function (filename, ...args) {
  try { return await realOpen.call(this, filename, ...args); }
  catch (error) {
    if (filename === lockFile && args[0] === 'wx' && error.code === 'EEXIST' && !notified) {
      notified = true;
      send('contended');
    }
    throw error;
  }
};
const realRename = fs.rename;
fs.rename = async function (source, target) {
  if (target === indexFile) {
    if (config.pausePublish) await barrier('before-publish');
    if (config.failPublish) throw Object.assign(new Error('Fallo de publicación inyectado'), { code: 'EIO' });
  }
  return realRename.call(this, source, target);
};
syncBuiltinESMExports();

try {
  const { openMotor, textVersion } = await import('../../src/motor.js');
  const motor = await openMotor({ baseDirectory: config.base });
  let result;
  if (config.operation === 'create' || config.operation === 'modify') {
    const requester = Object.freeze({});
    const request = { requester, folderId: config.id, relativePath: config.relativePath };
    if (config.operation === 'create') {
      const authorization = await motor.grantTextCreate(request);
      result = await motor.createTextFile({ requester, authorization, content: config.content });
    } else {
      const authorization = await motor.grantTextModify(request);
      result = await motor.modifyTextFile({ requester, authorization,
        expectedVersion: textVersion(config.previous), content: config.content });
    }
  } else if (config.operation === 'revoke') {
    result = await motor.revokeFolder(config.id);
  } else {
    const { createFolderRegistry } = await import('../../src/folders.js');
    const { createFolderIndexer } = await import('../../src/indexer.js');
    const registry = createFolderRegistry(config.base, fileURLToPath(new URL('../..', import.meta.url)));
    let calls = 0;
    const indexer = createFolderIndexer({ baseDirectory: config.base, resolveScope: async (id) => {
      const scope = await registry.loadAuthorizedFolder(id);
      if (!scope) throw Object.assign(new Error('Retirada'), { code: 'FOLDER_NOT_AUTHORIZED' });
      calls += 1;
      if (config.pauseAuthorization && calls === 1) await barrier('captured');
      if (config.pauseScan && calls === 3) await barrier('scanned');
      return scope;
    } });
    if (config.operation === 'scan') result = await indexer.indexFolder(config.id);
    else if (config.operation === 'remove') result = await indexer.removeFolderIndex(config.id);
    else if (config.operation === 'record-create') result = await indexer.recordCreatedFile(config.id, config.entry);
    else if (config.operation === 'record-modify') result = await indexer.recordModifiedFile(config.id, config.entry);
    else throw new Error('Operación de prueba desconocida');
  }
  send('result', { ok: true, result });
} catch (error) {
  send('result', { ok: false, code: error.code, message: error.message });
} finally {
  process.disconnect();
}
