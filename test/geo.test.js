'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const {
  blobLocationTokens,
  closestKnown,
  locationFilter,
  stateForCity,
  editDistance,
} = require('../src/domain/geo');

test('fuzzy is conservative: ambiguous / nonsense input is not force-matched', () => {
  assert.strictEqual(closestKnown('xyz'), null); // too short
  assert.strictEqual(closestKnown('zzzzzz'), null); // nothing close
});

test('blob tokens fold state + aliases into messy city strings (whole-word)', () => {
  const t = blobLocationTokens('Kochi / Kerala');
  assert.ok(t.includes('kerala'));
  assert.ok(t.includes('cochin'));
  // whole-word: "goa" must not match inside "goalpara"
  const g = blobLocationTokens('Goalpara');
  assert.ok(!g.includes('goa'));
  assert.ok(g.includes('assam'));
});

test('empty location is safe', () => {
  assert.deepStrictEqual(locationFilter('').terms, []);
  assert.deepStrictEqual(blobLocationTokens(null), []);
});

// ─── state-column-aware locationFilter (uses the native `state` field) ──────────

test('a state (name or code) filters on the state column', () => {
  for (const q of ['Kerala', 'kerala', 'KL']) {
    const r = locationFilter(q);
    assert.strictEqual(r.kind, 'state');
    assert.deepStrictEqual(r.states, ['Kerala']);
  }
  assert.deepStrictEqual(locationFilter('MH').states, ['Maharashtra']);
  assert.deepStrictEqual(locationFilter('Tamil Nadu').states, ['Tamil Nadu']);
});

test('a zone maps to its member states', () => {
  const r = locationFilter('South India');
  assert.strictEqual(r.kind, 'state');
  assert.ok(r.states.includes('Karnataka') && r.states.includes('Kerala') && r.states.includes('Tamil Nadu'));
});

test('a specific city filters on the city column with its variants', () => {
  const r = locationFilter('Bangalore');
  assert.strictEqual(r.kind, 'city');
  assert.ok(r.terms.includes('bengaluru') && r.terms.includes('bangalore'));
  assert.ok(!r.terms.includes('mysuru')); // a city query stays that city, not its state
  assert.deepStrictEqual(locationFilter('blr').kind, 'city');
});

test('NCR is a cross-state city cluster, not a state', () => {
  const r = locationFilter('NCR');
  assert.strictEqual(r.kind, 'city');
  assert.ok(r.terms.includes('gurugram') && r.terms.includes('noida') && r.terms.includes('delhi'));
});

test('twin cities Hyderabad and Secunderabad cross-match', () => {
  assert.ok(locationFilter('Hyderabad').terms.includes('secunderabad'));
  assert.ok(locationFilter('Secunderabad').terms.includes('hyderabad'));
});

test('abbreviations are never emitted as match terms (no false substring matches)', () => {
  // "bom" would ILIKE-match "Bomdila"; the alias must be resolved away, not kept.
  assert.ok(!locationFilter('bom').terms.includes('bom'));
  assert.deepStrictEqual(locationFilter('bom').terms.sort(), ['bombay', 'mumbai']);
  assert.ok(!locationFilter('blr').terms.includes('blr'));
});

test('fuzzy correction recovers common misspellings into a real city/state filter', () => {
  assert.ok(locationFilter('Hydrabad').terms.includes('hyderabad'));
  assert.ok(locationFilter('Mumabi').terms.includes('mumbai'), 'transposition should resolve');
  assert.ok(locationFilter('Chenai').terms.includes('chennai'));
});

test('unknown / foreign short names stay literal (no fuzzy mis-correction)', () => {
  const male = locationFilter('male'); // Maldives capital must NOT become Mahe
  assert.strictEqual(male.kind, 'literal');
  assert.deepStrictEqual(male.terms, ['male']);
  assert.strictEqual(locationFilter('Dubai').kind, 'literal');
});

test('fuzzy is conservative even in locationFilter: ambiguous input is not force-matched', () => {
  // "Bangaluru" is one edit from BOTH bengaluru and mangaluru - refuse to guess.
  assert.deepStrictEqual(locationFilter('Bangaluru').terms, ['bangaluru']);
});

test('stateForCity backfills a founder city to its state (Title Case)', () => {
  assert.strictEqual(stateForCity('Kochi'), 'Kerala');
  assert.strictEqual(stateForCity('Bengaluru'), 'Karnataka');
  assert.strictEqual(stateForCity('blr'), 'Karnataka');
  assert.strictEqual(stateForCity('Chennai'), 'Tamil Nadu');
  assert.strictEqual(stateForCity('Dubai'), null); // foreign: keep whatever the API gave
  assert.strictEqual(stateForCity(''), null);
});

test('editDistance is tight enough for typo-tolerant name lookup', () => {
  assert.ok(editDistance('umaier', 'umair') <= 2); // the real "umaier" -> "Umair" flop
  assert.ok(editDistance('bavana', 'bhavana') <= 2);
  assert.ok(editDistance('varn', 'varun') <= 2);
  assert.ok(editDistance('xyzqwe', 'umair') > 2); // unrelated stays unmatched
});
