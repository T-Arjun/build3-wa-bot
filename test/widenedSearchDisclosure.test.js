'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { widenedSearchDisclosure } = require('../src/bot/tools');

// The real live failure this exists to prevent: "find me a cofounder on
// fintech in bengalire" widened past sector (only 1 fintech founder in
// Bengaluru exists and they aren't cofounder-seeking) to a respiratory-sensor
// founder, and the model's own lead-in claimed "found a technical cofounder
// match for fintech in Bangalore" - a flat contradiction of what was actually
// shown. The disclosure is now a message the code sends directly so the
// model can't omit or contradict it.

test('sector dropped: names the actual sector that had no match', () => {
  const body = widenedSearchDisclosure(['sector'], { city: 'Bengaluru', sector: 'Financial Services' });
  assert.match(body, /no strong Financial Services match/);
  assert.doesNotMatch(body, /Bengaluru/); // city was NOT dropped, so it's not named as unmatched
});

test('city dropped: names the actual city that had no match', () => {
  const body = widenedSearchDisclosure(['city'], { city: 'Bengaluru', sector: 'Financial Services' });
  assert.match(body, /no strong Bengaluru match/);
});

test('both dropped: names both', () => {
  const body = widenedSearchDisclosure(['city', 'sector'], { city: 'Bengaluru', sector: 'Financial Services' });
  assert.match(body, /Bengaluru \+ Financial Services/);
});
