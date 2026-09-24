import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { freshDb, makeUser, makeClass, assignTeacher, makeQuestion } from './helpers.js';
import { createApp } from '../server/app.js';
import { login } from '../server/auth.js';
import { get, run } from '../server/db.js';
import { scoreFor } from '../server/live.js';

let server, base, tokens, s4a, s4b, alice, bob, outsiderStudent, teacher, qids;

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
  outsiderStudent = makeUser({ username: 'carol', role: 'STUDENT', classId: s4b, password: 'pw-carol-123' });
  teacher = makeUser({ username: 'chan', role: 'TEACHER', password: 'pw-chan-123' });
  assignTeacher(s4a, teacher.id);

  tokens = {
    alice: login('alice', 'pw-alice-123').accessToken,
    bob: login('bob', 'pw-bob-123').accessToken,
    carol: login('carol', 'pw-carol-123').accessToken,
    teacher: login('chan', 'pw-chan-123').accessToken,
  };
  qids = [makeQuestion({ correct: 'A' }), makeQuestion({ correct: 'B' })];
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

const host = async (extra = {}) => {
  const res = await call('POST', '/api/teacher/live', {
    token: tokens.teacher,
    body: { title: '課堂測驗', classId: s4a, questionIds: qids, seconds: 30, ...extra },
  });
  return res.body.data.session;
};

/**
 * Read a few events off the stream, then hang up. A plain reader rather than
 * an EventSource, because this runs in Node.
 */
