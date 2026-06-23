'use strict';

/**
 * In-memory dedupe of recently-seen WhatsApp message ids. Meta retries the same
 * webhook within seconds when our 200 is slow; a small bounded set is enough to
 * drop duplicates without a DB round-trip.
 */
const MAX = 2000;
const seen = new Set();

function alreadyProcessed(messageId) {
  if (!messageId) return false;
  if (seen.has(messageId)) return true;
  seen.add(messageId);
  if (seen.size > MAX) {
    // Drop the oldest ~10% (insertion order is preserved by Set).
    const drop = Math.floor(MAX * 0.1);
    let i = 0;
    for (const id of seen) {
      seen.delete(id);
      if (++i >= drop) break;
    }
  }
  return false;
}

module.exports = { alreadyProcessed };
