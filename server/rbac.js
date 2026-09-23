/**
 * Authorization. Two independent gates, and a request must pass both:
 *
 *   1. Permission — does this *role* have the right to perform this action?
 *      Every route declares a permission; the router refuses to register one
 *      that does not, so "I forgot to add a check" cannot become "anyone can
 *      call it". `PUBLIC` is the only way to opt out, and it is deliberately
 *      noisy to type.
 *
 *   2. Scope — is this particular *row* any of the caller's business? A
 *      teacher having `student.profile.read` does not mean they may read any
 *      student; they may read students in classes assigned to them. Every
 *      lookup of someone else's data goes through an assert below.
 *
 * Nothing here reads a role or a user id from the request body or query
 * string. The caller identity always comes from the verified access token.
 */
import { get } from './db.js';

export const PUBLIC = Symbol('public route, no authentication');

export const PERMISSIONS = Object.freeze({
  STUDENT: [
    'self.read', 'self.password.change', 'self.sessions.manage',
    'practice.run', 'wrongbook.read',
    'assignment.self.list', 'assignment.self.attempt', 'assignment.self.review',
    'topic.list', 'question.practice.read',
  ],
  TEACHER: [
    'self.read', 'self.password.change', 'self.sessions.manage',
    'topic.list', 'question.bank.read', 'question.bank.write',
    'assignment.manage', 'assignment.grade.read',
    'class.read', 'student.profile.read', 'analytics.read',
    // Throttling, split by how much damage each action can do:
    //   read  — see who is currently being throttled;
    //   clear — lift one throttle, which the limit immediately re-applies;
    //   relax — raise a limit for a while, within hard bounds (see below).
    // Tightening or blocking is deliberately not here: shutting an address
    // out is a different kind of act from letting a stuck class back in.
    'ratelimit.read', 'ratelimit.clear', 'ratelimit.relax',
  ],
  // An administrator oversees every class, so they hold everything a teacher
  // holds and then some. This is not a convenience: the scope gates below
  // already let ADMIN through (`teachesClass`, `assertCanReadStudent`,
  // `loadAssignmentFor`), and a catalogue that disagreed with them produced
  // an administrator who was refused pages their own navigation offered.
  // The test suite pins TEACHER ⊆ ADMIN so the two cannot drift apart again.
  ADMIN: [
    'self.read', 'self.password.change', 'self.sessions.manage',
    'topic.list', 'topic.manage',
    'question.bank.read', 'question.bank.write',
    'assignment.manage', 'assignment.grade.read',
    'class.read', 'class.manage', 'student.profile.read', 'analytics.read',
    'user.manage', 'audit.read',
    'ratelimit.read', 'ratelimit.clear', 'ratelimit.relax',
    // Unbounded adjustment, including tightening an address to zero.
    'ratelimit.override',
  ],
});

const PERMISSION_SET = Object.fromEntries(
  Object.entries(PERMISSIONS).map(([role, list]) => [role, new Set(list)]),
);

/** Every permission string the catalogue knows about; used to catch typos. */
export const ALL_PERMISSIONS = new Set(Object.values(PERMISSIONS).flat());

export class ForbiddenError extends Error {
  constructor(message = '權限不足', code = 'FORBIDDEN') {
    super(message);
    this.code = code;
    this.status = 403;
  }
}

export class UnauthorizedError extends Error {
  constructor(message = '請先登入', code = 'UNAUTHORIZED') {
    super(message);
    this.code = code;
    this.status = 401;
  }
}

export class NotFoundError extends Error {
  constructor(message = '找不到資源', code = 'NOT_FOUND') {
    super(message);
    this.code = code;
    this.status = 404;
  }
}

export function can(user, permission) {
  if (!user) return false;
  return PERMISSION_SET[user.role]?.has(permission) === true;
}

export function requirePermission(user, permission) {
  if (!user) throw new UnauthorizedError();
  if (!can(user, permission)) throw new ForbiddenError();
  return user;
}

// ------------------------------------------------------------ scope gates --

/**
 * A student may only ever address their own data. A teacher or admin reaching
 * for a student goes through `assertCanReadStudent` instead, which checks the
 * class relationship — so this never silently widens.
 */
export function assertSelf(user, targetUserId) {
  if (!user) throw new UnauthorizedError();
  if (Number(targetUserId) !== user.id) throw new ForbiddenError('只能存取自己的資料');
  return user.id;
}

export function teachesClass(user, classId) {
  if (!user || classId == null) return false;
  if (user.role === 'ADMIN') return true;
  if (user.role !== 'TEACHER') return false;
  return get(
    'SELECT 1 AS ok FROM class_teachers WHERE class_id = ? AND teacher_id = ?',
    Number(classId), user.id,
  ) != null;
}

export function assertTeachesClass(user, classId) {
  if (!teachesClass(user, classId)) throw new ForbiddenError('你沒有這個班別的權限');
  return Number(classId);
}

/** Teachers and admins reading a student: allowed only via a shared class. */
export function assertCanReadStudent(user, studentId) {
  if (!user) throw new UnauthorizedError();
  const id = Number(studentId);
  if (user.role === 'STUDENT') return assertSelf(user, id);

  const student = get('SELECT id, class_id, role FROM users WHERE id = ?', id);
  if (!student || student.role !== 'STUDENT') throw new NotFoundError('找不到該學生');
  assertTeachesClass(user, student.class_id);
  return id;
}

/**
 * Load an assignment the caller is entitled to act on, or throw. `mode` is
 * 'manage' for the teacher-side views and 'attempt' for the student side;
 * a student additionally may not see an assignment that is still a draft or
 * not yet open.
 */
export function loadAssignmentFor(user, assignmentId, mode, at = Date.now()) {
  if (!user) throw new UnauthorizedError();
  const a = get('SELECT * FROM assignments WHERE id = ?', Number(assignmentId));
  if (!a) throw new NotFoundError('找不到作業');

  if (mode === 'manage') {
    assertTeachesClass(user, a.class_id);
    return a;
  }
  if (user.role !== 'STUDENT') throw new ForbiddenError();
  if (a.class_id !== user.class_id) throw new NotFoundError('找不到作業');
  if (a.status !== 'PUBLISHED') throw new NotFoundError('找不到作業');
  if (a.open_at != null && a.open_at > at) throw new ForbiddenError('作業尚未開放');
  return a;
}

/** Whether a student is allowed to see correct answers for an assignment. */
export function mayRevealAnswers(assignment, submission, at = Date.now()) {
  switch (assignment.reveal) {
    case 'NEVER': return false;
    // A null timestamp means "no such moment", never "1970, so yes". Reading
    // these through `new Date(null)` is what let the old app reveal answers
    // for papers that had never been marked revealable.
    case 'AFTER_DUE': return assignment.due_at != null && assignment.due_at <= at;
    case 'AT_TIME': return assignment.reveal_at != null && assignment.reveal_at <= at;
    case 'AFTER_SUBMIT': return submission?.status === 'SUBMITTED';
    default: return false;
  }
}
