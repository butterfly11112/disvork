// Realtime event bus over Server-Sent Events (no external deps).
// Maps userId -> Set of open SSE response streams (multiple tabs/devices allowed).

const clients = new Map();

export function addClient(userId, res) {
  if (!clients.has(userId)) clients.set(userId, new Set());
  clients.get(userId).add(res);
}

export function removeClient(userId, res) {
  const set = clients.get(userId);
  if (!set) return;
  set.delete(res);
  if (set.size === 0) clients.delete(userId);
}

function writeEvent(res, event, data) {
  try {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  } catch {
    // ignore broken pipe; disconnect handler will clean up
  }
}

export function sendToUser(userId, event, data) {
  const set = clients.get(userId);
  if (!set) return;
  for (const res of set) writeEvent(res, event, data);
}

export function sendToUsers(userIds, event, data) {
  for (const id of userIds) sendToUser(id, event, data);
}

export function isOnline(userId) {
  return clients.has(userId);
}

// ---- Voice presence: channelId -> Map<userId, peerInfo> ----
const voiceRooms = new Map();

export function voiceJoin(channelId, userId, peerInfo) {
  if (!voiceRooms.has(channelId)) voiceRooms.set(channelId, new Map());
  const room = voiceRooms.get(channelId);
  const others = [...room.entries()].map(([uid, info]) => ({ userId: uid, ...info }));
  room.set(userId, peerInfo);
  return others;
}

export function voiceLeave(channelId, userId) {
  const room = voiceRooms.get(channelId);
  if (!room) return;
  room.delete(userId);
  if (room.size === 0) voiceRooms.delete(channelId);
}

export function voiceLeaveAll(userId) {
  const left = [];
  for (const [channelId, room] of voiceRooms.entries()) {
    if (room.has(userId)) {
      room.delete(userId);
      left.push(channelId);
      if (room.size === 0) voiceRooms.delete(channelId);
    }
  }
  return left;
}

export function voicePeers(channelId) {
  const room = voiceRooms.get(channelId);
  if (!room) return [];
  return [...room.entries()].map(([uid, info]) => ({ userId: uid, ...info }));
}
