import { openDb, setDb, closeDb, run, get, now } from '../server/db.js';
import { hashPassword, resetSecretCache } from '../server/auth.js';

process.env.LB_SECRET ??= 'test-secret-do-not-use-in-production';

/** A fresh in-memory database per test file, with the base subject/topic rows. */
export function freshDb() {
  closeDb();
  resetSecretCache();
  setDb(openDb(':memory:'));
  run('INSERT INTO subjects (id, code, name_zh, name_en) VALUES (1, ?, ?, ?)', 'ICT', '資訊及通訊科技', 'ICT');
  run('INSERT INTO topics (id, subject_id, code, name_zh, name_en, seq) VALUES (1, 1, ?, ?, ?, 1)', 'DB', '數據庫', 'Database');
  run('INSERT INTO topics (id, subject_id, code, name_zh, name_en, seq) VALUES (2, 1, ?, ?, ?, 2)', 'NET', '互聯網', 'Internet');
}

export function makeClass(name = 'S4A', grade = 'S4') {
  const r = run('INSERT INTO classes (name, grade, created_at) VALUES (?, ?, ?)', name, grade, now());
  return Number(r.lastInsertRowid);
}

export function makeUser({ username, role = 'STUDENT', classId = null, password = 'pw-12345678', displayName = null }) {
  const { hash, salt } = hashPassword(password);
  const t = now();
  const r = run(
    `INSERT INTO users (username, display_name, password_hash, password_salt, role, class_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    username, displayName ?? username, hash, salt, role, classId, t, t,
  );
  return get('SELECT * FROM users WHERE id = ?', Number(r.lastInsertRowid));
}

export function assignTeacher(classId, teacherId) {
  run('INSERT INTO class_teachers (class_id, teacher_id) VALUES (?, ?)', classId, teacherId);
}

/**
 * Create a question with options. `correct` is a label or array of labels.
 * Passing `correct: []` makes a question with no answer key, for the tests
 * that check we refuse to grade one.
 */
export function makeQuestion({
  topicId = 1, type = 'MCQ', correct = 'A', labels = ['A', 'B', 'C', 'D'],
  content = '測試題目', status = 'ACTIVE',
} = {}) {
  const t = now();
  const r = run(
    `INSERT INTO questions (subject_id, topic_id, type, content_zh, status, created_at, updated_at)
     VALUES (1, ?, ?, ?, ?, ?, ?)`,
    topicId, type, content, status, t, t,
  );
  const id = Number(r.lastInsertRowid);
  const correctSet = new Set([correct].flat());
  labels.forEach((label, i) => {
    run(
      'INSERT INTO question_options (question_id, label, content_zh, is_correct, seq) VALUES (?, ?, ?, ?, ?)',
      id, label, `選項 ${label}`, correctSet.has(label) ? 1 : 0, i,
    );
  });
  return id;
}

export { closeDb };
