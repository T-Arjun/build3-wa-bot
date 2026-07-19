'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const { untrackedNote, scrubUnverifiedUrls, extractUrls } = require('../src/bot/guards');

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

// ─── unverified URL scrub ─────────────────────────────────────────────────
// Real live-reproduced failure: after a turn ending on a pending
// disambiguation, asking about a new person sometimes made the model skip
// get_profile and invent a plausible LinkedIn URL from scratch (two separate
// runs of the identical request produced two DIFFERENT fabricated URLs).

test('a URL that never appeared in tool results gets replaced', () => {
  const reply = "here's his LinkedIn: https://www.linkedin.com/in/totally-made-up-123/";
  const verified = ['https://ch.linkedin.com/in/abhijeetip']; // a DIFFERENT, real one
  const out = scrubUnverifiedUrls(reply, verified);
  assert.notStrictEqual(out, reply);
  assert.ok(!out.includes('totally-made-up'));
});

test('a URL that DID appear in tool results this turn passes through untouched', () => {
  const reply = "here's his LinkedIn: https://ch.linkedin.com/in/abhijeetip";
  const verified = ['https://ch.linkedin.com/in/abhijeetip'];
  assert.strictEqual(scrubUnverifiedUrls(reply, verified), reply);
});

test('trailing sentence punctuation right after a URL does not cause a false flag', () => {
  const reply = 'reach out here: https://ch.linkedin.com/in/abhijeetip.';
  const verified = ['https://ch.linkedin.com/in/abhijeetip'];
  assert.strictEqual(scrubUnverifiedUrls(reply, verified), reply);
});

test('a reply with no URL at all is never touched', () => {
  const reply = 'abhijeet runs Skillencio out of Hyderabad.';
  assert.strictEqual(scrubUnverifiedUrls(reply, []), reply);
});

test('extractUrls pulls URLs out of tool-result-shaped JSON', () => {
  const json = JSON.stringify({ status: 'shown', facts: { linkedin_url: 'https://ch.linkedin.com/in/abhijeetip' } });
  assert.deepStrictEqual(extractUrls(json), ['https://ch.linkedin.com/in/abhijeetip']);
});
