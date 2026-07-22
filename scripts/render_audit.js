'use strict';

/* eslint-disable no-console */
/**
 * Render audit: run EVERY founder + mentor through EVERY user-facing render
 * surface and flag broken output. This is the "how does it actually look"
 * regression net: placeholder junk, empty fields leaking, over-limit strings
 * WhatsApp will truncate, ugly separators, dangling labels.
 *
 *   node scripts/render_audit.js            # audit everything, print defects
 *   node scripts/render_audit.js --show 12  # also render N sample cards
 */
require('dotenv').config();
const { supabase } = require('../src/config/supabase');
const fmt = require('../src/bot/format');
const { MENTORS } = require('../src/domain/mentors.data');
const { PERKS } = require('../src/domain/perks.data');
const { lookingForStatus } = require('../src/domain/matching');

const WA_LIMITS = { rowTitle: 24, rowDesc: 72, caption: 1024, body: 1024 };
const JUNK = /\b(undefined|null|NaN)\b|\*\s*\*|(^|\s)(na|n\/a|tbd)(\s|$|\.)/i;

const defects = [];
function flag(surface, who, issue, sample) {
  defects.push({ surface, who, issue, sample: String(sample).slice(0, 110) });
}

function auditRow(f) {
  const row = fmt.toRow(f);
  if (!row.title || !row.title.trim()) flag('row.title', f.source_slug, 'empty title', JSON.stringify(row));
  if (row.title && row.title.length > WA_LIMITS.rowTitle) flag('row.title', f.source_slug, `>${WA_LIMITS.rowTitle} chars (WA truncates)`, row.title);
  if (!row.description || !row.description.trim()) flag('row.desc', f.source_slug, 'EMPTY description (blank row line)', row.title);
  if (row.description && row.description.length > WA_LIMITS.rowDesc) flag('row.desc', f.source_slug, `>${WA_LIMITS.rowDesc} chars (WA truncates)`, row.description);
  if (row.description && JUNK.test(row.description)) flag('row.desc', f.source_slug, 'placeholder junk', row.description);
  if (row.description && /(^|\s)·|·(\s*·)|·\s*$/.test(row.description.replace(/\S · \S/g, 'x'))) flag('row.desc', f.source_slug, 'dangling separator', row.description);
}

