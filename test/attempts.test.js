import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { freshDb, makeUser, makeClass, assignTeacher, makeQuestion } from './helpers.js';
import { createApp } from '../server/app.js';
import { login } from '../server/auth.js';
import { run, get, now } from '../server/db.js';

/**
 * Multiple attempts, and which one counts.
 *
 * The scoring rule was stored, returned by the API and offered in the teacher
 * UI long before anything read it, so BEST and FIRST silently behaved as LAST.
 * These tests exist so a setting that does nothing cannot ship again.
 */
let server, base, tokens, classId, alice, qids;

before(async () => {
  server = createServer(createApp({ allowedOrigins: [], rateLimit: false }));
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

beforeEach(() => {
  freshDb();
  classId = makeClass('S4A', 'S4');
  alice = makeUser({ username: 'alice', role: 'STUDENT', classId, password: 'pw-alice-123' });
  const teacher = makeUser({ username: 'chan', role: 'TEACHER', password: 'pw-chan-123' });
  assignTeacher(classId, teacher.id);
  tokens = {
    alice: login('alice', 'pw-alice-123').accessToken,
    teacher: login('chan', 'pw-chan-123').accessToken,
  };
  qids = [makeQuestion({ correct: 'A' }), makeQuestion({ correct: 'A' })];
});

async function call(method, path, { token, body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function makePaper(strategy, maxAttempts = 3) {
  const t = now();
  const id = Number(run(
    `INSERT INTO assignments (code, title, subject_id, class_id, created_by, kind,
       max_attempts, score_strategy, reveal, status, created_at, updated_at)
     VALUES ('HW1', '作業', 1, ?, ?, 'HOMEWORK', ?, ?, 'AFTER_SUBMIT', 'PUBLISHED', ?, ?)`,
    classId, 2, maxAttempts, strategy, t, t,
  ).lastInsertRowid);
  qids.forEach((q, i) => run(
    'INSERT INTO assignment_questions (assignment_id, question_id, seq, points) VALUES (?, ?, ?, 1)',
    id, q, i + 1,
  ));
  return id;
}

/** Answer `rightCount` of the two questions correctly, then submit. */
async function attempt(paper, rightCount) {
  await call('POST', `/api/assignments/${paper}/start`, { token: tokens.alice });
  const answers = qids.map((questionId, i) => ({
    questionId, chosen: i < rightCount ? 'A' : 'B',
  }));
  await call('PUT', `/api/assignments/${paper}/answers`, { token: tokens.alice, body: { answers } });
  const res = await call('POST', `/api/assignments/${paper}/submit`, { token: tokens.alice });
  return res.body.data.submission.score;
}

const reportedScore = async () => {
  const list = await call('GET', '/api/assignments', { token: tokens.alice });
  return list.body.data.assignments[0].submission.score;
};

describe('which attempt counts', () => {
  test('BEST reports the highest score, not the newest', async () => {
    const paper = makePaper('BEST');
    assert.equal(await attempt(paper, 2), 2);
    assert.equal(await attempt(paper, 0), 0);
    assert.equal(await reportedScore(), 2, 'BEST 應取最高分，而不是最後一次');
  });

  test('FIRST reports the first attempt, not the newest', async () => {
    const paper = makePaper('FIRST');
    assert.equal(await attempt(paper, 1), 1);
    assert.equal(await attempt(paper, 2), 2);
    assert.equal(await reportedScore(), 1, 'FIRST 應取第一次');
  });

  test('LAST reports the newest attempt', async () => {
    const paper = makePaper('LAST');
    await attempt(paper, 2);
    await attempt(paper, 1);
    assert.equal(await reportedScore(), 1);
  });

  test('the teacher score table applies the same rule', async () => {
    const paper = makePaper('BEST');
    await attempt(paper, 2);
    await attempt(paper, 0);

    const scores = await call('GET', `/api/teacher/assignments/${paper}/scores`, {
      token: tokens.teacher,
    });
    const row = scores.body.data.rows.find((r) => r.studentId === alice.id);
    assert.equal(row.score, 2, '老師看到的分數必須和學生看到的一致');
  });

  test('an attempt in progress is what the student resumes, whatever the rule', async () => {
    const paper = makePaper('BEST');
    await attempt(paper, 2);
    await call('POST', `/api/assignments/${paper}/start`, { token: tokens.alice });

    const list = await call('GET', '/api/assignments', { token: tokens.alice });
    const row = list.body.data.assignments[0];
    assert.equal(row.submission.status, 'IN_PROGRESS', '作答中的那次優先，否則學生回不去');
    assert.equal(row.submission.score, null, '還沒交就沒有分數');
  });

  test('the attempt limit counts every attempt, not just the graded one', async () => {
    const paper = makePaper('BEST', 2);
    await attempt(paper, 1);
    await attempt(paper, 2);

    const third = await call('POST', `/api/assignments/${paper}/start`, { token: tokens.alice });
    assert.equal(third.status, 409);
    assert.equal(third.body.error.code, 'NO_ATTEMPTS_LEFT');
  });

  test('each attempt keeps its own answers', async () => {
    const paper = makePaper('BEST');
    await attempt(paper, 2);
    await attempt(paper, 0);

    const rows = get(
      'SELECT COUNT(*) AS n FROM submissions WHERE assignment_id = ? AND user_id = ?',
      paper, alice.id,
    ).n;
    assert.equal(rows, 2);
    assert.equal(
      get('SELECT COUNT(*) AS n FROM submission_answers').n, 4,
      '兩次各兩題，答案不該互相覆蓋',
    );
  });
});
