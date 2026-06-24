'use strict';

/* eslint-disable no-console */
/**
 * Local stress harness — drives the REAL engine against live Supabase + OpenAI,
 * threading conversation state exactly like src/bot/handler.js does. Not a CI
 * test (hits paid APIs). Run: node scripts/sim.js
 */
require('dotenv').config();
const engine = require('../src/bot/engine');
const founders = require('../src/domain/founders');
const fmt = require('../src/bot/format');

const MATCH_PAGE = 3;

// Mirror of handler.persistDraft so the sim threads state identically.
function persistDraft(conv, state) {
  const draft = { ...(conv.draft || {}) };
  draft.intro_sent = true;
  if (state.self) draft.self = state.self;
  if (state.match_cache) {
    draft.match_cache = state.match_cache;
    draft.match_offset = MATCH_PAGE;
  }
  if (state.focus) {
    draft.focus = state.focus;
    delete draft.match_cache;
    delete draft.match_offset;
  } else if (state.topic_changed) {
    delete draft.focus;
  }
  return draft;
}

function renderOutbox(outbox) {
  return outbox
    .map((m) => {
      if (m.kind === 'list') return `  [LIST] ${m.body}\n` + m.rows.map((r) => `      • ${r.title} — ${r.description || ''}`).join('\n');
      if (m.kind === 'image') return `  [CARD] ${String(m.caption || '').split('\n').join(' / ')}`;
      if (m.kind === 'buttons') return `  [BTNS] ${m.body} {${(m.buttons || []).map((b) => b.title).join(', ')}}`;
      if (m.kind === 'text') return `  [TEXT] ${m.body}`;
      return `  [${m.kind}]`;
    })
    .join('\n');
}

async function runConvo(title, turns, opts = {}) {
  console.log(`\n${'='.repeat(78)}\nSCENARIO: ${title}\n${'='.repeat(78)}`);
  const waId = opts.waId || '910000000000';
  let conv = { draft: {}, history: [] };
  for (const turn of turns) {
    if (typeof turn === 'object' && turn.tap) {
      // Simulate an interactive row tap (handler.routeReply profile: path).
      const f = await founders.getBySlug(turn.tap);
      conv.draft = { ...conv.draft, focus: f ? fmt.focusFields(f) : undefined };
      conv.history = [...conv.history, { role: 'assistant', content: `[showed profile: ${f ? f.name : '??'}]` }].slice(-10);
      console.log(`\n👆 TAP ${turn.tap} → focus=${f ? f.name : 'NOT FOUND'}`);
      continue;
    }
    const text = turn;
    console.log(`\n👤 ${text}`);
    const { outbox, finalText, state, assistantSummary } = await engine.run({
      text,
      waId,
      requesterSlug: opts.requesterSlug || null,
      requesterName: opts.requesterName || null,
      history: conv.history,
      focus: conv.draft?.focus || null,
      self: conv.draft?.self || null,
    });
    if (outbox.length) console.log(renderOutbox(outbox));
    if (finalText) console.log(`🤖 ${finalText}`);
    // Thread state like the handler.
    conv.history = [
      ...conv.history,
      { role: 'user', content: text },
      { role: 'assistant', content: assistantSummary || '(no reply)' },
    ].slice(-10);
    conv.draft = persistDraft(conv, state);
    // Surface what persisted, for inspection.
    const dbg = [];
    if (conv.draft.focus) dbg.push(`focus=${conv.draft.focus.name}`);
    if (conv.draft.self) dbg.push(`self=${JSON.stringify(conv.draft.self)}`);
    if (conv.draft.match_cache) dbg.push(`match_cache=${conv.draft.match_cache.length}`);
    if (dbg.length) console.log(`   ⤷ state: ${dbg.join('  ')}`);
    if (!outbox.length && !finalText) console.log('   ⚠️  EMPTY REPLY (no outbox, no text)');
  }
}

(async () => {
  await runConvo('1. Location search (Kerala — historically returned 2, expect ~12)', [
    'find me founders from kerala',
  ]);

  await runConvo('2. Profile + dedup (Umair — historically showed duplicate)', [
    "show me umair's profile",
  ]);

  await runConvo('3. Self-profile personalization (technical → wants sales cofounder)', [
    "I'm a technical founder, find me a sales cofounder in Bangalore",
    'find me another cofounder', // should still treat me as technical, no re-ask
  ]);

  // Grab a real founder to drive the FOCUS test deterministically.
  const sample = (await founders.searchFounders({ sector: 'Financial Services' }, 1))[0];
  if (sample) {
    await runConvo(`4. FOCUS grounding + topic change clears it (focus: ${sample.name})`, [
      { tap: sample.source_slug },
      'what sector are they in?', // must answer from FOCUS, no hallucination
      'find me fintech founders', // topic change → focus must clear
      'and what about their skills?', // focus is gone now — must NOT answer about sample
    ]);
  }

  await runConvo('5. Vague cofounder → ask once; then "anyone" → proceed', [
    'find me a cofounder',
    'anyone',
  ]);

  await runConvo('6. Fresh start — greeting must not resurface old question', [
    'show me priya', // likely ambiguous → asks which
    'hello', // must NOT re-ask about Priya
  ]);

  await runConvo('7. Skills OR (sales or marketing) + nonsense input', [
    'find founders who do sales or marketing',
    'asdkjfh qwfqwf', // gibberish
  ]);

  await runConvo('8. Unmapped location (should not crash, may return few)', [
    'find founders from Timbuktu',
  ]);

  console.log('\n\nDONE.');
  process.exit(0);
})().catch((e) => {
  console.error('SIM CRASH:', e);
  process.exit(1);
});
