import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { freshDb, makeUser, makeClass, assignTeacher, makeQuestion } from './helpers.js';
import { createApp } from '../server/app.js';
import { login } from '../server/auth.js';
import { recordAttempt } from '../server/scoring.js';
import { now } from '../server/db.js';

let server, base, tokens, s4a, s4b, alice, bob, quiet;

before(async () => {
  server = createServer(createApp({ allowedOrigins: [], rateLimit: false }));
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

beforeEach(() => {
  freshDb();
  s4a = makeClass('S4A', 'S4');
  s4b = makeClass('S4B', 'S4');
  alice = makeUser({ username: 'alice', role: 'STUDENT', classId: s4a, password: 'pw-alice-123' });
  bob = makeUser({ username: 'bob', role: 'STUDENT', classId: s4a, password: 'pw-bob-123' });
  // Enrolled, never answered anything — the case both screens must not hide.
  quiet = makeUser({ username: 'quiet', role: 'STUDENT', classId: s4a, password: 'pw-quiet-123' });
  const teacher = makeUser({ username: 'chan', role: 'TEACHER', password: 'pw-chan-123' });
  const outsider = makeUser({ username: 'wong', role: 'TEACHER', password: 'pw-wong-123' });
  assignTeacher(s4a, teacher.id);

  tokens = {
    alice: login('alice', 'pw-alice-123').accessToken,
    quiet: login('quiet', 'pw-quiet-123').accessToken,
    teacher: login('chan', 'pw-chan-123').accessToken,
    outsider: login('wong', 'pw-wong-123').accessToken,
  };
  void bob;
});

const call = async (method, path, token) => {
  const res = await fetch(base + path, {
    method, headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

/** Answer `topic` questions, `right` of them correctly, for `user`. */
function practise(userId, topicId, right, wrong) {
  for (let i = 0; i < right; i += 1) {
    recordAttempt({ userId, questionId: makeQuestion({ topicId, correct: 'A' }), chosen: 'A' });
  }
  for (let i = 0; i < wrong; i += 1) {
    recordAttempt({ userId, questionId: makeQuestion({ topicId, correct: 'A' }), chosen: 'B' });
  }
}

describe('a student\'s own progress', () => {
  test('per-topic accuracy, with never-attempted topics distinguished', async () => {
    practise(alice.id, 1, 3, 1);

    const res = await call('GET', '/api/me/progress', tokens.alice);
    assert.equal(res.status, 200);

    const db = res.body.data.topics.find((t) => t.topicId === 1);
    assert.equal(db.answered, 4);
    assert.equal(db.accuracy, 0.75);
    assert.equal(db.openWrong, 1);

    const untouched = res.body.data.topics.find((t) => t.topicId === 2);
    assert.equal(untouched.answered, 0);
    assert.equal(untouched.accuracy, null, '沒做過的課題是 null，不是 0%');
  });

  test('a student who has done nothing gets nulls, not zeros', async () => {
    const res = await call('GET', '/api/me/progress', tokens.quiet);
    assert.equal(res.body.data.totals.answered, 0);
    assert.equal(res.body.data.totals.accuracy, null);
    assert.deepEqual(res.body.data.weakest, []);
  });

  test('the weakest topics are ones actually attempted', async () => {
    practise(alice.id, 1, 1, 3);
    practise(alice.id, 2, 4, 0);

    const res = await call('GET', '/api/me/progress', tokens.alice);
    const { weakest, strongest } = res.body.data;
    assert.equal(weakest[0].topicId, 1);
    assert.equal(strongest[0].topicId, 2);
    assert.ok(weakest.every((t) => t.answered > 0), '沒做過的課題不該被說成「最弱」');
  });

  /** Empty days are returned as zeros so a chart shows the gaps. */
  test('activity covers every day in the window, including quiet ones', async () => {
    practise(alice.id, 1, 1, 0);
    const res = await call('GET', '/api/me/progress', tokens.alice);
    const { activity } = res.body.data;

    assert.equal(activity.length, 28);
    assert.equal(activity.at(-1).answered, 1, '今天的作答要算在最後一天');
    assert.ok(activity.slice(0, 27).every((d) => d.answered === 0));
    assert.equal(res.body.data.totals.streakDays, 1);
  });

  test('it is the caller\'s own progress and nobody else\'s', async () => {
    practise(alice.id, 1, 5, 0);
    const res = await call('GET', '/api/me/progress', tokens.quiet);
    assert.equal(res.body.data.totals.answered, 0, 'quiet 不該看到 alice 的資料');
  });

  test('staff have no student progress of their own to read', async () => {
    const res = await call('GET', '/api/me/progress', tokens.teacher);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.totals.answered, 0);
  });

  test('an unauthenticated caller is refused', async () => {
    assert.equal((await call('GET', '/api/me/progress')).status, 401);
  });
});

describe('class analytics', () => {
  test('only a teacher of that class may read it', async () => {
    assert.equal((await call('GET', `/api/teacher/classes/${s4a}/analytics`, tokens.teacher)).status, 200);
    assert.equal((await call('GET', `/api/teacher/classes/${s4a}/analytics`, tokens.outsider)).status, 403);
    assert.equal((await call('GET', `/api/teacher/classes/${s4b}/analytics`, tokens.teacher)).status, 403);
    assert.equal((await call('GET', `/api/teacher/classes/${s4a}/analytics`, tokens.alice)).status, 403);
  });

  test('students who never started are named, not folded into the average', async () => {
    practise(alice.id, 1, 3, 1);

    const res = await call('GET', `/api/teacher/classes/${s4a}/analytics`, tokens.teacher);
    const d = res.body.data;

    assert.equal(d.studentCount, 3);
    assert.ok(d.notStarted.includes('quiet'), '沒開始的人要點名，不是只給個數字');
    assert.equal(d.classAccuracy, 0.75, '平均只算有練習的人，否則零分會被灌進去');
  });

  test('a class where nobody has started reports null, not zero', async () => {
    const res = await call('GET', `/api/teacher/classes/${s4a}/analytics`, tokens.teacher);
    assert.equal(res.body.data.classAccuracy, null);
    assert.equal(res.body.data.notStarted.length, 3);
  });

  /** One student's bad day should not put a question at the top of the list. */
  test('a hotspot needs more than one student to have tried it', async () => {
    const shared = makeQuestion({ topicId: 1, correct: 'A' });
    const lonely = makeQuestion({ topicId: 1, correct: 'A' });

    recordAttempt({ userId: alice.id, questionId: shared, chosen: 'B' });
    recordAttempt({ userId: bob.id, questionId: shared, chosen: 'B' });
    recordAttempt({ userId: alice.id, questionId: lonely, chosen: 'B' });

    const res = await call('GET', `/api/teacher/classes/${s4a}/analytics`, tokens.teacher);
    const ids = res.body.data.hotspots.map((h) => h.questionId);
    assert.ok(ids.includes(shared));
    assert.ok(!ids.includes(lonely), '只有一個人做過的題目不算全班的難點');
  });

  test('a question the class mostly gets right is not a hotspot', async () => {
    const easy = makeQuestion({ topicId: 1, correct: 'A' });
    recordAttempt({ userId: alice.id, questionId: easy, chosen: 'A' });
    recordAttempt({ userId: bob.id, questionId: easy, chosen: 'A' });

    const res = await call('GET', `/api/teacher/classes/${s4a}/analytics`, tokens.teacher);
    assert.equal(res.body.data.hotspots.length, 0);
  });

  test('the roster distinguishes never-started from low-scoring', async () => {
    practise(alice.id, 1, 0, 4);

    const res = await call('GET', `/api/teacher/classes/${s4a}/analytics`, tokens.teacher);
    const rows = res.body.data.roster;
    assert.equal(rows.find((r) => r.studentId === quiet.id).accuracy, null);
    assert.equal(rows.find((r) => r.studentId === alice.id).accuracy, 0,
      '全錯是 0，沒做過是 null —— 兩者不可混為一談');
    void now;
  });
});
