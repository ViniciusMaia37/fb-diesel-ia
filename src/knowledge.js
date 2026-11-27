// Base de conhecimento: importação dos arquivos .md e busca por relevância (BM25)
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { db, ROOT_DIR } from './db.js';

const KNOWLEDGE_DIR = path.join(ROOT_DIR, 'knowledge');

// ---------- Importação dos arquivos ----------

/** Lê o cabeçalho "---" (frontmatter simples chave: valor) de um arquivo markdown. */
export function parseMarkdown(raw) {
  const text = raw.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const meta = {};
  let body = text;
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (m) {
    for (const line of m[1].split('\n')) {
      const i = line.indexOf(':');
      if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    body = text.slice(m[0].length);
  }
  return { meta, body: body.trim() };
}

function listMarkdownFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listMarkdownFiles(full));
    else if (name.toLowerCase().endsWith('.md')) out.push(full);
  }
  return out.sort();
}

/**
 * Importa os arquivos de knowledge/ para o banco.
 * Por padrão só insere documentos novos (não sobrescreve edições feitas pelo administrador
 * nem traz de volta documentos excluídos pelo painel).
 * Com { overwrite: true } atualiza também os documentos de origem "arquivo".
 */
export function importKnowledgeFiles({ overwrite = false } = {}) {
  const files = listMarkdownFiles(KNOWLEDGE_DIR);
  let inserted = 0;
  let updated = 0;
  const find = db.prepare('SELECT id, origin FROM documents WHERE slug = ?');
  const insert = db.prepare(
    `INSERT INTO documents (slug, title, category, source, url, verified_at, content, origin)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'arquivo')`
  );
  const update = db.prepare(
    `UPDATE documents SET title = ?, category = ?, source = ?, url = ?, verified_at = ?, content = ?,
            updated_at = datetime('now')
      WHERE id = ?`
  );
  for (const file of files) {
    const slug = path.relative(KNOWLEDGE_DIR, file).replace(/\\/g, '/').replace(/\.md$/i, '');
    const { meta, body } = parseMarkdown(readFileSync(file, 'utf8'));
    const fields = [
      meta.titulo || slug,
      meta.categoria || 'Geral',
      meta.fonte || null,
      meta.url || null,
      meta.verificado_em || null,
      body,
    ];
    const existing = find.get(slug);
    if (!existing) {
      insert.run(slug, ...fields);
      inserted++;
    } else if (overwrite && existing.origin === 'arquivo') {
      update.run(...fields, existing.id);
      updated++;
    }
  }
  invalidateIndex();
  return { files: files.length, inserted, updated };
}

// ---------- Normalização de texto (português) ----------

const STOPWORDS = new Set(
  `a o as os um uma uns umas de do da dos das em no na nos nas por pelo pela pelos pelas para pra
   com sem sob sobre entre ate apos e ou mas que se como quando onde qual quais quem cujo cuja
   ao aos a à às é ser sao foi era sera ha tem ter isso isto esse essa este esta aquele aquela
   seu sua seus suas meu minha nosso nossa lhe eles elas ele ela voce voces nao sim mais menos
   muito pouco ja tambem so ainda entao assim pode podem deve devem qualquer cada todo toda todos todas`
    .split(/\s+/)
    .filter(Boolean)
);

export function normalize(text) {
  return String(text)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

export function tokenize(text) {
  return normalize(text)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .map(stem);
}

// Radicalização leve: remove plurais e sufixos comuns para casar "créditos" com "crédito" etc.
function stem(t) {
  if (/^\d+$/.test(t)) return t;
  if (t.length > 5 && t.endsWith('coes')) return t.slice(0, -4) + 'cao';
  if (t.length > 4 && t.endsWith('oes')) return t.slice(0, -3) + 'ao';
  if (t.length > 4 && t.endsWith('ais')) return t.slice(0, -3) + 'al';
  if (t.length > 4 && t.endsWith('eis')) return t.slice(0, -3) + 'el';
  if (t.length > 3 && t.endsWith('s')) return t.slice(0, -1);
  return t;
}

// ---------- Índice BM25 por trechos (seções "##") ----------

let index = null;

export function invalidateIndex() {
  index = null;
}

function splitIntoChunks(doc) {
  const sections = [];
  let heading = 'Introdução';
  let buf = [];
  const flush = () => {
    const text = buf.join('\n').trim();
    if (text) sections.push({ heading, text });
    buf = [];
  };
  for (const line of doc.content.split('\n')) {
    const h = line.match(/^#{1,3}\s+(.*)/);
    if (h) {
      flush();
      heading = h[1].trim();
    } else {
      buf.push(line);
    }
  }
  flush();
  return sections.map((s, i) => ({
    key: `${doc.id}:${i}`,
    docId: doc.id,
    docTitle: doc.title,
    category: doc.category,
    source: doc.source,
    url: doc.url,
    verifiedAt: doc.verified_at,
    heading: s.heading,
    text: s.text,
  }));
}

function buildIndex() {
  const docs = db
    .prepare('SELECT id, title, category, source, url, verified_at, content FROM documents WHERE deleted = 0')
    .all();
  const chunks = docs.flatMap(splitIntoChunks);
  const df = new Map();
  let totalLen = 0;
  for (const c of chunks) {
    // título e seção contam em dobro para a relevância
    const tokens = [
      ...tokenize(`${c.docTitle} ${c.heading}`),
      ...tokenize(`${c.docTitle} ${c.heading}`),
      ...tokenize(c.text),
    ];
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
    c.tf = tf;
    c.len = tokens.length;
    totalLen += tokens.length;
    for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
  }
  return { chunks, df, avgLen: chunks.length ? totalLen / chunks.length : 1 };
}

/** Retorna os trechos mais relevantes para a pergunta. */
export function search(query, limit = 6) {
  if (!index) index = buildIndex();
  const { chunks, df, avgLen } = index;
  const N = chunks.length;
  const terms = [...new Set(tokenize(query))];
  if (!terms.length || !N) return [];
  const k1 = 1.4;
  const b = 0.75;
  const scored = [];
  for (const c of chunks) {
    let score = 0;
    for (const t of terms) {
      const f = c.tf.get(t);
      if (!f) continue;
      const n = df.get(t);
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * c.len) / avgLen)));
    }
    if (score > 0) scored.push({ chunk: c, score });
  }
  scored.sort((a, b2) => b2.score - a.score);

  // no máximo 3 trechos do mesmo documento, para diversificar as fontes
  const perDoc = new Map();
  const result = [];
  for (const { chunk, score } of scored) {
    const n = perDoc.get(chunk.docId) || 0;
    if (n >= 3) continue;
    perDoc.set(chunk.docId, n + 1);
    result.push({ ...chunk, score });
    if (result.length >= limit) break;
  }
  return result;
}
