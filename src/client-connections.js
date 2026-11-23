import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { productPaths, usesNativeMotor } from './layout.js';
import { checkHealthyConnector } from './connector.js';

const problem = code => Object.assign(new Error('La conexion requiere revision; se conserva el archivo.'), { code });
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

async function physical(value) {
  const dialect = /^(?:[A-Za-z]:[\\/]|\\\\)/u.test(value) ? path.win32 : path;
  if (!dialect.isAbsolute(value)) return null;
  const resolved = dialect.resolve(value);
  try { return await fs.realpath(resolved); }
  catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
    const parent = dialect.dirname(resolved);
    if (parent === resolved) return resolved;
    return dialect.join(await physical(parent) ?? parent, dialect.basename(resolved));
  }
}
async function canonical(value, platform) {
  if (typeof value !== 'string') return null;
  const result = await physical(value);
  if (result === null) return null;
  const normalized = result.replaceAll('\\', '/').replace(/\/$/u, '');
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}
async function same(left, right, platform) {
  const a = await canonical(left, platform), b = await canonical(right, platform);
  return a !== null && a === b;
}

function hasMcpCommand(args) {
  for (let index = 1; index < args.length; index++) {
    if (args[index] === '--base' || args[index] === '--carpeta') {
      if (typeof args[index + 1] !== 'string' || !args[index + 1].trim()) return false;
      index++;
    } else return args[index] === 'mcp';
  }
  return false;
}

async function replacements(entry, { root, runtime, manifest, platform, baseMigration }) {
  if (!isObject(entry) || typeof entry.command !== 'string' || !Array.isArray(entry.args)
      || entry.args.length < 2 || entry.args.some(value => typeof value !== 'string') || !hasMcpCommand(entry.args)) return null;
  const legacyNodes = [path.join(root, 'Runtime', 'node', 'node.exe'), path.join(root, 'Runtime', 'node', 'bin', 'node'),
    ...['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64'].map(target => path.join(root, 'Runtime', target, 'node', 'bin', 'node'))];
  const nodes = [...legacyNodes, runtime.nodeExecutable];
  let managed = false;
  for (const node of nodes) if (await same(entry.command, node, platform)) { managed = true; break; }
  if (!managed) return null;
  const paths = productPaths(root, manifest ?? { layoutVersion: 2 });
  const entries = [path.join(root, 'Motor', 'bin', 'mind.js'), paths.entrypoint, paths.agentEntrypoint];
  managed = false;
  for (const candidate of entries) if (await same(entry.args[0], candidate, platform)) { managed = true; break; }
  if (!managed) return null;
  const args = [...entry.args]; args[0] = paths.agentEntrypoint;
  let envMindBase;
  if (baseMigration && await same(baseMigration.from, path.join(root, 'Base'), platform)
      && await same(baseMigration.to, path.join(root, 'Sistema', 'Base'), platform)) {
    if (typeof entry.env?.MIND_BASE === 'string' && await same(entry.env.MIND_BASE, baseMigration.from, platform)) envMindBase = baseMigration.to;
    for (let index = 1; index < args.length; index++) {
      if (args[index] === '--base' && index + 1 < args.length && await same(args[index + 1], baseMigration.from, platform)) args[++index] = baseMigration.to;
      else if (args[index].startsWith('--base=') && await same(args[index].slice(7), baseMigration.from, platform)) args[index] = '--base=' + baseMigration.to;
    }
  }
  return { command: runtime.nodeExecutable, args, envMindBase };
}

