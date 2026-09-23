import { test, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, makeUser, makeQuestion } from './helpers.js';
import { get, all } from '../server/db.js';
import {
  normalizeChosen, grade, recordAttempt, updateWrongBook, correctLabelsFor,
  AnswerError, CLEAR_STREAK,
} from '../server/scoring.js';

let student;
beforeEach(() => {
  freshDb();
  student = makeUser({ username: 'stu1' });
});

describe('normalizeChosen', () => {
  test('accepts a single label and upper-cases it', () => {
    const q = makeQuestion({ correct: 'B' });
    assert.equal(normalizeChosen(q, 'b'), 'B');
    assert.equal(normalizeChosen(q, ['b']), 'B');
  });

  test('sorts and de-duplicates multi-select answers', () => {
    const q = makeQuestion({ type: 'MSQ', correct: ['A', 'C'] });
    assert.equal(normalizeChosen(q, ['C', 'a', 'C']), 'A,C');
    assert.equal(normalizeChosen(q, 'c,a'), 'A,C');
  });

  test('rejects an empty answer instead of grading it wrong', () => {
    const q = makeQuestion();
    assert.throws(() => normalizeChosen(q, []), (e) => e instanceof AnswerError && e.code === 'EMPTY_ANSWER');
    assert.throws(() => normalizeChosen(q, ''), { code: 'EMPTY_ANSWER' });
    assert.throws(() => normalizeChosen(q, null), { code: 'EMPTY_ANSWER' });
    assert.throws(() => normalizeChosen(q, '  ,  '), { code: 'EMPTY_ANSWER' });
  });

  test('rejects a label that does not belong to the question', () => {
    const q = makeQuestion({ labels: ['A', 'B'] });
    assert.throws(() => normalizeChosen(q, 'E'), { code: 'UNKNOWN_OPTION' });
  });

  test('rejects multiple selections on a single-answer question', () => {
    const q = makeQuestion({ type: 'MCQ', correct: 'A' });
    assert.throws(() => normalizeChosen(q, ['A', 'B']), { code: 'TOO_MANY_OPTIONS' });
  });
});

describe('grade', () => {
  test('marks the exact correct label right and anything else wrong', () => {
    const q = makeQuestion({ correct: 'C' });
    assert.equal(grade(q, 'C').isCorrect, true);
    assert.equal(grade(q, 'A').isCorrect, false);
  });

  test('multi-select needs the exact set, not an overlap', () => {
    const q = makeQuestion({ type: 'MSQ', correct: ['A', 'C'] });
    assert.equal(grade(q, 'A,C').isCorrect, true);
    assert.equal(grade(q, 'A').isCorrect, false, '部分正確不給分');
    assert.equal(grade(q, 'A,B,C').isCorrect, false, '多選一個也算錯');
  });

  test('refuses to grade a question with no answer key', () => {
    const q = makeQuestion({ correct: [] });
    assert.throws(() => grade(q, 'A'), { code: 'NO_ANSWER_KEY' });
  });

  test('correctLabelsFor returns sorted labels', () => {
    const q = makeQuestion({ type: 'MSQ', correct: ['D', 'B'] });
    assert.deepEqual(correctLabelsFor(q), ['B', 'D']);
  });
});

