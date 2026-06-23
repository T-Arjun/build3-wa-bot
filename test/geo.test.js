'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const { expandLocation, blobLocationTokens } = require('../src/domain/geo');

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
  // Must NOT pull in other Karnataka cities.
  assert.ok(!r.terms.includes('mangaluru'));
  assert.ok(!r.terms.includes('shimoga'));
});

test('alt city names map together', () => {
  assert.ok(expandLocation('Cochin').terms.includes('kochi'));
  assert.ok(expandLocation('Trivandrum').terms.includes('thiruvananthapuram'));
  assert.ok(expandLocation('Gurgaon').terms.includes('gurugram'));
});

test('state aliases resolve', () => {
  assert.strictEqual(expandLocation('TN').state, 'tamil nadu');
  assert.strictEqual(expandLocation('UP').state, 'uttar pradesh');
});

test('unknown location falls back to itself', () => {
  const r = expandLocation('Atlantis');
  assert.deepStrictEqual(r.terms, ['atlantis']);
});

test('blob tokens fold state + aliases into messy city strings', () => {
  const t = blobLocationTokens('Kochi / Kerala');
  assert.ok(t.includes('kerala'));
  assert.ok(t.includes('cochin'));
});

test('empty location is safe', () => {
  assert.deepStrictEqual(expandLocation('').terms, []);
  assert.deepStrictEqual(blobLocationTokens(null), []);
});