/** String token parser. JSON.parse validates JSON; TOML support is deliberately literal-only. */
function stringToken(text, start, toml = false) {
  const quote = text[start];
  if (quote !== '"' && !(toml && quote === "'")) throw problem('CLIENT_CONNECTION_UNSUPPORTED');
  if (text.slice(start, start + 3) === quote.repeat(3)) throw problem('CLIENT_CONNECTION_UNSUPPORTED');
  let index = start + 1;
  for (; index < text.length; index++) {
    if (text[index] === '\n' || text[index] === '\r') throw problem('CLIENT_CONNECTION_UNSUPPORTED');
    if (quote === '"' && text[index] === '\\') { index++; continue; }
    if (text[index] === quote) {
      const raw = text.slice(start, index + 1);
      return { start, end: index + 1, value: quote === "'" ? raw.slice(1, -1) : JSON.parse(raw) };
    }
  }
  throw problem('CLIENT_CONNECTION_UNSUPPORTED');
}
function tomlFields(text) {
  const headers = [...text.matchAll(/^[ \t]*\[([^\r\n]+)\][ \t]*(?:#[^\r\n]*)?\r?$/gm)];
  const matches = headers.filter(match => /^(?:mcp_servers|"mcp_servers"|'mcp_servers')\.(?:mind|"mind"|'mind')$/u.test(match[1].trim()));
  if (!matches.length) return null;
  if (matches.length !== 1) throw problem('CLIENT_CONNECTION_AMBIGUOUS');
  const header = matches[0], start = header.index + header[0].length;
  const end = headers.find(match => match.index > header.index)?.index ?? text.length;
  const section = text.slice(start, end), fields = {};
  const skip = index => { for (;;) { while (/\s/u.test(text[index] ?? '') && index < end) index++; if (text[index] !== '#') return index; while (index < end && text[index] !== '\n') index++; } };
  for (const match of section.matchAll(/^[ \t]*(command|args)[ \t]*=[ \t]*/gm)) {
    const key = match[1]; if (fields[key]) throw problem('CLIENT_CONNECTION_AMBIGUOUS');
    let index = start + match.index + match[0].length;
    if (key === 'command') fields.command = stringToken(text, index, true);
    else {
      if (text[index++] !== '[') throw problem('CLIENT_CONNECTION_UNSUPPORTED');
      const items = [];
      for (;;) {
        index = skip(index); if (index >= end) throw problem('CLIENT_CONNECTION_UNSUPPORTED');
        if (text[index] === ']') { index++; break; }
        const item = stringToken(text, index, true); items.push(item); index = skip(item.end);
        if (text[index] === ']') { index++; break; }
        if (text[index++] !== ',') throw problem('CLIENT_CONNECTION_UNSUPPORTED');
      }
      fields.args = { start: start + match.index + match[0].length, items, value: items.map(item => item.value), end: index };
    }
    index = fields[key].end;
    while (text[index] === ' ' || text[index] === '\t') index++;
    if (index < end && !['#', '\r', '\n'].includes(text[index])) throw problem('CLIENT_CONNECTION_UNSUPPORTED');
  }
  const inline = [...section.matchAll(/^[ \t]*env[ \t]*=[ \t]*/gm)];
  const envHeaders = headers.filter(match => /^(?:mcp_servers|"mcp_servers"|'mcp_servers')\.(?:mind|"mind"|'mind')\.(?:env|"env"|'env')$/u.test(match[1].trim()));
  if (inline.length > 1 || envHeaders.length > 1 || (inline.length && envHeaders.length)) throw problem('CLIENT_CONNECTION_AMBIGUOUS');
  if (inline.length) {
    let index = start + inline[0].index + inline[0][0].length;
    if (text[index++] !== '{') throw problem('CLIENT_CONNECTION_UNSUPPORTED');
    const keys = new Set();
    for (;;) {
      while (text[index] === ' ' || text[index] === '\t') index++;
      if (text[index] === '}') break;
      let key;
      if (text[index] === '"' || text[index] === "'") { const token = stringToken(text,index,true); key = token.value; index = token.end; }
      else { const match = /^[A-Za-z0-9_-]+/u.exec(text.slice(index)); if (!match) throw problem('CLIENT_CONNECTION_UNSUPPORTED'); key = match[0]; index += key.length; }
      if (keys.has(key)) throw problem('CLIENT_CONNECTION_AMBIGUOUS'); keys.add(key);
      while (text[index] === ' ' || text[index] === '\t') index++;
      if (text[index++] !== '=') throw problem('CLIENT_CONNECTION_UNSUPPORTED');
      while (text[index] === ' ' || text[index] === '\t') index++;
      const token = stringToken(text,index,true); index = token.end;
      if (key === 'MIND_BASE') fields.envMindBase = token;
      while (text[index] === ' ' || text[index] === '\t') index++;
      if (text[index] === '}') break;
      if (text[index++] !== ',') throw problem('CLIENT_CONNECTION_UNSUPPORTED');
    }
    index++;
    while (text[index] === ' ' || text[index] === '\t') index++;
    if (index < end && !['#','\r','\n'].includes(text[index])) throw problem('CLIENT_CONNECTION_UNSUPPORTED');
  }
  if (envHeaders.length) {
    const envHeader = envHeaders[0], envStart = envHeader.index + envHeader[0].length;
    const envEnd = headers.find(match => match.index > envHeader.index)?.index ?? text.length;
    const matches = [...text.slice(envStart,envEnd).matchAll(/^[ \t]*(?:MIND_BASE|"MIND_BASE"|'MIND_BASE')[ \t]*=[ \t]*/gm)];
    if (matches.length > 1) throw problem('CLIENT_CONNECTION_AMBIGUOUS');
    if (matches.length) {
      fields.envMindBase = stringToken(text,envStart + matches[0].index + matches[0][0].length,true);
      let index = fields.envMindBase.end; while (text[index] === ' ' || text[index] === '\t') index++;
      if (index < envEnd && !['#','\r','\n'].includes(text[index])) throw problem('CLIENT_CONNECTION_UNSUPPORTED');
    }
  }
  return fields.command && fields.args ? fields : null;
}

function jsonNodes(text) {
  JSON.parse(text);
  const nodes = new Map();
  const skip = index => { while (/\s/u.test(text[index] ?? '') && index < text.length) index++; return index; };
  function value(start, route = [], depth = 0) {
    if (depth > 80) throw problem('CLIENT_CONNECTION_UNSUPPORTED');
    let index = skip(start), node;
    if (text[index] === '"') node = stringToken(text, index);
    else if (text[index] === '{') {
      index = skip(index + 1);
      while (text[index] !== '}') {
        const key = stringToken(text, index); index = skip(key.end) + 1;
        const child = value(index, [...route, key.value], depth + 1); index = skip(child.end);
        if (text[index] !== ',') break; index = skip(index + 1);
      }
      node = { start, end: index + 1 };
    } else if (text[index] === '[') {
      const items = []; index = skip(index + 1);
      while (text[index] !== ']') {
        const child = value(index, [...route, items.length], depth + 1); items.push(child); index = skip(child.end);
        if (text[index] !== ',') break; index = skip(index + 1);
      }
      node = { start, end: index + 1, items, value: items.map(item => item.value) };
    } else {
      const match = /^[^\s,}\]]+/u.exec(text.slice(index)); node = { start: index, end: index + match[0].length };
    }
    const key = route.join('\0'); if (nodes.has(key)) throw problem('CLIENT_CONNECTION_AMBIGUOUS'); nodes.set(key, node); return node;
  }
  value(0);
  return nodes;
}

function jsonFields(text) {
  const nodes = jsonNodes(text);
  const command = nodes.get('mcpServers\0mind\0command'), args = nodes.get('mcpServers\0mind\0args');
  return command && args?.items ? { command, args, envMindBase: nodes.get('mcpServers\0mind\0env\0MIND_BASE') } : null;
}
function edited(text, fields, next) {
  const changes = [];
  if (fields.envMindBase && next.envMindBase !== undefined && fields.envMindBase.value !== next.envMindBase) changes.push({ ...fields.envMindBase, value: next.envMindBase });
  if (fields.command.value !== next.command) changes.push({ ...fields.command, value: next.command });
  fields.args.items.forEach((item, index) => { if (item.value !== next.args[index]) changes.push({ ...item, value: next.args[index] }); });
  for (const change of changes.sort((a, b) => b.start - a.start)) text = text.slice(0, change.start) + JSON.stringify(change.value) + text.slice(change.end);
  return text;
}
async function readSafe(file, anchor) {
  const relative = path.relative(anchor, path.dirname(file));
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) throw problem('CLIENT_CONNECTION_UNSAFE');
  let current = anchor;
  const folder = await fs.lstat(current).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!folder) return null;
  if (!folder.isDirectory() || folder.isSymbolicLink()) throw problem('CLIENT_CONNECTION_UNSAFE');
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part); const info = await fs.lstat(current).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!info) return null;
    if (!info.isDirectory() || info.isSymbolicLink()) throw problem('CLIENT_CONNECTION_UNSAFE');
  }
  const info = await fs.lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!info) return null;
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 1024 * 1024) throw problem('CLIENT_CONNECTION_UNSAFE');
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== info.dev || opened.ino !== info.ino
        || opened.size !== info.size) throw problem('CLIENT_CONNECTION_CHANGED');
    const bytes = Buffer.alloc(info.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const last = await fs.lstat(file);
    if (length !== info.size || last.dev !== info.dev || last.ino !== info.ino
        || last.nlink !== 1 || last.mtimeMs !== info.mtimeMs || last.size !== info.size) {
      throw problem('CLIENT_CONNECTION_CHANGED');
    }
    return { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length)), info };
  } finally { await handle.close(); }
}
async function replaceSafe(file, anchor, previous, next) {
  const temporary = path.join(path.dirname(file), '.mind-connection-' + randomUUID() + '.tmp');
  const confirm = async () => {
    const current = await readSafe(file, anchor);
    if (!current || current.text !== previous.text || current.info.dev !== previous.info.dev || current.info.ino !== previous.info.ino) throw problem('CLIENT_CONNECTION_CHANGED');
  };
  try {
    await confirm();
    await fs.writeFile(temporary, next, { flag: 'wx', mode: previous.info.mode & 0o777 });
    await confirm();
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }); }
}

