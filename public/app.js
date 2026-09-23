'use strict';

/* ---------------------------- State & storage ---------------------------- */

const state = {
  token: localStorage.getItem('token') || null,
  user: null,
  servers: [],
  currentServerId: null, // 'dm' for direct messages view
  channels: [],
  currentChannelId: null,
  messages: {},      // channelId -> [messages]
  members: [],
  dmThreads: [],
  currentDmThreadId: null,
  dmMessages: {},     // threadId -> [messages]
  voice: {
    channelId: null,
    joined: false,
    localStream: null,
    peers: {},         // userId -> { pc, audioEl, info, speaking }
    muted: false,
  },
  authMode: 'login',   // 'login' | 'register'
  authError: null,
  modal: null,          // { type: 'create-server' | 'join-server' | 'invite', ... }
};

let es = null; // EventSource

function saveToken(token) {
  state.token = token;
  if (token) localStorage.setItem('token', token);
  else localStorage.removeItem('token');
}

/* ---------------------------- API helpers ---------------------------- */

async function api(path, opts = {}) {
  const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const res = await fetch(path, Object.assign({}, opts, { headers }));
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok) throw new Error((body && body.error) || `Ошибка запроса (${res.status})`);
  return body;
}

/* ---------------------------- Utilities ---------------------------- */

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function initials(name) {
  return (name || '?').trim().slice(0, 2).toUpperCase();
}

function avatarHtml(user, size) {
  const cls = size === 'mini' ? 'avatar avatar-mini' : 'avatar';
  return `<div class="${cls}" style="background:${escapeHtml(user.avatarColor || '#5865F2')}">${escapeHtml(initials(user.displayName || user.username))}</div>`;
}

function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function showToast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

function roleLabel(role) {
  return { owner: 'Владелец', admin: 'Админ', member: 'Участник' }[role] || role;
}

/* ---------------------------- Rendering root ---------------------------- */

function render() {
  const app = document.getElementById('app');
  if (!state.token || !state.user) {
    app.innerHTML = renderAuth();
    bindAuthEvents();
    return;
  }
  app.innerHTML = renderMain();
  bindMainEvents();
  if (state.modal) {
    const modalHost = document.createElement('div');
    modalHost.innerHTML = renderModal();
    document.body.appendChild(modalHost.firstElementChild);
    bindModalEvents();
  }
  scrollMessagesToBottom();
}

/* ---------------------------- Auth screens ---------------------------- */

function renderAuth() {
  const isLogin = state.authMode === 'login';
  return `
  <div class="auth-wrap">
    <div class="auth-card">
      <div class="auth-logo">Disvork</div>
      <h1>${isLogin ? 'С возвращением!' : 'Создать аккаунт'}</h1>
      <p class="sub">${isLogin ? 'Рады видеть тебя снова' : 'Просто ник и пароль — почта не нужна'}</p>
      <form id="auth-form">
        <label>Ник</label>
        <input id="f-username" name="username" autocomplete="username" placeholder="ник (лат. буквы, цифры, _)" required />
        ${isLogin ? '' : `
        <label>Отображаемое имя (необязательно)</label>
        <input id="f-displayname" name="displayName" placeholder="как тебя показывать другим" />
        `}
        <label>Пароль</label>
        <input id="f-password" name="password" type="password" autocomplete="${isLogin ? 'current-password' : 'new-password'}" placeholder="минимум 6 символов" required />
        <button class="submit" type="submit">${isLogin ? 'Войти' : 'Зарегистрироваться'}</button>
      </form>
      ${state.authError ? `<div class="error-box">${escapeHtml(state.authError)}</div>` : ''}
      <div class="auth-switch">
        ${isLogin ? 'Нет аккаунта? <a id="switch-auth">Зарегистрироваться</a>' : 'Уже есть аккаунт? <a id="switch-auth">Войти</a>'}
      </div>
    </div>
  </div>`;
}

