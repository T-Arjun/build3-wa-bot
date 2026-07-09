'use strict';

const { env } = require('../config/env');
const engine = require('./engine');
const founders = require('../domain/founders');
const sherpas = require('../domain/sherpas');
const { getConversation, saveConversation } = require('./conversation');
const { sendOutbox: sendOutboxRaw } = require('./sendOutbox');
const messageLog = require('../domain/messageLog');
const { resolveTypedSelection } = require('./ordinal');
const { pushProfile, pushSherpaCard } = require('./tools');
const { areaLabel } = require('../domain/sherpaAreas');
const { untrackedNote, selfHarmResponse } = require('./guards');
const { buildMentionNote, findMentions } = require('./mentions');
const fmt = require('./format');
const wa = require('../whatsapp/cloudApi');
const log = require('../lib/logger');

const MATCH_PAGE = 3;

/**
 * Thin logging wrappers around the two real send paths (wa.sendText directly,
 * and the rich sendOutbox specs) so EVERY outbound message - regardless of
 * which branch sent it - lands in the full-fidelity message_log, independent
 * of the 10-entry-capped conversations.history used for LLM context.
 */
async function sendText(to, body) {
  let ok = true;
  try {
    await wa.sendText(to, body);
  } catch (err) {
    ok = false;
    throw err;
  } finally {
    // Log on failure too - a send that never reached WhatsApp still needs a
    // row (tagged ok=false) so the admin dashboard can show it as failed
    // instead of silently having no record at all.
    await messageLog.logOutbound(to, { kind: 'text', body }, ok);
  }
}

async function sendOutbox(to, outbox) {
  const results = await sendOutboxRaw(to, outbox);
  // Logged sequentially (not Promise.all) so message_log rows get inserted in
  // the SAME order sendOutboxRaw actually sent them - sendOutboxRaw itself
  // sends one spec at a time, awaited, so a concurrent Promise.all here could
  // let a later spec's row land (and get an earlier created_at/id) before an
  // earlier spec's row, scrambling the admin dashboard's rendered order.
  for (let i = 0; i < outbox.length; i++) {
    await messageLog.logOutbound(to, outbox[i], results[i]?.ok !== false);
  }
  return results;
}

/**
 * Per-wa_id serialization. WhatsApp users routinely fire 2+ messages within a
 * few seconds (impatience, or Meta redelivering); server.js dispatches each
 * inbound event without awaiting, so without this, concurrent handleEvent
 * calls for the SAME user each read their own stale `conv` snapshot and the
 * later save clobbers the earlier one - lost history, stale/wrong focus,
 * duplicated intros. This chains calls for one wa_id so only one is ever
 * in flight at a time, while different users still run fully in parallel (no
 * cross-user latency cost). The chain entry is deleted once it's the tail, so
 * the map never grows unbounded across the process lifetime.
 */
const chains = new Map();

function handleEvent(ev) {
  const waId = ev.waId || '(unknown)';
  const tail = chains.get(waId) || Promise.resolve();
  const next = tail.then(() => processEvent(ev), () => processEvent(ev));
  chains.set(waId, next);
  next.finally(() => {
    if (chains.get(waId) === next) chains.delete(waId);
  });
  return next;
}

/**
 * Handle one parsed inbound event end-to-end:
 * resolve identity → route interactive replies → else run the engine → send.
 */
