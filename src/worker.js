// FB Consult · Assistente Diesel — API no Cloudflare Workers (D1 + Workers AI)
import * as auth from './auth.js';
import { buildIndex, search } from './knowledge.js';
import { aiEnabled, generateAnswer, offlineAnswer } from './ai.js';

const COOKIE_NAME = 'fbsid';
const MAX_BODY = 1_000_000;
const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Cache-Control': 'no-store',
};

// ---------- Utilidades HTTP ----------

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(status, data, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...SECURITY_HEADERS, ...headers },
  });
}

async function readJson(request) {
  // Exigir JSON impede envios de formulários de outros sites (proteção CSRF junto com SameSite=Strict)
  if (!(request.headers.get('content-type') || '').includes('application/json')) {
    throw new HttpError(415, 'Envie os dados em JSON.');
  }
  const text = await request.text();
  if (text.length > MAX_BODY) throw new HttpError(413, 'Conteúdo muito grande.');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'JSON inválido.');
  }
}

const str = (v, max = 10_000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// ---------- Acesso ao banco (D1) ----------

const one = (env, sql, ...args) => env.DB.prepare(sql).bind(...args).first();
const all = async (env, sql, ...args) => (await env.DB.prepare(sql).bind(...args).all()).results;
const run = (env, sql, ...args) => env.DB.prepare(sql).bind(...args).run();
const stmt = (env, sql, ...args) => env.DB.prepare(sql).bind(...args);

async function bumpKnowledgeVersion(env) {
  await run(env, `UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'kb_version'`);
}

// Índice de busca em memória, refeito quando a versão da base muda
let kbCache = { version: null, index: null };
async function getIndex(env) {
  const row = await one(env, `SELECT value FROM meta WHERE key = 'kb_version'`);
  const version = row?.value ?? '0';
  if (kbCache.version !== version || !kbCache.index) {
    const docs = await all(
      env,
      'SELECT id, title, category, source, url, verified_at, content FROM documents WHERE deleted = 0'
    );
    kbCache = { version, index: buildIndex(docs) };
  }
  return kbCache.index;
}

// ---------- Sessões ----------

function readSessionCookie(request) {
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE_NAME) return decodeURIComponent(v.join('='));
  }
  return null;
}

