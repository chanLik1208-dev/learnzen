import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { decodeEntities } from '../server/text.js';

describe('decodeEntities', () => {
  test('decodes the entities the source bank actually contains', () => {
    assert.equal(decodeEntities('如果 (MARKS &gt;= 50)則'), '如果 (MARKS >= 50)則');
    assert.equal(decodeEntities('輸出 &#39;PASS&#39;'), "輸出 'PASS'");
    assert.equal(decodeEntities('A &amp; B'), 'A & B');
    assert.equal(decodeEntities('&lt;img&gt;'), '<img>');
  });

  test('handles hex and decimal numeric references', () => {
    assert.equal(decodeEntities('&#x3C;p&#x3E;'), '<p>');
    assert.equal(decodeEntities('&#8230;'), '…');
  });

  /** &amp; is decoded last, so an escaped entity survives as text. */
  test('does not double-decode', () => {
    assert.equal(decodeEntities('&amp;lt;'), '&lt;');
  });

  test('leaves ordinary text and non-strings alone', () => {
    assert.equal(decodeEntities('沒有實體的文字'), '沒有實體的文字');
    assert.equal(decodeEntities(null), null);
    assert.equal(decodeEntities(undefined), undefined);
    assert.equal(decodeEntities(42), 42);
  });
});
