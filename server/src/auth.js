import crypto from 'crypto';

const SECRET = process.env.AUTH_SECRET || 'change-this-secret-in-production';
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function b64url(input) {
  return Buffer.from(input).toString('base64url');
}

// Simple signed token: base64url(json payload) + "." + base64url(hmac signature)
export function signToken(user) {
  const payload = { id: user.id, username: user.username, exp: Date.now() + TOKEN_TTL_MS };
  const payloadStr = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', SECRET).update(payloadStr).digest('base64url');
  return `${payloadStr}.${sig}`;
}

export function verifyToken(token) {
  try {
    const [payloadStr, sig] = (token || '').split('.');
    if (!payloadStr || !sig) return null;
    const expected = crypto.createHmac('sha256', SECRET).update(payloadStr).digest('base64url');
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(Buffer.from(payloadStr, 'base64url').toString());
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}