function sessionCookie(token, env, secure) {
  const hours = Number(env.SESSION_HOURS || 12);
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${hours * 3600}${secure ? '; Secure' : ''}`;
}

const clearSessionCookie = (secure) =>
  `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? '; Secure' : ''}`;

async function createSession(env, userId) {
  const token = auth.randomToken();
  const hours = Number(env.SESSION_HOURS || 12);
  await run(
    env,
    `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, datetime('now', ?))`,
    await auth.sha256Hex(token),
    userId,
    `+${hours} hours`
  );
  return token;
}

async function userFromRequest(env, request) {
  const token = readSessionCookie(request);
  if (!token) return null;
  const row = await one(
    env,
    `SELECT u.id, u.username, u.name, u.role, u.active, u.must_change_password
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > datetime('now')`,
    await auth.sha256Hex(token)
  );
  if (!row || !row.active) return null;
  return {
    id: row.id,
    username: row.username,
    name: row.name,
    role: row.role,
    mustChangePassword: !!row.must_change_password,
  };
}

async function destroyUserSessions(env, userId, exceptToken) {
  if (exceptToken) {
    await run(env, 'DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?', userId, await auth.sha256Hex(exceptToken));
  } else {
    await run(env, 'DELETE FROM sessions WHERE user_id = ?', userId);
  }
}

// ---------- Bloqueio por tentativas (guardado no D1) ----------

async function isLocked(env, key) {
  const row = await one(env, `SELECT 1 AS l FROM login_attempts WHERE key = ? AND locked_until > datetime('now')`, key);
  return !!row;
}

async function registerFailure(env, key) {
  await run(
    env,
    `INSERT INTO login_attempts (key, count) VALUES (?, 1)
     ON CONFLICT(key) DO UPDATE SET count = count + 1`,
    key
  );
  await run(
    env,
    `UPDATE login_attempts SET count = 0, locked_until = datetime('now', ?) WHERE key = ? AND count >= ?`,
    `+${LOCK_MINUTES} minutes`,
    key,
    MAX_ATTEMPTS
  );
}

// ---------- Rotas ----------

const routes = [];
const route = (method, pattern, handler, opts = {}) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
  routes.push({ method, re, keys, handler, auth: opts.auth ?? 'user' });
};

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

// --- Autenticação ---

route('POST', '/api/auth/login', async ({ env, request, secure }) => {
  const body = await readJson(request);
  const username = str(body.username, 100);
  const password = typeof body.password === 'string' ? body.password : '';
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  const key = `${ip}|${username.toLowerCase()}`;
  if (await isLocked(env, key)) throw new HttpError(429, 'Muitas tentativas. Aguarde 15 minutos e tente novamente.');

  const user = await one(env, 'SELECT * FROM users WHERE username = ?', username);
  if (!user || !(await auth.verifyPassword(password, user.password_hash))) {
    await registerFailure(env, key);
    throw new HttpError(401, 'Usuário ou senha incorretos.');
  }
  if (!user.active) throw new HttpError(403, 'Usuário desativado. Fale com o administrador.');

  await env.DB.batch([
    stmt(env, 'DELETE FROM login_attempts WHERE key = ?', key),
    stmt(env, `UPDATE users SET last_login_at = datetime('now') WHERE id = ?`, user.id),
    stmt(env, `DELETE FROM sessions WHERE expires_at < datetime('now')`),
  ]);
  const token = await createSession(env, user.id);
  return json(200, { user: publicUser(user) }, { 'Set-Cookie': sessionCookie(token, env, secure) });
}, { auth: 'none' });

route('POST', '/api/auth/logout', async ({ env, request, secure }) => {
  const token = readSessionCookie(request);
  if (token) await run(env, 'DELETE FROM sessions WHERE token_hash = ?', await auth.sha256Hex(token));
  return json(200, { ok: true }, { 'Set-Cookie': clearSessionCookie(secure) });
}, { auth: 'none' });

route('GET', '/api/auth/me', async ({ env, user }) => {
  const enabled = aiEnabled(env);
  return json(200, { user, ai: { enabled, model: enabled ? env.AI_MODEL : null } });
}, { auth: 'any' });

route('POST', '/api/auth/change-password', async ({ env, request, user }) => {
  const body = await readJson(request);
  const row = await one(env, 'SELECT password_hash FROM users WHERE id = ?', user.id);
  if (!(await auth.verifyPassword(String(body.currentPassword || ''), row.password_hash))) {
    throw new HttpError(400, 'A senha atual está incorreta.');
  }
  const newPassword = String(body.newPassword || '');
  const problem = auth.validatePassword(newPassword);
  if (problem) throw new HttpError(400, problem);
  if (newPassword === body.currentPassword) throw new HttpError(400, 'A nova senha deve ser diferente da atual.');
  await run(env, 'UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?', await auth.hashPassword(newPassword), user.id);
  await destroyUserSessions(env, user.id, readSessionCookie(request));
  return json(200, { ok: true });
}, { auth: 'any' });

// --- Conversas ---

async function ownConversation(env, id, userId) {
  const conv = await one(env, 'SELECT * FROM conversations WHERE id = ? AND user_id = ?', Number(id), userId);
  if (!conv) throw new HttpError(404, 'Conversa não encontrada.');
  return conv;
}

route('GET', '/api/conversations', async ({ env, user }) => {
  const rows = await all(
    env,
    `SELECT id, title, created_at, updated_at FROM conversations
      WHERE user_id = ? ORDER BY updated_at DESC, id DESC LIMIT 500`,
    user.id
  );
  return json(200, { conversations: rows });
});

route('POST', '/api/conversations', async ({ env, request, user }) => {
  const body = await readJson(request);
  const title = str(body.title, 120) || 'Nova conversa';
  const res = await run(env, 'INSERT INTO conversations (user_id, title) VALUES (?, ?)', user.id, title);
  const conversation = await one(env, 'SELECT * FROM conversations WHERE id = ?', res.meta.last_row_id);
  return json(201, { conversation });
});

route('GET', '/api/conversations/:id', async ({ env, user, params }) => {
  const conv = await ownConversation(env, params.id, user.id);
  const messages = (
    await all(env, 'SELECT id, role, content, sources, created_at FROM messages WHERE conversation_id = ? ORDER BY id', conv.id)
  ).map((m) => ({ ...m, sources: m.sources ? JSON.parse(m.sources) : [] }));
  return json(200, { conversation: conv, messages });
});

route('PATCH', '/api/conversations/:id', async ({ env, request, user, params }) => {
  const conv = await ownConversation(env, params.id, user.id);
  const title = str((await readJson(request)).title, 120);
  if (!title) throw new HttpError(400, 'Informe um título.');
  await run(env, 'UPDATE conversations SET title = ? WHERE id = ?', title, conv.id);
  return json(200, { ok: true });
});

route('DELETE', '/api/conversations/:id', async ({ env, user, params }) => {
  const conv = await ownConversation(env, params.id, user.id);
  await env.DB.batch([
    stmt(env, 'DELETE FROM messages WHERE conversation_id = ?', conv.id),
    stmt(env, 'DELETE FROM conversations WHERE id = ?', conv.id),
  ]);
  return json(200, { ok: true });
});

// Envia uma pergunta e devolve a resposta em streaming (Server-Sent Events)
route('POST', '/api/conversations/:id/messages', async ({ env, ctx, request, user, params }) => {
  const conv = await ownConversation(env, params.id, user.id);
  const content = str((await readJson(request)).content, 8000);
  if (!content) throw new HttpError(400, 'Escreva uma pergunta.');

  const previous = await all(env, 'SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id', conv.id);

  const writes = [stmt(env, 'INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)', conv.id, 'user', content)];
  if (!previous.length && conv.title === 'Nova conversa') {
    const title = content.length > 60 ? content.slice(0, 57).trimEnd() + '…' : content;
    writes.push(stmt(env, 'UPDATE conversations SET title = ? WHERE id = ?', title, conv.id));
  }
  await env.DB.batch(writes);

  // Busca pela pergunta atual; se vier pouco, soma a pergunta anterior (perguntas de continuação)
  const index = await getIndex(env);
  const lastUserQuestion = [...previous].reverse().find((m) => m.role === 'user')?.content || '';
  let chunks = search(index, content, 6);
  if (chunks.length < 3 && lastUserQuestion) chunks = search(index, `${content} ${lastUserQuestion}`, 6);

  const sources = chunks.map((c, i) => ({
    n: i + 1,
    docId: c.docId,
    title: c.docTitle,
    heading: c.heading,
    category: c.category,
    url: c.url,
    verifiedAt: c.verifiedAt,
  }));

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const send = (name, data) => writer.write(encoder.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`));

  const work = (async () => {
    try {
      await send('sources', { sources });
      let answer = '';
      if (aiEnabled(env)) {
        let partial = '';
        try {
          answer = await generateAnswer(env, [...previous, { role: 'user', content }], chunks, (delta) => {
            partial += delta;
            send('delta', { text: delta });
          });
        } catch (err) {
          // Cota diária esgotada ou IA indisponível: completa com os trechos da base
          console.error('[IA] falha:', err?.message || err);
          const fallback = offlineAnswer(chunks, 'quota');
          answer = partial ? `${partial}\n\n${fallback}` : fallback;
          await send('delta', { text: partial ? `\n\n${fallback}` : fallback });
        }
        if (!answer.trim()) {
          answer = offlineAnswer(chunks, 'quota');
          await send('delta', { text: answer });
        }
      } else {
        answer = offlineAnswer(chunks, 'off');
        await send('delta', { text: answer });
      }

      const res = await run(
        env,
        'INSERT INTO messages (conversation_id, role, content, sources) VALUES (?, ?, ?, ?)',
        conv.id,
        'assistant',
        answer,
        JSON.stringify(sources)
      );
      await run(env, `UPDATE conversations SET updated_at = datetime('now') WHERE id = ?`, conv.id);
      const updated = await one(env, 'SELECT id, title, updated_at FROM conversations WHERE id = ?', conv.id);
      await send('done', { messageId: res.meta.last_row_id, conversation: updated });
    } catch (err) {
      console.error('[chat] erro:', err?.message || err);
      await send('error', { message: 'Não foi possível gerar a resposta agora. Tente novamente em instantes.' }).catch(() => {});
    } finally {
      await writer.close().catch(() => {});
    }
  })();
  ctx.waitUntil(work);

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
});

