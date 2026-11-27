// FB Consult · Assistente Diesel — frontend (HTML/CSS/JS puro)
import { renderMarkdown, escapeHtml } from './markdown.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  user: null,
  ai: null,
  conversations: [],
  currentId: null,
  sending: false,
  documents: [],
  docCategory: 'Todas',
  docId: null,
  view: 'chat',
};

const SUGGESTIONS = [
  ['ICMS', 'Qual o valor atual do ICMS ad rem do diesel e como a transportadora aproveita o crédito?'],
  ['Biodiesel', 'Qual o percentual de biodiesel obrigatório hoje e quando muda para B16?'],
  ['Tanque interno', 'O que a transportadora precisa para ter um ponto de abastecimento (tanque interno) regular?'],
  ['Método FB', 'Como calcular a taxa de retorno do programa de premiação dos motoristas?'],
];

// ---------- API ----------

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  let data = {};
  try { data = await res.json(); } catch { /* sem corpo */ }
  if (res.status === 401 && path !== '/api/auth/login' && path !== '/api/auth/me') {
    showScreen('login');
  }
  if (!res.ok) {
    const err = new Error(data.error || `Erro ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// ---------- Utilidades de interface ----------

function showScreen(name) {
  for (const s of ['login', 'password', 'app']) $(`#screen-${s}`).hidden = s !== name;
  if (name === 'login') {
    const f = $('#login-form');
    f.reset();
    $('.form-error', f).hidden = true;
    setTimeout(() => f.username.focus(), 0);
  }
  if (name === 'password') {
    const f = $('#password-form');
    f.reset();
    $('.form-error', f).hidden = true;
    setTimeout(() => f.currentPassword.focus(), 0);
  }
}

function formError(form, msg) {
  const el = $('.form-error', form);
  el.textContent = msg || '';
  el.hidden = !msg;
}

let toastTimer;
function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('is-error', isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3200);
}

