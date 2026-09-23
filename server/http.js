/**
 * A small router with one opinion: a route cannot exist without declaring who
 * may call it. `route()` throws at startup if the permission is missing or is
 * not in the catalogue, so an unguarded endpoint fails the process rather than
 * quietly shipping. Opting out is possible but has to be spelled `PUBLIC`.
 */
import { verifyAccessToken } from './auth.js';
import {
  consume, refund, clientAddress, policyFor, LIMITS, RateLimitError,
} from './ratelimit.js';
import {
  ALL_PERMISSIONS, PUBLIC, requirePermission, UnauthorizedError, ForbiddenError,
} from './rbac.js';

const MAX_BODY_BYTES = 1 << 20; // 1 MiB

export class HttpError extends Error {
  constructor(status, message, code = 'ERROR') {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export const badRequest = (message, code = 'BAD_REQUEST') => new HttpError(400, message, code);
export const notFound = (message = '找不到資源') => new HttpError(404, message, 'NOT_FOUND');
export const conflict = (message, code = 'CONFLICT') => new HttpError(409, message, code);

const routes = [];

/** Compile `/api/assignments/:id` into a matcher plus its parameter names. */
function compile(path) {
  const names = [];
  const pattern = path
    .split('/')
    .map((seg) => {
      if (!seg.startsWith(':')) return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      names.push(seg.slice(1));
      return '([^/]+)';
    })
    .join('/');
  return { regex: new RegExp(`^${pattern}$`), names };
}

export function route(method, path, permission, handler) {
  if (permission !== PUBLIC && !ALL_PERMISSIONS.has(permission)) {
    throw new Error(
      `路由 ${method} ${path} 宣告了未知權限 ${String(permission)}；` +
      '請在 rbac.js 的 PERMISSIONS 加入它，或明確標示 PUBLIC。',
    );
  }
  routes.push({ method, permission, handler, ...compile(path), path });
}

export const routeTable = () => routes.map(({ method, path, permission }) => ({
  method, path, permission: permission === PUBLIC ? 'PUBLIC' : permission,
}));

function match(method, pathname) {
  let pathMatched = false;
  for (const r of routes) {
    const m = r.regex.exec(pathname);
    if (!m) continue;
    pathMatched = true;
    if (r.method !== method) continue;
    const params = Object.fromEntries(r.names.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
    return { route: r, params };
  }
  return pathMatched ? { methodNotAllowed: true } : null;
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw badRequest('請求內容過大', 'PAYLOAD_TOO_LARGE');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw badRequest('請求格式不是合法 JSON', 'BAD_JSON');
  }
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function send(res, status, payload, cookies = [], extra = {}) {
  const body = JSON.stringify(payload);
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'same-origin',
    ...extra,
  };
  if (cookies.length) headers['set-cookie'] = cookies;
  res.writeHead(status, headers);
  res.end(body);
}

export const ok = (data) => ({ success: true, data });

/**
 * Whether the Origin header names this very server.
 *
 * A page served from the same origin it is calling cannot be a cross-site
 * request, so it needs no allow-list entry. Checking this first is what lets
 * the server be reached at whatever address it happens to have — localhost,
 * a LAN address, a hostname — without someone having to enumerate them all in
 * configuration. Getting that wrong means the server refuses its own pages.
 */
export function isSameOrigin(origin, req) {
  const host = req.headers.host;
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function createHandler({ allowedOrigins = [], rateLimit = true } = {}) {
  return async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const found = match(req.method, url.pathname);

    // Throttle before routing, so a flood costs a Map lookup rather than a
    // database round trip — and so an unknown path cannot be used to bypass
    // the limit by never reaching a handler.
    const address = clientAddress(req);
    let policy = null;
    if (rateLimit) {
      policy = policyFor(req.method, url.pathname, address);
      const verdict = consume(policy.key, policy);
      if (!verdict.allowed) {
        const err = new RateLimitError(verdict.resetAt);
        return send(res, 429, {
          success: false, error: { code: err.code, message: err.message },
        }, [], { 'retry-after': String(err.retryAfter) });
      }
    }

    if (!found) return send(res, 404, { success: false, error: { code: 'NOT_FOUND', message: '找不到路由' } });
    if (found.methodNotAllowed) {
      return send(res, 405, { success: false, error: { code: 'METHOD_NOT_ALLOWED', message: '不支援的方法' } });
    }

    const cookies = [];
    const ctx = {
      req,
      res,
      params: found.params,
      query: url.searchParams,
      ip: req.socket.remoteAddress ?? null,
      cookies: parseCookies(req.headers.cookie ?? ''),
      setCookie: (c) => cookies.push(c),
      user: null,
      body: {},
    };

    try {
      // A state-changing request must come from an origin we recognise, so a
      // cookie-bearing form on another site cannot drive the API.
      if (!['GET', 'HEAD'].includes(req.method)) {
        const origin = req.headers.origin;
        if (origin && !isSameOrigin(origin, req) && !allowedOrigins.includes(origin)) {
          throw new HttpError(403, '來源不被允許', 'BAD_ORIGIN');
        }
      }

      const auth = req.headers.authorization ?? '';
      if (auth.startsWith('Bearer ')) ctx.user = verifyAccessToken(auth.slice(7).trim());

      if (found.route.permission !== PUBLIC) {
        if (!ctx.user) throw new UnauthorizedError();
        requirePermission(ctx.user, found.route.permission);
      }

      if (!['GET', 'HEAD'].includes(req.method)) ctx.body = await readBody(req);

      // One address grinding passwords for one account gets its own, tighter
      // budget. It is keyed on address *and* username, never username alone,
      // so it cannot be used to shut someone out of their own account.
      let userKey = null;
      if (rateLimit && policy?.name === 'login' && ctx.body?.username) {
        userKey = `login:${address}:${String(ctx.body.username).trim().toLowerCase()}`;
        const verdict = consume(userKey, LIMITS.loginPerUser);
        if (!verdict.allowed) {
          const err = new RateLimitError(verdict.resetAt);
          return send(res, 429, {
            success: false, error: { code: err.code, message: err.message },
          }, cookies, { 'retry-after': String(err.retryAfter) });
        }
      }

      const data = await found.route.handler(ctx);

      // A successful sign-in costs nothing: someone who mistypes twice and
      // then gets it right should not be closer to a lockout than before.
      if (userKey) { refund(userKey); refund(policy.key); }
      if (res.writableEnded) return undefined;
      return send(res, data === undefined ? 204 : 200, ok(data ?? null), cookies);
    } catch (err) {
      const status = Number.isInteger(err?.status) ? err.status : 500;
      if (status >= 500) console.error(`[${req.method} ${url.pathname}]`, err);
      return send(res, status, {
        success: false,
        error: {
          code: err?.code ?? 'INTERNAL',
          message: status >= 500 ? '伺服器發生錯誤' : err.message,
        },
      }, cookies);
    }
  };
}

export { PUBLIC, UnauthorizedError, ForbiddenError };
