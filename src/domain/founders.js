'use strict';

const { supabase } = require('../config/supabase');
const { COFOUNDER_INTENT } = require('./enums');

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
  if (filters.city) q = q.ilike('city', `%${filters.city}%`);
  if (Number.isInteger(filters.cohort)) q = q.eq('cohort', filters.cohort);
  if (filters.program) q = q.eq('program', filters.program);
  if (filters.stage) q = q.eq('startup_stage', filters.stage);
  if (filters.role) q = q.contains('platform_role', [filters.role]);
  if (Array.isArray(filters.lookingFor) && filters.lookingFor.length) {
    q = q.overlaps('looking_for', pgArray(filters.lookingFor));
  }
  // Skills + free text are fuzzy → matched via search_blob ilike (any term).
  const terms = [];
  if (Array.isArray(filters.skills)) terms.push(...filters.skills);
  if (filters.query) terms.push(filters.query);
  for (const t of terms) {
    const clean = String(t).toLowerCase().trim();
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
  const { data, error } = await q.limit(limit);
  if (error) throw new Error(`searchFounders: ${error.message}`);
  return data || [];
}

async function countFounders(filters = {}) {
  let q = supabase()
    .from('founders')
    .select('source_slug', { count: 'exact', head: true })
    .eq('is_published', true);
  q = applyFilters(q, filters);
  const { count, error } = await q;
  if (error) throw new Error(`countFounders: ${error.message}`);
  return count || 0;
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
    .limit(limit);
  if (error) throw new Error(`findByName: ${error.message}`);
  return data || [];
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
  return data || [];
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
  return data || [];
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
