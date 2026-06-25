'use strict';

const wa = require('../whatsapp/cloudApi');
const log = require('../lib/logger');

/**
 * Send a list of outbound message specs in order.
 * spec.kind ∈ text | buttons | list | image
 * Returns one { kind, ok } per spec (in order) so callers can avoid committing
 * state (e.g. draft.focus) for a card that never reached the user.
 */
async function sendOutbox(to, outbox) {
  const results = [];
  for (const m of outbox) {
    let ok = false;
    try {
      if (m.kind === 'text') await wa.sendText(to, m.body);
      else if (m.kind === 'buttons') await wa.sendButtons(to, m.body, m.buttons);
      else if (m.kind === 'list') await wa.sendList(to, m.body, m.button, m.rows, m.header);
      else if (m.kind === 'image') await wa.sendImage(to, m.url, m.caption);
      ok = true;
    } catch (err) {
      log.error(`sendOutbox ${m.kind} failed:`, err.message);
    }
    results.push({ kind: m.kind, ok });
  }
  return results;
}

module.exports = { sendOutbox };
