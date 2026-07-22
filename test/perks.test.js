'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const {
  categoriesWithCounts,
  filterByCategory,
  matchByText,
} = require('../src/domain/perks');

const PERKS = [
  { slug: 'aws', name: 'AWS Activate', objective: 'cloud computing credits', description: 'AWS credits worth $1,000', categories: ['cloud'], sort_order: 1 },
  { slug: 'zoho', name: 'Zoho', objective: 'business software suite', description: '45+ apps', categories: ['cloud', 'productivity'], sort_order: 2 },
  { slug: 'canva', name: 'Canva', objective: 'design creative assets', description: 'social media images, posters, presentations', categories: ['design'], sort_order: 3 },
  { slug: 'zendesk', name: 'Zendesk', objective: 'customer sales and support CRM', description: 'service-first CRM', categories: ['sales'], sort_order: 4 },
  { slug: 'cashfree', name: 'Cashfree Payments', objective: 'payment gateway', description: 'favorable merchant rates', categories: ['sales'], sort_order: 5 },
];

test('categoriesWithCounts returns only categories with >=1 perk, in taxonomy order, with counts', () => {
  const cats = categoriesWithCounts(PERKS);
  const byKey = Object.fromEntries(cats.map((c) => [c.key, c.count]));
  assert.strictEqual(byKey.cloud, 2); // aws + zoho
  assert.strictEqual(byKey.design, 1);
  assert.strictEqual(byKey.sales, 2); // zendesk + cashfree
  assert.strictEqual(byKey.productivity, 1); // zoho
  // categories with zero perks are omitted entirely
  assert.ok(!('ai' in byKey));
  assert.ok(!('hiring' in byKey));
  // taxonomy order is preserved (cloud before design before sales in the enum)
  assert.deepStrictEqual(cats.map((c) => c.key), ['cloud', 'design', 'sales', 'productivity']);
});

test('categoriesWithCounts carries the human label', () => {
  const cloud = categoriesWithCounts(PERKS).find((c) => c.key === 'cloud');
  assert.strictEqual(cloud.label, 'Cloud & infra credits');
});

test('filterByCategory returns only perks tagged with that category, ordered', () => {
  const cloud = filterByCategory(PERKS, 'cloud');
  assert.deepStrictEqual(cloud.map((p) => p.slug), ['aws', 'zoho']);
  // a multi-tag perk shows up under each of its categories
  assert.deepStrictEqual(filterByCategory(PERKS, 'productivity').map((p) => p.slug), ['zoho']);
  // a category with nothing tagged returns empty, never throws
  assert.deepStrictEqual(filterByCategory(PERKS, 'hiring'), []);
});

test('matchByText ranks by name/objective hits and ignores short tokens', () => {
  // "CRM" appears in Zendesk's objective AND description -> should surface it
  assert.strictEqual(matchByText(PERKS, 'we need a CRM')[0].slug, 'zendesk');
  // "design" hits Canva's objective
  assert.strictEqual(matchByText(PERKS, 'any design tool?')[0].slug, 'canva');
  // "cloud" hits both cloud perks (objective/category KEY), Zendesk not returned
  const cloudHits = matchByText(PERKS, 'cloud credits').map((p) => p.slug);
  assert.ok(cloudHits.includes('aws'));
  assert.ok(!cloudHits.includes('canva'));
  // a need nothing covers returns nothing (caller falls back to the picker)
  assert.deepStrictEqual(matchByText(PERKS, 'legal incorporation lawyer'), []);
  // too-short / empty queries never match
  assert.deepStrictEqual(matchByText(PERKS, 'a to'), []);
  assert.deepStrictEqual(matchByText(PERKS, ''), []);
});

// Real live-confirmed issue: a bare "payments" query matched Zendesk (a CRM,
// nothing to do with payments) purely because the human-readable CATEGORY
// LABEL for its 'sales' tag was "Sales & payments" - a compound label chosen
// for the browse picker, not for search. matchByText must only ever search
// category KEYS ('sales'), never the prose LABEL, so a query word that only
// exists in the label text can't leak onto every perk sharing that tag.
test('matchByText never matches on words that only appear in a category LABEL, not the key', () => {
  const hits = matchByText(PERKS, 'payments').map((p) => p.slug);
  assert.ok(hits.includes('cashfree'), 'the actual payment gateway must still match (its own objective says "payment")');
  assert.ok(!hits.includes('zendesk'), 'a CRM must not match "payments" just because its category label happens to contain the word');
});

// Real live-confirmed issue: a design-tool query's token "design" false-matched
// perks whose description only used "designed" as a generic past-tense verb
// ("a program designed for startups", "products designed to improve...",
// "tools designed to plan...") - none of which are design tools. The same
// token must still match legitimate forms ("designing", "graphic design
// editor") since only the bare "-ed" continuation is the false-positive class.
test('matchByText excludes a bare "-ed" continuation but keeps other word forms', () => {
  const AWS = { slug: 'aws', name: 'AWS Activate', objective: 'cloud computing credits', description: 'a program designed for startups', categories: ['cloud'] };
  const CANVA = { slug: 'canva', name: 'Canva', objective: 'design creative assets', description: 'Canva makes designing beautiful assets easy', categories: ['design'] };
  const CREATOSAURUS = { slug: 'creatosaurus', name: 'Creatosaurus', objective: 'content creation tool', description: 'combines a graphic design editor and more', categories: ['design'] };
  const hits = matchByText([AWS, CANVA, CREATOSAURUS], 'design').map((p) => p.slug);
  assert.ok(!hits.includes('aws'), '"designed for startups" is a generic verb, not a design-tool signal');
  assert.ok(hits.includes('canva'), '"designing" must still match');
  assert.ok(hits.includes('creatosaurus'), '"graphic design editor" must still match');
});

test('matchByText weights a name hit above a description-only hit', () => {
  // "zoho" is a name (weight 2) for one perk and appears nowhere else
  assert.strictEqual(matchByText(PERKS, 'zoho')[0].slug, 'zoho');
});
