/**
 * Build a self-contained demo database.
 *
 * The screenshots in the README are taken from this, not from real data: the
 * questions are written here rather than imported from anyone's bank, and the
 * people are invented. That keeps the repository free of school content and
 * of real names, and means anyone who clones this can regenerate exactly the
 * same screenshots.
 *
 *   node scripts/demo.mjs                 # writes data/demo.db
 *   LB_DB=data/demo.db PORT=8788 npm start
 */
import { rmSync } from 'node:fs';
import { openDb, setDb, run, get, tx, now } from '../server/db.js';
import { hashPassword } from '../server/auth.js';
import { recordAttempt } from '../server/scoring.js';

const FILE = process.env.LB_DB ?? 'data/demo.db';
for (const suffix of ['', '-wal', '-shm']) {
  try { rmSync(FILE + suffix); } catch { /* not there */ }
}
setDb(openDb(FILE));

const t = now();
const DAY = 86_400_000;

run("INSERT INTO subjects (id, code, name_zh, name_en) VALUES (1, 'ICT', '資訊及通訊科技', 'ICT')");

const TOPICS = [
  ['bin', '數據表示', 'Data Representation'],
  ['db', '數據庫', 'Database'],
  ['net', '網絡', 'Networking'],
  ['sec', '資訊安全', 'Information Security'],
  ['pgm', '程序編寫', 'Programming'],
  ['os', '操作系統', 'Operating System'],
];
TOPICS.forEach(([code, zh, en], i) => run(
  'INSERT INTO topics (id, subject_id, code, name_zh, name_en, seq) VALUES (?, 1, ?, ?, ?, ?)',
  i + 1, code, zh, en, i + 1,
));

