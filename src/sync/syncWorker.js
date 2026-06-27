'use strict';

const { supabase } = require('../config/supabase');
const { iterateListedUsers } = require('./sourceClient');
const { mapFounder } = require('./mapFounder');
const log = require('../lib/logger');

const UPSERT_BATCH = 200;

async function upsertBatch(rows) {
  if (!rows.length) return 0;
  // onConflict source_slug: only synced rows share these slugs, so native
  // origin='whatsapp' rows (distinct slugs) are never touched.
  const { error } = await supabase()
    .from('founders')
    .upsert(rows, { onConflict: 'source_slug' });
  if (error) throw new Error(`upsert failed: ${error.message}`);
  return rows.length;
}

/**
 * Pull every listed founder from the source and upsert into Supabase.
 * @param {{dryRun?:boolean}} opts
 */
async function runSync(opts = {}) {
  const dryRun = !!opts.dryRun;
  log.info(`sync starting${dryRun ? ' (dry run)' : ''}`);

  let runId = null;
  if (!dryRun) {
    const { data, error } = await supabase()
      .from('sync_runs')
      .insert({ status: 'running' })
      .select('id')
      .single();
    if (error) throw new Error(`could not open sync_run: ${error.message}`);
    runId = data.id;
  }

  const stats = { pages: 0, fetched: 0, upserted: 0, errors: [] };
  let batch = [];
  let lastPage = 0;

  try {
    for await (const { founder, page } of iterateListedUsers()) {
      if (page !== lastPage) {
        stats.pages += 1;
        lastPage = page;
      }
      stats.fetched += 1;
      if (!founder.slug) {
        stats.errors.push({ name: founder.name, message: 'missing slug, skipped' });
        continue;
      }
      batch.push(mapFounder(founder));
      if (batch.length >= UPSERT_BATCH) {
        if (!dryRun) stats.upserted += await upsertBatch(batch);
        batch = [];
      }
    }
    if (batch.length) {
      if (!dryRun) stats.upserted += await upsertBatch(batch);
      else stats.upserted += batch.length;
    }

    if (!dryRun) {
      await supabase()
        .from('sync_runs')
        .update({
          status: 'completed',
          pages: stats.pages,
          fetched: stats.fetched,
          upserted: stats.upserted,
          errors: stats.errors,
          finished_at: new Date().toISOString(),
        })
        .eq('id', runId);
    }

    log.info(
      `sync done - pages:${stats.pages} fetched:${stats.fetched} upserted:${stats.upserted} errors:${stats.errors.length}`,
    );
    return stats;
  } catch (err) {
    log.error('sync failed:', err.message);
    if (!dryRun && runId) {
      await supabase()
        .from('sync_runs')
        .update({
          status: 'failed',
          pages: stats.pages,
          fetched: stats.fetched,
          upserted: stats.upserted,
          errors: [...stats.errors, { message: err.message }],
          finished_at: new Date().toISOString(),
        })
        .eq('id', runId)
        .then(() => {}, () => {});
    }
    throw err;
  }
}

module.exports = { runSync };
