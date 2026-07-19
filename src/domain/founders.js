'use strict';

const { supabase } = require('../config/supabase');
const { COFOUNDER_INTENT } = require('./enums');
const { locationFilter, normalize, editDistance } = require('./geo');
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

// Short single-word terms (<=4 chars: "ai", "ar", "b2b", "saas"...) are exactly
// the tech buzzwords founders search by, but a raw ILIKE substring match on the
// denormalized search_blob hits them constantly by accident - "ai" alone
// matched "Nair" (a surname), "maintain", "raised" etc, once inflating an
// "AI founders in Mumbai" search from a real ~8 to a false 40. Word-boundary
// regex match (PostgREST's imatch / Postgres `\y`) fixes this; longer or
// multi-word terms keep the substring ILIKE, where false positives are rare.
const WORD_BOUNDARY_MAX_LEN = 4;

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isShortWord(term) {
  return term.length > 0 && term.length <= WORD_BOUNDARY_MAX_LEN && !/\s/.test(term);
}

/** { column, op, value } args for supabase-js .filter(), matching `term` against `col`. */
function blobFilterArgs(col, term) {
  return isShortWord(term)
    ? [col, 'imatch', `\\y${escapeRegex(term)}\\y`]
    : [col, 'ilike', `%${term}%`];
}

/** The equivalent `column.op.value` clause for a PostgREST .or() string. */
function blobOrClause(col, term) {
  return isShortWord(term) ? `${col}.imatch.\\y${escapeRegex(term)}\\y` : `${col}.ilike.*${term}*`;
}

// ─── Dedup (source has duplicate person records) ───────────────────────────────

function linkedinHandle(url) {
  if (!url) return null;
  // ONLY personal profiles (/in/...) identify a person. Company pages
  // (/company/...) are shared by everyone at the startup, so they must NOT be an
  // identity key - otherwise two cofounders who both link their company page
  // collapse into one and one of them disappears from the directory.
  const m = String(url).toLowerCase().match(/linkedin\.com\/in\/([a-z0-9\-_%.]+)/i);
  return m ? m[1].replace(/\/+$/, '') : null;
}

/** Normalize a name for comparison: lowercase, strip titles/punctuation. */
function normalizeName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\b(dr|mr|mrs|ms|prof|mx)\b\.?/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Are two names plausibly the same person? Same normalized string, or they share
 * a name token of length >= 3 (handles "Avinash matkar"/"Avinash Matkar",
 * "Zeeshan MD"/"Zeeshan Mohammed"). Missing names → allow (can't tell).
 */
function namesSimilar(a, b) {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return true;
  if (na === nb) return true;
  const ta = new Set(na.split(' ').filter((t) => t.length >= 3));
  return nb.split(' ').some((t) => t.length >= 3 && ta.has(t));
}

/** Identity key: personal-LinkedIn handle if present, else name+city. */
function identityKey(f) {
  const h = linkedinHandle(f.linkedin_url);
  return h ? `in:${h}` : `nc:${(f.name || '').toLowerCase().trim()}|${(f.city || '').toLowerCase().trim()}`;
}

/**
 * Is there anything worth showing for this founder? Shell profiles (just a name +
 * "Cohort N", no startup/skills/sector/LinkedIn) render as broken-looking cards,
 * so we exclude them. NOTE: callers must select the content columns
 * (startup_name, startup_idea, skills, sector, linkedin_url) for this to work.
 */
function isShowable(f) {
  return !!(
    f.startup_name ||
    f.startup_idea ||
    (Array.isArray(f.skills) && f.skills.length) ||
    (f.sector && String(f.sector).toLowerCase() !== 'other') ||
    f.linkedin_url
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
    let k = identityKey(f);
    // Guard against distinct people who share one /in/ URL (a source data error):
    // if a row already sits under this handle with a clearly different name, treat
    // this as a separate person instead of silently merging them away.
    if (k.startsWith('in:') && byKey.has(k) && !namesSimilar(byKey.get(k).name, f.name)) {
      k = `${k}#${normalizeName(f.name)}`;
    }
    const cur = byKey.get(k);
    if (!cur || completeness(f) > completeness(cur)) byKey.set(k, f);
  }
  // Drop shell profiles so they never surface as (broken-looking) results.
  return Array.from(byKey.values()).filter(isShowable);
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
    // A state/region resolves to the native `state` column (exact, reliable, and
    // covers every founder in that state). A specific city resolves to substring
    // matches on the clean `city` column. Replaces the old "expand a state into 20
    // city-substring guesses" workaround now that `state` is a real field.
    const loc = locationFilter(filters.city);
    if (loc.kind === 'none') {
      // "India" / "anywhere" / "remote": explicitly NOT a location constraint.
    } else if (loc.kind === 'state' && loc.states.length) {
      q = q.or(loc.states.map((s) => `state.ilike."${s}"`).join(','));
    } else {
      const terms = (loc.terms && loc.terms.length ? loc.terms : [normalize(filters.city)]).filter(
        (t) => t && !/[,()]/.test(t),
      );
      if (terms.length === 1) q = q.ilike('city', `%${terms[0]}%`);
      else if (terms.length > 1) q = q.or(terms.map((t) => `city.ilike.*${t}*`).join(','));
    }
    log.debug('location filter', JSON.stringify(filters.city), '->', JSON.stringify(loc));
  }
  if (Number.isInteger(filters.cohort)) q = q.eq('cohort', filters.cohort);
  if (filters.program) q = q.eq('program', filters.program);
  if (filters.stage) q = q.eq('startup_stage', filters.stage);
  if (filters.role) q = q.contains('platform_role', [filters.role]);
  if (Array.isArray(filters.lookingFor) && filters.lookingFor.length) {
    q = q.overlaps('looking_for', pgArray(filters.lookingFor));
  }
  // Skills: OR semantics - a founder matching ANY listed skill is relevant.
  if (Array.isArray(filters.skills) && filters.skills.length) {
    const skillTerms = filters.skills
      .map((t) => String(t).toLowerCase().trim())
      .filter((t) => t && !/[,()]/.test(t)); // strip chars that would break the or() filter
    if (skillTerms.length === 1) {
      q = q.filter(...blobFilterArgs('search_blob', skillTerms[0]));
    } else if (skillTerms.length > 1) {
      q = q.or(skillTerms.map((t) => blobOrClause('search_blob', t)).join(','));
    }
  }
  // Free-text query is AND'd on top of skill/filter results.
  if (filters.query) {
    const clean = String(filters.query).toLowerCase().trim();
    if (clean) q = q.filter(...blobFilterArgs('search_blob', clean));
  }
  return q;
}

