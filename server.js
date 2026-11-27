// FB Consult - Assistente Diesel (servidor HTTP sem frameworks)
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { db, tx, ROOT_DIR } from './src/db.js';
import * as auth from './src/auth.js';
import { importKnowledgeFiles, search, invalidateIndex } from './src/knowledge.js';
import { generateAnswer, aiEnabled, MODEL } from './src/ai.js';

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const MAX_BODY = 1_000_000; // 1 MB

// ---------- Utilidades HTTP ----------

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function send(res, status, data, headers = {}) {
  const body = data === undefined ? '' : JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

async function readJson(req) {
  const type = req.headers['content-type'] || '';
  // Exigir JSON impede envios de formulários de outros sites (proteção CSRF junto com SameSite=Strict)
  if (!type.includes('application/json')) throw new HttpError(415, 'Envie os dados em JSON.');
  let size = 0;
  const parts = [];
  for await (const part of req) {
    size += part.length;
    if (size > MAX_BODY) throw new HttpError(413, 'Conteúdo muito grande.');
    parts.push(part);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(parts).toString('utf8'));
  } catch {
    throw new HttpError(400, 'JSON inválido.');
  }
}

const str = (v, max = 10_000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function clientIp(req) {
  return req.socket.remoteAddress || 'desconhecido';
}

// ---------- Rotas ----------

const routes = [];
const route = (method, pattern, handler, opts = {}) => {
  const keys = [];
  const re = new RegExp(
    '^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$'
  );
  routes.push({ method, re, keys, handler, auth: opts.auth ?? 'user' });
};

// --- Autenticação ---

route('POST', '/api/auth/login', async (req, res) => {
  const body = await readJson(req);
  const username = str(body.username, 100);
  const password = typeof body.password === 'string' ? body.password : '';
  const key = `${clientIp(req)}|${username.toLowerCase()}`;
  if (auth.isLocked(key)) {
    throw new HttpError(429, 'Muitas tentativas. Aguarde 15 minutos e tente novamente.');
  }
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !auth.verifyPassword(password, user.password_hash)) {
    auth.registerFailure(key);
    throw new HttpError(401, 'Usuário ou senha incorretos.');
  }
  if (!user.active) throw new HttpError(403, 'Usuário desativado. Fale com o administrador.');
  auth.clearFailures(key);
  db.prepare(`UPDATE users SET last_login_at = datetime('now') WHERE id = ?`).run(user.id);
  const token = auth.createSession(user.id);
  send(res, 200, { user: publicUser(user) }, { 'Set-Cookie': auth.sessionCookie(token) });
}, { auth: 'none' });

route('POST', '/api/auth/logout', async (req, res) => {
  auth.destroySession(auth.readSessionCookie(req));
  send(res, 200, { ok: true }, { 'Set-Cookie': auth.clearSessionCookie() });
}, { auth: 'none' });

route('GET', '/api/auth/me', async (req, res, { user }) => {
  send(res, 200, { user, ai: { enabled: aiEnabled, model: aiEnabled ? MODEL : null } });
}, { auth: 'any' });

route('POST', '/api/auth/change-password', async (req, res, { user }) => {
  const body = await readJson(req);
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id);
  if (!auth.verifyPassword(String(body.currentPassword || ''), row.password_hash)) {
    throw new HttpError(400, 'A senha atual está incorreta.');
  }
  const newPassword = String(body.newPassword || '');
  const problem = auth.validatePassword(newPassword);
  if (problem) throw new HttpError(400, problem);
  if (newPassword === body.currentPassword) throw new HttpError(400, 'A nova senha deve ser diferente da atual.');
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?')
    .run(auth.hashPassword(newPassword), user.id);
  auth.destroyUserSessions(user.id, auth.readSessionCookie(req));
  send(res, 200, { ok: true });
}, { auth: 'any' });

// --- Conversas ---