describe('wrong book', () => {
  test('a wrong answer opens an entry, a first correct answer never does', () => {
    const q1 = makeQuestion({ correct: 'A' });
    const q2 = makeQuestion({ correct: 'A' });

    recordAttempt({ userId: student.id, questionId: q1, chosen: 'B' });
    recordAttempt({ userId: student.id, questionId: q2, chosen: 'A' });

    const open = all('SELECT question_id FROM wrong_book WHERE user_id = ? AND cleared_at IS NULL', student.id);
    assert.deepEqual(open.map((r) => r.question_id), [q1]);
  });

  test('answering the same question wrong twice keeps one row and counts twice', () => {
    const q = makeQuestion({ correct: 'A' });
    recordAttempt({ userId: student.id, questionId: q, chosen: 'B' });
    recordAttempt({ userId: student.id, questionId: q, chosen: 'C' });

    const rows = all('SELECT * FROM wrong_book WHERE user_id = ?', student.id);
    assert.equal(rows.length, 1, '錯題本不應重複出現同一題');
    assert.equal(rows[0].wrong_count, 2);
  });

  test(`clears only after ${CLEAR_STREAK} consecutive correct redos`, () => {
    const q = makeQuestion({ correct: 'A' });
    recordAttempt({ userId: student.id, questionId: q, chosen: 'B' });

    for (let i = 1; i < CLEAR_STREAK; i += 1) {
      recordAttempt({ userId: student.id, questionId: q, chosen: 'A' });
      assert.equal(get('SELECT cleared_at FROM wrong_book WHERE question_id = ?', q).cleared_at, null);
    }
    recordAttempt({ userId: student.id, questionId: q, chosen: 'A' });
    assert.notEqual(get('SELECT cleared_at FROM wrong_book WHERE question_id = ?', q).cleared_at, null);
  });

  test('a wrong answer in between resets the streak', () => {
    const q = makeQuestion({ correct: 'A' });
    recordAttempt({ userId: student.id, questionId: q, chosen: 'B' });
    recordAttempt({ userId: student.id, questionId: q, chosen: 'A' });
    recordAttempt({ userId: student.id, questionId: q, chosen: 'B' });

    const row = get('SELECT * FROM wrong_book WHERE question_id = ?', q);
    assert.equal(row.correct_streak, 0);
    assert.equal(row.cleared_at, null);
  });

  test('getting a cleared question wrong again re-opens it', () => {
    const q = makeQuestion({ correct: 'A' });
    recordAttempt({ userId: student.id, questionId: q, chosen: 'B' });
    for (let i = 0; i < CLEAR_STREAK; i += 1) {
      recordAttempt({ userId: student.id, questionId: q, chosen: 'A' });
    }
    assert.notEqual(get('SELECT cleared_at FROM wrong_book WHERE question_id = ?', q).cleared_at, null);

    recordAttempt({ userId: student.id, questionId: q, chosen: 'D' });
    const row = get('SELECT * FROM wrong_book WHERE question_id = ?', q);
    assert.equal(row.cleared_at, null, '再答錯要重新進錯題本');
    assert.equal(row.wrong_count, 2);
  });

  test("one student's answers never touch another student's book", () => {
    const other = makeUser({ username: 'stu2' });
    const q = makeQuestion({ correct: 'A' });
    recordAttempt({ userId: student.id, questionId: q, chosen: 'B' });

    assert.equal(all('SELECT * FROM wrong_book WHERE user_id = ?', other.id).length, 0);
  });

  test('updateWrongBook on a correct answer for an unseen question stays a no-op', () => {
    const q = makeQuestion({ correct: 'A' });
    updateWrongBook(student.id, q, true);
    assert.equal(all('SELECT * FROM wrong_book').length, 0);
  });
});

describe('recordAttempt', () => {
  test('stores the canonical answer and the verdict', () => {
    const q = makeQuestion({ type: 'MSQ', correct: ['A', 'C'] });
    const out = recordAttempt({ userId: student.id, questionId: q, chosen: ['c', 'A'] });

    assert.equal(out.chosen, 'A,C');
    assert.equal(out.isCorrect, true);
    assert.deepEqual(out.correctLabels, ['A', 'C']);

    const row = get('SELECT * FROM attempts WHERE user_id = ?', student.id);
    assert.equal(row.chosen, 'A,C');
    assert.equal(row.is_correct, 1);
  });

  test('writes no attempt row when the answer is malformed', () => {
    const q = makeQuestion();
    assert.throws(() => recordAttempt({ userId: student.id, questionId: q, chosen: 'Z' }));
    assert.equal(all('SELECT * FROM attempts').length, 0);
    assert.equal(all('SELECT * FROM wrong_book').length, 0);
  });

  test('keeps every attempt as history', () => {
    const q = makeQuestion({ correct: 'A' });
    recordAttempt({ userId: student.id, questionId: q, chosen: 'B' });
    recordAttempt({ userId: student.id, questionId: q, chosen: 'A' });
    assert.equal(all('SELECT * FROM attempts WHERE question_id = ?', q).length, 2);
  });
});