// --- Fontes (base de conhecimento) ---

route('GET', '/api/documents', async ({ env }) => {
  const documents = await all(
    env,
    `SELECT id, slug, title, category, source, url, verified_at, origin, updated_at
       FROM documents WHERE deleted = 0 ORDER BY category, title`
  );
  return json(200, { documents });
});

route('GET', '/api/documents/:id', async ({ env, params }) => {
  const document = await one(env, 'SELECT * FROM documents WHERE id = ? AND deleted = 0', Number(params.id));
  if (!document) throw new HttpError(404, 'Documento não encontrado.');
  return json(200, { document });
});

// --- Administração: usuários ---

async function activeAdminsExcept(env, id) {
  const r = await one(env, `SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1 AND id <> ?`, id);
  return r.n;
}

route('GET', '/api/admin/users', async ({ env }) => {
  const users = (await all(env, 'SELECT * FROM users ORDER BY name COLLATE NOCASE')).map(publicUser);
  return json(200, { users });
}, { auth: 'admin' });

route('POST', '/api/admin/users', async ({ env, request }) => {
  const body = await readJson(request);
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
  if (await one(env, 'SELECT 1 AS x FROM users WHERE username = ?', username)) {
    throw new HttpError(409, 'Já existe um usuário com esse login.');
  }
  const res = await run(
    env,
    `INSERT INTO users (username, name, password_hash, role, must_change_password) VALUES (?, ?, ?, ?, 1)`,
    username,
    name,
    await auth.hashPassword(password),
    role
  );
  const user = await one(env, 'SELECT * FROM users WHERE id = ?', res.meta.last_row_id);
  // A senha provisória volta uma única vez, para o administrador repassar ao consultor
  return json(201, { user: publicUser(user), temporaryPassword: password });
}, { auth: 'admin' });

