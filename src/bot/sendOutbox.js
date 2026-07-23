'use strict';

const wa = require('../whatsapp/cloudApi');
const log = require('../lib/logger');

// WhatsApp accepts an image sent by URL instantly (HTTP 200) but then fetches +
// transcodes the media ASYNCHRONOUSLY before delivering it to the phone - so a
// lightweight text/buttons message sent right after has nothing to fetch and
// can overtake a still-processing image, landing out of order on the device
// (real observed failure: a "N more matches" button appeared BETWEEN cards
// instead of after them). WhatsApp does not guarantee ordering across mixed
// media/non-media sends. Pausing after an image gives it time to actually land
// before the next message goes out. Not a hard guarantee, but it removes the
// overwhelming majority of reorders; env-tunable so it can be adjusted without
// a code change if Meta's media latency shifts.
const IMAGE_SETTLE_MS = parseInt(process.env.IMAGE_SETTLE_MS, 10) || 800;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  for (let i = 0; i < outbox.length; i++) {
    const m = outbox[i];
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
    // Only pause after an image that actually sent AND has something after it -
    // no point delaying the very last message or after a failed send.
    if (m.kind === 'image' && ok && i < outbox.length - 1 && IMAGE_SETTLE_MS > 0) {
      await sleep(IMAGE_SETTLE_MS);
    }
  }
  return results;
}

module.exports = { sendOutbox };
