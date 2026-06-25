'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const {
  expandLocation,
  blobLocationTokens,
  closestKnown,
  CITY_STATE,
  STATE_TO_CITIES,
} = require('../src/domain/geo');

test('a state expands to its cities + the state name', () => {
  const r = expandLocation('Kerala');
  assert.strictEqual(r.isState, true);
  assert.ok(r.terms.includes('kerala'));
  assert.ok(r.terms.includes('kochi'));
  assert.ok(r.terms.includes('thiruvananthapuram'));
  assert.ok(r.terms.includes('kozhikode'));
});

test('a city expands only to its spelling variants, not the whole state', () => {
  const r = expandLocation('Bangalore');
  assert.strictEqual(r.isState, false);
  assert.ok(r.terms.includes('bengaluru'));
  assert.ok(r.terms.includes('banglore'));
  assert.ok(!r.terms.includes('mangaluru'));
  assert.ok(!r.terms.includes('shimoga'));
});

test('alternate / old city names map together', () => {
  assert.ok(expandLocation('Cochin').terms.includes('kochi'));
  assert.ok(expandLocation('Trivandrum').terms.includes('thiruvananthapuram'));
  assert.ok(expandLocation('Gurgaon').terms.includes('gurugram'));
  assert.ok(expandLocation('Bombay').terms.includes('mumbai'));
  assert.ok(expandLocation('Calcutta').terms.includes('kolkata'));
  assert.ok(expandLocation('Madras').terms.includes('chennai'));
  assert.ok(expandLocation('Allahabad').terms.includes('prayagraj'));
  assert.ok(expandLocation('Baroda').terms.includes('vadodara'));
});

test('common abbreviations resolve to the city', () => {
  assert.ok(expandLocation('blr').terms.includes('bengaluru'));
  assert.ok(expandLocation('hyd').terms.includes('hyderabad'));
  assert.ok(expandLocation('vizag').terms.includes('visakhapatnam'));
  assert.ok(expandLocation('tvm').terms.includes('thiruvananthapuram'));
  assert.ok(expandLocation('Lko').terms.includes('lucknow'));
  assert.strictEqual(expandLocation('blr').state, 'karnataka');
});

test('abbreviations are never emitted as match terms (no false substring matches)', () => {
  // "bom" would ILIKE-match "Bomdila"; "cal" would match "Calicut"/"Calangute".
  assert.ok(!expandLocation('bombay').terms.includes('bom'));
  assert.ok(!expandLocation('bom').terms.includes('bom'));
  assert.ok(!expandLocation('cal').terms.includes('cal'));
  assert.ok(!expandLocation('blr').terms.includes('blr'));
  assert.deepStrictEqual(expandLocation('bom').terms.sort(), ['bombay', 'mumbai']);
});

test('twin cities Hyderabad and Secunderabad cross-match', () => {
  assert.ok(expandLocation('Hyderabad').terms.includes('secunderabad'));
  assert.ok(expandLocation('Secunderabad').terms.includes('hyderabad'));
});

test('ambiguous / international 2-letter inputs do NOT resolve to an Indian state', () => {
  // "UK" must not become Uttarakhand; English words must not become states.
  assert.strictEqual(expandLocation('UK').state, null);
  assert.deepStrictEqual(expandLocation('UK').terms, ['uk']);
  assert.strictEqual(expandLocation('or').state, null);
  assert.strictEqual(expandLocation('as').state, null);
  assert.strictEqual(expandLocation('ga').state, null);
});

test('state abbreviations and variants resolve', () => {
  assert.strictEqual(expandLocation('TN').state, 'tamil nadu');
  assert.strictEqual(expandLocation('UP').state, 'uttar pradesh');
  assert.strictEqual(expandLocation('KA').state, 'karnataka');
  assert.strictEqual(expandLocation('MH').state, 'maharashtra');
  assert.strictEqual(expandLocation('TS').state, 'telangana');
  assert.strictEqual(expandLocation('Orissa').state, 'odisha');
});

test('every state has cities and resolves from its full name', () => {
  const states = new Set(Object.values(CITY_STATE));
  assert.ok(states.size >= 30, `expected all states/UTs, got ${states.size}`);
  for (const st of states) {
    const r = expandLocation(st);
    assert.strictEqual(r.isState, true, `${st} should resolve as a state`);
    assert.ok(r.terms.includes(st), `${st} should match its own name`);
    assert.ok((STATE_TO_CITIES[st] || []).length > 0);
  }
});

test('NCR is a region spanning Delhi + Gurgaon + Noida (not just Delhi)', () => {
  for (const q of ['NCR', 'Delhi NCR', 'National Capital Region']) {
    const r = expandLocation(q);
    assert.strictEqual(r.isRegion, true, `${q} should be a region`);
    assert.ok(r.terms.includes('gurgaon'), `${q} must include Gurgaon`);
    assert.ok(r.terms.includes('gurugram'));
    assert.ok(r.terms.includes('noida'), `${q} must include Noida`);
    assert.ok(r.terms.includes('delhi'));
    assert.ok(r.terms.includes('faridabad'));
  }
});

test('zones expand across member states', () => {
  const south = expandLocation('South India');
  assert.strictEqual(south.isRegion, true);
  assert.ok(south.terms.includes('bengaluru'));
  assert.ok(south.terms.includes('chennai'));
  assert.ok(south.terms.includes('kochi'));
  assert.ok(south.terms.includes('hyderabad'));
  const ne = expandLocation('north east');
  assert.ok(ne.terms.includes('guwahati'));
  assert.ok(ne.terms.includes('shillong'));
});

test('fuzzy correction recovers common misspellings', () => {
  assert.ok(expandLocation('Hydrabad').terms.includes('hyderabad'));
  assert.ok(expandLocation('Mumabi').terms.includes('mumbai'), 'transposition should resolve');
  assert.ok(expandLocation('Chenai').terms.includes('chennai'));
  assert.ok(expandLocation('Kolkatta').terms.includes('kolkata'));
});

test('fuzzy is conservative: ambiguous / nonsense input is not force-matched', () => {
  assert.strictEqual(closestKnown('xyz'), null); // too short
  assert.strictEqual(closestKnown('zzzzzz'), null); // nothing close
  // "Bangaluru" is one edit from BOTH bengaluru and mangaluru — refuse to guess.
  assert.deepStrictEqual(expandLocation('Bangaluru').terms, ['bangaluru']);
  // A non-Indian city stays literal (no Indian state inferred).
  const sf = expandLocation('San Francisco');
  assert.strictEqual(sf.state, null);
  assert.deepStrictEqual(sf.terms, ['san francisco']);
});

test('unknown / international location falls back to itself', () => {
  assert.deepStrictEqual(expandLocation('Atlantis').terms, ['atlantis']);
  assert.deepStrictEqual(expandLocation('Dubai').terms, ['dubai']);
  assert.strictEqual(expandLocation('Seattle').state, null);
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
  assert.deepStrictEqual(expandLocation('').terms, []);
  assert.deepStrictEqual(blobLocationTokens(null), []);
});