/** Written for this demo. `a` is the index of the correct option. */
const QUESTIONS = [
  [1, '十進制數字 25 換算成二進制是什麼？', ['11001', '10011', '11010', '10101'], 0, 'EASY',
    '25 = 16 + 8 + 1，對應 2⁴、2³ 和 2⁰ 三個位元，寫成 11001。'],
  [1, '一個位元組（byte）可以表示多少個不同的數值？', ['8', '16', '128', '256'], 3, 'EASY',
    '一個位元組有 8 個位元，每個位元兩種狀態，所以 2⁸ = 256 種。'],
  [1, '用 ASCII 儲存「ICT2026」需要多少個位元組？', ['5', '6', '7', '14'], 2, 'EASY_MEDIUM',
    'ASCII 每個字元佔一個位元組，「ICT2026」共 7 個字元，故選 C。'],
  [1, '下列哪一種檔案格式採用失真壓縮？', ['PNG', 'JPEG', 'BMP', 'TIFF'], 1, 'MEDIUM',
    'JPEG 捨棄人眼不敏感的細節以換取檔案變小，屬失真壓縮；其餘三種都是無失真或未壓縮。'],

  [2, '在關聯式數據庫中，用來唯一識別每一筆記錄的欄位稱為什麼？',
    ['外來鍵', '主鍵', '索引', '視圖'], 1, 'EASY',
    '主鍵（primary key）的值在整張表中不重複，因此能唯一指向一筆記錄。'],
  [2, '設定「學生表的班別欄必須對應班別表中存在的班別」，用的是什麼機制？',
    ['主鍵', '外來鍵', '檢查約束', '觸發器'], 1, 'MEDIUM',
    '外來鍵（foreign key）要求欄位的值必須存在於另一張表，藉此維持參照完整性。'],
  [2, '下列哪一項**不是**使用數據庫而非試算表的理由？',
    ['避免重複儲存同一筆資料', '多人同時存取時控制衝突', '設定欄位必須符合的條件', '畫出統計圖表'], 3, 'MEDIUM',
    '畫圖表是試算表本來就擅長的事，不構成改用數據庫的理由；前三項都是數據庫的強項。'],

  [3, '在同一棟大樓內連接數十台電腦的網絡屬於哪一類？',
    ['LAN', 'WAN', 'MAN', 'PAN'], 0, 'EASY',
    '局域網（LAN）涵蓋單一建築物或園區的範圍。'],
  [3, '為什麼公司通常採用以伺服器為核心的網絡而非同級對等網絡？',
    ['安裝比較便宜', '不需要網絡線', '可以集中管理帳戶與權限', '速度一定比較快'], 2, 'MEDIUM',
    '伺服器架構讓管理員在一處管理所有帳戶與權限，並集中實施防毒與備份，保安與維運都比較可控，故選 C。'],
  [3, 'HTTPS 相對於 HTTP 多了什麼？',
    ['傳輸速度更快', '傳輸內容經過加密', '可以傳送更大的檔案', '不需要網域名稱'], 1, 'EASY',
    'HTTPS 在 HTTP 之外加上 TLS 加密，讓中途的人看不到也改不了傳輸內容。'],

  [4, '收到一封聲稱來自銀行、要求點連結更新密碼的電郵，這屬於什麼攻擊？',
    ['阻斷服務攻擊', '釣魚', '暴力破解', '病毒感染'], 1, 'EASY',
    '釣魚（phishing）假冒可信的一方誘使你自己交出帳號密碼。'],
  [4, '下列哪一項最能降低密碼被暴力破解的風險？',
    ['密碼定期每週更換', '使用足夠長且獨特的密碼', '把密碼寫在筆記本', '用生日當密碼'], 1, 'EASY_MEDIUM',
    '長度與獨特性決定了猜測所需的嘗試次數；頻繁更換反而常導致使用更弱、更有規律的密碼。'],
  [4, '定期備份主要防範下列哪一種情況？',
    ['防止他人看到檔案', '在資料損毀後能還原', '加快電腦執行速度', '阻擋網絡攻擊'], 1, 'EASY',
    '備份處理的是可用性：硬碟壞掉、誤刪或勒索軟件之後還原得回來。它不negates保密性需求。'],

  [5, '以下偽代碼執行後 total 的值是什麼？\n\ntotal ← 0\n對於 i 由 1 至 4\n    total ← total + i\n',
    ['4', '10', '15', '0'], 1, 'EASY_MEDIUM',
    '迴圈把 1、2、3、4 依次加上去，1+2+3+4 = 10，故選 B。'],
  [5, '檢查考試成績是否及格（≥ 50）的程式，下列哪組測試值最恰當？',
    ['50、60、70', '0、50、100', '49、50、51', '100、200、300'], 2, 'MEDIUM_HARD',
    '49、50、51 同時涵蓋剛好不及格、邊界值與剛好及格三種情況，最能揭露邊界判斷寫錯的錯誤，故選 C。'],
  [5, '程式執行時才被逐行翻譯成機器碼的是哪一種？',
    ['編譯器', '直譯器', '組譯器', '連結器'], 1, 'MEDIUM',
    '直譯器（interpreter）在執行期逐句翻譯並立即執行；編譯器則事先把整份原始碼翻成機器碼。'],

  [6, '操作系統的「多工」指的是什麼？',
    ['同時連接多部印表機', '看起來同時執行多個程式', '一次安裝多個操作系統', '多人共用同一個帳戶'], 1, 'MEDIUM',
    '多工讓處理器在多個程序之間快速切換，使用者感覺它們在同時進行。'],
  [6, '新接上的掃描器需要安裝驅動程式，原因是什麼？',
    ['掃描器沒有電源', '操作系統沒有內建該型號的驅動程式', '掃描器是應用軟件', '掃描器需要連上互聯網'], 1, 'MEDIUM',
    '操作系統要透過驅動程式才能控制裝置。若系統已內建該型號的驅動便毋須另裝，題中要另行安裝，正說明系統沒有包含它，故選 B。'],
];

