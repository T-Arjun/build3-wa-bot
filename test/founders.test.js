'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const { buildNamePatterns } = require('../src/domain/founders');

// The real production vulnerability this guards: findByName() joins every
// pattern into a single PostgREST `.or()` string. A pattern containing a raw
// comma breaks out of its own `name.ilike.*...*` clause and lets the rest be
// parsed as an INDEPENDENT filter clause on any column. Confirmed live against
// the real database before this fix: a crafted name like
// "xyz,cohort.gt.0" made Postgres itself evaluate `cohort.gt.0` as a real
// filter (error: "invalid input syntax for type integer: \"0*\"" - the
// injected clause was actually executing, not being treated as literal text).

test('a comma in the query is never present in any returned pattern', () => {
  const patterns = buildNamePatterns('xyznonexistent,cohort.gt.0');
  for (const p of patterns) assert.ok(!p.includes(','), `pattern leaked a comma: ${p}`);
  // the dangerous whole-phrase is dropped; the safe token "cohort" survives
  assert.ok(!patterns.includes('xyznonexistent,cohort.gt.0'));
});

test('parentheses and quotes are never present in any returned pattern', () => {
  for (const payload of ['a(b)c', 'name","or","x','a:b*c']) {
    const patterns = buildNamePatterns(payload);
    for (const p of patterns) {
      assert.ok(!/[,()*:"\\]/.test(p), `pattern "${p}" still carries an unsafe char from payload "${payload}"`);
    }
  }
});

test('a query that is entirely unsafe characters returns no patterns (not an empty .or())', () => {
  assert.deepStrictEqual(buildNamePatterns(',,()()'), []);
  assert.deepStrictEqual(buildNamePatterns(''), []);
  assert.deepStrictEqual(buildNamePatterns('   '), []);
});

test('legitimate multi-word names are unaffected - whole phrase plus tokens', () => {
  const patterns = buildNamePatterns('Bhavana Menon');
  assert.ok(patterns.includes('bhavana menon')); // whole phrase
  assert.ok(patterns.includes('bhavana')); // token
  assert.ok(patterns.includes('menon')); // token
});

test('a bare short name still produces a usable pattern', () => {
  assert.deepStrictEqual(buildNamePatterns('Amit'), ['amit']);
});
