import { route, badRequest, notFound, conflict } from '../http.js';
import { all, get, run, tx, now, audit } from '../db.js';
import { can } from '../rbac.js';
import { correctLabelsFor, optionsFor } from '../scoring.js';

/**
 * Disputed questions.
 *
 * A wrong answer key costs marks for everyone who meets the question, and the
 * person best placed to notice is the student who just got it "wrong". This
 * gives them somewhere to say so, and gives staff a queue rather than a
 * conversation nobody wrote down.
 *
 * Accepting a report retires the question, because a question staff agree is
 * broken should stop being served while it is being fixed — leaving it live
 * and merely noting the objection helps nobody.
 */

const REASONS = ['WRONG_ANSWER', 'AMBIGUOUS', 'TYPO', 'MISSING_FIGURE', 'OTHER'];

route('POST', '/api/questions/:id/report', 'question.report', (ctx) => {
  const questionId = Number(ctx.params.id);
  const question = get('SELECT * FROM questions WHERE id = ?', questionId);
  if (!question) throw notFound('找不到題目');

  const reason = ctx.body?.reason;
  if (!REASONS.includes(reason)) throw badRequest('請選擇回報原因', 'BAD_REASON');
  const detail = String(ctx.body?.detail ?? '').trim().slice(0, 1000);

  // A student can only dispute a question they have actually met. Otherwise
  // the queue fills with questions nobody has seen, and the report carries
  // no information about what went wrong.
  const seen = get(
    'SELECT 1 AS hit FROM attempts WHERE user_id = ? AND question_id = ?',
    ctx.user.id, questionId,
  );
  if (!seen) throw badRequest('只能回報你作答過的題目', 'NOT_ATTEMPTED');

  const existing = get(
    "SELECT * FROM question_reports WHERE question_id = ? AND user_id = ? AND status = 'OPEN'",
    questionId, ctx.user.id,
  );
  if (existing) throw conflict('你已經回報過這題，老師還在處理', 'ALREADY_REPORTED');

  const id = Number(run(
    `INSERT INTO question_reports (question_id, user_id, reason, detail, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    questionId, ctx.user.id, reason, detail || null, now(),
  ).lastInsertRowid);

  audit({
    actorId: ctx.user.id, action: 'question.reported',
    target: `question:${questionId}`, ip: ctx.ip, detail: { reason },
  });
  return { reportId: id, status: 'OPEN' };
});

/** What this student has already raised, so the UI can say so. */
route('GET', '/api/me/reports', 'question.report', (ctx) => ({
  reports: all(
    `SELECT r.*, q.content_zh FROM question_reports r
       JOIN questions q ON q.id = r.question_id
      WHERE r.user_id = ? ORDER BY r.created_at DESC LIMIT 50`,
    ctx.user.id,
  ).map((r) => ({
    id: r.id,
    questionId: r.question_id,
    preview: r.content_zh.slice(0, 60),
    reason: r.reason,
    detail: r.detail,
    status: r.status,
    resolution: r.resolution,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
  })),
}));

route('GET', '/api/teacher/reports', 'question.report.review', (ctx) => {
  const status = ctx.query.get('status');
  const where = status && ['OPEN', 'ACCEPTED', 'REJECTED'].includes(status)
    ? 'WHERE r.status = ?' : '';
  const args = where ? [status] : [];

  return {
    openCount: get("SELECT COUNT(*) AS n FROM question_reports WHERE status = 'OPEN'").n,
    reports: all(
      `SELECT r.*, q.content_zh, q.explanation_zh, q.topic_id, q.status AS question_status,
              u.display_name, u.username
         FROM question_reports r
         JOIN questions q ON q.id = r.question_id
         JOIN users u ON u.id = r.user_id
       ${where} ORDER BY (r.status = 'OPEN') DESC, r.created_at DESC LIMIT 100`,
      ...args,
    ).map((r) => ({
      id: r.id,
      questionId: r.question_id,
      questionStatus: r.question_status,
      content: r.content_zh,
      explanation: r.explanation_zh,
      topicId: r.topic_id,
      // Staff hold question.bank.read, so seeing the key is the point here:
      // judging "the answer is wrong" without it is not possible.
      options: optionsFor(r.question_id).map((o) => ({
        label: o.label, content: o.content_zh, isCorrect: o.is_correct === 1,
      })),
      correctLabels: correctLabelsFor(r.question_id),
      reporter: r.display_name,
      reporterUsername: r.username,
      reason: r.reason,
      detail: r.detail,
      status: r.status,
      resolution: r.resolution,
      createdAt: r.created_at,
      resolvedAt: r.resolved_at,
    })),
  };
});

route('POST', '/api/teacher/reports/:id/resolve', 'question.report.review', (ctx) => {
  const id = Number(ctx.params.id);
  const report = get('SELECT * FROM question_reports WHERE id = ?', id);
  if (!report) throw notFound('找不到回報');
  if (report.status !== 'OPEN') throw conflict('這則回報已經處理過', 'ALREADY_RESOLVED');

  const accept = ctx.body?.accept === true;
  const resolution = String(ctx.body?.resolution ?? '').trim();
  if (!resolution) throw badRequest('請寫下處理說明，回報的學生會看到', 'RESOLUTION_REQUIRED');

  return tx(() => {
    const at = now();
    run(
      `UPDATE question_reports SET status = ?, resolution = ?, resolved_by = ?, resolved_at = ?
        WHERE id = ?`,
      accept ? 'ACCEPTED' : 'REJECTED', resolution, ctx.user.id, at, id,
    );

    // Agreeing the question is broken takes it out of circulation. It keeps
    // its history, so marks already given stand, but nobody else meets it
    // until someone fixes and re-enables it.
    if (accept) {
      run("UPDATE questions SET status = 'RETIRED', updated_at = ? WHERE id = ?", at, report.question_id);
    }

    audit({
      actorId: ctx.user.id,
      action: accept ? 'report.accepted' : 'report.rejected',
      target: `report:${id}`, ip: ctx.ip,
      detail: { questionId: report.question_id, resolution },
    });
    return {
      id,
      status: accept ? 'ACCEPTED' : 'REJECTED',
      questionRetired: accept,
      mayEditQuestion: can(ctx.user, 'question.bank.write'),
    };
  });
});