const questionIds = [];
tx(() => {
  for (const [topicId, content, options, correct, difficulty, explanation] of QUESTIONS) {
    const r = run(
      `INSERT INTO questions
         (subject_id, topic_id, type, content_zh, explanation_zh, source, exam_year,
          difficulty, official_correct_rate, status, created_at, updated_at)
       VALUES (1, ?, 'MCQ', ?, ?, '示範', '2026', ?, ?, 'ACTIVE', ?, ?)`,
      topicId, content, explanation, difficulty,
      45 + Math.round(Math.random() * 45), t, t,
    );
    const id = Number(r.lastInsertRowid);
    questionIds.push(id);
    options.forEach((text, i) => run(
      'INSERT INTO question_options (question_id, label, content_zh, is_correct, seq) VALUES (?, ?, ?, ?, ?)',
      id, String.fromCharCode(65 + i), text, i === correct ? 1 : 0, i,
    ));
  }
});

// A couple of questions left without options, so the "fill in the drafts"
// screen has something to show.
tx(() => {
  for (const [content, explanation] of [
    ['RAM 與 ROM 最主要的分別是什麼？', '斷電後 RAM 的內容會消失而 ROM 不會，故選 A。'],
    ['下列哪一項屬於輸入裝置？', '掃描器把實體文件轉成電腦可處理的數據，屬輸入裝置。'],
  ]) {
    run(
      `INSERT INTO questions (subject_id, topic_id, type, content_zh, explanation_zh,
         source, exam_year, difficulty, status, created_at, updated_at)
       VALUES (1, 6, 'MCQ', ?, ?, '示範', '2026', 'MEDIUM', 'DRAFT', ?, ?)`,
      content, explanation, t, t,
    );
  }
});

// ------------------------------------------------------------------ people --

run('INSERT INTO classes (id, name, grade, created_at) VALUES (1, ?, ?, ?)', 'S4A', 'S4', t);
run('INSERT INTO classes (id, name, grade, created_at) VALUES (2, ?, ?, ?)', 'S4B', 'S4', t);

