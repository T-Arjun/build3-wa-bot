'use strict';

/**
 * Normalize a Meta Cloud API webhook payload into a flat list of inbound events.
 * Each event: { waId, name, messageId, type, text, replyId, image }
 *  - type 'text'         → text
 *  - type 'interactive'  → replyId (button/list selection id), text = title
 *  - type 'image'        → image { id, mimeType, caption }
 * Status callbacks (delivered/read) are ignored (returns []).
 */
function parseInbound(body) {
  const events = [];
  const entries = body?.entry || [];
  for (const entry of entries) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const contacts = value.contacts || [];
      const nameByWaId = {};
      for (const c of contacts) nameByWaId[c.wa_id] = c.profile?.name;

      for (const msg of value.messages || []) {
        const waId = msg.from;
        const base = {
          waId,
          name: nameByWaId[waId] || null,
          messageId: msg.id,
          type: msg.type,
          text: null,
          replyId: null,
          image: null,
        };

        if (msg.type === 'text') {
          base.text = msg.text?.body || '';
        } else if (msg.type === 'interactive') {
          const it = msg.interactive || {};
          if (it.type === 'button_reply') {
            base.replyId = it.button_reply?.id || null;
            base.text = it.button_reply?.title || '';
          } else if (it.type === 'list_reply') {
            base.replyId = it.list_reply?.id || null;
            base.text = it.list_reply?.title || '';
          }
        } else if (msg.type === 'image') {
          base.image = {
            id: msg.image?.id || null,
            mimeType: msg.image?.mime_type || null,
            caption: msg.image?.caption || null,
          };
          base.text = msg.image?.caption || '';
        } else if (msg.type === 'button') {
          // template quick-reply button
          base.text = msg.button?.text || '';
          base.replyId = msg.button?.payload || null;
        }

        events.push(base);
      }
    }
  }
  return events;
}

/**
 * Extract delivery/read/failed status callbacks from a webhook payload.
 * Each event: { wamid, status } - status ∈ sent | delivered | read | failed.
 * These arrive on the SAME /webhook payload as inbound messages, just under
 * value.statuses instead of value.messages, keyed by the wamid Meta returned
 * from the original send.
 */
function parseStatuses(body) {
  const events = [];
  const entries = body?.entry || [];
  for (const entry of entries) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      for (const s of value.statuses || []) {
        if (!s.id || !s.status) continue;
        events.push({ wamid: s.id, status: s.status });
      }
    }
  }
  return events;
}

module.exports = { parseInbound, parseStatuses };
