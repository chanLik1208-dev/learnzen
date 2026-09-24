/**
 * The figures a teaching report is written from, with people numbered rather
 * than named.
 *
 * Separate from the route so the guarantee can be tested directly: what this
 * returns is exactly what leaves the building, and a test can assert that no
 * student's name is anywhere in it without needing an API key or a network.
 */
import { all, get, now } from './db.js';

const DAY = 86_400_000;

/** The figures, with people numbered rather than named. */
export function gatherFacts(classId, subjectId) {
  const students = all(
    `SELECT id, display_name FROM users
      WHERE class_id = ? AND role = 'STUDENT' AND status = 'ACTIVE' ORDER BY display_name`,
    classId,
  );
  const alias = new Map(students.map((s, i) => [s.id, `學生${i + 1}`]));

  const topics = all(
    `SELECT t.name_zh, COUNT(a.id) AS answered,
            SUM(CASE WHEN a.is_correct = 1 THEN 1 ELSE 0 END) AS correct,
            COUNT(DISTINCT a.user_id) AS students
       FROM topics t
       LEFT JOIN questions q ON q.topic_id = t.id
       LEFT JOIN attempts a ON a.question_id = q.id
            AND a.user_id IN (SELECT id FROM users WHERE class_id = ? AND role = 'STUDENT')
      WHERE t.subject_id = ? AND t.enabled = 1
      GROUP BY t.id HAVING answered > 0 ORDER BY t.seq`,
    classId, subjectId,
  ).map((r) => ({
    topic: r.name_zh,
    answered: r.answered,
    accuracyPercent: Math.round((r.correct / r.answered) * 100),
    studentsAttempted: r.students,
  }));

  const roster = students.map((s) => {
    const stats = get(
      `SELECT COUNT(*) AS answered, SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END) AS correct
         FROM attempts WHERE user_id = ?`,
      s.id,
    );
    return {
      alias: alias.get(s.id),
      answered: stats.answered,
      accuracyPercent: stats.answered > 0 ? Math.round((stats.correct / stats.answered) * 100) : null,
      openWrong: get(
        'SELECT COUNT(*) AS n FROM wrong_book WHERE user_id = ? AND cleared_at IS NULL', s.id,
      ).n,
      activeDaysLast28: get(
        `SELECT COUNT(DISTINCT CAST(answered_at / ? AS INTEGER)) AS n
           FROM attempts WHERE user_id = ? AND answered_at >= ?`,
        DAY, s.id, now() - 28 * DAY,
      ).n,
    };
  });

  const hardest = all(
    `SELECT q.content_zh, q.official_correct_rate,
            COUNT(*) AS attempts, COUNT(DISTINCT a.user_id) AS students,
            SUM(CASE WHEN a.is_correct = 1 THEN 1 ELSE 0 END) AS correct
       FROM attempts a JOIN questions q ON q.id = a.question_id
      WHERE a.user_id IN (SELECT id FROM users WHERE class_id = ? AND role = 'STUDENT')
      GROUP BY q.id HAVING students >= 2
      ORDER BY correct * 1.0 / attempts ASC LIMIT 5`,
    classId,
  ).map((r) => ({
    question: r.content_zh.slice(0, 120),
    classAccuracyPercent: Math.round((r.correct / r.attempts) * 100),
    publishedAccuracyPercent: r.official_correct_rate == null ? null : Math.round(r.official_correct_rate),
    studentsAttempted: r.students,
  }));

  const engaged = roster.filter((r) => r.accuracyPercent !== null);
  return {
    facts: {
      className: get('SELECT name FROM classes WHERE id = ?', classId).name,
      studentCount: students.length,
      neverStarted: roster.filter((r) => r.answered === 0).length,
      classAccuracyPercent: engaged.length
        ? Math.round(engaged.reduce((s, r) => s + r.accuracyPercent, 0) / engaged.length)
        : null,
      topics,
      students: roster,
      hardestQuestions: hardest,
    },
    alias,
    names: students.map((s) => s.display_name),
  };
}