function bindAuthEvents() {
  document.getElementById('switch-auth').addEventListener('click', () => {
    state.authMode = state.authMode === 'login' ? 'register' : 'login';
    state.authError = null;
    render();
  });
  document.getElementById('auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('f-username').value.trim();
    const password = document.getElementById('f-password').value;
    const displayNameEl = document.getElementById('f-displayname');
    const displayName = displayNameEl ? displayNameEl.value.trim() : undefined;
    state.authError = null;
    try {
      const path = state.authMode === 'login' ? '/api/auth/login' : '/api/auth/register';
      const body = state.authMode === 'login' ? { username, password } : { username, password, displayName };
      const data = await api(path, { method: 'POST', body: JSON.stringify(body) });
      saveToken(data.token);
      state.user = data.user;
      await bootstrapApp();
    } catch (err) {
      state.authError = err.message;
      render();
    }
  });
}

/* ---------------------------- Main layout ---------------------------- */

function currentServer() {
  return state.servers.find(s => s.id === state.currentServerId) || null;
}

function currentChannel() {
  return state.channels.find(c => c.id === state.currentChannelId) || null;
}

function currentDmThread() {
  return state.dmThreads.find(t => t.id === state.currentDmThreadId) || null;
}

function renderMain() {
  return `
  <div class="main-layout">
    ${renderServersRail()}
    ${state.currentServerId === 'dm' ? renderDmSidebar() : renderServerSidebar()}
    ${renderContentArea()}
  </div>`;
}

function renderServersRail() {
  const items = state.servers.map(s => `
    <div class="server-icon ${state.currentServerId === s.id ? 'active' : ''}" data-server="${s.id}" title="${escapeHtml(s.name)}">
      <div class="pill"></div>${escapeHtml(initials(s.name))}
    </div>`).join('');
  return `
  <div class="servers-rail">
    <div class="server-icon dm-icon ${state.currentServerId === 'dm' ? 'active' : ''}" data-server="dm" title="Личные сообщения">
      <div class="pill"></div>💬
    </div>
    <div class="rail-divider"></div>
    ${items}
    <div class="server-icon" id="add-server-btn" title="Создать или войти на сервер" style="color:var(--green)">＋</div>
  </div>`;
}

function renderServerSidebar() {
  const server = currentServer();
  if (!server) {
    return `<div class="sidebar"><div class="sidebar-header">Выбери сервер</div><div class="channel-list"></div>${renderUserPanel()}</div>`;
  }
  const canManage = ['owner', 'admin'].includes(server.role);
  const textChannels = state.channels.filter(c => c.type === 'text');
  const voiceChannels = state.channels.filter(c => c.type === 'voice');

  const renderChannelItem = (c) => {
    const isVoice = c.type === 'voice';
    const isActive = state.currentChannelId === c.id && (isVoice ? state.voice.joined && state.voice.channelId === c.id : true);
    const participants = isVoice ? getVoiceParticipantsFor(c.id) : [];
    return `
    <div class="channel-item ${state.currentChannelId === c.id ? 'active' : ''}" data-channel="${c.id}" data-ctype="${c.type}">
      <span class="hash">${isVoice ? '🔊' : '#'}</span>
      <span>${escapeHtml(c.name)}</span>
      ${canManage ? `<span class="del-btn" data-del-channel="${c.id}">✕</span>` : ''}
    </div>
    ${participants.length ? `<div class="voice-participants">${participants.map(p => `
      <div class="voice-participant">${avatarHtml({ displayName: p.displayName || p.username, avatarColor: p.avatarColor }, 'mini')}<span>${escapeHtml(p.displayName || p.username)}</span></div>
    `).join('')}</div>` : ''}
    `;
  };

  return `
  <div class="sidebar">
    <div class="sidebar-header">
      <span>${escapeHtml(server.name)}</span>
      <button class="invite-btn secondary" id="invite-btn">Пригласить</button>
    </div>
    <div class="channel-list">
      <div class="channel-group-label">Текстовые каналы</div>
      ${textChannels.map(renderChannelItem).join('')}
      ${canManage ? `
      <div class="add-channel-row">
        <input id="new-text-channel" placeholder="новый канал" />
        <button id="add-text-channel" class="secondary">+</button>
      </div>` : ''}
      <div class="channel-group-label">Голосовые каналы</div>
      ${voiceChannels.map(renderChannelItem).join('')}
      ${canManage ? `
      <div class="add-channel-row">
        <input id="new-voice-channel" placeholder="новый голосовой" />
        <button id="add-voice-channel" class="secondary">+</button>
      </div>` : ''}
    </div>
    ${renderUserPanel()}
  </div>`;
}

