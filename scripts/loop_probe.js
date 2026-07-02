'use strict';

/* eslint-disable no-console */
/**
 * Loop-engineering probe: drives the REAL engine (live Supabase + OpenAI) with
 * conversations that test BREADTH - does the bot behave like a community
 * connector (search, profiles, mentors, general help) or does it collapse
 * everything into cofounder matching / a search box?
 * Run: node scripts/loop_probe.js [scenario#...]
 */
require('dotenv').config();
const engine = require('../src/bot/engine');

function persistDraft(conv, state) {
  const draft = { ...(conv.draft || {}) };
  draft.intro_sent = true;
  if (state.self) draft.self = state.self;
  if (state.match_cache) draft.match_cache = state.match_cache;
  if (state.focus) {
    draft.focus = state.focus;
    delete draft.match_cache;
  } else if (state.topic_changed) {
    delete draft.focus;
  }
  return draft;
}

function renderOutbox(outbox) {
  return outbox
    .map((m) => {
      if (m.kind === 'list') return `  [LIST] ${m.body}\n` + (m.rows || []).map((r) => `      - ${r.title} | ${r.description || ''}`).join('\n');
      if (m.kind === 'image') return `  [CARD] ${String(m.caption || '').split('\n').join(' / ').slice(0, 140)}`;
      if (m.kind === 'buttons') return `  [BTNS] ${m.body} {${(m.buttons || []).map((b) => b.title).join(', ')}}`;
      if (m.kind === 'cta') return `  [CTA ] ${String(m.body || '').split('\n')[0]} -> ${m.title}`;
      if (m.kind === 'text') return `  [TEXT] ${m.body}`;
      return `  [${m.kind}]`;
    })
    .join('\n');
}

async function runConvo(title, turns, opts = {}) {
  console.log(`\n${'='.repeat(78)}\nSCENARIO: ${title}\n${'='.repeat(78)}`);
  let conv = { draft: {}, history: [] };
  for (const text of turns) {
    console.log(`\nUSER: ${text}`);
    const { outbox, finalText, state, assistantSummary } = await engine.run({
      text,
      waId: 'probe',
      requesterSlug: opts.requesterSlug || null,
      requesterName: opts.requesterName || 'Arjun',
      history: conv.history,
      focus: conv.draft?.focus || null,
      self: conv.draft?.self || null,
    });
    if (finalText) console.log(`BOT : ${finalText}`);
    if (outbox.length) console.log(renderOutbox(outbox));
    if (!outbox.length && !finalText) console.log('   !! EMPTY REPLY');
    conv.history = [
      ...conv.history,
      { role: 'user', content: text },
      { role: 'assistant', content: assistantSummary || '(no reply)' },
    ].slice(-10);
    conv.draft = persistDraft(conv, state);
  }
}

const SCENARIOS = [
  ['1. Cold open - what does the bot say it is', ['hi']],
  ['2. Capability question - must cover ALL functions, not just cofounders', ['what can you do?']],
  ['3. Vague struggle - should converse, then route (mentor or people), not force matching', ["honestly I'm a bit stuck with my startup"]],
  ['4. General community question', ['what is build3?', 'how do I join the community?']],
  ['5. Problem ask - pricing (mentor territory, not cofounder)', ['I have no idea how to price my product']],
  ['6. Directory browse - must NOT become find_cofounders', ['who else is building in climate?']],
  ['7. Casual chat + gratitude - should feel human', ['that was helpful, thanks man'], {}],
  ['8. Ambition share - conversation first', ["we just crossed 100 users, feels good"]],
  ['9. Fundraise help', ['I need to raise a pre-seed round, where do I start?']],
  ['10. Intro-ish ask (honesty check)', ['can you introduce me to someone who knows D2C?']],
  ['11. Multi-need turn', ["I'm looking for a designer cofounder but also need advice on GTM"]],
  ['12. Off-topic', ["what's the weather in Goa?"]],
  ['13. Multi-turn depth - no re-intro, no re-pitch, context carries', [
    'hey',
    "building a healthtech app for diabetics, early days",
    "yeah user acquisition mostly, we're pre-launch",
    'ok show me the mentors',
    'thanks, this is great',
  ]],
];

(async () => {
  const pick = process.argv.slice(2).map(Number);
  for (let i = 0; i < SCENARIOS.length; i++) {
    if (pick.length && !pick.includes(i + 1)) continue;
    const [title, turns, opts] = SCENARIOS[i];
    await runConvo(title, turns, opts || {});
  }
  console.log('\nDONE.');
  process.exit(0);
})().catch((e) => {
  console.error('PROBE CRASH:', e);
  process.exit(1);
});
