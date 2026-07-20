'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const { parseMatchResults, lookingForStatus } = require('../src/domain/matching');

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
  const results = parseMatchResults(parsed, CANDIDATES);
  assert.deepStrictEqual(results.map((r) => r.slug), ['alice', 'carol', 'bob']);
  assert.strictEqual(results[0].score, 90);
});

// Real live-confirmed crash: `parsed.matches || []` doesn't guard a truthy
// non-array value. `{matches:{}}` threw `.filter is not a function`, uncaught
// by the surrounding try/catch since it ran outside it.
test('a truthy non-array `matches` (e.g. a single object) never crashes', () => {
  assert.deepStrictEqual(parseMatchResults({ matches: {} }, CANDIDATES), []);
  assert.deepStrictEqual(parseMatchResults({ matches: 'oops' }, CANDIDATES), []);
  assert.deepStrictEqual(parseMatchResults({ matches: null }, CANDIDATES), []);
  assert.deepStrictEqual(parseMatchResults({}, CANDIDATES), []);
  assert.deepStrictEqual(parseMatchResults(null, CANDIDATES), []);
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
  const results = parseMatchResults(parsed, CANDIDATES);
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
  const results = parseMatchResults(parsed, CANDIDATES);
  assert.strictEqual(results.filter((r) => r.slug === 'alice').length, 1);
  // keeps the FIRST occurrence (whichever the model listed first for that index)
  assert.strictEqual(results.find((r) => r.slug === 'alice').score, 95);
});

test('score is clamped to 0-100 even if the model returns something outside range', () => {
  const parsed = { matches: [{ candidateIndex: 0, score: 150 }, { candidateIndex: 1, score: -20 }] };
  const results = parseMatchResults(parsed, CANDIDATES);
  assert.strictEqual(results.find((r) => r.slug === 'alice').score, 100);
  assert.strictEqual(results.find((r) => r.slug === 'bob').score, 0);
});

test('non-array reasons never crash, default to empty', () => {
  const parsed = { matches: [{ candidateIndex: 0, score: 50, reasons: 'not an array' }] };
  const results = parseMatchResults(parsed, CANDIDATES);
  assert.deepStrictEqual(results[0].reasons, []);
});

// ─── lookingForStatus: honest per-candidate cofounder-intent mapping ────────

test('blank/unspecified looking_for gets an honest "hasn\'t said" line, never treated as a no', () => {
  assert.match(lookingForStatus([]), /hasn't said either way/);
  assert.match(lookingForStatus(null), /hasn't said either way/);
  assert.match(lookingForStatus(undefined), /hasn't said either way/);
});

test('each explicit looking_for value maps to its own honest status', () => {
  assert.match(lookingForStatus(['co-founder, I have a startup']), /already running something/);
  assert.match(lookingForStatus(["co-founder, I don't have a startup"]), /looking to join someone as a cofounder/);
  assert.match(lookingForStatus(['join a startup']), /open to joining a startup, not necessarily as a cofounder/);
  assert.match(lookingForStatus(['service providers']), /listed as a service provider/);
});

test('multi-select priority: co-founder-with-startup beats every other value when several are set', () => {
  const status = lookingForStatus(['service providers', 'join a startup', 'co-founder, I have a startup']);
  assert.match(status, /already running something/);
});

test('multi-select priority: co-founder-without-startup beats join-a-startup and service-providers', () => {
  const status = lookingForStatus(['service providers', 'join a startup', "co-founder, I don't have a startup"]);
  assert.match(status, /looking to join someone as a cofounder/);
});

test('parseMatchResults tags each result with its own lookingForStatus from the source candidate', () => {
  const candidates = [
    { source_slug: 'alice', name: 'Alice', looking_for: ['co-founder, I have a startup'] },
    { source_slug: 'bob', name: 'Bob', looking_for: [] },
  ];
  const parsed = { matches: [{ candidateIndex: 0, score: 90 }, { candidateIndex: 1, score: 80 }] };
  const results = parseMatchResults(parsed, candidates);
  assert.match(results.find((r) => r.slug === 'alice').lookingForStatus, /already running something/);
  assert.match(results.find((r) => r.slug === 'bob').lookingForStatus, /hasn't said either way/);
});
