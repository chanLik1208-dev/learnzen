/**
 * Request rate limiting.
 *
 * This replaces the per-account lockout the login flow used to have. A lockout
 * keyed on the *username* is a denial-of-service handed to anyone who knows a
 * username: they lock the owner out on demand, and the owner cannot do
 * anything about it. So nothing here is ever keyed on a username alone.
 *
 * The keys are:
 *   - the client address, which bounds what one source can do; and
 *   - address + username, which stops one source grinding through passwords
 *     for a single account, while leaving that account perfectly usable from
 *     anywhere else.
 *
 * Counters live in memory and expire on their own, so a throttled client
 * recovers by waiting rather than by an administrator unlocking something.
 * A single process owns the whole API here; behind several processes this
 * would need shared storage, and the limits would otherwise be per-process.
 */

const buckets = new Map();
/** Temporary, staff-set adjustments to a policy. See the overrides section. */
const overrides = new Map();

/** Fixed windows: cheap, and the edge effect does not matter at these sizes. */
function hit(key, windowMs, max, now) {
  const found = buckets.get(key);
  if (!found || found.resetAt <= now) {
    const fresh = { count: 1, resetAt: now + windowMs };
    buckets.set(key, fresh);
    // The first request of a window still has to fit: a limit of 0 means
    // blocked, and must not leak one request through on a fresh bucket.
    return { allowed: max >= 1, remaining: Math.max(0, max - 1), resetAt: fresh.resetAt };
  }
  found.count += 1;
  return {
    allowed: found.count <= max,
    remaining: Math.max(0, max - found.count),
    resetAt: found.resetAt,
  };
}

export function consume(key, { windowMs, max }, now = Date.now()) {
  return hit(key, windowMs, max, now);
}

/** Give a point back, so a successful login does not spend the budget. */
export function refund(key) {
  const found = buckets.get(key);
  if (found && found.count > 0) found.count -= 1;
}

/**
 * Clear one counter, or — with no argument — everything, including temporary
 * adjustments. Leaving overrides behind on a full reset would let one caller's
 * adjustment quietly govern the next one.
 */
export function reset(key) {
  if (key !== undefined) { buckets.delete(key); return; }
  buckets.clear();
  overrides.clear();
}

export function sweep(now = Date.now()) {
  let removed = 0;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) { buckets.delete(key); removed += 1; }
  }
  return removed;
}

export const size = () => buckets.size;

// ------------------------------------------------------------------ policy --

const MINUTE = 60_000;

export const LIMITS = {
  // Credential attempts from one address. Generous enough that a person
  // fumbling a password never notices, tight enough that guessing is useless.
  login: { windowMs: 15 * MINUTE, max: 20 },
  // The same address grinding one account specifically.
  loginPerUser: { windowMs: 15 * MINUTE, max: 8 },
  // Rotation is automatic and frequent; this only catches a runaway client.
  refresh: { windowMs: 5 * MINUTE, max: 60 },
  // Password changes are rare and expensive to verify.
  password: { windowMs: 15 * MINUTE, max: 10 },
  write: { windowMs: 5 * MINUTE, max: 600 },
  read: { windowMs: 5 * MINUTE, max: 1500 },
};

/**
 * The client address. `X-Forwarded-For` is only believed when the deployment
 * says it sits behind a proxy — otherwise any client could set the header and
 * hand itself a fresh bucket per request, which is worse than no limiting.
 */
export function clientAddress(req, { trustProxy = process.env.LB_TRUST_PROXY === '1' } = {}) {
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length) {
      return forwarded.split(',')[0].trim();
    }
  }
  return req.socket?.remoteAddress ?? 'unknown';
}

// -------------------------------------------------------------- overrides --

