import { route, badRequest, notFound } from '../http.js';
import { audit, all } from '../db.js';
import { can } from '../rbac.js';
import {
  snapshot, listOverrides, setOverride, clearOverride, reset, consume,
  LIMITS, MAX_OVERRIDE_MS,
} from '../ratelimit.js';

/**
 * Staff controls for throttling.
 *
 * Two separate powers, because they are not the same act:
 *
 *   relax    — let people back in. A class shares one public address, so
 *              thirty students signing in together look like one machine
 *              guessing passwords. Teachers need to fix that themselves,
 *              within bounds, without waiting for an administrator.
 *   override — change a limit to anything, including zero, which shuts an
 *              address out entirely. That is an administrator's decision.
 *
 * Every action is written to the audit log with who did it and why, because
 * lifting a throttle is exactly what someone running a password attack would
 * want to do, and the record is what makes that visible afterwards.
 */

const RELAX_MAX_MS = 4 * 60 * 60 * 1000;
const RELAX_MAX_FACTOR = 10;
/** A teacher clearing throttles over and over is itself worth throttling. */
const CLEAR_BUDGET = { windowMs: 60 * 60 * 1000, max: 30 };

const basePolicyOf = (key) => LIMITS[String(key).split(':')[0]] ?? null;

route('GET', '/api/staff/ratelimit', 'ratelimit.read', (ctx) => ({
  // Only buckets with something in them; an idle address is not interesting.
  buckets: snapshot({ minCount: 1 }).slice(0, 100),
  overrides: listOverrides(),
  policies: LIMITS,
  /** What this caller is allowed to do, so the UI does not offer the rest. */
  may: {
    clear: can(ctx.user, 'ratelimit.clear'),
    relax: can(ctx.user, 'ratelimit.relax'),
    override: can(ctx.user, 'ratelimit.override'),
  },
  limits: {
    relaxMaxHours: RELAX_MAX_MS / 3_600_000,
    relaxMaxFactor: RELAX_MAX_FACTOR,
    overrideMaxHours: MAX_OVERRIDE_MS / 3_600_000,
  },
}));

/**
 * Lift one throttle. The limit itself is untouched, so the same address hits
 * it again on the next burst — this unsticks someone, it does not exempt them.
 */
route('POST', '/api/staff/ratelimit/clear', 'ratelimit.clear', (ctx) => {
  const key = String(ctx.body?.key ?? '').trim();
  if (!key) throw badRequest('請指定要解除的項目');
  if (!basePolicyOf(key)) throw badRequest('不認得這個項目', 'UNKNOWN_KEY');

  const budget = consume(`staff-clear:${ctx.user.id}`, CLEAR_BUDGET);
  if (!budget.allowed) {
    throw badRequest('解除次數過多，請稍後再試', 'CLEAR_BUDGET_EXHAUSTED');
  }

  reset(key);
  audit({
    actorId: ctx.user.id, action: 'ratelimit.clear', target: key, ip: ctx.ip,
    detail: { reason: ctx.body?.reason ?? null },
  });
  return { cleared: key, clearsLeftThisHour: budget.remaining };
});

/**
 * Raise a limit for a while. A teacher may only loosen, only by so much, and
 * only for so long; an administrator may set anything, including a limit of
 * zero. Both land in the same store — the difference is what each is allowed
 * to ask for, checked here rather than trusted from the request.
 */
route('POST', '/api/staff/ratelimit/override', 'ratelimit.relax', (ctx) => {
  const key = String(ctx.body?.key ?? '').trim();
  const max = Number(ctx.body?.max);
  const minutes = Number(ctx.body?.minutes);
  const reason = String(ctx.body?.reason ?? '').trim();

  if (!key) throw badRequest('請指定要調整的項目');
  const base = basePolicyOf(key);
  if (!base) throw badRequest('不認得這個項目', 'UNKNOWN_KEY');
  if (!Number.isFinite(max) || max < 0) throw badRequest('上限必須是非負數字');
  if (!Number.isFinite(minutes) || minutes <= 0) throw badRequest('請指定有效時間');
  if (!reason) throw badRequest('請填寫原因', 'REASON_REQUIRED');

  const elevated = can(ctx.user, 'ratelimit.override');
  if (!elevated) {
    if (max < base.max) {
      throw badRequest('只有管理員可以調低上限或封鎖來源', 'TIGHTENING_NOT_ALLOWED');
    }
    if (max > base.max * RELAX_MAX_FACTOR) {
      throw badRequest(`最多只能放寬到原本的 ${RELAX_MAX_FACTOR} 倍（${base.max * RELAX_MAX_FACTOR}）`, 'TOO_LOOSE');
    }
    if (minutes * 60_000 > RELAX_MAX_MS) {
      throw badRequest(`最長只能設 ${RELAX_MAX_MS / 3_600_000} 小時`, 'TOO_LONG');
    }
  }

  const now = Date.now();
  let entry;
  try {
    entry = setOverride(key, {
      max, expiresAt: now + minutes * 60_000, reason, by: ctx.user.id,
    }, now);
  } catch (err) {
    throw badRequest(err.message);
  }

  audit({
    actorId: ctx.user.id,
    action: elevated ? 'ratelimit.override' : 'ratelimit.relax',
    target: key, ip: ctx.ip,
    detail: { from: base.max, to: max, minutes, reason },
  });
  return { override: entry };
});

route('DELETE', '/api/staff/ratelimit/override', 'ratelimit.relax', (ctx) => {
  const key = String(ctx.body?.key ?? '').trim();
  if (!key) throw badRequest('請指定要取消的項目');
  if (!clearOverride(key)) throw notFound('沒有這個臨時設定');

  audit({ actorId: ctx.user.id, action: 'ratelimit.override_removed', target: key, ip: ctx.ip });
  return { removed: key };
});

/** The trail of who touched throttling, so a lifted limit is never silent. */
route('GET', '/api/staff/ratelimit/audit', 'ratelimit.read', (ctx) => ({
  entries: all(
    `SELECT a.*, u.display_name, u.username FROM audit_log a
       LEFT JOIN users u ON u.id = a.actor_id
      WHERE a.action LIKE 'ratelimit.%'
      ORDER BY a.at DESC LIMIT ?`,
    Math.min(Number(ctx.query.get('limit')) || 50, 200),
  ).map((r) => ({
    at: r.at,
    action: r.action,
    target: r.target,
    actor: r.display_name ?? '（已刪除）',
    actorUsername: r.username ?? null,
    detail: r.detail ? JSON.parse(r.detail) : null,
  })),
}));
