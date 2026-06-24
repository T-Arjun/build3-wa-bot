'use strict';

const { supabase } = require('../config/supabase');
const { COFOUNDER_INTENT } = require('./enums');
const { expandLocation } = require('./geo');
const log = require('../lib/logger');

/**
 * Founder queries over Supabase. All reads are scoped to published profiles.
 * Filter semantics mirror the source platform's directory filters + search.
 */

const LIST_COLUMNS =
  'source_slug,name,city,cohort,program,sector,skills,traits,dharma,looking_for,' +
  'startup_name,startup_idea,startup_stage,primary_role,platform_role,' +
  'avatar_url,linkedin_url,phone,phone_public';

function normPhone(p) {
  return String(p || '').replace(/[^0-9]/g, '');
}

/**
 * Build a PostgREST array literal: {"a, b","c"}.
 * Needed because supabase-js .overlaps()/.contains() do NOT quote array
 * elements, so values containing commas (e.g. "co-founder, I have a startup")
 * would otherwise be split into wrong tokens.
 */
function pgArray(values) {
  return `{${values.map((v) => `"${String(v).replace(/(["\\])/g, '\\$1')}"`).join(',')}}`;
}

// ─── Dedup (source has duplicate person records) ───────────────────────────────

function linkedinHandle(url) {
  if (!url) return null;
  const m = String(url).toLowerCase().match(/linkedin\.com\/(?:in|company)\/([a-z0-9\-_%.]+)/i);
  return m ? m[1].replace(/\/+$/, '') : null;
}

/** Identity key: LinkedIn handle if present, else name+city. */
function identityKey(f) {
  return (
    linkedinHandle(f.linkedin_url) ||
    `${(f.name || '').toLowerCase().trim()}|${(f.city || '').toLowerCase().trim()}`
  );
}

/** Collapse rows that are the same person, keeping the most complete record. */
function dedupeFounders(rows) {
  const completeness = (f) =>
    [
      f.startup_name,
      f.startup_idea,
      f.sector,
      f.dharma,
      f.startup_stage,
      f.skills && f.skills.length,
      f.looking_for && f.looking_for.length,
      f.avatar_url && !f.avatar_url.includes('ui-avatars.com'),
    ].filter(Boolean).length;

  const byKey = new Map();
  for (const f of rows) {
    const k = identityKey(f);
    const cur = byKey.get(k);
    if (!cur || completeness(f) > completeness(cur)) byKey.set(k, f);
  }
  return Array.from(byKey.values());
}

async function findByWaId(waId) {
  const { data } = await supabase()
    .from('founders')
    .select('*')
    .eq('wa_id', waId)
    .maybeSingle();
  if (data) return data;
  // Fall back to a public-phone match (synced founders who opted in).
  const digits = normPhone(waId);
  if (digits.length >= 8) {
    const { data: byPhone } = await supabase()
      .from('founders')
      .select('*')
      .eq('phone_public', true)
      .ilike('phone', `%${digits.slice(-10)}%`)
      .limit(1);
    if (byPhone && byPhone.length) return byPhone[0];
  }
  return null;
}

/**
 * Apply structured filters to a query builder.
 * filters: { sector, city, cohort, program, role, lookingFor[], skills[], stage }
 */
function applyFilters(q, filters = {}) {
  if (filters.sector) q = q.eq('sector', filters.sector);
  if (filters.city) {
    // Expand a city OR a state/region into all the substring terms that should
    // match. "Kerala" → kerala, kochi, cochin, thiruvananthapuram, … so a Kochi
    // founder is found even though `city` never says "Kerala". Falls back to the
    // raw term for places we haven't mapped.
    const { terms } = expandLocation(filters.city);
    const list = (terms.length ? terms : [String(filters.city).toLowerCase()])
      .filter((t) => t && !/[,()]/.test(t)); // commas/parens would break the or() filter
    if (list.length === 1) {
      q = q.ilike('city', `%${list[0]}%`);
    } else if (list.length > 1) {
      q = q.or(list.map((t) => `city.ilike.*${t}*`).join(','));
    }
    // DEBUG=1 shows how a city/state expanded — the Kerala-returns-2 class of bug.
    log.debug('city expand', JSON.stringify(filters.city), '→', JSON.stringify(list));
  }
  if (Number.isInteger(filters.cohort)) q = q.eq('cohort', filters.cohort);
  if (filters.program) q = q.eq('program', filters.program);
  if (filters.stage) q = q.eq('startup_stage', filters.stage);
  if (filters.role) q = q.contains('platform_role', [filters.role]);
  if (Array.isArray(filters.lookingFor) && filters.lookingFor.length) {
    q = q.overlaps('looking_for', pgArray(filters.lookingFor));
  }
  // Skills: OR semantics — a founder matching ANY listed skill is relevant.
  if (Array.isArray(filters.skills) && filters.skills.length) {
    const skillTerms = filters.skills.map((t) => String(t).toLowerCase().trim()).filter(Boolean);
    if (skillTerms.length === 1) {
      q = q.ilike('search_blob', `%${skillTerms[0]}%`);
    } else if (skillTerms.length > 1) {
      q = q.or(skillTerms.map((t) => `search_blob.ilike.*${t}*`).join(','));
    }
  }
  // Free-text query is AND'd on top of skill/filter results.
  if (filters.query) {
    const clean = String(filters.query).toLowerCase().trim();
    if (clean) q = q.ilike('search_blob', `%${clean}%`);
  }
  return q;
}

