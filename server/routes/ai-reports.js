import { route, badRequest, notFound } from '../http.js';
import { all, get, run, now, audit } from '../db.js';
import { assertTeachesClass } from '../rbac.js';
import { consume } from '../ratelimit.js';
import { chat, aiConfig, assertNoNames, AiError } from '../ai.js';
import { gatherFacts } from '../report-facts.js';

/**
 * Written teaching reports, generated from the class's own figures.
 *
 * Two constraints shape this, and both are about what leaves the building:
 *
 *   - Names never go to the model. Students are numbered, the mapping stays
 *     here, and the text comes back referring to 學生1 which is rendered with
 *     the real name locally. A marking analysis does not need to know who
 *     anyone is, and a name sent to somebody else's service cannot be unsent.
 *   - The figures the report was written from are stored with it, so any
 *     claim in the text can be checked against what the model was given
 *     rather than taken on faith.
 *
 * Generating costs money and takes half a minute, so reports are kept and
 * generation is rationed.
 */

const GENERATION_BUDGET = { windowMs: 60 * 60 * 1000, max: 12 };

const SYSTEM = `你是一位香港中學 ICT 科的資深教師，正在替同事寫一份班級學習報告。

規則：
- 只根據提供的數字說話。數字沒有支持的結論不要寫，也不要臆測原因。
- 學生一律用資料中的代號（學生1、學生2…）稱呼。
- 用繁體中文，語氣像同事之間的專業交流，不要客套話、不要條列式的空泛建議。
- 分四段：整體表現、值得注意的課題、需要關注的學生、下一步建議。
- 「需要關注」要分清楚兩種人：做了但答對率低的，和根本沒開始的——他們需要的處理完全不同。
- 全文 400 字以內。`;

route('POST', '/api/teacher/classes/:classId/ai-report', 'ai.report.generate', async (ctx) => {
  const classId = assertTeachesClass(ctx.user, ctx.params.classId);
  const subjectId = Number(ctx.body?.subjectId ?? 1);

  const budget = consume(`ai-report:${ctx.user.id}`, GENERATION_BUDGET);
  if (!budget.allowed) {
    throw badRequest('產生報告的次數已達上限，請稍後再試', 'AI_BUDGET_EXHAUSTED');
  }

  const { facts, alias, names } = gatherFacts(classId, subjectId);
  if (facts.topics.length === 0) {
    throw badRequest('這個班還沒有足夠的作答記錄可以分析', 'NOT_ENOUGH_DATA');
  }

  // The class name is the school's, not a person's, but the roster is
  // numbered — and this refuses to send anything that still is not.
  assertNoNames(facts, names);

  const { content, model, usage } = await chat([
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `以下是這個班的數據：\n\n${JSON.stringify(facts, null, 2)}` },
  ]);

  const id = Number(run(
    `INSERT INTO ai_reports
       (class_id, subject_id, content, input_facts, model, input_tokens, output_tokens, generated_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    classId, subjectId, content, JSON.stringify(facts), model,
    usage.inputTokens, usage.outputTokens, ctx.user.id, now(),
  ).lastInsertRowid);

  audit({
    actorId: ctx.user.id, action: 'ai.report_generated',
    target: `class:${classId}`, ip: ctx.ip,
    detail: { model, tokens: usage },
  });

  return {
    report: {
      id,
      content,
      // The numbers in the text mean nothing on their own, so the mapping is
      // sent back for the interface to render names it already had.
      aliases: Object.fromEntries([...alias].map(([userId, name]) => [name, userId])),
      facts,
      model,
      usage,
      createdAt: now(),
    },
    generationsLeftThisHour: budget.remaining,
  };
});

route('GET', '/api/teacher/classes/:classId/ai-reports', 'ai.report.read', (ctx) => {
  const classId = assertTeachesClass(ctx.user, ctx.params.classId);
  const students = all(
    `SELECT id, display_name FROM users
      WHERE class_id = ? AND role = 'STUDENT' AND status = 'ACTIVE' ORDER BY display_name`,
    classId,
  );
  const aliases = Object.fromEntries(students.map((s, i) => [`學生${i + 1}`, s.display_name]));

  return {
    available: aiConfig().enabled,
    // Stated plainly so the interface can explain why the button does nothing
    // rather than letting someone press it and get an error.
    disabledReason: aiConfig().enabled ? null : '尚未設定 AI 金鑰（LB_AI_KEY）',
    aliases,
    reports: all(
      `SELECT r.*, u.display_name AS author FROM ai_reports r
         LEFT JOIN users u ON u.id = r.generated_by
        WHERE r.class_id = ? ORDER BY r.created_at DESC LIMIT 20`,
      classId,
    ).map((r) => ({
      id: r.id,
      content: r.content,
      model: r.model,
      author: r.author ?? '（已刪除）',
      createdAt: r.created_at,
      usage: { inputTokens: r.input_tokens, outputTokens: r.output_tokens },
    })),
  };
});

/** The figures a given report was written from, for checking a claim in it. */
route('GET', '/api/teacher/ai-reports/:id/facts', 'ai.report.read', (ctx) => {
  const report = get('SELECT * FROM ai_reports WHERE id = ?', Number(ctx.params.id));
  if (!report) throw notFound('找不到報告');
  assertTeachesClass(ctx.user, report.class_id);
  return { facts: JSON.parse(report.input_facts), model: report.model, createdAt: report.created_at };
});

export { AiError };
