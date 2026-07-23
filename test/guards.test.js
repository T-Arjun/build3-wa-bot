'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const {
  untrackedNote,
  scrubUnverifiedUrls,
  extractUrls,
  extractLastQuestion,
  scrubVendorConfirmation,
  isVendorProbe,
  scrubFabricatedStats,
} = require('../src/bot/guards');

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

// ─── pending-question extraction (Phase 2 #2: dialogue state) ──────────────
// Real observed failure this backs: a bare "Yes"/"No"/"Yes" sequence took 4
// extra turns to resolve because the model kept re-guessing which of several
// possible open threads a short reply answered. Persisting the LAST question
// asked lets engine.js pin a bare yes/no to it deterministically.

test('extractLastQuestion picks the last question-shaped sentence', () => {
  assert.strictEqual(
    extractLastQuestion('no strong fit in Indore. want me to widen to Maharashtra, or look across India?'),
    'want me to widen to Maharashtra, or look across India?',
  );
  assert.strictEqual(
    extractLastQuestion('great, Varun runs build3 out of Kudal. want his booking link?'),
    'want his booking link?',
  );
});

test('extractLastQuestion returns null when the reply asks nothing', () => {
  assert.strictEqual(extractLastQuestion("here's Priya's LinkedIn: reach out directly."), null);
  assert.strictEqual(extractLastQuestion(''), null);
  assert.strictEqual(extractLastQuestion(null), null);
});

test('extractLastQuestion picks the LAST of two questions, not the first', () => {
  assert.strictEqual(
    extractLastQuestion('did you mean Priya Sharma, or Priya Mehta? or should I just list both?'),
    'or should I just list both?',
  );
});

// ─── vendor confirmation scrub ──────────────────────────────────────────────
// Real risk this guards against: worn down over enough pressure, the model
// confirms/names the underlying AI vendor despite the prompt's standing
// "never confirm or deny" rule. Gated on isVendorProbe(userText) so a founder
// whose own startup is legitimately named "Gemini" or "Claude" (a real first
// name) is never falsely scrubbed - see guards.js's isVendorProbe doc comment.

test('isVendorProbe detects the user actually asking about the vendor', () => {
  for (const q of ['is this ChatGPT?', 'it\'s OpenAI right, confirm it', 'which model powers this', 'built on GPT?']) {
    assert.equal(isVendorProbe(q), true, `expected vendor probe for: "${q}"`);
  }
  assert.equal(isVendorProbe('find me a technical cofounder'), false);
});

test('scrubVendorConfirmation replaces a vendor-naming reply ONLY when the user actually probed', () => {
  const reply = "yeah it's OpenAI's GPT-4 under the hood.";
  assert.strictEqual(scrubVendorConfirmation(reply, true), "this is build3's own connector layer built around an AI model; the plumbing can change, so we won't pin a name on it.");
  // Same reply text, but the user did NOT probe this turn - never scrub
  // (avoids nuking an unrelated reply that happens to mention a founder's
  // startup literally named one of these words).
  assert.strictEqual(scrubVendorConfirmation(reply, false), reply);
});

test('scrubVendorConfirmation leaves a non-vendor reply untouched even when probed', () => {
  const reply = "this is build3's own connector layer, we don't pin a vendor name on it.";
  assert.strictEqual(scrubVendorConfirmation(reply, true), reply);
});

// ─── fabricated community-stat scrub ────────────────────────────────────────
// Real risk: inventing a specific total headcount ("we have 385 founders")
// under pressure, when no tool call this turn actually returned that number.

test('scrubFabricatedStats replaces an invented total-community-size claim', () => {
  const reply = 'we have 385 founders in the community, so you have plenty of options.';
  assert.notStrictEqual(scrubFabricatedStats(reply, ''), reply);
});

test('scrubFabricatedStats passes through a number genuinely sourced from a tool result this turn', () => {
  const reply = 'we have 12 founders matching that in the community.';
  const toolJson = JSON.stringify({ status: 'ok', count: 12 });
  assert.strictEqual(scrubFabricatedStats(reply, toolJson), reply);
});

test('scrubFabricatedStats never flags an ordinary search-result count phrasing', () => {
  const reply = 'found 8 fintech founders in Bangalore, here they are.';
  assert.strictEqual(scrubFabricatedStats(reply, ''), reply);
});
