'use strict';

const { openai } = require('../config/openai');
const { env } = require('../config/env');
const { systemPrompt } = require('./prompts');
const { definitions, impls } = require('./tools');
const { scrubUnverifiedUrls, extractUrls } = require('./guards');
const log = require('../lib/logger');

const MAX_TURNS = 4;

/**
 * Run one conversational turn through the tool-calling loop.
 * @param {{text:string, requesterSlug:?string, requesterName:?string}} input
 * @returns {Promise<{outbox:object[], finalText:string, state:object}>}
 */
async function run(input) {
  const ctx = {
    outbox: [],
    state: {},
    waId: input.waId || null,
    requesterSlug: input.requesterSlug || null,
    requesterName: input.requesterName || null,
    nameConfirmed: !!input.nameConfirmed,
    self: input.self || null,
    prevMatchSlugs: input.prevMatchSlugs || [],
    focusSlug: input.focus?.slug || null,
    // Raw text of the CURRENT turn, so a tool impl can deterministically check
    // for intent words (e.g. "book"/"calendar") the model may have stripped out
    // before calling the tool - see get_profile's booking-intent override.
    rawText: input.text || '',
  };

  const history = Array.isArray(input.history) ? input.history : [];
  // Each completed turn appends a user+assistant pair, so history.length/2 is
  // how many replies we've already sent. A "casually ask for their name
  // sometime soon" instruction alone was empirically unreliable live across
  // several test conversations (idle chat included) - the model always found
  // something else to prioritize and never asked. Turn count makes the WHEN
  // deterministic (matches this codebase's doctrine of not trusting the model
  // to remember soft, un-timed asks) while leaving the actual phrasing to the
  // model, so it still reads as natural rather than a scripted extra message.
  const priorTurns = Math.floor(history.length / 2);

  let identity;
  if (ctx.requesterSlug) {
    identity = `The user is a known founder${ctx.requesterName ? ` named ${ctx.requesterName}` : ''} (slug: ${ctx.requesterSlug}).`;
  } else if (ctx.nameConfirmed) {
    identity = `The user is not yet linked to a founder profile. They told us their name is ${ctx.requesterName} - use it naturally.`;
  } else {
    const displayNameNote = ctx.requesterName
      ? `WhatsApp shows a display name of "${ctx.requesterName}" but that's just app metadata, not confirmed as their real name (could be a nickname, emoji, or business name) - don't treat it as confirmed and don't greet them with it.`
      : "We have no name for them at all.";
    if (priorTurns >= 2) {
      identity =
        `The user is not yet linked to a founder profile and still hasn't told us their name after ${priorTurns} replies. ${displayNameNote} ` +
        'Make asking for their name your ONE question THIS reply, phrased naturally (e.g. weave it into whatever you\'re already saying, "by the way, what should I call you?") - unless they just asked you something that genuinely needs a direct answer first, in which case answer that and ask next turn instead. Once they answer, call set_self_profile({name}) and don\'t ask again this conversation.';
    } else {
      identity =
        `The user is not yet linked to a founder profile and hasn't told us their name yet. ${displayNameNote} ` +
        'No need to ask this turn - focus on what they actually asked. Once they tell you their name (now or later), call set_self_profile({name}).';
    }
  }
  const messages = [
    { role: 'system', content: systemPrompt() },
    { role: 'system', content: identity },
  ];
  if (input.focus) {
    messages.push({
      role: 'system',
      content:
        'FOCUS - the founder the user is currently viewing. Answer any question about them using ONLY these facts; never invent a sector, skill, stage, or startup detail. If a field is null/empty, say you don\'t have that detail.\n' +
        JSON.stringify(input.focus),
    });
  }
  if (input.self && Object.keys(input.self).length) {
    messages.push({
      role: 'system',
      content:
        "KNOWN ABOUT THE USER (their OWN background - use this for cofounder complementarity and do NOT ask for it again): " +
        JSON.stringify(input.self),
    });
  }
  if (input.mentionNote) {
    // Deterministic person-entity grounding (handler.buildEntityGrounding):
    // pins names in THIS message to canonical people so the model never
    // substitutes a similar-sounding person from its summarized history.
    messages.push({ role: 'system', content: input.mentionNote });
  }
  messages.push(...history);
  if (history.length) {
    // Anti-echo (real observed failure): the model imitates the register of its
    // own recent replies far more than the distant system prompt, so ONE bad
    // deflection ("physics is outside our startup zone") seeds every following
    // answer. This sits AFTER the transcript so recency works for us, not
    // against us.
    messages.push({
      role: 'system',
      content:
        'REMINDER (overrides the transcript above): if any earlier reply of yours brushed off a general question, sounded scripted, or drifted from the rules, do NOT imitate it. Follow the system rules fresh each turn: answer general questions plainly, react like a person first.',
    });
  }
  // Deterministic backstop (real observed failure): "No show those profile
  // again" / "no show again" is a NEGATION - the user is refusing a repeat,
  // not asking for one - but the model read it as the literal opposite twice
  // in a row ("they're right above, tap any card") for the same user intent,
  // then flip-flopped to "you've seen them all" on the identical follow-up.
  // Don't trust the model to parse this negation unaided; flag it explicitly.
  if (/\b(no|don'?t|dont|stop)\b[^.!?]{0,30}\b(show|shw|send)(ing)?\b[^.!?]{0,30}\bagain\b/i.test(
    input.text || '',
  )) {
    messages.push({
      role: 'system',
      content:
        'NEGATION NOTE: the user\'s message is a NEGATION ("no, don\'t show X again") - they are refusing a repeat, NOT asking to see the same thing again. Do not respond as if they asked to re-view what\'s already on screen. If the pool is genuinely exhausted, say so plainly and consistently (offer to widen); if there are unseen candidates, show those instead. Never reply "they\'re right above, tap a card" to a message that says NOT to show it again.',
    });
  }
  if (input.safetyRecent) {
    // Sticky safety register: set for a couple of turns after the self-harm
    // guard fired (handler owns the counter). Keeps the tone gentle without
    // repeating the full helpline message every turn.
    messages.push({
      role: 'system',
      content:
        'SAFETY NOTE: this user very recently expressed thoughts of self-harm. Keep this reply gentle and unhurried: no chirpiness, no emoji, no exclamation marks, and no product offers unless they explicitly ask. If they hint at harm again, gently mention Tele-MANAS (14416, free, 24x7) without lecturing.',
    });
  }
  messages.push({ role: 'user', content: input.text || '' });

  // Every URL that legitimately surfaced this turn - the initial context
  // (focus/self/mentionNote/history) plus every tool result as it comes back
  // below. Feeds scrubUnverifiedUrls: the deterministic backstop for "URLS
  // ARE NEVER TYPED FROM MEMORY" (see guards.js for the live-reproduced
  // failure this closes - the model fabricating a plausible-looking LinkedIn
  // URL after a turn that ended on a pending disambiguation).
  const verifiedUrls = [];
  for (const m of messages) verifiedUrls.push(...extractUrls(m.content));

  let finalText = '';

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const completion = await openai().chat.completions.create({
      model: env.openai.model,
      temperature: 0.4,
      tools: definitions,
      tool_choice: 'auto',
      messages,
    });

    const msg = completion.choices?.[0]?.message;
    if (!msg) break;
    messages.push(msg);

    if (msg.tool_calls && msg.tool_calls.length) {
      for (const call of msg.tool_calls) {
        const name = call.function?.name;
        let args = {};
        try {
          args = JSON.parse(call.function?.arguments || '{}');
        } catch {
          args = {};
        }
        let result;
        try {
          result = impls[name] ? await impls[name](args, ctx) : { status: 'unknown_tool' };
        } catch (err) {
          log.error(`tool ${name} failed:`, err.message);
          result = { status: 'error', message: 'tool failed' };
        }
        verifiedUrls.push(...extractUrls(JSON.stringify(result)));
        // One observability line per turn: what the model extracted and what it got.
        // Lets us diagnose "the bot is dumb" from logs alone (wa, text, tool, filters, count).
        log.info(
          `turn wa=${ctx.waId || '?'} "${snippet(input.text)}" → ${name} ${JSON.stringify(args)} → ${toolResultSummary(result)}`,
        );
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(result),
        });
      }
      continue; // let the model react to tool results
    }

    finalText = scrubUnverifiedUrls((msg.content || '').trim(), verifiedUrls);
    log.info(`turn wa=${ctx.waId || '?'} "${snippet(input.text)}" → reply "${snippet(finalText)}"`);
    break;
  }

  return { outbox: ctx.outbox, finalText, state: ctx.state, assistantSummary: summarize(finalText, ctx.outbox) };
}