function fmtDate(iso, withTime = false) {
  if (!iso) return '—';
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00` : iso.replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return iso;
  return withTime
    ? d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('pt-BR');
}

function initials(name) {
  return String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('');
}

const isInternal = (category) => /m[ée]todo fb|interno/i.test(category || '');

// ---------- Modal genérico ----------

const modal = {
  el: $('#modal'),
  open({ title, body, actions, wide = false, onSubmit }) {
    $('#modal-title').textContent = title;
    $('#modal-body').innerHTML = body;
    $('#modal-error').hidden = true;
    this.el.classList.toggle('modal--wide', wide);
    const foot = $('#modal-foot');
    foot.innerHTML = '';
    for (const a of actions) {
      const b = document.createElement('button');
      b.className = `btn ${a.className || 'btn-secondary'}`;
      b.textContent = a.label;
      b.type = a.submit ? 'submit' : 'button';
      if (a.submit) b.value = 'submit';
      else b.addEventListener('click', () => (a.onClick ? a.onClick() : this.close()));
      foot.append(b);
    }
    this.onSubmit = onSubmit;
    this.el.showModal();
    const first = $('#modal-body input, #modal-body textarea, #modal-body select', this.el);
    if (first) first.focus();
  },
  error(msg) {
    const e = $('#modal-error');
    e.textContent = msg;
    e.hidden = !msg;
  },
  close() {
    this.el.close();
  },
};

$('#modal-form').addEventListener('submit', async (ev) => {
  if (ev.submitter?.value !== 'submit') return; // botão fechar
  ev.preventDefault();
  if (!modal.onSubmit) return modal.close();
  const btn = ev.submitter;
  btn.disabled = true;
  try {
    await modal.onSubmit(new FormData(ev.target));
  } catch (err) {
    modal.error(err.message);
  } finally {
    btn.disabled = false;
  }
});

function confirmDialog({ title, message, confirmLabel = 'Confirmar', danger = false }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      modal.el.removeEventListener('close', onClose);
      resolve(v);
    };
    const onClose = () => finish(false);
    modal.open({
      title,
      body: `<p class="modal-text">${escapeHtml(message)}</p>`,
      actions: [
        { label: 'Cancelar' },
        { label: confirmLabel, className: danger ? 'btn-danger' : 'btn-primary', onClick: () => { finish(true); modal.close(); } },
      ],
    });
    modal.el.addEventListener('close', onClose);
  });
}

// ---------- Login e sessão ----------

async function boot() {
  try {
    const { user, ai } = await api('/api/auth/me');
    state.user = user;
    state.ai = ai;
    if (user.mustChangePassword) return showScreen('password');
    enterApp();
  } catch {
    showScreen('login');
  }
}

$('#login-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  formError(f, '');
  const btn = $('button[type=submit]', f);
  btn.disabled = true;
  btn.textContent = 'Entrando…';
  try {
    await api('/api/auth/login', { method: 'POST', body: { username: f.username.value, password: f.password.value } });
    await boot();
  } catch (err) {
    formError(f, err.message);
    f.password.select();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Entrar';
  }
});

$('.pwd-toggle').addEventListener('click', () => {
  const input = $('#login-form').password;
  input.type = input.type === 'password' ? 'text' : 'password';
});
$('#login-form').password.addEventListener('keyup', (ev) => {
  $('.caps-warn').hidden = !ev.getModifierState?.('CapsLock');
});

$('#password-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  formError(f, '');
  if (f.newPassword.value !== f.confirm.value) return formError(f, 'As senhas não conferem.');
  try {
    await api('/api/auth/change-password', {
      method: 'POST',
      body: { currentPassword: f.currentPassword.value, newPassword: f.newPassword.value },
    });
    toast('Senha alterada.');
    await boot();
  } catch (err) {
    formError(f, err.message);
  }
});

document.addEventListener('click', async (ev) => {
  const el = ev.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  if (action === 'logout') {
    await api('/api/auth/logout', { method: 'POST', body: {} }).catch(() => {});
    state.user = null;
    state.conversations = [];
    state.currentId = null;
    showScreen('login');
  } else if (action === 'new-chat') {
    newChat();
  } else if (action === 'open-sidebar') {
    $('#screen-app').classList.add('sidebar-open');
  } else if (action === 'close-sidebar') {
    $('#screen-app').classList.remove('sidebar-open');
  } else if (action === 'new-user') {
    openUserForm();
  } else if (action === 'new-document') {
    openDocumentForm();
  }
});

// ---------- Aplicação ----------

function enterApp() {
  showScreen('app');
  const u = state.user;
  $('#user-name').textContent = u.name;
  $('#user-role').textContent = u.role === 'admin' ? 'Administrador' : 'Consultor';
  $('#user-avatar').textContent = initials(u.name);
  $$('[data-admin-only]').forEach((el) => (el.hidden = u.role !== 'admin'));
  const pill = $('#ai-status');
  pill.className = `pill ${state.ai?.enabled ? 'is-on' : 'is-off'}`;
  pill.textContent = state.ai?.enabled ? 'IA ativa' : 'IA não configurada';
  pill.title = state.ai?.enabled ? `Modelo: ${state.ai.model}` : 'Defina ANTHROPIC_API_KEY no .env do servidor';
  setView('chat');
  loadConversations().then(() => newChat());
}

function setView(view) {
  if (view === 'admin' && state.user?.role !== 'admin') view = 'chat';
  state.view = view;
  for (const v of ['chat', 'sources', 'admin']) $(`#view-${v}`).hidden = v !== view;
  $$('.nav-btn').forEach((b) => b.classList.toggle('is-active', b.dataset.view === view));
  $('#screen-app').classList.remove('sidebar-open');
  if (view === 'chat') {
    const conv = state.conversations.find((c) => c.id === state.currentId);
    $('#topbar-title').textContent = conv ? conv.title : 'Assistente Diesel';
    $('#composer-input').focus();
  } else if (view === 'sources') {
    $('#topbar-title').textContent = 'Fontes';
    loadDocuments();
  } else if (view === 'admin') {
    $('#topbar-title').textContent = 'Administração';
    loadAdmin();
  }
}

$$('.nav-btn').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));

// ---------- Histórico de conversas ----------

async function loadConversations() {
  const { conversations } = await api('/api/conversations');
  state.conversations = conversations;
  renderConversationList();
}

