import { route, badRequest, notFound, conflict } from '../http.js';
import { all, get, run, tx, now, audit } from '../db.js';
import {
  assertTeachesClass, assertCanReadStudent, loadAssignmentFor, ForbiddenError,
} from '../rbac.js';
import { serializeQuestion, serializeAssignment, serializeTopic } from '../serialize.js';
import { optionsFor } from '../scoring.js';
import { suggestAnswer, suggestAnswerWithEvidence } from '../answer-hint.js';

/** Classes the caller may act on. An admin sees all; a teacher sees theirs. */
function myClasses(user) {
  return user.role === 'ADMIN'
    ? all('SELECT * FROM classes ORDER BY name')
    : all(
      `SELECT c.* FROM classes c JOIN class_teachers ct ON ct.class_id = c.id
        WHERE ct.teacher_id = ? ORDER BY c.name`,
      user.id,
    );
}

route('GET', '/api/teacher/classes', 'class.read', (ctx) => ({
  classes: myClasses(ctx.user).map((c) => ({
    id: c.id,
    name: c.name,
    grade: c.grade,
    studentCount: get(
      "SELECT COUNT(*) AS n FROM users WHERE class_id = ? AND role = 'STUDENT' AND status = 'ACTIVE'",
      c.id,
    ).n,
  })),
}));

route('GET', '/api/teacher/classes/:classId/students', 'student.profile.read', (ctx) => {
  const classId = assertTeachesClass(ctx.user, ctx.params.classId);
  const students = all(
    `SELECT id, username, display_name FROM users
      WHERE class_id = ? AND role = 'STUDENT' AND status = 'ACTIVE' ORDER BY display_name`,
    classId,
  );

  return {
    students: students.map((s) => {
      const stats = get(
        `SELECT COUNT(*) AS answered,
                SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END) AS correct
           FROM attempts WHERE user_id = ?`,
        s.id,
      );
      return {
        id: s.id,
        username: s.username,
        displayName: s.display_name,
        answered: stats.answered,
        // Null rather than 0 when they have done nothing, so the class list
        // does not show a wall of apparent zeros for students who never started.
        accuracy: stats.answered > 0 ? stats.correct / stats.answered : null,
        openWrongCount: get(
          'SELECT COUNT(*) AS n FROM wrong_book WHERE user_id = ? AND cleared_at IS NULL',
          s.id,
        ).n,
      };
    }),
  };
});

route('GET', '/api/teacher/students/:studentId/profile', 'student.profile.read', (ctx) => {
  const studentId = assertCanReadStudent(ctx.user, ctx.params.studentId);
  const student = get('SELECT id, username, display_name, class_id FROM users WHERE id = ?', studentId);

  const byTopic = all(
    `SELECT t.id, t.name_zh, COUNT(*) AS answered,
            SUM(CASE WHEN a.is_correct = 1 THEN 1 ELSE 0 END) AS correct
       FROM attempts a
       JOIN questions q ON q.id = a.question_id
       JOIN topics t ON t.id = q.topic_id
      WHERE a.user_id = ?
      GROUP BY t.id ORDER BY t.seq`,
    studentId,
  );

  return {
    student: {
      id: student.id,
      username: student.username,
      displayName: student.display_name,
      classId: student.class_id,
    },
    topics: byTopic.map((r) => ({
      topicId: r.id,
      name: r.name_zh,
      answered: r.answered,
      accuracy: r.answered > 0 ? r.correct / r.answered : null,
    })),
    openWrongCount: get(
      'SELECT COUNT(*) AS n FROM wrong_book WHERE user_id = ? AND cleared_at IS NULL', studentId,
    ).n,
    recentSubmissions: all(
      `SELECT s.*, a.title, a.code FROM submissions s JOIN assignments a ON a.id = s.assignment_id
        WHERE s.user_id = ? AND s.status = 'SUBMITTED'
        ORDER BY s.submitted_at DESC LIMIT 10`,
      studentId,
    ).map((s) => ({
      assignmentId: s.assignment_id,
      code: s.code,
      title: s.title,
      submittedAt: s.submitted_at,
      score: s.score,
      maxScore: s.max_score,
      late: s.late === 1,
    })),
  };
});

