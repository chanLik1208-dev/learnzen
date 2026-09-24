/**
 * The API client.
 *
 * The access token lives in memory only. Persistence is the refresh cookie's
 * job, and that cookie is httpOnly and scoped to /api/auth, so no script here
 * — or injected into this page — can read a long-lived credential.
 *
 * On a 401 the client refreshes once and replays the request. Several requests
 * failing at the same moment share a single refresh, so a page that fires five
 * calls on mount does not start five refreshes and trip the server's rotation
 * reuse detection, which would log the user out for doing nothing wrong.
 */
import { ref } from 'vue';

let accessToken = null;
let refreshing = null;

/** Set once the session is known invalid; the router sends the user to login. */
export const sessionExpired = ref(false);

export const setToken = (token) => { accessToken = token; sessionExpired.value = false; };
export const clearToken = () => { accessToken = null; };
export const hasToken = () => accessToken != null;
/**
 * Only for the event-stream client, which must put the token in a header
 * itself because EventSource cannot. Nothing else should read it.
 */
export const currentToken = () => accessToken;

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function send(method, path, body, { auth = true } = {}) {
  const res = await fetch(path, {
    method,
    headers: {
      ...(auth && accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });

  const text = await res.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }

  if (!res.ok) {
    throw new ApiError(
      res.status,
      payload?.error?.code ?? 'HTTP_ERROR',
      payload?.error?.message ?? `請求失敗（${res.status}）`,
    );
  }
  return payload?.data ?? null;
}

/** One refresh at a time, whoever asks first starts it. */
function refreshOnce() {
  refreshing ??= send('POST', '/api/auth/refresh', {}, { auth: false })
    .then((data) => { setToken(data.accessToken); return data.user; })
    .catch((err) => { clearToken(); sessionExpired.value = true; throw err; })
    .finally(() => { refreshing = null; });
  return refreshing;
}

async function request(method, path, body, options = {}) {
  try {
    return await send(method, path, body, options);
  } catch (err) {
    const canRetry = err instanceof ApiError
      && err.status === 401
      && options.auth !== false
      && !path.startsWith('/api/auth/refresh')
      && !options._retried;

    if (!canRetry) throw err;

    await refreshOnce();
    return send(method, path, body, { ...options, _retried: true });
  }
}

export const api = {
  get: (path, options) => request('GET', path, undefined, options),
  post: (path, body, options) => request('POST', path, body ?? {}, options),
  put: (path, body, options) => request('PUT', path, body ?? {}, options),
  patch: (path, body, options) => request('PATCH', path, body ?? {}, options),
  // DELETE carries a body here because some endpoints identify the thing to
  // remove by a key rather than by a path segment.
  del: (path, body, options) => request('DELETE', path, body ?? {}, options),
  refresh: refreshOnce,
};