function renderDmSidebar() {
  const items = state.dmThreads.map(t => `
    <div class="channel-item ${state.currentDmThreadId === t.id ? 'active' : ''}" data-dm-thread="${t.id}">
      ${avatarHtml(t.user, 'mini')}
      <span>${escapeHtml(t.user.displayName || t.user.username)}</span>
    </div>`).join('');
  return `
  <div class="sidebar">
    <div class="sidebar-header"><span>Личные сообщения</span></div>
    <div class="channel-list">
      <div class="add-channel-row">
        <input id="new-dm-username" placeholder="ник пользователя" />
        <button id="start-dm" class="secondary">Написать</button>
      </div>
      <div class="channel-group-label">Чаты</div>
      ${items || '<div style="padding:8px;color:var(--text-muted);font-size:13px;">Пока пусто</div>'}
    </div>
    ${renderUserPanel()}
  </div>`;
}

function renderUserPanel() {
  const u = state.user;
  return `
  <div class="user-panel">
    ${avatarHtml(u)}
    <div class="who">
      <div class="name">${escapeHtml(u.displayName || u.username)}</div>
      <div class="status">@${escapeHtml(u.username)}</div>
    </div>
    <button class="logout" id="logout-btn" title="Выйти">⏻</button>
  </div>`;
}

function renderContentArea() {
  if (state.currentServerId === 'dm') {
    return renderDmContent();
  }
  if (!state.currentServerId) {
    return `<div class="content-area"><div class="empty-hint">Выбери или создай сервер слева, чтобы начать</div></div>`;
  }
  const ch = currentChannel();
  if (!ch) {
    return `<div class="content-area"><div class="empty-hint">Выбери канал</div></div>`;
  }
  if (ch.type === 'voice') {
    return renderVoiceContent(ch);
  }
  return renderTextContent(ch);
}

function renderTextContent(ch) {
  const msgs = state.messages[ch.id] || [];
  return `
  <div class="content-area">
    <div class="content-header"><span class="hash">#</span>&nbsp;${escapeHtml(ch.name)}</div>
    <div class="content-body">
      <div class="chat-column">
        <div class="messages" id="messages-scroll">
          ${msgs.length ? msgs.map(renderMessage).join('') : `<div class="empty-hint">Пока нет сообщений. Напиши первым!</div>`}
        </div>
        <div class="composer">
          <form id="send-form">
            <input id="msg-input" placeholder="Написать в #${escapeHtml(ch.name)}" autocomplete="off" />
            <button type="submit">➤</button>
          </form>
        </div>
      </div>
      ${renderMemberList()}
    </div>
  </div>`;
}

function renderMessage(m) {
  return `
  <div class="msg-row">
    ${avatarHtml(m.author)}
    <div class="msg-content">
      <div class="msg-head">
        <span class="msg-author">${escapeHtml(m.author.displayName || m.author.username)}</span>
        <span class="msg-time">${formatTime(m.createdAt)}</span>
      </div>
      <div class="msg-text">${escapeHtml(m.content)}</div>
    </div>
  </div>`;
}

