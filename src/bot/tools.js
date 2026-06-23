'use strict';

const founders = require('../domain/founders');
const { findCofounders } = require('../domain/matching');
const fmt = require('./format');
const { SECTORS, STARTUP_STAGES, LOOKING_FOR } = require('../domain/enums');

const TOO_BROAD = 50;

/** OpenAI tool (function) definitions exposed to the model. */
const definitions = [
  {
    type: 'function',
    function: {
      name: 'search_founders',
      description:
        'Search published founders by free text and/or structured filters. Returns a list shown to the user.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Free-text terms (name, startup, keyword).' },
          sector: { type: 'string', enum: SECTORS },
          city: { type: 'string' },
          cohort: { type: 'integer' },
          skills: { type: 'array', items: { type: 'string' } },
          looking_for: { type: 'array', items: { type: 'string', enum: LOOKING_FOR } },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_profile',
      description:
        "Show one founder's full profile with photo. Use name for a lookup; if several match, the tool returns them for you to disambiguate.",
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          slug: { type: 'string' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_cofounders',
      description:
        'Rank potential cofounders for the user, honoring constraints. Provide at least one of sector/city/skills, or confirm the user has none.',
      parameters: {
        type: 'object',
        properties: {
          sector: { type: 'string', enum: SECTORS },
          city: { type: 'string' },
          cohort: { type: 'integer' },
          stage: { type: 'string', enum: STARTUP_STAGES },
          skills: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    },
  },
];

function toFilters(args = {}) {
  return {
    query: args.query,
    sector: args.sector,
    city: args.city,
    cohort: Number.isInteger(args.cohort) ? args.cohort : undefined,
    program: args.program,
    stage: args.stage,
    role: args.role,
    lookingFor: args.looking_for,
    skills: args.skills,
  };
}

function hasAnyFilter(f) {
  return !!(f.sector || f.city || f.cohort || f.stage || (f.skills && f.skills.length) || f.query);
}

/** Tool implementations. Each receives (args, ctx) and returns a summary object for the model. */
const impls = {
  async search_founders(args, ctx) {
    const filters = toFilters(args);
    const count = await founders.countFounders(filters);
    if (count === 0) return { status: 'none' };
    if (count > TOO_BROAD && !hasAnyFilter(filters)) {
      return { status: 'too_broad', count };
    }
    const results = await founders.searchFounders(filters, 10);
    ctx.outbox.push({
      kind: 'list',
      body: `Found ${count}${count > results.length ? ` — showing ${results.length}` : ''}. Tap one to view:`,
      button: 'View founders',
      rows: results.map(fmt.toRow),
    });
    ctx.state.last_results = results.map((f) => f.source_slug);
    return { status: 'ok', count, shown: results.length, names: results.map((f) => f.name) };
  },

  async get_profile(args, ctx) {
    if (args.slug) {
      const f = await founders.getBySlug(args.slug);
      if (!f) return { status: 'none' };
      pushProfile(ctx, f);
      return { status: 'ok', name: f.name };
    }
    const matches = await founders.findByName(args.name || '', 5);
    if (matches.length === 0) return { status: 'none', query: args.name };
    if (matches.length === 1) {
      pushProfile(ctx, matches[0]);
      return { status: 'ok', name: matches[0].name };
    }
    ctx.outbox.push({
      kind: 'list',
      body: `I found a few — which ${args.name}?`,
      button: 'Choose',
      rows: matches.map(fmt.toRow),
    });
    return {
      status: 'ambiguous',
      candidates: matches.map((f) => `${f.name} (${fmt.subtitle(f) || 'no details'})`),
    };
  },

  async find_cofounders(args, ctx) {
    const filters = toFilters(args);
    const haveCriteria = !!(filters.sector || filters.city || (filters.skills && filters.skills.length) || filters.stage);
    if (!haveCriteria && !ctx.requesterSlug) {
      return { status: 'need_criteria' };
    }
    const { results, poolSize, tooFew } = await findCofounders(filters, ctx.requesterSlug);
    if (poolSize === 0 || results.length === 0) {
      return { status: 'too_few', poolSize };
    }
    const top = results.slice(0, 3);
    for (const m of top) {
      ctx.outbox.push({ kind: 'image', url: fmt.avatarFor(m), caption: fmt.matchCaption(m) });
    }
    if (results.length > 3) {
      ctx.outbox.push({
        kind: 'buttons',
        body: `${results.length - 3} more match${results.length - 3 === 1 ? '' : 'es'} available.`,
        buttons: [{ id: 'more:matches', title: 'More matches' }],
      });
      ctx.state.last_results = results.map((m) => m.slug);
      ctx.state.match_cache = results;
    }
    return {
      status: 'ok',
      shown: top.length,
      total: results.length,
      top: top.map((m) => `${m.name} (${m.score})`),
      tooFew,
    };
  },
};

function pushProfile(ctx, f) {
  ctx.outbox.push({ kind: 'image', url: fmt.avatarFor(f), caption: fmt.profileCaption(f) });
}

module.exports = { definitions, impls, pushProfile };