/**
 * Temporary adjustments to a policy, set by staff and always time-bounded.
 *
 * These exist because a fixed per-address limit is wrong in a school: a whole
 * year group shares one public address, so thirty students signing in at the
 * start of a lesson look exactly like one machine guessing passwords. Rather
 * than loosening the limit for everyone forever, the limit for that address
 * can be raised for the afternoon — or tightened, if an address is misbehaving.
 *
 * An override that never expired would quietly become the real policy, so
 * there is no way to create one without an expiry.
 */

export const MAX_OVERRIDE_MS = 24 * 60 * 60 * 1000;

export function setOverride(key, { max, windowMs, expiresAt, reason = null, by = null }, now = Date.now()) {
  if (!key || typeof key !== 'string') throw new Error('需要 key');
  if (!Number.isFinite(max) || max < 0) throw new Error('max 必須是非負數字');
  if (!Number.isFinite(expiresAt) || expiresAt <= now) throw new Error('到期時間必須在未來');
  if (expiresAt - now > MAX_OVERRIDE_MS) throw new Error('最長只能設 24 小時');

  const entry = { key, max, windowMs: windowMs ?? null, expiresAt, reason, by, setAt: now };
  overrides.set(key, entry);
  return entry;
}

export function clearOverride(key) {
  return overrides.delete(key);
}

export function listOverrides(now = Date.now()) {
  const live = [];
  for (const [key, entry] of overrides) {
    if (entry.expiresAt <= now) overrides.delete(key);
    else live.push(entry);
  }
  return live;
}

/**
 * The override in force for a bucket, if any. An exact key wins over a
 * policy-wide one, so "everyone on this policy gets 200" can still be
 * overruled for a single address.
 */
function overrideFor(name, key, now) {
  for (const candidate of [key, `${name}:*`]) {
    const entry = overrides.get(candidate);
    if (!entry) continue;
    if (entry.expiresAt <= now) { overrides.delete(candidate); continue; }
    return entry;
  }
  return null;
}

/** Which policy applies to a request, and under which key. */
export function policyFor(method, pathname, address, now = Date.now()) {
  const base = (() => {
    if (pathname === '/api/auth/login') return { name: 'login', key: `login:${address}`, ...LIMITS.login };
    if (pathname === '/api/auth/refresh') return { name: 'refresh', key: `refresh:${address}`, ...LIMITS.refresh };
    if (pathname === '/api/auth/password') return { name: 'password', key: `password:${address}`, ...LIMITS.password };
    if (['GET', 'HEAD'].includes(method)) return { name: 'read', key: `read:${address}`, ...LIMITS.read };
    return { name: 'write', key: `write:${address}`, ...LIMITS.write };
  })();

  const applied = overrideFor(base.name, base.key, now);
  if (!applied) return base;
  return {
    ...base,
    max: applied.max,
    windowMs: applied.windowMs ?? base.windowMs,
    overridden: applied,
  };
}

/**
 * What is currently being counted. Used by the staff screen so a throttle can
 * be lifted by picking it off a list, rather than by typing a key blind.
 */
export function snapshot({ now = Date.now(), minCount = 1 } = {}) {
  const rows = [];
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now || bucket.count < minCount) continue;
    const [name] = key.split(':');
    const policy = LIMITS[name] ?? null;
    const applied = overrideFor(name, key, now);
    const max = applied?.max ?? policy?.max ?? null;
    rows.push({
      key,
      policy: name,
      count: bucket.count,
      max,
      resetAt: bucket.resetAt,
      throttled: max != null && bucket.count > max,
      overridden: applied != null,
    });
  }
  // Whatever is closest to being cut off matters most.
  return rows.sort((a, b) => (b.count / (b.max || 1)) - (a.count / (a.max || 1)));
}

export class RateLimitError extends Error {
  constructor(resetAt, now = Date.now()) {
    const seconds = Math.max(1, Math.ceil((resetAt - now) / 1000));
    super(`請求過於頻繁，請於 ${seconds} 秒後再試`);
    this.status = 429;
    this.code = 'RATE_LIMITED';
    this.retryAfter = seconds;
    this.resetAt = resetAt;
  }
}
