'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const { systemPrompt } = require('../src/bot/prompts');

const P = systemPrompt();

// ─── New conversational-engine rules (live reference-product research, July 2026) ───

test('general questions section exists and forbids deflection', () => {
  assert.match(P, /GENERAL QUESTIONS/);
  assert.match(P, /never deflect/i);
  // the person-lookup exception must survive: general knowledge never overrides
  // the deterministic get_profile-first rule (that carve-out caused the
  // Bhavana/Arvind hallucinations when it was phrased the other way around).
  assert.match(P, /PERSON by name still follows the person rules/);
});

test('vendor/model questions get a never-confirm rule', () => {
  assert.match(P, /never confirm or deny ANY vendor or model name/);
});

test('skepticism and insults each have a distinct posture', () => {
  assert.match(P, /SKEPTICISM \(/);
  assert.match(P, /INSULTS aimed at you/);
  assert.match(P, /Never threaten consequences you can't enforce/);
});

test('venting rule holds space and blocks the proactive Sherpa offer', () => {
  assert.match(P, /VENTING \(/);
  assert.match(P, /NO founder search, NO Sherpa offer/);
  // the proactive rule itself must carry the venting carve-out
  assert.match(P, /VENTING about the stress of it rather than asking how to solve it/);
});

test('thin results are framed honestly, never padded', () => {
  assert.match(P, /ONE strong match beats a padded list/);
});

// ─── Protected sections (matching / search / sherpa) must stay intact ───────
// These are tripwires: if a future prompt edit deletes or renames one of these
// load-bearing sections, the conversational engine change has gone out of its
// lane and this test fails before anything deploys.

test('protected: tool-choice and matching sections are still present', () => {
  assert.match(P, /THEM vs WHO THEY WANT/);
  assert.match(P, /CHOOSING search_founders vs find_cofounders/);
  assert.match(P, /SHERPA HOURS \(list_sherpas \/ get_sherpa\)/);
  assert.match(P, /TURNING WHAT THEY SAY INTO A SEARCH/);
  assert.match(P, /PERSONALIZING COFOUNDER MATCHES/);
  assert.match(P, /SOFT MATCHES:/);
});

test('protected: acting-vs-clarifying threshold is unchanged', () => {
  // "Sharpen broad queries before searching" was deliberately NOT adopted: acting
  // on any usable signal is load-bearing for cofounder search UX.
  assert.match(P, /If the message has ANY usable signal \(a skill, sector, city, stage, or name\), act immediately/);
  assert.match(P, /Ask at most ONE clarifying question, and only when there's zero usable signal/);
});