function renderMemberList() {
  const server = currentServer();
  if (!server) return '';
  const canManage = ['owner', 'admin'].includes(server.role);
  const groups = { owner: [], admin: [], member: [] };
  for (const m of state.members) (groups[m.role] || groups.member).push(m);
  const renderGroup = (label, arr) => arr.length ? `
    <div class="member-group-label">${label} — ${arr.length}</div>
    ${arr.map(m => `
      <div class="member-item">
        ${avatarHtml(m, 'mini')}
        <div>
          <div class="mname">${escapeHtml(m.displayName || m.username)}</div>
        </div>
        ${(canManage && m.role !== 'owner' && m.id !== state.user.id) ? `
        <div class="member-actions">
          ${m.role === 'admin'
            ? `<button class="secondary" data-set-role="${m.id}:member">− admin</button>`
            : `<button class="secondary" data-set-role="${m.id}:admin">+ admin</button>`}
          <button class="danger" data-kick="${m.id}">кик</button>
        </div>` : ''}
      </div>`).join('')}
  ` : '';
  return `
  <div class="member-list">
    ${renderGroup('Владелец', groups.owner)}
    ${renderGroup('Админы', groups.admin)}
    ${renderGroup('Участники', groups.member)}
  </div>`;
}

function renderVoiceContent(ch) {
  const inThisChannel = state.voice.joined && state.voice.channelId === ch.id;
  const participants = getVoiceParticipantsFor(ch.id, true);
  return `
  <div class="content-area">
    <div class="content-header">🔊&nbsp;${escapeHtml(ch.name)}</div>
    <div class="content-body">
      <div class="voice-stage">
        <div class="voice-grid">
          ${participants.length ? participants.map(p => `
            <div class="voice-tile">
              <div class="avatar ${p.speaking ? 'speaking' : ''}" style="background:${escapeHtml(p.avatarColor || '#5865F2')}">${escapeHtml(initials(p.displayName || p.username))}</div>
              <div class="vname">${escapeHtml(p.displayName || p.username)}${p.isMe ? ' (ты)' : ''}</div>
            </div>
          `).join('') : `<div class="empty-hint">В канале пока никого нет</div>`}
        </div>
        <div class="voice-controls">
          ${inThisChannel
            ? `<button class="secondary" id="voice-mute-btn">${state.voice.muted ? '🔇 Включить микрофон' : '🎙️ Выключить микрофон'}</button>
               <button class="danger" id="voice-leave-btn">Покинуть канал</button>`
            : `<button id="voice-join-btn">Подключиться к голосовому каналу</button>`}
        </div>
      </div>
      ${renderMemberList()}
    </div>
  </div>`;
}

function getVoiceParticipantsFor(channelId, withSelf) {
  if (state.voice.channelId !== channelId) {
    if (!(withSelf && state.voice.joined && state.voice.channelId === channelId)) return [];
  }
  const list = [];
  if (state.voice.joined && state.voice.channelId === channelId) {
    list.push({ userId: state.user.id, username: state.user.username, displayName: state.user.displayName, avatarColor: state.user.avatarColor, isMe: true, speaking: false });
  }
  for (const [userId, p] of Object.entries(state.voice.peers)) {
    if (state.voice.channelId !== channelId) continue;
    list.push({ userId, username: p.info.username, displayName: p.info.displayName, avatarColor: p.info.avatarColor, speaking: !!p.speaking });
  }
  return list;
}

function renderDmContent() {
  const thread = currentDmThread();
  if (!thread) {
    return `<div class="content-area"><div class="empty-hint">Выбери переписку слева или начни новую по нику</div></div>`;
  }
  const msgs = state.dmMessages[thread.id] || [];
  return `
  <div class="content-area">
    <div class="content-header">${avatarHtml(thread.user, 'mini')}&nbsp;${escapeHtml(thread.user.displayName || thread.user.username)}</div>
    <div class="content-body">
      <div class="chat-column">
        <div class="messages" id="messages-scroll">
          ${msgs.length ? msgs.map(renderMessage).join('') : `<div class="empty-hint">Начните переписку</div>`}
        </div>
        <div class="composer">
          <form id="send-dm-form">
            <input id="dm-input" placeholder="Написать @${escapeHtml(thread.user.username)}" autocomplete="off" />
            <button type="submit">➤</button>
          </form>
        </div>
      </div>
    </div>
  </div>`;
}

/* ---------------------------- Modals ---------------------------- */

