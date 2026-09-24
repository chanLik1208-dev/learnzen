import { route, badRequest, notFound, conflict } from '../http.js';
import { all, get, run, tx, now, audit } from '../db.js';
import {
  can, assertTeachesClass, assertCanReadStudent, ForbiddenError,
} from '../rbac.js';
import { randomBytes } from 'node:crypto';
import { hashPassword, revokeAllForUser } from '../auth.js';

/**
 * Accounts and classes.
 *
 * Two rules run through everything here, and both are about privilege:
 *
 *   - A role is never taken from a request body without checking what the
 *     caller is allowed to create. A teacher enrolling students must not be
 *     able to mint an administrator by changing one field.
 *   - Accounts are disabled, never deleted. A student's attempts, submissions
 *     and marks cascade from their row, so removing the row would silently
 *     delete a term's worth of grades along with it.
 */

const ROLES = ['STUDENT', 'TEACHER', 'ADMIN'];
const MIN_PASSWORD = 8;

const publicShape = (u) => ({
  id: u.id,
  username: u.username,
  displayName: u.display_name,
  role: u.role,
  classId: u.class_id,
  className: u.class_name ?? null,
  status: u.status,
  createdAt: u.created_at,
});

/** What roles this caller may bring into existence, and for which classes. */
function assertMayCreate(user, role, classId) {
  if (role === 'STUDENT') {
    if (!can(user, 'student.enroll')) throw new ForbiddenError();
    // A student must land in a class, and only one the caller actually teaches.
    if (classId == null) throw badRequest('學生必須指定班別', 'CLASS_REQUIRED');
    assertTeachesClass(user, classId);
    return;
  }
  // Anything above a student is an administrator's decision.
  if (!can(user, 'user.manage')) {
    throw new ForbiddenError('只有管理員可以建立教師或管理員帳號');
  }
}

// ------------------------------------------------------------------ users --

route('GET', '/api/staff/users', 'student.profile.read', (ctx) => {
  const role = ctx.query.get('role');
  const classId = ctx.query.get('classId');
  const search = ctx.query.get('q');

  const where = [];
  const args = [];
  if (role && ROLES.includes(role)) { where.push('u.role = ?'); args.push(role); }
  if (classId) { where.push('u.class_id = ?'); args.push(Number(classId)); }
  if (search) {
    where.push('(u.username LIKE ? OR u.display_name LIKE ?)');
    args.push(`%${search}%`, `%${search}%`);
  }

  // A teacher sees the students of their own classes and nobody else. Without
  // this the listing would be a way around the per-student scope check.
  if (!can(ctx.user, 'user.manage')) {
    const mine = all(
      'SELECT class_id FROM class_teachers WHERE teacher_id = ?', ctx.user.id,
    ).map((r) => r.class_id);
    if (mine.length === 0) return { users: [], total: 0, mayManageStaff: false };
    where.push(`u.role = 'STUDENT' AND u.class_id IN (${mine.map(() => '?').join(',')})`);
    args.push(...mine);
  }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return {
    total: get(`SELECT COUNT(*) AS n FROM users u ${clause}`, ...args).n,
    mayManageStaff: can(ctx.user, 'user.manage'),
    users: all(
      `SELECT u.*, c.name AS class_name FROM users u
         LEFT JOIN classes c ON c.id = u.class_id
       ${clause} ORDER BY u.role, u.display_name LIMIT 500`,
      ...args,
    ).map(publicShape),
  };
});

