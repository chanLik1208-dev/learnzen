import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { freshDb, makeUser, makeClass, assignTeacher, makeQuestion } from './helpers.js';
import { createApp } from '../server/app.js';
import { login } from '../server/auth.js';
import { recordAttempt } from '../server/scoring.js';
import { get, all } from '../server/db.js';

let server, base, tokens, alice, bob, qid, unseen;

before(async () => {
  server = createServer(createApp({ allowedOrigins: [], rateLimit: false }));
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

beforeEach(() => {
  freshDb();
  const s4a = makeClass('S4A', 'S4');
  alice = makeUser({ username: 'alice', role: 'STUDENT', classId: s4a, password: 'pw-alice-123' });
  bob = makeUser({ username: 'bob', role: 'STUDENT', classId: s4a, password: 'pw-bob-123' });
  const teacher = makeUser({ username: 'chan', role: 'TEACHER', password: 'pw-chan-123' });
  assignTeacher(s4a, teacher.id);

  tokens = {
    alice: login('alice', 'pw-alice-123').accessToken,
    bob: login('bob', 'pw-bob-123').accessToken,
    teacher: login('chan', 'pw-chan-123').accessToken,
  };

  qid = makeQuestion({ correct: 'A' });
  unseen = makeQuestion({ correct: 'B' });
  recordAttempt({ userId: alice.id, questionId: qid, chosen: 'B' });
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

const report = (token = tokens.alice, body = { reason: 'WRONG_ANSWER', detail: '答案應該是 B' }) =>
  call('POST', `/api/questions/${qid}/report`, { token, body });

describe('raising a report', () => {
  test('a student reports a question they answered', async () => {
    const res = await report();
    assert.equal(res.status, 200);
    assert.equal(res.body.data.status, 'OPEN');
  });

  /** Otherwise the queue fills with questions nobody has actually met. */
  test('a question the student has never attempted cannot be reported', async () => {
    const res = await call('POST', `/api/questions/${unseen}/report`, {
      token: tokens.alice, body: { reason: 'WRONG_ANSWER' },
    });
    assert.equal(res.body.error.code, 'NOT_ATTEMPTED');
  });

  test('the same student cannot raise the same objection twice', async () => {
    await report();
    const again = await report();
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'ALREADY_REPORTED');
  });

  test('a different student may report the same question', async () => {
    await report();
    recordAttempt({ userId: bob.id, questionId: qid, chosen: 'C' });
    assert.equal((await report(tokens.bob)).status, 200);
  });

  test('a reason outside the list is refused', async () => {
    const res = await report(tokens.alice, { reason: 'BECAUSE' });
    assert.equal(res.body.error.code, 'BAD_REASON');
  });

  test('staff do not report questions, they review them', async () => {
    assert.equal((await report(tokens.teacher)).status, 403);
  });

  test('a student sees their own reports and only their own', async () => {
    await report();
    recordAttempt({ userId: bob.id, questionId: qid, chosen: 'D' });
    await report(tokens.bob);

    const mine = await call('GET', '/api/me/reports', { token: tokens.alice });
    assert.equal(mine.body.data.reports.length, 1);
    assert.equal(mine.body.data.reports[0].questionId, qid);
  });
});

describe('reviewing reports', () => {
  test('a student cannot reach the review queue', async () => {
    assert.equal((await call('GET', '/api/teacher/reports', { token: tokens.alice })).status, 403);
  });

  test('the queue shows the answer key, which is what judging needs', async () => {
    await report();
    const res = await call('GET', '/api/teacher/reports', { token: tokens.teacher });

    assert.equal(res.body.data.openCount, 1);
    const row = res.body.data.reports[0];
    assert.deepEqual(row.correctLabels, ['A']);
    assert.equal(row.reporterUsername, 'alice');
    assert.equal(row.detail, '答案應該是 B');
  });

  /**
   * Agreeing a question is broken takes it out of circulation. Noting the
   * objection and leaving it live would help nobody.
   */
  test('accepting a report retires the question', async () => {
    await report();
    const id = get('SELECT id FROM question_reports').id;

    const res = await call('POST', `/api/teacher/reports/${id}/resolve`, {
      token: tokens.teacher, body: { accept: true, resolution: '確認答案鍵錯了，已下架待修' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.questionRetired, true);
    assert.equal(get('SELECT status FROM questions WHERE id = ?', qid).status, 'RETIRED');
  });

  test('rejecting a report leaves the question alone', async () => {
    await report();
    const id = get('SELECT id FROM question_reports').id;

    await call('POST', `/api/teacher/reports/${id}/resolve`, {
      token: tokens.teacher, body: { accept: false, resolution: '題目沒問題，(3) 的敘述不成立' },
    });
    assert.equal(get('SELECT status FROM questions WHERE id = ?', qid).status, 'ACTIVE');
    assert.equal(get('SELECT status FROM question_reports WHERE id = ?', id).status, 'REJECTED');
  });

  /** The student who raised it is owed an answer, not a status change. */
  test('resolving requires a written explanation', async () => {
    await report();
    const id = get('SELECT id FROM question_reports').id;

    const res = await call('POST', `/api/teacher/reports/${id}/resolve`, {
      token: tokens.teacher, body: { accept: true, resolution: '   ' },
    });
    assert.equal(res.body.error.code, 'RESOLUTION_REQUIRED');
    assert.equal(get('SELECT status FROM question_reports WHERE id = ?', id).status, 'OPEN');
  });

  test('the student sees the explanation afterwards', async () => {
    await report();
    const id = get('SELECT id FROM question_reports').id;
    await call('POST', `/api/teacher/reports/${id}/resolve`, {
      token: tokens.teacher, body: { accept: true, resolution: '已確認並下架' },
    });

    const mine = await call('GET', '/api/me/reports', { token: tokens.alice });
    assert.equal(mine.body.data.reports[0].status, 'ACCEPTED');
    assert.equal(mine.body.data.reports[0].resolution, '已確認並下架');
  });

  test('a report cannot be resolved twice', async () => {
    await report();
    const id = get('SELECT id FROM question_reports').id;
    const body = { accept: true, resolution: '處理了' };
    await call('POST', `/api/teacher/reports/${id}/resolve`, { token: tokens.teacher, body });

    const again = await call('POST', `/api/teacher/reports/${id}/resolve`, { token: tokens.teacher, body });
    assert.equal(again.body.error.code, 'ALREADY_RESOLVED');
  });

  test('a retired question stops reaching students', async () => {
    await report();
    const id = get('SELECT id FROM question_reports').id;
    await call('POST', `/api/teacher/reports/${id}/resolve`, {
      token: tokens.teacher, body: { accept: true, resolution: 'x' },
    });

    const session = await call('POST', '/api/practice/sessions', {
      token: tokens.bob, body: { mode: 'TOPIC', topicId: 1, count: 10 },
    });
    const served = session.status === 200 ? session.body.data.questions.map((q) => q.id) : [];
    assert.ok(!served.includes(qid), '已下架的題目不該再被派出去');
  });

  test('marks already given stand', async () => {
    await report();
    const id = get('SELECT id FROM question_reports').id;
    const before = all('SELECT * FROM attempts WHERE question_id = ?', qid).length;

    await call('POST', `/api/teacher/reports/${id}/resolve`, {
      token: tokens.teacher, body: { accept: true, resolution: 'x' },
    });
    assert.equal(all('SELECT * FROM attempts WHERE question_id = ?', qid).length, before,
      '下架題目不該抹掉已經發生的作答');
  });
});