function renderModal() {
  const m = state.modal;
  if (!m) return '';
  if (m.type === 'create-join') {
    return `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal">
        <h2>Добавить сервер</h2>
        <p class="sub">Создай новый сервер для друзей или войди по приглашению</p>
        <label>Название нового сервера</label>
        <input id="modal-server-name" placeholder="Например: Наша тусовка" />
        <div class="modal-actions"><button id="modal-create-server">Создать сервер</button></div>
        <div style="height:1px;background:var(--border);margin:18px 0;"></div>
        <label>Код приглашения</label>
        <input id="modal-invite-code" placeholder="код приглашения" />
        <div class="modal-actions"><button class="secondary" id="modal-join-server">Войти по коду</button></div>
        ${state.modalError ? `<div class="error-box">${escapeHtml(state.modalError)}</div>` : ''}
        <div class="modal-actions"><button class="secondary" id="modal-close">Закрыть</button></div>
      </div>
    </div>`;
  }
  if (m.type === 'invite') {
    return `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal">
        <h2>Пригласить друзей</h2>
        <p class="sub">Отправь этот код — его нужно ввести на экране «Добавить сервер»</p>
        <div class="invite-code-box">
          <span>${escapeHtml(m.code)}</span>
          <button class="secondary" id="copy-invite">Скопировать</button>
        </div>
        <div class="modal-actions"><button class="secondary" id="modal-close">Готово</button></div>
      </div>
    </div>`;
  }
  return '';
}

function bindModalEvents() {
  const backdrop = document.getElementById('modal-backdrop');
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeModal(); });
  const closeBtn = document.getElementById('modal-close');
  if (closeBtn) closeBtn.addEventListener('click', closeModal);

  const createBtn = document.getElementById('modal-create-server');
  if (createBtn) createBtn.addEventListener('click', async () => {
    const name = document.getElementById('modal-server-name').value.trim();
    if (!name) return;
    try {
      const data = await api('/api/servers', { method: 'POST', body: JSON.stringify({ name }) });
      state.servers.push(data.server);
      closeModal();
      await selectServer(data.server.id);
    } catch (err) {
      state.modalError = err.message;
      render();
    }
  });

  const joinBtn = document.getElementById('modal-join-server');
  if (joinBtn) joinBtn.addEventListener('click', async () => {
    const inviteCode = document.getElementById('modal-invite-code').value.trim();
    if (!inviteCode) return;
    try {
      const data = await api('/api/servers/join', { method: 'POST', body: JSON.stringify({ inviteCode }) });
      if (!state.servers.find(s => s.id === data.server.id)) state.servers.push(data.server);
      closeModal();
      await selectServer(data.server.id);
    } catch (err) {
      state.modalError = err.message;
      render();
    }
  });

  const copyBtn = document.getElementById('copy-invite');
  if (copyBtn) copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(state.modal.code);
      showToast('Код скопирован');
    } catch {
      showToast('Не удалось скопировать — выдели вручную');
    }
  });
}

function closeModal() {
  state.modal = null;
  state.modalError = null;
  const backdrop = document.getElementById('modal-backdrop');
  if (backdrop) backdrop.remove();
}

/* ---------------------------- Event binding (main) ---------------------------- */