function buildManagedMcpSpec({ root, runtime, manifest }) {
  if (!runtime?.nodeExecutable) return null;
  const paths = productPaths(root, manifest ?? { layoutVersion: 2 });
  return { command: runtime.nodeExecutable, args: [paths.agentEntrypoint, 'mcp'] };
}

function insertMissingJson(text, spec) {
  const parsed = JSON.parse(text);
  if (!isObject(parsed)) return null;
  if (parsed.mcpServers !== undefined && !isObject(parsed.mcpServers)) return null;
  if (isObject(parsed.mcpServers) && parsed.mcpServers.mind !== undefined) return { conflict: true };
  const next = {
    ...parsed,
    mcpServers: {
      ...(parsed.mcpServers ?? {}),
      mind: { command: spec.command, args: spec.args },
    },
  };
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  let serialized = JSON.stringify(next, null, 2);
  if (eol !== '\n') serialized = serialized.replaceAll('\n', eol);
  return { content: serialized + (text.endsWith('\n') ? eol : '') };
}

function insertMissingToml(text, spec) {
  const headers = [...text.matchAll(/^[ \t]*\[([^\r\n]+)\][ \t]*(?:#[^\r\n]*)?\r?$/gm)];
  if (headers.some(match => /^(?:mcp_servers|"mcp_servers"|'mcp_servers')\.(?:mind|"mind"|'mind')(?:\.|$)/u.test(match[1].trim()))) {
    return { conflict: true };
  }
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const trimmedEnd = text.replace(/[\r\n]+$/u, '');
  const prefix = trimmedEnd.length ? trimmedEnd + eol + eol : '';
  const block = `[mcp_servers.mind]${eol}command = ${JSON.stringify(spec.command)}${eol}args = [${spec.args.map(arg => JSON.stringify(arg)).join(', ')}]${eol}`;
  return { content: prefix + block };
}

const HTTP_FIELDS = {
  'Codex': ['url', 'http_headers'],
  'Claude Code': ['url', 'headers'],
  'Gemini CLI': ['httpUrl', 'headers'],
  'Antigravity': ['serverUrl', 'headers'],
};
const MARKER = 'X-Mind-Managed';
const LOCAL_URL = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/mcp$/u;
const TOKEN = /^[\x21-\x7e]{32,256}$/u;
const TRANSPORT_FIELDS = new Set([
  'command', 'args', 'url', 'serverUrl', 'httpUrl', 'headers', 'http_headers', 'type',
  'env', 'env_vars', 'cwd', 'bearer_token_env_var', 'env_http_headers',
  'headersHelper', 'oauth', 'authProviderType',
]);

export function clientConnectionMode(manifest, mode) {
  const selected = mode ?? (usesNativeMotor(manifest) ? 'nativo' : 'legacy');
  if (!['nativo', 'r3', 'legacy'].includes(selected)) throw problem('CLIENT_CONNECTION_MODE');
  return selected;
}

async function connectionIdentity(options, mode) {
  const base = await physical(options.baseDirectory ?? productPaths(options.root, options.manifest).baseDirectory);
  const root = await canonical(options.root, options.platform);
  if (!base || !root) throw problem('CLIENT_CONNECTION_BASE_INVALID');
  const stored = await readSafe(path.join(base, 'conector-secreto.json'), base);
  let token;
  if (stored) {
    const secret = JSON.parse(stored.text);
    if (secret?.version === 1 && typeof secret.token === 'string' && TOKEN.test(secret.token)) token = secret.token;
  }
  let url;
  if (mode === 'nativo') {
    const active = await checkHealthyConnector(base);
    if (!token || !active || active.token !== token || active.health.backend !== 'rust'
        || active.health.port !== active.state.port || active.health.pid !== active.state.pid) {
      throw problem('CLIENT_CONNECTION_MOTOR_UNAVAILABLE');
    }
    url = active.url + '/mcp';
    if (!LOCAL_URL.test(url)) throw problem('CLIENT_CONNECTION_BASE_INVALID');
  }
  const baseKey = await canonical(base, options.platform);
  const marker = (endpoint, client) => createHmac('sha256', token)
    .update(JSON.stringify(['mind-http-1.0.5', root, baseKey, client, endpoint])).digest('hex');
  return { token, base, url, marker };
}

function isManagedHttp(entry, client, identity) {
  if (!identity.token) return false;
  const [urlKey, headersKey] = HTTP_FIELDS[client];
  const url = entry[urlKey], headers = entry[headersKey];
  const port = typeof url === 'string' && LOCAL_URL.exec(url);
  const allowed = [urlKey, headersKey, ...(client === 'Claude Code' ? ['type'] : [])];
  if (!port || Number(port[1]) > 65535 || !isObject(headers) || Object.keys(headers).length !== 2
      || headers.Authorization !== 'Bearer ' + identity.token
      || typeof headers[MARKER] !== 'string' || !/^[0-9a-f]{64}$/u.test(headers[MARKER])
      || (client === 'Claude Code' && entry.type !== 'http')
      || Object.keys(entry).some(key => TRANSPORT_FIELDS.has(key) && !allowed.includes(key))) return false;
  return timingSafeEqual(Buffer.from(headers[MARKER], 'hex'), Buffer.from(identity.marker(url, client), 'hex'));
}

function httpSpec(client, identity) {
  const [url, headers] = HTTP_FIELDS[client];
  return {
    ...(client === 'Claude Code' ? { type: 'http' } : {}),
    [url]: identity.url,
    [headers]: { Authorization: 'Bearer ' + identity.token, [MARKER]: identity.marker(identity.url, client) },
  };
}

async function legacySpec(options, identity, client) {
  const spec = buildManagedMcpSpec(options);
  if (!spec) throw problem('CLIENT_CONNECTION_RUNTIME_REQUIRED');
  if (!await same(identity.base, productPaths(options.root, options.manifest).baseDirectory, options.platform)) {
    spec.args.push('--base', identity.base);
  }
  return client === 'Claude Code' ? { type: 'stdio', ...spec } : spec;
}

async function switchableLegacy(entry, options, identity) {
  const legacy = await replacements(entry, options);
  if (!legacy || (entry.type !== undefined && entry.type !== 'stdio')) return false;
  if (Object.keys(entry).some(key => TRANSPORT_FIELDS.has(key) && !['command', 'args', 'type'].includes(key))) {
    throw problem('CLIENT_CONNECTION_CUSTOM_SCOPE');
  }
  const args = legacy.args.slice(1);
  let chosenBase;
  let hasMcp = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === 'mcp' && !hasMcp) hasMcp = true;
    else if (chosenBase === undefined && arg === '--base') chosenBase = args[++index];
    else if (chosenBase === undefined && arg.startsWith('--base=')) chosenBase = arg.slice(7);
    else throw problem('CLIENT_CONNECTION_CUSTOM_SCOPE');
  }
  const base = chosenBase ?? productPaths(options.root, options.manifest).baseDirectory;
  if (!hasMcp || !await same(base, identity.base, options.platform)) throw problem('CLIENT_CONNECTION_CUSTOM_SCOPE');
  return true;
}

function tomlNative(text) {
  if (text.includes('"""') || text.includes("'''")) throw problem('CLIENT_CONNECTION_UNSUPPORTED');
  const headers = [...text.matchAll(/^[ \t]*\[([^\r\n]+)\][ \t]*(?:#[^\r\n]*)?\r?$/gm)];
  const root = /^(?:mcp_servers|"mcp_servers"|'mcp_servers')\s*\.\s*(?:mind|"mind"|'mind')(?:\s*\.|$)/u;
  const owned = headers.filter(header => root.test(header[1].trim()));
  if (!owned.length) {
    if (/^[ \t]*(?:mcp_servers|"mcp_servers"|'mcp_servers')[ \t]*(?:\.|=)/mu.test(text)
        || headers.some(h => /^(?:mcp_servers|"mcp_servers"|'mcp_servers')$/u.test(h[1].trim()))) {
      throw problem('CLIENT_CONNECTION_UNSUPPORTED');
    }
    return null;
  }
  const nested = owned.some(header => !/^(?:mcp_servers|"mcp_servers"|'mcp_servers')\s*\.\s*(?:mind|"mind"|'mind')$/u.test(header[1].trim()));
  if (owned.length !== 1 || nested) throw problem('CLIENT_CONNECTION_UNSUPPORTED');
  const head = owned[0];
  const start = head.index + head[0].length;
  const end = headers.find(match => match.index > head.index)?.index ?? text.length;
  const section = text.slice(start, end);
  const entry = {}, spans = [];
  const old = tomlFields(text);
  function register(key, first, last, value, where = first) {
    if (Object.hasOwn(entry, key)) throw problem('CLIENT_CONNECTION_AMBIGUOUS');
    const eol = text.indexOf('\n', last);
    const lineEnd = eol < 0 ? text.length : eol + 1;
    const comment = /^[ \t]*(#[^\r\n]*)?[ \t]*\r?\n?$/u.exec(text.slice(last, lineEnd));
    if (!comment) throw problem('CLIENT_CONNECTION_UNSUPPORTED');
    spans.push({ start: where, end: lineEnd, comment: comment[1] });
    entry[key] = value;
  }
  if (old) {
    register('command', old.command.start, old.command.end, old.command.value, text.lastIndexOf('\n', old.command.start - 1) + 1);
    register('args', old.args.start, old.args.end, old.args.value, text.lastIndexOf('\n', old.args.start - 1) + 1);
  }
  for (const match of section.matchAll(/^[ \t]*([A-Za-z_][A-Za-z0-9_-]*|"[^"\r\n]+"|'[^'\r\n]+')[ \t]*=[ \t]*/gmu)) {
    const key = match[1].replace(/^["']|["']$/gu, '');
    if (!TRANSPORT_FIELDS.has(key)) continue;
    const offset = start + match.index + match[0].length;
    if (key === 'args' || key === 'command') {
      if (!old || match[1] !== key) throw problem('CLIENT_CONNECTION_UNSUPPORTED');
    } else if (key === 'url') {
      const url = stringToken(text, offset, true);
      register(key, offset, url.end, url.value, start + match.index);
    } else if (key === 'http_headers') {
      const inline = /^\{\s*Authorization\s*=\s*("(?:[^"\\\r\n]|\\.)*")\s*,\s*"X-Mind-Managed"\s*=\s*("[a-f0-9]{64}")\s*\}/u.exec(text.slice(offset, end));
      if (!inline) throw problem('CLIENT_CONNECTION_UNSUPPORTED');
      register(key, offset, offset + inline[0].length, { Authorization: JSON.parse(inline[1]), [MARKER]: JSON.parse(inline[2]) }, start + match.index);
    } else {
      throw problem('CLIENT_CONNECTION_CUSTOM_SCOPE');
    }
  }
  return { entry, spans };
}

function renderTransportToml(spec, eol) {
  if (spec.url) {
    const headers = spec.http_headers;
    return 'url = ' + JSON.stringify(spec.url) + eol
      + 'http_headers = { Authorization = ' + JSON.stringify(headers.Authorization)
      + ', "' + MARKER + '" = ' + JSON.stringify(headers[MARKER]) + ' }' + eol;
  }
  return 'command = ' + JSON.stringify(spec.command) + eol + 'args = ' + JSON.stringify(spec.args) + eol;
}

function changeToml(text, parsed, spec) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const rendered = renderTransportToml(spec, eol);
  if (!parsed) return text + (text && !text.endsWith('\n') ? eol : '') + (text ? eol : '')
    + '[mcp_servers.mind]' + eol + rendered;
  const spans = parsed.spans.sort((a, b) => a.start - b.start);
  if (spans.length !== 2 || spans[0].end > spans[1].start) throw problem('CLIENT_CONNECTION_UNSUPPORTED');
  const [first, second] = spans;
  const comment = span => span.comment ? span.comment + eol : '';
  return text.slice(0, first.start) + comment(first) + rendered
    + text.slice(first.end, second.start) + comment(second) + text.slice(second.end);
}

function jsonNative(text) {
  const nodes = jsonNodes(text);
  const root = JSON.parse(text);
  if (!isObject(root) || (root.mcpServers !== undefined && !isObject(root.mcpServers))) throw problem('CLIENT_CONNECTION_UNSUPPORTED');
  const entry = root.mcpServers?.mind;
  return { entry, span: nodes.get('mcpServers\0mind'), servers: nodes.get('mcpServers'), root: nodes.get(''), value: root };
}

function changeJson(text, parsed, spec) {
  if (parsed.span) {
    const extra = Object.fromEntries(Object.entries(parsed.entry).filter(([key]) => !TRANSPORT_FIELDS.has(key)));
    return text.slice(0, parsed.span.start) + JSON.stringify({ ...extra, ...spec }) + text.slice(parsed.span.end);
  }
  const node = parsed.servers ?? parsed.root;
  const fields = parsed.servers ? parsed.value.mcpServers : parsed.value;
  const insert = parsed.servers ? '"mind": ' + JSON.stringify(spec) : '"mcpServers": {"mind": ' + JSON.stringify(spec) + '}';
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  return text.slice(0, node.end - 1) + (Object.keys(fields).length ? ',' : '') + eol + '  ' + insert + eol + text.slice(node.end - 1);
}

async function configureNative(file, anchor, format, client, previous, options, mode, identity) {
  const text = previous?.text ?? (format === 'toml' ? '' : '{}\n');
  const parsed = format === 'toml' ? tomlNative(text) : jsonNative(text);
  const entry = parsed?.entry;
  const hasEntry = entry !== undefined;
  if (hasEntry && !isObject(entry)) return 'ajena';
  const owned = hasEntry && isManagedHttp(entry, client, identity);
  if (mode === 'r3' && !owned) return hasEntry ? 'ajena' : 'sin-servidor-administrado';
  if (mode === 'nativo' && hasEntry && !owned && !await switchableLegacy(entry, options, identity)) return 'ajena';
  if (!hasEntry && !options.createMissing) return 'sin-servidor-administrado';
  const next = mode === 'r3' ? await legacySpec(options, identity, client) : httpSpec(client, identity);
  if (owned && mode === 'nativo' && entry[HTTP_FIELDS[client][0]] === identity.url) return 'vigente';
  const content = format === 'toml' ? changeToml(text, parsed, next) : changeJson(text, parsed, next);
  if (previous) await replaceSafe(file, anchor, previous, content);
  else {
    if (await readSafe(file, anchor) !== null) throw problem('CLIENT_CONNECTION_CHANGED');
    await fs.writeFile(file, content, { flag: 'wx', mode: 0o600 });
  }
  return mode === 'r3' ? 'revertida' : hasEntry ? 'actualizada' : 'creada';
}

/** Updates existing managed entries and optionally creates missing ones in detected client configs without overwriting foreign entries. */
export async function updateManagedClientConnections({ root, runtime, manifest, home = os.homedir(), env = process.env, platform = process.platform, baseMigration, createMissing = false, mode, baseDirectory } = {}) {
  if (!root || env.MIND_AGENT_STARTUP === '0') return [];
  baseMigration ??= env.MIND_BASE_MIGRATED_FROM && env.MIND_BASE_MIGRATED_TO ? { from: env.MIND_BASE_MIGRATED_FROM, to: env.MIND_BASE_MIGRATED_TO } : null;
  const codexHome = env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(home, '.codex');
  const geminiHome = env.GEMINI_CLI_HOME ? path.resolve(env.GEMINI_CLI_HOME) : home;
  const candidates = [
    ['Codex', path.join(codexHome, 'config.toml'), codexHome, 'toml'],
    ['Claude Code', path.join(home, '.claude.json'), home, 'json'],
    ['Gemini CLI', path.join(geminiHome, '.gemini', 'settings.json'), geminiHome, 'json'],
    // Antigravity ha usado las dos ubicaciones según versión; solo se toca la que exista.
    ['Antigravity', path.join(home, '.gemini', 'config', 'mcp_config.json'), home, 'json'],
    ['Antigravity', path.join(home, '.gemini', 'antigravity', 'mcp_config.json'), home, 'json'],
  ];
  mode = clientConnectionMode(manifest, mode);
  const options = { root, runtime, manifest, platform, baseMigration, baseDirectory, createMissing };
  let identity, unavailable;
  if (mode !== 'legacy') {
    try { identity = await connectionIdentity(options, mode); }
    catch (error) { unavailable = error; }
  }
  const results = [];
  for (const [client, file, anchor, format] of candidates) {
    try {
      const previous = await readSafe(file, anchor);
      if (!previous) {
        if (mode !== 'nativo' || !createMissing) continue;
        const detected = client === 'Claude Code' ? path.join(home, '.claude') : path.dirname(file);
        const folder = await fs.lstat(detected).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        if (!folder) continue;
        if (!folder.isDirectory() || folder.isSymbolicLink()) throw problem('CLIENT_CONNECTION_UNSAFE');
      }
      if (mode !== 'legacy') {
        if (unavailable) throw unavailable;
        const estado = await configureNative(file, anchor, format, client, previous, options, mode, identity);
        results.push({ cliente: client, archivo: file, estado });
        continue;
      }
      const fields = format === 'toml' ? tomlFields(previous.text) : jsonFields(previous.text);
      if (!fields) {
        if (!createMissing) { results.push({ cliente: client, archivo: file, estado: 'sin-servidor-administrado' }); continue; }
        const spec = buildManagedMcpSpec({ root, runtime, manifest });
        const inserted = spec ? (format === 'toml' ? insertMissingToml(previous.text, spec) : insertMissingJson(previous.text, spec)) : null;
        if (!inserted) { results.push({ cliente: client, archivo: file, estado: 'sin-servidor-administrado' }); continue; }
        if (inserted.conflict) { results.push({ cliente: client, archivo: file, estado: 'ajena' }); continue; }
        await replaceSafe(file, anchor, previous, inserted.content);
        results.push({ cliente: client, archivo: file, estado: 'creada' });
        continue;
      }
      const json = format === 'json' ? JSON.parse(previous.text).mcpServers?.mind : null;
      const entry = { ...json, command: fields.command.value, args: fields.args.value, env: fields.envMindBase ? { ...(json?.env ?? {}), MIND_BASE: fields.envMindBase.value } : json?.env };
      const next = await replacements(entry, { root, runtime, manifest, platform, baseMigration });
      if (!next) { results.push({ cliente: client, archivo: file, estado: 'ajena' }); continue; }
      const content = edited(previous.text, fields, next);
      if (content !== previous.text) await replaceSafe(file, anchor, previous, content);
      results.push({ cliente: client, archivo: file, estado: content === previous.text ? 'vigente' : 'actualizada' });
    } catch (error) {
      results.push({ cliente: client, archivo: file, estado: 'pendiente', codigo: error.code ?? 'CLIENT_CONNECTION_INVALID' });
    }
  }
  return results;
}