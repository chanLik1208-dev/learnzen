/**
 * Shaping database rows for the wire. The only function that may attach an
 * answer key to a question is `serializeQuestion` with `withAnswer: true`, and
 * every caller has to pass it explicitly — there is no default that leaks.
 */
import { get } from './db.js';
import { optionsFor } from './scoring.js';

/**
 * Total marks on a paper, from its questions.
 *
 * Computed here when the caller did not supply it, because relying on every
 * call site to remember produced exactly the inconsistency this module exists
 * to prevent: the same field came back as a number from one endpoint and null
 * from another.
 */
const maxScoreOf = (assignmentId) => get(
  'SELECT COALESCE(SUM(points), 0) AS total FROM assignment_questions WHERE assignment_id = ?',
  assignmentId,
).total;

export function serializeQuestion(q, { withAnswer = false, lang = 'zh' } = {}) {
  const rows = optionsFor(q.id);
  const options = rows.map((o) => ({
    label: o.label,
    content: (lang === 'en' ? o.content_en : o.content_zh) ?? o.content_zh,
    // Present on every option either way, so the shape does not change with
    // the caller's permissions; before submission it is simply always false.
    isCorrect: withAnswer ? o.is_correct === 1 : false,
  }));

  const out = {
    id: q.id,
    topicId: q.topic_id,
    type: q.type,
    content: (lang === 'en' ? q.content_en : q.content_zh) ?? q.content_zh,
    figure: (lang === 'en' ? q.figure_en : q.figure_zh) ?? q.figure_zh ?? null,
    source: q.source,
    examYear: q.exam_year,
    difficulty: q.difficulty,
    officialCorrectRate: q.official_correct_rate,
    options,
  };

  if (withAnswer) {
    const correct = new Set(optionsFor(q.id).filter((o) => o.is_correct).map((o) => o.label));
    for (const o of out.options) o.isCorrect = correct.has(o.label);
    out.correctLabels = [...correct].sort();
    out.explanation = (lang === 'en' ? q.explanation_en : q.explanation_zh) ?? q.explanation_zh ?? null;
  }
  return out;
}

export const serializeTopic = (t) => ({
  id: t.id,
  code: t.code,
  nameZh: t.name_zh,
  nameEn: t.name_en,
  seq: t.seq,
  enabled: t.enabled === 1,
});

/**
 * An assignment row as the client sees it.
 *
 * Two rules hold for every assignment, whatever its state, because a table
 * cannot render a row whose columns come and go:
 *
 *   - The key set never varies. A value that does not apply is `null`, and
 *     `null` is a value the UI can render as a dash. A *missing* key is not:
 *     it becomes `undefined`, and `undefined / maxScore` is `NaN` while
 *     `dayjs(undefined)` is the current time, so the row silently fills with
 *     plausible nonsense instead of showing that there is nothing to show.
 *   - Everything that depends on the individual student lives under
 *     `submission`, which is either `null` or complete. That gives the UI one
 *     place to branch instead of one per column.
 *
 * Timestamps are epoch milliseconds — a number, never a zone-less string.
 */
export const serializeAssignment = (a, submission = null) => ({
  id: a.id,
  code: a.code,
  title: a.title,
  kind: a.kind,
  classId: a.class_id,
  status: a.status,
  openAt: a.open_at ?? null,
  dueAt: a.due_at ?? null,
  timeLimitSeconds: a.time_limit_s ?? null,
  allowLate: a.allow_late === 1,
  maxAttempts: a.max_attempts,
  scoreStrategy: a.score_strategy,
  reveal: a.reveal,
  revealAt: a.reveal_at ?? null,
  shuffle: a.shuffle === 1,
  maxScore: a.max_score ?? maxScoreOf(a.id),
  submission: submission ? serializeSubmission(submission) : null,
});

/** Null-or-complete: callers get every field or the object itself is null. */
export const serializeSubmission = (s) => ({
  id: s.id,
  attemptNo: s.attempt_no,
  status: s.status,
  startedAt: s.started_at,
  submittedAt: s.submitted_at ?? null,
  score: s.score ?? null,
  maxScore: s.max_score ?? null,
  late: s.late === 1,
});
