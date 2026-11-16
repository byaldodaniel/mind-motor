import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { MotorError } from './errors.js';
import { fold } from './search.js';
import { isExcluded } from './paths.js';
import { prepareBaseFormat } from './base-format.js';
import { withCatalog } from './sqlite-catalog.js';

const MAX_MARK_FILE_BYTES = 512 * 1024;
const TEXT_MARK_EXTENSIONS = new Set(['.md', '.txt']);

const DEFAULT_ALIASES = new Map([
  ['pendiente', 'pendiente'],
  ['pendientes', 'pendiente'],
  ['tarea', 'pendiente'],
  ['tareas', 'pendiente'],
  ['actividad', 'pendiente'],
  ['actividades', 'pendiente'],
  ['todo', 'pendiente'],
  ['todos', 'pendiente'],
  ['accion', 'pendiente'],
  ['acciones', 'pendiente'],
  ['idea', 'idea'],
  ['ideas', 'idea'],
  ['decision', 'decision'],
  ['decisiones', 'decision'],
  ['bloqueo', 'bloqueo'],
  ['bloqueos', 'bloqueo'],
  ['bloqueado', 'bloqueo'],
  ['urgente', 'urgente'],
  ['urgentes', 'urgente'],
]);

const CLOSED_STATUS_WORDS = new Set(['cerrado', 'cerrada', 'completado', 'completada', 'hecho', 'hecha', 'resuelto', 'resuelta', 'done']);
const META_PROPERTY_WORDS = new Set(['abierto', 'abierta', 'en curso', ...CLOSED_STATUS_WORDS]);

