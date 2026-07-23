'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { wantsCofounder, isHedgedSelfClaim, cityIsSelf } = require('../src/bot/intent');

test('wantsCofounder detects cofounder asks, not plain founder search', () => {
  assert.equal(wantsCofounder('find me a cofounder in sales'), true);
  assert.equal(wantsCofounder('match me with someone technical'), true);
  assert.equal(wantsCofounder('co-founder needed'), true);
  assert.equal(wantsCofounder('find founders who do sales'), false);
  assert.equal(wantsCofounder('who is building in fintech'), false);
});

test('isHedgedSelfClaim flags vague self-skill statements only', () => {
  assert.equal(isHedgedSelfClaim('and a little bit tech'), true);
  assert.equal(isHedgedSelfClaim('somewhat technical'), true);
  assert.equal(isHedgedSelfClaim('mixed, some tech'), true);
  assert.equal(isHedgedSelfClaim('i am technical, been coding for years'), false);
  assert.equal(isHedgedSelfClaim('sales and growth'), false);
});

// ── The corruption direction: a WANTED city must NEVER be saved as self ──────
test('cityIsSelf: a city on the WANTED cofounder is not the user (all prepositions)', () => {
  assert.equal(cityIsSelf('find me a cofounder in sales from delhi', 'Delhi'), false);
  assert.equal(cityIsSelf('find me a tech cofounder in bangalore', 'Bangalore'), false);
  assert.equal(cityIsSelf('cofounder based in mumbai', 'Mumbai'), false);
  assert.equal(cityIsSelf('need someone from pune', 'Pune'), false);
  assert.equal(cityIsSelf('match me with an engineer near hyderabad', 'Hyderabad'), false);
  // codex #2: an intervening word must not flip a wanted requirement to self
  assert.equal(cityIsSelf('cofounder should be based in delhi', 'Delhi'), false);
  assert.equal(cityIsSelf('need a CTO preferably based in delhi', 'Delhi'), false);
});

test('cityIsSelf: a genuine first-person location is the user', () => {
  assert.equal(cityIsSelf("i'm based in mumbai, need a technical cofounder", 'Mumbai'), true);
  assert.equal(cityIsSelf('i am from jaipur', 'Jaipur'), true);
  assert.equal(cityIsSelf('i live in chennai and run a d2c brand', 'Chennai'), true);
  assert.equal(cityIsSelf('my city is kochi', 'Kochi'), true);
  // codex #1 / #7: self-intros with a role noun
  assert.equal(cityIsSelf("i'm a founder from goa, show me fintech founders", 'Goa'), true);
});

test('cityIsSelf: BOTH a self-city and a wanted-city in one message', () => {
  const text = "i'm in mumbai, find me a cofounder in delhi";
  assert.equal(cityIsSelf(text, 'Mumbai'), true);
  assert.equal(cityIsSelf(text, 'Delhi'), false);
});

test('cityIsSelf: Hinglish self-location (codex #3)', () => {
  const text = 'main mumbai me hu, delhi me cofounder chahiye';
  assert.equal(cityIsSelf(text, 'Mumbai'), true);
  assert.equal(cityIsSelf(text, 'Delhi'), false);
});

test('cityIsSelf: substring collision - "goa" inside "goal" is not matched (codex #5)', () => {
  // real Goa mention is self; the word "goal" must not be analyzed as the city
  assert.equal(cityIsSelf('my goal is matching; i am based in goa, need a cofounder', 'Goa'), true);
});

test('cityIsSelf: unsure defaults to NOT-self (conservative - never corrupt the profile)', () => {
  // a bare city with no first-person signal in a request context -> don't save
  assert.equal(cityIsSelf('find me a cofounder in sales from delhi', 'Delhi'), false);
  // normalized city we cannot locate, inside a request -> conservative, not saved
  assert.equal(cityIsSelf('find me a cofounder in bombay', 'Mumbai'), false);
});