async function processEvent(ev) {
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

  // Full-fidelity audit log (unbounded, independent of the 10-entry-capped
  // conversations.history) - covers typed text AND interactive taps, since
  // parseInbound already puts the tapped title into ev.text either way.
  // MUST be awaited: the outbound reply's log rows are also awaited later in
  // this function, so an unawaited inbound insert can race them over the
  // network and land with a HIGHER id than the reply that answers it -
  // scrambling the /messages id-ordered dashboard exactly like the bug this
  // table was built to fix.
  await messageLog.logInbound(to, ev);

  const conv = await getConversation(to);
  const founder = await founders.findByWaId(to);
  const requesterSlug = founder?.source_slug || conv.founder_slug || null;
  const requesterName = founder?.name || ev.name || null;

  // Persist resolved identity early.
  const baseState = { founder_slug: requesterSlug };

  // 0.5) Explicit self-harm language: fixed humane response, no LLM turn.
  // A founder-networking bot must never answer "I want to kill myself" with a
  // founder search or a chirpy register. The regex is deliberately narrow
  // (first-person harm only); mere talk of death goes to the normal engine,
  // whose prompt has sensitive-topic rules.
  if (ev.text && !ev.replyId) {
    const care = selfHarmResponse(ev.text);
    if (care) {
      await sendText(to, care);
      const hist = Array.isArray(conv.history) ? conv.history : [];
      hist.push({ role: 'user', content: ev.text });
      hist.push({ role: 'assistant', content: care });
      await saveConversation(to, {
        ...baseState,
        history: hist.slice(-10),
        draft: { ...(conv.draft || {}), intro_sent: true },
      });
      return;
    }
  }

  // 1) Interactive reply routing (deterministic, no LLM). Wrapped so a tap can
  // never die silently (typing indicator then nothing): on any error we tell the
  // user instead of leaving them staring at a dead card.
  if (ev.replyId) {
    try {
      const handled = await routeReply(ev, to, conv, baseState);
      if (handled) return;
    } catch (err) {
      log.error('routeReply failed:', err.message);
      await sendText(to, 'sorry, that one glitched on our side. try again, or tell me what you need?');
      return;
    }
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
    const mentionNote = await buildEntityGrounding(ev.text, conv);
    const { outbox, finalText, state, assistantSummary } = await engine.run({
      text: ev.text || '',
      waId: to,
      requesterSlug,
      requesterName,
      history,
      focus: conv.draft?.focus || null,
      self: conv.draft?.self || null,
      prevMatchSlugs: (conv.draft?.match_cache || []).map((m) => m.slug),
      mentionNote,
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
    if (outText) await sendText(to, outText);
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
    await sendText(to, "Sorry, something went wrong on my side. Try again in a moment.");
  }
}

/**
 * Deterministic person-entity grounding (see mentions.js for the why): scan
 * the raw text against every person currently "in play" for this conversation
 * and produce a system note pinning names to canonical identities. Failure
 * here must never block the turn - worst case the model falls back to its old
 * (fuzzier) behavior.
 */
async function buildEntityGrounding(text, conv) {
  if (!text) return null;
  try {
    const draft = conv.draft || {};
    const candidates = [];
    for (const s of await sherpas.listAll()) {
      candidates.push({ name: s.name, slug: s.slug, type: 'sherpa', bookingUrl: s.booking_url });
    }
    if (draft.focus?.slug) {
      candidates.push({
        name: draft.focus.name,
        slug: draft.focus.slug,
        type: 'founder',
        linkedinUrl: draft.focus.linkedin_url || undefined,
      });
    }
    for (const m of draft.match_cache || []) {
      if (m?.slug) candidates.push({ name: m.name, slug: m.slug, type: 'founder', linkedinUrl: m.linkedin_url || undefined });
    }
    for (const slug of conv.last_results || []) {
      if (typeof slug === 'string') candidates.push({ name: slug.replace(/-/g, ' '), slug, type: 'founder' });
    }
    const hits = findMentions(text, candidates);
    if (!hits.length) return null;
    // Enrich matched founders that came in as bare slugs with their real
    // name + LinkedIn, so the note can hand the model the actual link.
    for (const h of hits) {
      if (h.type === 'founder' && !h.linkedinUrl) {
        const f = await founders.getBySlug(h.slug).catch(() => null);
        if (f) {
          h.name = f.name || h.name;
          h.linkedinUrl = f.linkedin_url || undefined;
        }
      }
    }
    return buildMentionNote(text, hits);
  } catch (err) {
    log.warn('entity grounding failed (continuing without):', err.message);
    return null;
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
    await sendText(to, "sorry, couldn't load that profile just now. try again?");
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
        await sendText(to, "sorry, couldn't load that profile just now. try again?");
      }
    } else {
      await sendText(to, "hmm, we couldn't find that profile anymore.");
    }
    await saveConversation(to, { ...baseState, history: hist.slice(-10), draft });
    return true;
  }

  if (id === 'more:matches') {
    const cache = conv.draft?.match_cache || [];
    const offset = conv.draft?.match_offset || MATCH_PAGE;
    const next = cache.slice(offset, offset + MATCH_PAGE);
    if (next.length === 0) {
      await sendText(to, "That's everyone I found. Want to try different criteria?");
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
      await sendText(to, 'no Sherpas in that area right now. try another?');
    } else {
      await sendOutbox(to, [
        {
          kind: 'list',
          header: 'Sherpa hours',
          body: `Sherpas for ${areaLabel(key)}. tap one to view and book:`,
          button: 'View Sherpa',
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
        await sendText(to, "sorry, couldn't load that sherpa just now. try again?");
      }
    } else {
      await sendText(to, "hmm, we couldn't find that sherpa anymore.");
    }
    await saveConversation(to, { ...baseState, draft });
    return true;
  }

  if (id.startsWith('book:')) {
    const slug = id.slice('book:'.length);
    const s = await sherpas.getBySlug(slug);
    await sendText(to, s ? fmt.bookingMessage(s) : "hmm, we couldn't find that sherpa anymore.");
    await saveConversation(to, { ...baseState, draft: { ...(conv.draft || {}), intro_sent: true } });
    return true;
  }

  if (id.startsWith('prep:')) {
    await sendText(to, fmt.prepMessage());
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
    await sendText(to, "sorry, couldn't load that sherpa just now. try again?");
  } else {
    hist.push({ role: 'user', content: ev.text });
    hist.push({
      role: 'assistant',
      content: `(internal note - already shown to the user: the Sherpa card for ${sel.founder.name})`,
    });
  }
  await saveConversation(to, { ...baseState, history: hist.slice(-10), draft });
  return true;
}

module.exports = { handleEvent };
