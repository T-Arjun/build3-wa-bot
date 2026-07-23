'use strict';

const { supabase } = require('../config/supabase');
const { MENTORS } = require('./mentors.data');
const { AREA_KEYS, areaLabel } = require('./mentorAreas');
const { editDistance } = require('./geo');
const log = require('../lib/logger');

/**
 * Mentor directory queries. Source of truth is the Supabase `mentors`
 * table; if it's missing or empty (e.g. migration not yet applied), we fall back
 * to the static seed in mentors.data.js so the feature works regardless. The
 * pure helpers below hold the filtering/ranking logic and are unit-tested
 * directly against an in-memory array (no DB).
 */

const COLUMNS =
  'slug,name,expertise,areas,booking_url,booking_platform,linkedin_url,avatar_url,bio,sort_order';

let warnedFallback = false;

/** All active mentors, ordered. Reads the table; falls back to the static seed. */
async function loadAll() {
  try {
    const { data, error } = await supabase()
      .from('mentors')
      .select(COLUMNS)
      .eq('is_active', true)
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true });
    if (error) throw error;
    if (data && data.length) return data;
  } catch (e) {
    if (!warnedFallback) {
      log.warn(`mentors: using static seed (table unavailable: ${e.message})`);
      warnedFallback = true;
    }
  }
  return staticActive();
}

function staticActive() {
  return MENTORS.filter((s) => s.is_active !== false).slice().sort(byOrder);
}

function byOrder(a, b) {
  const ao = Number.isInteger(a.sort_order) ? a.sort_order : 100;
  const bo = Number.isInteger(b.sort_order) ? b.sort_order : 100;
  return ao - bo || String(a.name).localeCompare(String(b.name));
}

// ─── Pure helpers (unit-tested directly) ─────────────────────────────────────

/** Expertise areas that actually have ≥1 mentor, in taxonomy order, with counts. */
function areasWithCounts(mentors) {
  return AREA_KEYS.map((key) => ({
    key,
    label: areaLabel(key),
    count: mentors.filter((s) => (s.areas || []).includes(key)).length,
  })).filter((a) => a.count > 0);
}

/** Active mentors tagged with an area key, ordered. */
function filterByArea(mentors, areaKey) {
  return mentors.filter((s) => (s.areas || []).includes(areaKey)).sort(byOrder);
}

/**
 * Loose search for free-text ("who can help with pricing?"), the proactive path,
 * AND explicit by-name booking ("book varun"). Scores each mentor by how many
 * query tokens appear in their NAME, expertise blurb, or area labels; a name hit
 * weighs more so "book varun" resolves to that mentor. Returns matches best-first.
 */
function matchByExpertise(mentors, text) {
  const tokens = String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
  if (!tokens.length) return [];
  const scored = mentors
    .map((s) => {
      const name = String(s.name || '').toLowerCase();
      const hay = `${s.expertise} ${(s.areas || []).map(areaLabel).join(' ')} ${(s.areas || []).join(' ')}`.toLowerCase();
      const score = tokens.reduce(
        (n, t) => n + (name.includes(t) ? 2 : 0) + (hay.includes(t) ? 1 : 0),
        0,
      );
      return { s, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || byOrder(a.s, b.s));
  return scored.map((x) => x.s);
}

// ─── Public async API ────────────────────────────────────────────────────────

async function listAreas() {
  return areasWithCounts(await loadAll());
}

/** All active mentors (for deterministic name grounding in the engine). */
async function listAll() {
  return loadAll();
}

async function listByArea(areaKey) {
  return filterByArea(await loadAll(), areaKey);
}

async function getBySlug(slug) {
  const all = await loadAll();
  return all.find((s) => s.slug === slug) || null;
}

async function searchByExpertise(text) {
  return matchByExpertise(await loadAll(), text);
}

module.exports = {
  listAreas,
  listAll,
  listByArea,
  getBySlug,
  searchByExpertise,
  // pure helpers (exported for tests)
  areasWithCounts,
  filterByArea,
  matchByExpertise,
};
