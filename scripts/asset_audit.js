'use strict';

/* eslint-disable no-console */
/**
 * DELIVERY-LAYER audit: the test every prior pass skipped. Instead of checking
 * the engine's output objects, this actually HITS every asset URL the bot would
 * send - founder + mentor avatars, and mentor booking links - and verifies each
 * is reachable AND a format WhatsApp will render. WhatsApp image messages accept
 * jpeg/png/webp only; it accepts an SVG (200) then silently drops it, so the
 * card never arrives (the "tap -> typing -> dead" bug).
 *
 *   node scripts/asset_audit.js
 */
require('dotenv').config();
const { supabase } = require('../src/config/supabase');
const fmt = require('../src/bot/format');
const { MENTORS } = require('../src/domain/mentors.data');

const OK_IMAGE = /^image\/(jpeg|jpg|png|webp)/i;
const CONCURRENCY = 12;

async function check(url, attempt = 0) {
  try {
    const res = await fetch(url, { redirect: 'follow' });
    const ct = (res.headers.get('content-type') || '').split(';')[0].trim();
    return { url, status: res.status, ct };
  } catch (e) {
    if (attempt < 2) return check(url, attempt + 1); // retry transient network flakes
    return { url, status: 0, ct: `FETCH_ERR ${e.message}` };
  }
}

async function pool(items, fn) {
  const out = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx], idx);
      }
    }),
  );
  return out;
}

(async () => {
  const { data: founders, error } = await supabase()
    .from('founders')
    .select('source_slug,name,avatar_url')
    .eq('is_published', true);
  if (error) throw new Error(error.message);

  // 1) Founder avatars (what pushProfile actually sends)
  const avatarTargets = founders.map((f) => ({ who: f.source_slug, url: fmt.avatarFor(f), kind: 'avatar' }));
  // 2) Mentor avatars + booking links
  for (const s of MENTORS) {
    avatarTargets.push({ who: `mentor:${s.slug}`, url: fmt.avatarFor(s), kind: 'avatar' });
    avatarTargets.push({ who: `mentor:${s.slug}`, url: s.booking_url, kind: 'booking' });
  }

  console.log(`checking ${avatarTargets.length} live asset URLs (avatars + booking links)...`);
  const results = await pool(avatarTargets, async (t) => ({ ...t, ...(await check(t.url)) }));

  const bad = results.filter((r) => {
    if (r.kind === 'avatar') return r.status !== 200 || !OK_IMAGE.test(r.ct); // must be a renderable image
    return r.status >= 400 || r.status === 0; // booking link must at least resolve
  });

  const ctCounts = {};
  for (const r of results.filter((r) => r.kind === 'avatar')) ctCounts[r.ct] = (ctCounts[r.ct] || 0) + 1;
  console.log('\navatar content-types:', JSON.stringify(ctCounts));

  if (!bad.length) {
    console.log('\nALL ASSETS DELIVERABLE 🎉');
  } else {
    console.log(`\n${bad.length} UNDELIVERABLE assets:\n`);
    for (const r of bad.slice(0, 40)) console.log(`  [${r.kind}] ${r.who}: ${r.status} ${r.ct}  ${r.url.slice(0, 70)}`);
    if (bad.length > 40) console.log(`  ... +${bad.length - 40} more`);
    process.exitCode = 1;
  }
  process.exit(process.exitCode || 0);
})().catch((e) => {
  console.error('ASSET AUDIT CRASH:', e);
  process.exit(1);
});
