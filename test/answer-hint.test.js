import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { suggestAnswer, suggestAnswerWithEvidence } from '../server/answer-hint.js';

describe('suggestAnswer', () => {
  test('reads the common "故選X" phrasing', () => {
    assert.equal(suggestAnswer('…適合一般公司，故選C。採用TCP/IP…'), 'C');
    assert.equal(suggestAnswer('…不需太多專業技術知識，故選D。'), 'D');
    assert.equal(suggestAnswer('因此選A。'), 'A');
  });

  test('reads "正確答案為X" and its variants', () => {
    assert.equal(suggestAnswer('正確答案為B。'), 'B');
    assert.equal(suggestAnswer('答案是 (D)'), 'D');
  });

  test('reads "故X對" and "因此X正確"', () => {
    assert.equal(suggestAnswer('…須待用戶按下文字後才連到該圖，故C對。文字只作連結用…'), 'C');
    assert.equal(suggestAnswer('…必須採用相同的SSID，故B對。'), 'B');
  });

  /**
   * The case that makes a loose pattern dangerous: the letters name the
   * statements the question lists, not the option to pick. Suggesting one of
   * them would pre-select a wrong answer with an air of confidence.
   */
  test('refuses a list of letters rather than guessing the first', () => {
    assert.equal(suggestAnswer('…並能輔助長者及傷殘人士生活，故A、B、C正確。'), null);
    assert.equal(suggestAnswer('故A及B正確。'), null);
    assert.equal(suggestAnswer('因此 (A)、(C) 正確。'), null);
  });

  test('returns null when the explanation never names an answer', () => {
    assert.equal(suggestAnswer('這段詳解只解釋概念，沒有講答案。'), null);
    assert.equal(suggestAnswer(''), null);
    assert.equal(suggestAnswer(null), null);
    assert.equal(suggestAnswer(undefined), null);
  });

  test('never suggests a label the question does not have', () => {
    assert.equal(suggestAnswer('故選D。', ['A', 'B', 'C']), null);
    assert.equal(suggestAnswer('故選C。', ['A', 'B', 'C']), 'C');
  });

  test('is case-insensitive about the letter', () => {
    assert.equal(suggestAnswer('故選c。'), 'C');
  });

  test('carries the phrase it matched, so the choice can be checked', () => {
    const { label, evidence } = suggestAnswerWithEvidence('網絡保安較高，適合一般公司，故選C。採用…');
    assert.equal(label, 'C');
    assert.match(evidence, /故選C/);
  });

  test('evidence is null when there is nothing to show', () => {
    assert.deepEqual(suggestAnswerWithEvidence('沒有答案'), { label: null, evidence: null });
  });
});
