import { test, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, makeUser, makeClass, assignTeacher } from './helpers.js';
import { run, now } from '../server/db.js';
import {
  can, requirePermission, assertSelf, assertTeachesClass, assertCanReadStudent,
  loadAssignmentFor, mayRevealAnswers, ForbiddenError, NotFoundError,
  PERMISSIONS, ALL_PERMISSIONS,
} from '../server/rbac.js';

let s4a, s4b, alice, bob, teacher, other, admin;

beforeEach(() => {
  freshDb();
  s4a = makeClass('S4A', 'S4');
  s4b = makeClass('S4B', 'S4');
  alice = makeUser({ username: 'alice', role: 'STUDENT', classId: s4a });
  bob = makeUser({ username: 'bob', role: 'STUDENT', classId: s4b });
  teacher = makeUser({ username: 'chan', role: 'TEACHER' });
  other = makeUser({ username: 'wong', role: 'TEACHER' });
  admin = makeUser({ username: 'root', role: 'ADMIN' });
  assignTeacher(s4a, teacher.id);
});

function makeAssignment({ classId = s4a, status = 'PUBLISHED', openAt = null, dueAt = null, reveal = 'AFTER_SUBMIT' } = {}) {
  const t = now();
  const r = run(
    `INSERT INTO assignments (code, title, subject_id, class_id, created_by, kind, open_at, due_at, reveal, status, created_at, updated_at)
     VALUES (?, ?, 1, ?, ?, 'HOMEWORK', ?, ?, ?, ?, ?, ?)`,
    `HW-${Math.random().toString(36).slice(2, 8)}`, '測驗', classId, teacher.id, openAt, dueAt, reveal, status, t, t,
  );
  return Number(r.lastInsertRowid);
}

describe('permission catalogue', () => {
  test('students hold no teacher or admin powers', () => {
    for (const p of ['question.bank.write', 'assignment.manage', 'user.manage', 'analytics.read', 'audit.read']) {
      assert.equal(can(alice, p), false, `學生不應有 ${p}`);
    }
  });

  test('teachers cannot manage users or read the audit log', () => {
    assert.equal(can(teacher, 'user.manage'), false);
    assert.equal(can(teacher, 'audit.read'), false);
    assert.equal(can(teacher, 'topic.manage'), false);
  });

  test('admins are not silently granted student-only actions', () => {
    assert.equal(can(admin, 'practice.run'), false);
    assert.equal(can(admin, 'assignment.self.attempt'), false);
  });

  test('an unauthenticated caller holds nothing', () => {
    assert.equal(can(null, 'self.read'), false);
    assert.equal(can(undefined, 'topic.list'), false);
    assert.equal(can({ role: 'STUDENT' }, 'self.read'), true);
    assert.equal(can({ role: 'GOD' }, 'self.read'), false);
  });

  test('requirePermission throws for a missing permission and passes otherwise', () => {
    assert.throws(() => requirePermission(alice, 'user.manage'), ForbiddenError);
    assert.doesNotThrow(() => requirePermission(alice, 'practice.run'));
  });

  test('every role grants only catalogued permission strings', () => {
    for (const list of Object.values(PERMISSIONS)) {
      for (const p of list) assert.ok(ALL_PERMISSIONS.has(p));
    }
  });
});

describe('scope: self', () => {
  test('a student may address their own id and no other', () => {
    assert.equal(assertSelf(alice, alice.id), alice.id);
    assert.equal(assertSelf(alice, String(alice.id)), alice.id);
    assert.throws(() => assertSelf(alice, bob.id), ForbiddenError);
  });
});

describe('scope: classes', () => {
  test('a teacher reaches only their assigned classes', () => {
    assert.doesNotThrow(() => assertTeachesClass(teacher, s4a));
    assert.throws(() => assertTeachesClass(teacher, s4b), ForbiddenError);
  });

  test('a teacher with no assignments reaches nothing', () => {
    assert.throws(() => assertTeachesClass(other, s4a), ForbiddenError);
  });

  test('an admin reaches every class', () => {
    assert.doesNotThrow(() => assertTeachesClass(admin, s4b));
  });

  test('a student never passes a class gate', () => {
    assert.throws(() => assertTeachesClass(alice, s4a), ForbiddenError);
  });
});

describe('scope: students', () => {
  test('a teacher reads a student in their class but not one outside it', () => {
    assert.equal(assertCanReadStudent(teacher, alice.id), alice.id);
    assert.throws(() => assertCanReadStudent(teacher, bob.id), ForbiddenError);
  });

  test('a student reading another student is refused', () => {
    assert.throws(() => assertCanReadStudent(alice, bob.id), ForbiddenError);
    assert.equal(assertCanReadStudent(alice, alice.id), alice.id);
  });

  test('asking for a teacher id through the student gate is a miss, not a leak', () => {
    assert.throws(() => assertCanReadStudent(admin, teacher.id), NotFoundError);
    assert.throws(() => assertCanReadStudent(teacher, 99999), NotFoundError);
  });

  test('moving a student out of the class removes the teacher access', () => {
    run('UPDATE users SET class_id = ? WHERE id = ?', s4b, alice.id);
    assert.throws(() => assertCanReadStudent(teacher, alice.id), ForbiddenError);
  });
});

