import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { freshDb, makeUser, makeClass, assignTeacher } from './helpers.js';
import { createApp } from '../server/app.js';
import { login, verifyAccessToken } from '../server/auth.js';
import { get, all } from '../server/db.js';

let server, base, tokens, s4a, s4b, alice, bob, teacher, outsider, admin;

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
  bob = makeUser({ username: 'bob', role: 'STUDENT', classId: s4b, password: 'pw-bob-123' });
  teacher = makeUser({ username: 'chan', role: 'TEACHER', password: 'pw-chan-123' });
  outsider = makeUser({ username: 'wong', role: 'TEACHER', password: 'pw-wong-123' });
  admin = makeUser({ username: 'root', role: 'ADMIN', password: 'pw-root-123' });
  assignTeacher(s4a, teacher.id);

  tokens = {
    alice: login('alice', 'pw-alice-123').accessToken,
    teacher: login('chan', 'pw-chan-123').accessToken,
    outsider: login('wong', 'pw-wong-123').accessToken,
    admin: login('root', 'pw-root-123').accessToken,
  };
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

const newStudent = (extra = {}) => ({
  username: 'newbie', displayName: '新同學', password: 'pw-newbie-123',
  role: 'STUDENT', classId: s4a, ...extra,
});

describe('creating accounts', () => {
  test('a teacher enrols a student into a class they teach', async () => {
    const res = await call('POST', '/api/staff/users', { token: tokens.teacher, body: newStudent() });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.user.role, 'STUDENT');
    assert.equal(res.body.data.user.classId, s4a);

    // …and the new account actually works.
    assert.equal(login('newbie', 'pw-newbie-123').user.username, 'newbie');
  });

  test('a student cannot create anyone', async () => {
    const res = await call('POST', '/api/staff/users', { token: tokens.alice, body: newStudent() });
    assert.equal(res.status, 403);
  });

  /**
   * The escalation this whole module is shaped around: a teacher account must
   * not be usable to manufacture an account with more power than it has.
   */
  test('a teacher cannot create a teacher or an administrator', async () => {
    for (const role of ['TEACHER', 'ADMIN']) {
      const res = await call('POST', '/api/staff/users', {
        token: tokens.teacher, body: newStudent({ role, username: `x-${role}` }),
      });
      assert.equal(res.status, 403, `教師不該能建立 ${role}`);
      assert.equal(get('SELECT COUNT(*) AS n FROM users WHERE username = ?', `x-${role}`).n, 0);
    }
  });

  test('an administrator can create staff', async () => {
    const res = await call('POST', '/api/staff/users', {
      token: tokens.admin,
      body: { username: 'newteacher', displayName: '新老師', password: 'pw-teach-123', role: 'TEACHER' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.user.role, 'TEACHER');
  });

  test('a teacher cannot enrol into a class they do not teach', async () => {
    const res = await call('POST', '/api/staff/users', {
      token: tokens.teacher, body: newStudent({ classId: s4b }),
    });
    assert.equal(res.status, 403);
  });

  test('a student must be given a class', async () => {
    const res = await call('POST', '/api/staff/users', {
      token: tokens.teacher, body: newStudent({ classId: null }),
    });
    assert.equal(res.body.error.code, 'CLASS_REQUIRED');
  });

  test('usernames are unique, and the clash says so', async () => {
    const res = await call('POST', '/api/staff/users', {
      token: tokens.teacher, body: newStudent({ username: 'alice' }),
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'USERNAME_TAKEN');
  });

  test('a weak password or a malformed username is refused', async () => {
    const weak = await call('POST', '/api/staff/users', {
      token: tokens.teacher, body: newStudent({ password: 'short' }),
    });
    assert.equal(weak.body.error.code, 'WEAK_PASSWORD');

    for (const username of ['ab', 'has space', '中文帳號', '']) {
      const res = await call('POST', '/api/staff/users', {
        token: tokens.teacher, body: newStudent({ username }),
      });
      assert.equal(res.body.error.code, 'BAD_USERNAME', `${username} 應被拒`);
    }
  });
});

describe('bulk enrolment', () => {
  test('good rows are created even when one is bad', async () => {
    const res = await call('POST', '/api/staff/users/import', {
      token: tokens.teacher,
      body: {
        classId: s4a,
        students: [
          { username: 's101', displayName: '甲', password: 'pw-s101-123' },
          { username: 'alice', displayName: '撞名', password: 'pw-dupe-123' },
          { username: 's102', displayName: '乙', password: 'pw-s102-123' },
        ],
      },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.createdCount, 2, '一筆壞資料不該拖垮其他筆');
    assert.equal(res.body.data.failedCount, 1);
    assert.equal(res.body.data.failed[0].username, 'alice');
  });

  test('importing into another teacher\'s class is refused', async () => {
    const res = await call('POST', '/api/staff/users/import', {
      token: tokens.teacher,
      body: { classId: s4b, students: [{ username: 's103', password: 'pw-s103-123' }] },
    });
    assert.equal(res.status, 403);
  });

  test('an empty or oversized list is refused', async () => {
    assert.equal((await call('POST', '/api/staff/users/import', {
      token: tokens.teacher, body: { classId: s4a, students: [] },
    })).status, 400);

    const many = Array.from({ length: 201 }, (_, i) => ({ username: `s${i}`, password: 'pw-long-1234' }));
    const res = await call('POST', '/api/staff/users/import', {
      token: tokens.teacher, body: { classId: s4a, students: many },
    });
    assert.equal(res.body.error.code, 'TOO_MANY');
  });
});

describe('listing accounts', () => {
  test('a teacher sees only students of their own classes', async () => {
    const res = await call('GET', '/api/staff/users', { token: tokens.teacher });
    const names = res.body.data.users.map((u) => u.username);
    assert.deepEqual(names, ['alice'], '名單不該變成繞過逐人檢查的方法');
    assert.equal(res.body.data.mayManageStaff, false);
  });

  test('an administrator sees everyone', async () => {
    const res = await call('GET', '/api/staff/users', { token: tokens.admin });
    assert.ok(res.body.data.users.length >= 5);
    assert.equal(res.body.data.mayManageStaff, true);
  });

  test('a teacher with no classes sees nobody', async () => {
    const res = await call('GET', '/api/staff/users', { token: tokens.outsider });
    assert.deepEqual(res.body.data.users, []);
  });

  test('a student cannot list accounts', async () => {
    assert.equal((await call('GET', '/api/staff/users', { token: tokens.alice })).status, 403);
  });
});

describe('changing an account', () => {
  test('a teacher may rename their own student', async () => {
    const res = await call('PATCH', `/api/staff/users/${alice.id}`, {
      token: tokens.teacher, body: { displayName: '陳同學' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.user.displayName, '陳同學');
  });

  test('a teacher may not change a role or a status', async () => {
    for (const body of [{ role: 'ADMIN' }, { role: 'TEACHER' }, { status: 'DISABLED' }]) {
      const res = await call('PATCH', `/api/staff/users/${alice.id}`, { token: tokens.teacher, body });
      assert.equal(res.status, 403, `教師不該能設 ${JSON.stringify(body)}`);
    }
    assert.equal(get('SELECT role FROM users WHERE id = ?', alice.id).role, 'STUDENT');
  });

  test('a teacher may not touch a student outside their classes', async () => {
    const res = await call('PATCH', `/api/staff/users/${bob.id}`, {
      token: tokens.teacher, body: { displayName: '改別班的' },
    });
    assert.equal(res.status, 403);
  });

  test('promoting someone ends their live sessions at once', async () => {
    const aliceToken = tokens.alice;
    assert.ok(verifyAccessToken(aliceToken), '先確認原本有效');

    await call('PATCH', `/api/staff/users/${alice.id}`, {
      token: tokens.admin, body: { role: 'TEACHER' },
    });
    assert.equal(verifyAccessToken(aliceToken), null, '角色變了就不該還握著舊 token');
  });

  test('disabling an account ends its sessions and blocks login', async () => {
    await call('PATCH', `/api/staff/users/${alice.id}`, {
      token: tokens.admin, body: { status: 'DISABLED' },
    });
    assert.equal(verifyAccessToken(tokens.alice), null);
    assert.throws(() => login('alice', 'pw-alice-123'), { code: 'DISABLED' });
  });

  /** Locking yourself out is a mistake with no way back. */
  test('an administrator cannot demote or disable themselves', async () => {
    const demote = await call('PATCH', `/api/staff/users/${admin.id}`, {
      token: tokens.admin, body: { role: 'TEACHER' },
    });
    assert.equal(demote.body.error.code, 'CANNOT_DEMOTE_SELF');

    const disable = await call('PATCH', `/api/staff/users/${admin.id}`, {
      token: tokens.admin, body: { status: 'DISABLED' },
    });
    assert.equal(disable.body.error.code, 'CANNOT_DISABLE_SELF');
  });

  /**
   * Rows are disabled, never deleted: a student's attempts and marks cascade
   * from their row, so removing it would take a term of grades with it.
   */
  test('there is no way to delete an account', async () => {
    const res = await call('DELETE', `/api/staff/users/${alice.id}`, { token: tokens.admin });
    assert.equal(res.status, 405, '刪除帳號會連同成績一起消失，所以根本不提供');
  });
});

describe('resetting a password', () => {
  test('a teacher resets their own student, and every session ends', async () => {
    const res = await call('POST', `/api/staff/users/${alice.id}/password`, {
      token: tokens.teacher, body: { newPassword: 'fresh-password-1' },
    });
    assert.equal(res.status, 200);
    assert.equal(verifyAccessToken(tokens.alice), null);
    assert.equal(login('alice', 'fresh-password-1').user.username, 'alice');
    assert.throws(() => login('alice', 'pw-alice-123'));
  });

  test('a teacher cannot reset a student in another class, or a colleague', async () => {
    assert.equal((await call('POST', `/api/staff/users/${bob.id}/password`, {
      token: tokens.teacher, body: { newPassword: 'fresh-password-1' },
    })).status, 403);

    assert.equal((await call('POST', `/api/staff/users/${outsider.id}/password`, {
      token: tokens.teacher, body: { newPassword: 'fresh-password-1' },
    })).status, 404, '對教師走學生的閘是「找不到」，不是洩漏存在');
  });

  test('a short password is refused', async () => {
    const res = await call('POST', `/api/staff/users/${alice.id}/password`, {
      token: tokens.teacher, body: { newPassword: 'abc' },
    });
    assert.equal(res.body.error.code, 'WEAK_PASSWORD');
  });
});

describe('classes', () => {
  test('only an administrator manages classes', async () => {
    assert.equal((await call('GET', '/api/admin/classes', { token: tokens.teacher })).status, 403);
    assert.equal((await call('POST', '/api/admin/classes', {
      token: tokens.teacher, body: { name: 'S5A', grade: 'S5' },
    })).status, 403);
  });

  test('an administrator creates a class and assigns teachers to it', async () => {
    const created = await call('POST', '/api/admin/classes', {
      token: tokens.admin, body: { name: 'S5A', grade: 'S5' },
    });
    assert.equal(created.status, 200);
    const classId = created.body.data.class.id;

    const assigned = await call('PUT', `/api/admin/classes/${classId}/teachers`, {
      token: tokens.admin, body: { teacherIds: [teacher.id] },
    });
    assert.equal(assigned.status, 200);

    // The teacher can now act on it, which is the point of assigning.
    const listed = await call('GET', '/api/teacher/classes', { token: tokens.teacher });
    assert.ok(listed.body.data.classes.some((c) => c.id === classId));
  });

  test('a duplicate class name is refused', async () => {
    const res = await call('POST', '/api/admin/classes', {
      token: tokens.admin, body: { name: 'S4A', grade: 'S4' },
    });
    assert.equal(res.body.error.code, 'CLASS_EXISTS');
  });

  test('a student cannot be assigned as a class teacher', async () => {
    const res = await call('PUT', `/api/admin/classes/${s4a}/teachers`, {
      token: tokens.admin, body: { teacherIds: [alice.id] },
    });
    assert.equal(res.body.error.code, 'NOT_STAFF');
  });

  test('assigning replaces the previous set rather than adding to it', async () => {
    await call('PUT', `/api/admin/classes/${s4a}/teachers`, {
      token: tokens.admin, body: { teacherIds: [outsider.id] },
    });
    const rows = all('SELECT teacher_id FROM class_teachers WHERE class_id = ?', s4a);
    assert.deepEqual(rows.map((r) => r.teacher_id), [outsider.id]);
  });
});

describe('initial passwords on bulk enrolment', () => {
  /**
   * The first version fell back to the username, which is both a bad password
   * and usually too short to pass validation — so rows silently failed.
   */
  test('a row with no password still gets an account, and one that can sign in', async () => {
    const res = await call('POST', '/api/staff/users/import', {
      token: tokens.teacher,
      body: { classId: s4a, students: [{ username: 's201', displayName: '新生甲' }] },
    });
    assert.equal(res.body.data.createdCount, 1, '短學號不該因為預設密碼太短而失敗');

    const row = res.body.data.created[0];
    assert.equal(row.generated, true);
    assert.ok(row.password.length >= 8);
    assert.equal(login('s201', row.password).user.username, 's201', '回傳的密碼必須真的能登入');
  });

  test('the password is never the username', async () => {
    const res = await call('POST', '/api/staff/users/import', {
      token: tokens.teacher,
      body: { classId: s4a, students: [{ username: 'somebodylong' }] },
    });
    assert.notEqual(res.body.data.created[0].password, 'somebodylong');
  });

  test('a supplied password is kept and marked as not generated', async () => {
    const res = await call('POST', '/api/staff/users/import', {
      token: tokens.teacher,
      body: { classId: s4a, students: [{ username: 's202', password: 'chosen-pw-123' }] },
    });
    assert.equal(res.body.data.created[0].password, 'chosen-pw-123');
    assert.equal(res.body.data.created[0].generated, false);
  });
});