function groupLabel(iso) {
  const d = new Date(iso.replace(' ', 'T') + 'Z');
  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const diffDays = (start - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86_400_000;
  if (diffDays <= 0) return 'Hoje';
  if (diffDays === 1) return 'Ontem';
  if (diffDays < 7) return 'Últimos 7 dias';
  if (diffDays < 30) return 'Últimos 30 dias';
  return 'Anteriores';
}

function renderConversationList() {
  const list = $('#conv-list');
  const q = $('#conv-search').value.trim().toLowerCase();
  const items = state.conversations.filter((c) => !q || c.title.toLowerCase().includes(q));
  if (!items.length) {
    list.innerHTML = `<p class="conv-empty">${q ? 'Nenhuma conversa encontrada.' : 'Suas conversas aparecerão aqui.'}</p>`;
    return;
  }
  let html = '';
  let last = '';
  for (const c of items) {
    const g = groupLabel(c.updated_at);
    if (g !== last) {
      html += `<p class="conv-group">${g}</p>`;
      last = g;
    }
    html += `
      <div class="conv-item ${c.id === state.currentId ? 'is-active' : ''}" data-id="${c.id}">
        <button class="conv-item__open" title="${escapeHtml(c.title)}">${escapeHtml(c.title)}</button>
        <button class="icon-btn conv-item__menu" data-conv-action="rename" title="Renomear" aria-label="Renomear conversa">
          <svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>
        </button>
        <button class="icon-btn conv-item__menu" data-conv-action="delete" title="Excluir" aria-label="Excluir conversa">
          <svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>
        </button>
      </div>`;
  }
  list.innerHTML = html;
}

$('#conv-search').addEventListener('input', renderConversationList);

$('#conv-list').addEventListener('click', async (ev) => {
  const item = ev.target.closest('.conv-item');
  if (!item) return;
  const id = Number(item.dataset.id);
  const action = ev.target.closest('[data-conv-action]')?.dataset.convAction;
  const conv = state.conversations.find((c) => c.id === id);
  if (action === 'rename') {
    modal.open({
      title: 'Renomear conversa',
      body: `<label class="field"><span>Título</span><input name="title" maxlength="120" required value="${escapeHtml(conv.title)}"></label>`,
      actions: [{ label: 'Cancelar' }, { label: 'Salvar', className: 'btn-primary', submit: true }],
      onSubmit: async (fd) => {
        const title = String(fd.get('title')).trim();
        await api(`/api/conversations/${id}`, { method: 'PATCH', body: { title } });
        conv.title = title;
        renderConversationList();
        if (id === state.currentId) $('#topbar-title').textContent = title;
        modal.close();
      },
    });
  } else if (action === 'delete') {
    const ok = await confirmDialog({
      title: 'Excluir conversa',
      message: `A conversa "${conv.title}" e todas as mensagens serão apagadas. Essa ação não pode ser desfeita.`,
      confirmLabel: 'Excluir',
      danger: true,
    });
    if (!ok) return;
    await api(`/api/conversations/${id}`, { method: 'DELETE' });
    state.conversations = state.conversations.filter((c) => c.id !== id);
    if (id === state.currentId) newChat();
    renderConversationList();
    toast('Conversa excluída.');
  } else {
    openConversation(id);
  }
});

function newChat() {
  state.currentId = null;
  renderConversationList();
  renderWelcome();
  if (state.view !== 'chat') setView('chat');
  $('#topbar-title').textContent = 'Assistente Diesel';
  $('#screen-app').classList.remove('sidebar-open');
  $('#composer-input').focus();
}

async function openConversation(id) {
  if (state.sending) return;
  state.currentId = id;
  renderConversationList();
  if (state.view !== 'chat') setView('chat');
  $('#screen-app').classList.remove('sidebar-open');
  const chat = $('#chat');
  chat.innerHTML = '<p class="muted empty">Carregando…</p>';
  try {
    const { conversation, messages } = await api(`/api/conversations/${id}`);
    $('#topbar-title').textContent = conversation.title;
    chat.innerHTML = '';
    for (const m of messages) {
      if (m.role === 'user') appendUserMessage(m.content);
      else appendAssistantMessage(m.content, m.sources);
    }
    scrollToBottom(true);
  } catch (err) {
    chat.innerHTML = `<p class="msg-error">${escapeHtml(err.message)}</p>`;
  }
}

// ---------- Chat ----------

function renderWelcome() {
  const first = (state.user?.name || '').split(' ')[0];
  $('#chat').innerHTML = `
    <div class="welcome">
      <p class="kicker kicker--dark">ASSISTENTE DIESEL · FB CONSULT</p>
      <h2>Olá${first ? `, ${escapeHtml(first)}` : ''}. Qual a dúvida de hoje?</h2>
      <p>Pergunte sobre tributação do diesel, regras da ANP e do CONTRAN, biodiesel, ARLA ou o Método FB. As respostas trazem a fonte de cada informação.</p>
      <div class="suggestions">
        ${SUGGESTIONS.map(([tag, q]) => `
          <button class="suggestion" data-q="${escapeHtml(q)}"><strong>${escapeHtml(tag)}</strong><span>${escapeHtml(q)}</span></button>`).join('')}
      </div>
    </div>`;
}

$('#chat').addEventListener('click', (ev) => {
  const s = ev.target.closest('.suggestion');
  if (s) return sendMessage(s.dataset.q);
  const cite = ev.target.closest('.cite');
  if (cite) {
    const row = cite.closest('.msg__body')?.querySelector(`.source-row[data-n="${cite.dataset.n}"]`);
    if (row) {
      row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      row.classList.add('is-flash');
      setTimeout(() => row.classList.remove('is-flash'), 1400);
    }
  }
  const docBtn = ev.target.closest('[data-open-doc]');
  if (docBtn) openDocumentFromChat(Number(docBtn.dataset.openDoc));
});

function scrollToBottom(force = false) {
  const box = $('#chat-scroll');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 160;
  if (force || nearBottom) box.scrollTop = box.scrollHeight;
}

function appendUserMessage(text) {
  const el = document.createElement('div');
  el.className = 'msg msg--user';
  el.innerHTML = `<div class="msg__body"></div>`;
  $('.msg__body', el).textContent = text;
  $('#chat').append(el);
  return el;
}

function sourcesHtml(sources) {
  if (!sources?.length) return '';
  return `
    <div class="msg-sources">
      <p class="msg-sources__title">Fontes consultadas</p>
      ${sources.map((s) => `
        <div class="source-row" data-n="${s.n}">
          <span class="source-row__n">${s.n}</span>
          <div class="source-row__txt">
            <strong>${escapeHtml(s.title)}</strong>
            <span class="source-row__meta"> · ${escapeHtml(s.heading)}</span>
            <br><span class="badge ${isInternal(s.category) ? 'badge--fb' : 'badge--lei'}">${escapeHtml(s.category)}</span>
            ${s.verifiedAt ? `<span class="source-row__meta"> verificado em ${fmtDate(s.verifiedAt)}</span>` : ''}
          </div>
          <div class="source-row__actions">
            <button type="button" data-open-doc="${s.docId}">Ver documento</button>
            ${s.url ? `<a href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer">Fonte oficial ↗</a>` : ''}
          </div>
        </div>`).join('')}
    </div>`;
}

function appendAssistantMessage(text, sources, { pending = false } = {}) {
  const el = document.createElement('div');
  el.className = 'msg msg--assistant';
  el.innerHTML = `
    <div class="msg__avatar" aria-hidden="true">FB</div>
    <div class="msg__body">
      <div class="md">${pending ? '<span class="typing"><i></i><i></i><i></i></span>' : renderMarkdown(text)}</div>
      <div class="msg__sources">${pending ? '' : sourcesHtml(sources)}</div>
    </div>`;
  $('#chat').append(el);
  return el;
}

const input = $('#composer-input');
function autosize() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 220) + 'px';
}
input.addEventListener('input', autosize);
input.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
    ev.preventDefault();
    $('#composer').requestSubmit();
  }
});
$('#composer').addEventListener('submit', (ev) => {
  ev.preventDefault();
  sendMessage(input.value);
});

