'use strict';

const crypto = require('crypto');
const { env } = require('../config/env');
const log = require('../lib/logger');

/**
 * Verify Meta's X-Hub-Signature-256 over the raw request body.
 * Requires the raw body buffer (see server.js express.json verify hook).
 * Returns true when valid, or when no app secret is configured (dev mode).
 */
function verifySignature(req) {
  if (!env.whatsapp.appSecret) {
    if (env.whatsapp.allowUnsigned) {
      log.warn('WHATSAPP_APP_SECRET not set — allowing unsigned webhook (ALLOW_UNSIGNED_WEBHOOKS=true)');
      return true;
    }
    if (env.nodeEnv === 'production') {
      // Fail closed: an unauthenticated webhook in prod lets anyone spoof messages.
      log.error(
        'WHATSAPP_APP_SECRET not set in production — REJECTING webhook. Set the secret, or ALLOW_UNSIGNED_WEBHOOKS=true to bypass intentionally.',
      );
      return false;
    }
    log.warn('WHATSAPP_APP_SECRET not set — skipping signature verification (non-production)');
    return true;
  }
  const header = req.get('x-hub-signature-256') || '';
  const raw = req.rawBody;
  if (!header || !raw) return false;

  const expected =
    'sha256=' +
    crypto.createHmac('sha256', env.whatsapp.appSecret).update(raw).digest('hex');

  try {
    const a = Buffer.from(header);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

module.exports = { verifySignature };
