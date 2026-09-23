import crypto from 'crypto';

export function makeId(bytes = 12) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function makeInviteCode() {
  return crypto.randomBytes(6).toString('base64url');
}
