'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const {
  areasWithCounts,
  filterByArea,
  matchByExpertise,
} = require('../src/domain/sherpas');
const { SHERPAS } = require('../src/domain/sherpas.data');
const { AREA_KEYS } = require('../src/domain/sherpaAreas');
const fmt = require('../src/bot/format');

test('every taxonomy area has at least one active sherpa', () => {
  const areas = areasWithCounts(SHERPAS);
  const keysWithMentors = areas.map((a) => a.key);
  for (const key of AREA_KEYS) {
    assert.ok(keysWithMentors.includes(key), `area "${key}" has no sherpa`);
  }
});

test('areasWithCounts returns labels and positive counts in taxonomy order', () => {
  const areas = areasWithCounts(SHERPAS);
  assert.ok(areas.length > 0);
  for (const a of areas) {
    assert.ok(a.label && a.count > 0);
  }
  // fundraising precedes impact (taxonomy order from AREA_KEYS)
  const keys = areas.map((a) => a.key);
  assert.ok(keys.indexOf('fundraising') < keys.indexOf('impact'));
});

test('filterByArea returns only mentors tagged with that area, ordered', () => {
  const fr = filterByArea(SHERPAS, 'fundraising');
  assert.ok(fr.length >= 3);
  for (const s of fr) assert.ok(s.areas.includes('fundraising'));
  // ordered by sort_order ascending
  const orders = fr.map((s) => s.sort_order);
  assert.deepStrictEqual(orders, [...orders].sort((a, b) => a - b));
});

test('filterByArea on an unknown area is empty', () => {
  assert.strictEqual(filterByArea(SHERPAS, 'nonexistent').length, 0);
});

test('matchByExpertise ranks topical mentors and ignores short tokens', () => {
  const fundraising = matchByExpertise(SHERPAS, 'fundraising').map((s) => s.slug);
  assert.ok(fundraising.includes('varun-chawla'));
  assert.ok(fundraising.includes('arvind-gourishankar'));
  // a topic no mentor mentions returns nothing (caller falls back to areas)
  assert.strictEqual(matchByExpertise(SHERPAS, 'xyzzy').length, 0);
  // sub-3-char query yields nothing
  assert.strictEqual(matchByExpertise(SHERPAS, 'go').length, 0);
});

test('matchByExpertise resolves an explicit booking by name (top-ranked)', () => {
  const byName = matchByExpertise(SHERPAS, 'book varun chawla');
  assert.strictEqual(byName[0].slug, 'varun-chawla'); // name hit outranks topic hits
  assert.ok(matchByExpertise(SHERPAS, 'ashmita').some((s) => s.slug === 'ashmita-dutta'));
});

test('sherpaRow / areaRow produce valid WhatsApp list rows', () => {
  const row = fmt.sherpaRow(SHERPAS[0]);
  assert.strictEqual(row.id, `sherpa:${SHERPAS[0].slug}`);
  assert.strictEqual(row.title, SHERPAS[0].name);
  assert.ok(row.description.length <= 72);

  const areaRow = fmt.areaRow({ key: 'fundraising', label: 'Fundraising & finance', count: 5 });
  assert.strictEqual(areaRow.id, 'area:fundraising');
  assert.match(areaRow.description, /5 mentors/);
  assert.match(fmt.areaRow({ key: 'impact', label: 'x', count: 1 }).description, /1 mentor$/);
});

test('sherpaCard includes LinkedIn only when present', () => {
  const withLi = fmt.sherpaCard(SHERPAS.find((s) => s.linkedin_url));
  assert.match(withLi, /linkedin\.com/);
  const withoutLi = fmt.sherpaCard(SHERPAS.find((s) => !s.linkedin_url));
  assert.ok(!/linkedin\.com/.test(withoutLi));
  assert.match(withoutLi, /^\*/); // bold name on the first line
});

test('bookingMessage carries the external link plus both guardrails', () => {
  const msg = fmt.bookingMessage(SHERPAS[0]);
  assert.ok(msg.includes(SHERPAS[0].booking_url));
  assert.match(msg, /prep doc/i);
  assert.match(msg, /feedback form/i);
});

test('every sherpa has a slug, booking url, and at least one valid area', () => {
  const slugs = new Set();
  for (const s of SHERPAS) {
    assert.ok(s.slug && !slugs.has(s.slug), `duplicate or missing slug: ${s.slug}`);
    slugs.add(s.slug);
    assert.match(s.booking_url, /^https:\/\//);
    assert.ok(s.areas.length > 0);
    for (const a of s.areas) assert.ok(AREA_KEYS.includes(a), `bad area "${a}" on ${s.slug}`);
  }
});
