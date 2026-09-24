import { route } from '../http.js';
import { all, get } from '../db.js';
import { assertTeachesClass } from '../rbac.js';

/**
 * Progress: what a student has learned, and how a class is doing.
 *
 * A student can already see their own numbers on the dashboard, but only in
 * aggregate. This is the view of themselves that a teacher already had of
 * them — per topic, over time — because a student who cannot see where they
 * are weak has to be told, and mostly nobody tells them.
 */

const DAY = 86_400_000;

/** Correct-rate per topic for one student, topics never touched included. */
function topicBreakdown(userId, subjectId = 1) {
  return all(
    `SELECT t.id, t.name_zh, t.code,
            COUNT(a.id) AS answered,
            SUM(CASE WHEN a.is_correct = 1 THEN 1 ELSE 0 END) AS correct,
            (SELECT COUNT(*) FROM wrong_book w
               JOIN questions wq ON wq.id = w.question_id
              WHERE w.user_id = ? AND w.cleared_at IS NULL AND wq.topic_id = t.id) AS open_wrong,
            (SELECT COUNT(*) FROM questions q2
              WHERE q2.topic_id = t.id AND q2.status = 'ACTIVE'
                AND EXISTS (SELECT 1 FROM question_options o
                             WHERE o.question_id = q2.id AND o.is_correct = 1)) AS pool
       FROM topics t
       LEFT JOIN questions q ON q.topic_id = t.id
       LEFT JOIN attempts a ON a.question_id = q.id AND a.user_id = ?
      WHERE t.subject_id = ? AND t.enabled = 1
      GROUP BY t.id ORDER BY t.seq`,
    userId, userId, subjectId,
  ).map((r) => ({
    topicId: r.id,
    code: r.code,
    name: r.name_zh,
    answered: r.answered,
    // Null, not zero: a topic never attempted has no accuracy, and drawing it
    // as an empty bar would read as "got everything wrong".
    accuracy: r.answered > 0 ? r.correct / r.answered : null,
    openWrong: r.open_wrong,
    questionCount: r.pool,
  }));
}

/**
 * Answers per day for the last `days` days, with empty days present.
 *
 * Buckets are calendar days, anchored to local midnight. Counting back in
 * 24-hour steps from the instant of the request instead puts an answer given
 * moments ago into yesterday, because the window start is computed a few
 * milliseconds after the answer was recorded.
 */
function dailyActivity(userId, days = 28, at = Date.now()) {
  const midnight = new Date(at);
  midnight.setHours(0, 0, 0, 0);
  const start = midnight.getTime() - (days - 1) * DAY;
  const counted = new Map(all(
    `SELECT CAST((answered_at - ?) / ? AS INTEGER) AS bucket,
            COUNT(*) AS answered,
            SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END) AS correct
       FROM attempts WHERE user_id = ? AND answered_at >= ?
      GROUP BY bucket`,
    start, DAY, userId, start,
  ).map((r) => [r.bucket, r]));

  // Days with nothing are returned as zeros rather than omitted, so a chart
  // shows the gaps instead of quietly compressing them away.
  return Array.from({ length: days }, (_, i) => {
    const row = counted.get(i);
    return {
      date: new Date(start + i * DAY).toISOString().slice(0, 10),
      answered: row?.answered ?? 0,
      correct: row?.correct ?? 0,
    };
  });
}

/** Consecutive days ending today (or yesterday) with at least one answer. */
function streak(activity) {
  let count = 0;
  for (let i = activity.length - 1; i >= 0; i -= 1) {
    if (activity[i].answered > 0) count += 1;
    // Today being empty does not break a streak that is still live; an empty
    // day before that does.
    else if (i < activity.length - 1) break;
  }
  return count;
}

route('GET', '/api/me/progress', 'self.read', (ctx) => {
  const subjectId = Number(ctx.query.get('subjectId') ?? 1);
  const topics = topicBreakdown(ctx.user.id, subjectId);
  const activity = dailyActivity(ctx.user.id);

  const totals = get(
    `SELECT COUNT(*) AS answered, SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END) AS correct
       FROM attempts WHERE user_id = ?`,
    ctx.user.id,
  );
  const attempted = topics.filter((t) => t.answered > 0);

  return {
    totals: {
      answered: totals.answered,
      accuracy: totals.answered > 0 ? totals.correct / totals.answered : null,
      openWrong: get(
        'SELECT COUNT(*) AS n FROM wrong_book WHERE user_id = ? AND cleared_at IS NULL', ctx.user.id,
      ).n,
      clearedWrong: get(
        'SELECT COUNT(*) AS n FROM wrong_book WHERE user_id = ? AND cleared_at IS NOT NULL', ctx.user.id,
      ).n,
      streakDays: streak(activity),
    },
    topics,
    // The three weakest topics they have actually attempted — suggesting one
    // they have never opened would say nothing about them.
    weakest: [...attempted].sort((a, b) => a.accuracy - b.accuracy).slice(0, 3),
    strongest: [...attempted].sort((a, b) => b.accuracy - a.accuracy).slice(0, 3),
    activity,
    submissions: all(
      `SELECT s.score, s.max_score, s.submitted_at, a.title, a.code, a.id AS assignment_id
         FROM submissions s JOIN assignments a ON a.id = s.assignment_id
        WHERE s.user_id = ? AND s.status = 'SUBMITTED'
        ORDER BY s.submitted_at DESC LIMIT 20`,
      ctx.user.id,
    ).map((s) => ({
      assignmentId: s.assignment_id,
      code: s.code,
      title: s.title,
      submittedAt: s.submitted_at,
      score: s.score,
      maxScore: s.max_score,
      rate: s.max_score > 0 ? s.score / s.max_score : null,
    })),
  };
});

