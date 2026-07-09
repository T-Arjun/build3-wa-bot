'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { findMentions, buildMentionNote } = require('../src/bot/mentions');
const { selfHarmResponse } = require('../src/bot/guards');

// The real production failure this module exists to prevent: user wrote
// "ayushmaan" right after booking Sherpa Ayushmaan Kapoor, and the model
// answered about "Ayush Gupta", an unrelated founder from an earlier list.
const AYUSHMAAN = { name: 'Ayushmaan Kapoor', slug: 'ayushmaan-kapoor', type: 'sherpa', bookingUrl: 'https://cal.example/ak' };
const AYUSH = { name: 'Ayush Gupta', slug: 'ayush-gupta', type: 'founder' };
const PRANAV = { name: 'Pranav Khanna', slug: 'pranav-khanna', type: 'founder', linkedinUrl: 'https://linkedin.com/in/khannapranav' };

test('the live failure: "ayushmaan" resolves to Ayushmaan Kapoor, never Ayush Gupta', () => {
  const hits = findMentions(
    'thanks put in touch with ayushmaan and tell me what you feel about death',
    [AYUSH, AYUSHMAAN, PRANAV],
  );
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].slug, 'ayushmaan-kapoor');
});

test('"ayush" alone resolves to Ayush Gupta, not the Sherpa', () => {
  const hits = findMentions('show me ayush', [AYUSH, AYUSHMAAN]);
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].slug, 'ayush-gupta');
});

test('full name matches, and surname alone also matches when uncommon', () => {
  assert.strictEqual(findMentions('pranav khanna contact?', [PRANAV, AYUSH]).length, 1);
  assert.strictEqual(findMentions('whats khanna up to', [PRANAV])[0].slug, 'pranav-khanna');
});

test('a lone very-common surname is NOT a mention', () => {
  assert.strictEqual(findMentions('gupta ka profile dikhao', [AYUSH]).length, 0);
});

test('full-name-elsewhere veto: "amit malakar" must not pin a cached Amit Sharma', () => {
  const SHARMA = { name: 'Amit Sharma', slug: 'amit-sharma', type: 'founder' };
  assert.strictEqual(findMentions('show me amit malakar', [SHARMA]).length, 0);
  // but a bare "amit" (no conflicting surname) still matches
  assert.strictEqual(findMentions('put me in touch with amit', [SHARMA]).length, 1);
});

test('dual founder+sherpa name returns both, sherpa first', () => {
  const V_F = { name: 'Varun Chawla', slug: 'varun-chawla-f', type: 'founder' };
  const V_S = { name: 'Varun Chawla', slug: 'varun-chawla', type: 'sherpa', bookingUrl: 'x' };
  const hits = findMentions('book varun chawla', [V_F, V_S]);
  assert.strictEqual(hits.length, 2);
  assert.strictEqual(hits[0].type, 'sherpa');
});

test('no names -> no note; note text carries the right channel per type', () => {
  assert.strictEqual(buildMentionNote('find me fintech founders in pune', [AYUSHMAAN, PRANAV]), null);
  const note = buildMentionNote('put me in touch with ayushmaan and pranav', [AYUSHMAAN, PRANAV]);
  assert.match(note, /Sherpa Ayushmaan Kapoor/);
  assert.match(note, /booking link/i);
  assert.match(note, /https:\/\/cal\.example\/ak/);
  assert.match(note, /Pranav Khanna/);
  assert.match(note, /linkedin\.com\/in\/khannapranav/);
});

test('slug-only candidates (last_results) match via slug tokens', () => {
  const bare = { name: 'prem ashra', slug: 'prem-ashra', type: 'founder' };
  assert.strictEqual(findMentions('what about prem?', [bare]).length, 1);
});

// ─── self-harm guard: narrow by design ───────────────────────────────────────

test('explicit self-harm phrases trigger the fixed humane response', () => {
  for (const t of [
    'i want to kill myself',
    'im thinking about suicide',
    'i keep hurting myself',
    'sometimes i just want to die',
  ]) {
    const r = selfHarmResponse(t);
    assert.ok(r, `expected trigger for: ${t}`);
    assert.match(r, /14416/); // Tele-MANAS number present
  }
});

test('death talk, startup metaphors, and third-person mentions do NOT trigger', () => {
  for (const t of [
    'tell me what you feel about death',
    'death',
    'we went through a near death funding phase',
    'this deadline is killing me',
    'my startup died last year',
  ]) {
    assert.strictEqual(selfHarmResponse(t), null, `false positive for: ${t}`);
  }
});
