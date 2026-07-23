'use strict';

const crypto = require('crypto');
const { openai } = require('../config/openai');
const { env } = require('../config/env');
const { supabase } = require('../config/supabase');
const { cofounderCandidates, getBySlug } = require('./founders');
const { buildSystemPrompt, buildUserPrompt } = require('./matchingPrompt');
const { withRetry } = require('../lib/retry');
const log = require('../lib/logger');

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // align with the 6-hour sync cadence

function signature(requesterSlug, filters, self) {
  const norm = JSON.stringify({
    r: requesterSlug || null,
    f: {
      sector: filters.sector || null,
      city: (filters.city || '').toLowerCase() || null,
      cohort: filters.cohort ?? null,
      stage: filters.stage || null,
      skills: (filters.skills || []).map((s) => s.toLowerCase()).sort(),
    },
    // Self-description personalizes the target, so it MUST be part of the cache
    // key - otherwise two anonymous users with the same filters but different
    // backgrounds would share (wrong) cached results.
    s: self
      ? {
          sector: self.sector || null,
          city: (self.city || '').toLowerCase() || null,
          stage: self.stage || null,
          role: self.role || null,
          skills: (self.skills || []).map((s) => s.toLowerCase()).sort(),
        }
      : null,
  });
  return crypto.createHash('sha1').update(norm).digest('hex');
}

async function readCache(requesterSlug, sig) {
  const { data } = await supabase()
    .from('matches')
    .select('results, computed_at')
    .eq('requester_slug', requesterSlug || '')
    .eq('filter_signature', sig)
    .maybeSingle();
  if (!data) return null;
  if (Date.now() - new Date(data.computed_at).getTime() > CACHE_TTL_MS) return null;
  return data.results;
}

async function writeCache(requesterSlug, sig, results) {
  await supabase()
    .from('matches')
    .upsert(
      {
        requester_slug: requesterSlug || '',
        filter_signature: sig,
        results,
        model: env.openai.model,
        computed_at: new Date().toISOString(),
      },
      { onConflict: 'requester_slug,filter_signature' },
    );
}

/**
 * Build the "target founder" the candidates are scored against.
 * - Known requester → their real profile (true complementarity).
 * - Anonymous with a self-description → a target built from THEIR OWN skills/
 *   sector/etc., so scoring measures complementarity to the user (not just the
 *   filters). This is what makes matches feel personal for unlinked users.
 * - Anonymous with nothing → a thin synthetic target from the stated criteria.
 */
function buildTarget(requester, filters, self) {
  if (requester) return requester;
  if (self && ((self.skills && self.skills.length) || self.sector || self.role || self.stage)) {
    return {
      name: 'the requester',
      sector: self.sector || filters.sector || null,
      city: self.city || filters.city || null,
      skills: Array.isArray(self.skills) ? self.skills : [],
      traits: Array.isArray(self.traits) ? self.traits : [],
      dharma: self.dharma || null,
      looking_for: ['co-founder, I have a startup'],
      startup_stage: self.stage || filters.stage || null,
      // 'soft' when the user hedged their own skill claim ("little bit tech")
      // rather than stating it plainly ("I'm technical") - see tools.js
      // set_self_profile. Caps the matching prompt's reason-tone confidence so
      // it doesn't assert "directly complements your engineering" as settled
      // fact off an assumption nobody confirmed.
      skillConfidence: self.skillConfidence || null,
    };
  }
  return {
    name: 'the requester',
    sector: filters.sector || null,
    city: filters.city || null,
    skills: [],
    looking_for: ['co-founder, I have a startup'],
    startup_stage: filters.stage || null,
  };
}

/**
 * Honest, per-candidate line about what THIS founder actually said about
 * cofounder intent - never a batch-wide assumption. `looking_for` is
 * multi-select, so when more than one value is set, the most cofounder-
 * relevant one wins (checked in this priority order). Blank/unspecified is
 * the majority case in the live directory (mostly legacy cohorts that
 * predate this field existing on the source platform, not people declining
 * to answer) - it gets an honest "hasn't said" line, not a exclusion and not
 * a confident claim either way. A founder who explicitly opted out
 * ('none') never reaches here - excluded at the SQL layer in founders.js.
 */
