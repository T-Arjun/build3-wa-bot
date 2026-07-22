'use strict';

const { supabase } = require('../config/supabase');
const { PERKS } = require('./perks.data');
const { CATEGORY_KEYS, categoryLabel } = require('./perkCategories');
const log = require('../lib/logger');

/**
 * Startup-perk ("Perks & credits") directory queries. Source of truth is the
 * Supabase `perks` table; if it's missing or empty (e.g. migration not yet
 * applied), we fall back to the static seed in perks.data.js so the feature
 * works regardless. The pure helpers below hold the filtering/ranking logic and
 * are unit-tested directly against an in-memory array (no DB). Mirrors mentors.js.
 */

const COLUMNS =
  'slug,name,objective,categories,description,how_to_access,access_url,sort_order';

let warnedFallback = false;

/** All active perks, ordered. Reads the table; falls back to the static seed. */
async function loadAll() {
  try {
    const { data, error } = await supabase()
      .from('perks')
      .select(COLUMNS)
      .eq('is_active', true)
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true });
    if (error) throw error;
    if (data && data.length) return data;
  } catch (e) {
    if (!warnedFallback) {
      log.warn(`perks: using static seed (table unavailable: ${e.message})`);
      warnedFallback = true;
    }
  }
  return staticActive();
}

function staticActive() {
  return PERKS.filter((p) => p.is_active !== false).slice().sort(byOrder);
}

function byOrder(a, b) {
  const ao = Number.isInteger(a.sort_order) ? a.sort_order : 100;
  const bo = Number.isInteger(b.sort_order) ? b.sort_order : 100;
  return ao - bo || String(a.name).localeCompare(String(b.name));
}

// ─── Pure helpers (unit-tested directly) ─────────────────────────────────────

/** Categories that actually have ≥1 perk, in taxonomy order, with counts. */
function categoriesWithCounts(perks) {
  return CATEGORY_KEYS.map((key) => ({
    key,
    label: categoryLabel(key),
    count: perks.filter((p) => (p.categories || []).includes(key)).length,
  })).filter((c) => c.count > 0);
}

/** Active perks tagged with a category key, ordered. */
function filterByCategory(perks, categoryKey) {
  return perks.filter((p) => (p.categories || []).includes(categoryKey)).sort(byOrder);
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whole-word-ish containment check for a query token against free-text prose,
 * EXCLUDING the token's bare "-ed" past-participle continuation. Live-verified
 * failure this guards: a design-tool query's token "design" matched "a program
 * designED for startups" (AWS), "products designED to improve..." (Zendesk),
 * "tools designED to plan..." (Atlassian) - none of those are design tools,
 * the word is just being used as a generic "built/made for X" verb. The SAME
 * token still correctly matches "designING beautiful..." (Canva) and "graphic
 * design editor" (Creatosaurus), since only the specific "-ed" continuation is
 * excluded, not the word itself or its other legitimate forms (-ing/-er/-s).
 * This class of collision (a common English verb's past tense vs. an unrelated
 * product-category noun) isn't unique to "design" and will recur for other
 * tokens, so it's a general helper, not a one-off special case.
 */
function wordHit(haystack, token) {
  return new RegExp(`\\b${escapeRegex(token)}(?!ed\\b)`, 'i').test(haystack);
}

/**
 * Loose search for free-text ("any cloud credits?", "we need a CRM"). Scores
 * each perk by how many query tokens appear in its NAME, objective, description,
 * or category KEYS; a name/objective hit weighs more so "canva" resolves
 * cleanly. Returns matches best-first.
 *
 * Deliberately uses category KEYS ('sales'), not human-readable category
 * LABELS ('Sales & payments'), in the haystack: a compound label like that
 * grouping two related-but-distinct perk types for the picker (CRM tools +
 * payment gateways) would leak the word "payments" onto every perk merely
 * TAGGED sales - live-verified this: a bare "payments" query matched Zendesk
 * (a CRM, nothing to do with payments) purely because its category label
 * happened to contain the word. Keys are short, stable, and won't accidentally
 * contain an unrelated query term the way prose labels can.
 */
function matchByText(perks, text) {
  const tokens = String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
  if (!tokens.length) return [];
  const scored = perks
    .map((p) => {
      const name = String(p.name || '').toLowerCase();
      const strong = `${name} ${String(p.objective || '').toLowerCase()}`;
      const hay = `${p.description || ''} ${(p.categories || []).join(' ')}`.toLowerCase();
      const score = tokens.reduce(
        (n, t) => n + (wordHit(strong, t) ? 2 : 0) + (wordHit(hay, t) ? 1 : 0),
        0,
      );
      return { p, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || byOrder(a.p, b.p));
  return scored.map((x) => x.p);
}

// ─── Public async API ────────────────────────────────────────────────────────

async function listCategories() {
  return categoriesWithCounts(await loadAll());
}

/** All active perks (for deterministic grounding / the render audit). */
async function listAll() {
  return loadAll();
}

async function listByCategory(categoryKey) {
  return filterByCategory(await loadAll(), categoryKey);
}

async function getBySlug(slug) {
  const all = await loadAll();
  return all.find((p) => p.slug === slug) || null;
}

async function searchByText(text) {
  return matchByText(await loadAll(), text);
}

module.exports = {
  listCategories,
  listAll,
  listByCategory,
  getBySlug,
  searchByText,
  // pure helpers (exported for tests)
  categoriesWithCounts,
  filterByCategory,
  matchByText,
};