async function searchFounders(filters = {}, limit = 10) {
  let q = supabase()
    .from('founders')
    .select(LIST_COLUMNS)
    .eq('is_published', true);
  q = applyFilters(q, filters);
  // Over-fetch then dedupe so duplicate person records don't fill the slots.
  const { data, error } = await q.limit(limit * 2);
  if (error) throw new Error(`searchFounders: ${error.message}`);
  return dedupeFounders(data || []).slice(0, limit);
}

async function countFounders(filters = {}) {
  // Count DISTINCT people, not raw rows — otherwise "Found 2" can show 1 after
  // dedupe collapses duplicate records. Uses the same identity key as the list.
  let q = supabase()
    .from('founders')
    .select('linkedin_url,name,city')
    .eq('is_published', true);
  q = applyFilters(q, filters);
  const { data, error } = await q;
  if (error) throw new Error(`countFounders: ${error.message}`);
  return new Set((data || []).map(identityKey)).size;
}

async function getBySlug(slug) {
  const { data } = await supabase()
    .from('founders')
    .select('*')
    .eq('source_slug', slug)
    .maybeSingle();
  return data || null;
}

/**
 * Find by (partial) name — returns up to `limit` for disambiguation.
 */
async function findByName(name, limit = 5) {
  const clean = String(name || '').trim();
  if (!clean) return [];
  const { data, error } = await supabase()
    .from('founders')
    .select(LIST_COLUMNS)
    .eq('is_published', true)
    .ilike('name', `%${clean}%`)
    .limit(Math.max(limit * 3, 15));
  if (error) throw new Error(`findByName: ${error.message}`);
  // Dedupe so the same person (duplicate records) isn't offered as two choices.
  return dedupeFounders(data || []).slice(0, limit);
}

/**
 * Candidate pool for cofounder matching: published founders open to a cofounder
 * (lookingFor overlaps the cofounder-intent set), narrowed by structured filters,
 * excluding the requester.
 */
async function cofounderCandidates(filters = {}, excludeSlug = null, limit = 40) {
  let q = supabase()
    .from('founders')
    .select(
      'source_slug,name,city,cohort,sector,skills,traits,dharma,looking_for,' +
        'startup_name,startup_idea,startup_stage,avatar_url,linkedin_url',
    )
    .eq('is_published', true)
    .overlaps('looking_for', pgArray(COFOUNDER_INTENT));
  q = applyFilters(q, filters);
  if (excludeSlug) q = q.neq('source_slug', excludeSlug);
  const { data, error } = await q.limit(limit);
  if (error) throw new Error(`cofounderCandidates: ${error.message}`);
  return dedupeFounders(data || []);
}

/**
 * Fallback pool when nobody matching the filters has explicitly set cofounder
 * intent: all published founders matching the filters, EXCLUDING those who
 * explicitly opted out (looking_for contains 'none'). Founders who left
 * looking_for blank are included — blank means "unspecified", not "no".
 */
async function candidatesByFilters(filters = {}, excludeSlug = null, limit = 40) {
  let q = supabase()
    .from('founders')
    .select(
      'source_slug,name,city,cohort,sector,skills,traits,dharma,looking_for,' +
        'startup_name,startup_idea,startup_stage,avatar_url,linkedin_url',
    )
    .eq('is_published', true)
    .not('looking_for', 'cs', pgArray(['none']));
  q = applyFilters(q, filters);
  if (excludeSlug) q = q.neq('source_slug', excludeSlug);
  const { data, error } = await q.limit(limit);
  if (error) throw new Error(`candidatesByFilters: ${error.message}`);
  return dedupeFounders(data || []);
}

module.exports = {
  findByWaId,
  searchFounders,
  countFounders,
  getBySlug,
  findByName,
  cofounderCandidates,
  candidatesByFilters,
};