// ------------------------------------------------------------- class view --

route('GET', '/api/teacher/classes/:classId/analytics', 'analytics.read', (ctx) => {
  const classId = assertTeachesClass(ctx.user, ctx.params.classId);
  const subjectId = Number(ctx.query.get('subjectId') ?? 1);

  const students = all(
    `SELECT id, username, display_name FROM users
      WHERE class_id = ? AND role = 'STUDENT' AND status = 'ACTIVE'`,
    classId,
  );

  const perTopic = all(
    `SELECT t.id, t.name_zh,
            COUNT(a.id) AS answered,
            SUM(CASE WHEN a.is_correct = 1 THEN 1 ELSE 0 END) AS correct,
            COUNT(DISTINCT a.user_id) AS students
       FROM topics t
       LEFT JOIN questions q ON q.topic_id = t.id
       LEFT JOIN attempts a ON a.question_id = q.id
            AND a.user_id IN (SELECT id FROM users WHERE class_id = ? AND role = 'STUDENT')
      WHERE t.subject_id = ? AND t.enabled = 1
      GROUP BY t.id ORDER BY t.seq`,
    classId, subjectId,
  ).map((r) => ({
    topicId: r.id,
    name: r.name_zh,
    answered: r.answered,
    studentsAttempted: r.students,
    accuracy: r.answered > 0 ? r.correct / r.answered : null,
  }));

  /**
   * Questions this class gets wrong far more often than the published rate
   * suggests they should — the ones worth spending a lesson on. Restricted to
   * questions several students have actually tried, so one person's bad day
   * does not put a question at the top of the list.
   */
  const hotspots = all(
    `SELECT q.id, q.content_zh, q.topic_id, q.official_correct_rate,
            COUNT(*) AS attempts,
            COUNT(DISTINCT a.user_id) AS students,
            SUM(CASE WHEN a.is_correct = 1 THEN 1 ELSE 0 END) AS correct
       FROM attempts a JOIN questions q ON q.id = a.question_id
      WHERE a.user_id IN (SELECT id FROM users WHERE class_id = ? AND role = 'STUDENT')
      GROUP BY q.id
     HAVING students >= 2 AND correct * 1.0 / attempts < 0.5
      ORDER BY correct * 1.0 / attempts ASC, students DESC
      LIMIT 10`,
    classId,
  ).map((r) => ({
    questionId: r.id,
    preview: r.content_zh.slice(0, 80),
    topicId: r.topic_id,
    students: r.students,
    classAccuracy: r.correct / r.attempts,
    officialCorrectRate: r.official_correct_rate,
  }));

  const roster = students.map((s) => {
    const stats = get(
      `SELECT COUNT(*) AS answered, SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END) AS correct
         FROM attempts WHERE user_id = ?`,
      s.id,
    );
    return {
      studentId: s.id,
      username: s.username,
      displayName: s.display_name,
      answered: stats.answered,
      accuracy: stats.answered > 0 ? stats.correct / stats.answered : null,
      openWrong: get(
        'SELECT COUNT(*) AS n FROM wrong_book WHERE user_id = ? AND cleared_at IS NULL', s.id,
      ).n,
      activeDays: get(
        `SELECT COUNT(DISTINCT CAST(answered_at / ? AS INTEGER)) AS n
           FROM attempts WHERE user_id = ? AND answered_at >= ?`,
        DAY, s.id, Date.now() - 28 * DAY,
      ).n,
    };
  });

  const engaged = roster.filter((r) => r.answered > 0);
  return {
    classId,
    studentCount: students.length,
    // Distinguished from "did badly": a student who has not started is a
    // different problem from one who is struggling, and the same number
    // would hide that.
    notStarted: roster.filter((r) => r.answered === 0).map((r) => r.displayName),
    classAccuracy: engaged.length
      ? engaged.reduce((s, r) => s + r.accuracy, 0) / engaged.length
      : null,
    topics: perTopic,
    hotspots,
    roster,
  };
});