export function normalizeBaseTag(raw) {
  if (typeof raw !== 'string') return '';
  const cleaned = raw.trim().replace(/^#+/u, '');
  return fold(cleaned).replace(/\s+/gu, '-');
}

export function normalizeTag(raw, aliasMap = null) {
  const base = normalizeBaseTag(raw);
  if (!base) return '';
  if (aliasMap?.has(base)) return aliasMap.get(base);
  return DEFAULT_ALIASES.get(base) ?? base;
}

function stripMetaExamples(line) {
  // Remove parenthetical tag lists such as "(#pendiente, #idea)" or "(por ejemplo #pendiente)".
  return line
    .replace(/\((?:[^()]*#[\p{L}\p{N}_-]+[^()]*,)+[^()]*\)/gu, ' ')
    .replace(/\((?:por\s+ejemplo|p\.?\s*ej\.?|ej\.?|como|such as|e\.g\.)\s*[^()]*#[\p{L}\p{N}_-]+[^()]*\)/giu, ' ')
    .replace(/`#[\p{L}\p{N}_-]+`\s*,\s*`#[\p{L}\p{N}_-]+`(?:\s*,\s*`#[\p{L}\p{N}_-]+`)*/gu, ' ');
}

function cleanInlineMarkdown(text) {
  return text
    .replace(/`([^`]*)`/gu, '$1')
    .replace(/\*\*([^*]+)\*\*/gu, '$1')
    .replace(/~~([^~]+)~~/gu, '$1')
    .replace(/\s+/gu, ' ')
    .trim();
}

function detectBlockStatus(blockLines) {
  const first = blockLines[0] ?? '';
  if (/^\s*(?:[-*+]|\d+\.)\s+\[(?:x|X)\]/u.test(first)) return 'cerrado';
  const joined = blockLines.join(' ');
  const withoutBullet = first.replace(/^\s*(?:[-*+]|\d+\.)\s+(?:\[.\]\s+)?/u, '').trim();
  if (/^~~.+~~$/u.test(withoutBullet)) return 'cerrado';
  if (/(?:^|\s)#(?:cerrad[oa]|hech[oa]|completad[oa]|resuelt[oa]|done)(?=$|\s|`|[,.;:)!])/iu.test(joined)) {
    return 'cerrado';
  }
  const statusMatch = /(?:^|\b)(?:\*\*)?(?:estado|status)(?:\*\*)?:\s*([a-zA-ZáéíóúñÁÉÍÓÚÑ_-]+)/iu.exec(joined);
  if (statusMatch && CLOSED_STATUS_WORDS.has(fold(statusMatch[1]))) return 'cerrado';
  return 'abierto';
}

function extractTagsFromBlock(blockLines, blockType, aliasMap) {
  const tags = [];
  const seen = new Set();

  const pushTag = (raw) => {
    const cleanRaw = raw.trim().replace(/^#+/u, '');
    if (!cleanRaw) return;
    const base = normalizeBaseTag(cleanRaw);
    if (!base || CLOSED_STATUS_WORDS.has(base)) return;
    const canonical = normalizeTag(base, aliasMap);
    if (!canonical || seen.has(canonical)) return;
    seen.add(canonical);
    tags.push({ tag: canonical, rawTag: `#${cleanRaw}` });
  };

  const first = blockLines[0] ?? '';
  const hasTaskCheckbox = /^\s*(?:[-*+]|\d+\.)\s+\[[ xX]\]\s*/u.test(first);

  for (const line of blockLines) {
    const candidate = stripMetaExamples(line);
    const hashRegex = /(?:^|[\s`([{-])#([\p{L}][\p{L}\p{N}_-]{1,63})(?=$|[\s`)\]},.;:!?])/gu;
    let match;
    while ((match = hashRegex.exec(candidate)) !== null) {
      pushTag(match[1]);
    }

    const propRegex = /^\s*(?:[-*+]\s*)?(?:\*\*)?(?:etiquetas?|tags?|tipo|categor[ií]a|estado)(?:\*\*)?:\s*(.+)$/iu;
    const propMatch = propRegex.exec(candidate);
    if (propMatch) {
      for (const token of propMatch[1].split(/[,;]+/u)) {
        const stripped = token.replace(/^\s*#?|\s*$/gu, '').replace(/\*+|`/gu, '').trim();
        if (stripped && !META_PROPERTY_WORDS.has(fold(stripped)) && /^[\p{L}][\p{L}\p{N}_\s-]{0,40}$/u.test(stripped)) {
          pushTag(stripped);
        }
      }
    }
  }

  if (hasTaskCheckbox && !seen.has('pendiente') && blockType === 'list-item') {
    tags.push({ tag: 'pendiente', rawTag: 'task-list' });
  }
  return tags;
}

/** Extracts block-level Markdown marks (#pendiente, #idea, task lists [ ]/[x], Etiqueta:/Estado:) ignoring code fences and prose examples. */
export function extractDocumentMarks(content, _relativePath = '', aliasMap = null) {
  if (typeof content !== 'string' || content.length === 0) return [];
  const lines = content.replace(/\r\n?/gu, '\n').split('\n');
  const marks = [];
  let inFence = false;
  let fenceChar = '';
  let currentHeading = null;
  let blockIndex = 0;

  let index = 0;
  while (index < lines.length) {
    const rawLine = lines[index];
    const fenceMatch = /^\s*(```+|~~~+)/u.exec(rawLine);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (!inFence) {
        inFence = true;
        fenceChar = marker;
      } else if (fenceChar === marker) {
        inFence = false;
        fenceChar = '';
      }
      index += 1;
      continue;
    }
    if (inFence) {
      index += 1;
      continue;
    }
    if (!rawLine.trim()) {
      index += 1;
      continue;
    }

    const headingMatch = /^(#{1,6})\s+(.+?)\s*#*$/u.exec(rawLine.trim());
    if (headingMatch) {
      const lineNumber = index + 1;
      const headingText = cleanInlineMarkdown(headingMatch[2]);
      const blockTags = extractTagsFromBlock([rawLine], 'heading', aliasMap);
      if (blockTags.length > 0) {
        const status = detectBlockStatus([rawLine]);
        for (const item of blockTags) {
          marks.push({
            blockIndex,
            heading: currentHeading,
            lineNumber,
            blockType: 'heading',
            tag: item.tag,
            rawTag: item.rawTag,
            status,
            excerpt: headingText.slice(0, 240),
          });
        }
        blockIndex += 1;
      }
      currentHeading = headingText;
      index += 1;
      continue;
    }

    const listMatch = /^(\s*)(?:[-*+]|\d+\.)\s+(.*)$/u.exec(rawLine);
    if (listMatch) {
      const baseIndent = listMatch[1].length;
      const startLine = index + 1;
      const blockLines = [rawLine];
      index += 1;
      while (index < lines.length) {
        const nextLine = lines[index];
        if (!nextLine.trim()) break;
        if (/^\s*(?:```+|~~~+|#{1,6}\s+)/u.test(nextLine)) break;
        const nextList = /^(\s*)(?:[-*+]|\d+\.)\s+/u.exec(nextLine);
        if (nextList && nextList[1].length <= baseIndent) break;
        blockLines.push(nextLine);
        index += 1;
      }
      const blockTags = extractTagsFromBlock(blockLines, 'list-item', aliasMap);
      if (blockTags.length > 0) {
        const status = detectBlockStatus(blockLines);
        const excerpt = cleanInlineMarkdown(
          blockLines[0].replace(/^\s*(?:[-*+]|\d+\.)\s+(?:\[[ xX]\]\s+)?/u, '')
            + (blockLines.length > 1 ? ` ${blockLines.slice(1).map((l) => l.trim()).join(' ')}` : ''),
        ).slice(0, 240);
        for (const item of blockTags) {
          marks.push({
            blockIndex,
            heading: currentHeading,
            lineNumber: startLine,
            blockType: 'list-item',
            tag: item.tag,
            rawTag: item.rawTag,
            status,
            excerpt,
          });
        }
        blockIndex += 1;
      }
      continue;
    }

    const startLine = index + 1;
    const blockLines = [rawLine];
    index += 1;
    while (index < lines.length) {
      const nextLine = lines[index];
      if (!nextLine.trim()) break;
      if (/^\s*(?:```+|~~~+|#{1,6}\s+|(?:[-*+]|\d+\.)\s+)/u.test(nextLine)) break;
      blockLines.push(nextLine);
      index += 1;
    }
    const blockTags = extractTagsFromBlock(blockLines, 'paragraph', aliasMap);
    if (blockTags.length > 0) {
      const status = detectBlockStatus(blockLines);
      const excerpt = cleanInlineMarkdown(blockLines.join(' ')).slice(0, 240);
      for (const item of blockTags) {
        marks.push({
          blockIndex,
          heading: currentHeading,
          lineNumber: startLine,
          blockType: 'paragraph',
          tag: item.tag,
          rawTag: item.rawTag,
          status,
          excerpt,
        });
      }
      blockIndex += 1;
    }
  }
  return marks;
}

function isMarkCandidate(entry, exclusions) {
  if (entry.type !== 'file' || entry.state !== 'indexed') return false;
  if (entry.size === null || entry.size > MAX_MARK_FILE_BYTES) return false;
  const dot = entry.path.lastIndexOf('.');
  if (dot === -1) return false;
  const ext = entry.path.slice(dot).toLowerCase();
  if (!TEXT_MARK_EXTENSIONS.has(ext)) return false;
  return !isExcluded(exclusions, entry.path);
}

function entryFingerprint(entry) {
  return `${entry.size ?? 0}:${entry.modifiedAt ?? ''}:${entry.identity ?? ''}`;
}

async function readMarkCandidateSafe(rootPath, relativePath, expectedSize) {
  const segments = String(relativePath ?? '').split('/').filter(Boolean);
  if (segments.length === 0 || segments.some((seg) => seg === '.' || seg === '..')) return null;

  let cursor = path.resolve(rootPath);
  let info = null;
  for (let i = 0; i < segments.length; i += 1) {
    cursor = path.join(cursor, segments[i]);
    const st = await fs.lstat(cursor).catch(() => null);
    if (!st || st.isSymbolicLink()) return null;
    if (i < segments.length - 1) {
      if (!st.isDirectory()) return null;
    } else {
      info = st;
    }
  }
  if (!info || !info.isFile() || info.size > MAX_MARK_FILE_BYTES) return null;
  if (expectedSize !== null && info.size !== expectedSize) {
    // Size shifted slightly after last index scan; still enforce hard limit before reading.
    if (info.size > MAX_MARK_FILE_BYTES) return null;
  }

  const openFlags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  let handle = null;
  try {
    handle = await fs.open(cursor, openFlags);
    const openedStat = await handle.stat();
    if (!openedStat.isFile() || openedStat.size > MAX_MARK_FILE_BYTES) return null;
    if (openedStat.dev !== info.dev || openedStat.ino !== info.ino || openedStat.size !== info.size) return null;
    if (openedStat.size === 0) return '';
    const buffer = Buffer.allocUnsafe(openedStat.size);
    let offset = 0;
    while (offset < openedStat.size) {
      const { bytesRead } = await handle.read(buffer, offset, openedStat.size - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_MARK_FILE_BYTES) return null;
    if (offset === openedStat.size) {
      const probe = Buffer.allocUnsafe(1);
      const tail = await handle.read(probe, 0, 1, offset);
      if (tail.bytesRead > 0 && offset + tail.bytesRead > MAX_MARK_FILE_BYTES) return null;
    }
    return buffer.toString('utf8', 0, offset);
  } catch {
    return null;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

function detectProjectsForScope(folderPath, entries) {
  const rootName = path.basename(folderPath) || folderPath;
  const projectRoots = [];
  for (const entry of entries) {
    if (entry.type !== 'file') continue;
    const base = path.posix.basename(entry.path).toLowerCase();
    if (base !== 'proyecto.md') continue;
    const dir = path.posix.dirname(entry.path);
    const prefix = dir === '.' ? '' : dir;
    const name = prefix === '' ? rootName : path.posix.basename(prefix);
    projectRoots.push({ prefix, name });
  }
  projectRoots.sort((a, b) => b.prefix.length - a.prefix.length);

  return (relativePath) => {
    for (const proj of projectRoots) {
      if (proj.prefix === '' || relativePath === proj.prefix || relativePath.startsWith(`${proj.prefix}/`)) {
        return proj.name;
      }
    }
    const slash = relativePath.indexOf('/');
    return slash > 0 ? relativePath.slice(0, slash) : rootName;
  };
}

function matchesPropertiesFilter(fileProps, filter) {
  if (!filter || Object.keys(filter).length === 0) return true;
  if (!fileProps) return false;
  for (const [key, expected] of Object.entries(filter)) {
    const actual = fileProps[key];
    if (actual === undefined) return false;
    if (typeof expected === 'string') {
      if (typeof actual !== 'string' || fold(actual) !== fold(expected)) return false;
    } else if (actual !== expected) {
      return false;
    }
  }
  return true;
}

/** Incremental block-level mark indexing and fast SQLite grouping across authorized readable folders. */
export async function groupMarksInCatalog({
  baseDirectory,
  scopes,
  readFolderProperties,
  tag = null,
  status = 'abierto',
  groupBy = 'proyecto',
  propertyFilter = null,
  customAliases = null,
  coverageFolders = [],
}) {
  if (!['abierto', 'cerrado', 'todos'].includes(status)) {
    throw new MotorError('INVALID_ARGUMENTS', 'estado debe ser abierto, cerrado o todos.');
  }
  if (!['proyecto', 'carpeta', 'archivo', 'etiqueta'].includes(groupBy)) {
    throw new MotorError('INVALID_ARGUMENTS', 'agrupar_por debe ser proyecto, carpeta, archivo o etiqueta.');
  }

  const scopeContexts = [];
  const projectResolvers = new Map();
  const folderById = new Map();
  const propsByScope = new Map();
  let filesScannedNow = 0;

  for (const scope of scopes) {
    const { folder, index } = scope;
    folderById.set(folder.id, folder);
    const entries = index?.entries ?? [];
    projectResolvers.set(folder.id, detectProjectsForScope(folder.path, entries));
    const candidates = entries.filter((entry) => isMarkCandidate(entry, folder.exclusions ?? []));
    const propsRecord = await readFolderProperties(folder.id).catch(() => null);
    propsByScope.set(folder.id, propsRecord?.entries ?? {});
    scopeContexts.push({ folder, candidates });
  }

  await prepareBaseFormat(baseDirectory, 3);
  // First read current scanned_files fingerprints & alias table from catalog (create if missing).
  const initial = await withCatalog(baseDirectory, { write: true, create: true }, (db) => {
    if (customAliases && typeof customAliases === 'object') {
      db.exec('BEGIN IMMEDIATE;');
      try {
        const upsertAlias = db.prepare(
          'INSERT OR REPLACE INTO tag_aliases (alias, canonical_tag, user_defined) VALUES (?, ?, 1)',
        );
        for (const [aliasRaw, canonicalRaw] of Object.entries(customAliases)) {
          const aliasKey = normalizeBaseTag(aliasRaw);
          const canonicalVal = normalizeBaseTag(canonicalRaw);
          if (aliasKey && canonicalVal) upsertAlias.run(aliasKey, canonicalVal);
        }
        db.exec('COMMIT;');
      } catch (error) {
        try { db.exec('ROLLBACK;'); } catch { /* noop */ }
        throw error;
      }
    }
    const aliasRows = db.prepare('SELECT alias, canonical_tag FROM tag_aliases').all();
    const aliasMap = new Map(aliasRows.map((row) => [row.alias, row.canonical_tag]));
    for (const [k, v] of DEFAULT_ALIASES) if (!aliasMap.has(k)) aliasMap.set(k, v);

    const scannedByScope = new Map();
    const selectScanned = db.prepare('SELECT relative_path, fingerprint FROM scanned_files WHERE scope_id = ?');
    for (const { folder } of scopeContexts) {
      const map = new Map();
      for (const row of selectScanned.all(folder.id)) map.set(row.relative_path, row.fingerprint);
      scannedByScope.set(folder.id, map);
    }
    return { aliasMap, scannedByScope };
  });

  const { aliasMap, scannedByScope } = initial;
  const pendingUpdates = [];

  for (const { folder, candidates } of scopeContexts) {
    const prevScanned = scannedByScope.get(folder.id) ?? new Map();
    const currentSet = new Set(candidates.map((c) => c.path));
    const stalePaths = [];
    for (const prevPath of prevScanned.keys()) {
      if (!currentSet.has(prevPath)) stalePaths.push(prevPath);
    }

    const dirtyEntries = [];
    for (const entry of candidates) {
      const fp = entryFingerprint(entry);
      if (prevScanned.get(entry.path) !== fp) {
        dirtyEntries.push({ entry, fingerprint: fp });
      }
    }

    const updatedFiles = [];
    for (const { entry, fingerprint } of dirtyEntries) {
      const content = await readMarkCandidateSafe(folder.path, entry.path, entry.size);
      if (content === null) continue;
      filesScannedNow += 1;
      const marks = extractDocumentMarks(content, entry.path, aliasMap);
      updatedFiles.push({ relativePath: entry.path, fingerprint, marks });
    }

    if (stalePaths.length > 0 || updatedFiles.length > 0) {
      pendingUpdates.push({ scopeId: folder.id, stalePaths, updatedFiles });
    }
  }

  const canonicalTarget = tag ? normalizeTag(tag, aliasMap) : null;
  const matchingTagVariants = new Set();
  if (canonicalTarget) {
    matchingTagVariants.add(canonicalTarget);
    for (const [alias, target] of aliasMap.entries()) {
      if (target === canonicalTarget) matchingTagVariants.add(alias);
    }
  }

  const rows = await withCatalog(baseDirectory, { write: pendingUpdates.length > 0, create: true }, (db) => {
    if (pendingUpdates.length > 0) {
      const now = new Date().toISOString();
      db.exec('BEGIN IMMEDIATE;');
      try {
        const delMark = db.prepare('DELETE FROM document_marks WHERE scope_id = ? AND relative_path = ?');
        const delScan = db.prepare('DELETE FROM scanned_files WHERE scope_id = ? AND relative_path = ?');
        const insMark = db.prepare(`
          INSERT OR REPLACE INTO document_marks
            (scope_id, relative_path, block_index, heading, line_number, block_type, tag, raw_tag, status, excerpt, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const insScan = db.prepare(`
          INSERT OR REPLACE INTO scanned_files (scope_id, relative_path, fingerprint, scanned_at)
          VALUES (?, ?, ?, ?)
        `);

        for (const upd of pendingUpdates) {
          for (const gone of upd.stalePaths) {
            delMark.run(upd.scopeId, gone);
            delScan.run(upd.scopeId, gone);
          }
          for (const file of upd.updatedFiles) {
            delMark.run(upd.scopeId, file.relativePath);
            for (const m of file.marks) {
              insMark.run(
                upd.scopeId,
                file.relativePath,
                m.blockIndex,
                m.heading,
                m.lineNumber,
                m.blockType,
                m.tag,
                m.rawTag,
                m.status,
                m.excerpt,
                now,
              );
            }
            insScan.run(upd.scopeId, file.relativePath, file.fingerprint, now);
          }
        }
        db.exec('COMMIT;');
      } catch (error) {
        try { db.exec('ROLLBACK;'); } catch { /* noop */ }
        throw error;
      }
    }

    if (scopeContexts.length === 0) return [];
    const scopePlaceholders = scopeContexts.map(() => '?').join(', ');
    const params = scopeContexts.map((s) => s.folder.id);
    const clauses = [`scope_id IN (${scopePlaceholders})`];

    if (matchingTagVariants.size > 0) {
      const variants = [...matchingTagVariants];
      clauses.push(`tag IN (${variants.map(() => '?').join(', ')})`);
      params.push(...variants);
    }
    if (status !== 'todos') {
      clauses.push('status = ?');
      params.push(status);
    }

    return db.prepare(`
      SELECT scope_id, relative_path, block_index, heading, line_number, block_type, tag, raw_tag, status, excerpt
      FROM document_marks
      WHERE ${clauses.join(' AND ')}
      ORDER BY scope_id, relative_path, line_number, block_index
    `).all(...params);
  });

  const items = [];
  for (const row of rows) {
    const folder = folderById.get(row.scope_id);
    if (!folder) continue;
    const scopeProps = propsByScope.get(row.scope_id) ?? {};
    const fileProps = scopeProps[row.relative_path];
    if (!matchesPropertiesFilter(fileProps, propertyFilter)) continue;

    const canonicalItemTag = normalizeTag(row.tag, aliasMap);
    const project = projectResolvers.get(row.scope_id)(row.relative_path);
    const absPath = path.join(folder.path, ...row.relative_path.split('/'));

    items.push({
      carpeta: folder.id,
      carpeta_nombre: path.basename(folder.path) || folder.path,
      proyecto: project,
      ruta: row.relative_path,
      ruta_absoluta: absPath,
      linea: row.line_number,
      ...(row.heading ? { seccion: row.heading } : {}),
      tipo_bloque: row.block_type,
      etiqueta: canonicalItemTag,
      marca_original: row.raw_tag,
      estado: row.status,
      extracto: row.excerpt,
      ...(fileProps ? { propiedades: fileProps } : {}),
    });
  }

  // Merge Mind explicit file properties matching requested tag/filter.
  for (const { folder } of scopeContexts) {
    const scopeProps = propsByScope.get(folder.id) ?? {};
    for (const [relativePath, fileProps] of Object.entries(scopeProps)) {
      if (!matchesPropertiesFilter(fileProps, propertyFilter)) continue;
      const candidateTags = new Set();
      for (const [k, v] of Object.entries(fileProps)) {
        const nk = normalizeTag(k, aliasMap);
        if (nk && v === true) candidateTags.add(nk);
        if (['etiqueta', 'etiquetas', 'tag', 'tags', 'tipo', 'estado'].includes(fold(k)) && typeof v === 'string') {
          const nv = normalizeTag(v, aliasMap);
          if (nv && !CLOSED_STATUS_WORDS.has(nv)) candidateTags.add(nv);
        }
      }
      const propEstadoRaw = typeof fileProps.estado === 'string' ? fold(fileProps.estado) : '';
      const propEstado = CLOSED_STATUS_WORDS.has(propEstadoRaw) ? 'cerrado' : 'abierto';
      if (status !== 'todos' && propEstado !== status) continue;

      for (const propTag of candidateTags) {
        if (canonicalTarget && propTag !== canonicalTarget) continue;
        const alreadyInFile = items.some(
          (item) => item.carpeta === folder.id && item.ruta === relativePath && item.etiqueta === propTag,
        );
        if (alreadyInFile) continue;
        items.push({
          carpeta: folder.id,
          carpeta_nombre: path.basename(folder.path) || folder.path,
          proyecto: projectResolvers.get(folder.id)(relativePath),
          ruta: relativePath,
          ruta_absoluta: path.join(folder.path, ...relativePath.split('/')),
          linea: 0,
          tipo_bloque: 'propiedad',
          etiqueta: propTag,
          marca_original: 'propiedad',
          estado: propEstado,
          extracto: `${relativePath} (${Object.entries(fileProps).map(([k, v]) => `${k}=${v}`).join(', ')})`,
          propiedades: fileProps,
        });
      }
    }
  }

  const groupMap = new Map();
  for (const item of items) {
    let key;
    if (groupBy === 'proyecto') key = item.proyecto;
    else if (groupBy === 'carpeta') key = item.carpeta_nombre;
    else if (groupBy === 'archivo') key = item.ruta_absoluta;
    else key = item.etiqueta;

    let bucket = groupMap.get(key);
    if (!bucket) {
      bucket = { grupo: key, total: 0, abiertos: 0, cerrados: 0, elementos: [] };
      groupMap.set(key, bucket);
    }
    bucket.total += 1;
    if (item.estado === 'cerrado') bucket.cerrados += 1;
    else bucket.abiertos += 1;
    bucket.elementos.push(item);
  }

  const grupos = [...groupMap.values()].sort((a, b) => b.total - a.total || a.grupo.localeCompare(b.grupo));
  return {
    etiqueta_consultada: tag ?? null,
    etiqueta_canonica: canonicalTarget,
    estado: status,
    agrupar_por: groupBy,
    total: items.length,
    grupos,
    cobertura: {
      carpetas_consultadas: scopeContexts.length,
      archivos_escaneados_ahora: filesScannedNow,
      carpetas: coverageFolders,
    },
  };
}
