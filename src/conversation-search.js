import { SEMANTIC_DIMENSIONS } from './semantic-encoder.js';

export function conversationChunks(title, important) {
  const fragments = [important];
  let short = '';
  const flush = () => { if (short) { fragments.push(short); short = ''; } };
  for (const sentence of important.split(/(?<=[.!?])\s+|\n+/u).map(x => x.trim()).filter(Boolean)) {
    if (Array.from(sentence).length >= 40) { flush(); fragments.push(sentence); }
    else { short += (short ? ' ' : '') + sentence; if (Array.from(short).length >= 80) flush(); }
  }
  flush();
  const chunks = [];
  const seen = new Set();
  for (const fragment of fragments) {
    const characters = Array.from(fragment);
    for (let offset = 0; offset < characters.length; offset += 320) {
      const excerpt = characters.slice(offset, offset + 400).join('');
      if (!seen.has(excerpt)) { seen.add(excerpt); chunks.push({part:chunks.length,excerpt,text:excerpt}); }
      if (offset + 400 >= characters.length) break;
    }
  }
  return chunks;
}

export async function prepareConversationVectors(db, encoder, publish, { backgroundGate } = {}) {
  let embedded = 0;
  const reuse = new Map();
  const rows = db.prepare(`SELECT id,revision,title,important FROM conversations
    WHERE id NOT IN (SELECT id FROM conversation_vectors WHERE model=?)`).all(encoder.model);

  for (const row of rows) {
    await backgroundGate?.yieldIfNeeded?.();
    const chunks = conversationChunks(row.title, row.important);
    // No publicar una conversación parcialmente vectorizada si se cancela.
    const complete = [];
    for (let start = 0; start < chunks.length; start += 1) {
      await backgroundGate?.yieldIfNeeded?.();
      const batch = chunks.slice(start, start + 1);
      const key = batch[0].text;
      let vectors = reuse.get(key);
      if (!vectors) {
        vectors = await encoder.embed(batch.map(chunk => chunk.text));
        reuse.set(key, vectors);
        if (reuse.size > 256) reuse.delete(reuse.keys().next().value);
      }
      batch.forEach((chunk, index) => complete.push([row.id, chunk.part, encoder.model,
        Buffer.from(new Float32Array(vectors[index]).buffer), chunk.excerpt]));
    }
    await publish(row, complete);
    embedded += chunks.length;
  }
  return embedded;
}

export async function semanticSearch(db, encoder, { query, projectKey, signal, minimum = 0.80 }) {
  const [needle] = await encoder.embed([query], { signal, kind: 'query' });
  const vectors = db.prepare(`SELECT v.id,v.vector,v.excerpt FROM conversation_vectors v
    JOIN conversations c ON c.id=v.id WHERE v.model=?${projectKey === undefined ? '' : ' AND c.project_key=?'}`)
    .all(encoder.model, ...(projectKey === undefined ? [] : [projectKey]));
  const byId = new Map();
  for (const row of vectors) {
    if (row.vector.byteLength !== SEMANTIC_DIMENSIONS * 4) throw new Error('Vector almacenado no válido.');
    const vector = new Float32Array(Uint8Array.from(row.vector).buffer);
    let score = 0;
    for (let i = 0; i < needle.length; i++) score += needle[i] * vector[i];
    if (!Number.isFinite(score)) throw new Error('Vector almacenado no válido.');
    if (score >= minimum && (!byId.has(row.id) || score > byId.get(row.id).similarity)) {
      byId.set(row.id, { id: row.id, similarity: score, excerpt: row.excerpt });
    }
  }
  return { embedded: 0, matches: [...byId.values()].sort((a,b) => b.similarity - a.similarity || a.id.localeCompare(b.id)).slice(0, 100) };
}

export function fuseResults(lexical, semantic, { exactIdentifiers = false } = {}) {
  const merged = new Map();
  lexical.forEach((row, rank) => merged.set(row.id, { ...row, score: 1 / (60 + rank + 1), match: 'palabras' }));
  semantic.forEach((row, rank) => {
    const before = merged.get(row.id);
    merged.set(row.id, { ...row, ...before, score: (before?.score ?? 0) + 1 / (60 + rank + 1),
      match: before ? 'ambas' : 'significado' });
  });
  return [...merged.values()].sort((a,b) => {
    if (exactIdentifiers) {
      const exact = Number(b.match !== 'significado') - Number(a.match !== 'significado');
      if (exact) return exact;
    }
    return b.score - a.score || a.id.localeCompare(b.id);
  });
}
