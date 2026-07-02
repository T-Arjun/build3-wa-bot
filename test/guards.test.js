'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const { untrackedNote } = require('../src/bot/guards');

test('gender filter intent triggers the honest disclaimer', () => {
  for (const q of ['show me women founders in fintech', 'female founders in Bangalore', 'founders who are women', 'only women in healthtech']) {
    assert.match(untrackedNote(q) || '', /gender/i, `expected gender note for: ${q}`);
  }
});

test('topical mentions of women do NOT misfire the gender note', () => {
  assert.strictEqual(untrackedNote("founders building women's health products"), null);
  assert.strictEqual(untrackedNote('anyone working on femtech'), null);
  assert.strictEqual(untrackedNote('find founders in Bangalore'), null);
});

test('funding and hiring filters trigger their disclaimers', () => {
  assert.match(untrackedNote('well funded founders in fintech') || '', /funding|revenue/i);
  assert.match(untrackedNote('founders who raised a seed round') || '', /funding|revenue/i);
  assert.match(untrackedNote('which founders are hiring') || '', /hiring/i);
});

test('normal queries return no note', () => {
  for (const q of ['find founders in kerala', 'i need a technical cofounder', 'book a mentor for pricing', 'hey']) {
    assert.strictEqual(untrackedNote(q), null);
  }
});