function ownConversation(id, userId) {
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?').get(Number(id), userId);
  if (!conv) throw new HttpError(404, 'Conversa não encontrada.');
  return conv;
}

route('GET', '/api/conversations', async (req, res, { user }) => {
  const rows = db.prepare(
    `SELECT id, title, created_at, updated_at FROM conversations
      WHERE user_id = ? ORDER BY updated_at DESC, id DESC LIMIT 500`
  ).all(user.id);
  send(res, 200, { conversations: rows });
});

route('POST', '/api/conversations', async (req, res, { user }) => {
  const body = await readJson(req);
  const title = str(body.title, 120) || 'Nova conversa';
  const { lastInsertRowid } = db.prepare('INSERT INTO conversations (user_id, title) VALUES (?, ?)').run(user.id, title);
  send(res, 201, { conversation: db.prepare('SELECT * FROM conversations WHERE id = ?').get(lastInsertRowid) });
});

route('GET', '/api/conversations/:id', async (req, res, { user, params }) => {
  const conv = ownConversation(params.id, user.id);
  const messages = db.prepare(
    'SELECT id, role, content, sources, created_at FROM messages WHERE conversation_id = ? ORDER BY id'
  ).all(conv.id).map((m) => ({ ...m, sources: m.sources ? JSON.parse(m.sources) : [] }));
  send(res, 200, { conversation: conv, messages });
});

route('PATCH', '/api/conversations/:id', async (req, res, { user, params }) => {
  const conv = ownConversation(params.id, user.id);
  const title = str((await readJson(req)).title, 120);
  if (!title) throw new HttpError(400, 'Informe um título.');
  db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(title, conv.id);
  send(res, 200, { ok: true });
});

route('DELETE', '/api/conversations/:id', async (req, res, { user, params }) => {
  const conv = ownConversation(params.id, user.id);
  db.prepare('DELETE FROM conversations WHERE id = ?').run(conv.id);
  send(res, 200, { ok: true });
});

// Envia uma pergunta e devolve a resposta em streaming (Server-Sent Events)
route('POST', '/api/conversations/:id/messages', async (req, res, { user, params }) => {
  const conv = ownConversation(params.id, user.id);
  const content = str((await readJson(req)).content, 8000);
  if (!content) throw new HttpError(400, 'Escreva uma pergunta.');

  const previous = db.prepare(
    'SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id'
  ).all(conv.id);

  db.prepare('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)').run(conv.id, 'user', content);
  if (!previous.length && conv.title === 'Nova conversa') {
    const title = content.length > 60 ? content.slice(0, 57).trimEnd() + '…' : content;
    db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(title, conv.id);
  }

  // A busca usa a pergunta atual + a pergunta anterior (ajuda em perguntas de continuação)
  const lastUserQuestion = [...previous].reverse().find((m) => m.role === 'user')?.content || '';
  let chunks = search(content, 6);
  if (chunks.length < 3 && lastUserQuestion) chunks = search(`${content} ${lastUserQuestion}`, 6);

  const sources = chunks.map((c, i) => ({
    n: i + 1,
    docId: c.docId,
    title: c.docTitle,
    heading: c.heading,
    category: c.category,
    url: c.url,
    verifiedAt: c.verifiedAt,
  }));

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const event = (name, data) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  event('sources', { sources });

  let answer = '';
  try {
    answer = await generateAnswer([...previous, { role: 'user', content }], chunks, (delta) => {
      event('delta', { text: delta });
    });
  } catch (err) {
    console.error('[IA] erro ao gerar resposta:', err?.status || '', err?.message || err);
    const msg = err?.status === 401
      ? 'A chave da API da IA é inválida. Avise o administrador.'
      : err?.status === 429
        ? 'Limite de uso da IA atingido no momento. Tente novamente em alguns instantes.'
        : 'Não foi possível gerar a resposta agora. Tente novamente em instantes.';
    event('error', { message: msg });
    res.end();
    return;
  }

  const { lastInsertRowid } = db.prepare(
    'INSERT INTO messages (conversation_id, role, content, sources) VALUES (?, ?, ?, ?)'
  ).run(conv.id, 'assistant', answer, JSON.stringify(sources));
  db.prepare(`UPDATE conversations SET updated_at = datetime('now') WHERE id = ?`).run(conv.id);
  const updated = db.prepare('SELECT id, title, updated_at FROM conversations WHERE id = ?').get(conv.id);
  event('done', { messageId: Number(lastInsertRowid), conversation: updated });
  res.end();
});

