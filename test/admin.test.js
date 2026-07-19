'use strict';

const assert = require('node:assert');
const { test, beforeEach } = require('node:test');

process.env.ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'test-only-token';
const router = require('../src/admin/routes');
const { tokenMatches, isValidUrl, isRateLimited, recordFailure, resetRateLimiter } = router._testHooks;

// ─── constant-time token comparison ────────────────────────────────────────

test('tokenMatches: correct token matches, wrong token does not', () => {
  assert.strictEqual(tokenMatches('secret123', 'secret123'), true);
  assert.strictEqual(tokenMatches('wrong', 'secret123'), false);
});

test('tokenMatches: different lengths never throw, always false', () => {
  assert.strictEqual(tokenMatches('short', 'a-much-longer-secret-token'), false);
  assert.strictEqual(tokenMatches('', 'secret123'), false);
  assert.strictEqual(tokenMatches('secret123', ''), false);
});

// ─── brute-force throttle on the admin auth check ──────────────────────────
// Real gap this closes: there was NO limit at all on failed auth attempts
// before this fix - unlimited token guessing against a live endpoint.

beforeEach(() => resetRateLimiter());

test('rate limiter allows attempts under the threshold', () => {
  for (let i = 0; i < 7; i++) recordFailure('test-ip-a');
  assert.strictEqual(isRateLimited('test-ip-a'), false);
});

test('rate limiter blocks once the failure threshold is hit', () => {
  for (let i = 0; i < 8; i++) recordFailure('test-ip-b');
  assert.strictEqual(isRateLimited('test-ip-b'), true);
});

test('rate limiter buckets are independent per key', () => {
  for (let i = 0; i < 8; i++) recordFailure('test-ip-c');
  assert.strictEqual(isRateLimited('test-ip-c'), true);
  assert.strictEqual(isRateLimited('test-ip-d'), false); // untouched key, unaffected
});

// ─── URL-scheme validation for sherpa links (stored-XSS fix) ───────────────
// Real live-confirmed gap: booking_url/linkedin_url/avatar_url were accepted
// with zero scheme check and rendered later as a raw href/src. A
// "javascript:alert(document.location)" booking_url was proved to pass
// straight through to the stored row before this fix.

test('http(s) URLs are accepted', () => {
  assert.strictEqual(isValidUrl('https://calendar.app.google/abc'), true);
  assert.strictEqual(isValidUrl('http://example.com'), true);
});

test('non-http(s) schemes are rejected', () => {
  assert.strictEqual(isValidUrl('javascript:alert(document.location)'), false);
  assert.strictEqual(isValidUrl('data:text/html,<script>alert(1)</script>'), false);
  assert.strictEqual(isValidUrl('vbscript:msgbox(1)'), false);
});

test('empty/absent optional URL fields are allowed through (not required)', () => {
  assert.strictEqual(isValidUrl(''), true);
  assert.strictEqual(isValidUrl(null), true);
  assert.strictEqual(isValidUrl(undefined), true);
});