function bindMainEvents() {
  const logoutBtn = document.getElementById('logout-btn');
  if (logoutBtn) logoutBtn.addEventListener('click', logout);

  document.querySelectorAll('[data-server]').forEach(el => {
    el.addEventListener('click', () => selectServer(el.dataset.server));
  });

  const addServerBtn = document.getElementById('add-server-btn');
  if (addServerBtn) addServerBtn.addEventListener('click', () => {
    state.modal = { type: 'create-join' };
    render();
  });

  const inviteBtn = document.getElementById('invite-btn');
  if (inviteBtn) inviteBtn.addEventListener('click', () => {
    const server = currentServer();
    state.modal = { type: 'invite', code: server.inviteCode };
    render();
  });

  document.querySelectorAll('[data-channel]').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.dataset.delChannel) return;
      selectChannel(el.dataset.channel, el.dataset.ctype);
    });
  });

  document.querySelectorAll('[data-del-channel]').forEach(el => {
    el.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('Удалить канал?')) return;
      try {
        await api(`/api/servers/${state.currentServerId}/channels/${el.dataset.delChannel}`, { method: 'DELETE' });
        state.channels = state.channels.filter(c => c.id !== el.dataset.delChannel);
        if (state.currentChannelId === el.dataset.delChannel) state.currentChannelId = null;
        render();
      } catch (err) { showToast(err.message); }
    });
  });

  const addText = document.getElementById('add-text-channel');
  if (addText) addText.addEventListener('click', () => createChannel('text', 'new-text-channel'));
  const addVoice = document.getElementById('add-voice-channel');
  if (addVoice) addVoice.addEventListener('click', () => createChannel('voice', 'new-voice-channel'));

  const sendForm = document.getElementById('send-form');
  if (sendForm) sendForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = document.getElementById('msg-input');
    const content = input.value.trim();
    if (!content) return;
    input.value = '';
    try {
      await api(`/api/channels/${state.currentChannelId}/messages`, { method: 'POST', body: JSON.stringify({ content }) });
    } catch (err) { showToast(err.message); }
  });

  document.querySelectorAll('[data-dm-thread]').forEach(el => {
    el.addEventListener('click', () => selectDmThread(el.dataset.dmThread));
  });

  const startDm = document.getElementById('start-dm');
  if (startDm) startDm.addEventListener('click', async () => {
    const input = document.getElementById('new-dm-username');
    const username = input.value.trim();
    if (!username) return;
    try {
      const data = await api('/api/dm/threads', { method: 'POST', body: JSON.stringify({ username }) });
      if (!state.dmThreads.find(t => t.id === data.thread.id)) state.dmThreads.push(data.thread);
      input.value = '';
      await selectDmThread(data.thread.id);
    } catch (err) { showToast(err.message); }
  });

  const sendDmForm = document.getElementById('send-dm-form');
  if (sendDmForm) sendDmForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = document.getElementById('dm-input');
    const content = input.value.trim();
    if (!content) return;
    input.value = '';
    try {
      await api(`/api/dm/threads/${state.currentDmThreadId}/messages`, { method: 'POST', body: JSON.stringify({ content }) });
    } catch (err) { showToast(err.message); }
  });

  document.querySelectorAll('[data-set-role]').forEach(el => {
    el.addEventListener('click', async () => {
      const [userId, role] = el.dataset.setRole.split(':');
      try {
        await api(`/api/servers/${state.currentServerId}/members/${userId}/role`, { method: 'PATCH', body: JSON.stringify({ role }) });
        await loadMembers();
      } catch (err) { showToast(err.message); }
    });
  });

  document.querySelectorAll('[data-kick]').forEach(el => {
    el.addEventListener('click', async () => {
      if (!confirm('Убрать участника с сервера?')) return;
      try {
        await api(`/api/servers/${state.currentServerId}/members/${el.dataset.kick}`, { method: 'DELETE' });
        await loadMembers();
      } catch (err) { showToast(err.message); }
    });
  });

  const voiceJoinBtn = document.getElementById('voice-join-btn');
  if (voiceJoinBtn) voiceJoinBtn.addEventListener('click', () => joinVoiceChannel(state.currentChannelId));
  const voiceLeaveBtn = document.getElementById('voice-leave-btn');
  if (voiceLeaveBtn) voiceLeaveBtn.addEventListener('click', leaveVoiceChannel);
  const voiceMuteBtn = document.getElementById('voice-mute-btn');
  if (voiceMuteBtn) voiceMuteBtn.addEventListener('click', toggleMute);
}

function scrollMessagesToBottom() {
  const el = document.getElementById('messages-scroll');
  if (el) el.scrollTop = el.scrollHeight;
}

/* ---------------------------- Actions ---------------------------- */

async function createChannel(type, inputId) {
  const input = document.getElementById(inputId);
  const name = input.value.trim();
  if (!name) return;
  try {
    const data = await api(`/api/servers/${state.currentServerId}/channels`, { method: 'POST', body: JSON.stringify({ name, type }) });
    state.channels.push(data.channel);
    render();
  } catch (err) { showToast(err.message); }
}