function lookingForStatus(lookingFor) {
  const lf = Array.isArray(lookingFor) ? lookingFor : [];
  if (lf.includes('co-founder, I have a startup')) {
    return 'already running something and open to a cofounder for it';
  }
  if (lf.includes("co-founder, I don't have a startup")) {
    return 'looking to join someone as a cofounder';
  }
  if (lf.includes('join a startup')) {
    return 'open to joining a startup, not necessarily as a cofounder';
  }
  if (lf.includes('service providers')) {
    return 'listed as a service provider, but might still be worth a conversation';
  }
  return "hasn't said either way, worth asking directly";
}

/**
 * Turn the model's raw scoring JSON into result cards. Pure/exported so this
 * is unit-testable without a live API call.
 *
 * Two defensive gaps closed here, both matching this codebase's existing
 * "never trust the model to not repeat itself" doctrine (see tools.js's own
 * comments on live-repeated model mistakes):
 * - `parsed.matches || []` doesn't guard a TRUTHY non-array (e.g. the model
 *   wrapping a single match as an object instead of a one-item array) -
 *   confirmed live: `{matches:{}}` throws `.filter is not a function`,
 *   uncaught by the surrounding try/catch since this ran outside it. Fixed
 *   with the same `Array.isArray` guard already used everywhere else in this
 *   codebase for exactly this class of LLM-shaped input.
 * - No defense against the model repeating a candidateIndex (never observed
 *   live at full 40-candidate scale, but "include ALL candidates" doesn't
 *   explicitly forbid duplicates either) - a repeat would show the SAME
 *   founder as two separate cards in one reply. Deduped by slug, keeping the
 *   first (highest-scored, since matches are sorted after this) occurrence.
 * @param {object} parsed - the model's parsed JSON response
 * @param {object[]} candidates - the candidate pool, indexed the same way the prompt described them
 * @returns {object[]} result cards, highest score first
 */
function parseMatchResults(parsed, candidates) {
  const matches = Array.isArray(parsed?.matches) ? parsed.matches : [];
  const seenSlugs = new Set();
  const results = [];
  for (const m of matches) {
    if (!Number.isInteger(m.candidateIndex) || !candidates[m.candidateIndex]) continue;
    const c = candidates[m.candidateIndex];
    if (seenSlugs.has(c.source_slug)) continue;
    seenSlugs.add(c.source_slug);
    results.push({
      slug: c.source_slug,
      name: c.name,
      sector: c.sector,
      city: c.city,
      startup_name: c.startup_name,
      startup_idea: c.startup_idea,
      avatar_url: c.avatar_url,
      linkedin_url: c.linkedin_url,
      score: Math.min(100, Math.max(0, Math.round(m.score))),
      reasons: Array.isArray(m.reasons) ? m.reasons.slice(0, 2) : [],
      lookingForStatus: lookingForStatus(c.looking_for),
    });
  }
  return results.sort((a, b) => b.score - a.score);
}

/**
 * Hard-filter candidates against explicit search constraints BEFORE the LLM
 * scores them. The LLM does soft complementarity scoring; hard requirements
 * (skill present, sector match) should never be left to the model's judgment
 * because it is inconsistent — "want a tech cofounder" produces different
 * candidate sets across runs when the filtering is implicit.
 *
 * Conservative: only drops a candidate when we are CERTAIN it doesn't qualify.
 * When the candidate's relevant field is missing/null, we leave them in (benefit
 * of the doubt) rather than wrongly excluding someone who just has an incomplete
 * profile.
 */
