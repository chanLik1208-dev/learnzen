import { route, badRequest, notFound, conflict, HttpError } from '../http.js';
import { all, get, run, tx, now, audit } from '../db.js';
import { loadAssignmentFor, mayRevealAnswers } from '../rbac.js';
import { normalizeChosen, grade, updateWrongBook, correctLabelsFor } from '../scoring.js';
import { serializeQuestion, serializeAssignment, serializeSubmission } from '../serialize.js';

/** Total marks available, from the paper rather than from anything a client sent. */
const maxScoreOf = (assignmentId) => get(
  'SELECT COALESCE(SUM(points), 0) AS total FROM assignment_questions WHERE assignment_id = ?',
  assignmentId,
).total;

const withMaxScore = (a) => ({ ...a, max_score: maxScoreOf(a.id) });

/**
 * The attempt a student is currently on, or their most recent one. This is
 * what "resume" and "how many attempts have been used" mean — it is not
 * necessarily the attempt that counts towards the grade.
 */
const latestSubmission = (assignmentId, userId) => get(
  `SELECT * FROM submissions WHERE assignment_id = ? AND user_id = ?
    ORDER BY attempt_no DESC LIMIT 1`,
  assignmentId, userId,
);

/**
 * The attempt that counts, chosen by the paper's scoring rule.
 *
 * Keeping this separate from `latestSubmission` is the whole point: with more
 * than one attempt allowed, "which one do I resume" and "which one is my mark"
 * are different questions, and answering both with the newest row makes BEST
 * and FIRST silently behave as LAST — a stored setting that does nothing.
 *
 * While an attempt is still in progress there is no mark yet, so that row is
 * returned as-is; the choice only applies among submitted ones.
 */
function gradedSubmission(assignment, userId) {
  const inProgress = get(
    `SELECT * FROM submissions WHERE assignment_id = ? AND user_id = ? AND status = 'IN_PROGRESS'
      ORDER BY attempt_no DESC LIMIT 1`,
    assignment.id, userId,
  );
  if (inProgress) return inProgress;

  const order = {
    BEST: 'score DESC, attempt_no DESC',
    FIRST: 'attempt_no ASC',
    LAST: 'attempt_no DESC',
  }[assignment.score_strategy] ?? 'attempt_no DESC';

  return get(
    `SELECT * FROM submissions WHERE assignment_id = ? AND user_id = ? AND status = 'SUBMITTED'
      ORDER BY ${order} LIMIT 1`,
    assignment.id, userId,
  );
}

/**
 * The moment a paper stops accepting answers for this attempt: the earlier of
 * the deadline and the student's personal time limit. Computed from stored
 * timestamps every time rather than trusted from a countdown in the browser,
 * which a student can pause simply by closing the tab.
 */
function hardStopFor(assignment, submission) {
  const stops = [];
  if (assignment.time_limit_s != null) {
    stops.push(submission.started_at + assignment.time_limit_s * 1000);
  }
  if (assignment.due_at != null && !assignment.allow_late) stops.push(assignment.due_at);
  return stops.length ? Math.min(...stops) : null;
}

route('GET', '/api/assignments', 'assignment.self.list', (ctx) => {
  if (ctx.user.class_id == null) return { assignments: [] };

  const rows = all(
    `SELECT * FROM assignments
      WHERE class_id = ? AND status = 'PUBLISHED' AND (open_at IS NULL OR open_at <= ?)
      ORDER BY COALESCE(due_at, 9e15) ASC, id DESC`,
    ctx.user.class_id, now(),
  );

  return {
    assignments: rows.map((a) => serializeAssignment(
      withMaxScore(a),
      gradedSubmission(a, ctx.user.id),
    )),
  };
});

route('GET', '/api/assignments/:id', 'assignment.self.list', (ctx) => {
  const a = loadAssignmentFor(ctx.user, ctx.params.id, 'attempt');
  const submission = gradedSubmission(a, ctx.user.id);
  return {
    assignment: serializeAssignment(withMaxScore(a), submission),
    questionCount: get(
      'SELECT COUNT(*) AS n FROM assignment_questions WHERE assignment_id = ?', a.id,
    ).n,
  };
});

