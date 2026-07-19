'use strict';

const { env } = require('../config/env');

/**
 * Read-only client for the source platform's public API.
 * We ONLY ever call GET endpoints - the source is never mutated.
 */

function authHeaders() {
  return {
    'X-API-Key': env.source.apiKey,
    Accept: 'application/json',
  };
}

/**
 * Fetch one page of listed (published) founders.
 * Mirrors GET /api/v1/getListedUsers - see source routes/api.js.
 * @returns {Promise<{page:number,limit:number,total:number,totalPages:number,data:object[]}>}
 */
async function getListedUsersPage(page = 1, limit = 200) {
  if (!env.source.apiBase) throw new Error('SOURCE_API_BASE not configured');
  if (!env.source.apiKey) throw new Error('SOURCE_API_KEY not configured');

  const url = `${env.source.apiBase}/api/v1/getListedUsers?page=${page}&limit=${limit}`;
  const res = await fetch(url, { headers: authHeaders() });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`getListedUsers ${page} failed (${res.status}): ${body.slice(0, 300)}`);
  }

  const json = await res.json();
  if (!json || json.success !== true || !Array.isArray(json.data)) {
    throw new Error(`getListedUsers ${page} returned unexpected shape`);
  }
  return json;
}

// Sanity bound on pagination (200,000 founders at the default page size - two
// orders of magnitude past any realistic scale for this directory today).
// Without this, a bug on the source side (a wrong totalPages) makes this loop
// run forever: schedule.js's overlap guard is a plain boolean with no timeout,
// so a single sync that never terminates silently disables every future
// scheduled sync (just a log.warn, no alert) until a manual process restart.
// Fails loudly instead - runSync's existing try/catch already marks the run
// 'failed' and schedule.js's finally block already resets the running flag,
// so this is the one thing needed to turn "hangs forever" into "errors cleanly".
const MAX_PAGES = 1000;

/**
 * Async generator yielding every listed founder across all pages.
 */
async function* iterateListedUsers(limit = 200) {
  let page = 1;
  let totalPages = 1;
  do {
    if (page > MAX_PAGES) {
      throw new Error(`iterateListedUsers: exceeded ${MAX_PAGES} pages (totalPages=${totalPages}) - aborting, likely a source API pagination bug`);
    }
    const res = await getListedUsersPage(page, limit);
    totalPages = res.totalPages || 1;
    for (const founder of res.data) yield { founder, page };
    page += 1;
  } while (page <= totalPages);
}

module.exports = { getListedUsersPage, iterateListedUsers };
