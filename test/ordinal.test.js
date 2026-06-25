'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const { parseOrdinal, resolveTypedSelection } = require('../src/bot/ordinal');

test('parseOrdinal: bare numbers within range', () => {
  assert.strictEqual(parseOrdinal('2', 10), 1);
  assert.strictEqual(parseOrdinal('1', 10), 0);
  assert.strictEqual(parseOrdinal('#3', 10), 2);
  assert.strictEqual(parseOrdinal('2nd', 10), 1);
});

test('parseOrdinal: verb phrases', () => {
  assert.strictEqual(parseOrdinal('show 2', 10), 1);
  assert.strictEqual(parseOrdinal('show me 2', 10), 1);
  assert.strictEqual(parseOrdinal('open the 3rd', 10), 2);
  assert.strictEqual(parseOrdinal('number 4', 10), 3);
  assert.strictEqual(parseOrdinal('tell me about the first one', 10), 0);
  assert.strictEqual(parseOrdinal('tell me about the second', 10), 1);
});

test('parseOrdinal: word ordinals', () => {
  assert.strictEqual(parseOrdinal('first', 10), 0);
  assert.strictEqual(parseOrdinal('the first one', 10), 0);
  assert.strictEqual(parseOrdinal('second one', 10), 1);
  assert.strictEqual(parseOrdinal('THIRD', 10), 2);
});

test('parseOrdinal: out of range and no-list return null', () => {
  assert.strictEqual(parseOrdinal('2', 1), null);
  assert.strictEqual(parseOrdinal('11', 10), null);
  assert.strictEqual(parseOrdinal('first', 0), null);
  assert.strictEqual(parseOrdinal('2', 0), null);
});

test('parseOrdinal: does NOT match embedded numbers or real queries', () => {
  assert.strictEqual(parseOrdinal('find 3 founders', 10), null);
  assert.strictEqual(parseOrdinal('show me AI founders', 10), null);
  assert.strictEqual(parseOrdinal('first round funding', 10), null);
  assert.strictEqual(parseOrdinal('2 cofounders please', 10), null);
  assert.strictEqual(parseOrdinal('', 10), null);
  assert.strictEqual(parseOrdinal('hi', 10), null);
});

test('resolveTypedSelection: resolves the correct slug and commits on send success', async () => {
  let askedSlug = null;
  const r = await resolveTypedSelection({
    text: '2',
    lastResults: ['alice', 'bob', 'carol'],
    getBySlug: async (slug) => {
      askedSlug = slug;
      return { source_slug: slug, name: 'Bob' };
    },
    sendCard: async () => true,
  });
  assert.strictEqual(askedSlug, 'bob');
  assert.strictEqual(r.handled, true);
  assert.strictEqual(r.founder.name, 'Bob');
  assert.ok(!r.sendFailed);
});

test('resolveTypedSelection: send failure is handled but returns NO founder (no focus commit)', async () => {
  const r = await resolveTypedSelection({
    text: 'show 1',
    lastResults: ['alice'],
    getBySlug: async (slug) => ({ source_slug: slug, name: 'Alice' }),
    sendCard: async () => false,
  });
  assert.strictEqual(r.handled, true);
  assert.strictEqual(r.sendFailed, true);
  assert.strictEqual(r.founder, undefined);
});

test('resolveTypedSelection: non-ordinal text is not handled (falls through to LLM)', async () => {
  const r = await resolveTypedSelection({
    text: 'find AI founders',
    lastResults: ['alice', 'bob'],
    getBySlug: async () => assert.fail('getBySlug must not be called'),
    sendCard: async () => assert.fail('sendCard must not be called'),
  });
  assert.strictEqual(r.handled, false);
});

test('resolveTypedSelection: stale slug (getBySlug null) falls through to LLM', async () => {
  const r = await resolveTypedSelection({
    text: '2',
    lastResults: ['alice', 'gone'],
    getBySlug: async () => null,
    sendCard: async () => assert.fail('sendCard must not be called on a missing founder'),
  });
  assert.strictEqual(r.handled, false);
});