function auditAvatar(f) {
  const url = fmt.avatarFor(f);
  // WhatsApp drops SVG images silently (tap looks dead). The card image must be
  // a raster format or our PNG placeholder.
  if (/\.svg(\?|#|$)/i.test(url) || (/ui-avatars\.com/i.test(url) && !/format=png/i.test(url))) {
    flag('avatar', f.source_slug, 'SVG/non-PNG image (WhatsApp drops it, tap dies)', url);
  }
}

function auditProfile(f) {
  const cap = fmt.profileCaption(f);
  const lines = cap.split('\n');
  if (cap.length > WA_LIMITS.caption) flag('profile', f.source_slug, `caption >${WA_LIMITS.caption} (WA truncates tail incl. LinkedIn)`, `${cap.length} chars`);
  for (const l of lines) {
    if (JUNK.test(l)) flag('profile', f.source_slug, 'placeholder junk in line', l);
    if (/^(Stage|Skills|Open to|Archetype):\s*$/.test(l)) flag('profile', f.source_slug, 'dangling empty label', l);
    if (/·\s*·|^\s*·|·\s*$/.test(l)) flag('profile', f.source_slug, 'dangling separator', l);
  }
  if (lines.length < 2 || !lines[1].trim()) flag('profile', f.source_slug, 'no meta line under the name (card looks bare)', lines.join(' / ').slice(0, 80));
}

function auditMatch(f) {
  // Exercise the real per-candidate cofounder-intent line against every
  // founder's ACTUAL looking_for value, not a stubbed one - this is the one
  // surface where a raw founder row doesn't already carry the computed field
  // (matching.js only computes it inside parseMatchResults), so it must be
  // derived here or this audit silently never touches the new line at all.
  const cap = fmt.matchCaption({ ...f, score: 80, reasons: ['x'], lookingForStatus: lookingForStatus(f.looking_for) });
  if (JUNK.test(cap)) flag('match', f.source_slug, 'placeholder junk', cap.split('\n').find((l) => JUNK.test(l)));
  const statusLine = cap.split('\n').find((l) => l.startsWith('('));
  if (!statusLine) flag('match', f.source_slug, 'missing cofounder-intent status line', cap.slice(0, 80));
}

function auditMentor(s) {
  const card = fmt.mentorCard(s);
  if (JUNK.test(card)) flag('mentorCard', s.slug, 'placeholder junk', card);
  const row = fmt.mentorRow(s);
  if (row.title.length > WA_LIMITS.rowTitle) flag('mentorRow', s.slug, `title >${WA_LIMITS.rowTitle}`, row.title);
  if (!row.description) flag('mentorRow', s.slug, 'empty description', row.title);
}

function auditPerk(p) {
  // Overview message (name/objective/trimmed description) - must fit the body cap.
  const card = fmt.perkCard(p);
  if (JUNK.test(card)) flag('perkCard', p.slug, 'placeholder junk', (card.split('\n').find((l) => JUNK.test(l)) || card).slice(0, 110));
  if (card.length > WA_LIMITS.body) flag('perkCard', p.slug, `overview >${WA_LIMITS.body} chars`, `${card.length} chars`);
  // How-to-access message (the actionable part) - separate message, must fit the
  // cap AND carry the real steps in full (source text is authored to fit; a
  // truncation here means an entry needs tightening, like Microsoft did).
  const access = fmt.perkAccess(p);
  if (!access) flag('perkAccess', p.slug, 'empty how-to-access (nothing actionable)', p.name);
  if (access.length > WA_LIMITS.body) flag('perkAccess', p.slug, `how-to-access >${WA_LIMITS.body} chars (WA truncates the tail)`, `${access.length} chars`);
  if (p.how_to_access && !access.includes(p.how_to_access.trim())) flag('perkAccess', p.slug, 'how-to-access got truncated - tighten the source entry', `${p.how_to_access.length} chars`);
  const row = fmt.perkRow(p);
  if (row.title.length > WA_LIMITS.rowTitle) flag('perkRow', p.slug, `title >${WA_LIMITS.rowTitle}`, row.title);
  if (!row.description) flag('perkRow', p.slug, 'empty description', row.title);
}

(async () => {
  const { data: founders, error } = await supabase()
    .from('founders')
    .select('*')
    .eq('is_published', true);
  if (error) throw new Error(error.message);

  for (const f of founders) {
    auditRow(f);
    auditProfile(f);
    auditMatch(f);
    auditAvatar(f);
  }
  for (const s of MENTORS) auditMentor(s);
  for (const p of PERKS) auditPerk(p);

  // Summary
  console.log(`audited ${founders.length} founders x 3 surfaces + ${MENTORS.length} mentors + ${PERKS.length} perks`);
  if (!defects.length) {
    console.log('NO DEFECTS 🎉');
  } else {
    const bySurface = {};
    for (const d of defects) (bySurface[`${d.surface} | ${d.issue}`] = bySurface[`${d.surface} | ${d.issue}`] || []).push(d);
    console.log(`\n${defects.length} defects in ${Object.keys(bySurface).length} classes:\n`);
    for (const [k, arr] of Object.entries(bySurface).sort((a, b) => b[1].length - a[1].length)) {
      console.log(`[${arr.length}x] ${k}`);
      for (const d of arr.slice(0, 3)) console.log(`     ${d.who}: ${d.sample}`);
      if (arr.length > 3) console.log(`     ... +${arr.length - 3} more`);
    }
  }

  // Optional visual sample
  const si = process.argv.indexOf('--show');
  if (si !== -1) {
    const n = parseInt(process.argv[si + 1], 10) || 8;
    console.log('\n================ SAMPLE CARDS ================');
    for (const f of founders.slice(0, n)) {
      console.log('\n--- ' + f.source_slug + ' (row) ---');
      const r = fmt.toRow(f);
      console.log(`  ${r.title}\n  ${r.description}`);
      console.log('--- (profile) ---');
      console.log(fmt.profileCaption(f).split('\n').map((l) => '  ' + l).join('\n'));
    }
  }
  process.exit(0);
})().catch((e) => {
  console.error('AUDIT CRASH:', e);
  process.exit(1);
});
