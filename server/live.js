/**
 * The live quiz room: who is connected, and what everyone should be seeing.
 *
 * Broadcast is server-sent events rather than a WebSocket. A quiz is almost
 * entirely one-directional — the host advances, everyone else watches — and
 * answers are ordinary POSTs. SSE needs no dependency, survives a proxy that
 * would drop a socket upgrade, and reconnects by itself, which matters in a
 * classroom on school wi-fi.
 *
 * Connections are the only thing kept in memory. Every fact about the room is
 * in the database, so a restart mid-lesson resumes the room rather than
 * losing it; the clients simply reconnect and are told the current state.
 */
import { all, get, run, now } from './db.js';
import { correctLabelsFor, optionsFor } from './scoring.js';
import { serializeQuestion } from './serialize.js';

/**
 * sessionId -> Set of { res, userId, isHost }.
 *
 * Who each connection belongs to is kept, because part of every frame is
 * personal: whether *you* answered, and what it was worth. Sending one frame
 * to everyone meant nobody was ever told their own result.
 */
const rooms = new Map();

const KEEPALIVE_MS = 25_000;

export function subscribe(sessionId, res, { onClose, userId = null, isHost = false } = {}) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    // Nginx buffers event streams by default, which turns a live quiz into a
    // quiz that arrives all at once when it is over.
    'x-accel-buffering': 'no',
  });
  res.write(': connected\n\n');

  const entry = { res, userId, isHost };
  if (!rooms.has(sessionId)) rooms.set(sessionId, new Set());
  rooms.get(sessionId).add(entry);

  // Comment frames keep intermediaries from treating the connection as idle.
  const beat = setInterval(() => {
    try { res.write(': keepalive\n\n'); } catch { /* closing */ }
  }, KEEPALIVE_MS);

  const cleanup = () => {
    clearInterval(beat);
    rooms.get(sessionId)?.delete(entry);
    if (rooms.get(sessionId)?.size === 0) rooms.delete(sessionId);
    onClose?.();
  };
  res.on('close', cleanup);
  res.on('error', cleanup);
  return cleanup;
}

/**
 * Send one event to a room. `payload` may be a function, which is called per
 * connection with that connection's identity — that is how a frame carries
 * the recipient's own result without carrying anyone else's.
 */
export function publish(sessionId, event, payload, { hostsOnly = false } = {}) {
  const listeners = rooms.get(sessionId);
  if (!listeners) return 0;

  let sent = 0;
  for (const entry of listeners) {
    if (hostsOnly && !entry.isHost) continue;
    const body = typeof payload === 'function' ? payload(entry) : payload;
    if (body == null) continue;
    try {
      entry.res.write(`event: ${event}\ndata: ${JSON.stringify(body)}\n\n`);
      sent += 1;
    } catch {
      listeners.delete(entry);
    }
  }
  return sent;
}

export const connectionCount = (sessionId) => rooms.get(sessionId)?.size ?? 0;

export function closeRoom(sessionId) {
  for (const entry of rooms.get(sessionId) ?? []) {
    try { entry.res.end(); } catch { /* already gone */ }
  }
  rooms.delete(sessionId);
}

// ------------------------------------------------------------------ state --

/**
 * Faster answers are worth more, down to half marks at the buzzer. Getting it
 * right still matters far more than getting it early: the slowest correct
 * answer scores more than any wrong one, which is nil.
 */
export function scoreFor(isCorrect, elapsedMs, limitMs) {
  if (!isCorrect) return 0;
  const fraction = Math.max(0, Math.min(1, 1 - elapsedMs / limitMs));
  return Math.round(1000 * (0.5 + 0.5 * fraction));
}

export const currentQuestion = (session) => (session.current_seq == null ? null : get(
  `SELECT q.* FROM live_session_questions lq JOIN questions q ON q.id = lq.question_id
    WHERE lq.session_id = ? AND lq.seq = ?`,
  session.id, session.current_seq,
));

export const questionCount = (sessionId) => get(
  'SELECT COUNT(*) AS n FROM live_session_questions WHERE session_id = ?', sessionId,
).n;

