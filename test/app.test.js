// Testes de ponta a ponta da API (sobe o servidor com um banco temporário, sem IA)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PORT = 3999;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = mkdtempSync(path.join(tmpdir(), 'fbdiesel-'));
let server;

before(async () => {
  server = spawn(process.execPath, ['server.js'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      DB_PATH: path.join(tmp, 'test.db'),
      ADMIN_USERNAME: 'admin',
      ADMIN_PASSWORD: 'Provisoria123',
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_AUTH_TOKEN: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('servidor não subiu')), 10_000);
    server.stdout.on('data', (d) => { if (String(d).includes('rodando em')) { clearTimeout(t); resolve(); } });
    server.on('exit', (c) => reject(new Error('servidor saiu: ' + c)));
  });
});

after(() => {
  server?.kill();
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* Windows pode segurar o arquivo */ }
});

function client() {
  let cookie = '';
  return async (p, { method = 'GET', body, raw = false } = {}) => {
    const res = await fetch(BASE + p, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    if (raw) return res;
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  };
}

test('fluxo completo: admin, consultor, chat e histórico', async () => {
  const admin = client();

  // sem login
  assert.equal((await admin('/api/conversations')).status, 401);

  // login errado e certo
  assert.equal((await admin('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'x' } })).status, 401);
  const login = await admin('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'Provisoria123' } });
  assert.equal(login.status, 200);
  assert.equal(login.data.user.mustChangePassword, true);

  // senha provisória bloqueia o resto até trocar
  assert.equal((await admin('/api/conversations')).status, 403);
  assert.equal((await admin('/api/auth/change-password', { method: 'POST', body: { currentPassword: 'Provisoria123', newPassword: 'curta' } })).status, 400);
  assert.equal((await admin('/api/auth/change-password', { method: 'POST', body: { currentPassword: 'Provisoria123', newPassword: 'NovaSenha2026' } })).status, 200);

  // admin cria consultor
  const created = await admin('/api/admin/users', { method: 'POST', body: { name: 'Consultor Teste', username: 'consultor.teste', role: 'consultor' } });
  assert.equal(created.status, 201);
  const temp = created.data.temporaryPassword;
  assert.ok(temp && temp.length >= 8);
  assert.equal((await admin('/api/admin/users', { method: 'POST', body: { name: 'Dup', username: 'consultor.teste' } })).status, 409);

  // consultor entra, troca senha e não acessa a administração
  const cons = client();
  assert.equal((await cons('/api/auth/login', { method: 'POST', body: { username: 'consultor.teste', password: temp } })).status, 200);
  assert.equal((await cons('/api/auth/change-password', { method: 'POST', body: { currentPassword: temp, newPassword: 'Consultor2026' } })).status, 200);
  assert.equal((await cons('/api/admin/users')).status, 403);

  // fontes
  const docs = await cons('/api/documents');
  assert.ok(docs.data.documents.length >= 10, 'base de conhecimento importada');

  // conversa com resposta em streaming (modo sem IA devolve os trechos)
  const conv = await cons('/api/conversations', { method: 'POST', body: {} });
  const id = conv.data.conversation.id;
  const res = await cons(`/api/conversations/${id}/messages`, { method: 'POST', body: { content: 'Qual o valor do ICMS ad rem do diesel?' }, raw: true });
  const text = await res.text();
  assert.match(text, /event: sources/);
  assert.match(text, /ICMS/);
  assert.match(text, /event: done/);

  // histórico salvo e título automático
  const hist = await cons(`/api/conversations/${id}`);
  assert.equal(hist.data.messages.length, 2);
  assert.equal(hist.data.messages[1].role, 'assistant');
  assert.ok(hist.data.messages[1].sources.length > 0);
  assert.match(hist.data.conversation.title, /ICMS/);

  // isolamento: admin não vê conversa do consultor
  assert.equal((await admin(`/api/conversations/${id}`)).status, 404);

  // desativar consultor encerra a sessão
  const uid = created.data.user.id;
  assert.equal((await admin(`/api/admin/users/${uid}`, { method: 'PATCH', body: { active: false } })).status, 200);
  assert.equal((await cons('/api/conversations')).status, 401);

  // admin não pode se rebaixar
  const me = (await admin('/api/auth/me')).data.user;
  assert.equal((await admin(`/api/admin/users/${me.id}`, { method: 'PATCH', body: { role: 'consultor' } })).status, 400);

  // CSRF: POST sem JSON é recusado
  const form = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'username=a&password=b' });
  assert.equal(form.status, 415);
});

test('busca encontra os documentos certos', async () => {
  process.env.DB_PATH = path.join(tmp, 'search.db');
  const { search, importKnowledgeFiles } = await import('../src/knowledge.js');
  importKnowledgeFiles();
  const top = (q) => search(q, 3).map((c) => c.docTitle).join(' | ');
  assert.match(top('percentual de biodiesel B15'), /biodiesel/i);
  assert.match(top('capacidade máxima tanque suplementar caminhão'), /suplementar/i);
  assert.match(top('crédito PIS COFINS transportadora lucro real'), /PIS/i);
  assert.match(top('ARLA consumo emulador'), /ARLA/i);
});