async function readStream(path, token, { events = 1, timeoutMs = 3000 } = {}) {
  const controller = new AbortController();
  const res = await fetch(`${base}${path}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: controller.signal,
  });
  const frames = [];
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (frames.length < events) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (const chunk of buffer.split('\n\n')) {
        const nameLine = chunk.match(/^event: (\w+)$/m);
        const dataLine = chunk.match(/^data: (.*)$/m);
        if (nameLine && dataLine) frames.push({ event: nameLine[1], data: JSON.parse(dataLine[1]) });
      }
      buffer = buffer.slice(buffer.lastIndexOf('\n\n') + 2);
    }
  } catch { /* aborted */ } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return { status: res.status, frames };
}

describe('starting a room', () => {
  test('a teacher opens one and gets a code', async () => {
    const session = await host();
    assert.match(session.code, /^[A-Z2-9]{5}$/);
    assert.equal(session.status, 'LOBBY');
    assert.equal(session.questionCount, 2);
  });

  test('a code avoids characters that get misread aloud', async () => {
    const session = await host();
    assert.ok(!/[O0I1]/.test(session.code), '唸出來會被聽錯的字元不該出現在代碼裡');
  });

  test('a student cannot host', async () => {
    const res = await call('POST', '/api/teacher/live', {
      token: tokens.alice, body: { questionIds: qids },
    });
    assert.equal(res.status, 403);
  });

  test('a question with no answer key cannot be put on screen', async () => {
    const bad = makeQuestion({ correct: [] });
    const res = await call('POST', '/api/teacher/live', {
      token: tokens.teacher, body: { questionIds: [bad] },
    });
    assert.equal(res.body.error.code, 'NO_ANSWER_KEY');
  });
});

describe('joining', () => {
  test('a student of the class joins; one from another class cannot', async () => {
    const session = await host();
    assert.equal((await call('POST', `/api/live/${session.code}/join`, { token: tokens.alice })).status, 200);
    assert.equal((await call('POST', `/api/live/${session.code}/join`, { token: tokens.carol })).status, 403);
  });

  test('a room with no class is open to anyone with the code', async () => {
    const session = await host({ classId: null });
    assert.equal((await call('POST', `/api/live/${session.code}/join`, { token: tokens.carol })).status, 200);
  });

  test('joining twice is not an error and does not duplicate', async () => {
    const session = await host();
    await call('POST', `/api/live/${session.code}/join`, { token: tokens.alice });
    await call('POST', `/api/live/${session.code}/join`, { token: tokens.alice });
    assert.equal(get('SELECT COUNT(*) AS n FROM live_participants').n, 1);
  });

  test('a wrong or ended code is a clear miss', async () => {
    assert.equal((await call('POST', '/api/live/ZZZZZ/join', { token: tokens.alice })).status, 404);

    const session = await host();
    await call('POST', `/api/teacher/live/${session.sessionId}/end`, { token: tokens.teacher });
    assert.equal((await call('POST', `/api/live/${session.code}/join`, { token: tokens.alice })).status, 404);
  });
});

describe('answering', () => {
  let session;
  beforeEach(async () => {
    session = await host();
    await call('POST', `/api/live/${session.code}/join`, { token: tokens.alice });
    await call('POST', `/api/live/${session.code}/join`, { token: tokens.bob });
  });

  const ask = () => call('POST', `/api/teacher/live/${session.sessionId}/next`, { token: tokens.teacher });
  const answer = (token, chosen) => call('POST', `/api/live/${session.code}/answer`, { token, body: { chosen } });

  test('nobody can answer before a question is up', async () => {
    const res = await answer(tokens.alice, 'A');
    assert.equal(res.body.error.code, 'NOT_ASKING');
  });

  test('someone who never joined cannot answer', async () => {
    await ask();
    const res = await answer(tokens.carol, 'A');
    assert.ok(['NOT_JOINED', 'FORBIDDEN'].includes(res.body.error.code));
  });

  /** Otherwise the first to answer can simply tell the room. */
  test('answering does not reveal whether it was right', async () => {
    await ask();
    const res = await answer(tokens.alice, 'A');
    assert.equal(res.status, 200);
    assert.equal(res.body.data.revealed, false);
    assert.equal(res.body.data.points, undefined);
    assert.ok(!('isCorrect' in res.body.data));
    assert.ok(!JSON.stringify(res.body.data).includes('correctLabels'));
  });

  test('a live round is one shot per question', async () => {
    await ask();
    await answer(tokens.alice, 'A');
    const again = await answer(tokens.alice, 'B');
    assert.equal(again.body.error.code, 'ALREADY_ANSWERED');
  });

  test('an answer after the deadline is refused, by the server\'s clock', async () => {
    await ask();
    // Pretend the question went up a minute ago; the limit is thirty seconds.
    run('UPDATE live_sessions SET asked_at = ? WHERE id = ?', Date.now() - 60_000, session.sessionId);
    const res = await answer(tokens.alice, 'A');
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'TOO_LATE');
  });

  test('marks are the server\'s: faster is worth more, wrong is worth nothing', () => {
    const limit = 30_000;
    assert.equal(scoreFor(false, 0, limit), 0, '答錯不論多快都是 0');
    assert.ok(scoreFor(true, 0, limit) > scoreFor(true, limit, limit), '快的分數比慢的高');
    assert.ok(scoreFor(true, limit, limit) > 0, '壓線答對仍然有分');
    assert.ok(scoreFor(true, limit, limit) > scoreFor(false, 0, limit), '最慢的答對也勝過最快的答錯');
  });

  test('the leaderboard appears only once the host reveals', async () => {
    await ask();
    await answer(tokens.alice, 'A');

    const during = await readStream(`/api/live/${session.code}/stream`, tokens.alice, { events: 1 });
    assert.deepEqual(during.frames[0].data.leaderboard, [], '題目還開著就不該看到排行');

    await call('POST', `/api/teacher/live/${session.sessionId}/reveal`, { token: tokens.teacher });
    const after = await readStream(`/api/live/${session.code}/stream`, tokens.alice, { events: 1 });
    assert.ok(after.frames[0].data.leaderboard.length > 0);
    assert.ok(after.frames[0].data.breakdown, '公開後才給答案分布');
  });
});

describe('the event stream', () => {
  test('a client that connects is told the current state at once', async () => {
    const session = await host();
    await call('POST', `/api/live/${session.code}/join`, { token: tokens.alice });

    const { status, frames } = await readStream(`/api/live/${session.code}/stream`, tokens.alice, { events: 1 });
    assert.equal(status, 200);
    assert.equal(frames[0].event, 'state');
    assert.equal(frames[0].data.status, 'LOBBY');
  });

  test('the host gets host frames, a student gets state frames', async () => {
    const session = await host();
    const asHost = await readStream(`/api/teacher/live/${session.sessionId}/stream`, tokens.teacher, { events: 1 });
    assert.equal(asHost.frames[0].event, 'host');

    // And the student door is not a way in for the host's view, nor the
    // reverse — the two permissions stay separate.
    const wrongDoor = await fetch(`${base}/api/teacher/live/${session.sessionId}/stream`, {
      headers: { authorization: `Bearer ${tokens.alice}` },
    });
    assert.equal(wrongDoor.status, 403);
  });

  /** A student reconnecting mid-question must not be handed the key. */
  test('a student joining mid-question is not sent the answer', async () => {
    const session = await host();
    await call('POST', `/api/live/${session.code}/join`, { token: tokens.alice });
    await call('POST', `/api/teacher/live/${session.sessionId}/next`, { token: tokens.teacher });

    const { frames } = await readStream(`/api/live/${session.code}/stream`, tokens.alice, { events: 1 });
    const frame = frames[0].data;
    assert.equal(frame.status, 'QUESTION');
    assert.ok(frame.question, '題目要送');
    assert.equal(frame.question.correctLabels, undefined, '答案不送');
    assert.ok(frame.question.options.every((o) => o.isCorrect === false));
    assert.equal(frame.breakdown, null);
  });

  test('the deadline is an absolute instant, not a number of seconds left', async () => {
    const session = await host();
    await call('POST', `/api/live/${session.code}/join`, { token: tokens.alice });
    await call('POST', `/api/teacher/live/${session.sessionId}/next`, { token: tokens.teacher });

    const { frames } = await readStream(`/api/live/${session.code}/stream`, tokens.alice, { events: 1 });
    const frame = frames[0].data;
    assert.ok(frame.deadlineAt > frame.serverTime);
    assert.equal(frame.deadlineAt - frame.serverTime <= 30_000, true);
  });
});

describe('running through and ending', () => {
  test('advancing past the last question ends the room', async () => {
    const session = await host();
    const next = () => call('POST', `/api/teacher/live/${session.sessionId}/next`, { token: tokens.teacher });

    assert.equal((await next()).body.data.session.seq, 1);
    assert.equal((await next()).body.data.session.seq, 2);
    const ended = await next();
    assert.equal(ended.body.data.session.status, 'ENDED');
  });

  test('only the host advances it', async () => {
    const session = await host();
    const res = await call('POST', `/api/teacher/live/${session.sessionId}/next`, { token: tokens.alice });
    assert.equal(res.status, 403);
  });

  test('another teacher cannot drive someone else\'s room', async () => {
    const other = makeUser({ username: 'wong', role: 'TEACHER', password: 'pw-wong-123' });
    const otherToken = login('wong', 'pw-wong-123').accessToken;
    const session = await host();

    const res = await call('POST', `/api/teacher/live/${session.sessionId}/next`, { token: otherToken });
    assert.equal(res.status, 403);
    void other;
  });

  test('revealing requires a question to be up', async () => {
    const session = await host();
    const res = await call('POST', `/api/teacher/live/${session.sessionId}/reveal`, { token: tokens.teacher });
    assert.equal(res.body.error.code, 'NOT_ASKING');
  });

  test('ending twice is not an error', async () => {
    const session = await host();
    await call('POST', `/api/teacher/live/${session.sessionId}/end`, { token: tokens.teacher });
    const again = await call('POST', `/api/teacher/live/${session.sessionId}/end`, { token: tokens.teacher });
    assert.equal(again.status, 200);
  });

  test('the monitor shows who has answered the question on screen', async () => {
    const session = await host();
    await call('POST', `/api/live/${session.code}/join`, { token: tokens.alice });
    await call('POST', `/api/live/${session.code}/join`, { token: tokens.bob });
    await call('POST', `/api/teacher/live/${session.sessionId}/next`, { token: tokens.teacher });
    await call('POST', `/api/live/${session.code}/answer`, { token: tokens.alice, body: { chosen: 'A' } });

    const res = await call('GET', `/api/teacher/live/${session.sessionId}/monitor`, { token: tokens.teacher });
    const rows = res.body.data.participants;
    assert.equal(rows.find((r) => r.userId === alice.id).answeredCurrent, true);
    assert.equal(rows.find((r) => r.userId === bob.id).answeredCurrent, false);
  });

  test('a student cannot read the monitor', async () => {
    const session = await host();
    assert.equal(
      (await call('GET', `/api/teacher/live/${session.sessionId}/monitor`, { token: tokens.alice })).status,
      403,
    );
  });
});

describe('each connection gets its own frame', () => {
  /**
   * The broadcast used to be one frame sent to everyone, so `myAnswer` was
   * null for all of them and nobody was ever told their own result.
   */
  test('two students are told their own results, not each other\'s', async () => {
    const session = await host();
    await call('POST', `/api/live/${session.code}/join`, { token: tokens.alice });
    await call('POST', `/api/live/${session.code}/join`, { token: tokens.bob });
    await call('POST', `/api/teacher/live/${session.sessionId}/next`, { token: tokens.teacher });

    await call('POST', `/api/live/${session.code}/answer`, { token: tokens.alice, body: { chosen: 'A' } });
    await call('POST', `/api/live/${session.code}/answer`, { token: tokens.bob, body: { chosen: 'B' } });
    await call('POST', `/api/teacher/live/${session.sessionId}/reveal`, { token: tokens.teacher });

    const path = `/api/live/${session.code}/stream`;
    const forAlice = (await readStream(path, tokens.alice, { events: 1 })).frames[0].data;
    const forBob = (await readStream(path, tokens.bob, { events: 1 })).frames[0].data;

    assert.ok(forAlice.myAnswer, 'alice 要看得到自己的作答');
    assert.ok(forBob.myAnswer, 'bob 要看得到自己的作答');
    assert.equal(forAlice.myAnswer.chosen, 'A');
    assert.equal(forBob.myAnswer.chosen, 'B');
    assert.equal(forAlice.myAnswer.is_correct, 1, 'A 是這題的正確答案');
    assert.equal(forBob.myAnswer.is_correct, 0);
  });

  test('a student is not sent the host view, and vice versa', async () => {
    const session = await host();
    await call('POST', `/api/live/${session.code}/join`, { token: tokens.alice });
    await call('POST', `/api/teacher/live/${session.sessionId}/next`, { token: tokens.teacher });

    const student = (await readStream(`/api/live/${session.code}/stream`, tokens.alice, { events: 1 })).frames[0];
    assert.equal(student.event, 'state');
    assert.equal(student.data.tally, null, '題目還開著，學生不該看到有多少人答了');

    const asHost = (await readStream(
      `/api/teacher/live/${session.sessionId}/stream`, tokens.teacher, { events: 1 },
    )).frames[0];
    assert.equal(asHost.event, 'host');
    assert.ok(asHost.data.tally, '主持人要看得到進度');
  });
});
