/**
 * Merge whatever question data we have into the database.
 *
 * The exports arrive in pieces and none of them is complete on its own:
 *
 *   - the bulk question dump has 960 stems, explanations and metadata, but no
 *     options and no answer key;
 *   - a submitted assignment's review has options, and carries the answer key
 *     only once the teacher has let answers be revealed;
 *   - the error book and redo generator cover whatever has been practised.
 *
 * So this reads any number of files, keys everything by question id, and lets
 * a later file fill gaps a earlier one left. A question that still has no
 * answer key at the end is imported as DRAFT, which the practice and paper
 * builders refuse to serve — an unanswerable question must never reach a
 * student, and silence here is what produced "此題無法評分" in the original.
 *
 * Usage:
 *   node scripts/import-questions.mjs <file...> [--db path] [--dry-run]
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { openDb, setDb, run, get, all, tx, now } from '../server/db.js';
import { decodeEntities } from '../server/text.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const dbIndex = args.indexOf('--db');
const dbPath = dbIndex >= 0 ? args[dbIndex + 1] : undefined;
const files = args.filter((a, i) => !a.startsWith('--') && !(dbIndex >= 0 && i === dbIndex + 1));

if (files.length === 0) {
  console.error('用法：node scripts/import-questions.mjs <匯出檔...> [--db 路徑] [--dry-run]');
  process.exit(1);
}

setDb(openDb(dbPath));

// ------------------------------------------------------------------ parsing --

/** Pull the question array out of whichever export shape this file is. */
function questionsIn(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.questions)) return payload.questions;
  if (Array.isArray(payload.data)) return payload.data;
  return [];
}

const pick = (obj, ...names) => {
  for (const n of names) {
    if (obj[n] != null) return typeof obj[n] === 'string' ? decodeEntities(obj[n]) : obj[n];
  }
  return null;
};

/**
 * "…適合一般公司，故選C。" — the Chinese explanations routinely name the
 * answer. Used only as a last resort, and only when the option letter it
 * names actually exists on the question.
 */
const ANSWER_IN_TEXT = /(?:故|應|因此|所以)?(?:選|答案(?:為|是)|正確答案(?:為|是)?)\s*[（(]?([A-Da-d])[）)]?/;

function answerFromExplanation(text, labels) {
  if (!text) return null;
  const m = ANSWER_IN_TEXT.exec(text);
  if (!m) return null;
  const label = m[1].toUpperCase();
  return labels.includes(label) ? label : null;
}

// ------------------------------------------------------------------ merging --

/** id -> merged record. Later files fill gaps; they never overwrite good data. */
const merged = new Map();

function absorb(row, origin) {
  const id = Number(pick(row, 'id', 'questionId'));
  if (!Number.isInteger(id)) return;

  const existing = merged.get(id) ?? { id, sources: [] };
  const out = { ...existing };
  out.sources = [...existing.sources, origin];

  out.subjectId = existing.subjectId ?? pick(row, 'subjectId') ?? 1;
  out.topicId = existing.topicId ?? pick(row, 'topicId');
  out.type = existing.type ?? pick(row, 'type') ?? 'MCQ';
  out.contentZh = existing.contentZh ?? pick(row, 'contentZh', 'content');
  out.contentEn = existing.contentEn ?? pick(row, 'contentEn');
  out.explanationZh = existing.explanationZh ?? pick(row, 'explanationZh', 'explanation');
  out.explanationEn = existing.explanationEn ?? pick(row, 'explanationEn');
  out.source = existing.source ?? pick(row, 'source');
  out.examYear = existing.examYear ?? pick(row, 'examYear');
  out.figureZh = existing.figureZh ?? pick(row, 'figureUrlZh', 'figureZh');
  out.figureEn = existing.figureEn ?? pick(row, 'figureUrlEn', 'figureEn');
  out.difficulty = existing.difficulty ?? pick(row, 'difficulty');
  out.officialCorrectRate = existing.officialCorrectRate ?? pick(row, 'officialCorrectRate');

  // Options: keep the first set that has any, then let a later file supply the
  // answer key if this one lacked it.
  const incoming = Array.isArray(row.options) ? row.options : null;
  if (incoming?.length) {
    if (!out.options?.length) {
      out.options = incoming.map((o, i) => ({
        optionId: pick(o, 'id', 'optionId'),
        label: String(pick(o, 'label') ?? String.fromCharCode(65 + i)).toUpperCase(),
        contentZh: decodeEntities(pick(o, 'contentZh', 'content') ?? ''),
        contentEn: decodeEntities(pick(o, 'contentEn')),
        isCorrect: typeof o.isCorrect === 'boolean' ? o.isCorrect : null,
      }));
      if (out.options.some((o) => o.isCorrect === true)) out.keySource = 'export';
    } else if (out.options.every((o) => o.isCorrect == null)) {
      const keyed = new Map(incoming.map((o) => [String(pick(o, 'label') ?? '').toUpperCase(), o]));
      for (const o of out.options) {
        const match = keyed.get(o.label);
        if (match && typeof match.isCorrect === 'boolean') o.isCorrect = match.isCorrect;
      }
      if (out.options.some((o) => o.isCorrect === true)) out.keySource = 'export';
    }
  }

  // A review row says whether *this student* was right and which option they
  // picked. When they were right, their pick is the answer — the one case
  // where a per-student field is safe to promote into the shared bank.
  if (row.isCorrect === true && pick(row, 'selectedOptionId') != null && out.options?.length) {
    const chosen = Number(pick(row, 'selectedOptionId'));
    if (out.options.every((o) => o.isCorrect == null)) {
      for (const o of out.options) o.isCorrect = o.optionId === chosen;
      out.keySource = 'own-correct-answer';
    }
  }

  merged.set(id, out);
}

