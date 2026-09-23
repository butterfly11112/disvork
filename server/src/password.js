import crypto from 'crypto';

// Password hashing using Node's built-in scrypt (no external deps needed).
// Format stored: scrypt$<saltHex>$<hashHex>

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  try {
    const [scheme, saltHex, hashHex] = stored.split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(password, salt, 64);
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