function hardFilter(candidates, filters) {
  let pool = candidates;

  // Skills: if the search explicitly names required skills, drop candidates who
  // have NO skills field entry that overlaps (substring match, case-insensitive).
  // A candidate with an empty skills array stays in — their profile may just be
  // incomplete. The LLM still scores them lower for missing the requirement.
  if (filters.skills && filters.skills.length) {
    const wanted = filters.skills.map((s) => s.toLowerCase());
    pool = pool.filter((f) => {
      const has = (f.skills || []).map((s) => s.toLowerCase());
      if (has.length === 0) return true; // incomplete profile — keep, let LLM decide
      return wanted.some((w) => has.some((h) => h.includes(w) || w.includes(h)));
    });
  }

  // Sector: if the search names a sector, drop candidates in a clearly different
  // sector. Null sector on the candidate → keep (incomplete profile).
  if (filters.sector) {
    const wantedSector = filters.sector.toLowerCase();
    pool = pool.filter((f) => {
      if (!f.sector) return true; // incomplete — keep
      return f.sector.toLowerCase() === wantedSector;
    });
  }

  return pool;
}

/**
 * Constraint-aware cofounder matching.
 * @param {object} filters {sector,city,cohort,stage,skills[]}
 * @param {string|null} requesterSlug
 * @returns {Promise<{results:object[], poolSize:number, cached:boolean, tooFew:boolean}>}
 */
async function findCofounders(filters = {}, requesterSlug = null, self = null) {
  // A linked profile always beats a chat-derived self-description.
  const effectiveSelf = requesterSlug ? null : self;
  const sig = signature(requesterSlug, filters, effectiveSelf);

  const cached = await readCache(requesterSlug, sig);
  if (cached) {
    return { results: cached, poolSize: cached.length, cached: true, tooFew: cached.length < 3 };
  }

  const requester = requesterSlug ? await getBySlug(requesterSlug) : null;

  // One pool: everyone published matching the filters. looking_for is never a
  // gate here (see cofounderCandidates' own doc comment) - it only shapes the
  // per-result lookingForStatus line, never who's scored and shown.
  const candidates = await cofounderCandidates(filters, requesterSlug, 40);
  // Hard-filter before LLM scoring: drop candidates that definitively don't
  // meet explicit skill/sector constraints. This prevents score volatility from
  // the model "inferring" that an edtech person belongs in a fintech search.
  const qualified = hardFilter(candidates, filters);
  // Log the drop so we can monitor whether the filter is too aggressive.
  if (qualified.length < candidates.length) {
    log.info(`hardFilter: ${candidates.length} → ${qualified.length} candidates (filters: skills=${JSON.stringify(filters.skills)}, sector=${filters.sector})`);
  }

  if (qualified.length === 0) {
    return { results: [], poolSize: 0, cached: false, tooFew: true };
  }

  const target = buildTarget(requester, filters, effectiveSelf);
  const system = buildSystemPrompt();
  const user = buildUserPrompt(target, qualified, filters.skills);

  let parsed;
  try {
    // Disable the SDK's own (silent) retries and use our logged retry instead,
    // so transient OpenAI failures are visible and not double-counted.
    const completion = await withRetry(
      () =>
        openai().chat.completions.create(
          {
            model: env.openai.model,
            temperature: 0.3,
            response_format: { type: 'json_object' },
            max_tokens: 4000,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
          },
          { maxRetries: 0 },
        ),
      { retries: 2, baseMs: 600, label: 'findCofounders' },
    );
    // Observability tripwire, not a fix: live-verified at the full 40-candidate
    // cap that gpt-4.1-mini finishes comfortably under budget (2639/4000
    // tokens, finish_reason "stop"), so this doesn't fire today. But nothing
    // else in this function would ever surface a silent truncation - a
    // response cut off mid-array can still happen to parse as valid (shorter)
    // JSON with zero error - so this is a one-line, zero-cost way to notice if
    // that combination (larger candidate pool, more verbose model) ever
    // changes, rather than quietly returning fewer matches than exist.
    if (completion.choices?.[0]?.finish_reason === 'length') {
      log.warn(`findCofounders: OpenAI response hit max_tokens (${candidates.length} candidates) - results may be truncated`);
    }
    parsed = JSON.parse(completion.choices?.[0]?.message?.content || '{}');
  } catch (err) {
    log.error('findCofounders OpenAI error:', err.message);
    throw err;
  }

  const results = parseMatchResults(parsed, qualified);

  await writeCache(requesterSlug, sig, results);

  return { results, poolSize: candidates.length, cached: false, tooFew: results.length < 3 };
}

module.exports = { findCofounders, buildTarget, parseMatchResults, lookingForStatus };
