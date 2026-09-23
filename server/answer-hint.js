/**
 * Guessing an answer letter from the Chinese explanation.
 *
 * The DSE explanations in this bank routinely name the answer outright
 * ("…適合一般公司，故選C。"), so a draft question missing its options can at
 * least arrive with the key pre-selected. It is a *hint*: the person filling
 * the question in still confirms it, and nothing is ever marked ACTIVE on the
 * strength of a guess alone.
 *
 * Shared by the importer and the fill-in screen so both agree on what counts.
 */

const PATTERNS = [
  // 故選C / 應選 (C) / 因此選C
  /(?:故|應|因此|所以|遂)\s*選\s*[（(]?([A-Da-d])[）)]?/,
  // 正確答案為C / 答案是 C
  /(?:正確)?答案\s*(?:為|是|應為|應是)\s*[（(]?([A-Da-d])[）)]?/,
  // 選C為正確 / 選 (C) 正確
  /選\s*[（(]?([A-Da-d])[）)]?\s*(?:為|是)?\s*正確/,
  // C為正確答案 / C 是正確的
  /[（(]?([A-Da-d])[）)]?\s*(?:為|是)\s*正確/,
  // 故C對 / 因此B正確。The negative lookahead rejects a *list* of letters:
  // "故A、B、C正確" is a question about which statements hold, where A/B/C
  // name the statements rather than the answer, and suggesting "A" there
  // would be confidently wrong — worse than suggesting nothing.
  /(?:故|因此|所以)\s*[（(]?([A-Da-d])[）)]?(?![）)]?\s*[、,，和及與/]\s*[（(]?[A-Da-d])\s*(?:對|正確)/,
];

/**
 * Returns the suggested label, or null. `labels` restricts the answer to
 * options the question actually has, so a stray letter in prose ("A 公司")
 * cannot produce a key for an option that does not exist.
 */
export function suggestAnswer(explanation, labels = ['A', 'B', 'C', 'D']) {
  if (!explanation) return null;
  const allowed = new Set(labels.map((l) => String(l).toUpperCase()));

  for (const pattern of PATTERNS) {
    const m = pattern.exec(explanation);
    if (!m) continue;
    const label = m[1].toUpperCase();
    if (allowed.has(label)) return label;
  }
  return null;
}

/** The matched phrase, so the UI can show *why* a letter was suggested. */
export function suggestAnswerWithEvidence(explanation, labels) {
  const label = suggestAnswer(explanation, labels);
  if (!label) return { label: null, evidence: null };

  for (const pattern of PATTERNS) {
    const m = pattern.exec(explanation);
    if (m && m[1].toUpperCase() === label) {
      const from = Math.max(0, m.index - 24);
      return { label, evidence: explanation.slice(from, m.index + m[0].length + 6) };
    }
  }
  return { label, evidence: null };
}
