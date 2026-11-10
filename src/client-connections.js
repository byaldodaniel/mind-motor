import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { productPaths } from './layout.js';

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
      fields.args = { items, value: items.map(item => item.value), end: index };
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

function jsonFields(text) {
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
  let current = anchor;
  const folder = await fs.lstat(current).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!folder) return null;
  if (!folder.isDirectory() || folder.isSymbolicLink()) throw problem('CLIENT_CONNECTION_UNSAFE');
  for (const part of path.relative(anchor, path.dirname(file)).split(path.sep).filter(Boolean)) {
    current = path.join(current, part); const info = await fs.lstat(current).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!info) return null;
    if (!info.isDirectory() || info.isSymbolicLink()) throw problem('CLIENT_CONNECTION_UNSAFE');
  }
  const info = await fs.lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!info) return null;
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 1024 * 1024) throw problem('CLIENT_CONNECTION_UNSAFE');
  return { text: await fs.readFile(file, 'utf8'), info };
}
async function replaceSafe(file, anchor, previous, next) {
  const temporary = path.join(path.dirname(file), '.mind-connection-' + randomUUID() + '.tmp');
  try {
    await fs.writeFile(temporary, next, { flag: 'wx', mode: previous.info.mode & 0o777 });
    const current = await readSafe(file, anchor);
    if (!current || current.text !== previous.text || current.info.dev !== previous.info.dev || current.info.ino !== previous.info.ino) throw problem('CLIENT_CONNECTION_CHANGED');
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }); }
}

/** Updates existing managed entries only. It never creates a server or exports configuration values. */
export async function updateManagedClientConnections({ root, runtime, manifest, home = os.homedir(), env = process.env, platform = process.platform, baseMigration } = {}) {
  if (!root || env.MIND_AGENT_STARTUP === '0') return [];
  baseMigration ??= env.MIND_BASE_MIGRATED_FROM && env.MIND_BASE_MIGRATED_TO ? { from: env.MIND_BASE_MIGRATED_FROM, to: env.MIND_BASE_MIGRATED_TO } : null;
  const codexHome = env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(home, '.codex');
  const candidates = [
    ['Codex', path.join(codexHome, 'config.toml'), codexHome, 'toml'],
    ['Claude Code', path.join(home, '.claude.json'), home, 'json'],
    ['Gemini CLI', path.join(home, '.gemini', 'settings.json'), home, 'json'],
    ['Antigravity', path.join(home, '.gemini', 'antigravity', 'mcp_config.json'), home, 'json'],
  ];
  const results = [];
  for (const [client, file, anchor, format] of candidates) {
    try {
      const previous = await readSafe(file, anchor); if (!previous) continue;
      const fields = format === 'toml' ? tomlFields(previous.text) : jsonFields(previous.text);
      if (!fields) { results.push({ cliente: client, archivo: file, estado: 'sin-servidor-administrado' }); continue; }
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