function createUser({ username, displayName, role, classId, password, actor, ip }) {
  const name = String(username ?? '').trim();
  if (!/^[A-Za-z0-9._-]{3,32}$/.test(name)) {
    throw badRequest('帳號只能用英數字、點、底線或連字號，長度 3–32', 'BAD_USERNAME');
  }
  const display = String(displayName ?? '').trim() || name;
  if (String(password ?? '').length < MIN_PASSWORD) {
    throw badRequest(`密碼至少 ${MIN_PASSWORD} 個字元`, 'WEAK_PASSWORD');
  }
  if (get('SELECT 1 AS hit FROM users WHERE username = ?', name)) {
    throw conflict(`帳號 ${name} 已經有人用了`, 'USERNAME_TAKEN');
  }

  const { hash, salt } = hashPassword(String(password));
  const t = now();
  const id = Number(run(
    `INSERT INTO users (username, display_name, password_hash, password_salt, role, class_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    name, display, hash, salt, role, classId ?? null, t, t,
  ).lastInsertRowid);

  audit({
    actorId: actor.id, action: 'user.create', target: `user:${id}`, ip,
    detail: { username: name, role, classId: classId ?? null },
  });
  return id;
}

route('POST', '/api/staff/users', 'student.enroll', (ctx) => {
  const b = ctx.body ?? {};
  const role = ROLES.includes(b.role) ? b.role : 'STUDENT';
  const classId = b.classId == null ? null : Number(b.classId);
  assertMayCreate(ctx.user, role, classId);

  return tx(() => {
    const id = createUser({ ...b, role, classId, actor: ctx.user, ip: ctx.ip });
    return {
      user: publicShape(get(
        `SELECT u.*, c.name AS class_name FROM users u
           LEFT JOIN classes c ON c.id = u.class_id WHERE u.id = ?`, id,
      )),
    };
  });
});

/**
 * An initial password for a row that did not bring one.
 *
 * Deriving it from the username was the first idea and it is a bad one twice
 * over: a student number is usually shorter than the minimum length, so the
 * row simply failed, and "your password is your username" is not a password.
 * This generates something short enough to read out loud and hand over, and
 * the caller gets it back so they can.
 */
const WORDS = 'abcdefghijkmnpqrstuvwxyz23456789';
function initialPassword() {
  const bytes = randomBytes(12);
  return Array.from(bytes, (b) => WORDS[b % WORDS.length]).join('');
}

/**
 * Enrol a list of students in one go, the common case at the start of a term.
 * Rows are reported individually rather than all-or-nothing: one duplicate
 * username in a list of thirty should not throw away the other twenty-nine,
 * and the caller needs to know which ones to fix.
 */
route('POST', '/api/staff/users/import', 'student.enroll', (ctx) => {
  const classId = Number(ctx.body?.classId);
  assertTeachesClass(ctx.user, classId);

  const rows = Array.isArray(ctx.body?.students) ? ctx.body.students : [];
  if (rows.length === 0) throw badRequest('沒有要匯入的學生');
  if (rows.length > 200) throw badRequest('一次最多匯入 200 人', 'TOO_MANY');

  const created = [];
  const failed = [];
  for (const row of rows) {
    // Returned to the caller, because an account nobody can sign in to is not
    // an account. This is the only moment the password is knowable.
    const password = String(row.password ?? '').trim() || initialPassword();
    const generated = !row.password;
    try {
      // Each row is its own transaction so a later failure cannot undo the
      // accounts already made.
      const id = tx(() => createUser({
        username: row.username,
        displayName: row.displayName,
        role: 'STUDENT',
        classId,
        password,
        actor: ctx.user,
        ip: ctx.ip,
      }));
      created.push({
        id, username: String(row.username).trim(),
        displayName: String(row.displayName ?? row.username).trim(),
        password, generated,
      });
    } catch (err) {
      failed.push({ username: row.username ?? '(空白)', reason: err.message });
    }
  }
  return { created, failed, createdCount: created.length, failedCount: failed.length };
});

route('PATCH', '/api/staff/users/:id', 'student.enroll', (ctx) => {
  const id = Number(ctx.params.id);
  const target = get('SELECT * FROM users WHERE id = ?', id);
  if (!target) throw notFound('找不到帳號');

  const b = ctx.body ?? {};
  const elevated = can(ctx.user, 'user.manage');
  if (!elevated) {
    // A teacher may only touch students in their own classes, and may not
    // change anyone's role or move a student out of their reach.
    assertCanReadStudent(ctx.user, id);
    for (const field of ['role', 'status']) {
      if (b[field] !== undefined) {
        throw new ForbiddenError('只有管理員可以變更角色或啟用狀態');
      }
    }
    if (b.classId !== undefined) assertTeachesClass(ctx.user, b.classId);
  }

  const changes = {};
  if (b.displayName !== undefined) {
    const display = String(b.displayName).trim();
    if (!display) throw badRequest('姓名不可空白');
    changes.display_name = display;
  }
  if (b.classId !== undefined) changes.class_id = b.classId == null ? null : Number(b.classId);
  if (elevated && b.role !== undefined) {
    if (!ROLES.includes(b.role)) throw badRequest('不支援的角色', 'BAD_ROLE');
    // Removing your own last route back in is a mistake nobody recovers from.
    if (id === ctx.user.id && b.role !== 'ADMIN') {
      throw badRequest('不能把自己降級', 'CANNOT_DEMOTE_SELF');
    }
    changes.role = b.role;
  }
  if (elevated && b.status !== undefined) {
    if (!['ACTIVE', 'DISABLED'].includes(b.status)) throw badRequest('不支援的狀態', 'BAD_STATUS');
    if (id === ctx.user.id && b.status === 'DISABLED') {
      throw badRequest('不能停用自己的帳號', 'CANNOT_DISABLE_SELF');
    }
    changes.status = b.status;
  }
  if (Object.keys(changes).length === 0) throw badRequest('沒有要變更的欄位');

  return tx(() => {
    const t = now();
    const sets = [...Object.keys(changes).map((k) => `${k} = ?`), 'updated_at = ?'];
    run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, ...Object.values(changes), t, id);

    // A role change or a disable must not leave live sessions behind: the
    // access token carries the epoch, so bumping it ends them at once.
    if (changes.role !== undefined || changes.status === 'DISABLED') {
      run('UPDATE users SET token_epoch = token_epoch + 1 WHERE id = ?', id);
      revokeAllForUser(id, t);
    }

    audit({ actorId: ctx.user.id, action: 'user.update', target: `user:${id}`, ip: ctx.ip, detail: changes });
    return {
      user: publicShape(get(
        `SELECT u.*, c.name AS class_name FROM users u
           LEFT JOIN classes c ON c.id = u.class_id WHERE u.id = ?`, id,
      )),
    };
  });
});

/**
 * Set someone else's password — the "I forgot mine" path. Every session they
 * have is ended, so a password handed out in person cannot be racing an old
 * session still open on a shared machine.
 */
route('POST', '/api/staff/users/:id/password', 'student.enroll', (ctx) => {
  const id = Number(ctx.params.id);
  const target = get('SELECT * FROM users WHERE id = ?', id);
  if (!target) throw notFound('找不到帳號');
  if (!can(ctx.user, 'user.manage')) assertCanReadStudent(ctx.user, id);

  const password = String(ctx.body?.newPassword ?? '');
  if (password.length < MIN_PASSWORD) throw badRequest(`密碼至少 ${MIN_PASSWORD} 個字元`, 'WEAK_PASSWORD');

  return tx(() => {
    const { hash, salt } = hashPassword(password);
    const t = now();
    run(
      `UPDATE users SET password_hash = ?, password_salt = ?, token_epoch = token_epoch + 1, updated_at = ?
        WHERE id = ?`,
      hash, salt, t, id,
    );
    revokeAllForUser(id, t);
    audit({ actorId: ctx.user.id, action: 'user.password_reset', target: `user:${id}`, ip: ctx.ip });
    return { reset: true, username: target.username };
  });
});

// ---------------------------------------------------------------- classes --

route('POST', '/api/admin/classes', 'class.manage', (ctx) => {
  const name = String(ctx.body?.name ?? '').trim();
  const grade = String(ctx.body?.grade ?? '').trim();
  if (!name) throw badRequest('請輸入班別名稱');
  if (!grade) throw badRequest('請輸入級別');
  if (get('SELECT 1 AS hit FROM classes WHERE name = ?', name)) {
    throw conflict(`班別 ${name} 已經存在`, 'CLASS_EXISTS');
  }

  const id = Number(run(
    'INSERT INTO classes (name, grade, created_at) VALUES (?, ?, ?)', name, grade, now(),
  ).lastInsertRowid);
  audit({ actorId: ctx.user.id, action: 'class.create', target: `class:${id}`, ip: ctx.ip, detail: { name, grade } });
  return { class: { id, name, grade, studentCount: 0, teachers: [] } };
});

route('GET', '/api/admin/classes', 'class.manage', () => ({
  classes: all('SELECT * FROM classes ORDER BY name').map((c) => ({
    id: c.id,
    name: c.name,
    grade: c.grade,
    studentCount: get(
      "SELECT COUNT(*) AS n FROM users WHERE class_id = ? AND role = 'STUDENT' AND status = 'ACTIVE'", c.id,
    ).n,
    teachers: all(
      `SELECT u.id, u.display_name FROM class_teachers ct
         JOIN users u ON u.id = ct.teacher_id WHERE ct.class_id = ?`, c.id,
    ).map((u) => ({ id: u.id, displayName: u.display_name })),
  })),
}));

route('PUT', '/api/admin/classes/:id/teachers', 'class.manage', (ctx) => {
  const classId = Number(ctx.params.id);
  if (!get('SELECT 1 AS hit FROM classes WHERE id = ?', classId)) throw notFound('找不到班別');

  const ids = [...new Set((Array.isArray(ctx.body?.teacherIds) ? ctx.body.teacherIds : []).map(Number))];
  for (const id of ids) {
    const u = get('SELECT role FROM users WHERE id = ?', id);
    if (!u) throw badRequest(`找不到帳號 ${id}`);
    if (!['TEACHER', 'ADMIN'].includes(u.role)) throw badRequest('只有教師或管理員可以被指派班別', 'NOT_STAFF');
  }

  return tx(() => {
    run('DELETE FROM class_teachers WHERE class_id = ?', classId);
    for (const id of ids) {
      run('INSERT INTO class_teachers (class_id, teacher_id) VALUES (?, ?)', classId, id);
    }
    audit({
      actorId: ctx.user.id, action: 'class.teachers_set',
      target: `class:${classId}`, ip: ctx.ip, detail: { teacherIds: ids },
    });
    return { classId, teacherIds: ids };
  });
});
