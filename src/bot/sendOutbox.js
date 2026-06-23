'use strict';

const wa = require('../whatsapp/cloudApi');
const log = require('../lib/logger');

/**
 * Send a list of outbound message specs in order.
 * spec.kind ∈ text | buttons | list | image
 */
async function sendOutbox(to, outbox) {
  for (const m of outbox) {
    try {
      if (m.kind === 'text') await wa.sendText(to, m.body);
      else if (m.kind === 'buttons') await wa.sendButtons(to, m.body, m.buttons);
      else if (m.kind === 'list') await wa.sendList(to, m.body, m.button, m.rows, m.header);
      else if (m.kind === 'image') await wa.sendImage(to, m.url, m.caption);
    } catch (err) {
      log.error(`sendOutbox ${m.kind} failed:`, err.message);
    }
  }
}

module.exports = { sendOutbox };
