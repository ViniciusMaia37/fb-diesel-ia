// Base de conhecimento: leitura do Markdown e busca por relevância (BM25).
// Funções puras, usadas tanto no Worker quanto nos scripts em Node.

/** Lê o cabeçalho "---" (frontmatter simples chave: valor) de um arquivo markdown. */
export function parseMarkdown(raw) {
  const text = String(raw).replace(/^﻿/, '').replace(/\r\n/g, '\n');
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

// ---------- Normalização de texto (português) ----------

const STOPWORDS = new Set(
  `a o as os um uma uns umas de do da dos das em no na nos nas por pelo pela pelos pelas para pra
   com sem sob sobre entre ate apos e ou mas que se como quando onde qual quais quem cujo cuja
   ao aos e sao foi era sera ha tem ter isso isto esse essa este esta aquele aquela
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

// Radicalização leve: casa "créditos" com "crédito", "ações" com "ação" etc.
function stem(t) {
  if (/^\d+$/.test(t)) return t;
  if (t.length > 5 && t.endsWith('coes')) return t.slice(0, -4) + 'cao';
  if (t.length > 4 && t.endsWith('oes')) return t.slice(0, -3) + 'ao';
  if (t.length > 4 && t.endsWith('ais')) return t.slice(0, -3) + 'al';
  if (t.length > 4 && t.endsWith('eis')) return t.slice(0, -3) + 'el';
  if (t.length > 3 && t.endsWith('s')) return t.slice(0, -1);
  return t;
}

export function tokenize(text) {
  return normalize(text)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .map(stem);
}

// ---------- Índice BM25 por trechos (seções "##") ----------

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
  return sections.map((s) => ({
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

/** Monta o índice a partir das linhas da tabela documents. */
export function buildIndex(docs) {
  const chunks = docs.flatMap(splitIntoChunks);
  const df = new Map();
  let totalLen = 0;
  for (const c of chunks) {
    const head = tokenize(`${c.docTitle} ${c.heading}`);
    const tokens = [...head, ...head, ...tokenize(c.text)]; // título e seção contam em dobro
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
    c.tf = tf;
    c.len = tokens.length;
    totalLen += tokens.length;
    for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
  }
  return { chunks, df, avgLen: chunks.length ? totalLen / chunks.length : 1 };
}

/** Retorna os trechos mais relevantes (no máximo 3 por documento). */
export function search(index, query, limit = 6) {
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
  scored.sort((x, y) => y.score - x.score);

  const perDoc = new Map();
  const result = [];
  for (const { chunk, score } of scored) {
    const n = perDoc.get(chunk.docId) || 0;
    if (n >= 3) continue;
    perDoc.set(chunk.docId, n + 1);
    const { tf, len, ...plain } = chunk;
    result.push({ ...plain, score });
    if (result.length >= limit) break;
  }
  return result;
}
