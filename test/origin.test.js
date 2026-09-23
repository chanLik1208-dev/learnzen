import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { freshDb, makeUser } from './helpers.js';
import { createApp } from '../server/app.js';
import { isSameOrigin } from '../server/http.js';

describe('isSameOrigin', () => {
  const req = (host) => ({ headers: { host } });

  test('accepts an origin naming this very host and port', () => {
    assert.equal(isSameOrigin('http://192.168.0.120:8787', req('192.168.0.120:8787')), true);
    assert.equal(isSameOrigin('http://localhost:8787', req('localhost:8787')), true);
    assert.equal(isSameOrigin('https://buddy.example', req('buddy.example')), true);
  });

  test('a different port or host is not the same origin', () => {
    assert.equal(isSameOrigin('http://192.168.0.120:5173', req('192.168.0.120:8787')), false);
    assert.equal(isSameOrigin('http://evil.example', req('localhost:8787')), false);
  });

  test('malformed input is refused, not thrown on', () => {
    assert.equal(isSameOrigin('not a url', req('localhost:8787')), false);
    assert.equal(isSameOrigin('http://x', { headers: {} }), false);
    assert.equal(isSameOrigin('null', req('localhost:8787')), false);
  });
});

describe('over HTTP', () => {
  let server, base, host;

  before(async () => {
    // A deliberately empty allow-list: nothing but same-origin should pass.
    server = createServer(createApp({ allowedOrigins: [], rateLimit: false }));
    await new Promise((r) => server.listen(0, r));
    host = `127.0.0.1:${server.address().port}`;
    base = `http://${host}`;
  });
  after(() => server.close());

  beforeEach(() => {
    freshDb();
    makeUser({ username: 'alice', password: 'pw-alice-123' });
  });

  const login = (origin) => fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
    body: JSON.stringify({ username: 'alice', password: 'pw-alice-123' }),
  });

  /**
   * The case that broke in the browser: the app was opened at the machine's
   * LAN address, which was not in the allow-list, so the server rejected its
   * own login form with "來源不被允許".
   */
  test('the server accepts the page it served itself, whatever address that is', async () => {
    assert.equal((await login(base)).status, 200);
  });

  test('a genuinely foreign origin is still refused', async () => {
    const res = await login('http://evil.example');
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error.code, 'BAD_ORIGIN');
  });

  test('a request with no Origin header is allowed, for non-browser clients', async () => {
    assert.equal((await login(undefined)).status, 200);
  });
});