// ------------------------------------------------------------ question bank --

route('GET', '/api/teacher/questions', 'question.bank.read', (ctx) => {
  const limit = Math.min(Number(ctx.query.get('limit')) || 50, 200);
  const offset = Math.max(Number(ctx.query.get('offset')) || 0, 0);
  const topicId = ctx.query.get('topicId');
  const search = ctx.query.get('q');

  const where = ["q.status <> 'RETIRED'"];
  const args = [];
  if (topicId) { where.push('q.topic_id = ?'); args.push(Number(topicId)); }
  if (search) { where.push('q.content_zh LIKE ?'); args.push(`%${search}%`); }
  // The paper builder asks for ACTIVE only: a question with no answer key
  // cannot go on a paper, and filtering here means the builder never has to
  // display one just to grey it out.
  const status = ctx.query.get('status');
  if (status && ['ACTIVE', 'DRAFT'].includes(status)) { where.push('q.status = ?'); args.push(status); }
  if (ctx.query.get('source')) { where.push('q.source = ?'); args.push(ctx.query.get('source')); }
  if (ctx.query.get('examYear')) { where.push('q.exam_year = ?'); args.push(ctx.query.get('examYear')); }
  const clause = where.join(' AND ');

  const rows = all(
    `SELECT * FROM questions q WHERE ${clause} ORDER BY q.id DESC LIMIT ? OFFSET ?`,
    ...args, limit, offset,
  );

  return {
    total: get(`SELECT COUNT(*) AS n FROM questions q WHERE ${clause}`, ...args).n,
    // Teachers hold question.bank.read, so the answer key is theirs to see.
    questions: rows.map((q) => ({ ...serializeQuestion(q, { withAnswer: true }), status: q.status })),
  };
});

