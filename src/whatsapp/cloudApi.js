'use strict';

const { env } = require('../config/env');
const { DISCLAIMER } = require('../lib/constants');
const log = require('../lib/logger');

/**
 * Meta WhatsApp Cloud API sender.
 * Docs: https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages
 */

function graphUrl() {
  const { graphVersion, phoneNumberId } = env.whatsapp;
  return `https://graph.facebook.com/${graphVersion}/${phoneNumberId}/messages`;
}

async function send(payload) {
  if (!env.whatsapp.token || !env.whatsapp.phoneNumberId) {
    log.warn('WhatsApp not configured - would send:', JSON.stringify(payload).slice(0, 500));
    return { skipped: true };
  }
  const res = await fetch(graphUrl(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.whatsapp.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    log.error(`Cloud API send failed (${res.status}): ${body.slice(0, 400)}`);
    throw new Error(`Cloud API ${res.status}`);
  }
  return res.json();
}

function sendText(to, body) {
  return send({ to, type: 'text', text: { preview_url: false, body: truncate(body, 4096) } });
}

/**
 * Reply buttons - max 3. buttons = [{id, title}].
 */
function sendButtons(to, body, buttons) {
  return send({
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: truncate(body, 1024) },
      footer: { text: truncate(DISCLAIMER, 60) },
      action: {
        buttons: buttons.slice(0, 3).map((b) => ({
          type: 'reply',
          reply: { id: b.id, title: truncate(b.title, 20) },
        })),
      },
    },
  });
}

/**
 * CTA-URL message - a single button that opens `url` directly (no reply id).
 * The only interactive type that deep-links to the web; can't be combined with
 * reply buttons in the same message.
 */
function sendCtaUrl(to, body, displayText, url, header) {
  return send({
    to,
    type: 'interactive',
    interactive: {
      type: 'cta_url',
      ...(header ? { header: { type: 'text', text: truncate(header, 60) } } : {}),
      body: { text: truncate(body, 1024) },
      footer: { text: truncate(DISCLAIMER, 60) },
      action: {
        name: 'cta_url',
        parameters: { display_text: truncate(displayText || 'Open', 20), url },
      },
    },
  });
}

/**
 * List message - up to 10 rows total. rows = [{id, title, description?}].
 */
function sendList(to, body, buttonLabel, rows, header) {
  return send({
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      ...(header ? { header: { type: 'text', text: truncate(header, 60) } } : {}),
      body: { text: truncate(body, 1024) },
      footer: { text: truncate(DISCLAIMER, 60) },
      action: {
        button: truncate(buttonLabel || 'Select', 20),
        sections: [
          {
            rows: rows.slice(0, 10).map((r) => ({
              id: r.id,
              title: truncate(r.title, 24),
              ...(r.description ? { description: truncate(r.description, 72) } : {}),
            })),
          },
        ],
      },
    },
  });
}

/**
 * Image message via public link (e.g. a founder avatar URL), with optional caption.
 */
function sendImage(to, imageUrl, caption) {
  return send({
    to,
    type: 'image',
    image: { link: imageUrl, ...(caption ? { caption: truncate(caption, 1024) } : {}) },
  });
}

/**
 * Mark a received message as read AND show a typing indicator - in ONE call.
 *
 * The typing indicator is NOT a standalone message type. The /messages endpoint
 * rejects type:"typing_indicator" (its enum is audio/text/image/interactive/…),
 * which is why a separate typing call 400s. Instead the indicator rides along
 * with the read-receipt request, keyed on message_id: blue double-ticks appear
 * immediately, and a "typing…" bubble shows for up to 25s or until the next
 * outbound message, whichever comes first.
 * Ref: https://developers.facebook.com/docs/whatsapp/cloud-api/typing-indicators/
 */
function markRead(messageId) {
  if (!messageId) return Promise.resolve();
  log.info('markRead+typing', messageId);
  return send({
    status: 'read',
    message_id: messageId,
    typing_indicator: { type: 'text' },
  }).catch((err) => {
    log.warn('markRead failed:', err.message);
  });
}

function truncate(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

module.exports = { send, sendText, sendButtons, sendList, sendCtaUrl, sendImage, markRead };
