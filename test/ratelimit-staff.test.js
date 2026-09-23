import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { freshDb, makeUser } from './helpers.js';
import { createApp } from '../server/app.js';
import { login } from '../server/auth.js';
import { consume, reset, setOverride, policyFor, LIMITS } from '../server/ratelimit.js';

let server, base, tokens;

before(async () => {
  // The staff endpoints are the subject here, so the ambient throttle that
  // would otherwise cut these suites off is switched out of the way.
  server = createServer(createApp({ allowedOrigins: [], rateLimit: false }));
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

beforeEach(() => {
  freshDb();
  reset();
  makeUser({ username: 'alice', role: 'STUDENT', password: 'pw-alice-123' });
  makeUser({ username: 'chan', role: 'TEACHER', password: 'pw-chan-123' });
  makeUser({ username: 'root', role: 'ADMIN', password: 'pw-root-123' });
  tokens = {
    student: login('alice', 'pw-alice-123').accessToken,
    teacher: login('chan', 'pw-chan-123').accessToken,
    admin: login('root', 'pw-root-123').accessToken,
  };
});

async function call(method, path, { token, body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const KEY = 'login:10.0.0.9';

describe('who may touch throttling', () => {
  test('students reach none of it', async () => {
    for (const [m, p] of [
      ['GET', '/api/staff/ratelimit'],
      ['POST', '/api/staff/ratelimit/clear'],
      ['POST', '/api/staff/ratelimit/override'],
      ['GET', '/api/staff/ratelimit/audit'],
    ]) {
      const body = m === 'GET' ? undefined : {};
      assert.equal(
        (await call(m, p, { token: tokens.student, body })).status, 403, `${m} ${p}`,
      );
    }
  });

  test('an unauthenticated caller gets 401, not a listing', async () => {
    assert.equal((await call('GET', '/api/staff/ratelimit')).status, 401);
  });

  test('the listing tells the caller which powers they hold', async () => {
    const teacher = await call('GET', '/api/staff/ratelimit', { token: tokens.teacher });
    assert.deepEqual(teacher.body.data.may, { clear: true, relax: true, override: false });

    const admin = await call('GET', '/api/staff/ratelimit', { token: tokens.admin });
    assert.equal(admin.body.data.may.override, true);
  });
});

describe('lifting a throttle', () => {
  test('a throttled source shows up and can be lifted', async () => {
    for (let i = 0; i < LIMITS.login.max + 1; i += 1) consume(KEY, LIMITS.login);

    const listed = await call('GET', '/api/staff/ratelimit', { token: tokens.teacher });
    const row = listed.body.data.buckets.find((b) => b.key === KEY);
    assert.ok(row, '被擋住的來源要列出來，不用自己猜 key');
    assert.equal(row.throttled, true);

    const cleared = await call('POST', '/api/staff/ratelimit/clear', {
      token: tokens.teacher, body: { key: KEY, reason: '整班同時登入' },
    });
    assert.equal(cleared.status, 200);
    assert.equal(consume(KEY, LIMITS.login).allowed, true, '解除後立刻可用');
  });

  /** Unsticking someone is not the same as exempting them. */
  test('clearing does not raise the limit', async () => {
    for (let i = 0; i < LIMITS.login.max + 1; i += 1) consume(KEY, LIMITS.login);
    await call('POST', '/api/staff/ratelimit/clear', {
      token: tokens.teacher, body: { key: KEY, reason: 'x' },
    });

    for (let i = 0; i < LIMITS.login.max; i += 1) consume(KEY, LIMITS.login);
    assert.equal(consume(KEY, LIMITS.login).allowed, false, '額度用完照樣再擋');
  });

  test('an unrecognised key is refused rather than silently accepted', async () => {
    const res = await call('POST', '/api/staff/ratelimit/clear', {
      token: tokens.teacher, body: { key: 'nonsense:1.2.3.4' },
    });
    assert.equal(res.body.error.code, 'UNKNOWN_KEY');
  });

  test('repeated clearing is itself throttled', async () => {
    let last;
    for (let i = 0; i < 32; i += 1) {
      last = await call('POST', '/api/staff/ratelimit/clear', {
        token: tokens.teacher, body: { key: KEY, reason: 'x' },
      });
    }
    assert.equal(
      last.body.error.code, 'CLEAR_BUDGET_EXHAUSTED',
      '不能靠一直解除把節流變成暴力破解的幫浦',
    );
  });
});

describe('temporary adjustments, bounded by role', () => {
  test('a teacher may loosen a limit, and it takes effect', async () => {
    const res = await call('POST', '/api/staff/ratelimit/override', {
      token: tokens.teacher,
      body: { key: KEY, max: LIMITS.login.max * 5, minutes: 60, reason: '課堂登入' },
    });
    assert.equal(res.status, 200);
    assert.equal(policyFor('POST', '/api/auth/login', '10.0.0.9').max, LIMITS.login.max * 5);
  });

  test('a teacher may not tighten, block, over-loosen, or run it too long', async () => {
    const cases = [
      [{ max: 1, minutes: 60 }, 'TIGHTENING_NOT_ALLOWED'],
      [{ max: 0, minutes: 60 }, 'TIGHTENING_NOT_ALLOWED'],
      [{ max: LIMITS.login.max * 50, minutes: 60 }, 'TOO_LOOSE'],
      [{ max: LIMITS.login.max * 2, minutes: 60 * 12 }, 'TOO_LONG'],
    ];
    for (const [body, code] of cases) {
      const res = await call('POST', '/api/staff/ratelimit/override', {
        token: tokens.teacher, body: { key: KEY, reason: 'x', ...body },
      });
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(res.body.error.code, code);
    }
  });

  test('an administrator may tighten a source to zero', async () => {
    const res = await call('POST', '/api/staff/ratelimit/override', {
      token: tokens.admin, body: { key: KEY, max: 0, minutes: 60, reason: '疑似攻擊' },
    });
    assert.equal(res.status, 200);
    const policy = policyFor('POST', '/api/auth/login', '10.0.0.9');
    assert.equal(policy.max, 0);
    assert.equal(consume(KEY, policy).allowed, false);
  });

  test('an adjustment must say why', async () => {
    const res = await call('POST', '/api/staff/ratelimit/override', {
      token: tokens.admin, body: { key: KEY, max: 50, minutes: 60 },
    });
    assert.equal(res.body.error.code, 'REASON_REQUIRED');
  });

  /** An adjustment with no end date quietly becomes the real policy. */
  test('nobody, not even an administrator, can set one without an expiry', async () => {
    const res = await call('POST', '/api/staff/ratelimit/override', {
      token: tokens.admin, body: { key: KEY, max: 50, minutes: 60 * 48, reason: 'x' },
    });
    assert.equal(res.status, 400, '超過 24 小時不給設');
  });

  test('an expired adjustment stops applying on its own', () => {
    const now = Date.now();
    setOverride(KEY, { max: 999, expiresAt: now + 50, reason: 'x' }, now);
    assert.equal(policyFor('POST', '/api/auth/login', '10.0.0.9', now).max, 999);
    assert.equal(
      policyFor('POST', '/api/auth/login', '10.0.0.9', now + 100).max, LIMITS.login.max,
      '到期後自動回到原本的上限',
    );
  });

  test('an exact key beats a policy-wide one', () => {
    const now = Date.now();
    setOverride('login:*', { max: 100, expiresAt: now + 60_000, reason: 'x' }, now);
    setOverride(KEY, { max: 5, expiresAt: now + 60_000, reason: 'x' }, now);
    assert.equal(policyFor('POST', '/api/auth/login', '10.0.0.9', now).max, 5);
    assert.equal(policyFor('POST', '/api/auth/login', '10.0.0.1', now).max, 100);
  });

  test('an adjustment can be cancelled early', async () => {
    await call('POST', '/api/staff/ratelimit/override', {
      token: tokens.teacher, body: { key: KEY, max: LIMITS.login.max * 2, minutes: 30, reason: 'x' },
    });
    const removed = await call('DELETE', '/api/staff/ratelimit/override', {
      token: tokens.teacher, body: { key: KEY },
    });
    assert.equal(removed.status, 200);
    assert.equal(policyFor('POST', '/api/auth/login', '10.0.0.9').max, LIMITS.login.max);

    const again = await call('DELETE', '/api/staff/ratelimit/override', {
      token: tokens.teacher, body: { key: KEY },
    });
    assert.equal(again.status, 404);
  });
});

describe('the trail', () => {
  test('every action records who did it and why', async () => {
    await call('POST', '/api/staff/ratelimit/clear', {
      token: tokens.teacher, body: { key: KEY, reason: '整班卡住' },
    });
    await call('POST', '/api/staff/ratelimit/override', {
      token: tokens.admin, body: { key: KEY, max: 0, minutes: 30, reason: '封鎖' },
    });

    const log = await call('GET', '/api/staff/ratelimit/audit', { token: tokens.teacher });
    const actions = log.body.data.entries.map((e) => e.action);
    assert.ok(actions.includes('ratelimit.clear'));
    assert.ok(actions.includes('ratelimit.override'));

    const cleared = log.body.data.entries.find((e) => e.action === 'ratelimit.clear');
    assert.equal(cleared.actorUsername, 'chan');
    assert.equal(cleared.detail.reason, '整班卡住');

    const blocked = log.body.data.entries.find((e) => e.action === 'ratelimit.override');
    assert.equal(blocked.detail.to, 0);
    assert.equal(blocked.detail.from, LIMITS.login.max);
  });

  test('a teacher loosening is logged as a relax, not an override', async () => {
    await call('POST', '/api/staff/ratelimit/override', {
      token: tokens.teacher, body: { key: KEY, max: LIMITS.login.max * 2, minutes: 30, reason: 'x' },
    });
    const log = await call('GET', '/api/staff/ratelimit/audit', { token: tokens.teacher });
    assert.equal(log.body.data.entries[0].action, 'ratelimit.relax');
  });
});
