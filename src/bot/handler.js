'use strict';

const { env } = require('../config/env');
const engine = require('./engine');
const founders = require('../domain/founders');
const { getConversation, saveConversation } = require('./conversation');
const { sendOutbox } = require('./sendOutbox');
const { pushProfile } = require('./tools');
const fmt = require('./format');
const wa = require('../whatsapp/cloudApi');
const log = require('../lib/logger');

const MATCH_PAGE = 3;

/**
 * Handle one parsed inbound event end-to-end:
 * resolve identity → route interactive replies → else run the engine → send.
 */
async function handleEvent(ev) {
  const to = ev.waId;

  // Graceful degrade: until the database/source are wired, confirm we're online
  // so the WhatsApp inbound→outbound loop is testable on its own.
  if (!env.supabase.url || !env.supabase.serviceKey) {
    await wa.sendText(
      to,
      "👋 Hi! build3 bot is online — I'm in final setup right now. Founder search and cofounder matching go live very soon. Message me again shortly!",
    );
    return;
  }

  const conv = await getConversation(to);
  const founder = await founders.findByWaId(to);
  const requesterSlug = founder?.source_slug || conv.founder_slug || null;
  const requesterName = founder?.name || ev.name || null;

  // Persist resolved identity early.
  const baseState = { founder_slug: requesterSlug };

  // 1) Interactive reply routing (deterministic, no LLM).
  if (ev.replyId) {
    const handled = await routeReply(ev, to, conv, baseState);
    if (handled) return;
  }

  // 2) Conversational turn.
  try {
    const { outbox, finalText, state } = await engine.run({
      text: ev.text || '',
      requesterSlug,
      requesterName,
    });

    await sendOutbox(to, outbox);
    if (finalText) await wa.sendText(to, finalText);

    await saveConversation(to, {
      ...baseState,
      last_results: state.last_results || conv.last_results || [],
      draft: persistDraft(conv, state),
    });
  } catch (err) {
    log.error('handleEvent engine error:', err.message);
    await wa.sendText(to, "Sorry — something went wrong on my side. Try again in a moment.");
  }
}

function persistDraft(conv, state) {
  const draft = { ...(conv.draft || {}) };
  if (state.match_cache) {
    draft.match_cache = state.match_cache;
    draft.match_offset = MATCH_PAGE;
  }
  return draft;
}

/** Returns true if the reply id was handled here. */
async function routeReply(ev, to, conv, baseState) {
  const id = ev.replyId;

  if (id.startsWith('profile:')) {
    const slug = id.slice('profile:'.length);
    const f = await founders.getBySlug(slug);
    if (f) {
      const ctx = { outbox: [] };
      pushProfile(ctx, f);
      await sendOutbox(to, ctx.outbox);
    } else {
      await wa.sendText(to, "I couldn't find that profile anymore.");
    }
    await saveConversation(to, baseState);
    return true;
  }

  if (id === 'more:matches') {
    const cache = conv.draft?.match_cache || [];
    const offset = conv.draft?.match_offset || MATCH_PAGE;
    const next = cache.slice(offset, offset + MATCH_PAGE);
    if (next.length === 0) {
      await wa.sendText(to, "That's everyone I found. Want to try different criteria?");
      return true;
    }
    const outbox = next.map((m) => ({
      kind: 'image',
      url: fmt.avatarFor(m),
      caption: fmt.matchCaption(m),
    }));
    const newOffset = offset + next.length;
    if (cache.length > newOffset) {
      outbox.push({
        kind: 'buttons',
        body: `${cache.length - newOffset} more available.`,
        buttons: [{ id: 'more:matches', title: 'More matches' }],
      });
    }
    await sendOutbox(to, outbox);
    await saveConversation(to, {
      ...baseState,
      draft: { ...(conv.draft || {}), match_offset: newOffset },
    });
    return true;
  }

  return false; // not an id we own → fall through to the engine
}

module.exports = { handleEvent };