route('PATCH', '/api/admin/users/:id', async ({ env, request, user: me, params }) => {
  const id = Number(params.id);
  const target = await one(env, 'SELECT * FROM users WHERE id = ?', id);
  if (!target) throw new HttpError(404, 'Usuário não encontrado.');
  const body = await readJson(request);
  const writes = [];
  const result = {};

  if (body.name !== undefined) {
    const name = str(body.name, 120);
    if (!name) throw new HttpError(400, 'Informe o nome.');
    writes.push(stmt(env, 'UPDATE users SET name = ? WHERE id = ?', name, id));
  }
  if (body.role !== undefined || body.active !== undefined) {
    const role = body.role === undefined ? target.role : body.role === 'admin' ? 'admin' : 'consultor';
    const active = body.active === undefined ? !!target.active : !!body.active;
    if (id === me.id && (role !== 'admin' || !active)) {
      throw new HttpError(400, 'Você não pode remover o seu próprio acesso de administrador.');
    }
    if (target.role === 'admin' && (role !== 'admin' || !active) && (await activeAdminsExcept(env, id)) === 0) {
      throw new HttpError(400, 'É preciso manter pelo menos um administrador ativo.');
    }
    writes.push(stmt(env, 'UPDATE users SET role = ?, active = ? WHERE id = ?', role, active ? 1 : 0, id));
    if (!active) writes.push(stmt(env, 'DELETE FROM sessions WHERE user_id = ?', id));
  }
  if (body.resetPassword) {
    const password = body.password ? String(body.password) : auth.generateTempPassword();
    const problem = auth.validatePassword(password);
    if (problem) throw new HttpError(400, problem);
    writes.push(
      stmt(env, 'UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?', await auth.hashPassword(password), id),
      stmt(env, 'DELETE FROM sessions WHERE user_id = ?', id)
    );
    result.temporaryPassword = password;
  }
  if (writes.length) await env.DB.batch(writes); // tudo ou nada

  const updated = await one(env, 'SELECT * FROM users WHERE id = ?', id);
  return json(200, { user: publicUser(updated), ...result });
}, { auth: 'admin' });

