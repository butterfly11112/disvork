import { db } from './db.js';
import { signToken, verifyToken } from './auth.js';
import { hashPassword, verifyPassword } from './password.js';
import { makeId, makeInviteCode } from './id.js';
import { createRouter, readJsonBody, sendJson } from './router.js';
import { sendToUsers, addClient, removeClient, voiceJoin, voiceLeave, voiceLeaveAll, voicePeers } from './bus.js';

const now = () => Date.now();
const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;

function publicUser(u) {
  if (!u) return null;
  return { id: u.id, username: u.username, displayName: u.display_name, avatarColor: u.avatar_color };
}

function getMembership(serverId, userId) {
  return db.prepare('SELECT * FROM memberships WHERE server_id = ? AND user_id = ?').get(serverId, userId);
}

function serverMemberIds(serverId) {
  return db.prepare('SELECT user_id FROM memberships WHERE server_id = ?').all(serverId).map(r => r.user_id);
}

function channelServerId(channelId) {
  const ch = db.prepare('SELECT server_id FROM channels WHERE id = ?').get(channelId);
  return ch ? ch.server_id : null;
}

function threadKey(a, b) { return a < b ? [a, b] : [b, a]; }

function getOrCreateThread(userA, userB) {
  const [a, b] = threadKey(userA, userB);
  let thread = db.prepare('SELECT * FROM dm_threads WHERE user_a = ? AND user_b = ?').get(a, b);
  if (!thread) {
    const id = makeId();
    db.prepare('INSERT INTO dm_threads (id, user_a, user_b, created_at) VALUES (?, ?, ?, ?)').run(id, a, b, now());
    thread = { id, user_a: a, user_b: b };
  }
  return thread;
}

function authenticate(req) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return null;
  return verifyToken(token);
}

