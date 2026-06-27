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

/**
 * Async generator yielding every listed founder across all pages.
 */
async function* iterateListedUsers(limit = 200) {
  let page = 1;
  let totalPages = 1;
  do {
    const res = await getListedUsersPage(page, limit);
    totalPages = res.totalPages || 1;
    for (const founder of res.data) yield { founder, page };
    page += 1;
  } while (page <= totalPages);
}

module.exports = { getListedUsersPage, iterateListedUsers };