// --- Fontes (base de conhecimento) ---

route('GET', '/api/documents', async (req, res) => {
  const docs = db.prepare(
    `SELECT id, slug, title, category, source, url, verified_at, origin, updated_at
       FROM documents WHERE deleted = 0 ORDER BY category, title`
  ).all();
  send(res, 200, { documents: docs });
});

route('GET', '/api/documents/:id', async (req, res, { params }) => {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ? AND deleted = 0').get(Number(params.id));
  if (!doc) throw new HttpError(404, 'Documento não encontrado.');
  send(res, 200, { document: doc });
});

// --- Administração: usuários ---

function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    name: u.name,
    role: u.role,
    active: !!u.active,
    mustChangePassword: !!u.must_change_password,
    createdAt: u.created_at,
    lastLoginAt: u.last_login_at,
  };
}

route('GET', '/api/admin/users', async (req, res) => {
  const users = db.prepare('SELECT * FROM users ORDER BY name COLLATE NOCASE').all().map(publicUser);
  send(res, 200, { users });
}, { auth: 'admin' });

route('POST', '/api/admin/users', async (req, res) => {
  const body = await readJson(req);
  const username = str(body.username, 60).toLowerCase();
  const name = str(body.name, 120);
  const role = body.role === 'admin' ? 'admin' : 'consultor';
  if (!/^[a-z0-9._-]{3,60}$/.test(username)) {
    throw new HttpError(400, 'Usuário deve ter de 3 a 60 caracteres: letras, números, ponto, hífen ou sublinhado.');
  }
  if (!name) throw new HttpError(400, 'Informe o nome.');
  const password = body.password ? String(body.password) : auth.generateTempPassword();
  const problem = auth.validatePassword(password);
  if (problem) throw new HttpError(400, problem);
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
    throw new HttpError(409, 'Já existe um usuário com esse login.');
  }
  const { lastInsertRowid } = db.prepare(
    `INSERT INTO users (username, name, password_hash, role, must_change_password) VALUES (?, ?, ?, ?, 1)`
  ).run(username, name, auth.hashPassword(password), role);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(lastInsertRowid);
  // A senha provisória volta uma única vez, para o administrador repassar ao consultor
  send(res, 201, { user: publicUser(user), temporaryPassword: password });
}, { auth: 'admin' });

