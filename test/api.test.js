import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { freshDb, makeUser, makeClass, assignTeacher, makeQuestion } from './helpers.js';
import { run, get, now } from '../server/db.js';
import { createApp } from '../server/app.js';
import { login } from '../server/auth.js';

let server, base;

before(async () => {
  // Throttling is exercised in ratelimit.test.js; these suites fire hundreds
  // of requests from one address and are not testing that.
  const app = createApp({ allowedOrigins: [], rateLimit: false });
  server = createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

/** Minimal client: returns { status, body } and never throws on 4xx. */
async function call(method, path, { token, body, cookie } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { cookie } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return {
    status: res.status,
    body: text ? JSON.parse(text) : null,
    setCookie: res.headers.getSetCookie?.() ?? [],
  };
}

let s4a, s4b, alice, bob, teacher, outsider, admin, tokens;

beforeEach(() => {
  freshDb();
  s4a = makeClass('S4A', 'S4');
  s4b = makeClass('S4B', 'S4');
  alice = makeUser({ username: 'alice', role: 'STUDENT', classId: s4a, password: 'pw-alice-123' });
  bob = makeUser({ username: 'bob', role: 'STUDENT', classId: s4b, password: 'pw-bob-123' });
  teacher = makeUser({ username: 'chan', role: 'TEACHER', password: 'pw-chan-123' });
  outsider = makeUser({ username: 'wong', role: 'TEACHER', password: 'pw-wong-123' });
  admin = makeUser({ username: 'root', role: 'ADMIN', password: 'pw-root-123' });
  assignTeacher(s4a, teacher.id);

  tokens = {
    alice: login('alice', 'pw-alice-123').accessToken,
    bob: login('bob', 'pw-bob-123').accessToken,
    teacher: login('chan', 'pw-chan-123').accessToken,
    outsider: login('wong', 'pw-wong-123').accessToken,
    admin: login('root', 'pw-root-123').accessToken,
  };
});

describe('default deny', () => {
  test('an unauthenticated request is refused everywhere', async () => {
    for (const [m, p] of [
      ['GET', '/api/auth/me'], ['GET', '/api/topics'], ['GET', '/api/wrongbook'],
      ['GET', '/api/assignments'], ['GET', '/api/teacher/classes'], ['GET', '/api/admin/audit'],
    ]) {
      const res = await call(m, p);
      assert.equal(res.status, 401, `${m} ${p} 應該要 401`);
    }
  });

  test('a garbage token is not a session', async () => {
    const res = await call('GET', '/api/auth/me', { token: 'not.a.token' });
    assert.equal(res.status, 401);
  });

  test('an unknown route is 404 and a wrong method is 405', async () => {
    assert.equal((await call('GET', '/api/nope')).status, 404);
    assert.equal((await call('DELETE', '/api/auth/login')).status, 405);
  });
});

describe('role separation', () => {
  test('a student cannot reach teacher or admin endpoints', async () => {
    for (const p of [
      '/api/teacher/classes', '/api/teacher/questions', '/api/teacher/assignments',
      '/api/admin/topics', '/api/admin/audit',
    ]) {
      const res = await call('GET', p, { token: tokens.alice });
      assert.equal(res.status, 403, `學生不應能讀 ${p}`);
    }
  });

  test('a teacher cannot reach admin endpoints', async () => {
    assert.equal((await call('GET', '/api/admin/audit', { token: tokens.teacher })).status, 403);
    assert.equal((await call('GET', '/api/admin/topics', { token: tokens.teacher })).status, 403);
  });

  test('an admin cannot take a student action', async () => {
    const res = await call('POST', '/api/practice/sessions', {
      token: tokens.admin, body: { mode: 'RANDOM' },
    });
    assert.equal(res.status, 403, '管理員不應能代替學生做練習');
  });

  test('a teacher reaches only their own class', async () => {
    assert.equal((await call('GET', `/api/teacher/classes/${s4a}/students`, { token: tokens.teacher })).status, 200);
    assert.equal((await call('GET', `/api/teacher/classes/${s4b}/students`, { token: tokens.teacher })).status, 403);
    assert.equal((await call('GET', `/api/teacher/classes/${s4a}/students`, { token: tokens.outsider })).status, 403);
  });

  test("a teacher cannot read a student outside their classes", async () => {
    assert.equal((await call('GET', `/api/teacher/students/${alice.id}/profile`, { token: tokens.teacher })).status, 200);
    assert.equal((await call('GET', `/api/teacher/students/${bob.id}/profile`, { token: tokens.teacher })).status, 403);
  });
});

describe('practice', () => {
  beforeEach(() => {
    for (let i = 0; i < 5; i += 1) makeQuestion({ topicId: 1, correct: 'A' });
  });

  test('a session serves questions without the answer key', async () => {
    const res = await call('POST', '/api/practice/sessions', {
      token: tokens.alice, body: { mode: 'TOPIC', topicId: 1, count: 3 },
    });
    assert.equal(res.status, 200);
    const { questions } = res.body.data;
    assert.equal(questions.length, 3);

    const serialized = JSON.stringify(questions);
    assert.ok(!serialized.includes('correctLabels'), '題目不應附帶正確答案');
    assert.ok(!serialized.includes('explanation'), '作答前不應附帶詳解');
    for (const q of questions) {
      assert.ok(q.options.every((o) => o.isCorrect === false), '所有選項的 isCorrect 必須為 false');
    }
  });

  test('answering returns the verdict and the explanation', async () => {
    const s = await call('POST', '/api/practice/sessions', {
      token: tokens.alice, body: { mode: 'TOPIC', topicId: 1, count: 1 },
    });
    const { sessionId, questions } = s.body.data;

    const res = await call('POST', `/api/practice/sessions/${sessionId}/answers`, {
      token: tokens.alice, body: { questionId: questions[0].id, chosen: 'A' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.isCorrect, true);
    assert.deepEqual(res.body.data.correctLabels, ['A']);
  });

  test('another student cannot answer into my session', async () => {
    const s = await call('POST', '/api/practice/sessions', {
      token: tokens.alice, body: { mode: 'TOPIC', topicId: 1, count: 1 },
    });
    const { sessionId, questions } = s.body.data;

    const res = await call('POST', `/api/practice/sessions/${sessionId}/answers`, {
      token: tokens.bob, body: { questionId: questions[0].id, chosen: 'A' },
    });
    assert.equal(res.status, 404, '別人的練習必須看不見');
    assert.equal((await call('GET', `/api/practice/sessions/${sessionId}`, { token: tokens.bob })).status, 404);
  });

  test('the same question cannot be answered twice in one session', async () => {
    const s = await call('POST', '/api/practice/sessions', {
      token: tokens.alice, body: { mode: 'TOPIC', topicId: 1, count: 1 },
    });
    const { sessionId, questions } = s.body.data;
    const payload = { token: tokens.alice, body: { questionId: questions[0].id, chosen: 'B' } };

    assert.equal((await call('POST', `/api/practice/sessions/${sessionId}/answers`, payload)).status, 200);
    const again = await call('POST', `/api/practice/sessions/${sessionId}/answers`, payload);
    assert.equal(again.status, 400);
    assert.equal(again.body.error.code, 'ALREADY_ANSWERED');
  });

  test('a question with no answer key is never served', async () => {
    // Topic 2 holds nothing but a question whose options were never imported,
    // which is exactly the state a half-finished question import leaves behind.
    makeQuestion({ topicId: 2, correct: [] });

    const res = await call('POST', '/api/practice/sessions', {
      token: tokens.alice, body: { mode: 'TOPIC', topicId: 2, count: 5 },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'NO_QUESTIONS', '寧可說沒題目，也不要出一題無法評分的');

    const listed = await call('GET', '/api/topics', { token: tokens.alice });
    const topic2 = listed.body.data.topics.find((t) => t.id === 2);
    assert.equal(topic2.questionCount, 0, '課題清單也不該把它算進可練習題數');
  });

  test('the wrong book fills from practice and drives the redo session', async () => {
    const s = await call('POST', '/api/practice/sessions', {
      token: tokens.alice, body: { mode: 'TOPIC', topicId: 1, count: 2 },
    });
    const { sessionId, questions } = s.body.data;
    await call('POST', `/api/practice/sessions/${sessionId}/answers`, {
      token: tokens.alice, body: { questionId: questions[0].id, chosen: 'B' },
    });

    const book = await call('GET', '/api/wrongbook', { token: tokens.alice });
    assert.equal(book.body.data.openCount, 1);
    assert.equal(book.body.data.items[0].questionId, questions[0].id);

    const redo = await call('POST', '/api/practice/sessions', {
      token: tokens.alice, body: { mode: 'REDO' },
    });
    assert.equal(redo.body.data.questions.length, 1);

    // Bob's book is untouched.
    const bobBook = await call('GET', '/api/wrongbook', { token: tokens.bob });
    assert.equal(bobBook.body.data.openCount, 0);
  });

  test('an empty redo pool is a clear message, not an empty screen', async () => {
    const res = await call('POST', '/api/practice/sessions', {
      token: tokens.alice, body: { mode: 'REDO' },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'NO_QUESTIONS');
  });
});

describe('assignments', () => {
  let paper, qids;

  beforeEach(() => {
    qids = [makeQuestion({ correct: 'A' }), makeQuestion({ correct: 'B' }), makeQuestion({ correct: 'C' })];
    const t = now();
    const r = run(
      `INSERT INTO assignments (code, title, subject_id, class_id, created_by, kind, reveal, status, created_at, updated_at)
       VALUES ('HW1', '第一份作業', 1, ?, ?, 'HOMEWORK', 'AFTER_SUBMIT', 'PUBLISHED', ?, ?)`,
      s4a, teacher.id, t, t,
    );
    paper = Number(r.lastInsertRowid);
    qids.forEach((id, i) => run(
      'INSERT INTO assignment_questions (assignment_id, question_id, seq, points) VALUES (?, ?, ?, 1)',
      paper, id, i + 1,
    ));
  });

  test('a student in another class cannot see or start it', async () => {
    assert.equal((await call('GET', `/api/assignments/${paper}`, { token: tokens.bob })).status, 404);
    assert.equal((await call('POST', `/api/assignments/${paper}/start`, { token: tokens.bob })).status, 404);
  });

  test('starting twice resumes the same attempt', async () => {
    const a = await call('POST', `/api/assignments/${paper}/start`, { token: tokens.alice });
    const b = await call('POST', `/api/assignments/${paper}/start`, { token: tokens.alice });
    assert.equal(a.body.data.submission.id, b.body.data.submission.id);
    assert.equal(get('SELECT COUNT(*) AS n FROM submissions').n, 1);
  });

  test('the paper carries no answer key while in progress', async () => {
    const res = await call('POST', `/api/assignments/${paper}/start`, { token: tokens.alice });
    const dump = JSON.stringify(res.body.data.questions);
    assert.ok(!dump.includes('correctLabels'));
    assert.ok(res.body.data.questions.every((q) => q.options.every((o) => o.isCorrect === false)));
  });

  test('saved answers survive and come back on resume', async () => {
    await call('POST', `/api/assignments/${paper}/start`, { token: tokens.alice });
    await call('PUT', `/api/assignments/${paper}/answers`, {
      token: tokens.alice, body: { answers: [{ questionId: qids[0], chosen: 'A' }] },
    });

    const resumed = await call('POST', `/api/assignments/${paper}/start`, { token: tokens.alice });
    const q0 = resumed.body.data.questions.find((q) => q.id === qids[0]);
    assert.equal(q0.chosen, 'A');
  });

  test('saving an answer never tells the student whether it is right', async () => {
    await call('POST', `/api/assignments/${paper}/start`, { token: tokens.alice });
    const res = await call('PUT', `/api/assignments/${paper}/answers`, {
      token: tokens.alice, body: { answers: [{ questionId: qids[0], chosen: 'A' }] },
    });
    assert.deepEqual(Object.keys(res.body.data).sort(), ['saved', 'savedAt']);
  });

  test('a question from another paper is rejected', async () => {
    const stray = makeQuestion({ correct: 'A' });
    await call('POST', `/api/assignments/${paper}/start`, { token: tokens.alice });
    const res = await call('PUT', `/api/assignments/${paper}/answers`, {
      token: tokens.alice, body: { answers: [{ questionId: stray, chosen: 'A' }] },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'NOT_ON_PAPER');
  });

  test('submitting grades server-side and is idempotent', async () => {
    await call('POST', `/api/assignments/${paper}/start`, { token: tokens.alice });
    await call('PUT', `/api/assignments/${paper}/answers`, {
      token: tokens.alice,
      body: {
        answers: [
          { questionId: qids[0], chosen: 'A' }, // right
          { questionId: qids[1], chosen: 'D' }, // wrong
          // qids[2] left unanswered
        ],
      },
    });

    const first = await call('POST', `/api/assignments/${paper}/submit`, { token: tokens.alice });
    assert.equal(first.status, 200);
    assert.equal(first.body.data.submission.score, 1);
    assert.equal(first.body.data.submission.maxScore, 3);
    assert.equal(first.body.data.revealed, true);

    const second = await call('POST', `/api/assignments/${paper}/submit`, { token: tokens.alice });
    assert.equal(second.body.data.submission.score, 1, '重複交卷不得改變分數');
    assert.equal(
      get('SELECT COUNT(*) AS n FROM attempts WHERE user_id = ?', alice.id).n, 2,
      '重複交卷不得重複寫入作答記錄',
    );

    const wrong = get(
      'SELECT wrong_count FROM wrong_book WHERE user_id = ? AND question_id = ?', alice.id, qids[1],
    );
    assert.equal(wrong.wrong_count, 1, '重複交卷不得讓錯題本重複計數');
  });

  test('an unanswered question scores zero and still enters the wrong book', async () => {
    await call('POST', `/api/assignments/${paper}/start`, { token: tokens.alice });
    await call('POST', `/api/assignments/${paper}/submit`, { token: tokens.alice });

    assert.equal(
      get('SELECT COUNT(*) AS n FROM wrong_book WHERE user_id = ? AND cleared_at IS NULL', alice.id).n,
      3,
    );
  });

  test('a client-supplied score is ignored', async () => {
    await call('POST', `/api/assignments/${paper}/start`, { token: tokens.alice });
    const res = await call('POST', `/api/assignments/${paper}/submit`, {
      token: tokens.alice, body: { score: 999, correctCount: 3, maxScore: 999 },
    });
    assert.equal(res.body.data.submission.score, 0, '伺服器只採信自己算的分數');
    assert.equal(res.body.data.submission.maxScore, 3);
  });

  test('answers stay hidden when the reveal policy says NEVER', async () => {
    run("UPDATE assignments SET reveal = 'NEVER' WHERE id = ?", paper);
    await call('POST', `/api/assignments/${paper}/start`, { token: tokens.alice });
    const res = await call('POST', `/api/assignments/${paper}/submit`, { token: tokens.alice });

    assert.equal(res.body.data.revealed, false);
    assert.ok(res.body.data.answers.every((a) => a.correctLabels === null));
    // The student still learns their own result.
    assert.ok(res.body.data.answers.every((a) => typeof a.isCorrect === 'boolean'));
  });

  test('answering after submitting is refused', async () => {
    await call('POST', `/api/assignments/${paper}/start`, { token: tokens.alice });
    await call('POST', `/api/assignments/${paper}/submit`, { token: tokens.alice });

    const res = await call('PUT', `/api/assignments/${paper}/answers`, {
      token: tokens.alice, body: { answers: [{ questionId: qids[0], chosen: 'A' }] },
    });
    assert.equal(res.status, 409);
  });

  test('a second attempt is refused when only one is allowed', async () => {
    await call('POST', `/api/assignments/${paper}/start`, { token: tokens.alice });
    await call('POST', `/api/assignments/${paper}/submit`, { token: tokens.alice });

    const res = await call('POST', `/api/assignments/${paper}/start`, { token: tokens.alice });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'NO_ATTEMPTS_LEFT');
  });

  test('the time limit is enforced from the stored start time', async () => {
    run('UPDATE assignments SET time_limit_s = 60 WHERE id = ?', paper);
    await call('POST', `/api/assignments/${paper}/start`, { token: tokens.alice });
    // Pretend the attempt began two minutes ago.
    run('UPDATE submissions SET started_at = ? WHERE user_id = ?', now() - 120_000, alice.id);

    const res = await call('PUT', `/api/assignments/${paper}/answers`, {
      token: tokens.alice, body: { answers: [{ questionId: qids[0], chosen: 'A' }] },
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'TIME_UP');
  });

  test('a draft assignment is invisible to the class', async () => {
    run("UPDATE assignments SET status = 'DRAFT' WHERE id = ?", paper);
    const list = await call('GET', '/api/assignments', { token: tokens.alice });
    assert.equal(list.body.data.assignments.length, 0);
    assert.equal((await call('POST', `/api/assignments/${paper}/start`, { token: tokens.alice })).status, 404);
  });

  test('the list row keeps a constant shape whether or not there is a submission', async () => {
    const before = await call('GET', '/api/assignments', { token: tokens.alice });
    const pendingRow = before.body.data.assignments[0];
    assert.equal(pendingRow.submission, null);
    assert.ok('maxScore' in pendingRow && 'dueAt' in pendingRow);

    await call('POST', `/api/assignments/${paper}/start`, { token: tokens.alice });
    await call('POST', `/api/assignments/${paper}/submit`, { token: tokens.alice });

    const after = await call('GET', '/api/assignments', { token: tokens.alice });
    const doneRow = after.body.data.assignments[0];
    assert.deepEqual(
      Object.keys(pendingRow).sort(), Object.keys(doneRow).sort(),
      '有沒有作答記錄，欄位組合必須完全一樣',
    );
    assert.notEqual(doneRow.submission, null);
  });
});

describe('teacher grading views', () => {
  test('the score table lists every student, including those who never started', async () => {
    const q = makeQuestion({ correct: 'A' });
    const t = now();
    const r = run(
      `INSERT INTO assignments (code, title, subject_id, class_id, created_by, kind, status, created_at, updated_at)
       VALUES ('HW2', '作業二', 1, ?, ?, 'HOMEWORK', 'PUBLISHED', ?, ?)`,
      s4a, teacher.id, t, t,
    );
    const paper = Number(r.lastInsertRowid);
    run('INSERT INTO assignment_questions (assignment_id, question_id, seq, points) VALUES (?, ?, 1, 1)', paper, q);

    const carol = makeUser({ username: 'carol', role: 'STUDENT', classId: s4a });
    void carol;

    const res = await call('GET', `/api/teacher/assignments/${paper}/scores`, { token: tokens.teacher });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.rows.length, 2, 'S4A 兩名學生都要出現');
    assert.ok(res.body.data.rows.every((r2) => r2.status === 'NOT_STARTED'));
    assert.ok(res.body.data.rows.every((r2) => r2.score === null), '沒作答就是 null，不是 0');

    assert.equal((await call('GET', `/api/teacher/assignments/${paper}/scores`, { token: tokens.outsider })).status, 403);
  });

  test('a paper cannot be created from questions with no answer key', async () => {
    const bad = makeQuestion({ correct: [] });
    const res = await call('POST', '/api/teacher/assignments', {
      token: tokens.teacher,
      body: { title: '壞卷', classId: s4a, questionIds: [bad] },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'NO_ANSWER_KEY');
  });

  test('a teacher cannot create a paper for a class they do not teach', async () => {
    const q = makeQuestion({ correct: 'A' });
    const res = await call('POST', '/api/teacher/assignments', {
      token: tokens.teacher,
      body: { title: '越權', classId: s4b, questionIds: [q] },
    });
    assert.equal(res.status, 403);
  });
});

describe('auth endpoints', () => {
  test('login sets an httpOnly refresh cookie scoped to /api/auth', async () => {
    const res = await call('POST', '/api/auth/login', {
      body: { username: 'alice', password: 'pw-alice-123' },
    });
    assert.equal(res.status, 200);
    const cookie = res.setCookie.find((c) => c.startsWith('lb_rt='));
    assert.ok(cookie.includes('HttpOnly'));
    assert.ok(cookie.includes('SameSite=Strict'));
    assert.ok(cookie.includes('Path=/api/auth'));
  });

  test('a bad password does not reveal whether the account exists', async () => {
    const a = await call('POST', '/api/auth/login', { body: { username: 'alice', password: 'x' } });
    const b = await call('POST', '/api/auth/login', { body: { username: 'ghost', password: 'x' } });
    assert.equal(a.status, b.status);
    assert.deepEqual(a.body.error, b.body.error);
  });

  test('refreshing without a cookie is a clean 401, not a crash', async () => {
    const res = await call('POST', '/api/auth/refresh');
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'NO_REFRESH_TOKEN');
  });

  test('a refresh cookie exchanges for a working access token', async () => {
    const out = await call('POST', '/api/auth/login', {
      body: { username: 'alice', password: 'pw-alice-123' },
    });
    const cookie = out.setCookie.find((c) => c.startsWith('lb_rt=')).split(';')[0];

    const refreshed = await call('POST', '/api/auth/refresh', { cookie });
    assert.equal(refreshed.status, 200);

    const me = await call('GET', '/api/auth/me', { token: refreshed.body.data.accessToken });
    assert.equal(me.body.data.user.username, 'alice');
  });

  test('malformed JSON is a 400, not a 500', async () => {
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    assert.equal(res.status, 400);
  });
});

describe('per-class topic gating', () => {
  test('a topic defaults to open and can be closed by the class teacher only', async () => {
    makeQuestion({ topicId: 1, correct: 'A' });

    const opened = await call('POST', '/api/practice/sessions', {
      token: tokens.alice, body: { mode: 'TOPIC', topicId: 1, count: 1 },
    });
    assert.equal(opened.status, 200, '沒有人關過的課題預設就是開的');

    const forbidden = await call('PUT', `/api/teacher/classes/${s4a}/topics/1`, {
      token: tokens.outsider, body: { open: false },
    });
    assert.equal(forbidden.status, 403, '不帶這個班的老師不能關它的課題');

    const closed = await call('PUT', `/api/teacher/classes/${s4a}/topics/1`, {
      token: tokens.teacher, body: { open: false },
    });
    assert.equal(closed.status, 200);

    const blocked = await call('POST', '/api/practice/sessions', {
      token: tokens.alice, body: { mode: 'TOPIC', topicId: 1, count: 1 },
    });
    assert.equal(blocked.status, 400);
    assert.equal(blocked.body.error.code, 'TOPIC_CLOSED');

    const listed = await call('GET', '/api/topics', { token: tokens.alice });
    assert.equal(listed.body.data.topics.find((t) => t.id === 1).open, false,
      '課題清單要先講它是關的，別讓學生點進去才被拒');
  });

  test('closing a topic for one class does not close it for another', async () => {
    makeQuestion({ topicId: 1, correct: 'A' });
    await call('PUT', `/api/teacher/classes/${s4a}/topics/1`, {
      token: tokens.teacher, body: { open: false },
    });

    const bobTries = await call('POST', '/api/practice/sessions', {
      token: tokens.bob, body: { mode: 'TOPIC', topicId: 1, count: 1 },
    });
    assert.equal(bobTries.status, 200, 'S4B 不受 S4A 的設定影響');
  });

  test('the toggle screen distinguishes a default from a deliberate setting', async () => {
    const before = await call('GET', `/api/teacher/classes/${s4a}/topics`, { token: tokens.teacher });
    assert.ok(before.body.data.topics.every((t) => t.open === true));
    assert.ok(before.body.data.topics.every((t) => t.explicitlySet === false));

    await call('PUT', `/api/teacher/classes/${s4a}/topics/1`, {
      token: tokens.teacher, body: { open: false },
    });
    const after = await call('GET', `/api/teacher/classes/${s4a}/topics`, { token: tokens.teacher });
    const t1 = after.body.data.topics.find((t) => t.id === 1);
    assert.equal(t1.open, false);
    assert.equal(t1.explicitlySet, true);
  });
});

describe('practice resume', () => {
  test('reloading returns the same questions in the same order, with progress', async () => {
    for (let i = 0; i < 6; i += 1) makeQuestion({ topicId: 1, correct: 'A' });

    const started = await call('POST', '/api/practice/sessions', {
      token: tokens.alice, body: { mode: 'TOPIC', topicId: 1, count: 4 },
    });
    const { sessionId, questions } = started.body.data;
    await call('POST', `/api/practice/sessions/${sessionId}/answers`, {
      token: tokens.alice, body: { questionId: questions[1].id, chosen: 'B' },
    });

    const resumed = await call('GET', `/api/practice/sessions/${sessionId}`, { token: tokens.alice });
    assert.deepEqual(
      resumed.body.data.questions.map((q) => q.id), questions.map((q) => q.id),
      '重整後題目與順序必須完全一致',
    );
    assert.equal(resumed.body.data.answered.length, 1);
    assert.equal(resumed.body.data.answered[0].isCorrect, false);
  });

  test('resuming reveals the key only for questions already answered', async () => {
    for (let i = 0; i < 3; i += 1) makeQuestion({ topicId: 1, correct: 'A' });
    const started = await call('POST', '/api/practice/sessions', {
      token: tokens.alice, body: { mode: 'TOPIC', topicId: 1, count: 3 },
    });
    const { sessionId, questions } = started.body.data;
    await call('POST', `/api/practice/sessions/${sessionId}/answers`, {
      token: tokens.alice, body: { questionId: questions[0].id, chosen: 'A' },
    });

    const resumed = await call('GET', `/api/practice/sessions/${sessionId}`, { token: tokens.alice });
    const [done, ...pending] = resumed.body.data.questions;
    assert.ok(done.correctLabels, '答過的題可以看到答案');
    assert.ok(pending.every((q) => q.correctLabels === undefined), '還沒答的題不准偷看');
    assert.ok(pending.every((q) => q.options.every((o) => o.isCorrect === false)));
  });
});

describe('filling in draft questions', () => {
  /** A question imported without its options: stem and explanation only. */
  function draftQuestion(explanation = '……因此選C。') {
    const t = now();
    const r = run(
      `INSERT INTO questions (subject_id, topic_id, type, content_zh, explanation_zh, status, created_at, updated_at)
       VALUES (1, 1, 'MCQ', ?, ?, 'DRAFT', ?, ?)`,
      '某題目', explanation, t, t,
    );
    return Number(r.lastInsertRowid);
  }

  test('drafts are listed with the answer the explanation implies', async () => {
    draftQuestion('資訊時代的特色……故選C。');
    const res = await call('GET', '/api/teacher/questions/drafts', { token: tokens.teacher });

    assert.equal(res.status, 200);
    assert.equal(res.body.data.total, 1);
    const q = res.body.data.questions[0];
    assert.equal(q.suggestedAnswer, 'C');
    assert.match(q.suggestionEvidence, /故選C/);
    assert.deepEqual(q.options, []);
  });

  test('a suggestion is absent rather than invented when the text does not say', async () => {
    draftQuestion('這段詳解沒有講答案是哪一個。');
    const res = await call('GET', '/api/teacher/questions/drafts', { token: tokens.teacher });
    assert.equal(res.body.data.questions[0].suggestedAnswer, null);
  });

  test('filling the options makes the question servable', async () => {
    const id = draftQuestion();
    const res = await call('PUT', `/api/teacher/questions/${id}/options`, {
      token: tokens.teacher,
      body: {
        options: [
          { label: 'A', contentZh: '甲', isCorrect: false },
          { label: 'B', contentZh: '乙', isCorrect: false },
          { label: 'C', contentZh: '丙', isCorrect: true },
          { label: 'D', contentZh: '丁', isCorrect: false },
        ],
      },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.remainingDrafts, 0);
    assert.equal(get('SELECT status FROM questions WHERE id = ?', id).status, 'ACTIVE');

    // And it now actually reaches a student.
    const s = await call('POST', '/api/practice/sessions', {
      token: tokens.alice, body: { mode: 'TOPIC', topicId: 1, count: 5 },
    });
    assert.ok(s.body.data.questions.some((q) => q.id === id));
  });

  test('a draft cannot be activated without an answer key', async () => {
    const id = draftQuestion();
    const res = await call('PUT', `/api/teacher/questions/${id}/options`, {
      token: tokens.teacher,
      body: { options: [{ label: 'A', contentZh: '甲' }, { label: 'B', contentZh: '乙' }] },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'NO_ANSWER_KEY');
    assert.equal(get('SELECT status FROM questions WHERE id = ?', id).status, 'DRAFT');
  });

  test('blank option text and duplicate labels are refused', async () => {
    const id = draftQuestion();
    const blank = await call('PUT', `/api/teacher/questions/${id}/options`, {
      token: tokens.teacher,
      body: { options: [{ label: 'A', contentZh: '  ', isCorrect: true }, { label: 'B', contentZh: '乙' }] },
    });
    assert.equal(blank.body.error.code, 'EMPTY_OPTION');

    const dupe = await call('PUT', `/api/teacher/questions/${id}/options`, {
      token: tokens.teacher,
      body: { options: [{ label: 'A', contentZh: '甲', isCorrect: true }, { label: 'A', contentZh: '乙' }] },
    });
    assert.equal(dupe.body.error.code, 'DUPLICATE_LABEL');
  });

  test('a single-answer question refuses two correct options', async () => {
    const id = draftQuestion();
    const res = await call('PUT', `/api/teacher/questions/${id}/options`, {
      token: tokens.teacher,
      body: {
        options: [
          { label: 'A', contentZh: '甲', isCorrect: true },
          { label: 'B', contentZh: '乙', isCorrect: true },
        ],
      },
    });
    assert.equal(res.body.error.code, 'TOO_MANY_CORRECT');
  });

  test('students cannot see or fill drafts', async () => {
    const id = draftQuestion();
    assert.equal((await call('GET', '/api/teacher/questions/drafts', { token: tokens.alice })).status, 403);
    const res = await call('PUT', `/api/teacher/questions/${id}/options`, {
      token: tokens.alice,
      body: { options: [{ label: 'A', contentZh: '甲', isCorrect: true }, { label: 'B', contentZh: '乙' }] },
    });
    assert.equal(res.status, 403);
  });
});

describe('draft filtering by hint', () => {
  function draft(explanation) {
    const t = now();
    return Number(run(
      `INSERT INTO questions (subject_id, topic_id, type, content_zh, explanation_zh, status, created_at, updated_at)
       VALUES (1, 1, 'MCQ', '題', ?, 'DRAFT', ?, ?)`,
      explanation, t, t,
    ).lastInsertRowid);
  }

  test('hinted=true narrows to the questions whose explanation names an answer', async () => {
    draft('故選A。');
    draft('這裡沒有講答案。');
    draft('故選B。');

    const every = await call('GET', '/api/teacher/questions/drafts', { token: tokens.teacher });
    assert.equal(every.body.data.total, 3);
    assert.equal(every.body.data.hintedTotal, 2);

    const hinted = await call('GET', '/api/teacher/questions/drafts?hinted=true', { token: tokens.teacher });
    assert.equal(hinted.body.data.total, 2);
    assert.ok(hinted.body.data.questions.every((q) => q.suggestedAnswer));
  });

  test('paging counts the filtered set, not the whole draft pile', async () => {
    for (let i = 0; i < 5; i += 1) draft('故選C。');
    for (let i = 0; i < 5; i += 1) draft('沒講。');

    const page = await call('GET', '/api/teacher/questions/drafts?hinted=true&limit=2&offset=4', {
      token: tokens.teacher,
    });
    assert.equal(page.body.data.total, 5);
    assert.equal(page.body.data.questions.length, 1, '第 5 筆之後就沒有了');
  });
});

describe('an administrator can use the pages shown to them', () => {
  test('every teacher-side endpoint an administrator is offered actually answers', async () => {
    const paths = [
      '/api/teacher/classes',
      '/api/teacher/assignments',
      '/api/teacher/questions?limit=1',
      '/api/teacher/questions/drafts?limit=1',
      `/api/teacher/classes/${s4a}/students`,
      `/api/teacher/classes/${s4a}/topics`,
      `/api/teacher/students/${alice.id}/profile`,
    ];
    for (const p of paths) {
      const res = await call('GET', p, { token: tokens.admin });
      assert.equal(res.status, 200, `管理員打 ${p} 應該要通`);
    }
  });

  test('an administrator reaches classes no teacher is assigned to', async () => {
    // S4B has no teacher; an administrator still oversees it.
    assert.equal((await call('GET', `/api/teacher/classes/${s4b}/students`, { token: tokens.admin })).status, 200);
    assert.equal((await call('GET', `/api/teacher/students/${bob.id}/profile`, { token: tokens.admin })).status, 200);
  });
});
