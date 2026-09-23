import { route, PUBLIC, ok, badRequest, HttpError } from '../http.js';
import { audit, get, tx } from '../db.js';
import {
  login, publicUser, rotateRefreshToken, revokeFamily, changePassword,
  verifyPassword, listSessions, REFRESH_TTL_MS,
} from '../auth.js';

const COOKIE = 'lb_rt';
const secure = process.env.NODE_ENV === 'production';

/**
 * The refresh token lives in an httpOnly, SameSite=Strict cookie scoped to
 * /api/auth. Page scripts cannot read it, and it is never attached to any
 * other endpoint, so a leak in one API response cannot carry a session away.
 */
const setRefreshCookie = (ctx, token) => ctx.setCookie(
  `${COOKIE}=${encodeURIComponent(token)}; Path=/api/auth; HttpOnly; SameSite=Strict; Max-Age=${
    Math.floor(REFRESH_TTL_MS / 1000)}${secure ? '; Secure' : ''}`,
);

const clearRefreshCookie = (ctx) => ctx.setCookie(
  `${COOKIE}=; Path=/api/auth; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`,
);

route('POST', '/api/auth/login', PUBLIC, (ctx) => {
  const { username, password } = ctx.body ?? {};
  if (!username || !password) throw badRequest('請輸入帳號與密碼');

  const session = login(username, password);
  setRefreshCookie(ctx, session.refresh.token);
  audit({ actorId: session.user.id, action: 'auth.login', ip: ctx.ip });
  return { user: session.user, accessToken: session.accessToken };
});

/**
 * Exchanges the cookie for a new access token. Returning 401 (rather than an
 * error the client retries) is what lets the front end fall back to the login
 * screen exactly once instead of looping.
 */
route('POST', '/api/auth/refresh', PUBLIC, (ctx) => {
  const token = ctx.cookies[COOKIE];
  if (!token) throw new HttpError(401, '尚未登入', 'NO_REFRESH_TOKEN');

  const rotated = rotateRefreshToken(token);
  if (!rotated) {
    clearRefreshCookie(ctx);
    throw new HttpError(401, '登入狀態已失效，請重新登入', 'REFRESH_REJECTED');
  }
  setRefreshCookie(ctx, rotated.refresh.token);
  return { user: publicUser(rotated.user), accessToken: rotated.accessToken };
});

route('POST', '/api/auth/logout', PUBLIC, (ctx) => {
  const token = ctx.cookies[COOKIE];
  if (token) {
    const row = get('SELECT family_id, user_id FROM refresh_tokens WHERE id = ?', token.split('.')[0]);
    if (row) {
      revokeFamily(row.family_id);
      audit({ actorId: row.user_id, action: 'auth.logout', ip: ctx.ip });
    }
  }
  clearRefreshCookie(ctx);
  return { loggedOut: true };
});

route('GET', '/api/auth/me', 'self.read', (ctx) => ({ user: publicUser(ctx.user) }));

route('POST', '/api/auth/password', 'self.password.change', (ctx) => {
  const { currentPassword, newPassword } = ctx.body ?? {};
  if (!currentPassword || !newPassword) throw badRequest('請輸入目前密碼與新密碼');
  if (String(newPassword).length < 8) throw badRequest('新密碼至少 8 個字元', 'WEAK_PASSWORD');

  const row = get('SELECT password_hash, password_salt FROM users WHERE id = ?', ctx.user.id);
  if (!verifyPassword(String(currentPassword), row.password_hash, row.password_salt)) {
    throw new HttpError(403, '目前密碼不正確', 'WRONG_PASSWORD');
  }

  tx(() => changePassword(ctx.user.id, String(newPassword)));
  clearRefreshCookie(ctx);
  audit({ actorId: ctx.user.id, action: 'auth.password_changed', ip: ctx.ip });
  // Every session, including this one, is now invalid by design.
  return { changed: true, mustLogInAgain: true };
});

route('GET', '/api/auth/sessions', 'self.sessions.manage', (ctx) => ({
  sessions: listSessions(ctx.user.id).map((s) => ({
    familyId: s.family_id,
    issuedAt: s.issued_at,
    expiresAt: s.expires_at,
    active: s.revoked_at == null && s.used_at == null && s.expires_at > Date.now(),
  })),
}));

export { ok };