route('DELETE', '/api/admin/users/:id', async ({ env, user: me, params }) => {
  const id = Number(params.id);
  if (id === me.id) throw new HttpError(400, 'Você não pode excluir o seu próprio usuário.');
  const target = await one(env, 'SELECT * FROM users WHERE id = ?', id);
  if (!target) throw new HttpError(404, 'Usuário não encontrado.');
  if (target.role === 'admin' && (await activeAdminsExcept(env, id)) === 0) {
    throw new HttpError(400, 'É preciso manter pelo menos um administrador ativo.');
  }
  await env.DB.batch([
    stmt(env, 'DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE user_id = ?)', id),
    stmt(env, 'DELETE FROM conversations WHERE user_id = ?', id),
    stmt(env, 'DELETE FROM sessions WHERE user_id = ?', id),
    stmt(env, 'UPDATE documents SET updated_by = NULL WHERE updated_by = ?', id),
    stmt(env, 'DELETE FROM users WHERE id = ?', id),
  ]);
  return json(200, { ok: true });
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

route('POST', '/api/admin/documents', async ({ env, request, user }) => {
  const d = readDocumentBody(await readJson(request));
  const slug = `admin/${Date.now()}-${d.title.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').slice(0, 60)}`;
  const res = await run(
    env,
    `INSERT INTO documents (slug, title, category, source, url, verified_at, content, origin, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'admin', ?)`,
    slug, d.title, d.category, d.source, d.url, d.verifiedAt, d.content, user.id
  );
  await bumpKnowledgeVersion(env);
  return json(201, { document: await one(env, 'SELECT * FROM documents WHERE id = ?', res.meta.last_row_id) });
}, { auth: 'admin' });

route('PUT', '/api/admin/documents/:id', async ({ env, request, user, params }) => {
  const id = Number(params.id);
  if (!(await one(env, 'SELECT 1 AS x FROM documents WHERE id = ? AND deleted = 0', id))) {
    throw new HttpError(404, 'Documento não encontrado.');
  }
  const d = readDocumentBody(await readJson(request));
  // Ao editar pelo painel, o documento passa a ser "admin" e não é sobrescrito por reimportações
  await run(
    env,
    `UPDATE documents SET title = ?, category = ?, source = ?, url = ?, verified_at = ?, content = ?,
            origin = 'admin', updated_at = datetime('now'), updated_by = ? WHERE id = ?`,
    d.title, d.category, d.source, d.url, d.verifiedAt, d.content, user.id, id
  );
  await bumpKnowledgeVersion(env);
  return json(200, { document: await one(env, 'SELECT * FROM documents WHERE id = ?', id) });
}, { auth: 'admin' });

route('DELETE', '/api/admin/documents/:id', async ({ env, params }) => {
  // Exclusão lógica: some da base, mas o registro fica para não ser reimportado do arquivo
  const res = await run(
    env,
    `UPDATE documents SET deleted = 1, updated_at = datetime('now') WHERE id = ? AND deleted = 0`,
    Number(params.id)
  );
  if (!res.meta.changes) throw new HttpError(404, 'Documento não encontrado.');
  await bumpKnowledgeVersion(env);
  return json(200, { ok: true });
}, { auth: 'admin' });

route('GET', '/api/admin/stats', async ({ env }) => {
  const [users, conversations, questions, last30, documents] = await env.DB.batch([
    stmt(env, 'SELECT COUNT(*) AS n FROM users WHERE active = 1'),
    stmt(env, 'SELECT COUNT(*) AS n FROM conversations'),
    stmt(env, `SELECT COUNT(*) AS n FROM messages WHERE role = 'user'`),
    stmt(env, `SELECT COUNT(*) AS n FROM messages WHERE role = 'user' AND created_at >= datetime('now', '-30 days')`),
    stmt(env, 'SELECT COUNT(*) AS n FROM documents WHERE deleted = 0'),
  ]);
  const n = (r) => r.results[0].n;
  return json(200, {
    users: n(users),
    conversations: n(conversations),
    questions: n(questions),
    questionsLast30: n(last30),
    documents: n(documents),
  });
}, { auth: 'admin' });

// ---------- Entrada do Worker ----------

async function handleApi(request, env, ctx) {
  const url = new URL(request.url);
  const secure = url.protocol === 'https:';
  try {
    const match = routes
      .map((r) => ({ r, m: r.method === request.method && url.pathname.match(r.re) }))
      .find((x) => x.m);
    if (!match) throw new HttpError(404, 'Rota não encontrada.');
    const { r, m } = match;
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));

    let user = null;
    if (r.auth !== 'none') {
      user = await userFromRequest(env, request);
      if (!user) throw new HttpError(401, 'Sessão expirada. Entre novamente.');
      // Quem está com senha provisória só pode trocar a senha
      if (r.auth !== 'any' && user.mustChangePassword) throw new HttpError(403, 'Troque a sua senha provisória para continuar.');
      if (r.auth === 'admin' && user.role !== 'admin') throw new HttpError(403, 'Acesso restrito ao administrador.');
    }
    return await r.handler({ env, ctx, request, user, params, secure });
  } catch (err) {
    if (!(err instanceof HttpError)) console.error(err);
    const status = err instanceof HttpError ? err.status : 500;
    return json(status, { error: err instanceof HttpError ? err.message : 'Erro interno do servidor.' });
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return handleApi(request, env, ctx);
    return env.ASSETS.fetch(request);
  },
};
