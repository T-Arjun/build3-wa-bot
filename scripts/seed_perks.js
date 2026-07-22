'use strict';

/* eslint-disable no-console */
/**
 * Seed / refresh the `perks` table from the canonical dataset in
 * src/domain/perks.data.js. Idempotent: upserts on `slug`, so re-running
 * updates existing perks and adds new ones without duplicating.
 *
 *   node scripts/seed_perks.js
 *
 * Requires the `perks` table to exist (apply supabase/migrations/0009_perks.sql
 * first). If the table is missing, this prints the migration path and exits 1.
 */
require('dotenv').config();
const { supabase } = require('../src/config/supabase');
const { PERKS } = require('../src/domain/perks.data');

async function main() {
  const rows = PERKS.map((p) => ({
    slug: p.slug,
    name: p.name,
    objective: p.objective,
    categories: p.categories || [],
    description: p.description || null,
    how_to_access: p.how_to_access,
    access_url: p.access_url || null,
    is_active: p.is_active !== false,
    sort_order: Number.isInteger(p.sort_order) ? p.sort_order : 100,
  }));

  const { data, error } = await supabase()
    .from('perks')
    .upsert(rows, { onConflict: 'slug' })
    .select('slug');

  if (error) {
    console.error('Seed failed:', error.message);
    if (/relation .*perks.* does not exist|Could not find the table/i.test(error.message)) {
      console.error('\nThe perks table does not exist yet. Apply the migration first:');
      console.error('  supabase/migrations/0009_perks.sql');
      console.error('(paste it into the Supabase SQL editor, or run it via psql).');
    }
    process.exit(1);
  }

  console.log(`Seeded ${data.length} perks:`);
  for (const r of data) console.log('  •', r.slug);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