route('POST', '/api/assignments/:id/start', 'assignment.self.attempt', (ctx) => {
  const at = now();
  const a = loadAssignmentFor(ctx.user, ctx.params.id, 'attempt', at);

  return tx(() => {
    let submission = latestSubmission(a.id, ctx.user.id);

    // Resuming an attempt already in progress is the same call as starting
    // one, so a reload or a flaky connection never creates a second row.
    if (submission?.status === 'IN_PROGRESS') {
      return openPaper(a, submission, ctx.user, at);
    }

    const used = get(
      'SELECT COUNT(*) AS n FROM submissions WHERE assignment_id = ? AND user_id = ?',
      a.id, ctx.user.id,
    ).n;
    if (used >= a.max_attempts) {
      throw conflict(`這份${a.kind === 'TEST' ? '測驗' : '作業'}只能作答 ${a.max_attempts} 次`, 'NO_ATTEMPTS_LEFT');
    }
    if (a.due_at != null && a.due_at < at && !a.allow_late) {
      throw new HttpError(403, '已過截止時間', 'PAST_DUE');
    }

    const r = run(
      'INSERT INTO submissions (assignment_id, user_id, attempt_no, status, started_at) VALUES (?, ?, ?, ?, ?)',
      a.id, ctx.user.id, used + 1, 'IN_PROGRESS', at,
    );
    submission = get('SELECT * FROM submissions WHERE id = ?', Number(r.lastInsertRowid));
    audit({ actorId: ctx.user.id, action: 'assignment.start', target: `assignment:${a.id}`, ip: ctx.ip });
    return openPaper(a, submission, ctx.user, at);
  });
});

/** The paper as the student sees it while answering: questions, never answers. */
function openPaper(assignment, submission, user, at) {
  const rows = all(
    `SELECT q.*, aq.seq, aq.points FROM assignment_questions aq
       JOIN questions q ON q.id = aq.question_id
      WHERE aq.assignment_id = ? ORDER BY aq.seq`,
    assignment.id,
  );

  const saved = new Map(all(
    'SELECT question_id, chosen FROM submission_answers WHERE submission_id = ?',
    submission.id,
  ).map((r) => [r.question_id, r.chosen]));

  const order = assignment.shuffle === 1 ? shuffleFor(rows, submission.id) : rows;

  return {
    assignment: serializeAssignment({ ...assignment, max_score: maxScoreOf(assignment.id) }, submission),
    submission: serializeSubmission(submission),
    // Absolute instant rather than a remaining-seconds number, so a clock
    // that drifts or a tab that sleeps cannot extend the attempt.
    hardStopAt: hardStopFor(assignment, submission),
    serverTime: at,
    questions: order.map((q) => ({
      ...serializeQuestion(q),
      seq: q.seq,
      points: q.points,
      chosen: saved.get(q.id) ?? null,
    })),
  };
}

/**
 * A per-submission shuffle: the same student always sees the same order on
 * the same attempt, so reloading mid-paper does not reshuffle under them.
 */