export function buildRouter() {
  const router = createRouter();

  router.get('/api/health', (req, res) => sendJson(res, 200, { ok: true }));

  // ---------- AUTH (no token required) ----------

  router.post('/api/auth/register', async (req, res) => {
    const body = await readJsonBody(req);
    const { username, password, displayName } = body || {};
    if (!username || !password) return sendJson(res, 400, { error: 'Укажите ник и пароль' });
    if (!USERNAME_RE.test(username)) {
      return sendJson(res, 400, { error: 'Ник: 3-20 символов, латиница/цифры/подчёркивание' });
    }
    if (password.length < 6) return sendJson(res, 400, { error: 'Пароль минимум 6 символов' });

    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (existing) return sendJson(res, 409, { error: 'Такой ник уже занят' });

    const id = makeId();
    const hash = hashPassword(password);
    const colors = ['#5865F2', '#57F287', '#FEE75C', '#EB459E', '#ED4245', '#00b0f4'];
    const avatarColor = colors[Math.floor(Math.random() * colors.length)];

    db.prepare(
      'INSERT INTO users (id, username, password_hash, display_name, avatar_color, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(id, username, hash, (displayName && displayName.trim()) || username, avatarColor, now());

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    const token = signToken(user);
    sendJson(res, 200, { token, user: publicUser(user) });
  });

  router.post('/api/auth/login', async (req, res) => {
    const body = await readJsonBody(req);
    const { username, password } = body || {};
    if (!username || !password) return sendJson(res, 400, { error: 'Укажите ник и пароль' });
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user || !verifyPassword(password, user.password_hash)) {
      return sendJson(res, 401, { error: 'Неверный ник или пароль' });
    }
    const token = signToken(user);
    sendJson(res, 200, { token, user: publicUser(user) });
  });

  // ---------- Auth-required middleware wrapper ----------

  function withAuth(handler) {
    return async (req, res, params) => {
      const payload = authenticate(req);
      if (!payload) return sendJson(res, 401, { error: 'Не авторизован' });
      req.user = payload;
      return handler(req, res, params);
    };
  }

  function withMember(handler) {
    return withAuth(async (req, res, params) => {
      const m = getMembership(params.serverId, req.user.id);
      if (!m) return sendJson(res, 403, { error: 'Вы не участник этого сервера' });
      req.membership = m;
      return handler(req, res, params);
    });
  }

  function withManager(handler) {
    return withMember(async (req, res, params) => {
      if (!['owner', 'admin'].includes(req.membership.role)) {
        return sendJson(res, 403, { error: 'Недостаточно прав' });
      }
      return handler(req, res, params);
    });
  }

  router.get('/api/me', withAuth((req, res) => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!user) return sendJson(res, 404, { error: 'Пользователь не найден' });
    sendJson(res, 200, { user: publicUser(user) });
  }));

  // ---------- SERVERS ----------

  router.get('/api/servers', withAuth((req, res) => {
    const rows = db.prepare(
      `SELECT s.*, m.role FROM servers s
       JOIN memberships m ON m.server_id = s.id
       WHERE m.user_id = ? ORDER BY s.created_at ASC`
    ).all(req.user.id);
    sendJson(res, 200, { servers: rows.map(r => ({ id: r.id, name: r.name, ownerId: r.owner_id, inviteCode: r.invite_code, role: r.role })) });
  }));

  router.post('/api/servers', withAuth(async (req, res) => {
    const body = await readJsonBody(req);
    const name = (body.name || '').trim();
    if (!name) return sendJson(res, 400, { error: 'Укажите название сервера' });

    const id = makeId();
    const inviteCode = makeInviteCode();
    const ts = now();
    db.prepare('INSERT INTO servers (id, name, owner_id, invite_code, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, name, req.user.id, inviteCode, ts);
    db.prepare('INSERT INTO memberships (server_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
      .run(id, req.user.id, 'owner', ts);
    db.prepare('INSERT INTO channels (id, server_id, name, type, position, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(makeId(), id, 'general', 'text', 0, ts);
    db.prepare('INSERT INTO channels (id, server_id, name, type, position, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(makeId(), id, 'Общий голосовой', 'voice', 1, ts);

    sendJson(res, 200, { server: { id, name, ownerId: req.user.id, inviteCode, role: 'owner' } });
  }));

  router.post('/api/servers/join', withAuth(async (req, res) => {
    const body = await readJsonBody(req);
    const inviteCode = (body.inviteCode || '').trim();
    const server = db.prepare('SELECT * FROM servers WHERE invite_code = ?').get(inviteCode);
    if (!server) return sendJson(res, 404, { error: 'Приглашение не найдено' });

    const existing = getMembership(server.id, req.user.id);
    if (existing) {
      return sendJson(res, 200, { server: { id: server.id, name: server.name, ownerId: server.owner_id, inviteCode: server.invite_code, role: existing.role } });
    }
    db.prepare('INSERT INTO memberships (server_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
      .run(server.id, req.user.id, 'member', now());
    sendJson(res, 200, { server: { id: server.id, name: server.name, ownerId: server.owner_id, inviteCode: server.invite_code, role: 'member' } });
  }));

  router.get('/api/servers/:serverId/members', withMember((req, res, params) => {
    const rows = db.prepare(
      `SELECT u.id, u.username, u.display_name, u.avatar_color, m.role FROM memberships m
       JOIN users u ON u.id = m.user_id WHERE m.server_id = ? ORDER BY m.role, u.username`
    ).all(params.serverId);
    sendJson(res, 200, { members: rows.map(r => ({ id: r.id, username: r.username, displayName: r.display_name, avatarColor: r.avatar_color, role: r.role })) });
  }));

  router.patch('/api/servers/:serverId/members/:userId/role', withManager(async (req, res, params) => {
    const body = await readJsonBody(req);
    const role = body.role;
    if (!['admin', 'member'].includes(role)) return sendJson(res, 400, { error: 'Недопустимая роль' });
    const target = getMembership(params.serverId, params.userId);
    if (!target) return sendJson(res, 404, { error: 'Участник не найден' });
    if (target.role === 'owner') return sendJson(res, 400, { error: 'Нельзя менять роль владельца' });
    db.prepare('UPDATE memberships SET role = ? WHERE server_id = ? AND user_id = ?').run(role, params.serverId, params.userId);
    sendJson(res, 200, { ok: true });
  }));

  router.delete('/api/servers/:serverId/members/:userId', withManager((req, res, params) => {
    const target = getMembership(params.serverId, params.userId);
    if (!target) return sendJson(res, 404, { error: 'Участник не найден' });
    if (target.role === 'owner') return sendJson(res, 400, { error: 'Нельзя удалить владельца' });
    db.prepare('DELETE FROM memberships WHERE server_id = ? AND user_id = ?').run(params.serverId, params.userId);
    sendJson(res, 200, { ok: true });
  }));

  // ---------- CHANNELS ----------

  router.get('/api/servers/:serverId/channels', withMember((req, res, params) => {
    const rows = db.prepare('SELECT * FROM channels WHERE server_id = ? ORDER BY type, position, created_at').all(params.serverId);
    sendJson(res, 200, { channels: rows.map(r => ({ id: r.id, name: r.name, type: r.type, position: r.position })) });
  }));

  router.post('/api/servers/:serverId/channels', withManager(async (req, res, params) => {
    const body = await readJsonBody(req);
    const name = (body.name || '').trim();
    if (!name) return sendJson(res, 400, { error: 'Укажите название канала' });
    const chType = body.type === 'voice' ? 'voice' : 'text';
    const id = makeId();
    const maxPos = db.prepare('SELECT COALESCE(MAX(position), -1) AS p FROM channels WHERE server_id = ? AND type = ?')
      .get(params.serverId, chType).p;
    db.prepare('INSERT INTO channels (id, server_id, name, type, position, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, params.serverId, name, chType, maxPos + 1, now());
    sendJson(res, 200, { channel: { id, name, type: chType, position: maxPos + 1 } });
  }));

  router.delete('/api/servers/:serverId/channels/:channelId', withManager((req, res, params) => {
    const ch = db.prepare('SELECT * FROM channels WHERE id = ? AND server_id = ?').get(params.channelId, params.serverId);
    if (!ch) return sendJson(res, 404, { error: 'Канал не найден' });
    db.prepare('DELETE FROM channels WHERE id = ?').run(params.channelId);
    sendJson(res, 200, { ok: true });
  }));

  // ---------- MESSAGES ----------

  router.get('/api/channels/:channelId/messages', withAuth((req, res, params) => {
    const serverId = channelServerId(params.channelId);
    if (!serverId) return sendJson(res, 404, { error: 'Канал не найден' });
    if (!getMembership(serverId, req.user.id)) return sendJson(res, 403, { error: 'Нет доступа' });

    const url = new URL(req.url, 'http://x');
    const before = url.searchParams.get('before') ? Number(url.searchParams.get('before')) : now() + 1;
    const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 100);
    const rows = db.prepare(
      `SELECT msg.*, u.username, u.display_name, u.avatar_color FROM messages msg
       JOIN users u ON u.id = msg.user_id
       WHERE msg.channel_id = ? AND msg.created_at < ?
       ORDER BY msg.created_at DESC LIMIT ?`
    ).all(params.channelId, before, limit);

    sendJson(res, 200, {
      messages: rows.reverse().map(r => ({
        id: r.id, channelId: r.channel_id, content: r.content, createdAt: r.created_at,
        author: { id: r.user_id, username: r.username, displayName: r.display_name, avatarColor: r.avatar_color }
      }))
    });
  }));

  router.post('/api/channels/:channelId/messages', withAuth(async (req, res, params) => {
    const serverId = channelServerId(params.channelId);
    if (!serverId) return sendJson(res, 404, { error: 'Канал не найден' });
    if (!getMembership(serverId, req.user.id)) return sendJson(res, 403, { error: 'Нет доступа' });

    const body = await readJsonBody(req);
    const text = (body.content || '').toString().trim().slice(0, 4000);
    if (!text) return sendJson(res, 400, { error: 'Пустое сообщение' });

    const id = makeId();
    const createdAt = now();
    db.prepare('INSERT INTO messages (id, channel_id, user_id, content, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, params.channelId, req.user.id, text, createdAt);
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    const message = {
      id, channelId: params.channelId, content: text, createdAt,
      author: publicUser(u)
    };
    sendToUsers(serverMemberIds(serverId), 'message:new', message);
    sendJson(res, 200, { message });
  }));

  // ---------- DIRECT MESSAGES ----------

  router.get('/api/dm/threads', withAuth((req, res) => {
    const rows = db.prepare('SELECT * FROM dm_threads WHERE user_a = ? OR user_b = ?').all(req.user.id, req.user.id);
    const threads = rows.map(t => {
      const otherId = t.user_a === req.user.id ? t.user_b : t.user_a;
      const other = db.prepare('SELECT * FROM users WHERE id = ?').get(otherId);
      return { id: t.id, user: publicUser(other) };
    });
    sendJson(res, 200, { threads });
  }));

  router.post('/api/dm/threads', withAuth(async (req, res) => {
    const body = await readJsonBody(req);
    const other = db.prepare('SELECT * FROM users WHERE username = ?').get((body.username || '').trim());
    if (!other) return sendJson(res, 404, { error: 'Пользователь не найден' });
    if (other.id === req.user.id) return sendJson(res, 400, { error: 'Нельзя написать самому себе' });
    const thread = getOrCreateThread(req.user.id, other.id);
    sendJson(res, 200, { thread: { id: thread.id, user: publicUser(other) } });
  }));

  router.get('/api/dm/threads/:threadId/messages', withAuth((req, res, params) => {
    const thread = db.prepare('SELECT * FROM dm_threads WHERE id = ?').get(params.threadId);
    if (!thread || (thread.user_a !== req.user.id && thread.user_b !== req.user.id)) {
      return sendJson(res, 403, { error: 'Нет доступа' });
    }
    const url = new URL(req.url, 'http://x');
    const before = url.searchParams.get('before') ? Number(url.searchParams.get('before')) : now() + 1;
    const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 100);
    const rows = db.prepare(
      `SELECT dm.*, u.username, u.display_name, u.avatar_color FROM dm_messages dm
       JOIN users u ON u.id = dm.user_id
       WHERE dm.thread_id = ? AND dm.created_at < ?
       ORDER BY dm.created_at DESC LIMIT ?`
    ).all(params.threadId, before, limit);
    sendJson(res, 200, {
      messages: rows.reverse().map(r => ({
        id: r.id, threadId: r.thread_id, content: r.content, createdAt: r.created_at,
        author: { id: r.user_id, username: r.username, displayName: r.display_name, avatarColor: r.avatar_color }
      }))
    });
  }));

  router.post('/api/dm/threads/:threadId/messages', withAuth(async (req, res, params) => {
    const thread = db.prepare('SELECT * FROM dm_threads WHERE id = ?').get(params.threadId);
    if (!thread || (thread.user_a !== req.user.id && thread.user_b !== req.user.id)) {
      return sendJson(res, 403, { error: 'Нет доступа' });
    }
    const body = await readJsonBody(req);
    const text = (body.content || '').toString().trim().slice(0, 4000);
    if (!text) return sendJson(res, 400, { error: 'Пустое сообщение' });

    const id = makeId();
    const createdAt = now();
    db.prepare('INSERT INTO dm_messages (id, thread_id, user_id, content, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, params.threadId, req.user.id, text, createdAt);
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    const message = { id, threadId: params.threadId, content: text, createdAt, author: publicUser(u) };
    sendToUsers([thread.user_a, thread.user_b], 'dm:new', message);
    sendJson(res, 200, { message });
  }));

  // ---------- VOICE (WebRTC signaling relay) ----------

  router.post('/api/voice/:channelId/join', withAuth((req, res, params) => {
    const serverId = channelServerId(params.channelId);
    if (!serverId || !getMembership(serverId, req.user.id)) return sendJson(res, 403, { error: 'Нет доступа' });
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    const peerInfo = { username: u.username, displayName: u.display_name, avatarColor: u.avatar_color };
    const others = voiceJoin(params.channelId, req.user.id, peerInfo);
    sendToUsers(others.map(o => o.userId), 'voice:peer-joined', { channelId: params.channelId, userId: req.user.id, ...peerInfo });
    sendJson(res, 200, { peers: others });
  }));

  router.post('/api/voice/:channelId/leave', withAuth((req, res, params) => {
    voiceLeave(params.channelId, req.user.id);
    const peers = voicePeers(params.channelId);
    sendToUsers(peers.map(p => p.userId), 'voice:peer-left', { channelId: params.channelId, userId: req.user.id });
    sendJson(res, 200, { ok: true });
  }));

  router.post('/api/voice/signal', withAuth(async (req, res) => {
    const body = await readJsonBody(req);
    const { toUserId, data, channelId } = body || {};
    if (!toUserId || !data) return sendJson(res, 400, { error: 'Некорректные данные сигнала' });
    sendToUsers([toUserId], 'voice:signal', { fromUserId: req.user.id, channelId, data });
    sendJson(res, 200, { ok: true });
  }));

  // ---------- SSE realtime stream ----------

  router.get('/api/stream', (req, res) => {
    const url = new URL(req.url, 'http://x');
    const token = url.searchParams.get('token');
    const payload = verifyToken(token);
    if (!payload) return sendJson(res, 401, { error: 'Не авторизован' });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    addClient(payload.id, res);

    const keepAlive = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { /* ignore */ }
    }, 25000);

    req.on('close', () => {
      clearInterval(keepAlive);
      removeClient(payload.id, res);
      const leftChannels = voiceLeaveAll(payload.id);
      for (const channelId of leftChannels) {
        const peers = voicePeers(channelId);
        sendToUsers(peers.map(p => p.userId), 'voice:peer-left', { channelId, userId: payload.id });
      }
    });
  });

  return router;
}