describe('scope: assignments', () => {
  test('a student sees a published assignment for their own class only', () => {
    const mine = makeAssignment({ classId: s4a });
    const theirs = makeAssignment({ classId: s4b });
    assert.equal(loadAssignmentFor(alice, mine, 'attempt').id, mine);
    assert.throws(() => loadAssignmentFor(alice, theirs, 'attempt'), NotFoundError);
  });

  test('a draft assignment is invisible to students', () => {
    const draft = makeAssignment({ status: 'DRAFT' });
    assert.throws(() => loadAssignmentFor(alice, draft, 'attempt'), NotFoundError);
    assert.doesNotThrow(() => loadAssignmentFor(teacher, draft, 'manage'));
  });

  test('an assignment that has not opened yet cannot be attempted', () => {
    const later = makeAssignment({ openAt: now() + 60_000 });
    assert.throws(() => loadAssignmentFor(alice, later, 'attempt'), ForbiddenError);
  });

  test('only the owning class teacher can manage it', () => {
    const a = makeAssignment({ classId: s4a });
    assert.doesNotThrow(() => loadAssignmentFor(teacher, a, 'manage'));
    assert.throws(() => loadAssignmentFor(other, a, 'manage'), ForbiddenError);
    assert.doesNotThrow(() => loadAssignmentFor(admin, a, 'manage'));
  });

  test('a student cannot enter the manage path even for their own assignment', () => {
    const a = makeAssignment({ classId: s4a });
    assert.throws(() => loadAssignmentFor(alice, a, 'manage'), ForbiddenError);
  });

  test('a missing assignment is a miss for everyone', () => {
    assert.throws(() => loadAssignmentFor(teacher, 4242, 'manage'), NotFoundError);
  });
});

describe('answer reveal policy', () => {
  const assignment = (reveal, dueAt = null) => ({ reveal, due_at: dueAt });

  test('NEVER never reveals', () => {
    assert.equal(mayRevealAnswers(assignment('NEVER'), { status: 'SUBMITTED' }), false);
  });

  test('AFTER_SUBMIT reveals only once submitted', () => {
    assert.equal(mayRevealAnswers(assignment('AFTER_SUBMIT'), { status: 'IN_PROGRESS' }), false);
    assert.equal(mayRevealAnswers(assignment('AFTER_SUBMIT'), null), false);
    assert.equal(mayRevealAnswers(assignment('AFTER_SUBMIT'), { status: 'SUBMITTED' }), true);
  });

  test('AFTER_DUE reveals only after the deadline', () => {
    const t = now();
    assert.equal(mayRevealAnswers(assignment('AFTER_DUE', t + 1000), { status: 'SUBMITTED' }, t), false);
    assert.equal(mayRevealAnswers(assignment('AFTER_DUE', t - 1000), { status: 'IN_PROGRESS' }, t), true);
    assert.equal(mayRevealAnswers(assignment('AFTER_DUE', null), { status: 'SUBMITTED' }, t), false);
  });
});

describe('AT_TIME reveal', () => {
  test('a null reveal_at is never treated as 1970', () => {
    const t = now();
    assert.equal(mayRevealAnswers({ reveal: 'AT_TIME', reveal_at: null }, { status: 'SUBMITTED' }, t), false);
    assert.equal(mayRevealAnswers({ reveal: 'AT_TIME', reveal_at: t - 1 }, null, t), true);
    assert.equal(mayRevealAnswers({ reveal: 'AT_TIME', reveal_at: t + 1 }, null, t), false);
  });
});

describe('role containment', () => {
  /**
   * The scope gates (`teachesClass`, `assertCanReadStudent`,
   * `loadAssignmentFor`) all let ADMIN through on the assumption that an
   * administrator oversees every class. If the catalogue does not grant the
   * matching permissions, an administrator is refused pages the navigation
   * offers them — which is exactly what happened.
   */
  test('an administrator holds every permission a teacher holds', () => {
    const missing = PERMISSIONS.TEACHER.filter((p) => !PERMISSIONS.ADMIN.includes(p));
    assert.deepEqual(missing, [], `ADMIN 缺少教師權限：${missing.join(', ')}`);
  });

  test('student-only actions stay out of both staff roles', () => {
    for (const p of ['practice.run', 'assignment.self.attempt', 'assignment.self.review', 'wrongbook.read']) {
      assert.equal(PERMISSIONS.TEACHER.includes(p), false, `教師不該有 ${p}`);
      assert.equal(PERMISSIONS.ADMIN.includes(p), false, `管理員不該有 ${p}`);
    }
  });

  test('the elevated throttle power belongs to administrators alone', () => {
    assert.equal(PERMISSIONS.TEACHER.includes('ratelimit.override'), false);
    assert.equal(PERMISSIONS.ADMIN.includes('ratelimit.override'), true);
  });

  test('no role lists the same permission twice', () => {
    for (const [role, list] of Object.entries(PERMISSIONS)) {
      assert.equal(new Set(list).size, list.length, `${role} 有重複的權限`);
    }
  });
});