function shuffleFor(rows, seed) {
  const out = [...rows];
  let state = seed * 2654435761 % 2147483647;
  const next = () => (state = (state * 16807) % 2147483647) / 2147483647;
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Load the caller's in-progress attempt, enforcing the deadline server-side. */
function activeAttempt(ctx, at) {
  const a = loadAssignmentFor(ctx.user, ctx.params.id, 'attempt', at);
  const submission = latestSubmission(a.id, ctx.user.id);
  if (!submission) throw badRequest('尚未開始作答', 'NOT_STARTED');
  if (submission.status === 'SUBMITTED') throw conflict('已經交卷', 'ALREADY_SUBMITTED');
  return { assignment: a, submission };
}

/**
 * Save a selection without grading it. Answers are stored as they are chosen
 * so a dropped connection loses nothing, and the verdict stays unknown to the
 * student until they submit.
 */
route('PUT', '/api/assignments/:id/answers', 'assignment.self.attempt', (ctx) => {
  const at = now();
  const { assignment, submission } = activeAttempt(ctx, at);

  const stop = hardStopFor(assignment, submission);
  if (stop != null && at > stop) throw new HttpError(403, '作答時間已結束', 'TIME_UP');

  const items = Array.isArray(ctx.body?.answers) ? ctx.body.answers : [ctx.body];
  if (items.length === 0) throw badRequest('沒有要儲存的答案');

  return tx(() => {
    let saved = 0;
    for (const item of items) {
      const questionId = Number(item?.questionId);
      const onPaper = get(
        'SELECT 1 AS hit FROM assignment_questions WHERE assignment_id = ? AND question_id = ?',
        assignment.id, questionId,
      );
      if (!onPaper) throw badRequest(`題目 ${questionId} 不屬於這份卷`, 'NOT_ON_PAPER');

      // Clearing a selection is legitimate; it stores as an empty row rather
      // than failing validation the way an empty submit would.
      if (item.chosen == null || item.chosen === '' || (Array.isArray(item.chosen) && !item.chosen.length)) {
        run('DELETE FROM submission_answers WHERE submission_id = ? AND question_id = ?',
          submission.id, questionId);
        continue;
      }

      const chosen = normalizeChosen(questionId, item.chosen);
      run(
        `INSERT INTO submission_answers (submission_id, question_id, chosen, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (submission_id, question_id)
         DO UPDATE SET chosen = excluded.chosen, updated_at = excluded.updated_at`,
        submission.id, questionId, chosen, at,
      );
      saved += 1;
    }
    return { saved, savedAt: at };
  });
});

/**
 * Grade and close the attempt. Idempotent by construction: the transaction
 * re-checks the status, so a double-tapped submit button, a retry after a
 * timeout, and an auto-submit firing at the same moment all converge on one
 * graded result — and the wrong-answer book is touched exactly once.
 */
route('POST', '/api/assignments/:id/submit', 'assignment.self.attempt', (ctx) => {
  const at = now();
  const a = loadAssignmentFor(ctx.user, ctx.params.id, 'attempt', at);

  return tx(() => {
    const submission = latestSubmission(a.id, ctx.user.id);
    if (!submission) throw badRequest('尚未開始作答', 'NOT_STARTED');
    if (submission.status === 'SUBMITTED') {
      // Not an error: return the result that already exists.
      return resultFor(a, submission, ctx.user, at);
    }

    const questions = all(
      `SELECT q.id, q.type, aq.points FROM assignment_questions aq
         JOIN questions q ON q.id = aq.question_id
        WHERE aq.assignment_id = ? ORDER BY aq.seq`,
      a.id,
    );
    const saved = new Map(all(
      'SELECT question_id, chosen FROM submission_answers WHERE submission_id = ?',
      submission.id,
    ).map((r) => [r.question_id, r.chosen]));

    let score = 0;
    for (const q of questions) {
      const chosen = saved.get(q.id);

      if (chosen == null) {
        // Unanswered: no marks, and no attempt row, because no answer was
        // given. It still belongs in the wrong-answer book — an unanswered
        // question is precisely what needs revisiting.
        updateWrongBook(ctx.user.id, q.id, false, at);
        run(
          `INSERT INTO submission_answers (submission_id, question_id, chosen, is_correct, points_earned, updated_at)
           VALUES (?, ?, '', 0, 0, ?)
           ON CONFLICT (submission_id, question_id)
           DO UPDATE SET is_correct = 0, points_earned = 0, updated_at = excluded.updated_at`,
          submission.id, q.id, at,
        );
        continue;
      }

      const { isCorrect } = grade(q.id, chosen);
      const earned = isCorrect ? q.points : 0;
      score += earned;

      run(
        `UPDATE submission_answers SET is_correct = ?, points_earned = ?, updated_at = ?
          WHERE submission_id = ? AND question_id = ?`,
        isCorrect ? 1 : 0, earned, at, submission.id, q.id,
      );
      run(
        `INSERT INTO attempts (user_id, question_id, submission_id, chosen, is_correct, answered_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ctx.user.id, q.id, submission.id, chosen, isCorrect ? 1 : 0, at,
      );
      updateWrongBook(ctx.user.id, q.id, isCorrect, at);
    }

    const late = a.due_at != null && at > a.due_at ? 1 : 0;
    run(
      `UPDATE submissions
          SET status = 'SUBMITTED', submitted_at = ?, score = ?, max_score = ?, late = ?
        WHERE id = ?`,
      at, score, maxScoreOf(a.id), late, submission.id,
    );
    audit({ actorId: ctx.user.id, action: 'assignment.submit', target: `submission:${submission.id}`, ip: ctx.ip });

    return resultFor(a, get('SELECT * FROM submissions WHERE id = ?', submission.id), ctx.user, at);
  });
});

/** What the student may see after submitting, subject to the reveal policy. */
function resultFor(assignment, submission, user, at) {
  const reveal = mayRevealAnswers(assignment, submission, at);
  const rows = all(
    `SELECT sa.*, q.explanation_zh FROM submission_answers sa
       JOIN questions q ON q.id = sa.question_id
      WHERE sa.submission_id = ?`,
    submission.id,
  );

  return {
    assignment: serializeAssignment({ ...assignment, max_score: maxScoreOf(assignment.id) }, submission),
    submission: serializeSubmission(submission),
    revealed: reveal,
    answers: rows.map((r) => ({
      questionId: r.question_id,
      chosen: r.chosen === '' ? null : r.chosen,
      // The verdict and the marks are the student's own result, so they are
      // always returned. The correct answer is what the policy gates.
      isCorrect: r.is_correct === 1,
      pointsEarned: r.points_earned,
      ...(reveal
        ? { correctLabels: correctLabelsFor(r.question_id), explanation: r.explanation_zh ?? null }
        : { correctLabels: null, explanation: null }),
    })),
  };
}

route('GET', '/api/assignments/:id/review', 'assignment.self.review', (ctx) => {
  const at = now();
  const a = loadAssignmentFor(ctx.user, ctx.params.id, 'attempt', at);
  const submission = gradedSubmission(a, ctx.user.id);
  if (!submission || submission.status !== 'SUBMITTED') throw notFound('尚未有可檢視的作答記錄');
  return resultFor(a, submission, ctx.user, at);
});
