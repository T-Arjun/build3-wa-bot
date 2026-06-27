'use strict';

const { openai } = require('../config/openai');
const { env } = require('../config/env');
const { systemPrompt } = require('./prompts');
const { definitions, impls } = require('./tools');
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
    self: input.self || null,
    prevMatchSlugs: input.prevMatchSlugs || [],
  };

  const identity = ctx.requesterSlug
    ? `The user is a known founder${ctx.requesterName ? ` named ${ctx.requesterName}` : ''} (slug: ${ctx.requesterSlug}).`
    : `The user is not yet linked to a founder profile${ctx.requesterName ? ` (WhatsApp name: ${ctx.requesterName})` : ''}.`;

  const history = Array.isArray(input.history) ? input.history : [];
  const messages = [
    { role: 'system', content: systemPrompt() },
    { role: 'system', content: identity },
  ];
  if (input.focus) {
    messages.push({
      role: 'system',
      content:
        'FOCUS — the founder the user is currently viewing. Answer any question about them using ONLY these facts; never invent a sector, skill, stage, or startup detail. If a field is null/empty, say you don\'t have that detail.\n' +
        JSON.stringify(input.focus),
    });
  }
  if (input.self && Object.keys(input.self).length) {
    messages.push({
      role: 'system',
      content:
        "KNOWN ABOUT THE USER (their OWN background — use this for cofounder complementarity and do NOT ask for it again): " +
        JSON.stringify(input.self),
    });
  }
  messages.push(...history, { role: 'user', content: input.text || '' });

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

    finalText = (msg.content || '').trim();
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
  if (r.soft) parts.push('soft');
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
      else if (ids.some((id) => id.startsWith('sherpa:'))) shown.push(`a list of mentors: ${titles}`);
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
  if (shown.length) parts.push(`(internal note — already shown to the user: ${shown.join('; ')})`);
  if (finalText) parts.push(finalText);
  return parts.join(' ').slice(0, 600) || '(no reply)';
}

module.exports = { run };