/** Collapse whitespace and clip for a single-line log entry. */
function snippet(s, n = 80) {
  s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/** Compact one-line summary of a tool result for logs. */
function toolResultSummary(r) {
  if (!r) return '∅';
  const parts = [r.status || 'ok'];
  if (r.count != null) parts.push(`count=${r.count}`);
  if (r.shown != null) parts.push(`shown=${r.shown}`);
  if (r.total != null) parts.push(`total=${r.total}`);
  if (r.poolSize != null) parts.push(`pool=${r.poolSize}`);
  if (Array.isArray(r.candidates)) parts.push(`candidates=${r.candidates.length}`);
  return parts.join(' ');
}

/**
 * One-line memory of what the assistant did this turn, so the next turn's
 * history conveys what was shown (lists/cards don't go through finalText).
 */
function summarize(finalText, outbox) {
  // What was already shown this turn, kept as the assistant's private memory so
  // the next turn can resolve "the first one" etc. Framed as an internal note
  // (no square brackets) and guarded by a prompt rule so the model never echoes it.
  const shown = [];
  for (const m of outbox) {
    if (m.kind === 'list') {
      const ids = (m.rows || []).map((r) => r.id || '');
      const titles = (m.rows || []).map((r) => r.title).slice(0, 8).join(', ');
      if (ids.some((id) => id.startsWith('area:'))) shown.push(`a list of mentor areas: ${titles}`);
      else if (ids.some((id) => id.startsWith('mentor:'))) shown.push(`a list of mentors: ${titles}`);
      else if (ids.some((id) => id.startsWith('perkcat:'))) shown.push(`a list of perk categories: ${titles}`);
      else if (ids.some((id) => id.startsWith('perk:'))) shown.push(`a list of perks: ${titles}`);
      else shown.push(`a list of founders: ${titles}`);
    } else if (m.kind === 'image') {
      shown.push(`the profile of ${String(m.caption || '').split('\n')[0].replace(/\*/g, '').trim()}`);
    } else if (m.kind === 'buttons') {
      shown.push('a follow-up prompt');
    } else if (m.kind === 'cta') {
      shown.push('a booking link');
    } else if (m.kind === 'text') {
      shown.push(m.body);
    }
  }
  const parts = [];
  if (shown.length) parts.push(`(internal note - already shown to the user: ${shown.join('; ')})`);
  if (finalText) parts.push(finalText);
  return parts.join(' ').slice(0, 600) || '(no reply)';
}

module.exports = { run };