async function sendMessage(text) {
  text = String(text || '').trim();
  if (!text || state.sending) return;
  state.sending = true;
  $('.composer__send').disabled = true;
  input.value = '';
  autosize();

  try {
    if (!state.currentId) {
      const { conversation } = await api('/api/conversations', { method: 'POST', body: {} });
      state.currentId = conversation.id;
      state.conversations.unshift(conversation);
      $('#chat').innerHTML = '';
      renderConversationList();
    }
    appendUserMessage(text);
    const msgEl = appendAssistantMessage('', [], { pending: true });
    scrollToBottom(true);
    await streamAnswer(state.currentId, text, msgEl);
  } catch (err) {
    toast(err.message, true);
  } finally {
    state.sending = false;
    $('.composer__send').disabled = false;
    input.focus();
  }
}

async function streamAnswer(convId, text, msgEl) {
  const mdEl = $('.md', msgEl);
  const srcEl = $('.msg__sources', msgEl);
  let answer = '';
  let sources = [];
  let frame = 0;
  const paint = () => {
    frame = 0;
    mdEl.innerHTML = renderMarkdown(answer);
    scrollToBottom();
  };

  const res = await fetch(`/api/conversations/${convId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: text }),
    credentials: 'same-origin',
  });
  if (!res.ok || !res.body) {
    let msg = `Erro ${res.status}`;
    try { msg = (await res.json()).error || msg; } catch { /* */ }
    if (res.status === 401) showScreen('login');
    mdEl.innerHTML = `<p class="msg-error">${escapeHtml(msg)}</p>`;
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const ev = /^event: (.*)$/m.exec(raw)?.[1];
      const dataLine = /^data: (.*)$/m.exec(raw)?.[1];
      if (!ev || !dataLine) continue;
      const data = JSON.parse(dataLine);
      if (ev === 'sources') {
        sources = data.sources;
      } else if (ev === 'delta') {
        answer += data.text;
        if (!frame) frame = requestAnimationFrame(paint);
      } else if (ev === 'error') {
        answer += `${answer ? '\n\n' : ''}_${data.message}_`;
        paint();
      } else if (ev === 'done') {
        const conv = state.conversations.find((c) => c.id === convId);
        if (conv && data.conversation) {
          Object.assign(conv, data.conversation);
          state.conversations.sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
          renderConversationList();
          if (convId === state.currentId) $('#topbar-title').textContent = conv.title;
        }
      }
    }
  }
  if (frame) cancelAnimationFrame(frame);
  paint();
  srcEl.innerHTML = sourcesHtml(sources);
  scrollToBottom();
}

// ---------- Fontes ----------

async function loadDocuments(selectId) {
  const { documents } = await api('/api/documents');
  state.documents = documents;
  renderDocCategories();
  renderDocList();
  const id = selectId || state.docId || documents[0]?.id;
  if (id) openDocument(id);
}

function renderDocCategories() {
  const cats = ['Todas', ...new Set(state.documents.map((d) => d.category))];
  if (!cats.includes(state.docCategory)) state.docCategory = 'Todas';
  $('#doc-categories').innerHTML = cats
    .map((c) => `<button class="chip ${c === state.docCategory ? 'is-active' : ''}" data-cat="${escapeHtml(c)}">${escapeHtml(c)}</button>`)
    .join('');
}

$('#doc-categories').addEventListener('click', (ev) => {
  const chip = ev.target.closest('.chip');
  if (!chip) return;
  state.docCategory = chip.dataset.cat;
  renderDocCategories();
  renderDocList();
});
$('#doc-search').addEventListener('input', renderDocList);

function renderDocList() {
  const q = $('#doc-search').value.trim().toLowerCase();
  const docs = state.documents.filter(
    (d) =>
      (state.docCategory === 'Todas' || d.category === state.docCategory) &&
      (!q || `${d.title} ${d.source || ''} ${d.category}`.toLowerCase().includes(q))
  );
  $('#doc-list').innerHTML = docs.length
    ? docs.map((d) => `
        <button class="doc-card ${d.id === state.docId ? 'is-active' : ''}" data-id="${d.id}">
          <span class="badge ${isInternal(d.category) ? 'badge--fb' : 'badge--lei'}">${escapeHtml(d.category)}</span>
          <strong>${escapeHtml(d.title)}</strong>
          <span class="muted">Verificado em ${fmtDate(d.verified_at)}</span>
        </button>`).join('')
    : '<p class="muted empty">Nenhum documento encontrado.</p>';
}

$('#doc-list').addEventListener('click', (ev) => {
  const card = ev.target.closest('.doc-card');
  if (card) openDocument(Number(card.dataset.id));
});

async function openDocument(id) {
  state.docId = id;
  $$('.doc-card').forEach((c) => c.classList.toggle('is-active', Number(c.dataset.id) === id));
  const reader = $('#doc-reader');
  try {
    const { document: d } = await api(`/api/documents/${id}`);
    reader.innerHTML = `
      <span class="badge ${isInternal(d.category) ? 'badge--fb' : 'badge--lei'}">${escapeHtml(d.category)}</span>
      <h3>${escapeHtml(d.title)}</h3>
      <dl class="doc-meta">
        ${d.source ? `<dt>Fonte</dt><dd>${escapeHtml(d.source)}</dd>` : ''}
        ${d.url ? `<dt>Link oficial</dt><dd><a href="${escapeHtml(d.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(d.url)}</a></dd>` : ''}
        <dt>Verificado em</dt><dd>${fmtDate(d.verified_at)}</dd>
        <dt>Atualizado em</dt><dd>${fmtDate(d.updated_at, true)}</dd>
      </dl>
      <div class="md">${renderMarkdown(d.content)}</div>`;
    reader.scrollTop = 0;
  } catch (err) {
    reader.innerHTML = `<p class="msg-error">${escapeHtml(err.message)}</p>`;
  }
}

function openDocumentFromChat(id) {
  state.docCategory = 'Todas';
  state.docId = id;
  setView('sources');
}

// ---------- Administração ----------

async function loadAdmin() {
  const [stats] = await Promise.all([api('/api/admin/stats'), loadUsers(), loadAdminDocs()]);
  $('#admin-stats').innerHTML = [
    ['Usuários ativos', stats.users],
    ['Conversas', stats.conversations],
    ['Perguntas (30 dias)', stats.questionsLast30],
    ['Perguntas (total)', stats.questions],
    ['Documentos na base', stats.documents],
  ].map(([label, n]) => `<div class="stat"><span>${label}</span><strong>${n.toLocaleString('pt-BR')}</strong></div>`).join('');
}

$$('.tab').forEach((t) =>
  t.addEventListener('click', () => {
    $$('.tab').forEach((x) => x.classList.toggle('is-active', x === t));
    $('#tab-users').hidden = t.dataset.tab !== 'users';
    $('#tab-documents').hidden = t.dataset.tab !== 'documents';
  })
);

let adminUsers = [];
async function loadUsers() {
  const { users } = await api('/api/admin/users');
  adminUsers = users;
  $('#users-table').innerHTML = `
    <thead><tr><th>Nome</th><th>Usuário</th><th>Perfil</th><th>Status</th><th>Último acesso</th><th></th></tr></thead>
    <tbody>
      ${users.map((u) => `
        <tr data-id="${u.id}">
          <td><strong>${escapeHtml(u.name)}</strong>${u.id === state.user.id ? ' <span class="badge">você</span>' : ''}</td>
          <td class="mono">${escapeHtml(u.username)}</td>
          <td>${u.role === 'admin' ? 'Administrador' : 'Consultor'}</td>
          <td><span class="status ${u.active ? '' : 'is-off'}">${u.active ? (u.mustChangePassword ? 'Aguardando 1º acesso' : 'Ativo') : 'Desativado'}</span></td>
          <td>${fmtDate(u.lastLoginAt, true)}</td>
          <td class="actions">
            <button class="btn btn-secondary btn-sm" data-user-action="edit">Editar</button>
            <button class="btn btn-secondary btn-sm" data-user-action="reset" title="Gerar nova senha provisória">Nova senha</button>
            ${u.id !== state.user.id ? `
              <button class="btn btn-secondary btn-sm" data-user-action="toggle">${u.active ? 'Desativar' : 'Ativar'}</button>
              <button class="btn btn-secondary btn-sm" data-user-action="delete">Excluir</button>` : ''}
          </td>
        </tr>`).join('')}
    </tbody>`;
}

function showTempPassword(title, user, password) {
  modal.open({
    title,
    body: `
      <p class="modal-text">Repasse estes dados a <strong>${escapeHtml(user.name)}</strong> por um canal seguro. A senha provisória <strong>não será exibida novamente</strong>, e a troca será exigida no primeiro acesso.</p>
      <dl class="doc-meta doc-meta--flush"><dt>Usuário</dt><dd class="mono">${escapeHtml(user.username)}</dd></dl>
      <div class="secret"><code>${escapeHtml(password)}</code><button type="button" class="btn btn-secondary btn-sm" id="copy-secret">Copiar</button></div>`,
    actions: [{ label: 'Concluído', className: 'btn-primary' }],
  });
  $('#copy-secret').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(`Usuário: ${user.username}\nSenha provisória: ${password}`);
      toast('Copiado.');
    } catch {
      toast('Não foi possível copiar. Selecione e copie manualmente.', true);
    }
  });
}

function openUserForm(user) {
  const editing = !!user;
  modal.open({
    title: editing ? 'Editar usuário' : 'Novo usuário',
    body: `
      <label class="field"><span>Nome completo</span><input name="name" maxlength="120" required value="${escapeHtml(user?.name || '')}"></label>
      <div class="grid-2">
        <label class="field"><span>Usuário (login)</span>
          <input name="username" maxlength="60" required ${editing ? 'disabled' : ''} value="${escapeHtml(user?.username || '')}" placeholder="ex.: joao.silva" autocapitalize="none" spellcheck="false">
        </label>
        <label class="field"><span>Perfil</span>
          <select name="role" ${editing && user.id === state.user.id ? 'disabled' : ''}>
            <option value="consultor" ${user?.role !== 'admin' ? 'selected' : ''}>Consultor</option>
            <option value="admin" ${user?.role === 'admin' ? 'selected' : ''}>Administrador</option>
          </select>
        </label>
      </div>
      ${editing ? '' : `
      <label class="field"><span>Senha provisória <small>(opcional: deixe em branco para gerar automaticamente)</small></span>
        <input name="password" type="text" autocomplete="off" minlength="8" placeholder="Gerar automaticamente">
      </label>`}`,
    actions: [{ label: 'Cancelar' }, { label: editing ? 'Salvar' : 'Criar usuário', className: 'btn-primary', submit: true }],
    onSubmit: async (fd) => {
      if (editing) {
        const body = { name: fd.get('name') };
        if (fd.get('role')) body.role = fd.get('role');
        await api(`/api/admin/users/${user.id}`, { method: 'PATCH', body });
        modal.close();
        toast('Usuário atualizado.');
        if (user.id === state.user.id) state.user.name = body.name;
      } else {
        const res = await api('/api/admin/users', {
          method: 'POST',
          body: { name: fd.get('name'), username: fd.get('username'), role: fd.get('role'), password: fd.get('password') || undefined },
        });
        showTempPassword('Usuário criado', res.user, res.temporaryPassword);
      }
      loadAdmin();
    },
  });
}

$('#users-table').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('[data-user-action]');
  if (!btn) return;
  const id = Number(btn.closest('tr').dataset.id);
  const user = adminUsers.find((u) => u.id === id);
  const action = btn.dataset.userAction;
  try {
    if (action === 'edit') return openUserForm(user);
    if (action === 'reset') {
      const ok = await confirmDialog({
        title: 'Redefinir senha',
        message: `Uma nova senha provisória será gerada para ${user.name}. As sessões abertas desse usuário serão encerradas.`,
        confirmLabel: 'Gerar nova senha',
      });
      if (!ok) return;
      const res = await api(`/api/admin/users/${id}`, { method: 'PATCH', body: { resetPassword: true } });
      showTempPassword('Senha redefinida', res.user, res.temporaryPassword);
    } else if (action === 'toggle') {
      await api(`/api/admin/users/${id}`, { method: 'PATCH', body: { active: !user.active } });
      toast(user.active ? 'Usuário desativado.' : 'Usuário ativado.');
    } else if (action === 'delete') {
      const ok = await confirmDialog({
        title: 'Excluir usuário',
        message: `${user.name} e todo o histórico de conversas dele serão apagados. Essa ação não pode ser desfeita. Se quiser só bloquear o acesso, use "Desativar".`,
        confirmLabel: 'Excluir',
        danger: true,
      });
      if (!ok) return;
      await api(`/api/admin/users/${id}`, { method: 'DELETE' });
      toast('Usuário excluído.');
    }
    loadAdmin();
  } catch (err) {
    toast(err.message, true);
  }
});

let adminDocs = [];
async function loadAdminDocs() {
  const { documents } = await api('/api/documents');
  adminDocs = documents;
  $('#docs-table').innerHTML = `
    <thead><tr><th>Título</th><th>Categoria</th><th>Verificado em</th><th>Origem</th><th></th></tr></thead>
    <tbody>
      ${documents.map((d) => `
        <tr data-id="${d.id}">
          <td><strong>${escapeHtml(d.title)}</strong></td>
          <td><span class="badge ${isInternal(d.category) ? 'badge--fb' : 'badge--lei'}">${escapeHtml(d.category)}</span></td>
          <td>${fmtDate(d.verified_at)}</td>
          <td>${d.origin === 'admin' ? 'Painel' : 'Arquivo'}</td>
          <td class="actions">
            <button class="btn btn-secondary btn-sm" data-doc-action="edit">Editar</button>
            <button class="btn btn-secondary btn-sm" data-doc-action="delete">Excluir</button>
          </td>
        </tr>`).join('')}
    </tbody>`;
}

async function openDocumentForm(id) {
  let d = {};
  if (id) d = (await api(`/api/documents/${id}`)).document;
  const today = new Date().toISOString().slice(0, 10);
  const categories = [...new Set(adminDocs.map((x) => x.category))];
  modal.open({
    title: id ? 'Editar documento' : 'Novo documento',
    wide: true,
    body: `
      <label class="field"><span>Título</span><input name="title" maxlength="200" required value="${escapeHtml(d.title || '')}"></label>
      <div class="grid-2">
        <label class="field"><span>Categoria</span>
          <input name="category" list="cat-list" maxlength="80" required value="${escapeHtml(d.category || '')}" placeholder="ex.: Tributário">
          <datalist id="cat-list">${categories.map((c) => `<option value="${escapeHtml(c)}">`).join('')}</datalist>
        </label>
        <label class="field"><span>Verificado em</span><input name="verifiedAt" type="date" value="${escapeHtml(d.verified_at || today)}"></label>
      </div>
      <label class="field"><span>Fonte (norma de origem)</span><input name="source" maxlength="500" value="${escapeHtml(d.source || '')}" placeholder="ex.: Lei Complementar nº 192/2022"></label>
      <label class="field"><span>Link oficial</span><input name="url" type="url" maxlength="500" value="${escapeHtml(d.url || '')}" placeholder="https://"></label>
      <label class="field"><span>Conteúdo (Markdown, com seções "## Título")</span><textarea name="content" required>${escapeHtml(d.content || '')}</textarea></label>`,
    actions: [{ label: 'Cancelar' }, { label: 'Salvar documento', className: 'btn-primary', submit: true }],
    onSubmit: async (fd) => {
      const body = Object.fromEntries(['title', 'category', 'verifiedAt', 'source', 'url', 'content'].map((k) => [k, fd.get(k)]));
      await api(id ? `/api/admin/documents/${id}` : '/api/admin/documents', { method: id ? 'PUT' : 'POST', body });
      modal.close();
      toast('Documento salvo. O assistente já usa a nova versão.');
      loadAdmin();
    },
  });
}

$('#docs-table').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('[data-doc-action]');
  if (!btn) return;
  const id = Number(btn.closest('tr').dataset.id);
  const doc = adminDocs.find((d) => d.id === id);
  try {
    if (btn.dataset.docAction === 'edit') return await openDocumentForm(id);
    const ok = await confirmDialog({
      title: 'Excluir documento',
      message: `"${doc.title}" será removido da base e o assistente deixará de usá-lo. As respostas antigas que citaram este documento continuam no histórico.`,
      confirmLabel: 'Excluir',
      danger: true,
    });
    if (!ok) return;
    await api(`/api/admin/documents/${id}`, { method: 'DELETE' });
    toast('Documento excluído.');
    loadAdmin();
  } catch (err) {
    toast(err.message, true);
  }
});

// ---------- Início ----------
boot();
