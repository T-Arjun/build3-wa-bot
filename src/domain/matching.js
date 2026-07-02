'use strict';

const crypto = require('crypto');
const { openai } = require('../config/openai');
const { env } = require('../config/env');
const { supabase } = require('../config/supabase');
const { cofounderCandidates, candidatesByFilters, getBySlug } = require('./founders');
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

  // Prefer founders who explicitly seek a cofounder; if none match the filters,
  // fall back to all founders matching the filters (soft match) so we surface
  // people worth a conversation rather than returning nothing.
  let candidates = await cofounderCandidates(filters, requesterSlug, 40);
  let soft = false;
  if (candidates.length === 0) {
    candidates = await candidatesByFilters(filters, requesterSlug, 40);
    soft = true;
  }

  if (candidates.length === 0) {
    return { results: [], poolSize: 0, cached: false, tooFew: true, soft: false };
  }

  const target = buildTarget(requester, filters, effectiveSelf);
  const system = buildSystemPrompt();
  const user = buildUserPrompt(target, candidates, filters.skills);

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
    parsed = JSON.parse(completion.choices?.[0]?.message?.content || '{}');
  } catch (err) {
    log.error('findCofounders OpenAI error:', err.message);
    throw err;
  }

  const results = (parsed.matches || [])
    .filter((m) => Number.isInteger(m.candidateIndex) && candidates[m.candidateIndex])
    .map((m) => {
      const c = candidates[m.candidateIndex];
      return {
        slug: c.source_slug,
        name: c.name,
        sector: c.sector,
        city: c.city,
        startup_name: c.startup_name,
        startup_idea: c.startup_idea,
        avatar_url: c.avatar_url,
        score: Math.min(100, Math.max(0, Math.round(m.score))),
        reasons: Array.isArray(m.reasons) ? m.reasons.slice(0, 2) : [],
      };
    })
    .sort((a, b) => b.score - a.score);

  await writeCache(requesterSlug, sig, results);

  return { results, poolSize: candidates.length, cached: false, tooFew: results.length < 3, soft };
}

module.exports = { findCofounders, buildTarget };