async function selectServer(serverId) {
  if (state.voice.joined) await leaveVoiceChannel();
  state.currentServerId = serverId;
  state.currentChannelId = null;
  state.currentDmThreadId = null;
  render();
  if (serverId === 'dm') {
    await loadDmThreads();
  } else {
    await loadChannels();
    await loadMembers();
    const firstText = state.channels.find(c => c.type === 'text');
    if (firstText) await selectChannel(firstText.id, 'text');
  }
}

async function selectChannel(channelId, ctype) {
  state.currentChannelId = channelId;
  render();
  if (ctype === 'text') {
    if (!state.messages[channelId]) await loadMessages(channelId);
    render();
  }
}

async function selectDmThread(threadId) {
  state.currentDmThreadId = threadId;
  render();
  if (!state.dmMessages[threadId]) await loadDmMessages(threadId);
  render();
}

async function loadChannels() {
  const data = await api(`/api/servers/${state.currentServerId}/channels`);
  state.channels = data.channels;
}

async function loadMembers() {
  const data = await api(`/api/servers/${state.currentServerId}/members`);
  state.members = data.members;
  render();
}

async function loadMessages(channelId) {
  const data = await api(`/api/channels/${channelId}/messages`);
  state.messages[channelId] = data.messages;
}

async function loadDmThreads() {
  const data = await api('/api/dm/threads');
  state.dmThreads = data.threads;
  render();
}

async function loadDmMessages(threadId) {
  const data = await api(`/api/dm/threads/${threadId}/messages`);
  state.dmMessages[threadId] = data.messages;
}

function logout() {
  if (state.voice.joined) leaveVoiceChannel();
  if (es) { es.close(); es = null; }
  saveToken(null);
  state.user = null;
  state.servers = [];
  state.channels = [];
  state.messages = {};
  state.currentServerId = null;
  state.currentChannelId = null;
  render();
}

/* ---------------------------- Realtime (SSE) ---------------------------- */

function connectStream() {
  if (es) es.close();
  es = new EventSource(`/api/stream?token=${encodeURIComponent(state.token)}`);

  es.addEventListener('message:new', (e) => {
    const msg = JSON.parse(e.data);
    if (!state.messages[msg.channelId]) state.messages[msg.channelId] = [];
    state.messages[msg.channelId].push(msg);
    if (state.currentChannelId === msg.channelId) render();
  });

  es.addEventListener('dm:new', (e) => {
    const msg = JSON.parse(e.data);
    if (!state.dmMessages[msg.threadId]) state.dmMessages[msg.threadId] = [];
    state.dmMessages[msg.threadId].push(msg);
    if (state.currentDmThreadId === msg.threadId) render();
    if (!state.dmThreads.find(t => t.id === msg.threadId) && state.currentServerId === 'dm') {
      loadDmThreads();
    }
  });

  es.addEventListener('voice:peer-joined', (e) => {
    const data = JSON.parse(e.data);
    if (state.voice.joined && state.voice.channelId === data.channelId) {
      // Existing peer waits for the newcomer's offer; nothing to do yet.
      render();
    }
  });

  es.addEventListener('voice:peer-left', (e) => {
    const data = JSON.parse(e.data);
    const peer = state.voice.peers[data.userId];
    if (peer) {
      try { peer.pc.close(); } catch {}
      if (peer.audioEl) peer.audioEl.remove();
      delete state.voice.peers[data.userId];
    }
    if (state.voice.joined && state.voice.channelId === data.channelId) render();
  });

  es.addEventListener('voice:signal', async (e) => {
    const { fromUserId, data } = JSON.parse(e.data);
    await handleVoiceSignal(fromUserId, data);
    render();
  });

  es.onerror = () => {
    // EventSource auto-reconnects; nothing else to do.
  };
}

/* ---------------------------- Voice (WebRTC mesh) ---------------------------- */

const RTC_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

