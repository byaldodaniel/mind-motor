// Prueba de extremo a extremo del anfitrión nativo delante del Motor r3.
// Uso: node probar-anfitrion.mjs <carpeta mind-medicion-*>
// Requiere el Motor (motor.mjs) y el anfitrión (mind-native anfitrion --base …) en marcha.
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = process.argv[2];
const base = path.join(root, 'Base');
const { port } = JSON.parse(await fs.readFile(path.join(base, 'anfitrion.json'), 'utf8'));
const { token } = JSON.parse(await fs.readFile(path.join(base, 'conector-secreto.json'), 'utf8'));
const motor = JSON.parse(await fs.readFile(path.join(base, 'conector.json'), 'utf8'));

function request(pathName, { method = 'POST', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port, method, path: pathName, headers: {
      Accept: 'application/json, text/event-stream', ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}), ...headers,
    } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json = null;
        if (String(res.headers['content-type']).includes('text/event-stream')) {
          const line = text.split(/\r?\n/u).filter((l) => l.startsWith('data:')).at(-1);
          json = line ? JSON.parse(line.slice(5)) : null;
        } else if (text) { try { json = JSON.parse(text); } catch { json = text; } }
        resolve({ status: res.statusCode, headers: res.headers, json, sse: String(res.headers['content-type']).includes('text/event-stream') });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const auth = { Authorization: `Bearer ${token}` };
const steps = [];
const step = (name, fn) => steps.push([name, fn]);

step('health del anfitrión verifica al Motor', async () => {
  const r = await request('/health', { method: 'GET' });
  assert.equal(r.status, 200);
  assert.equal(r.json.anfitrion, true);
  assert.equal(r.json.motor.port, motor.port);
  assert.notEqual(r.json.port, motor.port);
});
step('sin token responde 401', async () => {
  assert.equal((await request('/rpc', { body: { accion: 'ping' } })).status, 401);
});
step('Origin ajeno responde 403 aunque traiga el token', async () => {
  assert.equal((await request('/rpc', { headers: { ...auth, Origin: 'https://ejemplo.com' }, body: { accion: 'ping' } })).status, 403);
});
step('rpc ping llega al Motor', async () => {
  const r = await request('/rpc', { headers: auth, body: { accion: 'ping' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.pid, motor.pid);
});
let session;
step('MCP initialize por el anfitrión, catálogo núcleo', async () => {
  const r = await request('/mcp?catalogo=nucleo', { headers: auth, body: { jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'prueba-anfitrion', version: '1' } } } });
  assert.equal(r.status, 200);
  session = r.headers['mcp-session-id'];
  assert.ok(session, 'el anfitrión debe conservar Mcp-Session-Id');
  await request('/mcp', { headers: { ...auth, 'Mcp-Session-Id': session }, body: { jsonrpc: '2.0', method: 'notifications/initialized' } });
});
step('tools/list devuelve las 12 herramientas', async () => {
  const r = await request('/mcp', { headers: { ...auth, 'Mcp-Session-Id': session }, body: { jsonrpc: '2.0', id: 2, method: 'tools/list' } });
  assert.equal(r.json.result.tools.length, 12);
});
step('tools/call retomar devuelve la memoria ficticia', async () => {
  const r = await request('/mcp', { headers: { ...auth, 'Mcp-Session-Id': session }, body: { jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'retomar', arguments: { id: '8dad3096-b455-4d56-aa6a-7d7725a9f4e4' } } } });
  assert.match(JSON.stringify(r.json.result.structuredContent), /cotizaciones de cajas/);
});
step('DELETE cierra la sesión', async () => {
  const r = await request('/mcp', { method: 'DELETE', headers: { ...auth, 'Mcp-Session-Id': session } });
  assert.ok(r.status < 300, String(r.status));
});

let failed = 0;
for (const [name, fn] of steps) {
  try { await fn(); console.log(`ok  ${name}`); } catch (error) { failed++; console.log(`MAL ${name}: ${error.message}`); }
}
console.log(failed ? `${failed} fallos` : 'todo bien');
process.exit(failed ? 1 : 0);
