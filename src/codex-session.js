import net from 'node:net';
import { mkdtemp, chmod, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createReaderServer } from './codex-adapter.js';
import { MotorError } from './errors.js';

/**
 * Anfitrión local de confianza: una aprobación, identidad, permiso y conexión.
 * La IPC lleva solo el transporte; no crea ni persiste otro permiso de archivos.
 */
export async function prepareCodexRead({ motor, folderId, relativePath, confirm, lifetimeMs = 180_000, onEvent }) {
  const folder = (await motor.listAuthorizedFolders()).find((item) => item.id === folderId);
  if (!folder) throw new MotorError('FOLDER_NOT_AUTHORIZED', 'La carpeta debe estar registrada.');
  if (typeof confirm !== 'function' || await confirm(Object.freeze({
    folderId, folderPath: folder.path, relativePath, recipient: 'Codex CLI y su modelo',
  })) !== true) throw new MotorError('CONSENT_DENIED', 'El usuario no autorizó esta lectura.');

  const requester = Object.freeze({ session: randomUUID() });
  const authorization = await motor.grantTextRead({ requester, folderId, relativePath });
  const mcp = createReaderServer(() => motor.readTextFile({ requester, authorization }), onEvent);
  let directory;
  let socket;
  let timer;
  let closing;
  let listenerClosed;
  let connected = false;
  const listener = net.createServer((connection) => {
    if (connected) return connection.destroy();
    connected = true;
    socket = connection;
    void stopListening(); // Nunca se acepta un segundo cliente ni una reconexión.
    connection.on('error', () => { void close(); });
    connection.on('close', () => { void close(); });
    mcp.connect(new StdioServerTransport(connection, connection, { maxBufferSize: 65536 }))
      .catch(() => { void close(); });
  });

  function stopListening() {
    return listenerClosed ??= new Promise((resolve) => {
      if (listener.listening) listener.close(resolve);
      else resolve();
    });
  }

  function close() {
    return closing ??= (async () => {
      clearTimeout(timer);
      motor.revokeTextRead(authorization);
      socket?.destroy();
      await mcp.close();
      await stopListening();
      if (directory) await rmdir(directory); // Solo el directorio propio ya vacío.
    })();
  }

  try {
    let address;
    if (process.platform === 'win32') {
      address = `\\\\.\\pipe\\mind-read-${randomUUID()}`;
    } else {
      directory = await mkdtemp(path.join(tmpdir(), 'mind-read-'));
      await chmod(directory, 0o700);
      address = path.join(directory, 'mcp.sock');
    }
    await new Promise((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(address, resolve);
    });
    timer = setTimeout(() => { void close(); }, lifetimeMs);
    timer.unref();
    return Object.freeze({ address, close });
  } catch (error) {
    await close();
    throw error;
  }
}
