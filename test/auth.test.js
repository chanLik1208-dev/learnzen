import { test, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, makeUser } from './helpers.js';
import { run, get, now } from '../server/db.js';
import {
  login, AuthError, issueAccessToken, verifyAccessToken, issueRefreshToken,
  rotateRefreshToken, revokeFamily, changePassword, hashPassword, verifyPassword,
  pruneRefreshTokens, ACCESS_TTL_MS, REFRESH_TTL_MS,
} from '../server/auth.js';

let user;
beforeEach(() => {
  freshDb();
  user = makeUser({ username: 'alice', password: 'correct-horse' });
});

describe('passwords', () => {
  test('a hash verifies against its own password and nothing else', () => {
    const { hash, salt } = hashPassword('s3cret');
    assert.equal(verifyPassword('s3cret', hash, salt), true);
    assert.equal(verifyPassword('s3cret ', hash, salt), false);
    assert.equal(verifyPassword('', hash, salt), false);
  });

  test('the same password hashes differently for different users', () => {
    assert.notEqual(hashPassword('same').hash, hashPassword('same').hash);
  });
});

describe('login', () => {
  test('returns a session for the right password', () => {
    const out = login('alice', 'correct-horse');
    assert.equal(out.user.username, 'alice');
    assert.equal(out.user.role, 'STUDENT');
    assert.ok(out.accessToken);
    assert.ok(out.refresh.token);
    assert.equal(out.user.password_hash, undefined, '不應回傳密碼雜湊');
  });

  test('a wrong password and an unknown user give the same message', () => {
    const caught = (fn) => { try { fn(); } catch (e) { return e; } return null; };
    const a = caught(() => login('alice', 'nope'));
    const b = caught(() => login('nobody', 'nope'));
    assert.ok(a instanceof AuthError && b instanceof AuthError);
    assert.equal(a.message, b.message);
  });

  /**
   * Deliberately no lockout: throttling lives in the HTTP layer and is keyed
   * on where the attempts come from, so failed guesses can never take an
   * account away from the person who owns it.
   */
  test('repeated wrong passwords never lock the account out', () => {
    for (let i = 0; i < 25; i += 1) assert.throws(() => login('alice', 'wrong'));
    assert.equal(login('alice', 'correct-horse').user.username, 'alice');
  });

  test('a disabled account cannot log in', () => {
    run('UPDATE users SET status = ? WHERE id = ?', 'DISABLED', user.id);
    assert.throws(() => login('alice', 'correct-horse'), { code: 'DISABLED' });
  });
});

describe('access tokens', () => {
  test('a freshly issued token verifies', () => {
    const t = issueAccessToken(user);
    assert.equal(verifyAccessToken(t).id, user.id);
  });

  test('a tampered payload is rejected', () => {
    const t = issueAccessToken(user);
    const [body, mac] = t.split('.');
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    payload.role = 'ADMIN';
    const forged = `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${mac}`;
    assert.equal(verifyAccessToken(forged), null, '改了角色的 token 必須失效');
  });

  test('garbage is rejected without throwing', () => {
    for (const bad of ['', 'x', 'a.b', null, undefined, 'a.b.c']) {
      assert.equal(verifyAccessToken(bad), null);
    }
  });

  test('an expired token is rejected', () => {
    const t = issueAccessToken(user, now() - ACCESS_TTL_MS - 1000);
    assert.equal(verifyAccessToken(t), null);
  });

  test('the role comes from the database, not the token', () => {
    const t = issueAccessToken(user);
    run('UPDATE users SET role = ? WHERE id = ?', 'TEACHER', user.id);
    assert.equal(verifyAccessToken(t).role, 'TEACHER');
  });

  test('disabling an account invalidates its live tokens at once', () => {
    const t = issueAccessToken(user);
    run('UPDATE users SET status = ? WHERE id = ?', 'DISABLED', user.id);
    assert.equal(verifyAccessToken(t), null);
  });

  test('changing the password invalidates live tokens', () => {
    const t = issueAccessToken(user);
    changePassword(user.id, 'brand-new-password');
    assert.equal(verifyAccessToken(t), null);
  });
});

describe('refresh tokens', () => {
  test('rotating returns a new pair and retires the old token', () => {
    const first = issueRefreshToken(user.id);
    const out = rotateRefreshToken(first.token);
    assert.ok(out);
    assert.notEqual(out.refresh.token, first.token);
    assert.equal(out.refresh.familyId, first.familyId, '同一條連續會話屬於同一 family');
    assert.equal(verifyAccessToken(out.accessToken).id, user.id);
  });

  test('replaying a used token revokes the whole family', () => {
    const first = issueRefreshToken(user.id);
    const second = rotateRefreshToken(first.token);

    assert.equal(rotateRefreshToken(first.token), null, '舊 token 不可再用');
    assert.equal(rotateRefreshToken(second.refresh.token), null, '偵測到重放後整串作廢');
  });

  test('an expired token is rejected', () => {
    const t = issueRefreshToken(user.id, undefined, now() - REFRESH_TTL_MS - 1000);
    assert.equal(rotateRefreshToken(t.token), null);
  });

  test('a revoked family cannot refresh', () => {
    const t = issueRefreshToken(user.id);
    revokeFamily(t.familyId);
    assert.equal(rotateRefreshToken(t.token), null);
  });

  test('a token id with the wrong secret half is rejected', () => {
    const t = issueRefreshToken(user.id);
    const [id] = t.token.split('.');
    assert.equal(rotateRefreshToken(`${id}.wrong-secret`), null);
  });

  test('one user cannot refresh into another account', () => {
    const bob = makeUser({ username: 'bob' });
    const t = issueRefreshToken(bob.id);
    assert.equal(rotateRefreshToken(t.token).user.id, bob.id);
  });

  test('a disabled account cannot refresh', () => {
    const t = issueRefreshToken(user.id);
    run('UPDATE users SET status = ? WHERE id = ?', 'DISABLED', user.id);
    assert.equal(rotateRefreshToken(t.token), null);
  });

  test('changing the password revokes outstanding refresh tokens', () => {
    const t = issueRefreshToken(user.id);
    changePassword(user.id, 'another-one');
    assert.equal(rotateRefreshToken(t.token), null);
  });

  test('pruning removes expired rows and keeps live ones', () => {
    issueRefreshToken(user.id, undefined, now() - REFRESH_TTL_MS - 1000);
    const live = issueRefreshToken(user.id);
    assert.equal(pruneRefreshTokens(), 1);
    assert.ok(rotateRefreshToken(live.token));
  });
});
