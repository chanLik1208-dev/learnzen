import { route, badRequest, notFound, conflict, STREAM, HttpError } from '../http.js';
import { all, get, run, tx, now, audit } from '../db.js';
import { assertTeachesClass, ForbiddenError } from '../rbac.js';
import { normalizeChosen, grade } from '../scoring.js';
import {
  subscribe, publish, closeRoom, connectionCount, snapshotFor, broadcastState,
  currentQuestion, questionCount, leaderboard, scoreFor, generateCode,
} from '../live.js';

/**
 * Running a quiz in front of a class.
 *
 * The host advances; everyone else answers what is on screen. Two things are
 * deliberately not negotiable, for the same reason they are not elsewhere in
 * this codebase: the deadline is the server's, computed from when the question
 * actually went up, and the marking is the server's. A client that reports
 * its own time or its own correctness is ignored.
 */

const MAX_QUESTIONS = 50;

/** Load a room the caller is hosting, or refuse. */
function hosted(ctx, id) {
  const session = get('SELECT * FROM live_sessions WHERE id = ?', Number(id));
  if (!session) throw notFound('找不到房間');
  if (session.host_id !== ctx.user.id && ctx.user.role !== 'ADMIN') {
    throw new ForbiddenError('這不是你主持的房間');
  }
  return session;
}

/** Load a room by its join code, only while it is still running. */
function openRoom(code) {
  const session = get(
    "SELECT * FROM live_sessions WHERE code = ? AND status <> 'ENDED'",
    String(code ?? '').trim().toUpperCase(),
  );
  if (!session) throw notFound('找不到這個房間，或它已經結束');
  return session;
}

// ------------------------------------------------------------------- host --