async function searchFounders(filters = {}, limit = 10) {
  let q = supabase()
    .from('founders')
    .select(LIST_COLUMNS)
    .eq('is_published', true);
  q = applyFilters(q, filters);
  // Over-fetch (wider when there's a free-text query, so relevance ranking has
  // room to reorder) then dedupe so duplicate person records don't fill slots.
  const over = filters.query ? Math.max(limit * 4, 40) : limit * 2;
  const { data, error } = await q.limit(over);
  if (error) throw new Error(`searchFounders: ${error.message}`);
  return rankByQuery(dedupeFounders(data || []), filters.query).slice(0, limit);
}

/**
 * A free-text query hits `search_blob` by substring, so "loud" also matches
 * "cloud"/"aloud" and the real match can sink to the bottom. Re-rank so the
 * query in the startup name or person name wins, then startup idea, then the
 * rest (blob-only, incidental substring hits). Word-boundary beats mid-word.
 */
function rankByQuery(rows, query) {
  const q = String(query || '').toLowerCase().trim();
  if (!q) return rows;
  const wordRe = new RegExp(`\\b${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
  const score = (f) => {
    const name = String(f.startup_name || '').toLowerCase();
    const person = String(f.name || '').toLowerCase();
    const idea = String(f.startup_idea || '').toLowerCase();
    if (name === q) return 0;
    if (wordRe.test(name) || wordRe.test(person)) return 1;
    if (name.includes(q) || person.includes(q)) return 2;
    if (wordRe.test(idea)) return 3;
    if (idea.includes(q)) return 4;
    return 5; // blob-only / incidental substring
  };
  return rows
    .map((f, i) => ({ f, s: score(f), i }))
    .sort((a, b) => a.s - b.s || a.i - b.i)
    .map((x) => x.f);
}

async function countFounders(filters = {}) {
  // Count DISTINCT, SHOWABLE people - not raw rows - so the number always equals
  // what the list actually renders. Needs the content columns isShowable checks.
  let q = supabase()
    .from('founders')
    .select('linkedin_url,name,city,startup_name,startup_idea,skills,sector')
    .eq('is_published', true);
  q = applyFilters(q, filters);
  const { data, error } = await q;
  if (error) throw new Error(`countFounders: ${error.message}`);
  // Same dedupe (incl. the name-similarity guard) as searchFounders, so the
  // count always equals what the user actually sees.
  return dedupeFounders(data || []).length;
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
 * Build the safe pattern list for a name search: the whole phrase plus each
 * individual token, all filtered to exclude PostgREST .or()-grammar
 * metacharacters. Match the whole phrase OR any single name token, so
 * "bhavana menon" still finds "Bhavana" (people give a wrong/extra surname
 * all the time).
 *
 * SECURITY (real live-confirmed bug, fixed here): every pattern that reaches
 * the .or() string MUST exclude `, ( ) * : " \` - an unescaped comma breaks
 * out of its own `name.ilike.*...*` clause once joined with the rest and lets
 * the remainder be parsed as an INDEPENDENT PostgREST clause on any column.
 * Confirmed against the live DB: a name query containing a comma injected a
 * real `cohort.gt.N` filter (Postgres itself threw `invalid input syntax for
 * type integer`, proving the injected clause was actually being evaluated).
 * Pure/exported so this is unit-testable without a database connection.
 * @param {string} name
 * @returns {string[]} deduped, safe patterns (may be empty)
 */
function buildNamePatterns(name) {
  const clean = String(name || '').trim();
  if (!clean) return [];
  const UNSAFE = /[,()*:"\\]/;
  const tokens = clean
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !UNSAFE.test(t));
  const cleanLc = clean.toLowerCase();
  const patterns = [...(UNSAFE.test(cleanLc) ? [] : [cleanLc]), ...tokens];
  return Array.from(new Set(patterns));
}

/**
 * Find by (partial) name - returns up to `limit` for disambiguation.
 */
async function findByName(name, limit = 5) {
  const patterns = buildNamePatterns(name);
  // A query that's empty, all unsafe characters, or too short to tokenize
  // leaves patterns empty - .or('') is an empty filter, not "match nothing",
  // so it must return early here rather than reach Postgres.
  if (!patterns.length) return [];
  const orExpr = patterns.map((p) => `name.ilike.*${p}*`).join(',');
  const { data, error } = await supabase()
    .from('founders')
    .select(LIST_COLUMNS)
    .eq('is_published', true)
    .or(orExpr)
    .limit(Math.max(limit * 4, 20));
  if (error) throw new Error(`findByName: ${error.message}`);
  // Rank fuller-phrase matches first ("bhavana menon" -> "Bhavana Menon" beats
  // a bare "Bhavana"), then dedupe duplicate person records.
  const q = String(name || '').trim().toLowerCase();
  const ranked = (data || []).slice().sort((a, b) => {
    const an = String(a.name || '').toLowerCase();
    const bn = String(b.name || '').toLowerCase();
    return (bn.includes(q) ? 1 : 0) - (an.includes(q) ? 1 : 0);
  });
  const deduped = dedupeFounders(ranked);
  if (deduped.length) return deduped.slice(0, limit);
  // Nothing matched by substring: try a typo-tolerant pass ("umaier" -> "Umair
  // Tariq"). Only when exact/substring found nothing, so it never degrades a
  // good match. Fuzzy results are a GUESS, not a confirmed match - tagged
  // `_fuzzy` so the caller confirms with the user instead of asserting it as
  // fact (a wrong confident answer is worse than asking "did you mean X?").
  const fuzzyTokens = q.split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
  return fuzzyByName(fuzzyTokens.length ? fuzzyTokens : [q], limit);
}

/**
 * Typo-tolerant name lookup: pull published names and keep those whose any word
 * is within a small edit distance of any query token. Conservative thresholds so
 * "umaier"->"Umair" resolves but unrelated names don't.
 */
async function fuzzyByName(queryTokens, limit) {
  const toks = queryTokens.filter((t) => t && t.length >= 4);
  if (!toks.length) return [];
  const { data, error } = await supabase()
    .from('founders')
    .select(LIST_COLUMNS)
    .eq('is_published', true);
  if (error) throw new Error(`fuzzyByName: ${error.message}`);
  const scored = [];
  for (const f of data || []) {
    const words = String(f.name || '')
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    let best = Infinity;
    for (const t of toks) {
      const maxD = t.length > 6 ? 2 : 1;
      for (const w of words) {
        if (Math.abs(w.length - t.length) > maxD) continue;
        const d = editDistance(t, w);
        if (d <= maxD && d < best) best = d;
      }
    }
    if (best !== Infinity) scored.push({ f, d: best });
  }
  scored.sort((a, b) => a.d - b.d);
  // Tag every candidate as a guess (see findByName) before dedupe/return.
  for (const { f } of scored) f._fuzzy = true;
  return dedupeFounders(scored.map((x) => x.f)).slice(0, limit);
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
 * looking_for blank are included - blank means "unspecified", not "no".
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
  buildNamePatterns,
  cofounderCandidates,
  candidatesByFilters,
  dedupeFounders,
  namesSimilar,
  isShowable,
};
