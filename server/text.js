/**
 * Text normalisation applied to imported question content.
 *
 * The source bank stores HTML-escaped text, so a pseudocode question arrives
 * as "如果 (MARKS &gt;= 50)則 輸出 &#39;PASS&#39;". Rendering that verbatim puts
 * the entities in front of the student, so they are decoded once on the way
 * in — the database holds the real characters, and every reader gets them.
 */

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', hellip: '…',
  middot: '·', times: '×', divide: '÷', ne: '≠', le: '≤', ge: '≥',
};

export function decodeEntities(text) {
  if (typeof text !== 'string' || !text.includes('&')) return text;
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    // &amp; is handled last, so an escaped entity ("&amp;lt;") survives as the
    // literal text "&lt;" instead of collapsing all the way to "<".
    .replace(
      /&(lt|gt|quot|apos|nbsp|ldquo|rdquo|lsquo|rsquo|hellip|middot|times|divide|ne|le|ge|amp);/g,
      (_, name) => NAMED[name],
    );
}
