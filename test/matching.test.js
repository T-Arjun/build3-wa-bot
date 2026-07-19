'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const { parseMatchResults } = require('../src/domain/matching');

const CANDIDATES = [
  { source_slug: 'alice', name: 'Alice', sector: 'Fintech', city: 'Pune' },
  { source_slug: 'bob', name: 'Bob', sector: 'Healthtech', city: 'Mumbai' },
  { source_slug: 'carol', name: 'Carol', sector: 'Edtech', city: 'Delhi' },
];

test('normal shape: all candidates mapped and sorted by score descending', () => {
  const parsed = {
    matches: [
      { candidateIndex: 1, score: 60, reasons: ['a', 'b'] },
      { candidateIndex: 0, score: 90, reasons: ['c', 'd'] },
      { candidateIndex: 2, score: 75, reasons: ['e', 'f'] },
    ],
  };
  const results = parseMatchResults(parsed, CANDIDATES, false);
  assert.deepStrictEqual(results.map((r) => r.slug), ['alice', 'carol', 'bob']);
  assert.strictEqual(results[0].score, 90);
});

// Real live-confirmed crash: `parsed.matches || []` doesn't guard a truthy
// non-array value. `{matches:{}}` threw `.filter is not a function`, uncaught
// by the surrounding try/catch since it ran outside it.
test('a truthy non-array `matches` (e.g. a single object) never crashes', () => {
  assert.deepStrictEqual(parseMatchResults({ matches: {} }, CANDIDATES, false), []);
  assert.deepStrictEqual(parseMatchResults({ matches: 'oops' }, CANDIDATES, false), []);
  assert.deepStrictEqual(parseMatchResults({ matches: null }, CANDIDATES, false), []);
  assert.deepStrictEqual(parseMatchResults({}, CANDIDATES, false), []);
  assert.deepStrictEqual(parseMatchResults(null, CANDIDATES, false), []);
});

test('out-of-range or non-integer candidateIndex entries are dropped, not crashed on', () => {
  const parsed = {
    matches: [
      { candidateIndex: 99, score: 80, reasons: [] }, // out of bounds
      { candidateIndex: -1, score: 80, reasons: [] }, // negative
      { candidateIndex: 1.5, score: 80, reasons: [] }, // non-integer
      { candidateIndex: 0, score: 80, reasons: [] }, // valid
    ],
  };
  const results = parseMatchResults(parsed, CANDIDATES, false);
  assert.deepStrictEqual(results.map((r) => r.slug), ['alice']);
});

// Defensive addition: never observed live at full 40-candidate scale, but the
// prompt's "include ALL candidates" doesn't explicitly forbid the model
// repeating an index - a repeat would show the same founder as two cards.
test('a repeated candidateIndex from the model is deduped, not shown twice', () => {
  const parsed = {
    matches: [
      { candidateIndex: 0, score: 95, reasons: ['first, higher score'] },
      { candidateIndex: 0, score: 40, reasons: ['duplicate, lower score'] },
      { candidateIndex: 1, score: 70, reasons: [] },
    ],
  };
  const results = parseMatchResults(parsed, CANDIDATES, false);
  assert.strictEqual(results.filter((r) => r.slug === 'alice').length, 1);
  // keeps the FIRST occurrence (whichever the model listed first for that index)
  assert.strictEqual(results.find((r) => r.slug === 'alice').score, 95);
});

test('score is clamped to 0-100 even if the model returns something outside range', () => {
  const parsed = { matches: [{ candidateIndex: 0, score: 150 }, { candidateIndex: 1, score: -20 }] };
  const results = parseMatchResults(parsed, CANDIDATES, false);
  assert.strictEqual(results.find((r) => r.slug === 'alice').score, 100);
  assert.strictEqual(results.find((r) => r.slug === 'bob').score, 0);
});

test('non-array reasons never crash, default to empty', () => {
  const parsed = { matches: [{ candidateIndex: 0, score: 50, reasons: 'not an array' }] };
  const results = parseMatchResults(parsed, CANDIDATES, false);
  assert.deepStrictEqual(results[0].reasons, []);
});

test('_soft is tagged onto every result as passed in', () => {
  const parsed = { matches: [{ candidateIndex: 0, score: 50 }] };
  assert.strictEqual(parseMatchResults(parsed, CANDIDATES, true)[0]._soft, true);
  assert.strictEqual(parseMatchResults(parsed, CANDIDATES, false)[0]._soft, false);
});
