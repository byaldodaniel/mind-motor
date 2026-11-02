import net from 'node:net';

// Solo IPC del equipo: ninguna URL, puerto TCP o ruta UNC remota.
const address = process.argv[2];
const valid = typeof address === 'string' && (process.platform === 'win32'
  ? /^\\\\\.\\pipe\\mind-read-[a-f0-9-]+$/.test(address)
  : /^\/.*\/mind-read-[^/]+\/mcp\.sock$/.test(address));
if (!valid || process.argv.length !== 3) {
  process.stderr.write('MIND_SESSION_UNAVAILABLE\n');
  process.exitCode = 1;
} else {
  const socket = net.createConnection(address);
  socket.once('connect', () => {
    process.stdin.pipe(socket);
    socket.pipe(process.stdout);
  });
  socket.on('error', () => {
    process.stderr.write('MIND_SESSION_UNAVAILABLE\n');
    process.exitCode = 1;
    socket.destroy();
  });
  socket.on('close', () => { process.stdin.pause(); });
  process.stdin.on('error', () => { socket.destroy(); });
}
