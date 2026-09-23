/**
 * The only place in the server that decides whether an answer is right, and
 * the only place that writes `attempts` or `wrong_book`. Routes call these
 * functions; they never compare answers themselves and never trust a client
 * for correctness. Keeping it in one module is what makes the wrong-answer
 * book consistent with the scores.
 */
import { all, get, run, now } from './db.js';

/** A wrong question leaves the book after this many consecutive correct redos. */
export const CLEAR_STREAK = 2;

export class AnswerError extends Error {
  constructor(message, code = 'BAD_ANSWER') {
    super(message);
    this.code = code;
    this.status = 400;
  }
}

/**
 * Option rows for a question, in display order. `is_correct` is included
 * because the grader needs it; deciding whether it reaches the client is
 * serialize.js's job, never this module's.
 */
export function optionsFor(questionId) {
  return all(
    `SELECT label, content_zh, content_en, is_correct, seq
       FROM question_options WHERE question_id = ? ORDER BY seq, label`,
    questionId,
  );
}

/** Sorted correct labels, e.g. ['A'] or ['A','C']. */
export function correctLabelsFor(questionId) {
  return all(
    'SELECT label FROM question_options WHERE question_id = ? AND is_correct = 1 ORDER BY label',
    questionId,
  ).map((r) => r.label);
}

/**
 * Turn whatever the client sent into the canonical stored form: a sorted,
 * de-duplicated, comma-joined label string. Rejects labels that do not exist
 * on this question, and rejects multi-select on a single-answer question, so
 * a malformed payload can never be silently graded as wrong (or as right).
 */
export function normalizeChosen(questionId, chosen, { type } = {}) {
  const raw = Array.isArray(chosen)
    ? chosen
    : typeof chosen === 'string'
      ? chosen.split(',')
      : [];
  const labels = [...new Set(raw.map((s) => String(s).trim().toUpperCase()).filter(Boolean))].sort();

  if (labels.length === 0) throw new AnswerError('未選擇答案', 'EMPTY_ANSWER');

  const valid = new Set(optionsFor(questionId).map((o) => o.label));
  if (valid.size === 0) throw new AnswerError('此題尚未設定選項', 'NO_OPTIONS');
  for (const l of labels) {
    if (!valid.has(l)) throw new AnswerError(`選項 ${l} 不屬於此題`, 'UNKNOWN_OPTION');
  }

  const qType = type ?? get('SELECT type FROM questions WHERE id = ?', questionId)?.type;
  if (qType === 'MCQ' && labels.length > 1) {
    throw new AnswerError('單選題只能選一個答案', 'TOO_MANY_OPTIONS');
  }
  return labels.join(',');
}

/**
 * Grade a normalized answer. Correct means the chosen set equals the correct
 * set exactly — partial credit is not awarded, matching DSE MC marking.
 */
export function grade(questionId, normalizedChosen) {
  const correct = correctLabelsFor(questionId);
  if (correct.length === 0) {
    throw new AnswerError('此題尚未設定正確答案，無法評分', 'NO_ANSWER_KEY');
  }
  return {
    isCorrect: normalizedChosen === correct.join(','),
    correctLabels: correct,
  };
}

/**
 * Apply one graded answer to the student's wrong-answer book.
 *
 * Wrong  -> the question is in the book (re-opening it if it had been cleared),
 *           the streak resets, and the wrong count goes up.
 * Right  -> only questions already in the book are affected; a correct answer
 *           never creates an entry. After CLEAR_STREAK consecutive correct
 *           redos the entry is cleared, and the row is kept for history rather
 *           than deleted, so "cleared" and "never wrong" stay distinguishable.
 */
export function updateWrongBook(userId, questionId, isCorrect, at = now()) {
  const row = get(
    'SELECT * FROM wrong_book WHERE user_id = ? AND question_id = ?',
    userId, questionId,
  );

  if (!isCorrect) {
    if (row) {
      run(
        `UPDATE wrong_book
            SET wrong_count = wrong_count + 1, correct_streak = 0,
                last_wrong_at = ?, cleared_at = NULL
          WHERE user_id = ? AND question_id = ?`,
        at, userId, questionId,
      );
    } else {
      run(
        `INSERT INTO wrong_book
           (user_id, question_id, wrong_count, correct_streak, first_wrong_at, last_wrong_at, cleared_at)
         VALUES (?, ?, 1, 0, ?, ?, NULL)`,
        userId, questionId, at, at,
      );
    }
    return { inBook: true, cleared: false };
  }

  if (!row || row.cleared_at != null) return { inBook: row != null, cleared: row != null };

  const streak = row.correct_streak + 1;
  const cleared = streak >= CLEAR_STREAK;
  run(
    'UPDATE wrong_book SET correct_streak = ?, cleared_at = ? WHERE user_id = ? AND question_id = ?',
    streak, cleared ? at : null, userId, questionId,
  );
  return { inBook: true, cleared };
}

/**
 * Grade and persist a single answer: writes the attempt row and folds the
 * result into the wrong-answer book. Callers must already be inside a
 * transaction so the two writes cannot come apart.
 */
export function recordAttempt({
  userId, questionId, chosen, sessionId = null, submissionId = null,
  durationMs = null, at = now(), type = null,
}) {
  const normalized = normalizeChosen(questionId, chosen, { type });
  const { isCorrect, correctLabels } = grade(questionId, normalized);

  run(
    `INSERT INTO attempts
       (user_id, question_id, session_id, submission_id, chosen, is_correct, duration_ms, answered_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    userId, questionId, sessionId, submissionId, normalized, isCorrect ? 1 : 0, durationMs, at,
  );

  const book = updateWrongBook(userId, questionId, isCorrect, at);
  return { chosen: normalized, isCorrect, correctLabels, book };
}
