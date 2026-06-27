'use strict';

/* eslint-disable no-console */
/**
 * Seed / refresh the `sherpas` table from the canonical dataset in
 * src/domain/sherpas.data.js. Idempotent: upserts on `slug`, so re-running
 * updates existing mentors and adds new ones without duplicating.
 *
 *   node scripts/seed_sherpas.js
 *
 * Requires the `sherpas` table to exist (apply supabase/migrations/0004_sherpas.sql
 * first). If the table is missing, this prints the migration path and exits 1.
 */
require('dotenv').config();
const { supabase } = require('../src/config/supabase');
const { SHERPAS } = require('../src/domain/sherpas.data');

async function main() {
  const rows = SHERPAS.map((s) => ({
    slug: s.slug,
    name: s.name,
    expertise: s.expertise,
    areas: s.areas,
    booking_url: s.booking_url,
    booking_platform: s.booking_platform || null,
    linkedin_url: s.linkedin_url || null,
    avatar_url: s.avatar_url || null,
    bio: s.bio || null,
    is_active: s.is_active !== false,
    sort_order: Number.isInteger(s.sort_order) ? s.sort_order : 100,
  }));

  const { data, error } = await supabase()
    .from('sherpas')
    .upsert(rows, { onConflict: 'slug' })
    .select('slug');

  if (error) {
    console.error('Seed failed:', error.message);
    if (/relation .*sherpas.* does not exist|Could not find the table/i.test(error.message)) {
      console.error('\nThe sherpas table does not exist yet. Apply the migration first:');
      console.error('  supabase/migrations/0004_sherpas.sql');
      console.error('(paste it into the Supabase SQL editor, or run it via psql).');
    }
    process.exit(1);
  }

  console.log(`Seeded ${data.length} sherpas:`);
  for (const r of data) console.log('  •', r.slug);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