for (const file of files) {
  let payload;
  try {
    payload = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`× ${file}：${err.message}`);
    continue;
  }
  const rows = questionsIn(payload);
  for (const r of rows) absorb(r, basename(file));
  console.log(`讀入 ${basename(file)}：${rows.length} 筆`);

  // Some exports carry the topic list; it is the only authoritative mapping
  // from the numeric topicId in the bulk dump to a name.
  if (Array.isArray(payload.topics) && !dryRun) importTopics(payload.topics);
}

function importTopics(topics) {
  tx(() => {
    for (const t of topics) {
      run(
        `INSERT INTO topics (id, subject_id, code, name_zh, name_en, seq)
         VALUES (?, 1, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           code = excluded.code, name_zh = excluded.name_zh,
           name_en = excluded.name_en, seq = excluded.seq`,
        t.id, t.code, t.nameZh ?? t.name_zh ?? t.code, t.nameEn ?? t.name_en ?? t.code,
        t.sortOrder ?? t.seq ?? t.id,
      );
    }
  });
  console.log(`  課題 ${topics.length} 個已寫入`);
}

// ----------------------------------------------------------------- resolving --

const stats = {
  total: merged.size, withOptions: 0, keyed: 0,
  keyedFromOptions: 0, keyedFromOwnAnswer: 0, keyedFromExplanation: 0,
  draft: 0, noStem: 0,
};

for (const q of merged.values()) {
  if (!q.contentZh) { stats.noStem += 1; continue; }
  if (!q.options?.length) continue;
  stats.withOptions += 1;

  if (q.options.some((o) => o.isCorrect === true)) {
    stats.keyed += 1;
    if (q.keySource === 'own-correct-answer') stats.keyedFromOwnAnswer += 1;
    else stats.keyedFromOptions += 1;
    continue;
  }

  const guess = answerFromExplanation(q.explanationZh, q.options.map((o) => o.label));
  if (guess) {
    for (const o of q.options) o.isCorrect = o.label === guess;
    q.keySource = 'explanation';
    stats.keyed += 1;
    stats.keyedFromExplanation += 1;
  }
}

// ------------------------------------------------------------------ writing --

if (dryRun) {
  report();
  process.exit(0);
}

// Ensure a subject and a placeholder topic exist before the foreign keys bite.
run(
  `INSERT INTO subjects (id, code, name_zh, name_en) VALUES (1, 'ICT', '資訊及通訊科技', 'ICT')
   ON CONFLICT (id) DO NOTHING`,
);
const knownTopics = new Set(all('SELECT id FROM topics').map((t) => t.id));

let written = 0;
tx(() => {
  for (const q of merged.values()) {
    if (!q.contentZh) continue;

    const keyed = q.options?.some((o) => o.isCorrect === true) ?? false;
    // No key means no student may ever be shown it.
    const status = keyed ? 'ACTIVE' : 'DRAFT';
    if (!keyed) stats.draft += 1;

    const t = now();
    run(
      `INSERT INTO questions
         (id, subject_id, topic_id, type, content_zh, content_en, explanation_zh, explanation_en,
          source, exam_year, figure_zh, figure_en, difficulty, official_correct_rate,
          status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         topic_id = excluded.topic_id, content_zh = excluded.content_zh,
         content_en = excluded.content_en, explanation_zh = excluded.explanation_zh,
         explanation_en = excluded.explanation_en, difficulty = excluded.difficulty,
         official_correct_rate = excluded.official_correct_rate,
         status = excluded.status, updated_at = excluded.updated_at`,
      q.id, q.subjectId ?? 1,
      knownTopics.has(Number(q.topicId)) ? Number(q.topicId) : null,
      q.type ?? 'MCQ', q.contentZh, q.contentEn, q.explanationZh, q.explanationEn,
      q.source, q.examYear, q.figureZh, q.figureEn, q.difficulty,
      q.officialCorrectRate, status, t, t,
    );

    if (q.options?.length) {
      run('DELETE FROM question_options WHERE question_id = ?', q.id);
      q.options.forEach((o, i) => run(
        `INSERT INTO question_options (question_id, label, content_zh, content_en, is_correct, seq)
         VALUES (?, ?, ?, ?, ?, ?)`,
        q.id, o.label, o.contentZh, o.contentEn, o.isCorrect === true ? 1 : 0, i,
      ));
    }
    written += 1;
  }
});

report();
console.log(`\n寫入 ${written} 題。`);
console.log(`可立即練習（ACTIVE）：${get("SELECT COUNT(*) AS n FROM questions WHERE status = 'ACTIVE'").n}`);
console.log(`待補選項或答案（DRAFT）：${get("SELECT COUNT(*) AS n FROM questions WHERE status = 'DRAFT'").n}`);

function report() {
  console.log('\n──── 合併結果 ────');
  console.log(`題目總數            ${stats.total}`);
  if (stats.noStem) console.log(`缺題幹、已略過      ${stats.noStem}`);
  console.log(`有選項              ${stats.withOptions}`);
  console.log(`有正確答案          ${stats.keyed}`);
  console.log(`  ├ 匯出自帶        ${stats.keyedFromOptions}`);
  console.log(`  ├ 由自己答對推得  ${stats.keyedFromOwnAnswer}`);
  console.log(`  └ 由詳解文字推得  ${stats.keyedFromExplanation}`);
  console.log(`缺選項或答案        ${stats.total - stats.noStem - stats.keyed}`);
}