route('PATCH', '/api/admin/users/:id', async (req, res, { user: me, params }) => {
  const id = Number(params.id);
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!target) throw new HttpError(404, 'Usuário não encontrado.');
  const body = await readJson(req);
  const result = {};

  tx(() => {
    if (body.name !== undefined) {
      const name = str(body.name, 120);
      if (!name) throw new HttpError(400, 'Informe o nome.');
      db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, id);
    }
    if (body.role !== undefined || body.active !== undefined) {
      const role = body.role === undefined ? target.role : body.role === 'admin' ? 'admin' : 'consultor';
      const active = body.active === undefined ? !!target.active : !!body.active;
      if (id === me.id && (role !== 'admin' || !active)) {
        throw new HttpError(400, 'Você não pode remover o seu próprio acesso de administrador.');
      }
      if (target.role === 'admin' && (role !== 'admin' || !active)) {
        const { n } = db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1 AND id <> ?`).get(id);
        if (n === 0) throw new HttpError(400, 'É preciso manter pelo menos um administrador ativo.');
      }
      db.prepare('UPDATE users SET role = ?, active = ? WHERE id = ?').run(role, active ? 1 : 0, id);
      if (!active) auth.destroyUserSessions(id);
    }
    if (body.resetPassword) {
      const password = body.password ? String(body.password) : auth.generateTempPassword();
      const problem = auth.validatePassword(password);
      if (problem) throw new HttpError(400, problem);
      db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?')
        .run(auth.hashPassword(password), id);
      auth.destroyUserSessions(id);
      result.temporaryPassword = password;
    }
  });

  send(res, 200, { user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id)), ...result });
}, { auth: 'admin' });

route('DELETE', '/api/admin/users/:id', async (req, res, { user: me, params }) => {
  const id = Number(params.id);
  if (id === me.id) throw new HttpError(400, 'Você não pode excluir o seu próprio usuário.');
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!target) throw new HttpError(404, 'Usuário não encontrado.');
  if (target.role === 'admin') {
    const { n } = db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1 AND id <> ?`).get(id);
    if (n === 0) throw new HttpError(400, 'É preciso manter pelo menos um administrador ativo.');
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(id); // remove também sessões e conversas (cascade)
  send(res, 200, { ok: true });
}, { auth: 'admin' });

// --- Administração: documentos ---

function readDocumentBody(body) {
  const title = str(body.title, 200);
  const content = str(body.content, 200_000);
  if (!title) throw new HttpError(400, 'Informe o título.');
  if (!content) throw new HttpError(400, 'Informe o conteúdo.');
  const url = str(body.url, 500);
  if (url && !/^https?:\/\//i.test(url)) throw new HttpError(400, 'O link deve começar com http:// ou https://');
  const verifiedAt = str(body.verifiedAt, 10);
  if (verifiedAt && !/^\d{4}-\d{2}-\d{2}$/.test(verifiedAt)) throw new HttpError(400, 'Data de verificação inválida.');
  return {
    title,
    content,
    category: str(body.category, 80) || 'Geral',
    source: str(body.source, 500) || null,
    url: url || null,
    verifiedAt: verifiedAt || null,
  };
}

route('POST', '/api/admin/documents', async (req, res, { user }) => {
  const d = readDocumentBody(await readJson(req));
  const slug = `admin/${Date.now()}-${d.title.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').slice(0, 60)}`;
  const { lastInsertRowid } = db.prepare(
    `INSERT INTO documents (slug, title, category, source, url, verified_at, content, origin, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'admin', ?)`
  ).run(slug, d.title, d.category, d.source, d.url, d.verifiedAt, d.content, user.id);
  invalidateIndex();
  send(res, 201, { document: db.prepare('SELECT * FROM documents WHERE id = ?').get(lastInsertRowid) });
}, { auth: 'admin' });

route('PUT', '/api/admin/documents/:id', async (req, res, { user, params }) => {
  const id = Number(params.id);
  if (!db.prepare('SELECT 1 FROM documents WHERE id = ? AND deleted = 0').get(id)) throw new HttpError(404, 'Documento não encontrado.');
  const d = readDocumentBody(await readJson(req));
  // Ao editar pelo painel, o documento passa a ser "admin" e não é sobrescrito por reimportações
  db.prepare(
    `UPDATE documents SET title = ?, category = ?, source = ?, url = ?, verified_at = ?, content = ?,
            origin = 'admin', updated_at = datetime('now'), updated_by = ? WHERE id = ?`
  ).run(d.title, d.category, d.source, d.url, d.verifiedAt, d.content, user.id, id);
  invalidateIndex();
  send(res, 200, { document: db.prepare('SELECT * FROM documents WHERE id = ?').get(id) });
}, { auth: 'admin' });

route('DELETE', '/api/admin/documents/:id', async (req, res, { params }) => {
  // Exclusão lógica: o documento some da base, mas o registro fica para não ser reimportado do arquivo
  const { changes } = db.prepare(
    `UPDATE documents SET deleted = 1, updated_at = datetime('now') WHERE id = ? AND deleted = 0`
  ).run(Number(params.id));
  if (!changes) throw new HttpError(404, 'Documento não encontrado.');
  invalidateIndex();
  send(res, 200, { ok: true });
}, { auth: 'admin' });

route('GET', '/api/admin/stats', async (req, res) => {
  const one = (sql) => db.prepare(sql).get().n;
  send(res, 200, {
    users: one('SELECT COUNT(*) AS n FROM users WHERE active = 1'),
    conversations: one('SELECT COUNT(*) AS n FROM conversations'),
    questions: one(`SELECT COUNT(*) AS n FROM messages WHERE role = 'user'`),
    questionsLast30: one(`SELECT COUNT(*) AS n FROM messages WHERE role = 'user' AND created_at >= datetime('now', '-30 days')`),
    documents: one('SELECT COUNT(*) AS n FROM documents WHERE deleted = 0'),
  });
}, { auth: 'admin' });

// ---------- Arquivos estáticos ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || !path.extname(rel)) rel = '/index.html';
  const file = path.resolve(PUBLIC_DIR, '.' + rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, { error: 'Acesso negado.' });
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not file');
    const data = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': rel === '/index.html' ? 'no-cache' : 'public, max-age=300',
    });
    res.end(data);
  } catch {
    send(res, 404, { error: 'Não encontrado.' });
  }
}

