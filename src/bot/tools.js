'use strict';

const founders = require('../domain/founders');
const { findCofounders } = require('../domain/matching');
const sherpas = require('../domain/sherpas');
const fmt = require('./format');
const { SECTORS, STARTUP_STAGES, LOOKING_FOR } = require('../domain/enums');
const { AREA_KEYS, areaLabel } = require('../domain/sherpaAreas');

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
  {
    type: 'function',
    function: {
      name: 'set_self_profile',
      description:
        "Record what the USER says about THEMSELVES - their OWN skills, sector, city, stage, or role - so cofounder matches are scored as complementary to them (not just filtered). Call this whenever the user reveals their own background, e.g. \"I'm a technical founder\", \"I can do sales and growth\", \"I'm building a fintech in Bangalore\". This is about the user themselves, NOT about who they are looking for.",
      parameters: {
        type: 'object',
        properties: {
          skills: { type: 'array', items: { type: 'string' }, description: "the user's OWN skills" },
          sector: { type: 'string', enum: SECTORS },
          city: { type: 'string' },
          stage: { type: 'string', enum: STARTUP_STAGES },
          role: { type: 'string' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_sherpas',
      description:
        'Browse build3 mentors ("Sherpas") to book free 1:1 mentor hours. Call with NO args to show the expertise areas; with `area` to list mentors in one area; with `query` to surface mentors for a topic the founder needs help with (e.g. "pricing", "hiring", "fundraising").',
      parameters: {
        type: 'object',
        properties: {
          area: { type: 'string', enum: AREA_KEYS, description: 'expertise area to list mentors for' },
          query: {
            type: 'string',
            description: 'free-text topic the founder needs help with',
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_sherpa',
      description:
        "Show one mentor's profile card with their booking link and the prep-doc / feedback reminders. Use the slug from a list_sherpas result.",
      parameters: {
        type: 'object',
        properties: {
          slug: { type: 'string' },
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
  return !!(
    f.sector ||
    f.city ||
    f.cohort ||
    f.stage ||
    f.program ||
    f.role ||
    (f.skills && f.skills.length) ||
    (f.lookingFor && f.lookingFor.length) ||
    f.query
  );
}

const SHOWN_NOTE =
  'The full profile card (photo + startup, sector, city, skills, LinkedIn) has ALREADY been sent to the user. Do NOT offer to show the profile again. Keep any text to a one-line confirmation; you may offer "similar founders".';

const LIST_SHOWN_NOTE =
  'Your text reply is sent FIRST, then the interactive list/cards appear right below it. Write a warm, helpful lead-in (1-2 short sentences, build3 tone) that frames what they are about to see and invites them to tap. Do NOT enumerate or repeat the names/items - the list already shows them; repeating them is the mistake to avoid.';

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
    // Exactly one founder → show the profile directly. A 1-row "tap to view" list
    // is clunky, and this also covers the case where duplicate rows dedupe to one.
    if (results.length === 1) {
      pushProfile(ctx, results[0]);
      ctx.state.focus = fmt.focusFields(results[0]);
      return { status: 'shown', name: results[0].name, facts: ctx.state.focus, note: SHOWN_NOTE };
    }
    ctx.outbox.push({
      kind: 'list',
      body: `Found ${count}${count > results.length ? `, showing ${results.length}` : ''}. Tap one to view:`,
      button: 'View founders',
      rows: results.map(fmt.toRow),
    });
    ctx.state.last_results = results.map((f) => f.source_slug);
    ctx.state.topic_changed = true;
    return { status: 'ok', count, shown: results.length, note: LIST_SHOWN_NOTE };
  },

  async get_profile(args, ctx) {
    const shownNote = SHOWN_NOTE;
    if (args.slug) {
      const f = await founders.getBySlug(args.slug);
      if (!f) return { status: 'none' };
      pushProfile(ctx, f);
      ctx.state.focus = fmt.focusFields(f);
      return { status: 'shown', name: f.name, facts: ctx.state.focus, note: shownNote };
    }
    const matches = await founders.findByName(args.name || '', 5);
    if (matches.length === 0) return { status: 'none', query: args.name };
    if (matches.length === 1) {
      pushProfile(ctx, matches[0]);
      ctx.state.focus = fmt.focusFields(matches[0]);
      return { status: 'shown', name: matches[0].name, facts: ctx.state.focus, note: shownNote };
    }
    ctx.outbox.push({
      kind: 'list',
      body: `I found a few - which ${args.name}?`,
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
    // No hard "need criteria" gate - a broad search returns sensible results
    // (cofounder-seekers, or soft fallback). The engine clarifies at most once
    // at the conversation layer; once the user wants results, we always show some.
    const { results, poolSize, tooFew, soft } = await findCofounders(
      filters,
      ctx.requesterSlug,
      ctx.self,
    );
    ctx.state.topic_changed = true;
    if (poolSize === 0 || results.length === 0) {
      return { status: 'too_few', poolSize };
    }
    // Drop people already surfaced in the previous match set so "find another"
    // doesn't re-paste identical cards. If everyone matching was already shown,
    // say so (no cards) instead of repeating them.
    const prevShown = new Set(ctx.prevMatchSlugs || []);
    const fresh = results.filter((m) => !prevShown.has(m.slug));
    if (fresh.length === 0) {
      return {
        status: 'no_new_matches',
        total: results.length,
        note: "Everyone matching these EXACT criteria was already shown. Do NOT dead-end and do NOT re-send their cards. Offer to WIDEN the pool (a nearby city, open-to-remote, or an adjacent sector) while KEEPING the core skill/role they asked for. Never suggest switching to a different core skill.",
      };
    }
    if (soft) {
      ctx.outbox.push({
        kind: 'text',
        body:
          "I didn't find anyone there who's said they're actively looking for a cofounder. " +
          'But we do have a few founder connects from that search - they\'re not explicitly seeking, ' +
          'though if you like, we can help you start a conversation with them:',
      });
    }
    const top = fresh.slice(0, 3);
    for (const m of top) {
      ctx.outbox.push({ kind: 'image', url: fmt.avatarFor(m), caption: fmt.matchCaption(m) });
    }
    // Record everyone in this fresh set as shown (for pagination + next-turn
    // exclusion), even if only the top 3 are on screen now.
    ctx.state.last_results = fresh.map((m) => m.slug);
    ctx.state.match_cache = fresh;
    if (fresh.length > 3) {
      ctx.outbox.push({
        kind: 'buttons',
        body: `${fresh.length - 3} more match${fresh.length - 3 === 1 ? '' : 'es'} available.`,
        buttons: [{ id: 'more:matches', title: 'More matches' }],
      });
    }
    return {
      status: 'ok',
      soft,
      shown: top.length,
      total: fresh.length,
      tooFew: fresh.length < 3,
      note: LIST_SHOWN_NOTE,
    };
  },

  async set_self_profile(args, ctx) {
    const self = { ...(ctx.self || {}) };
    if (Array.isArray(args.skills) && args.skills.length) self.skills = args.skills;
    if (args.sector) self.sector = args.sector;
    if (args.city) self.city = args.city;
    if (args.stage) self.stage = args.stage;
    if (args.role) self.role = args.role;
    ctx.self = self; // a find_cofounders call in this SAME turn picks it up
    ctx.state.self = self; // persisted by the handler for the rest of the session
    return {
      status: 'saved',
      self,
      note: 'Saved their background. If they were after a cofounder, call find_cofounders now so matches are personalized to them. Do not ask for this info again.',
    };
  },

  async list_sherpas(args, ctx) {
    // Topic search: "who can help with pricing?" / proactive suggestion path.
    if (args.query && !args.area) {
      const matches = await sherpas.searchByExpertise(args.query);
      if (matches.length === 1) {
        pushSherpaCard(ctx, matches[0]);
        return { status: 'shown', name: matches[0].name, note: SHERPA_SHOWN_NOTE };
      }
      if (matches.length > 1) {
        pushSherpaList(ctx, matches, 'Mentors who can help with that. Tap one to view and book:');
        return { status: 'ok', shown: matches.length, note: LIST_SHOWN_NOTE };
      }
      // No mentor literally lists that topic - don't show the area picker yet;
      // nudge the model to retry with the closest area so only ONE list renders.
      return {
        status: 'no_topic_match',
        note: 'No mentor explicitly lists that topic. Call list_sherpas again with the closest `area` from the enum; do not reply to the user yet.',
        areas: AREA_KEYS,
      };
    }
    // Area chosen.
    if (args.area && AREA_KEYS.includes(args.area)) {
      const list = await sherpas.listByArea(args.area);
      if (!list.length) return { status: 'none', area: args.area };
      pushSherpaList(ctx, list, `Mentors for ${areaLabel(args.area)}. Tap one to view and book:`);
      return { status: 'ok', area: args.area, shown: list.length, note: LIST_SHOWN_NOTE };
    }
    // Default: show the area picker.
    return showAreas(ctx);
  },

  async get_sherpa(args, ctx) {
    const s = await sherpas.getBySlug(args.slug);
    if (!s) return { status: 'none' };
    pushSherpaCard(ctx, s);
    return { status: 'shown', name: s.name, booking_url: s.booking_url, note: SHERPA_SHOWN_NOTE };
  },
};

const SHERPA_SHOWN_NOTE =
  "Your text reply is sent FIRST, then the mentor's card, a 'Book a slot' button that opens their calendar directly, and a Prep doc / More mentors row appear right below it. Open with a warm, helpful lead-in (1-2 short sentences, build3 tone): affirm it's a solid pick and tell them to tap Book a slot to pick a time. Do NOT repeat the mentor's details or list other mentors.";

function pushProfile(ctx, f) {
  ctx.outbox.push({ kind: 'image', url: fmt.avatarFor(f), caption: fmt.profileCaption(f) });
}

/** Push the expertise-area picker list. */
async function showAreas(ctx) {
  const areas = await sherpas.listAreas();
  ctx.outbox.push({
    kind: 'list',
    header: 'Mentor Hours',
    body: 'Book free 1:1 mentor hours with a build3 Sherpa. Pick an area to see who can help:',
    button: 'Choose an area',
    rows: areas.map(fmt.areaRow),
  });
  ctx.state.last_results = []; // not a founder list - disable founder ordinal pick
  return { status: 'areas', count: areas.length, note: LIST_SHOWN_NOTE };
}

/** Push a list of mentors and remember their slugs for a typed ("2") selection. */
function pushSherpaList(ctx, list, body) {
  ctx.outbox.push({
    kind: 'list',
    header: 'Mentor Hours',
    body,
    button: 'View mentor',
    rows: list.map(fmt.sherpaRow),
  });
  ctx.state.last_results = []; // not a founder list
  ctx.state.sherpa_results = list.map((s) => s.slug);
}

/**
 * Two messages:
 *  1. A rich card (photo header + name/expertise/LinkedIn) whose built-in
 *     "Book a slot" button opens the mentor's calendar DIRECTLY (one tap, no
 *     intermediate message) - a CTA-URL message with an image header.
 *  2. A Prep doc / More mentors button row. prep:/area: handlers live in
 *     handler.routeReply.
 */
function pushSherpaCard(ctx, s) {
  ctx.outbox.push({
    kind: 'cta',
    headerImage: fmt.avatarFor(s),
    body: fmt.sherpaCard(s),
    title: 'Book a slot',
    url: s.booking_url,
  });
  ctx.outbox.push({
    kind: 'buttons',
    body: 'Grab the prep doc before your call, or see other mentors 👇',
    buttons: [
      { id: `prep:${s.slug}`, title: 'Prep doc' },
      { id: `area:${(s.areas && s.areas[0]) || 'gtm'}`, title: 'More mentors' },
    ],
  });
}

module.exports = { definitions, impls, pushProfile, pushSherpaCard, hasAnyFilter, toFilters };
