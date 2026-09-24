-- LearnZen schema. Every table that holds per-student data carries an
-- explicit owner column so the permission layer can check ownership, never
-- inferring it from a join the caller controls.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS classes (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  grade      TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name  TEXT NOT NULL,
  email         TEXT COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  -- STUDENT | TEACHER | ADMIN. Never accepted from a request body.
  role          TEXT NOT NULL CHECK (role IN ('STUDENT','TEACHER','ADMIN')),
  class_id      INTEGER REFERENCES classes(id) ON DELETE SET NULL,
  status        TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISABLED')),
  -- Bumped on password change / forced logout; invalidates every live token.
  -- Repeated failed logins are handled by rate limiting rather than by
  -- locking the row: a lock keyed on the username is a denial-of-service
  -- anyone can trigger against anyone whose username they know.
  token_epoch   INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- A teacher may only touch classes listed here. No implicit "teachers see all".
CREATE TABLE IF NOT EXISTS class_teachers (
  class_id   INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  teacher_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (class_id, teacher_id)
);

CREATE TABLE IF NOT EXISTS subjects (
  id      INTEGER PRIMARY KEY,
  code    TEXT NOT NULL UNIQUE,
  name_zh TEXT NOT NULL,
  name_en TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS topics (
  id         INTEGER PRIMARY KEY,
  subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  code       TEXT NOT NULL,
  name_zh    TEXT NOT NULL,
  name_en    TEXT NOT NULL,
  seq        INTEGER NOT NULL DEFAULT 0,
  enabled    INTEGER NOT NULL DEFAULT 1,
  UNIQUE (subject_id, code)
);

-- Per-class practice gating. A topic with no row here is open: a fresh class
-- can practise everything, and closing a topic is an explicit act that names
-- who did it. (The original defaults the other way, which is why a new student
-- meets "此課題已被教師關閉" on a topic nobody ever deliberately closed.)
CREATE TABLE IF NOT EXISTS class_topics (
  class_id   INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  topic_id   INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  is_open    INTEGER NOT NULL DEFAULT 1,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (class_id, topic_id)
);

CREATE TABLE IF NOT EXISTS questions (
  id                    INTEGER PRIMARY KEY,
  subject_id            INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  topic_id              INTEGER REFERENCES topics(id) ON DELETE SET NULL,
  type                  TEXT NOT NULL CHECK (type IN ('MCQ','MSQ','SHORT')),
  content_zh            TEXT NOT NULL,
  content_en            TEXT,
  explanation_zh        TEXT,
  explanation_en        TEXT,
  source                TEXT,
  exam_year             TEXT,
  figure_zh             TEXT,
  figure_en             TEXT,
  difficulty            TEXT CHECK (difficulty IN ('EASY','EASY_MEDIUM','MEDIUM','MEDIUM_HARD','HARD')),
  official_correct_rate REAL,
  -- DRAFT questions are invisible to students no matter which list they hit.
  status                TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DRAFT','RETIRED')),
  created_by            INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_questions_topic ON questions(topic_id, status);

CREATE TABLE IF NOT EXISTS question_options (
  id          INTEGER PRIMARY KEY,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  label       TEXT NOT NULL,
  content_zh  TEXT NOT NULL,
  content_en  TEXT,
  is_correct  INTEGER NOT NULL DEFAULT 0,
  seq         INTEGER NOT NULL DEFAULT 0,
  UNIQUE (question_id, label)
);
CREATE INDEX IF NOT EXISTS idx_options_question ON question_options(question_id, seq);

-- ---------------------------------------------------------------- practice --

CREATE TABLE IF NOT EXISTS practice_sessions (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mode        TEXT NOT NULL CHECK (mode IN ('TOPIC','REDO','RANDOM')),
  topic_id    INTEGER REFERENCES topics(id) ON DELETE SET NULL,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON practice_sessions(user_id, started_at DESC);

-- The questions a session was built from. Without this a reload cannot rebuild
-- the session: the picker uses RANDOM(), so re-running it would silently hand
-- the student a different set and throw away what they had already answered.
CREATE TABLE IF NOT EXISTS practice_session_questions (
  session_id  INTEGER NOT NULL REFERENCES practice_sessions(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  PRIMARY KEY (session_id, question_id)
);

CREATE TABLE IF NOT EXISTS assignments (
  id           INTEGER PRIMARY KEY,
  code         TEXT NOT NULL UNIQUE,
  title        TEXT NOT NULL,
  subject_id   INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  class_id     INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  created_by   INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  kind         TEXT NOT NULL CHECK (kind IN ('HOMEWORK','TEST')),
  -- All timestamps are epoch milliseconds. Never a naive local-time string:
  -- "2026-09-29T05:08:00" has no zone, so the browser and the server disagree
  -- about when the deadline is by up to a day.
  open_at      INTEGER,
  due_at       INTEGER,
  time_limit_s INTEGER,
  shuffle      INTEGER NOT NULL DEFAULT 0,
  allow_late   INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 1 CHECK (max_attempts >= 1),
  -- Which attempt counts when several are allowed.
  score_strategy TEXT NOT NULL DEFAULT 'LAST' CHECK (score_strategy IN ('LAST','BEST','FIRST')),
  -- When a student may see correct answers. Enforced server-side.
  reveal       TEXT NOT NULL DEFAULT 'AFTER_SUBMIT'
               CHECK (reveal IN ('NEVER','AFTER_SUBMIT','AFTER_DUE','AT_TIME')),
  reveal_at    INTEGER,
  status       TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PUBLISHED','CLOSED')),
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,

  -- Table-level checks: settings that would contradict each other are simply
  -- not storable, so no reader has to guess which of two fields wins.
  -- A single-attempt paper has no meaningful "which attempt counts".
  CHECK (max_attempts > 1 OR score_strategy = 'LAST'),
  -- A reveal rule that depends on a timestamp must have that timestamp.
  CHECK (reveal <> 'AT_TIME'    OR reveal_at IS NOT NULL),
  CHECK (reveal <> 'AFTER_DUE'  OR due_at    IS NOT NULL),
  -- A window that closes before it opens is a data-entry slip, not a state.
  CHECK (open_at IS NULL OR due_at IS NULL OR open_at <= due_at)
);
CREATE INDEX IF NOT EXISTS idx_assignments_class ON assignments(class_id, status, due_at);

CREATE TABLE IF NOT EXISTS assignment_questions (
  assignment_id INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  question_id   INTEGER NOT NULL REFERENCES questions(id) ON DELETE RESTRICT,
  seq           INTEGER NOT NULL,
  points        REAL NOT NULL DEFAULT 1,
  PRIMARY KEY (assignment_id, question_id)
);

CREATE TABLE IF NOT EXISTS submissions (
  id            INTEGER PRIMARY KEY,
  assignment_id INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 1-based; a second row only exists when the paper allows more attempts.
  attempt_no    INTEGER NOT NULL DEFAULT 1 CHECK (attempt_no >= 1),
  status        TEXT NOT NULL DEFAULT 'IN_PROGRESS'
                CHECK (status IN ('IN_PROGRESS','SUBMITTED')),
  started_at    INTEGER NOT NULL,
  submitted_at  INTEGER,
  -- Null until submitted; written once, by the server. A client never sends
  -- a score, and nothing reads these while status is IN_PROGRESS.
  score         REAL,
  max_score     REAL,
  -- Set when the paper was submitted after its deadline, so "late" is a
  -- recorded fact rather than something recomputed from a moving clock.
  late          INTEGER NOT NULL DEFAULT 0,
  UNIQUE (assignment_id, user_id, attempt_no),
  -- A submitted row always carries its timestamp and marks; an unsubmitted
  -- one never does. This is the invariant the old API broke.
  CHECK ((status = 'SUBMITTED') = (submitted_at IS NOT NULL)),
  CHECK ((status = 'SUBMITTED') = (score IS NOT NULL))
);

-- One row per answered question. Grading is written here by the server only.
CREATE TABLE IF NOT EXISTS attempts (
  id            INTEGER PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question_id   INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  session_id    INTEGER REFERENCES practice_sessions(id) ON DELETE SET NULL,
  submission_id INTEGER REFERENCES submissions(id) ON DELETE CASCADE,
  -- Canonical sorted comma-joined labels, e.g. A or A,C.
  chosen        TEXT NOT NULL,
  is_correct    INTEGER NOT NULL,
  duration_ms   INTEGER,
  answered_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attempts_user_q ON attempts(user_id, question_id, answered_at DESC);
CREATE INDEX IF NOT EXISTS idx_attempts_session ON attempts(session_id);

-- Derived from attempts, but kept as a table so the wrong-answer book is a
-- single authoritative row per (student, question) instead of a query that
-- can double-count. Maintained only by recordAttempt() in scoring.js.
CREATE TABLE IF NOT EXISTS wrong_book (
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question_id    INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  wrong_count    INTEGER NOT NULL DEFAULT 0,
  correct_streak INTEGER NOT NULL DEFAULT 0,
  first_wrong_at INTEGER NOT NULL,
  last_wrong_at  INTEGER NOT NULL,
  -- Non-null once the student has cleared it; the row stays for history.
  cleared_at     INTEGER,
  PRIMARY KEY (user_id, question_id)
);
CREATE INDEX IF NOT EXISTS idx_wrongbook_open ON wrong_book(user_id, cleared_at);

-- The student's saved answer per question. Upserted while in progress so a
-- dropped connection never loses a selection; graded at submit time.
CREATE TABLE IF NOT EXISTS submission_answers (
  submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  question_id   INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  chosen        TEXT NOT NULL,
  is_correct    INTEGER,
  points_earned REAL,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (submission_id, question_id)
);

-- A student saying a question is wrong: the answer key looks incorrect, the
-- wording is ambiguous, an image is missing. Worth recording because a bad
-- question quietly costs marks for everyone who meets it, and because the
-- person best placed to notice is the one who just got it wrong.
CREATE TABLE IF NOT EXISTS question_reports (
  id          INTEGER PRIMARY KEY,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason      TEXT NOT NULL CHECK (reason IN ('WRONG_ANSWER','AMBIGUOUS','TYPO','MISSING_FIGURE','OTHER')),
  detail      TEXT,
  status      TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','ACCEPTED','REJECTED')),
  resolution  TEXT,
  resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL,
  resolved_at INTEGER,
  -- One open report per student per question: raising the same objection
  -- twice is noise, and the second one says nothing the first did not.
  UNIQUE (question_id, user_id, status),
  -- A resolved report always says who resolved it and when; an open one
  -- never pretends to have been looked at.
  CHECK ((status = 'OPEN') = (resolved_at IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_reports_open ON question_reports(status, created_at DESC);

-- ------------------------------------------------------------- live quiz --

-- A quiz run in front of a class: the teacher advances the questions, everyone
-- answers at once, and the scoreboard updates as they go. The state lives in
-- the database rather than in the server's memory so a restart mid-lesson
-- resumes instead of losing the room.
CREATE TABLE IF NOT EXISTS live_sessions (
  id          INTEGER PRIMARY KEY,
  -- Short code the class types in. Unique only among live rooms.
  code        TEXT NOT NULL UNIQUE,
  title       TEXT NOT NULL,
  host_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  class_id    INTEGER REFERENCES classes(id) ON DELETE SET NULL,
  status      TEXT NOT NULL DEFAULT 'LOBBY'
              CHECK (status IN ('LOBBY','QUESTION','REVEAL','ENDED')),
  -- Which question is on screen; null in the lobby and once ended.
  current_seq INTEGER,
  -- When the current question went up, so the server decides the deadline
  -- rather than trusting a countdown in anyone's browser.
  asked_at    INTEGER,
  seconds     INTEGER NOT NULL DEFAULT 30 CHECK (seconds > 0),
  created_at  INTEGER NOT NULL,
  ended_at    INTEGER,
  CHECK ((status = 'ENDED') = (ended_at IS NOT NULL)),
  CHECK ((status IN ('QUESTION','REVEAL')) = (current_seq IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_live_code ON live_sessions(code, status);

CREATE TABLE IF NOT EXISTS live_session_questions (
  session_id  INTEGER NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  PRIMARY KEY (session_id, seq)
);

CREATE TABLE IF NOT EXISTS live_participants (
  session_id INTEGER NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at  INTEGER NOT NULL,
  PRIMARY KEY (session_id, user_id)
);

CREATE TABLE IF NOT EXISTS live_answers (
  session_id  INTEGER NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chosen      TEXT NOT NULL,
  is_correct  INTEGER NOT NULL,
  -- Milliseconds from the question going up, which is what speed scoring uses.
  elapsed_ms  INTEGER NOT NULL,
  points      REAL NOT NULL DEFAULT 0,
  answered_at INTEGER NOT NULL,
  -- One answer per person per question: a live round is a single shot.
  PRIMARY KEY (session_id, question_id, user_id)
);

-- ------------------------------------------------------------------- auth --

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- SHA-256 of the secret half; the raw token is never stored.
  token_hash TEXT NOT NULL,
  -- Rotating tokens share a family; replaying a used one kills the family.
  family_id  TEXT NOT NULL,
  issued_at  INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_refresh_family ON refresh_tokens(family_id);
CREATE INDEX IF NOT EXISTS idx_refresh_user ON refresh_tokens(user_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id       INTEGER PRIMARY KEY,
  at       INTEGER NOT NULL,
  actor_id INTEGER,
  action   TEXT NOT NULL,
  target   TEXT,
  ip       TEXT,
  detail   TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at DESC);
