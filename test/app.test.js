// Testes de ponta a ponta: sobe o Worker localmente (wrangler dev) com banco D1 temporário e IA desligada
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ROOT } from '../scripts/lib.js';
import { buildIndex, search, parseMarkdown } from '../src/knowledge.js';
import { hashPassword, verifyPassword } from '../src/auth.js';

const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = mkdtempSync(path.join(tmpdir(), 'fbdiesel-test-'));
const WRANGLER = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const persist = ['--persist-to', tmp];
let server;

function node(args, env = {}) {
  const r = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(r.stdout + r.stderr);
  return r.stdout;
}

before(async () => {
  node([WRANGLER, 'd1', 'migrations', 'apply', 'fb-diesel-ia', '--local', ...persist]);
  node(['scripts/kb-sync.js', '--local', ...persist]);
  node(['scripts/create-admin.js', '--local', ...persist], { ADMIN_PASSWORD: 'Provisoria123' });

  server = spawn(
    process.execPath,
    [WRANGLER, 'dev', '--env', 'test', '--port', String(PORT), '--ip', '127.0.0.1', ...persist],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  await new Promise((resolve, reject) => {
    let log = '';
    server.stdout.on('data', (d) => (log += d));
    server.stderr.on('data', (d) => (log += d));
    const t = setTimeout(() => reject(new Error('wrangler dev não subiu:\n' + log.slice(-2000))), 60_000);
    const check = async () => {
      try {
        const r = await fetch(`${BASE}/api/auth/me`);
        if (r.status === 401) { clearTimeout(t); return resolve(); }
      } catch { /* ainda subindo */ }
      setTimeout(check, 500);
    };
    check();
    server.on('exit', (c) => reject(new Error('wrangler saiu: ' + c)));
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

  assert.equal((await admin('/api/conversations')).status, 401);
  assert.equal((await admin('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'x' } })).status, 401);
  const login = await admin('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'Provisoria123' } });
  assert.equal(login.status, 200);
  assert.equal(login.data.user.mustChangePassword, true);

  // senha provisória bloqueia o resto até trocar
  assert.equal((await admin('/api/conversations')).status, 403);
  assert.equal((await admin('/api/auth/change-password', { method: 'POST', body: { currentPassword: 'Provisoria123', newPassword: 'curta' } })).status, 400);
  assert.equal((await admin('/api/auth/change-password', { method: 'POST', body: { currentPassword: 'Provisoria123', newPassword: 'NovaSenha2026' } })).status, 200);

  // admin cria consultor
  const created = await admin('/api/admin/users', { method: 'POST', body: { name: 'Consultor Teste', username: 'consultor.teste' } });
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

  // conversa com resposta em streaming (IA desligada devolve os trechos)
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

  // edição de documento pelo admin entra na busca na hora
  const novo = await admin('/api/admin/documents', {
    method: 'POST',
    body: { title: 'Teste zebra', category: 'Teste', content: '## Seção\nPalavra única: xilofonezebra.' },
  });
  assert.equal(novo.status, 201);
  const conv2 = (await cons('/api/conversations', { method: 'POST', body: {} })).data.conversation.id;
  const t2 = await (await cons(`/api/conversations/${conv2}/messages`, { method: 'POST', body: { content: 'xilofonezebra' }, raw: true })).text();
  assert.match(t2, /Teste zebra/);

  // desativar consultor encerra a sessão
  const uid = created.data.user.id;
  assert.equal((await admin(`/api/admin/users/${uid}`, { method: 'PATCH', body: { active: false } })).status, 200);
  assert.equal((await cons('/api/conversations')).status, 401);

  // admin não pode se rebaixar
  const me = (await admin('/api/auth/me')).data.user;
  assert.equal((await admin(`/api/admin/users/${me.id}`, { method: 'PATCH', body: { role: 'consultor' } })).status, 400);

  // excluir consultor apaga o histórico dele
  assert.equal((await admin(`/api/admin/users/${uid}`, { method: 'DELETE' })).status, 200);

  // CSRF: POST sem JSON é recusado
  const form = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'username=a&password=b' });
  assert.equal(form.status, 415);

  // telas estáticas servidas
  const page = await fetch(BASE + '/');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Assistente Diesel/);
});

test('bloqueio após 5 tentativas erradas', async () => {
  const c = client();
  for (let i = 0; i < 5; i++) await c('/api/auth/login', { method: 'POST', body: { username: 'ninguem', password: 'errada123' } });
  assert.equal((await c('/api/auth/login', { method: 'POST', body: { username: 'ninguem', password: 'errada123' } })).status, 429);
});

test('senhas: hash e verificação', async () => {
  const h = await hashPassword('Segredo2026');
  assert.ok(await verifyPassword('Segredo2026', h));
  assert.ok(!(await verifyPassword('segredo2026', h)));
});

test('busca encontra os documentos certos', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const dir = path.join(ROOT, 'knowledge', 'legislacao');
  const docs = readdirSync(dir).map((f, i) => {
    const { meta, body } = parseMarkdown(readFileSync(path.join(dir, f), 'utf8'));
    return { id: i, title: meta.titulo, category: meta.categoria, content: body };
  });
  const index = buildIndex(docs);
  const top = (q) => search(index, q, 3).map((c) => c.docTitle).join(' | ');
  assert.match(top('percentual de biodiesel B15'), /biodiesel/i);
  assert.match(top('capacidade máxima tanque suplementar caminhão'), /suplementar/i);
  assert.match(top('crédito PIS COFINS transportadora lucro real'), /PIS/i);
  assert.match(top('ARLA consumo emulador'), /ARLA/i);
});
