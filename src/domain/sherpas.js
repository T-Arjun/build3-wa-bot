'use strict';

const { supabase } = require('../config/supabase');
const { SHERPAS } = require('./sherpas.data');
const { AREA_KEYS, areaLabel } = require('./sherpaAreas');
const log = require('../lib/logger');

/**
 * Mentor ("Sherpa") directory queries. Source of truth is the Supabase `sherpas`
 * table; if it's missing or empty (e.g. migration not yet applied), we fall back
 * to the static seed in sherpas.data.js so the feature works regardless. The
 * pure helpers below hold the filtering/ranking logic and are unit-tested
 * directly against an in-memory array (no DB).
 */

const COLUMNS =
  'slug,name,expertise,areas,booking_url,booking_platform,linkedin_url,avatar_url,bio,sort_order';

let warnedFallback = false;

/** All active sherpas, ordered. Reads the table; falls back to the static seed. */
async function loadAll() {
  try {
    const { data, error } = await supabase()
      .from('sherpas')
      .select(COLUMNS)
      .eq('is_active', true)
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true });
    if (error) throw error;
    if (data && data.length) return data;
  } catch (e) {
    if (!warnedFallback) {
      log.warn(`sherpas: using static seed (table unavailable: ${e.message})`);
      warnedFallback = true;
    }
  }
  return staticActive();
}

function staticActive() {
  return SHERPAS.filter((s) => s.is_active !== false).slice().sort(byOrder);
}

function byOrder(a, b) {
  const ao = Number.isInteger(a.sort_order) ? a.sort_order : 100;
  const bo = Number.isInteger(b.sort_order) ? b.sort_order : 100;
  return ao - bo || String(a.name).localeCompare(String(b.name));
}

// ─── Pure helpers (unit-tested directly) ─────────────────────────────────────

/** Expertise areas that actually have ≥1 sherpa, in taxonomy order, with counts. */
function areasWithCounts(sherpas) {
  return AREA_KEYS.map((key) => ({
    key,
    label: areaLabel(key),
    count: sherpas.filter((s) => (s.areas || []).includes(key)).length,
  })).filter((a) => a.count > 0);
}

/** Active sherpas tagged with an area key, ordered. */
function filterByArea(sherpas, areaKey) {
  return sherpas.filter((s) => (s.areas || []).includes(areaKey)).sort(byOrder);
}

/**
 * Loose expertise search for free-text ("who can help with pricing?") and the
 * proactive path. Scores each sherpa by how many query tokens appear in their
 * expertise blurb or area labels; returns matches best-first.
 */
function matchByExpertise(sherpas, text) {
  const tokens = String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
  if (!tokens.length) return [];
  const scored = sherpas
    .map((s) => {
      const hay = `${s.expertise} ${(s.areas || []).map(areaLabel).join(' ')} ${(s.areas || []).join(' ')}`.toLowerCase();
      const score = tokens.reduce((n, t) => (hay.includes(t) ? n + 1 : n), 0);
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
  listByArea,
  getBySlug,
  searchByExpertise,
  // pure helpers (exported for tests)
  areasWithCounts,
  filterByArea,
  matchByExpertise,
};