export function leaderboard(sessionId, limit = 20) {
  return all(
    `SELECT u.id, u.display_name,
            COALESCE(SUM(a.points), 0) AS points,
            COUNT(a.user_id) AS answered,
            SUM(CASE WHEN a.is_correct = 1 THEN 1 ELSE 0 END) AS correct
       FROM live_participants p
       JOIN users u ON u.id = p.user_id
       LEFT JOIN live_answers a ON a.session_id = p.session_id AND a.user_id = p.user_id
      WHERE p.session_id = ?
      GROUP BY u.id
      ORDER BY points DESC, correct DESC, u.display_name
      LIMIT ?`,
    sessionId, limit,
  ).map((r, i) => ({
    rank: i + 1,
    userId: r.id,
    displayName: r.display_name,
    points: r.points,
    answered: r.answered,
    correct: r.correct ?? 0,
  }));
}

/** How the current question is going, without saying who chose what. */
export function liveTally(session) {
  const question = currentQuestion(session);
  if (!question) return null;

  const answered = get(
    'SELECT COUNT(*) AS n FROM live_answers WHERE session_id = ? AND question_id = ?',
    session.id, question.id,
  ).n;
  return {
    questionId: question.id,
    answered,
    participants: get(
      'SELECT COUNT(*) AS n FROM live_participants WHERE session_id = ?', session.id,
    ).n,
  };
}

/** The distribution, which is only meaningful — and only shown — after reveal. */
export function breakdown(session) {
  const question = currentQuestion(session);
  if (!question) return null;

  const counts = new Map(all(
    `SELECT chosen, COUNT(*) AS n FROM live_answers
      WHERE session_id = ? AND question_id = ? GROUP BY chosen`,
    session.id, question.id,
  ).map((r) => [r.chosen, r.n]));

  return {
    questionId: question.id,
    correctLabels: correctLabelsFor(question.id),
    options: optionsFor(question.id).map((o) => ({
      label: o.label,
      content: o.content_zh,
      isCorrect: o.is_correct === 1,
      count: counts.get(o.label) ?? 0,
    })),
  };
}

/**
 * What a client should render right now.
 *
 * The same function answers both "I just connected" and "something changed",
 * so a reconnecting student cannot end up on a different screen from everyone
 * else. `forHost` is the only thing that varies: a student is never sent the
 * answer key while the question is still open.
 */
export function snapshotFor(session, { forHost = false, userId = null } = {}) {
  const question = currentQuestion(session);
  const revealed = session.status === 'REVEAL';

  const base = {
    sessionId: session.id,
    code: session.code,
    title: session.title,
    status: session.status,
    seq: session.current_seq,
    questionCount: questionCount(session.id),
    seconds: session.seconds,
    serverTime: now(),
    participants: get(
      'SELECT COUNT(*) AS n FROM live_participants WHERE session_id = ?', session.id,
    ).n,
  };

  if (!question) {
    return {
      ...base,
      question: null,
      leaderboard: session.status === 'ENDED' ? leaderboard(session.id) : [],
    };
  }

  return {
    ...base,
    // Absolute instant, like everywhere else, so a drifting clock cannot buy
    // anyone extra seconds.
    deadlineAt: session.asked_at + session.seconds * 1000,
    question: serializeQuestion(question, { withAnswer: revealed }),
    myAnswer: userId == null ? null : get(
      'SELECT chosen, is_correct, points FROM live_answers WHERE session_id = ? AND question_id = ? AND user_id = ?',
      session.id, question.id, userId,
    ) ?? null,
    tally: forHost || revealed ? liveTally(session) : null,
    breakdown: revealed ? breakdown(session) : null,
    leaderboard: revealed || session.status === 'ENDED' ? leaderboard(session.id) : [],
  };
}

/**
 * Tell everyone what changed. Each connection gets a frame built for it, so a
 * student is told their own result and nobody else's, and the host gets the
 * host view.
 */
export function broadcastState(session) {
  publish(session.id, 'state', ({ userId, isHost }) => (isHost
    ? null
    : snapshotFor(session, { forHost: false, userId })));
  publish(session.id, 'host', () => snapshotFor(session, { forHost: true }), { hostsOnly: true });
}

export function generateCode() {
  // No O/0/I/1: these get read aloud and typed in by thirty people at once.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const code = Array.from({ length: 5 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
    if (!get("SELECT 1 AS hit FROM live_sessions WHERE code = ? AND status <> 'ENDED'", code)) {
      return code;
    }
  }
  throw new Error('無法產生房間代碼');
}

export { run };