function createPeerConnection(remoteUserId, remoteInfo) {
  const pc = new RTCPeerConnection(RTC_CONFIG);
  if (state.voice.localStream) {
    for (const track of state.voice.localStream.getTracks()) pc.addTrack(track, state.voice.localStream);
  }
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      sendVoiceSignal(remoteUserId, { type: 'ice', candidate: event.candidate });
    }
  };
  pc.ontrack = (event) => {
    const audioEl = document.createElement('audio');
    audioEl.autoplay = true;
    audioEl.srcObject = event.streams[0];
    document.body.appendChild(audioEl);
    state.voice.peers[remoteUserId].audioEl = audioEl;
  };
  state.voice.peers[remoteUserId] = { pc, info: remoteInfo, audioEl: null, speaking: false };
  return pc;
}

async function sendVoiceSignal(toUserId, data) {
  try {
    await api('/api/voice/signal', { method: 'POST', body: JSON.stringify({ toUserId, data, channelId: state.voice.channelId }) });
  } catch { /* ignore */ }
}

async function handleVoiceSignal(fromUserId, data) {
  if (!state.voice.joined) return;
  let peer = state.voice.peers[fromUserId];
  let pcRef;
  if (!peer) {
    const member = state.members.find(m => m.id === fromUserId);
    const info = member || { username: 'участник', displayName: 'Участник', avatarColor: '#5865F2' };
    pcRef = createPeerConnection(fromUserId, info);
  } else {
    pcRef = peer.pc;
  }

  if (data.type === 'offer') {
    await pcRef.setRemoteDescription(new RTCSessionDescription(data.sdp));
    const answer = await pcRef.createAnswer();
    await pcRef.setLocalDescription(answer);
    sendVoiceSignal(fromUserId, { type: 'answer', sdp: answer });
  } else if (data.type === 'answer') {
    await pcRef.setRemoteDescription(new RTCSessionDescription(data.sdp));
  } else if (data.type === 'ice') {
    try { await pcRef.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch { /* ignore */ }
  }
}

async function joinVoiceChannel(channelId) {
  try {
    state.voice.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch (err) {
    showToast('Не удалось получить доступ к микрофону: ' + err.message);
    return;
  }
  state.voice.channelId = channelId;
  state.voice.joined = true;
  state.voice.muted = false;
  render();

  let data;
  try {
    data = await api(`/api/voice/${channelId}/join`, { method: 'POST' });
  } catch (err) {
    showToast(err.message);
    return;
  }

  // I am the newcomer: create an offer to each existing peer.
  for (const peer of data.peers) {
    const pc = createPeerConnection(peer.userId, peer);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendVoiceSignal(peer.userId, { type: 'offer', sdp: offer });
  }
  render();
}

async function leaveVoiceChannel() {
  if (!state.voice.joined) return;
  const channelId = state.voice.channelId;
  for (const [userId, peer] of Object.entries(state.voice.peers)) {
    try { peer.pc.close(); } catch {}
    if (peer.audioEl) peer.audioEl.remove();
  }
  state.voice.peers = {};
  if (state.voice.localStream) {
    for (const track of state.voice.localStream.getTracks()) track.stop();
  }
  state.voice.localStream = null;
  state.voice.joined = false;
  state.voice.channelId = null;
  try { await api(`/api/voice/${channelId}/leave`, { method: 'POST' }); } catch { /* ignore */ }
  render();
}

function toggleMute() {
  if (!state.voice.localStream) return;
  state.voice.muted = !state.voice.muted;
  for (const track of state.voice.localStream.getAudioTracks()) track.enabled = !state.voice.muted;
  render();
}

/* ---------------------------- Bootstrap ---------------------------- */

async function bootstrapApp() {
  try {
    const me = await api('/api/me');
    state.user = me.user;
  } catch {
    saveToken(null);
    state.user = null;
    render();
    return;
  }
  connectStream();
  try {
    const data = await api('/api/servers');
    state.servers = data.servers;
  } catch { state.servers = []; }
  render();
}

window.__DEBUG_STATE__ = state;

(async function init() {
  if (state.token) {
    await bootstrapApp();
  } else {
    render();
  }
})();