route('POST', '/api/teacher/live', 'live.host', (ctx) => {
  const b = ctx.body ?? {};
  const title = String(b.title ?? '').trim() || '即時測驗';
  const classId = b.classId == null ? null : assertTeachesClass(ctx.user, b.classId);
  const seconds = Math.min(Math.max(Number(b.seconds) || 30, 5), 300);

  const ids = [...new Set((Array.isArray(b.questionIds) ? b.questionIds : []).map(Number))]
    .filter(Number.isInteger)
    .slice(0, MAX_QUESTIONS);
  if (ids.length === 0) throw badRequest('請至少選一題', 'NO_QUESTIONS');

  // Same rule as a paper: a question with no key cannot be marked, so it can
  // never be put in front of anyone.
  const unmarkable = ids.filter((id) => !get(
    'SELECT 1 AS ok FROM question_options WHERE question_id = ? AND is_correct = 1', id,
  ));
  if (unmarkable.length) {
    throw badRequest(`題目 ${unmarkable.join(', ')} 還沒有正確答案`, 'NO_ANSWER_KEY');
  }

  return tx(() => {
    const code = generateCode();
    const id = Number(run(
      `INSERT INTO live_sessions (code, title, host_id, class_id, seconds, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      code, title, ctx.user.id, classId, seconds, now(),
    ).lastInsertRowid);

    ids.forEach((questionId, i) => run(
      'INSERT INTO live_session_questions (session_id, question_id, seq) VALUES (?, ?, ?)',
      id, questionId, i + 1,
    ));

    audit({ actorId: ctx.user.id, action: 'live.create', target: `live:${id}`, ip: ctx.ip, detail: { code } });
    return { session: snapshotFor(get('SELECT * FROM live_sessions WHERE id = ?', id), { forHost: true }) };
  });
});

route('GET', '/api/teacher/live', 'live.host', (ctx) => ({
  sessions: all(
    `SELECT * FROM live_sessions WHERE host_id = ? ORDER BY created_at DESC LIMIT 20`,
    ctx.user.id,
  ).map((s) => ({
    id: s.id,
    code: s.code,
    title: s.title,
    status: s.status,
    questionCount: questionCount(s.id),
    participants: get('SELECT COUNT(*) AS n FROM live_participants WHERE session_id = ?', s.id).n,
    createdAt: s.created_at,
    endedAt: s.ended_at,
  })),
}));

/**
 * Move to the next question. Also the way the first one goes up, so there is
 * one path into "a question is on screen" rather than two that can disagree.
 */
route('POST', '/api/teacher/live/:id/next', 'live.host', (ctx) => {
  const session = hosted(ctx, ctx.params.id);
  if (session.status === 'ENDED') throw conflict('這場已經結束', 'ALREADY_ENDED');

  const total = questionCount(session.id);
  const next = (session.current_seq ?? 0) + 1;
  const at = now();

  if (next > total) {
    run("UPDATE live_sessions SET status = 'ENDED', current_seq = NULL, ended_at = ? WHERE id = ?", at, session.id);
    const ended = get('SELECT * FROM live_sessions WHERE id = ?', session.id);
    broadcastState(ended);
    return { session: snapshotFor(ended, { forHost: true }) };
  }

  run(
    "UPDATE live_sessions SET status = 'QUESTION', current_seq = ?, asked_at = ? WHERE id = ?",
    next, at, session.id,
  );
  const updated = get('SELECT * FROM live_sessions WHERE id = ?', session.id);
  broadcastState(updated);
  return { session: snapshotFor(updated, { forHost: true }) };
});

/** Close the current question and show everyone how it went. */
route('POST', '/api/teacher/live/:id/reveal', 'live.host', (ctx) => {
  const session = hosted(ctx, ctx.params.id);
  if (session.status !== 'QUESTION') throw conflict('現在沒有進行中的題目', 'NOT_ASKING');

  run("UPDATE live_sessions SET status = 'REVEAL' WHERE id = ?", session.id);
  const updated = get('SELECT * FROM live_sessions WHERE id = ?', session.id);
  broadcastState(updated);
  return { session: snapshotFor(updated, { forHost: true }) };
});

route('POST', '/api/teacher/live/:id/end', 'live.host', (ctx) => {
  const session = hosted(ctx, ctx.params.id);
  if (session.status === 'ENDED') return { session: snapshotFor(session, { forHost: true }) };

  run(
    "UPDATE live_sessions SET status = 'ENDED', current_seq = NULL, ended_at = ? WHERE id = ?",
    now(), session.id,
  );
  const ended = get('SELECT * FROM live_sessions WHERE id = ?', session.id);
  broadcastState(ended);
  audit({ actorId: ctx.user.id, action: 'live.end', target: `live:${session.id}`, ip: ctx.ip });
  // The room stays readable for a moment so everyone sees the final board,
  // then the streams are closed rather than left dangling.
  setTimeout(() => closeRoom(session.id), 2000).unref?.();
  return { session: snapshotFor(ended, { forHost: true }), leaderboard: leaderboard(session.id, 100) };
});

// ---------------------------------------------------------------- players --

route('POST', '/api/live/:code/join', 'live.play', (ctx) => {
  const session = openRoom(ctx.params.code);
  // A room bound to a class is for that class; an ad-hoc one is open to any
  // signed-in student who has the code.
  if (session.class_id != null && session.class_id !== ctx.user.class_id) {
    throw new ForbiddenError('這場測驗不是給你的班別的');
  }

  run(
    'INSERT INTO live_participants (session_id, user_id, joined_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
    session.id, ctx.user.id, now(),
  );
  broadcastState(session);
  return { session: snapshotFor(session, { userId: ctx.user.id }) };
});

route('POST', '/api/live/:code/answer', 'live.play', (ctx) => {
  const at = now();
  const session = openRoom(ctx.params.code);
  if (session.status !== 'QUESTION') throw conflict('現在不能作答', 'NOT_ASKING');

  if (!get(
    'SELECT 1 AS hit FROM live_participants WHERE session_id = ? AND user_id = ?',
    session.id, ctx.user.id,
  )) throw badRequest('請先加入這場測驗', 'NOT_JOINED');

  const question = currentQuestion(session);
  if (!question) throw conflict('現在沒有題目', 'NOT_ASKING');

  const already = get(
    'SELECT 1 AS hit FROM live_answers WHERE session_id = ? AND question_id = ? AND user_id = ?',
    session.id, question.id, ctx.user.id,
  );
  if (already) throw conflict('這題你已經答過了', 'ALREADY_ANSWERED');

  // The deadline is the server's, measured from when the question actually
  // went up. A client that sends its own elapsed time is not consulted.
  const limitMs = session.seconds * 1000;
  const elapsed = at - session.asked_at;
  if (elapsed > limitMs) throw new HttpError(403, '時間到了', 'TOO_LATE');

  const chosen = normalizeChosen(question.id, ctx.body?.chosen, { type: question.type });
  const { isCorrect } = grade(question.id, chosen);
  const points = scoreFor(isCorrect, elapsed, limitMs);

  run(
    `INSERT INTO live_answers (session_id, question_id, user_id, chosen, is_correct, elapsed_ms, points, answered_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    session.id, question.id, ctx.user.id, chosen, isCorrect ? 1 : 0, elapsed, points, at,
  );

  // The host sees the count go up straight away; the class does not, because
  // seeing how many have answered tells you nothing useful and rushes people.
  publish(session.id, 'host', () => snapshotFor(session, { forHost: true }), { hostsOnly: true });

  // Whether it was right, and what it was worth, are withheld until the host
  // reveals. Otherwise the first person to answer can tell everyone else, and
  // even the number of correct options is a hint worth not giving away.
  return { accepted: true, chosen, revealed: false };
});

// ----------------------------------------------------------------- stream --

/**
 * The event stream.
 *
 * Two routes rather than one, because hosting and playing are separate
 * permissions and a route is not allowed to blur them. They share the code
 * below; what differs is who may reach each door, and a student is never sent
 * the answer key while a question is still open.
 */
function openStream(ctx, session, isHost) {
  subscribe(session.id, ctx.res, {
    userId: ctx.user.id,
    isHost,
    onClose: () => {
      // Only the roll call changes, so the host is told and the class is not
      // interrupted for it.
      const fresh = get('SELECT * FROM live_sessions WHERE id = ?', session.id);
      if (fresh) {
        publish(session.id, 'host', () => snapshotFor(fresh, { forHost: true }), { hostsOnly: true });
      }
    },
  });

  // Whatever is happening right now, so a client that connects late or
  // reconnects lands on the same screen as everyone else.
  const frame = snapshotFor(session, { forHost: isHost, userId: ctx.user.id });
  ctx.res.write(`event: ${isHost ? 'host' : 'state'}\ndata: ${JSON.stringify(frame)}\n\n`);
  // Someone arriving changes the roll call, which is the host's business.
  if (!isHost) {
    publish(session.id, 'host', () => snapshotFor(session, { forHost: true }), { hostsOnly: true });
  }

  return STREAM;
}

route('GET', '/api/live/:code/stream', 'live.play', (ctx) => openStream(
  ctx, openRoom(ctx.params.code), false,
));

route('GET', '/api/teacher/live/:id/stream', 'live.host', (ctx) => openStream(
  ctx, hosted(ctx, ctx.params.id), true,
));

// There is no GET /api/live/:code to preview a room before joining: joining
// is idempotent and returns the same information, so a second endpoint would
// only be another place for the two answers to disagree.

/** Who is connected right now — the monitoring view during a test. */
route('GET', '/api/teacher/live/:id/monitor', 'live.host', (ctx) => {
  const session = hosted(ctx, ctx.params.id);
  const question = currentQuestion(session);

  return {
    session: snapshotFor(session, { forHost: true }),
    connections: connectionCount(session.id),
    participants: all(
      `SELECT u.id, u.display_name, u.username, p.joined_at,
              (SELECT COUNT(*) FROM live_answers a
                WHERE a.session_id = p.session_id AND a.user_id = p.user_id) AS answered,
              (SELECT COALESCE(SUM(points), 0) FROM live_answers a
                WHERE a.session_id = p.session_id AND a.user_id = p.user_id) AS points
         FROM live_participants p JOIN users u ON u.id = p.user_id
        WHERE p.session_id = ? ORDER BY u.display_name`,
      session.id,
    ).map((r) => ({
      userId: r.id,
      displayName: r.display_name,
      username: r.username,
      joinedAt: r.joined_at,
      answered: r.answered,
      points: r.points,
      // Whether this person has answered the question on screen, which is
      // what a teacher walking around the room actually wants to know.
      answeredCurrent: question != null && get(
        'SELECT 1 AS hit FROM live_answers WHERE session_id = ? AND question_id = ? AND user_id = ?',
        session.id, question.id, r.id,
      ) != null,
    })),
  };
});
