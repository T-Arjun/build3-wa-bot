'use strict';

/* eslint-disable no-console */
/**
 * One-shot conversation driver for the REAL engine (live Supabase + OpenAI).
 * Threads state exactly like src/bot/handler.js. For experience testing.
 *
 * Usage:
 *   node scripts/convo.js '["hi","what can you do?"]'
 *   node scripts/convo.js --name Priya '["hey","find climate founders"]'
 * A turn of the form {"tap":"<founder-slug>"} simulates tapping a list row.
 */
require('dotenv').config();
const engine = require('../src/bot/engine');
const founders = require('../src/domain/founders');
const fmt = require('../src/bot/format');
const { untrackedNote } = require('../src/bot/guards');

// Same em/en-dash collapse the WhatsApp send layer applies (cloudApi.truncate),
// so transcripts show exactly what a user receives.
function sanitize(s) {
  return String(s == null ? '' : s).replace(/\s*[—–]\s*/g, ', ');
}

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
  if (state.sherpa_results) draft.sherpa_results = state.sherpa_results;
  else if (state.topic_changed || state.focus) delete draft.sherpa_results;
  return draft;
}

function renderOutbox(outbox) {
  return outbox
    .map((m) => {
      if (m.kind === 'list') return `  [LIST] ${m.body}\n` + (m.rows || []).map((r) => `      - ${r.title} | ${r.description || ''} (id=${r.id})`).join('\n');
      if (m.kind === 'image') return `  [CARD] ${String(m.caption || '').split('\n').join(' / ')}`;
      if (m.kind === 'buttons') return `  [BTNS] ${m.body} {${(m.buttons || []).map((b) => b.title).join(', ')}}`;
      if (m.kind === 'cta') return `  [CTA ] ${String(m.body || '').split('\n').join(' / ').slice(0, 200)} -> button "${m.title}" opens ${m.url}`;
      if (m.kind === 'text') return `  [TEXT] ${m.body}`;
      return `  [${m.kind}]`;
    })
    .join('\n');
}

(async () => {
  const argv = process.argv.slice(2);
  let name = 'Arjun';
  const ni = argv.indexOf('--name');
  if (ni !== -1) {
    name = argv[ni + 1];
    argv.splice(ni, 2);
  }
  let turns;
  try {
    turns = JSON.parse(argv[0] || '[]');
  } catch (e) {
    console.error('Pass turns as a JSON array, e.g. node scripts/convo.js \'["hi"]\'');
    process.exit(2);
  }

  let conv = { draft: {}, history: [] };
  for (const turn of turns) {
    if (turn && typeof turn === 'object' && turn.tap) {
      // Accept both a bare slug and the full row id ("profile:<slug>"), like routeReply does.
      const slug = String(turn.tap).replace(/^(profile|sherpa):/, '');
      const f = await founders.getBySlug(slug);
      if (f) {
        conv.draft = { ...conv.draft, focus: fmt.focusFields(f) };
        conv.history = [
          ...conv.history,
          { role: 'assistant', content: `(internal note - already shown to the user: the profile of ${f.name})` },
        ].slice(-10);
        console.log(`\nUSER: [taps list row: ${f.name}]`);
        console.log(`  [CARD] ${fmt.profileCaption(f).split('\n').join(' / ')}`);
      } else {
        console.log(`\nUSER: [taps ${slug}] -> NOT FOUND`);
      }
      continue;
    }
    const text = String(turn);
    console.log(`\nUSER: ${text}`);
    const started = Date.now();
    const { outbox, finalText, state, assistantSummary } = await engine.run({
      text,
      waId: 'convo-test',
      requesterSlug: null,
      requesterName: name,
      history: conv.history,
      focus: conv.draft?.focus || null,
      self: conv.draft?.self || null,
    });
    // Honesty backstop exactly like handler.js: untracked-attribute filters get
    // the disclaimer prepended if the model forgot it.
    let outText = finalText;
    const note = untrackedNote(text);
    if (note && !/don't (?:track|have)|can't filter/i.test(outText || '')) {
      outText = outText ? `${note}\n\n${outText}` : `${note} Here's what I do have:`;
    }
    if (outText) console.log(`BOT : ${sanitize(outText)}`);
    if (outbox.length) console.log(sanitize(renderOutbox(outbox)));
    if (!outbox.length && !finalText) console.log('  !! EMPTY REPLY');
    console.log(`  (took ${((Date.now() - started) / 1000).toFixed(1)}s)`);
    conv.history = [
      ...conv.history,
      { role: 'user', content: text },
      { role: 'assistant', content: assistantSummary || '(no reply)' },
    ].slice(-10);
    conv.draft = persistDraft(conv, state);
  }
  process.exit(0);
})().catch((e) => {
  console.error('CONVO CRASH:', e.message);
  process.exit(1);
});
