'use strict';

const log = require('./logger');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Retry an async fn on TRANSIENT failures (network blips, 429 rate limit, 5xx).
 * Non-transient errors (4xx other than 429) are re-thrown immediately - retrying
 * a bad request never helps. Backoff is exponential from baseMs.
 *
 * @param {() => Promise<any>} fn
 * @param {{retries?:number, baseMs?:number, label?:string}} opts
 */
async function withRetry(fn, { retries = 2, baseMs = 600, label = 'op' } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = err?.status ?? err?.response?.status;
      const transient = status == null || status === 429 || status >= 500;
      if (!transient || attempt === retries) throw err;
      const delay = baseMs * 2 ** attempt;
      log.warn(
        `${label} transient failure (attempt ${attempt + 1}/${retries + 1}, status ${status ?? 'n/a'}) - retrying in ${delay}ms: ${err.message}`,
      );
      await sleep(delay);
    }
  }
  throw lastErr;
}

module.exports = { withRetry };
