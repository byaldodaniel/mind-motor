// Captura el contrato observable de Mind 1.0.4-r3 sobre una Base ficticia.
//
// Arranca el Motor Central real de este repositorio (src/) en una Base temporal
// fuera del Motor, y registra lo que cualquier pieza nativa debe respetar:
// formato de Base, esquema SQLite del catálogo, campos de /health, acciones de
// /rpc, versiones MCP y el catálogo de herramientas que reciben los agentes.
// Registra tipos y huellas, no valores de una instalación concreta.
//
// Uso:  node nativo/contracts/r3/capturar.mjs            (imprime el contrato)
//       node nativo/contracts/r3/capturar.mjs --escribir (actualiza contrato-r3.json)
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RUNS } from '../../test/runs.mjs';
import { BASE_FORMAT_VERSION } from '../../../src/base-format.js';
import { SUPPORTED_PROTOCOL_VERSIONS } from '../../../src/mcp-core.js';
import { CATALOG_FILENAME, withCatalog } from '../../../src/sqlite-catalog.js';
import { CONNECTOR_SECRET_FILE } from '../../../src/connector.js';
import { MOTOR_VERSION } from '../../../src/version.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NATIVO = path.resolve(HERE, '..', '..');
export const CONTRACT_FILE = path.join(HERE, 'contrato-r3.json');

/** JSON con claves ordenadas: la huella no depende del orden de escritura. */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function request({ port, method, pathName, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port, method, path: pathName, headers: {
      ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}),
      Accept: 'application/json, text/event-stream', ...headers,
    } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json = null;
        if (String(res.headers['content-type']).includes('text/event-stream')) {
          const line = text.split(/\r?\n/u).filter((l) => l.startsWith('data:')).at(-1);
          json = line ? JSON.parse(line.slice(5)) : null;
        } else if (text) json = JSON.parse(text);
        resolve({ status: res.statusCode, headers: res.headers, json });
      });
    });
    req.setTimeout(30_000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function catalogSchema() {
  const base = await fs.mkdtemp(path.join(RUNS, 'contrato-catalogo-'));
  try {
    return await withCatalog(base, { write: true, create: true }, (db) => db
      .prepare("SELECT type, name, tbl_name AS tabla, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
      .all()
      .map((row) => ({ ...row, sql: String(row.sql ?? '').replace(/\s+/gu, ' ').trim() })));
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
}

async function withRealMotor(fn) {
  const root = await fs.mkdtemp(path.join(RUNS, 'contrato-motor-'));
  const base = path.join(root, 'Base');
  await fs.mkdir(base);
  const child = spawn(process.execPath, [path.join(NATIVO, 'test', 'real-motor.mjs'), base], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, MIND_AGENT_STARTUP: '0' },
  });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  try {
    let connector = null;
    for (let i = 0; i < 300 && !connector; i++) {
      connector = await fs.readFile(path.join(base, 'conector.json'), 'utf8').then(JSON.parse).catch(() => null);
      if (!connector) {
        if (child.exitCode !== null) throw new Error(`El Motor terminó al arrancar (${child.exitCode}): ${stderr}`);
        await wait(100);
      }
    }
    if (!connector) throw new Error(`El Motor no publicó conector.json: ${stderr}`);
    const { token } = JSON.parse(await fs.readFile(path.join(base, CONNECTOR_SECRET_FILE), 'utf8'));
    return await fn({ port: connector.port, token, connector });
  } finally {
    child.kill();
    await new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r)));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

