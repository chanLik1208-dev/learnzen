import { route, badRequest, notFound } from '../http.js';
import { all, get, run, tx, now } from '../db.js';
import { recordAttempt, optionsFor } from '../scoring.js';
import { serializeQuestion, serializeTopic } from '../serialize.js';

const MAX_QUESTIONS = 50;
const DEFAULT_QUESTIONS = 10;

/**
 * A question is only servable if it has an answer key. Papers imported
 * without their options would otherwise reach a student and then fail at
 * grading time, after the work of answering it.
 */
const GRADEABLE = `
  q.status = 'ACTIVE'
  AND EXISTS (SELECT 1 FROM question_options o WHERE o.question_id = q.id AND o.is_correct = 1)
`;

route('GET', '/api/topics', 'topic.list', (ctx) => {
  const topics = all(
    'SELECT * FROM topics WHERE subject_id = ? AND enabled = 1 ORDER BY seq, id',
    Number(ctx.query.get('subjectId') ?? 1),
  );

  // Per-student counts, computed here rather than trusted from the client.
  const stats = ctx.user.role === 'STUDENT'
    ? new Map(all(
      `SELECT q.topic_id AS topic_id,
              COUNT(DISTINCT a.question_id) AS attempted,
              SUM(CASE WHEN a.is_correct = 1 THEN 1 ELSE 0 END) AS correct,
              COUNT(*) AS total
         FROM attempts a JOIN questions q ON q.id = a.question_id
        WHERE a.user_id = ?
        GROUP BY q.topic_id`,
      ctx.user.id,
    ).map((r) => [r.topic_id, r]))
    : new Map();

  return {
    topics: topics.map((t) => {
      const s = stats.get(t.id);
      const pool = get(
        `SELECT COUNT(*) AS n FROM questions q WHERE q.topic_id = ? AND ${GRADEABLE}`,
        t.id,
      ).n;
      const open = ctx.user.role !== 'STUDENT' || topicIsOpenFor(ctx.user.class_id, t.id);
      return {
        ...serializeTopic(t),
        open,
        questionCount: pool,
        attempted: s?.attempted ?? 0,
        // Null, not 0, when nothing has been attempted: "no data" and
        // "scored zero" must not render the same way.
        correctRate: s && s.total > 0 ? s.correct / s.total : null,
      };
    }),
  };
});

/**
 * A topic is practisable unless the class has an explicit row closing it.
 * Absence means open, so a new class is not silently locked out of everything.
 */
export function topicIsOpenFor(classId, topicId) {
  if (classId == null) return true;
  const row = get(
    'SELECT is_open FROM class_topics WHERE class_id = ? AND topic_id = ?', classId, topicId,
  );
  return row == null || row.is_open === 1;
}

/** Questions for a new session, chosen server-side so the client cannot pick. */
function pickQuestions(userId, mode, topicId, count, classId) {
  switch (mode) {
    case 'TOPIC':
      if (!topicId) throw badRequest('請指定課題', 'TOPIC_REQUIRED');
      if (!topicIsOpenFor(classId, topicId)) {
        throw badRequest('此課題已被教師關閉，無法練習', 'TOPIC_CLOSED');
      }
      return all(
        `SELECT q.* FROM questions q WHERE q.topic_id = ? AND ${GRADEABLE}
          ORDER BY RANDOM() LIMIT ?`,
        topicId, count,
      );
    case 'REDO':
      return all(
        `SELECT q.* FROM questions q
           JOIN wrong_book w ON w.question_id = q.id
          WHERE w.user_id = ? AND w.cleared_at IS NULL AND ${GRADEABLE}
          ORDER BY w.last_wrong_at ASC LIMIT ?`,
        userId, count,
      );
    case 'RANDOM':
      return all(`SELECT q.* FROM questions q WHERE ${GRADEABLE} ORDER BY RANDOM() LIMIT ?`, count);
    default:
      throw badRequest('不支援的練習模式', 'BAD_MODE');
  }
}

route('POST', '/api/practice/sessions', 'practice.run', (ctx) => {
  const { mode = 'TOPIC', topicId = null } = ctx.body ?? {};
  const count = Math.min(Math.max(Number(ctx.body?.count) || DEFAULT_QUESTIONS, 1), MAX_QUESTIONS);

  return tx(() => {
    const questions = pickQuestions(ctx.user.id, mode, topicId && Number(topicId), count, ctx.user.class_id);
    if (questions.length === 0) {
      throw badRequest(
        mode === 'REDO' ? '錯題本目前沒有待重做的題目' : '這個課題還沒有可練習的題目',
        'NO_QUESTIONS',
      );
    }

    const r = run(
      'INSERT INTO practice_sessions (user_id, mode, topic_id, started_at) VALUES (?, ?, ?, ?)',
      ctx.user.id, mode, mode === 'TOPIC' ? Number(topicId) : null, now(),
    );
    const sessionId = Number(r.lastInsertRowid);
    questions.forEach((q, i) => run(
      'INSERT INTO practice_session_questions (session_id, question_id, seq) VALUES (?, ?, ?)',
      sessionId, q.id, i,
    ));

    return {
      sessionId,
      mode,
      // withAnswer is absent: a student receives no answer key up front.
      questions: questions.map((q) => serializeQuestion(q)),
      answered: [],
    };
  });
});

