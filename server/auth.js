/**
 * Passwords, access tokens and rotating refresh tokens.
 *
 * Two properties matter here and are worth stating plainly, because the
 * original app got both wrong: an access token carries the user's identity
 * *and* a token epoch, so disabling an account or changing a password kills
 * every live session immediately; and refresh tokens rotate within a family,
 * so replaying an old one revokes the whole family instead of handing out a
 * fresh session to whoever stole it.
 */
import {
  randomBytes, scryptSync, timingSafeEqual, createHmac, createHash, randomUUID,
} from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { all, get, run, now, audit } from './db.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export const ACCESS_TTL_MS = 15 * 60 * 1000;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

let secret = null;

/** HMAC key for access tokens. Persisted so restarts don't log everyone out. */
export function getSecret() {
  if (secret) return secret;
  if (process.env.LB_SECRET) return (secret = Buffer.from(process.env.LB_SECRET, 'utf8'));
  const file = join(root, 'data', '.secret');
  if (existsSync(file)) return (secret = Buffer.from(readFileSync(file, 'utf8').trim(), 'hex'));
  mkdirSync(dirname(file), { recursive: true });
  const generated = randomBytes(32);
  writeFileSync(file, generated.toString('hex'), { mode: 0o600 });
  return (secret = generated);
}

export function resetSecretCache() { secret = null; }

// ------------------------------------------------------------- passwords --

export function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  return { hash: scryptSync(password, salt, 64).toString('hex'), salt };
}

export function verifyPassword(password, hash, salt) {
  const candidate = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}

// ---------------------------------------------------------- access tokens --

const b64 = (buf) => Buffer.from(buf).toString('base64url');

function sign(payloadJson) {
  return createHmac('sha256', getSecret()).update(payloadJson).digest('base64url');
}

export function issueAccessToken(user, at = now()) {
  const payload = JSON.stringify({
    sub: user.id, role: user.role, epoch: user.token_epoch,
    iat: at, exp: at + ACCESS_TTL_MS,
  });
  return `${b64(payload)}.${sign(payload)}`;
}

/**
 * Verify an access token and re-check the user against the database. The
 * token alone is never enough: a disabled account or a bumped epoch is
 * rejected even while the signature is still valid and unexpired.
 */
export function verifyAccessToken(token, at = now()) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, mac] = token.split('.');
  let payloadJson;
  try {
    payloadJson = Buffer.from(body, 'base64url').toString('utf8');
  } catch { return null; }

  const expected = Buffer.from(sign(payloadJson), 'utf8');
  const actual = Buffer.from(mac ?? '', 'utf8');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;

  let payload;
  try { payload = JSON.parse(payloadJson); } catch { return null; }
  if (typeof payload.exp !== 'number' || payload.exp < at) return null;

  const user = get(
    'SELECT id, username, display_name, role, class_id, status, token_epoch FROM users WHERE id = ?',
    payload.sub,
  );
  if (!user || user.status !== 'ACTIVE') return null;
  if (user.token_epoch !== payload.epoch) return null;
  // The role comes from the row, not the token, so a role change takes effect
  // on the next request rather than at the next login.
  return user;
}

// --------------------------------------------------------- refresh tokens --

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

export function issueRefreshToken(userId, familyId = randomUUID(), at = now()) {
  const id = randomUUID();
  const secretHalf = randomBytes(32).toString('base64url');
  run(
    `INSERT INTO refresh_tokens (id, user_id, token_hash, family_id, issued_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    id, userId, sha256(secretHalf), familyId, at, at + REFRESH_TTL_MS,
  );
  return { token: `${id}.${secretHalf}`, familyId, expiresAt: at + REFRESH_TTL_MS };
}

export function revokeFamily(familyId, at = now()) {
  run('UPDATE refresh_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL', at, familyId);
}

export function revokeAllForUser(userId, at = now()) {
  run('UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', at, userId);
}

/**
 * Exchange a refresh token for a new pair. Returns null on any failure.
 * Presenting a token that was already used is treated as theft: the entire
 * family is revoked, which logs out both the attacker and the real user
 * rather than letting the two sessions run side by side.
 */
export function rotateRefreshToken(token, at = now()) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [id, secretHalf] = token.split('.');
  const row = get('SELECT * FROM refresh_tokens WHERE id = ?', id);
  if (!row) return null;

  const expected = Buffer.from(row.token_hash, 'utf8');
  const actual = Buffer.from(sha256(secretHalf ?? ''), 'utf8');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;

  if (row.used_at != null) {
    revokeFamily(row.family_id, at);
    audit({ actorId: row.user_id, action: 'refresh.reuse_detected', target: `family:${row.family_id}` });
    return null;
  }
  if (row.revoked_at != null || row.expires_at < at) return null;

  const user = get(
    'SELECT id, username, display_name, role, class_id, status, token_epoch FROM users WHERE id = ?',
    row.user_id,
  );
  if (!user || user.status !== 'ACTIVE') return null;

  run('UPDATE refresh_tokens SET used_at = ? WHERE id = ?', at, id);
  const next = issueRefreshToken(user.id, row.family_id, at);
  return { user, accessToken: issueAccessToken(user, at), refresh: next };
}

/** Drop expired and long-revoked rows so the table does not grow forever. */
export function pruneRefreshTokens(at = now()) {
  const cutoff = at - REFRESH_TTL_MS;
  return run(
    'DELETE FROM refresh_tokens WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)',
    at, cutoff,
  ).changes;
}

// ----------------------------------------------------------------- login --

export class AuthError extends Error {
  constructor(message, code = 'AUTH_FAILED', status = 401) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/**
 * Check credentials.
 *
 * Repeated failures are throttled by `ratelimit.js`, keyed on where the
 * attempts come from — deliberately not by locking the account. A lockout
 * keyed on the username lets anyone who knows a username lock its owner out
 * at will, which turns a brute-force defence into a denial-of-service tool.
 *
 * A wrong password and an unknown username produce the same error, so the
 * form cannot be used to enumerate accounts.
 */
export function login(username, password, at = now()) {
  const generic = new AuthError('帳號或密碼不正確');
  const user = get('SELECT * FROM users WHERE username = ?', String(username ?? '').trim());
  if (!user) {
    // Spend comparable time so a missing user is not detectably faster.
    hashPassword(String(password ?? ''));
    throw generic;
  }
  if (!verifyPassword(String(password ?? ''), user.password_hash, user.password_salt)) {
    throw generic;
  }
  if (user.status !== 'ACTIVE') throw new AuthError('帳號已停用', 'DISABLED', 403);

  return {
    user: publicUser(user),
    accessToken: issueAccessToken(user, at),
    refresh: issueRefreshToken(user.id, undefined, at),
  };
}

export function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    role: user.role,
    classId: user.class_id,
  };
}

/** Change a password and invalidate every existing session for that user. */
export function changePassword(userId, newPassword, at = now()) {
  const { hash, salt } = hashPassword(newPassword);
  run(
    `UPDATE users SET password_hash = ?, password_salt = ?, token_epoch = token_epoch + 1,
                      updated_at = ?
      WHERE id = ?`,
    hash, salt, at, userId,
  );
  revokeAllForUser(userId, at);
}

export function listSessions(userId) {
  return all(
    'SELECT id, family_id, issued_at, expires_at, used_at, revoked_at FROM refresh_tokens WHERE user_id = ? ORDER BY issued_at DESC',
    userId,
  );
}
