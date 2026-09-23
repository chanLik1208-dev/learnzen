/**
 * Create the subject, topics, a class and three accounts to develop against.
 * Safe to re-run: every insert is an upsert keyed on something stable.
 *
 * Topics 1–26 are the ICT list the original app ships as its offline fallback.
 * The live server reports 33, so the remainder are created as placeholders and
 * will be overwritten the moment a real topic list is imported.
 */
import { openDb, setDb, run, get, now } from '../server/db.js';
import { hashPassword } from '../server/auth.js';

setDb(openDb(process.env.LB_DB));

const TOPICS = [
  ['db', '數據庫', 'Database'], ['xls', '試算表', 'Spreadsheet'],
  ['doc', '文書處理', 'Word Processing'], ['ppt', '簡報', 'Presentation'],
  ['bin', '數據表示', 'Data Representation'], ['data', '數據控制', 'Data Control'],
  ['io', '輸入輸出設備', 'I/O Hardware'], ['mem', '存貯器', 'Memory'],
  ['cpu', '處理器', 'CPU'], ['os', '操作系統', 'Operating System'],
  ['int', '互聯網', 'Internet'], ['html', 'HTML', 'HTML'],
  ['net', '網絡', 'Networking'], ['url', 'URL', 'URL'],
  ['sec', '資訊安全', 'Information Security'], ['sys', '系統', 'System'],
  ['jpg', '多媒體', 'Multimedia'], ['pgm', '程序編寫', 'Programming'],
  ['flow', '流程圖', 'Flow Chart'], ['solve', '解難', 'Problem Solving'],
  ['lang', '程式語言', 'Programming Language'], ['open', '開放源碼', 'Open Source'],
  ['ergo', '人體工學', 'Ergonomics'], ['copy', '知識產權', 'Copyright'],
  ['divi', '數碼鴻溝', 'Digital Divide'], ['misc', '綜合', 'Miscellaneous'],
];
const TOPIC_COUNT = 33;

run(
  `INSERT INTO subjects (id, code, name_zh, name_en) VALUES (1, 'ICT', '資訊及通訊科技', 'ICT')
   ON CONFLICT (id) DO NOTHING`,
);

for (let id = 1; id <= TOPIC_COUNT; id += 1) {
  const [code, zh, en] = TOPICS[id - 1] ?? [`t${id}`, `課題 ${id}`, `Topic ${id}`];
  run(
    `INSERT INTO topics (id, subject_id, code, name_zh, name_en, seq) VALUES (?, 1, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET code = excluded.code, name_zh = excluded.name_zh,
       name_en = excluded.name_en, seq = excluded.seq`,
    id, code, zh, en, id,
  );
}

function upsertClass(name, grade) {
  run(
    'INSERT INTO classes (name, grade, created_at) VALUES (?, ?, ?) ON CONFLICT (name) DO NOTHING',
    name, grade, now(),
  );
  return get('SELECT id FROM classes WHERE name = ?', name).id;
}

function upsertUser({ username, displayName, role, classId = null, password }) {
  const existing = get('SELECT id FROM users WHERE username = ?', username);
  if (existing) return existing.id;
  const { hash, salt } = hashPassword(password);
  const t = now();
  const r = run(
    `INSERT INTO users (username, display_name, password_hash, password_salt, role, class_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    username, displayName, hash, salt, role, classId, t, t,
  );
  return Number(r.lastInsertRowid);
}

const s4a = upsertClass('S4A', 'S4');
// Demo accounts, deliberately generic: a seed script lives in version
// control, so it is the wrong place for a real person's name or student
// number. Change these locally, and change the passwords before the server
// is reachable by anyone else.
const student = upsertUser({
  username: 'student', displayName: '示範學生', role: 'STUDENT', classId: s4a, password: 'student-1234',
});
const teacher = upsertUser({
  username: 'teacher', displayName: '示範教師', role: 'TEACHER', password: 'teacher-1234',
});
upsertUser({ username: 'admin', displayName: '系統管理員', role: 'ADMIN', password: 'admin-1234' });

run(
  'INSERT INTO class_teachers (class_id, teacher_id) VALUES (?, ?) ON CONFLICT DO NOTHING',
  s4a, teacher,
);

console.log(`課題 ${TOPIC_COUNT} 個、班別 S4A、三個帳號已就緒`);
console.log('  學生  student / student-1234');
console.log('  教師  teacher / teacher-1234');
console.log('  管理  admin   / admin-1234');
console.log(`\n可練習題目：${get("SELECT COUNT(*) AS n FROM questions WHERE status = 'ACTIVE'").n}`);
void student;