export async function captureContract() {
  const wire = await withRealMotor(async ({ port, token, connector }) => {
    const nonce = crypto.randomBytes(16).toString('hex');
    const health = await request({ port, method: 'GET', pathName: `/health?nonce=${nonce}` });
    const auth = { Authorization: `Bearer ${token}` };
    const sinToken = await request({ port, method: 'POST', pathName: '/rpc', body: { accion: 'ping' } });
    const ping = await request({ port, method: 'POST', pathName: '/rpc', headers: auth, body: { accion: 'ping' } });
    const desconocida = await request({ port, method: 'POST', pathName: '/rpc', headers: auth, body: { accion: 'no-existe' } });
    const init = await request({ port, method: 'POST', pathName: '/mcp', headers: auth, body: {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: SUPPORTED_PROTOCOL_VERSIONS[0], capabilities: {}, clientInfo: { name: 'contrato-r3', version: '1' } },
    } });
    const session = init.headers['mcp-session-id'];
    const mcp = { ...auth, ...(session ? { 'Mcp-Session-Id': session } : {}) };
    await request({ port, method: 'POST', pathName: '/mcp', headers: mcp, body: { jsonrpc: '2.0', method: 'notifications/initialized' } });
    const list = await request({ port, method: 'POST', pathName: '/mcp', headers: mcp, body: { jsonrpc: '2.0', id: 2, method: 'tools/list' } });
    if (session) await request({ port, method: 'DELETE', pathName: '/mcp', headers: mcp });
    return { connector, health, sinToken, ping, desconocida, init, list };
  });

  const tools = wire.list.json?.result?.tools ?? [];
  const instructions = wire.init.json?.result?.instructions ?? '';
  const listBytes = Buffer.byteLength(JSON.stringify(wire.list.json?.result ?? {}));
  return {
    formato: 'mind-contrato',
    version: 1,
    origen: { motorVersion: MOTOR_VERSION, nota: 'Capturado del Motor Central de src/ sobre una Base ficticia.' },
    base: { formatVersion: BASE_FORMAT_VERSION, catalogo: CATALOG_FILENAME, esquemaCatalogo: await catalogSchema() },
    conector: Object.fromEntries(Object.entries(wire.connector).map(([k, v]) => [k, typeOf(v)]).sort()),
    http: {
      health: { status: wire.health.status, campos: Object.fromEntries(Object.entries(wire.health.json ?? {}).map(([k, v]) => [k, typeOf(v)]).sort()) },
      rpcSinToken: { status: wire.sinToken.status },
      rpcPing: { status: wire.ping.status, campos: Object.keys(wire.ping.json ?? {}).sort() },
      rpcAccionDesconocida: { status: wire.desconocida.status, codigo: wire.desconocida.json?.error?.codigo ?? null },
      rpcAcciones: ['apagar', 'estado', 'herramienta', 'inicio', 'ping', 'quietud', 'verificar-actualizacion'],
    },
    mcp: {
      versionesProtocolo: [...SUPPORTED_PROTOCOL_VERSIONS],
      versionNegociada: wire.init.json?.result?.protocolVersion ?? null,
      sesionEnCabecera: Boolean(wire.init.headers['mcp-session-id']),
      capacidades: Object.keys(wire.init.json?.result?.capabilities ?? {}).sort(),
      instrucciones: { bytes: Buffer.byteLength(instructions), sha256: sha256(instructions) },
      herramientas: tools.map((t) => ({
        nombre: t.name,
        esquemaSha256: sha256(canonical(t.inputSchema ?? null)),
        anotaciones: t.annotations ?? null,
        descripcionBytes: Buffer.byteLength(t.description ?? ''),
      })).sort((a, b) => a.nombre.localeCompare(b.nombre)),
      // Línea base del contexto que paga cada agente al cargar el catálogo completo.
      presupuesto: { herramientas: tools.length, catalogoBytes: listBytes, instruccionesBytes: Buffer.byteLength(instructions) },
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const contract = await captureContract();
  const text = `${JSON.stringify(contract, null, 2)}\n`;
  if (process.argv.includes('--escribir')) {
    await fs.writeFile(CONTRACT_FILE, text);
    console.error(`Contrato escrito en ${CONTRACT_FILE}`);
  } else process.stdout.write(text);
}
