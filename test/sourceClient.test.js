'use strict';

const assert = require('node:assert');
const { test } = require('node:test');

process.env.SOURCE_API_BASE = process.env.SOURCE_API_BASE || 'https://example.test';
process.env.SOURCE_API_KEY = process.env.SOURCE_API_KEY || 'test-key';
const { iterateListedUsers } = require('../src/sync/sourceClient');

/** Temporarily replace global.fetch for one test, restoring it afterward. */
function withFetch(impl, fn) {
  const real = global.fetch;
  global.fetch = impl;
  return fn().finally(() => {
    global.fetch = real;
  });
}

function jsonResponse(body, ok = true, status = 200) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) };
}

test('iterates every founder across all real pages', async () => {
  await withFetch(
    async (url) => {
      const page = Number(new URL(url).searchParams.get('page'));
      if (page === 1) return jsonResponse({ success: true, totalPages: 2, data: [{ slug: 'a' }, { slug: 'b' }] });
      return jsonResponse({ success: true, totalPages: 2, data: [{ slug: 'c' }] });
    },
    async () => {
      const seen = [];
      for await (const { founder } of iterateListedUsers()) seen.push(founder.slug);
      assert.deepStrictEqual(seen, ['a', 'b', 'c']);
    },
  );
});

// Real gap this closes: no upper bound meant a source-side pagination bug
// (a wrong/runaway totalPages) would loop forever - and schedule.js's overlap
// guard is a plain boolean with no timeout, so a hung sync silently disables
// every future scheduled sync until a manual restart.
test('a pathological totalPages that never converges throws instead of looping forever', async () => {
  await withFetch(
    async () => jsonResponse({ success: true, totalPages: 999999999, data: [{ slug: 'x' }] }),
    async () => {
      await assert.rejects(
        async () => {
          for await (const _ of iterateListedUsers()) {
            /* drain */
          }
        },
        /exceeded \d+ pages/,
      );
    },
  );
});

test('a malformed response shape throws a clear error, not a silent empty result', async () => {
  await withFetch(
    async () => jsonResponse({ success: true, data: 'not-an-array' }),
    async () => {
      await assert.rejects(async () => {
        for await (const _ of iterateListedUsers()) {
          /* drain */
        }
      }, /unexpected shape/);
    },
  );
});

test('an HTTP error from the source surfaces as a real error', async () => {
  await withFetch(
    async () => jsonResponse({}, false, 503),
    async () => {
      await assert.rejects(async () => {
        for await (const _ of iterateListedUsers()) {
          /* drain */
        }
      }, /failed \(503\)/);
    },
  );
});
