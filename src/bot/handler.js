'use strict';

const { env } = require('../config/env');
const engine = require('./engine');
const founders = require('../domain/founders');
const sherpas = require('../domain/sherpas');
const { getConversation, saveConversation } = require('./conversation');
const { sendOutbox } = require('./sendOutbox');
const { resolveTypedSelection } = require('./ordinal');
const { pushProfile, pushSherpaCard } = require('./tools');
const { areaLabel } = require('../domain/sherpaAreas');
const { untrackedNote } = require('./guards');
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

  // Acknowledge immediately - blue ticks + typing bubble (one combined call)
  // before any async work, so it lands within ~50ms of the message arriving.
  if (ev.messageId) wa.markRead(ev.messageId);

  // Graceful degrade: until the database/source are wired, confirm we're online
  // so the WhatsApp inbound→outbound loop is testable on its own.
  if (!env.supabase.url || !env.supabase.serviceKey) {
    await wa.sendText(
      to,
      "👋 Hi! build3 bot is online. I'm in final setup right now. Founder search and cofounder matching go live very soon. Message me again shortly!",
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

  // 1.4) Typed selection over a mentor list ("2", "the first one") - pre-LLM.
  if (ev.text && Array.isArray(conv.draft?.sherpa_results) && conv.draft.sherpa_results.length) {
    const handled = await routeSherpaTypedSelection(ev, to, conv, baseState);
    if (handled) return;
  }

  // 1.5) Typed list selection ("2", "show the first one") - deterministic, pre-LLM.
  // Goes slug → getBySlug, bypassing the brittle name lookup, and commits focus
  // ONLY if the card actually sent.
  if (ev.text && Array.isArray(conv.last_results) && conv.last_results.length) {
    const handled = await routeTypedSelection(ev, to, conv, baseState);
    if (handled) return;
  }

  // 2) Conversational turn. (No standalone beta-disclaimer bubble: Bo greets
  // warmly on first contact per the system prompt, and the beta note rides as the
  // footer on interactive messages, so we don't lead with a scripted liability line.)
  try {
    const history = Array.isArray(conv.history) ? conv.history : [];
    const { outbox, finalText, state, assistantSummary } = await engine.run({
      text: ev.text || '',
      waId: to,
      requesterSlug,
      requesterName,
      history,
      focus: conv.draft?.focus || null,
      self: conv.draft?.self || null,
      prevMatchSlugs: (conv.draft?.match_cache || []).map((m) => m.slug),
    });

    // Honesty backstop: if they tried to filter by an untracked attribute
    // (gender/funding/hiring), guarantee the disclaimer leads the reply even if
    // the model forgot it. Skip if the model already said it.
    let outText = finalText;
    const note = untrackedNote(ev.text || '');
    if (note && !/don't (?:track|have)|can't filter/i.test(outText || '')) {
      outText = outText ? `${note}\n\n${outText}` : `${note} Here's what I do have:`;
    }

    // Conversation FIRST, then the list/cards/links below it. The model has
    // already seen the tool result, so its lead-in frames what's about to appear.
    if (outText) await wa.sendText(to, outText);
    const sendResults = await sendOutbox(to, outbox);
    const allSent = sendResults.every((r) => r.ok);

    const newHistory = [
      ...history,
      { role: 'user', content: ev.text || '' },
      { role: 'assistant', content: assistantSummary || '(no reply)' },
    ].slice(-10);

    await saveConversation(to, {
      ...baseState,
      last_results: state.last_results || conv.last_results || [],
      history: newHistory,
      draft: persistDraft(conv, state, allSent),
    });
  } catch (err) {
    log.error('handleEvent engine error:', err.message);
    await wa.sendText(to, "Sorry, something went wrong on my side. Try again in a moment.");
  }
}

function persistDraft(conv, state, sendsOk = true) {
  const draft = { ...(conv.draft || {}) };
  draft.intro_sent = true; // disclaimer shown once per conversation
  // The user's own background persists for the whole session (survives topic
  // changes) so every later cofounder match stays personalized to them.
  if (state.self) draft.self = state.self;
  if (state.match_cache) {
    draft.match_cache = state.match_cache;
    draft.match_offset = MATCH_PAGE;
  }
  if (state.focus && sendsOk) {
    // New profile viewed this turn AND its card actually sent - update FOCUS and
    // clear stale match context. If the send failed, do NOT point focus at a card
    // the user never saw (their follow-ups would get confidently-wrong facts).
    draft.focus = state.focus;
    delete draft.match_cache;
    delete draft.match_offset;
  } else if (state.topic_changed) {
    // search_founders or find_cofounders was called - user moved on, stale FOCUS is wrong.
    delete draft.focus;
  }
  // Mentor list shown this turn → remember slugs for a typed ("2") pick. A founder
  // search/match (topic_changed) or a viewed founder profile ends the mentor list.
  if (state.sherpa_results) draft.sherpa_results = state.sherpa_results;
  else if (state.topic_changed || (state.focus && sendsOk)) delete draft.sherpa_results;
  return draft;
}

/**
 * Handle a typed list reference ("2", "show the first one") deterministically,
 * before the LLM. Returns true if it was an ordinal reference we resolved.
 */
async function routeTypedSelection(ev, to, conv, baseState) {
  const sel = await resolveTypedSelection({
    text: ev.text,
    lastResults: conv.last_results,
    getBySlug: founders.getBySlug,
    sendCard: async (f) => {
      const ctx = { outbox: [] };
      pushProfile(ctx, f);
      const results = await sendOutbox(to, ctx.outbox);
      return results.every((r) => r.ok);
    },
  });
  if (!sel.handled) return false; // not an ordinal (or stale slug) → let the LLM handle it

  const hist = Array.isArray(conv.history) ? conv.history : [];
  const draft = { ...(conv.draft || {}), intro_sent: true };
  if (sel.sendFailed) {
    await wa.sendText(to, "Sorry, I couldn't load that profile just now. Try again?");
  } else {
    hist.push({ role: 'user', content: ev.text });
    hist.push({ role: 'assistant', content: `(internal note - already shown to the user: the profile of ${sel.founder.name})` });
    draft.focus = fmt.focusFields(sel.founder); // ground follow-ups on real data
    delete draft.match_cache; // viewing a profile ends the previous match list
    delete draft.match_offset;
  }
  await saveConversation(to, {
    ...baseState,
    last_results: conv.last_results, // keep the list so "now show 3" still works
    history: hist.slice(-10),
    draft,
  });
  return true;
}

/** Returns true if the reply id was handled here. */
async function routeReply(ev, to, conv, baseState) {
  const id = ev.replyId;

  if (id.startsWith('profile:')) {
    const slug = id.slice('profile:'.length);
    const f = await founders.getBySlug(slug);
    const hist = Array.isArray(conv.history) ? conv.history : [];
    const draft = { ...(conv.draft || {}) };
    if (f) {
      const ctx = { outbox: [] };
      pushProfile(ctx, f);
      const results = await sendOutbox(to, ctx.outbox);
      if (results.every((r) => r.ok)) {
        hist.push({ role: 'assistant', content: `(internal note - already shown to the user: the profile of ${f.name})` });
        draft.focus = fmt.focusFields(f); // so follow-ups answer from real data
      } else {
        // Card didn't reach the user - don't claim it did, and don't set focus.
        await wa.sendText(to, "Sorry, I couldn't load that profile just now. Try again?");
      }
    } else {
      await wa.sendText(to, "I couldn't find that profile anymore.");
    }
    await saveConversation(to, { ...baseState, history: hist.slice(-10), draft });
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

  // ─── Mentor (Sherpa) hours ─────────────────────────────────────────────────
  if (id.startsWith('area:')) {
    const key = id.slice('area:'.length);
    const list = await sherpas.listByArea(key);
    const draft = { ...(conv.draft || {}), intro_sent: true };
    if (!list.length) {
      await wa.sendText(to, 'No mentors in that area right now. Try another?');
    } else {
      await sendOutbox(to, [
        {
          kind: 'list',
          header: 'Mentor Hours',
          body: `Mentors for ${areaLabel(key)}. Tap one to view and book:`,
          button: 'View mentor',
          rows: list.map(fmt.sherpaRow),
        },
      ]);
      draft.sherpa_results = list.map((s) => s.slug);
    }
    await saveConversation(to, { ...baseState, last_results: [], draft });
    return true;
  }

  if (id.startsWith('sherpa:')) {
    const slug = id.slice('sherpa:'.length);
    const s = await sherpas.getBySlug(slug);
    const draft = { ...(conv.draft || {}), intro_sent: true };
    if (s) {
      const ctx = { outbox: [], state: {} };
      pushSherpaCard(ctx, s);
      const results = await sendOutbox(to, ctx.outbox);
      if (!results.every((r) => r.ok)) {
        await wa.sendText(to, "Sorry, I couldn't load that mentor just now. Try again?");
      }
    } else {
      await wa.sendText(to, "I couldn't find that mentor anymore.");
    }
    await saveConversation(to, { ...baseState, draft });
    return true;
  }

  if (id.startsWith('book:')) {
    const slug = id.slice('book:'.length);
    const s = await sherpas.getBySlug(slug);
    await wa.sendText(to, s ? fmt.bookingMessage(s) : "I couldn't find that mentor anymore.");
    await saveConversation(to, { ...baseState, draft: { ...(conv.draft || {}), intro_sent: true } });
    return true;
  }

  if (id.startsWith('prep:')) {
    await wa.sendText(to, fmt.prepMessage());
    await saveConversation(to, { ...baseState, draft: { ...(conv.draft || {}), intro_sent: true } });
    return true;
  }

  return false; // not an id we own → fall through to the engine
}

/**
 * Handle a typed selection ("2", "the first one") over a mentor list shown last
 * turn. Mirrors routeTypedSelection but resolves against sherpa slugs and sends
 * the mentor card + booking buttons. Returns true if it was an ordinal we owned.
 */
async function routeSherpaTypedSelection(ev, to, conv, baseState) {
  const sel = await resolveTypedSelection({
    text: ev.text,
    lastResults: conv.draft.sherpa_results,
    getBySlug: sherpas.getBySlug,
    sendCard: async (s) => {
      const ctx = { outbox: [], state: {} };
      pushSherpaCard(ctx, s);
      const results = await sendOutbox(to, ctx.outbox);
      return results.every((r) => r.ok);
    },
  });
  if (!sel.handled) return false; // not an ordinal (or stale slug) → let the LLM handle it

  const hist = Array.isArray(conv.history) ? conv.history : [];
  const draft = { ...(conv.draft || {}), intro_sent: true };
  if (sel.sendFailed) {
    await wa.sendText(to, "Sorry, I couldn't load that mentor just now. Try again?");
  } else {
    hist.push({ role: 'user', content: ev.text });
    hist.push({
      role: 'assistant',
      content: `(internal note - already shown to the user: the mentor card for ${sel.founder.name})`,
    });
  }
  await saveConversation(to, { ...baseState, history: hist.slice(-10), draft });
  return true;
}

module.exports = { handleEvent };
