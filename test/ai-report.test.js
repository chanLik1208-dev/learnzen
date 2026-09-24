import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { freshDb, makeUser, makeClass, assignTeacher, makeQuestion } from './helpers.js';
import { createApp } from '../server/app.js';
import { login } from '../server/auth.js';
import { recordAttempt } from '../server/scoring.js';
import { gatherFacts } from '../server/report-facts.js';
import { assertNoNames, aiConfig, AiError, chat } from '../server/ai.js';
import { reset } from '../server/ratelimit.js';

let server, base, tokens, s4a, s4b, alice;

before(async () => {
  server = createServer(createApp({ allowedOrigins: [], rateLimit: false }));
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

beforeEach(() => {
  freshDb();
  reset();
  delete process.env.LB_AI_KEY;

  s4a = makeClass('S4A', 'S4');
  s4b = makeClass('S4B', 'S4');
  alice = makeUser({
    username: 'alice', displayName: '陳大文', role: 'STUDENT', classId: s4a, password: 'pw-alice-123',
  });
  makeUser({ username: 'bob', displayName: '李小明', role: 'STUDENT', classId: s4a, password: 'pw-bob-123' });
  // Enrolled, never answered: the report must be able to tell the two apart.
  makeUser({ username: 'quiet', displayName: '王靜', role: 'STUDENT', classId: s4a, password: 'pw-quiet-123' });
  const teacher = makeUser({ username: 'chan', role: 'TEACHER', password: 'pw-chan-123' });
  makeUser({ username: 'wong', role: 'TEACHER', password: 'pw-wong-123' });
  assignTeacher(s4a, teacher.id);

  tokens = {
    alice: login('alice', 'pw-alice-123').accessToken,
    teacher: login('chan', 'pw-chan-123').accessToken,
    outsider: login('wong', 'pw-wong-123').accessToken,
  };

  for (let i = 0; i < 3; i += 1) {
    recordAttempt({ userId: alice.id, questionId: makeQuestion({ topicId: 1, correct: 'A' }), chosen: 'A' });
  }
  recordAttempt({ userId: alice.id, questionId: makeQuestion({ topicId: 1, correct: 'A' }), chosen: 'B' });
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

describe('what leaves the building', () => {
  /**
   * The whole point. These figures are sent to somebody else's service, in
   * somebody else's jurisdiction, about children — and a name, once sent,
   * cannot be unsent.
   */
  test('no student name appears anywhere in the payload', () => {
    const { facts, names } = gatherFacts(s4a, 1);
    const payload = JSON.stringify(facts);

    for (const name of names) {
      assert.ok(!payload.includes(name), `「${name}」不該出現在送出的資料裡`);
    }
    assert.ok(payload.includes('學生1'), '學生要以代號出現');
  });

  test('the mapping back to real people stays here', () => {
    const { alias, names } = gatherFacts(s4a, 1);
    assert.equal(alias.size, names.length);
    assert.ok([...alias.values()].every((a) => /^學生\d+$/.test(a)));
  });

  test('the guard refuses a payload that still carries a name', () => {
    assert.throws(
      () => assertNoNames({ note: '陳大文答得不錯' }, ['陳大文']),
      (err) => err instanceof AiError && err.code === 'NAME_LEAK',
    );
    assert.doesNotThrow(() => assertNoNames({ note: '學生1答得不錯' }, ['陳大文']));
  });

  test('the figures distinguish never-started from low-scoring', () => {
    const { facts } = gatherFacts(s4a, 1);
    assert.equal(facts.neverStarted, 2, '沒作答的人要單獨算，不能混進平均');

    const idle = facts.students.filter((s) => s.answered === 0);
    assert.ok(idle.every((s) => s.accuracyPercent === null), '沒作答就是 null，不是 0%');
    assert.equal(facts.classAccuracyPercent, 75, '平均只算有練習的人');
  });
});

describe('when no key is configured', () => {
  test('the feature reports itself as unavailable, with the reason', async () => {
    const res = await call('GET', `/api/teacher/classes/${s4a}/ai-reports`, { token: tokens.teacher });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.available, false);
    assert.match(res.body.data.disabledReason, /LB_AI_KEY/);
    assert.deepEqual(res.body.data.reports, []);
  });

  /** A missing key is a configuration state, not a server fault. */
  test('generating says so cleanly rather than failing as an error', async () => {
    const res = await call('POST', `/api/teacher/classes/${s4a}/ai-report`, {
      token: tokens.teacher, body: {},
    });
    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, 'AI_DISABLED');
  });

  test('the client refuses to call out with no key', async () => {
    await assert.rejects(() => chat([{ role: 'user', content: 'hi' }]), { code: 'AI_DISABLED' });
  });

  test('configuration defaults to DeepSeek', () => {
    delete process.env.LB_AI_BASE_URL;
    delete process.env.LB_AI_MODEL;
    const config = aiConfig();
    assert.equal(config.baseUrl, 'https://api.deepseek.com');
    assert.equal(config.model, 'deepseek-chat');
    assert.equal(config.enabled, false);
  });
});

describe('who may do what', () => {
  test('a student reaches none of it', async () => {
    assert.equal((await call('GET', `/api/teacher/classes/${s4a}/ai-reports`, {
      token: tokens.alice,
    })).status, 403);
    assert.equal((await call('POST', `/api/teacher/classes/${s4a}/ai-report`, {
      token: tokens.alice, body: {},
    })).status, 403);
  });

  test('a teacher cannot read or generate for a class they do not teach', async () => {
    assert.equal((await call('GET', `/api/teacher/classes/${s4b}/ai-reports`, {
      token: tokens.teacher,
    })).status, 403);
    assert.equal((await call('GET', `/api/teacher/classes/${s4a}/ai-reports`, {
      token: tokens.outsider,
    })).status, 403);
  });
});

describe('a class with nothing to say about it', () => {
  test('is refused before anything is sent or charged for', async () => {
    process.env.LB_AI_KEY = 'test-key-not-used';
    const res = await call('POST', `/api/teacher/classes/${s4b}/ai-report`, {
      token: tokens.teacher, body: {},
    });
    // Scope is checked first; the teacher does not have S4B at all.
    assert.equal(res.status, 403);

    const emptyClass = makeClass('S4C', 'S4');
    assignTeacher(emptyClass, 4);
    const empty = await call('POST', `/api/teacher/classes/${emptyClass}/ai-report`, {
      token: tokens.teacher, body: {},
    });
    assert.equal(empty.body.error.code, 'NOT_ENOUGH_DATA');
  });
});