route('POST', '/api/teacher/questions', 'question.bank.write', (ctx) => {
  const b = ctx.body ?? {};
  const options = Array.isArray(b.options) ? b.options : [];
  if (!b.contentZh) throw badRequest('請輸入題幹');
  if (options.length < 2) throw badRequest('至少需要兩個選項', 'TOO_FEW_OPTIONS');
  if (!options.some((o) => o.isCorrect)) throw badRequest('請指定正確答案', 'NO_ANSWER_KEY');

  const type = b.type ?? 'MCQ';
  if (type === 'MCQ' && options.filter((o) => o.isCorrect).length > 1) {
    throw badRequest('單選題只能有一個正確答案', 'TOO_MANY_CORRECT');
  }

  return tx(() => {
    const t = now();
    const r = run(
      `INSERT INTO questions
         (subject_id, topic_id, type, content_zh, content_en, explanation_zh, explanation_en,
          source, exam_year, difficulty, status, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      Number(b.subjectId ?? 1), b.topicId ? Number(b.topicId) : null, type,
      b.contentZh, b.contentEn ?? null, b.explanationZh ?? null, b.explanationEn ?? null,
      b.source ?? null, b.examYear ?? null, b.difficulty ?? null,
      b.status ?? 'DRAFT', ctx.user.id, t, t,
    );
    const id = Number(r.lastInsertRowid);

    options.forEach((o, i) => run(
      'INSERT INTO question_options (question_id, label, content_zh, content_en, is_correct, seq) VALUES (?, ?, ?, ?, ?, ?)',
      id, String(o.label ?? String.fromCharCode(65 + i)).toUpperCase(),
      o.contentZh ?? o.content ?? '', o.contentEn ?? null, o.isCorrect ? 1 : 0, i,
    ));

    audit({ actorId: ctx.user.id, action: 'question.create', target: `question:${id}`, ip: ctx.ip });
    return { question: serializeQuestion(get('SELECT * FROM questions WHERE id = ?', id), { withAnswer: true }) };
  });
});

/**
 * Edit a question's text and metadata. The options and the answer key are not
 * touched here — they go through the options endpoint, which is the only
 * place that can move a question from DRAFT to ACTIVE, so an edit can never
 * make an unanswerable question servable by accident.
 */
route('PATCH', '/api/teacher/questions/:id', 'question.bank.write', (ctx) => {
  const q = get('SELECT * FROM questions WHERE id = ?', Number(ctx.params.id));
  if (!q) throw notFound('找不到題目');

  const b = ctx.body ?? {};
  const changes = {};
  if (b.contentZh !== undefined) {
    const content = String(b.contentZh).trim();
    if (!content) throw badRequest('題幹不可空白');
    changes.content_zh = content;
  }
  for (const [field, column] of [
    ['contentEn', 'content_en'], ['explanationZh', 'explanation_zh'],
    ['explanationEn', 'explanation_en'], ['source', 'source'], ['examYear', 'exam_year'],
  ]) {
    if (b[field] !== undefined) changes[column] = b[field] === null ? null : String(b[field]).trim() || null;
  }
  if (b.topicId !== undefined) {
    const topicId = b.topicId == null ? null : Number(b.topicId);
    if (topicId != null && !get('SELECT 1 AS ok FROM topics WHERE id = ?', topicId)) {
      throw badRequest('找不到課題', 'BAD_TOPIC');
    }
    changes.topic_id = topicId;
  }
  if (b.difficulty !== undefined) {
    const levels = ['EASY', 'EASY_MEDIUM', 'MEDIUM', 'MEDIUM_HARD', 'HARD'];
    if (b.difficulty != null && !levels.includes(b.difficulty)) {
      throw badRequest('不支援的難度', 'BAD_DIFFICULTY');
    }
    changes.difficulty = b.difficulty ?? null;
  }
  if (b.status !== undefined) {
    if (!['ACTIVE', 'DRAFT', 'RETIRED'].includes(b.status)) throw badRequest('不支援的狀態', 'BAD_STATUS');
    // Going ACTIVE means "students may be given this", so it needs a key.
    if (b.status === 'ACTIVE' && !get(
      'SELECT 1 AS ok FROM question_options WHERE question_id = ? AND is_correct = 1', q.id,
    )) {
      throw badRequest('這題還沒有正確答案，不能啟用', 'NO_ANSWER_KEY');
    }
    changes.status = b.status;
  }
  if (Object.keys(changes).length === 0) throw badRequest('沒有要變更的欄位');

  const t = now();
  const sets = [...Object.keys(changes).map((k) => `${k} = ?`), 'updated_at = ?'];
  run(`UPDATE questions SET ${sets.join(', ')} WHERE id = ?`, ...Object.values(changes), t, q.id);
  audit({ actorId: ctx.user.id, action: 'question.update', target: `question:${q.id}`, ip: ctx.ip, detail: changes });

  return {
    question: {
      ...serializeQuestion(get('SELECT * FROM questions WHERE id = ?', q.id), { withAnswer: true }),
      status: get('SELECT status FROM questions WHERE id = ?', q.id).status,
    },
  };
});

/**
 * Questions that cannot be served because they have no options or no answer
 * key. The bulk import leaves hundreds of these: stems and explanations came
 * through, the option text did not. They are listed here so they can be
 * completed by hand rather than sitting invisible in the bank forever.
 */
route('GET', '/api/teacher/questions/drafts', 'question.bank.write', (ctx) => {
  const limit = Math.min(Number(ctx.query.get('limit')) || 20, 100);
  const offset = Math.max(Number(ctx.query.get('offset')) || 0, 0);
  const topicId = ctx.query.get('topicId');
  const year = ctx.query.get('examYear');

  const where = ["q.status = 'DRAFT'"];
  const args = [];
  if (topicId) { where.push('q.topic_id = ?'); args.push(Number(topicId)); }
  if (year) { where.push('q.exam_year = ?'); args.push(year); }
  const clause = where.join(' AND ');

  // Whether the explanation names an answer cannot be expressed in SQL, so
  // that filter is applied in JS over the matching drafts. The set is small
  // enough (hundreds) that scanning it costs less than keeping a derived
  // column in sync with the hint rules.
  const hintedOnly = ctx.query.get('hinted') === 'true';
  const matching = all(
    `SELECT * FROM questions q WHERE ${clause} ORDER BY q.exam_year DESC, q.id`, ...args,
  );
  const pool = hintedOnly
    ? matching.filter((q) => suggestAnswer(q.explanation_zh))
    : matching;
  const rows = pool.slice(offset, offset + limit);

  return {
    total: pool.length,
    // Always reported, so the screen can offer "do the easy ones first"
    // without a second request.
    hintedTotal: matching.filter((q) => suggestAnswer(q.explanation_zh)).length,
    questions: rows.map((q) => {
      const existing = optionsFor(q.id);
      const labels = existing.length ? existing.map((o) => o.label) : ['A', 'B', 'C', 'D'];
      const hint = suggestAnswerWithEvidence(q.explanation_zh, labels);
      return {
        id: q.id,
        topicId: q.topic_id,
        content: q.content_zh,
        contentEn: q.content_en,
        explanation: q.explanation_zh,
        source: q.source,
        examYear: q.exam_year,
        difficulty: q.difficulty,
        officialCorrectRate: q.official_correct_rate,
        figure: q.figure_zh,
        options: existing.map((o) => ({
          label: o.label, contentZh: o.content_zh, contentEn: o.content_en,
          isCorrect: o.is_correct === 1,
        })),
        // A suggestion, never applied on its own: the reason is shown so the
        // person can see what the explanation actually said before accepting.
        suggestedAnswer: hint.label,
        suggestionEvidence: hint.evidence,
      };
    }),
  };
});

/**
 * Fill in a question's options and answer key. A question only becomes
 * ACTIVE — and therefore servable — through this call, so nothing reaches a
 * student until a human has confirmed the key.
 */
route('PUT', '/api/teacher/questions/:id/options', 'question.bank.write', (ctx) => {
  const q = get('SELECT * FROM questions WHERE id = ?', Number(ctx.params.id));
  if (!q) throw notFound('找不到題目');

  const options = Array.isArray(ctx.body?.options) ? ctx.body.options : [];
  if (options.length < 2) throw badRequest('至少需要兩個選項', 'TOO_FEW_OPTIONS');
  if (options.some((o) => !String(o.contentZh ?? '').trim())) {
    throw badRequest('選項內容不可空白', 'EMPTY_OPTION');
  }

  const correct = options.filter((o) => o.isCorrect);
  if (correct.length === 0) throw badRequest('請指定正確答案', 'NO_ANSWER_KEY');
  if (q.type === 'MCQ' && correct.length > 1) {
    throw badRequest('單選題只能有一個正確答案', 'TOO_MANY_CORRECT');
  }

  const labels = options.map((o, i) => String(o.label ?? String.fromCharCode(65 + i)).toUpperCase());
  if (new Set(labels).size !== labels.length) throw badRequest('選項代號重複', 'DUPLICATE_LABEL');

  return tx(() => {
    run('DELETE FROM question_options WHERE question_id = ?', q.id);
    options.forEach((o, i) => run(
      `INSERT INTO question_options (question_id, label, content_zh, content_en, is_correct, seq)
       VALUES (?, ?, ?, ?, ?, ?)`,
      q.id, labels[i], String(o.contentZh).trim(), o.contentEn ?? null, o.isCorrect ? 1 : 0, i,
    ));
    run("UPDATE questions SET status = 'ACTIVE', updated_at = ? WHERE id = ?", now(), q.id);

    audit({
      actorId: ctx.user.id, action: 'question.options_filled',
      target: `question:${q.id}`, detail: { answer: labels.filter((_, i) => options[i].isCorrect) },
      ip: ctx.ip,
    });
    return {
      question: serializeQuestion(get('SELECT * FROM questions WHERE id = ?', q.id), { withAnswer: true }),
      remainingDrafts: get("SELECT COUNT(*) AS n FROM questions WHERE status = 'DRAFT'").n,
    };
  });
});

// -------------------------------------------------------------- assignments --

route('GET', '/api/teacher/assignments', 'assignment.manage', (ctx) => {
  const ids = myClasses(ctx.user).map((c) => c.id);
  if (ids.length === 0) return { assignments: [] };

  const rows = all(
    `SELECT * FROM assignments WHERE class_id IN (${ids.map(() => '?').join(',')})
      ORDER BY created_at DESC`,
    ...ids,
  );

  return {
    assignments: rows.map((a) => {
      const total = get(
        "SELECT COUNT(*) AS n FROM users WHERE class_id = ? AND role = 'STUDENT' AND status = 'ACTIVE'",
        a.class_id,
      ).n;
      const submitted = get(
        "SELECT COUNT(DISTINCT user_id) AS n FROM submissions WHERE assignment_id = ? AND status = 'SUBMITTED'",
        a.id,
      ).n;
      return {
        ...serializeAssignment({
          ...a,
          max_score: get(
            'SELECT COALESCE(SUM(points), 0) AS t FROM assignment_questions WHERE assignment_id = ?', a.id,
          ).t,
        }),
        studentCount: total,
        submittedCount: submitted,
      };
    }),
  };
});

route('POST', '/api/teacher/assignments', 'assignment.manage', (ctx) => {
  const b = ctx.body ?? {};
  const classId = assertTeachesClass(ctx.user, b.classId);

  const title = String(b.title ?? '').trim();
  if (!title) throw badRequest('請輸入標題');

  // De-duplicated: assignment_questions is keyed on (assignment, question), so
  // a repeated id would otherwise fail at the database with a 500 rather than
  // telling the teacher what was wrong.
  const questionIds = [...new Set((Array.isArray(b.questionIds) ? b.questionIds : []).map(Number))]
    .filter(Number.isInteger);
  if (questionIds.length === 0) throw badRequest('請至少選一題', 'NO_QUESTIONS');

  const points = b.pointsPerQuestion === undefined ? 1 : Number(b.pointsPerQuestion);
  if (!Number.isFinite(points) || points <= 0) throw badRequest('每題分數必須大於 0', 'BAD_POINTS');

  const openAt = b.openAt == null ? null : Number(b.openAt);
  const dueAt = b.dueAt == null ? null : Number(b.dueAt);
  if (openAt != null && dueAt != null && openAt > dueAt) {
    throw badRequest('開放時間不能晚於截止時間', 'WINDOW_INVERTED');
  }

  const timeLimit = b.timeLimitSeconds == null ? null : Number(b.timeLimitSeconds);
  if (timeLimit != null && (!Number.isFinite(timeLimit) || timeLimit <= 0)) {
    throw badRequest('限時必須大於 0', 'BAD_TIME_LIMIT');
  }

  // The schema refuses a reveal rule whose timestamp is missing. Checking it
  // here turns that from an opaque database failure into an answerable message.
  const reveal = b.reveal ?? 'AFTER_SUBMIT';
  if (!['NEVER', 'AFTER_SUBMIT', 'AFTER_DUE', 'AT_TIME'].includes(reveal)) {
    throw badRequest('不支援的答案公開方式', 'BAD_REVEAL');
  }
  if (reveal === 'AFTER_DUE' && dueAt == null) {
    throw badRequest('選「截止後公開答案」就必須設截止時間', 'REVEAL_NEEDS_DUE');
  }
  const revealAt = b.revealAt == null ? null : Number(b.revealAt);
  if (reveal === 'AT_TIME' && revealAt == null) {
    throw badRequest('選「指定時間公開答案」就必須設那個時間', 'REVEAL_NEEDS_TIME');
  }

  // Every question must be gradeable before the paper can exist, so a student
  // can never open a paper containing a question that cannot be marked.
  const ungradeable = questionIds.filter((id) => !get(
    'SELECT 1 AS ok FROM question_options WHERE question_id = ? AND is_correct = 1', id,
  ));
  if (ungradeable.length) {
    throw badRequest(`題目 ${ungradeable.join(', ')} 尚未設定正確答案`, 'NO_ANSWER_KEY');
  }

  const maxAttempts = Math.max(Number(b.maxAttempts) || 1, 1);
  const strategy = maxAttempts > 1 ? (b.scoreStrategy ?? 'LAST') : 'LAST';

  return tx(() => {
    const t = now();
    const r = run(
      `INSERT INTO assignments
         (code, title, subject_id, class_id, created_by, kind, open_at, due_at, time_limit_s,
          shuffle, allow_late, max_attempts, score_strategy, reveal, reveal_at, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      String(b.code ?? '').trim() || `A-${t.toString(36).toUpperCase()}`,
      title, Number(b.subjectId ?? 1), classId,
      ctx.user.id, b.kind === 'TEST' ? 'TEST' : 'HOMEWORK',
      openAt, dueAt, timeLimit,
      b.shuffle ? 1 : 0, b.allowLate ? 1 : 0, maxAttempts, strategy,
      reveal, revealAt, 'DRAFT', t, t,
    );
    const id = Number(r.lastInsertRowid);

    questionIds.forEach((qid, i) => run(
      'INSERT INTO assignment_questions (assignment_id, question_id, seq, points) VALUES (?, ?, ?, ?)',
      id, qid, i + 1, points,
    ));

    audit({ actorId: ctx.user.id, action: 'assignment.create', target: `assignment:${id}`, ip: ctx.ip });
    return { assignment: serializeAssignment(get('SELECT * FROM assignments WHERE id = ?', id)) };
  });
});

route('POST', '/api/teacher/assignments/:id/publish', 'assignment.manage', (ctx) => {
  const a = loadAssignmentFor(ctx.user, ctx.params.id, 'manage');
  if (a.status === 'PUBLISHED') return { assignment: serializeAssignment(a) };
  if (a.status === 'CLOSED') throw conflict('已結束的作業不能重新發佈', 'ALREADY_CLOSED');

  run("UPDATE assignments SET status = 'PUBLISHED', updated_at = ? WHERE id = ?", now(), a.id);
  audit({ actorId: ctx.user.id, action: 'assignment.publish', target: `assignment:${a.id}`, ip: ctx.ip });
  return { assignment: serializeAssignment(get('SELECT * FROM assignments WHERE id = ?', a.id)) };
});

route('GET', '/api/teacher/assignments/:id/scores', 'assignment.grade.read', (ctx) => {
  const a = loadAssignmentFor(ctx.user, ctx.params.id, 'manage');
  const students = all(
    `SELECT id, username, display_name FROM users
      WHERE class_id = ? AND role = 'STUDENT' AND status = 'ACTIVE' ORDER BY display_name`,
    a.class_id,
  );

  return {
    assignment: serializeAssignment(a),
    // One row per enrolled student, including those who never started, so the
    // table shows who is missing instead of silently omitting them.
    rows: students.map((s) => {
      // The attempt the paper's scoring rule says counts — not simply the
      // newest one, which would make BEST and FIRST meaningless.
      const order = {
        BEST: 'score DESC, attempt_no DESC',
        FIRST: 'attempt_no ASC',
        LAST: 'attempt_no DESC',
      }[a.score_strategy] ?? 'attempt_no DESC';
      const sub = get(
        `SELECT * FROM submissions WHERE assignment_id = ? AND user_id = ?
          ORDER BY (status = 'IN_PROGRESS') DESC, ${order} LIMIT 1`,
        a.id, s.id,
      );
      return {
        studentId: s.id,
        username: s.username,
        displayName: s.display_name,
        status: sub?.status ?? 'NOT_STARTED',
        score: sub?.score ?? null,
        maxScore: sub?.max_score ?? null,
        submittedAt: sub?.submitted_at ?? null,
        late: sub?.late === 1,
      };
    }),
  };
});

route('GET', '/api/teacher/assignments/:id/analysis', 'assignment.grade.read', (ctx) => {
  const a = loadAssignmentFor(ctx.user, ctx.params.id, 'manage');
  const rows = all(
    `SELECT aq.seq, aq.points, q.id, q.content_zh, q.topic_id, q.official_correct_rate,
            COUNT(sa.submission_id) AS answered,
            SUM(CASE WHEN sa.is_correct = 1 THEN 1 ELSE 0 END) AS correct
       FROM assignment_questions aq
       JOIN questions q ON q.id = aq.question_id
       LEFT JOIN submission_answers sa ON sa.question_id = q.id
            AND sa.submission_id IN (
              SELECT id FROM submissions WHERE assignment_id = ? AND status = 'SUBMITTED'
            )
      WHERE aq.assignment_id = ?
      GROUP BY q.id ORDER BY aq.seq`,
    a.id, a.id,
  );

  return {
    assignment: serializeAssignment(a),
    questions: rows.map((r) => ({
      questionId: r.id,
      seq: r.seq,
      preview: r.content_zh.slice(0, 80),
      topicId: r.topic_id,
      answered: r.answered,
      classCorrectRate: r.answered > 0 ? r.correct / r.answered : null,
      officialCorrectRate: r.official_correct_rate,
    })),
  };
});

/**
 * Which topics a class may practise. Returns a row per topic including the
 * ones never touched, so the toggle screen shows the real state instead of an
 * empty list that looks like "nothing is configured".
 */
route('GET', '/api/teacher/classes/:classId/topics', 'assignment.manage', (ctx) => {
  const classId = assertTeachesClass(ctx.user, ctx.params.classId);
  const rows = all(
    `SELECT t.*, ct.is_open, ct.updated_at, ct.updated_by
       FROM topics t
       LEFT JOIN class_topics ct ON ct.topic_id = t.id AND ct.class_id = ?
      WHERE t.subject_id = ? ORDER BY t.seq, t.id`,
    classId, Number(ctx.query.get('subjectId') ?? 1),
  );

  return {
    classId,
    topics: rows.map((t) => ({
      ...serializeTopic(t),
      open: t.is_open == null || t.is_open === 1,
      // True when a teacher actually set it, as opposed to it merely defaulting.
      explicitlySet: t.is_open != null,
      updatedAt: t.updated_at ?? null,
      questionCount: get(
        `SELECT COUNT(*) AS n FROM questions q
          WHERE q.topic_id = ? AND q.status = 'ACTIVE'
            AND EXISTS (SELECT 1 FROM question_options o WHERE o.question_id = q.id AND o.is_correct = 1)`,
        t.id,
      ).n,
    })),
  };
});

route('PUT', '/api/teacher/classes/:classId/topics/:topicId', 'assignment.manage', (ctx) => {
  const classId = assertTeachesClass(ctx.user, ctx.params.classId);
  const topicId = Number(ctx.params.topicId);
  if (!get('SELECT 1 AS ok FROM topics WHERE id = ?', topicId)) throw notFound('找不到課題');

  const open = ctx.body?.open;
  if (typeof open !== 'boolean') throw badRequest('open 必須是布林值');

  const t = now();
  run(
    `INSERT INTO class_topics (class_id, topic_id, is_open, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (class_id, topic_id)
     DO UPDATE SET is_open = excluded.is_open, updated_by = excluded.updated_by,
                   updated_at = excluded.updated_at`,
    classId, topicId, open ? 1 : 0, ctx.user.id, t,
  );
  audit({
    actorId: ctx.user.id, action: 'class.topic_toggle',
    target: `class:${classId}/topic:${topicId}`, detail: { open }, ip: ctx.ip,
  });
  return { classId, topicId, open };
});

// --------------------------------------------------------------- admin only --

route('GET', '/api/admin/topics', 'topic.manage', (ctx) => ({
  topics: all(
    'SELECT * FROM topics WHERE subject_id = ? ORDER BY seq, id',
    Number(ctx.query.get('subjectId') ?? 1),
  ).map(serializeTopic),
}));

route('PATCH', '/api/admin/topics/:id', 'topic.manage', (ctx) => {
  const t = get('SELECT * FROM topics WHERE id = ?', Number(ctx.params.id));
  if (!t) throw notFound('找不到課題');
  const enabled = ctx.body?.enabled;
  if (typeof enabled !== 'boolean') throw badRequest('enabled 必須是布林值');

  run('UPDATE topics SET enabled = ? WHERE id = ?', enabled ? 1 : 0, t.id);
  audit({ actorId: ctx.user.id, action: 'topic.toggle', target: `topic:${t.id}`, detail: { enabled }, ip: ctx.ip });
  return { topic: serializeTopic(get('SELECT * FROM topics WHERE id = ?', t.id)) };
});

route('GET', '/api/admin/audit', 'audit.read', (ctx) => ({
  entries: all(
    'SELECT * FROM audit_log ORDER BY at DESC LIMIT ?',
    Math.min(Number(ctx.query.get('limit')) || 100, 500),
  ),
}));

export { ForbiddenError };
