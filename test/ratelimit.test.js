import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { freshDb, makeUser } from './helpers.js';
import { createApp } from '../server/app.js';
import {
  consume, refund, reset, sweep, size, clientAddress, policyFor, LIMITS,
} from '../server/ratelimit.js';

describe('the counter itself', () => {
  beforeEach(() => reset());

  test('allows up to the limit and refuses the next one', () => {
    const policy = { windowMs: 1000, max: 3 };
    for (let i = 0; i < 3; i += 1) assert.equal(consume('k', policy).allowed, true);
    assert.equal(consume('k', policy).allowed, false);
  });

  test('reports what is left and when it resets', () => {
    const now = 1_000_000;
    const first = consume('k', { windowMs: 5000, max: 2 }, now);
    assert.equal(first.remaining, 1);
    assert.equal(first.resetAt, now + 5000);
  });

  test('the window expires on its own, with no intervention', () => {
    const policy = { windowMs: 1000, max: 1 };
    assert.equal(consume('k', policy, 0).allowed, true);
    assert.equal(consume('k', policy, 500).allowed, false);
    assert.equal(consume('k', policy, 1001).allowed, true, '過了窗口自己恢復');
  });

  test('keys are independent', () => {
    const policy = { windowMs: 1000, max: 1 };
    consume('a', policy);
    assert.equal(consume('b', policy).allowed, true);
  });

  test('a refund gives the point back', () => {
    const policy = { windowMs: 1000, max: 2 };
    consume('k', policy);
    consume('k', policy);
    refund('k');
    assert.equal(consume('k', policy).allowed, true);
  });

  test('sweeping drops only expired buckets', () => {
    consume('old', { windowMs: 10, max: 1 }, 0);
    consume('live', { windowMs: 100_000, max: 1 }, 0);
    assert.equal(sweep(1000), 1);
    assert.equal(size(), 1);
  });
});

describe('client address', () => {
  const req = (headers, remote = '10.0.0.1') => ({ headers, socket: { remoteAddress: remote } });

  test('uses the socket address by default', () => {
    assert.equal(clientAddress(req({ 'x-forwarded-for': '1.2.3.4' }), { trustProxy: false }), '10.0.0.1');
  });

  /**
   * Believing the header unconditionally would let any client mint a fresh
   * bucket per request simply by varying it — worse than no limiting at all.
   */
  test('only believes x-forwarded-for when the deployment says to', () => {
    assert.equal(clientAddress(req({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8' }), { trustProxy: true }), '1.2.3.4');
  });

  test('copes with a missing address', () => {
    assert.equal(clientAddress({ headers: {}, socket: {} }, { trustProxy: false }), 'unknown');
  });
});

describe('policy selection', () => {
  test('login, refresh and password each get their own budget', () => {
    assert.equal(policyFor('POST', '/api/auth/login', 'ip').name, 'login');
    assert.equal(policyFor('POST', '/api/auth/refresh', 'ip').name, 'refresh');
    assert.equal(policyFor('POST', '/api/auth/password', 'ip').name, 'password');
  });

  test('reads and writes are separated', () => {
    assert.equal(policyFor('GET', '/api/topics', 'ip').name, 'read');
    assert.equal(policyFor('POST', '/api/practice/sessions', 'ip').name, 'write');
  });

  test('login is stricter than ordinary writes', () => {
    assert.ok(LIMITS.login.max < LIMITS.write.max);
    assert.ok(LIMITS.loginPerUser.max < LIMITS.login.max);
  });
});

// ------------------------------------------------------------ over HTTP --

describe('over HTTP', () => {
  let server, base;

  before(async () => {
    server = createServer(createApp({ allowedOrigins: [], rateLimit: true }));
    await new Promise((r) => server.listen(0, r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server.close());

  beforeEach(() => {
    freshDb();
    reset();
    makeUser({ username: 'alice', password: 'pw-alice-123' });
    makeUser({ username: 'bob', password: 'pw-bob-123' });
  });

  const post = async (path, body) => {
    const res = await fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    return { status: res.status, retryAfter: res.headers.get('retry-after'), body: await res.json() };
  };

  test('wrong passwords for one account are throttled with 429 and Retry-After', async () => {
    let last;
    for (let i = 0; i < LIMITS.loginPerUser.max + 1; i += 1) {
      last = await post('/api/auth/login', { username: 'alice', password: 'wrong' });
    }
    assert.equal(last.status, 429);
    assert.equal(last.body.error.code, 'RATE_LIMITED');
    assert.ok(Number(last.retryAfter) > 0, '必須告訴對方什麼時候可以再試');
  });

  /**
   * The property the old lockout did not have. Throttling one account from
   * one address must not take that account away from anyone else — otherwise
   * it is a denial-of-service anyone can trigger.
   */
  test('throttling one account does not affect another account', async () => {
    for (let i = 0; i < LIMITS.loginPerUser.max + 1; i += 1) {
      await post('/api/auth/login', { username: 'alice', password: 'wrong' });
    }
    const bob = await post('/api/auth/login', { username: 'bob', password: 'pw-bob-123' });
    assert.equal(bob.status, 200, 'bob 不該被 alice 的失敗連累');
  });

  test('a successful login is not charged against the budget', async () => {
    for (let i = 0; i < LIMITS.loginPerUser.max - 1; i += 1) {
      await post('/api/auth/login', { username: 'alice', password: 'wrong' });
      const ok = await post('/api/auth/login', { username: 'alice', password: 'pw-alice-123' });
      assert.equal(ok.status, 200);
    }
    // Having succeeded repeatedly, the account is still reachable.
    assert.equal((await post('/api/auth/login', { username: 'alice', password: 'pw-alice-123' })).status, 200);
  });

  test('the username is matched case-insensitively, so casing cannot dodge it', async () => {
    for (let i = 0; i < LIMITS.loginPerUser.max; i += 1) {
      await post('/api/auth/login', { username: 'alice', password: 'wrong' });
    }
    const dodge = await post('/api/auth/login', { username: 'ALICE', password: 'wrong' });
    assert.equal(dodge.status, 429);
  });

  test('an unknown route still consumes budget, so it is no bypass', async () => {
    const policy = { ...LIMITS.write };
    let seen429 = false;
    for (let i = 0; i < policy.max + 2; i += 1) {
      const res = await fetch(`${base}/api/does-not-exist`, { method: 'POST', body: '{}' });
      if (res.status === 429) { seen429 = true; break; }
    }
    assert.ok(seen429, '打不存在的路由也要被計數');
  });
});