/** Load a session the caller owns, or 404. Never reveals another student's. */
function ownSession(ctx, id) {
  const s = get('SELECT * FROM practice_sessions WHERE id = ?', Number(id));
  if (!s || s.user_id !== ctx.user.id) throw notFound('找不到練習');
  return s;
}

/**
 * Resume a session. Returns the very same questions in the very same order,
 * plus what has already been answered, so a reload or a dropped connection
 * drops the student back exactly where they were.
 */
route('GET', '/api/practice/sessions/:id', 'practice.run', (ctx) => {
  const s = ownSession(ctx, ctx.params.id);

  const questions = all(
    `SELECT q.* FROM practice_session_questions sq
       JOIN questions q ON q.id = sq.question_id
      WHERE sq.session_id = ? ORDER BY sq.seq`,
    s.id,
  );
  const answered = all(
    'SELECT question_id, chosen, is_correct FROM attempts WHERE session_id = ? ORDER BY answered_at',
    s.id,
  );

  // An answered question may show its key again; an unanswered one may not,
  // so resuming can never be used to read ahead.
  const done = new Set(answered.map((a) => a.question_id));

  return {
    sessionId: s.id,
    mode: s.mode,
    topicId: s.topic_id,
    startedAt: s.started_at,
    finishedAt: s.finished_at,
    questions: questions.map((q) => serializeQuestion(q, { withAnswer: done.has(q.id) })),
    answered: answered.map((a) => ({
      questionId: a.question_id, chosen: a.chosen, isCorrect: a.is_correct === 1,
    })),
  };
});

/**
 * Answer one question. Practice reveals the verdict and the explanation right
 * away — that is the point of practice — but the reveal happens *after* the
 * answer is recorded, so it cannot be used to peek.
 */
route('POST', '/api/practice/sessions/:id/answers', 'practice.run', (ctx) => {
  const s = ownSession(ctx, ctx.params.id);
  if (s.finished_at != null) throw badRequest('這次練習已結束', 'SESSION_FINISHED');

  const questionId = Number(ctx.body?.questionId);
  if (!Number.isInteger(questionId)) throw badRequest('缺少題號');

  const q = get('SELECT * FROM questions WHERE id = ?', questionId);
  if (!q || q.status !== 'ACTIVE') throw notFound('找不到題目');

  const already = get(
    'SELECT 1 AS hit FROM attempts WHERE session_id = ? AND question_id = ?',
    s.id, questionId,
  );
  if (already) throw badRequest('這題在本次練習已作答', 'ALREADY_ANSWERED');

  const result = tx(() => recordAttempt({
    userId: ctx.user.id,
    questionId,
    chosen: ctx.body?.chosen,
    sessionId: s.id,
    durationMs: Number.isFinite(Number(ctx.body?.durationMs)) ? Number(ctx.body.durationMs) : null,
    type: q.type,
  }));

  return {
    questionId,
    chosen: result.chosen,
    isCorrect: result.isCorrect,
    correctLabels: result.correctLabels,
    explanation: q.explanation_zh ?? null,
    wrongBook: result.book,
  };
});

route('POST', '/api/practice/sessions/:id/finish', 'practice.run', (ctx) => {
  const s = ownSession(ctx, ctx.params.id);
  const at = now();
  // Idempotent: finishing twice keeps the first timestamp.
  if (s.finished_at == null) {
    run('UPDATE practice_sessions SET finished_at = ? WHERE id = ?', at, s.id);
  }

  const rows = all('SELECT is_correct FROM attempts WHERE session_id = ?', s.id);
  const correct = rows.filter((r) => r.is_correct === 1).length;
  return {
    sessionId: s.id,
    answered: rows.length,
    correct,
    wrong: rows.length - correct,
    accuracy: rows.length > 0 ? correct / rows.length : null,
    finishedAt: s.finished_at ?? at,
  };
});

// ------------------------------------------------------------ wrong book --

route('GET', '/api/wrongbook', 'wrongbook.read', (ctx) => {
  const includeCleared = ctx.query.get('includeCleared') === 'true';
  const rows = all(
    `SELECT w.*, q.topic_id, q.content_zh, q.source, q.exam_year, q.difficulty
       FROM wrong_book w JOIN questions q ON q.id = w.question_id
      WHERE w.user_id = ? ${includeCleared ? '' : 'AND w.cleared_at IS NULL'}
      ORDER BY w.last_wrong_at DESC`,
    ctx.user.id,
  );

  return {
    openCount: get(
      'SELECT COUNT(*) AS n FROM wrong_book WHERE user_id = ? AND cleared_at IS NULL',
      ctx.user.id,
    ).n,
    items: rows.map((r) => ({
      questionId: r.question_id,
      topicId: r.topic_id,
      preview: r.content_zh.slice(0, 80),
      source: r.source,
      examYear: r.exam_year,
      difficulty: r.difficulty,
      wrongCount: r.wrong_count,
      correctStreak: r.correct_streak,
      firstWrongAt: r.first_wrong_at,
      lastWrongAt: r.last_wrong_at,
      clearedAt: r.cleared_at ?? null,
      optionCount: optionsFor(r.question_id).length,
    })),
  };
});
