'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const { buildNamePatterns, scoreThemeUnion } = require('../src/domain/founders');

// ─── scoreThemeUnion: multi-sector "my space" union (real observed failure,
// 919910811300 - "education and investing, and real estate development" fired
// two separate searches / two silo lists instead of one union) ──────────────

test('scoreThemeUnion: a founder spanning 2+ themes triggers overlap and leads the merged list', () => {
  const themes = [
    { label: 'education', sector: 'Education & Skilling' },
    { label: 'real estate development', sector: 'Built Environment' },
    { label: 'investing', query: 'invest' },
  ];
  const pool = [
    { source_slug: 'ankur', name: 'Ankur', sector: 'Built Environment', startup_idea: 'A real estate investment platform' },
    { source_slug: 'nikita', name: 'Nikita', sector: 'Education & Skilling', startup_idea: 'startup education' },
    { source_slug: 'shuvam', name: 'Shuvam', sector: 'Built Environment', startup_idea: 'construction listings' },
  ];
  const result = scoreThemeUnion(pool, themes, 10);
  assert.strictEqual(result.overlap, true);
  assert.strictEqual(result.results[0].source_slug, 'ankur'); // hits 2 themes (real estate + investing), leads
  assert.strictEqual(result.count, 3);
  assert.strictEqual(result.results.length, 3);
});

test('scoreThemeUnion: no cross-cutting founder means no overlap - caller must show separate lists', () => {
  const themes = [
    { label: 'climate', sector: 'Climate & Sustainability' },
    { label: 'gaming', query: 'gaming' },
  ];
  const pool = [
    { source_slug: 'a', sector: 'Climate & Sustainability', startup_idea: 'carbon capture' },
    { source_slug: 'b', sector: 'Climate & Sustainability', startup_idea: 'solar panels' },
    { source_slug: 'c', sector: 'Other', startup_idea: 'mobile gaming studio' },
  ];
  const result = scoreThemeUnion(pool, themes, 10);
  assert.strictEqual(result.overlap, false);
  assert.strictEqual(result.groups.length, 2);
  assert.strictEqual(result.groups[0].results.length, 2); // climate
  assert.strictEqual(result.groups[1].results.length, 1); // gaming
});

test('scoreThemeUnion: single-theme remainder round-robins so a named theme never gets buried', () => {
  const themes = [
    { label: 'education', sector: 'Education & Skilling' },
    { label: 'real estate', sector: 'Built Environment' },
  ];
  // One cross-cutting founder, then 9 education-only vs 2 real-estate-only.
  const pool = [
    { source_slug: 'cross', sector: 'Education & Skilling', startup_idea: 'edtech for real estate agents' },
    ...Array.from({ length: 9 }, (_, i) => ({ source_slug: `edu${i}`, sector: 'Education & Skilling' })),
    { source_slug: 're0', sector: 'Other', startup_idea: 'a real estate listings site' },
    { source_slug: 're1', sector: 'Other', startup_idea: 'real estate brokerage software' },
  ];
  const themes2 = [
    { label: 'education', sector: 'Education & Skilling' },
    { label: 'real estate', query: 'real estate' },
  ];
  const result = scoreThemeUnion(pool, themes2, 10);
  assert.strictEqual(result.overlap, true);
  const slugs = result.results.map((f) => f.source_slug);
  assert.ok(slugs.includes('re0') && slugs.includes('re1'), 'both real-estate-only founders must survive round-robin, not get buried by 9 education-only founders');
});

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