function makeUser(username, displayName, role, classId, password) {
  const { hash, salt } = hashPassword(password);
  const r = run(
    `INSERT INTO users (username, display_name, password_hash, password_salt, role, class_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    username, displayName, hash, salt, role, classId, t, t,
  );
  return Number(r.lastInsertRowid);
}

const teacher = makeUser('teacher', '示範教師', 'TEACHER', null, 'teacher-1234');
makeUser('admin', '系統管理員', 'ADMIN', null, 'admin-1234');
run('INSERT INTO class_teachers (class_id, teacher_id) VALUES (1, ?)', teacher);
run('INSERT INTO class_teachers (class_id, teacher_id) VALUES (2, ?)', teacher);

const CLASSMATES = [
  ['student', '示範學生', 0.62],
  ['s002', '學生乙', 0.81],
  ['s003', '學生丙', 0.47],
  ['s004', '學生丁', 0.73],
  ['s005', '學生戊', 0.35],
  // Left with no history at all, so the lists have someone who never started.
  ['s006', '學生己', null],
];
const students = CLASSMATES.map(([u, n]) => makeUser(u, n, 'STUDENT', 1, 'student-1234'));

// -------------------------------------------------------------- their work --

/** Deterministic, so the screenshots do not change between runs. */
let seed = 20260924;
const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

tx(() => {
  CLASSMATES.forEach(([, , skill], index) => {
    if (skill === null) return;
    const userId = students[index];

    const session = Number(run(
      'INSERT INTO practice_sessions (user_id, mode, topic_id, started_at, finished_at) VALUES (?, ?, ?, ?, ?)',
      userId, 'TOPIC', 1, t - 2 * DAY, t - 2 * DAY + 600_000,
    ).lastInsertRowid);

    for (const questionId of questionIds.slice(0, 10)) {
      const correctLabel = get(
        'SELECT label FROM question_options WHERE question_id = ? AND is_correct = 1', questionId,
      ).label;
      const rightAnswer = random() < skill;
      const chosen = rightAnswer
        ? correctLabel
        : ['A', 'B', 'C', 'D'].find((l) => l !== correctLabel);
      recordAttempt({
        userId, questionId, chosen, sessionId: session,
        at: t - 2 * DAY + questionIds.indexOf(questionId) * 40_000,
        durationMs: 20_000 + Math.round(random() * 40_000),
      });
    }
  });
});

// ------------------------------------------------------------- assignments --

const paperQuestions = questionIds.slice(0, 6);
const assignment = Number(run(
  `INSERT INTO assignments
     (code, title, subject_id, class_id, created_by, kind, due_at, time_limit_s,
      reveal, status, created_at, updated_at)
   VALUES ('S4A-CH1-TEST', '第一章測驗', 1, 1, ?, 'TEST', ?, 900, 'AFTER_SUBMIT', 'PUBLISHED', ?, ?)`,
  teacher, t + 3 * DAY, t, t,
).lastInsertRowid);
paperQuestions.forEach((id, i) => run(
  'INSERT INTO assignment_questions (assignment_id, question_id, seq, points) VALUES (?, ?, ?, 2)',
  assignment, id, i + 1,
));

run(
  `INSERT INTO assignments (code, title, subject_id, class_id, created_by, kind, due_at,
     reveal, status, created_at, updated_at)
   VALUES ('S4A-CH2-HW1', '第二章練習', 1, 1, ?, 'HOMEWORK', ?, 'AFTER_DUE', 'PUBLISHED', ?, ?)`,
  teacher, t + 6 * DAY, t, t,
);
run(
  'INSERT INTO assignment_questions (assignment_id, question_id, seq, points) SELECT 2, ?, 1, 1',
  questionIds[6],
);

// Three of the six submit; the rest have not started, which is what the score
// table is meant to make visible.
tx(() => {
  [0, 1, 3].forEach((index) => {
    const userId = students[index];
    const skill = CLASSMATES[index][2];
    const submission = Number(run(
      `INSERT INTO submissions (assignment_id, user_id, attempt_no, status, started_at, submitted_at, score, max_score, late)
       VALUES (?, ?, 1, 'SUBMITTED', ?, ?, 0, ?, 0)`,
      assignment, userId, t - DAY, t - DAY + 500_000, paperQuestions.length * 2,
    ).lastInsertRowid);

    let score = 0;
    for (const questionId of paperQuestions) {
      const correctLabel = get(
        'SELECT label FROM question_options WHERE question_id = ? AND is_correct = 1', questionId,
      ).label;
      const rightAnswer = random() < skill;
      const chosen = rightAnswer ? correctLabel : ['A', 'B', 'C', 'D'].find((l) => l !== correctLabel);
      if (rightAnswer) score += 2;
      run(
        `INSERT INTO submission_answers (submission_id, question_id, chosen, is_correct, points_earned, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        submission, questionId, chosen, rightAnswer ? 1 : 0, rightAnswer ? 2 : 0, t - DAY,
      );
      run(
        `INSERT INTO attempts (user_id, question_id, submission_id, chosen, is_correct, answered_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        userId, questionId, submission, chosen, rightAnswer ? 1 : 0, t - DAY,
      );
    }
    run('UPDATE submissions SET score = ? WHERE id = ?', score, submission);
  });
});

console.log(`示範資料寫入 ${FILE}`);
console.log(`  題目 ${get("SELECT COUNT(*) n FROM questions WHERE status='ACTIVE'").n} 可練 / ${get("SELECT COUNT(*) n FROM questions WHERE status='DRAFT'").n} 待補`);
console.log(`  學生 ${students.length} 人、作業 2 份、作答記錄 ${get('SELECT COUNT(*) n FROM attempts').n} 筆`);
console.log('\n  student / student-1234 · teacher / teacher-1234 · admin / admin-1234');