// ---------- Servidor ----------

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy':
    "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  const { pathname } = new URL(req.url, 'http://localhost');

  try {
    if (!pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Método não permitido.');
      return await serveStatic(req, res, pathname);
    }

    const match = routes
      .map((r) => ({ r, m: r.method === req.method && pathname.match(r.re) }))
      .find((x) => x.m);
    if (!match) throw new HttpError(404, 'Rota não encontrada.');
    const { r, m } = match;
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));

    let user = null;
    if (r.auth !== 'none') {
      user = auth.userFromToken(auth.readSessionCookie(req));
      if (!user) throw new HttpError(401, 'Sessão expirada. Entre novamente.');
      // Quem está com senha provisória só pode trocar a senha
      if (r.auth !== 'any' && user.mustChangePassword) throw new HttpError(403, 'Troque a sua senha provisória para continuar.');
      if (r.auth === 'admin' && user.role !== 'admin') throw new HttpError(403, 'Acesso restrito ao administrador.');
    }
    await r.handler(req, res, { user, params });
  } catch (err) {
    if (!(err instanceof HttpError)) console.error(err);
    if (res.headersSent) return res.end();
    const status = err instanceof HttpError ? err.status : 500;
    send(res, status, { error: err instanceof HttpError ? err.message : 'Erro interno do servidor.' });
  }
});

// ---------- Inicialização ----------

const imported = importKnowledgeFiles();
const admin = auth.ensureInitialAdmin();

server.listen(PORT, HOST, () => {
  console.log(`\nFB Consult · Assistente Diesel rodando em http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`Base de conhecimento: ${imported.files} arquivo(s), ${imported.inserted} novo(s) importado(s).`);
  console.log(aiEnabled ? `IA ativa (modelo ${MODEL}).` : 'IA desativada: defina ANTHROPIC_API_KEY no arquivo .env (o chat responde só com os trechos da base).');
  if (admin) {
    console.log('\n================ PRIMEIRO ACESSO ================');
    console.log(`Administrador criado: usuário "${admin.username}"`);
    if (!admin.fromEnv) console.log(`Senha provisória: ${admin.password}`);
    else console.log('Senha: a definida em ADMIN_PASSWORD no .env');
    console.log('A troca de senha será exigida no primeiro login.');
    console.log('=================================================\n');
  }
});
