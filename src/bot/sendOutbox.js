'use strict';

const wa = require('../whatsapp/cloudApi');
const log = require('../lib/logger');

/**
 * Send a list of outbound message specs in order.
 * spec.kind ∈ text | buttons | list | cta | image
 * Returns one { kind, ok, wamid } per spec (in order) so callers can avoid
 * committing state (e.g. draft.focus) for a card that never reached the user,
 * and can tie a later delivery/read status callback (keyed on wamid) back to
 * the right message_log row.
 */
async function sendOutbox(to, outbox) {
  const results = [];
  for (const m of outbox) {
    let ok = false;
    let wamid = null;
    try {
      let res;
      if (m.kind === 'text') res = await wa.sendText(to, m.body);
      else if (m.kind === 'buttons') res = await wa.sendButtons(to, m.body, m.buttons);
      else if (m.kind === 'list') res = await wa.sendList(to, m.body, m.button, m.rows, m.header);
      else if (m.kind === 'cta') res = await wa.sendCtaUrl(to, m.body, m.title, m.url, m.headerImage);
      else if (m.kind === 'image') res = await wa.sendImage(to, m.url, m.caption);
      wamid = res?.messages?.[0]?.id || null;
      ok = true;
    } catch (err) {
      log.error(`sendOutbox ${m.kind} failed:`, err.message);
    }
    results.push({ kind: m.kind, ok, wamid });
  }
  return results;
}

module.exports = { sendOutbox };
