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
    requesterSlug: input.requesterSlug || null,
    requesterName: input.requesterName || null,
  };

  const identity = ctx.requesterSlug
    ? `The user is a known founder${ctx.requesterName ? ` named ${ctx.requesterName}` : ''} (slug: ${ctx.requesterSlug}).`
    : `The user is not yet linked to a founder profile${ctx.requesterName ? ` (WhatsApp name: ${ctx.requesterName})` : ''}.`;

  const messages = [
    { role: 'system', content: systemPrompt() },
    { role: 'system', content: identity },
    { role: 'user', content: input.text || '' },
  ];

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
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(result),
        });
      }
      continue; // let the model react to tool results
    }

    finalText = (msg.content || '').trim();
    break;
  }

  return { outbox: ctx.outbox, finalText, state: ctx.state };
}

module.exports = { run };
