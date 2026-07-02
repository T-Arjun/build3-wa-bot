'use strict';

/**
 * Map a source getListedUsers record → our `founders` row shape.
 * Field names on the left mirror the source PUBLIC_FIELDS (routes/api.js).
 * Note: getListedUsers does NOT return email or linkedinData; those stay empty.
 */

function arr(v) {
  if (Array.isArray(v)) return v.filter((x) => x != null && x !== '');
  if (v == null || v === '') return [];
  return [v];
}

function toTimestamp(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const { blobLocationTokens, stateForCity } = require('../domain/geo');

function buildSearchBlob(src, state) {
  return [
    src.name,
    src.startupName,
    src.startupIdea,
    src.sector,
    src.city,
    state,
    src.program,
    src.dharma,
    ...arr(src.skills),
    ...arr(src.traits),
    ...arr(src.lookingFor),
    // Fold in state + city aliases so free-text "kerala"/"cochin" matches a
    // founder whose city only says "Kochi".
    ...blobLocationTokens(src.city),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function mapFounder(src) {
  // Prefer the API's normalized state; backfill from city for legacy rows that
  // predate it (so state-based search covers everyone, not just recent cohorts).
  const state = src.state || stateForCity(src.city);
  return {
    source_slug: src.slug,
    origin: 'synced',
    search_blob: buildSearchBlob(src, state),

    name: src.name || '(unnamed)',
    phone: src.phonePublic ? src.phone || null : null,
    phone_public: !!src.phonePublic,

    cohort: Number.isInteger(src.cohort) ? src.cohort : null,
    city: src.city || null,
    state: state || null,
    program: src.program || null,

    dharma: src.dharma || null,
    traits: arr(src.traits),
    skills: arr(src.skills),
    sector: src.sector || null,
    looking_for: arr(src.lookingFor),

    startup_name: src.startupName || null,
    startup_idea: src.startupIdea || null,
    startup_stage: src.startupStage || null,
    quote: src.quote || null,

    primary_role: src.primaryRole || null,
    platform_role: arr(src.platformRole),

    investment_thesis: src.investmentThesis || null,
    ticket_size: src.ticketSize || null,
    portfolio: arr(src.portfolioCompanies),

    avatar_url: src.avatarUrl || null,
    banner_url: src.bannerUrl || null,
    linkedin_url: src.linkedinUrl || null,

    is_published: src.isPublished !== false,
    source_created_at: toTimestamp(src.createdAt),
    source_updated_at: toTimestamp(src.updatedAt),
    synced_at: new Date().toISOString(),
  };
}

module.exports = { mapFounder };
