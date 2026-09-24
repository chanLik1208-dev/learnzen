import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { freshDb, makeUser, makeClass, assignTeacher, makeQuestion } from './helpers.js';
import { createApp } from '../server/app.js';
import { login } from '../server/auth.js';
import { get } from '../server/db.js';

/**
 * The schema refuses a paper whose settings contradict each other, which keeps
 * the data honest but surfaces as an opaque database failure. These pin the
 * route to answering with something the teacher can act on instead.
 */
let server, base, token, classId, qids;

before(async () => {
  server = createServer(createApp({ allowedOrigins: [], rateLimit: false }));
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

beforeEach(() => {
  freshDb();
  classId = makeClass('S4A', 'S4');
  const teacher = makeUser({ username: 'chan', role: 'TEACHER', password: 'pw-chan-123' });
  assignTeacher(classId, teacher.id);
  token = login('chan', 'pw-chan-123').accessToken;
  qids = [makeQuestion({ correct: 'A' }), makeQuestion({ correct: 'B' })];
});

const create = async (body) => {
  const res = await fetch(`${base}/api/teacher/assignments`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ title: '測驗', classId, questionIds: qids, ...body }),
  });
  return { status: res.status, body: await res.json() };
};

describe('creating a paper', () => {
  test('a valid paper is created', async () => {
    const res = await create({});
    assert.equal(res.status, 200);
  });

  test('a title of only spaces is refused', async () => {
    const res = await create({ title: '   ' });
    assert.equal(res.status, 400);
  });

  test('the stored title is trimmed', async () => {
    await create({ title: '  第一章測驗  ' });
    assert.equal(get('SELECT title FROM assignments').title, '第一章測驗');
  });

  test('repeating a question is de-duplicated rather than crashing', async () => {
    const res = await create({ questionIds: [qids[0], qids[0], qids[1]] });
    assert.equal(res.status, 200, '重複的題號不該讓資料庫爆掉');
    assert.equal(get('SELECT COUNT(*) AS n FROM assignment_questions').n, 2);
  });

  test('marks per question must be positive', async () => {
    for (const points of [0, -5]) {
      const res = await create({ pointsPerQuestion: points });
      assert.equal(res.status, 400, `每題 ${points} 分不該被接受`);
      assert.equal(res.body.error.code, 'BAD_POINTS');
    }
  });

  test('a window that closes before it opens is refused with a message', async () => {
    const res = await create({ openAt: 2_000_000_000_000, dueAt: 1_000_000_000_000 });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'WINDOW_INVERTED');
  });

  test('a reveal rule that needs a timestamp says so', async () => {
    const afterDue = await create({ reveal: 'AFTER_DUE' });
    assert.equal(afterDue.status, 400);
    assert.equal(afterDue.body.error.code, 'REVEAL_NEEDS_DUE');

    const atTime = await create({ reveal: 'AT_TIME' });
    assert.equal(atTime.status, 400);
    assert.equal(atTime.body.error.code, 'REVEAL_NEEDS_TIME');

    // …and is accepted once the timestamp is there.
    assert.equal((await create({ reveal: 'AFTER_DUE', dueAt: Date.now() + 86_400_000 })).status, 200);
  });

  test('an unknown reveal rule is refused', async () => {
    const res = await create({ reveal: 'WHENEVER' });
    assert.equal(res.body.error.code, 'BAD_REVEAL');
  });

  test('a non-positive time limit is refused', async () => {
    const res = await create({ timeLimitSeconds: 0 });
    assert.equal(res.body.error.code, 'BAD_TIME_LIMIT');
  });

  test('a single-attempt paper never stores a contradictory scoring rule', async () => {
    await create({ maxAttempts: 1, scoreStrategy: 'BEST' });
    assert.equal(get('SELECT score_strategy FROM assignments').score_strategy, 'LAST');
  });

  test('maxAttempts below one is lifted to one rather than rejected', async () => {
    assert.equal((await create({ maxAttempts: 0 })).status, 200);
    assert.equal(get('SELECT max_attempts FROM assignments').max_attempts, 1);
  });

  test('no route answers 500 for any of these', async () => {
    const bad = [
      { title: '' }, { title: '  ' }, { questionIds: [] },
      { pointsPerQuestion: -1 }, { reveal: 'AFTER_DUE' }, { reveal: 'AT_TIME' },
      { openAt: 2_000_000_000_000, dueAt: 1 }, { timeLimitSeconds: -60 },
      { questionIds: [qids[0], qids[0]] },
    ];
    for (const body of bad) {
      const res = await create(body);
      assert.notEqual(res.status, 500, `${JSON.stringify(body)} 回了 500`);
    }
  });
});

describe('the shape of an assignment on the wire', () => {
  /**
   * Every endpoint that returns an assignment returns the same fields with
   * the same meaning. maxScore used to be a number from some and null from
   * others depending on whether the call site remembered to supply it.
   */
  test('maxScore is the same wherever the assignment comes from', async () => {
    await create({ pointsPerQuestion: 3 });
    const id = get('SELECT id FROM assignments').id;
    const auth = { headers: { authorization: `Bearer ${token}` } };

    const list = await (await fetch(`${base}/api/teacher/assignments`, auth)).json();
    const published = await (await fetch(`${base}/api/teacher/assignments/${id}/publish`, {
      method: 'POST', headers: { ...auth.headers, 'content-type': 'application/json' }, body: '{}',
    })).json();
    const scores = await (await fetch(`${base}/api/teacher/assignments/${id}/scores`, auth)).json();
    const analysis = await (await fetch(`${base}/api/teacher/assignments/${id}/analysis`, auth)).json();

    const expected = qids.length * 3;
    assert.equal(list.data.assignments[0].maxScore, expected);
    assert.equal(published.data.assignment.maxScore, expected);
    assert.equal(scores.data.assignment.maxScore, expected);
    assert.equal(analysis.data.assignment.maxScore, expected);
  });

  test('the key set never varies between endpoints', async () => {
    await create({});
    const id = get('SELECT id FROM assignments').id;
    const auth = { headers: { authorization: `Bearer ${token}` } };

    const scores = await (await fetch(`${base}/api/teacher/assignments/${id}/scores`, auth)).json();
    const analysis = await (await fetch(`${base}/api/teacher/assignments/${id}/analysis`, auth)).json();
    assert.deepEqual(
      Object.keys(scores.data.assignment).sort(),
      Object.keys(analysis.data.assignment).sort(),
    );
  });
});
