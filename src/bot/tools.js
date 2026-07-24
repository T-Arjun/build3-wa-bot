'use strict';

const founders = require('../domain/founders');
const { findCofounders } = require('../domain/matching');
const mentors = require('../domain/mentors');
const perks = require('../domain/perks');
const fmt = require('./format');
const { SECTORS, STARTUP_STAGES, LOOKING_FOR } = require('../domain/enums');
const { AREA_KEYS, areaLabel } = require('../domain/mentorAreas');
const { CATEGORY_KEYS, categoryLabel } = require('../domain/perkCategories');
const { editDistance } = require('../domain/geo');
const { isHedgedSelfClaim, cityIsSelf } = require('./intent');

const TOO_BROAD = 50;

// Deterministic backstop for set_self_profile (real observed failure): asked
// "your own background?", a founder replying "little bit tech" got locked in
// as skills:["engineering"] - a firm, categorical tag from language the user
// themselves hedged. Every downstream match caption then stated "directly
// complements your engineering" as fact, off an assumption nobody confirmed.
// The model's own free-text -> category judgment can't be trusted to flag its
// own uncertainty (same doctrine as widenedSearchDisclosure not trusting the
// model to disclose a dropped filter) - so this checks the RAW user text
// directly, independent of whatever confident label the model chose.
// Self-vs-want resolution (hedged self-claims, and whether a named city belongs
// to the user or the person they want) lives in ./intent - one tested place,
// consulted here, instead of ad-hoc regexes patched one phrasing at a time.

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
          themes: {
            type: 'array',
            minItems: 2,
            items: {
              type: 'object',
              properties: {
                label: { type: 'string', description: 'what the user called this area, e.g. "real estate development"' },
                sector: { type: 'string', enum: SECTORS },
                query: { type: 'string', description: 'free-text keyword fallback when no sector fits, e.g. "invest"' },
              },
              required: ['label'],
              additionalProperties: false,
            },
            description:
              'Use when the user names MULTIPLE distinct areas for "my space" in ONE ask (e.g. "education and real estate", "fintech and healthcare") - pass every area here in a SINGLE call instead of calling search_founders once per area. Do NOT also set sector/city/query on this same call when using themes.',
          },
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
        "Record what the USER says about THEMSELVES - their OWN name, skills, sector, city, stage, or role - so cofounder matches are scored as complementary to them (not just filtered) and so we can greet them by name going forward. Call this whenever the user reveals their own background, e.g. \"I'm a technical founder\", \"I can do sales and growth\", \"I'm building a fintech in Bangalore\", or tells you their name. This is about the user themselves, NOT about who they are looking for.",
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: "the user's own first name, once they've told you" },
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
      name: 'list_mentors',
      description:
        'Browse build3\'s mentors (experienced founders/operators who guide 1:1) to book mentor hours. Call with NO args to show the expertise areas; with `area` to list mentors in one area; with `query` to surface mentors for a topic the founder needs help with (e.g. "pricing", "hiring", "fundraising").',
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
      name: 'send_prep_doc',
      description:
        'Send the mentor-session prep doc link (plus the post-call feedback form link) to the user. Call this whenever they ask for the prep doc, what to prepare, or how to get ready for a mentor call. Never describe or promise the doc without calling this.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_mentor',
      description:
        "Show one mentor's profile card with their booking link and the prep-doc / feedback reminders. Use the slug from a list_mentors result.",
      parameters: {
        type: 'object',
        properties: {
          slug: { type: 'string' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_perks',
      description:
        'Browse build3\'s startup perks & credits (free/discounted SaaS credits, tools, coworking, hiring - negotiated for build3 founders to save money and stretch runway). Call with NO args to show the perk categories; with `category` to list perks in one category; with `query` to surface perks for a need the founder describes (e.g. "cloud credits", "CRM", "payments", "design tool", "coworking").',
      parameters: {
        type: 'object',
        properties: {
          category: { type: 'string', enum: CATEGORY_KEYS, description: 'category to list perks for' },
          query: { type: 'string', description: 'free-text need the founder has' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_perk',
      description:
        "Show one perk's full details, including how to redeem it (link, email, or steps). Use the slug from a list_perks result.",
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

const MATCH_SHOWN_NOTE =
  'Your text reply is sent FIRST, then the match cards appear below it as photo cards, and each card ALREADY carries their LinkedIn link at the bottom - the user can reach out right away, no follow-up needed. Each card ALSO already discloses that specific person\'s real cofounder-seeking status in parentheses (some are actively building and open to it, some haven\'t said either way, some are only open to joining rather than co-founding) - this varies PER PERSON in the batch, so do NOT assert in your lead-in that "these are all actively seeking a cofounder" or similar; a neutral framing ("worth a look" / "a few people worth reaching out to") is safer than a blanket claim, and never repeat or restate what a card\'s status line already says. Photo cards are NOT tappable - NEVER tell the user to "tap the card", and never say you\'ll "pull up their LinkedIn" as if it takes another step - it\'s already on the card they\'re looking at. Write a warm 1-2 line lead-in (why these people); you may still offer their FULL profile (photo, all details) on request. If the user\'s message asked anything else too, answer that part in the same reply.';

const LIST_SHOWN_NOTE =
  'Your text reply is sent FIRST, then the interactive list/cards appear right below it. Write a warm, helpful lead-in (1-2 short sentences, build3 tone) that frames what they are about to see and invites them to tap. Do NOT enumerate or repeat the names/items - the list already shows them; repeating them is the mistake to avoid. IMPORTANT: if the user\'s message also asked something ELSE besides this search (another question or need), answer that part too in the same reply, even in one line; never silently drop a part of their message.';

/**
 * Deterministic, honest lead-in for a cofounder match that had to widen past
 * the sector/city the user actually asked for. Sent as a real message from
 * the CODE, not left to the model - a text `note` asking it to "disclose this
 * honestly" was tried first and the model did not reliably comply live (e.g.
 * calling a widened-past-fintech match "a fintech cofounder match" for an
 * unrelated sector). Cofounder-intent honesty (blank/service-provider/etc.)
 * is a separate, per-candidate concern now handled on each card itself - see
 * matching.js's lookingForStatus and format.js's matchCaption.
 */
function widenedSearchDisclosure(dropped, filters) {
  const droppedBits = [];
  if (dropped.includes('city') && filters.city) droppedBits.push(filters.city);
  if (dropped.includes('sector') && filters.sector) droppedBits.push(filters.sector);
  const droppedText = droppedBits.join(' + ');

  return droppedText
    ? `no strong ${droppedText} match, so here's from the wider community instead:`
    : "here's from the wider community instead:";
}

/**
 * Real observed failure (919910811300, "startup education and investing, and
 * real estate development"): each named area fired its own search_founders
 * call, producing two silo list bubbles for what the user asked as ONE space.
 * This unions all named themes, then decides honestly: if a founder's profile
 * genuinely spans 2+ named themes, show ONE ranked list (cross-cutting people
 * first); if the themes are genuinely disjoint in this community, show them
 * as separate lists with a plain disclaimer that nothing spans both.
 */
async function searchFoundersMultiTheme(rawThemes, ctx) {
  const themes = rawThemes.map((t) => ({ label: t.label, sector: t.sector, query: t.query }));
  const result = await founders.searchFoundersByThemes(themes, 10);

  if (result.overlap) {
    if (!result.results.length) {
      return { status: 'none', note: 'Nothing matched across these themes even combined. Say so plainly and offer to broaden.' };
    }
    ctx.outbox.push({
      kind: 'list',
      body: `found ${result.count}${result.count > result.results.length ? ` · showing the top ${result.results.length}` : ''} · tap one to view:`,
      button: 'View founders',
      rows: result.results.map(fmt.toRow),
    });
    const shownSlugs = result.results.map((f) => f.source_slug);
    ctx.state.last_results = Array.isArray(ctx.state.last_results)
      ? [...ctx.state.last_results, ...shownSlugs]
      : shownSlugs;
    ctx.state.topic_changed = true;
    return {
      status: 'ok',
      count: result.count,
      shown: result.results.length,
      note:
        'These named areas overlap in real profiles, so ONE list was shown spanning all of them, led by whoever\'s profile genuinely spans the most areas. Do not describe it as several separate searches. ' +
        LIST_SHOWN_NOTE,
    };
  }

  const nonEmpty = result.groups.filter((g) => g.results.length);
  if (!nonEmpty.length) {
    return { status: 'none', note: 'Nothing matched any of these named areas. Say so plainly and offer to broaden.' };
  }
  let allShown = [];
  for (const g of nonEmpty) {
    ctx.outbox.push({
      kind: 'list',
      body: `${g.theme.label}: found ${g.results.length} · tap one to view:`,
      button: 'View founders',
      rows: g.results.map(fmt.toRow),
    });
    allShown = allShown.concat(g.results.map((f) => f.source_slug));
  }
  ctx.state.last_results = Array.isArray(ctx.state.last_results)
    ? [...ctx.state.last_results, ...allShown]
    : allShown;
  ctx.state.topic_changed = true;
  return {
    status: 'ok',
    note:
      `No founder in the community spans BOTH ${nonEmpty.map((g) => g.theme.label).join(' and ')} at once - these are genuinely separate areas here. Say that plainly in one honest sentence, then let the ${nonEmpty.length} lists above speak for themselves. ` +
      LIST_SHOWN_NOTE,
  };
}

/** Tool implementations. Each receives (args, ctx) and returns a summary object for the model. */
const impls = {
  async search_founders(args, ctx) {
    if (Array.isArray(args.themes) && args.themes.length >= 2) {
      return searchFoundersMultiTheme(args.themes, ctx);
    }
    let filters = toFilters(args);
    let count = await founders.countFounders(filters);
    let broadened = null;
    if (count === 0) {
      // Deterministic auto-broadening: a narrow combo (city that described the
      // USER, or long free-text) must not become a false "nobody in the
      // community". Drop the narrowest constraint first and retry, so the user
      // gets "none in Jaipur, but across India:" instead of three dead ends.
      const attempts = [];
      if (filters.city) attempts.push({ alt: { ...filters, city: undefined }, dropped: `the "${filters.city}" location filter` });
      if (filters.query) attempts.push({ alt: { ...filters, query: undefined }, dropped: `the "${filters.query}" keyword` });
      if (filters.city && filters.query) {
        attempts.push({ alt: { ...filters, city: undefined, query: undefined }, dropped: `both the "${filters.city}" location and the "${filters.query}" keyword` });
      }
      for (const { alt, dropped } of attempts) {
        if (!hasAnyFilter(alt)) continue; // never silently widen to the whole directory
        const c = await founders.countFounders(alt);
        if (c > 0) {
          filters = alt;
          count = c;
          broadened = dropped;
          break;
        }
      }
      if (count === 0) {
        // A short query that matches a mentor's name ("arvind") means they were
        // probably asking for a person who is a mentor, not a founder.
        if (args.query && String(args.query).trim().split(/\s+/).length <= 2) {
          const mentor = await mentorByName(args.query);
          if (mentor) {
            pushMentorCard(ctx, mentor);
            return { status: 'shown_mentor', name: mentor.name, note: MENTOR_SHOWN_NOTE };
          }
        }
        return {
          status: 'none',
          note:
            'Nothing matched even after broadening. Say "nothing under that exact search" and offer the nearest pivot (adjacent sector, all of India). NEVER claim the community has no such founders; you searched a phrase, not the community.',
        };
      }
    }
    if (count > TOO_BROAD && !hasAnyFilter(filters)) {
      return { status: 'too_broad', count };
    }
    let results = await founders.searchFounders(filters, 10);
    // "People like the person on screen" must not return that same person.
    if (ctx.focusSlug && results.length > 1) {
      const before = results.length;
      results = results.filter((f) => f.source_slug !== ctx.focusSlug);
      if (results.length < before) count = Math.max(results.length, count - 1);
    }
    // Exactly one founder → show the profile directly. A 1-row "tap to view" list
    // is clunky, and this also covers the case where duplicate rows dedupe to one.
    if (results.length === 1) {
      pushProfile(ctx, results[0]);
      ctx.state.focus = fmt.focusFields(results[0]);
      return {
        status: 'shown',
        name: results[0].name,
        facts: ctx.state.focus,
        ...(broadened ? { broadened: `The exact search had zero results; this person comes from automatically dropping ${broadened}. Say so plainly.` } : {}),
        note: SHOWN_NOTE,
      };
    }
    ctx.outbox.push({
      kind: 'list',
      body: `found ${count}${count > results.length ? ` · showing the top ${results.length}` : ''} · tap one to view:`,
      button: 'View founders',
      rows: results.map(fmt.toRow),
    });
    // Multiple search_founders calls can fire in ONE turn (multi-sector /
    // multi-location, per the prompt's one-call-per-place rule) - each pushes
    // its own list bubble. APPEND rather than overwrite so a typed ordinal
    // ("the 3rd one") resolves against the COMBINED, top-to-bottom set the user
    // actually sees. Real observed failure (919910811300, "education +
    // investing + real estate development"): two lists were sent but
    // last_results held only the SECOND list's slugs, so a typed "3" would have
    // opened the 3rd built-environment founder, not the 3rd education one the
    // user meant. Taps (replyId) were unaffected - the id carries the slug -
    // which is why it only bites the typed-number path. ctx.state is fresh per
    // turn, so this only ever unions lists shown within the same turn.
    const shownSlugs = results.map((f) => f.source_slug);
    ctx.state.last_results = Array.isArray(ctx.state.last_results)
      ? [...ctx.state.last_results, ...shownSlugs]
      : shownSlugs;
    ctx.state.topic_changed = true;
    return {
      status: 'ok',
      count,
      shown: results.length,
      ...(broadened ? { broadened: `The exact search had zero results, so this list comes from automatically dropping ${broadened}. Tell the user plainly in your lead-in (e.g. "none in Jaipur specifically, but across the community:").` } : {}),
      note: LIST_SHOWN_NOTE,
    };
  },

  async get_profile(args, ctx) {
    const shownNote = SHOWN_NOTE;
    // Deterministic override (don't rely on the model alone - it has repeatedly
    // picked get_profile over list_mentors for explicit booking language, e.g.
    // "book anshu's calendar" -> get_profile("Anshu") -> disambiguated against
    // an unrelated FOUNDER, never surfacing the actual mentor named Anshu).
    // Explicit booking words mean they want a mentor, not a directory founder -
    // check the mentor roster first and short-circuit straight to their card.
    const bookingIntent = /\b(book(?:ing)?|calendar|schedule|slot|mentor)\b/i.test(ctx.rawText || '');
    if (bookingIntent && (args.name || args.slug)) {
      const mentor = await mentorByName(args.name || args.slug);
      if (mentor) {
        pushMentorCard(ctx, mentor);
        return { status: 'shown_mentor', name: mentor.name, note: MENTOR_SHOWN_NOTE };
      }
    }
    // The person whose card is ALREADY on screen (focus) never gets re-sent:
    // answer from facts instead. Kills the "asks for similar people, receives
    // the same card again" duplicate.
    const alreadyShown = (f) => ({
      status: 'already_on_screen',
      name: f.name,
      facts: fmt.focusFields(f),
      note: 'This person\'s card is ALREADY on the user\'s screen from earlier - it was NOT re-sent. Answer from the facts; do not describe a new card.',
    });
    if (args.slug) {
      const f = await founders.getBySlug(args.slug);
      if (!f) return { status: 'none' };
      if (ctx.focusSlug && f.source_slug === ctx.focusSlug) return alreadyShown(f);
      pushProfile(ctx, f);
      ctx.state.focus = fmt.focusFields(f);
      return { status: 'shown', name: f.name, facts: ctx.state.focus, note: shownNote };
    }
    const matches = await founders.findByName(args.name || '', 5);
    if (matches.length === 1 && ctx.focusSlug && matches[0].source_slug === ctx.focusSlug) {
      return alreadyShown(matches[0]);
    }
    if (matches.length === 0) {
      // Not a founder - but it may be one of the 13 mentors ("that Arvind guy").
      // Never tell the user a person "doesn't exist" when they're a mentor.
      const mentor = await mentorByName(args.name);
      if (mentor) {
        pushMentorCard(ctx, mentor);
        return { status: 'shown_mentor', name: mentor.name, note: MENTOR_SHOWN_NOTE };
      }
      return { status: 'none', query: args.name };
    }
    // A fuzzy/typo-corrected match is a GUESS, never a confirmed identity -
    // even when there's only one candidate. Always confirm before asserting
    // facts about a person we're not sure is who they meant (a confident wrong
    // answer is worse than one extra tap). Exact/substring matches are trusted
    // and still auto-show when there's exactly one.
    const isGuess = matches.every((f) => f._fuzzy);
    if (matches.length === 1 && !isGuess) {
      pushProfile(ctx, matches[0]);
      ctx.state.focus = fmt.focusFields(matches[0]);
      return { status: 'shown', name: matches[0].name, facts: ctx.state.focus, note: shownNote };
    }
    const body =
      isGuess && matches.length === 1
        ? `did you mean ${matches[0].name}?`
        : isGuess
          ? "didn't find an exact match - did you mean one of these?"
          : 'found a couple of people - which one did you mean?';
    ctx.outbox.push({ kind: 'list', body, button: 'Choose', rows: matches.map(fmt.toRow) });
    // Remember the candidates: enables the typed-ordinal pick ("the first
    // one") AND next turn's deterministic entity grounding. Without this, a
    // follow-up like "give me pranav's contact" had NO grounded candidates,
    // and the model fabricated a plausible-looking (broken) LinkedIn URL.
    ctx.state.last_results = matches.map((f) => f.source_slug);
    return {
      status: 'ambiguous',
      candidates: matches.map((f) => `${f.name} (${fmt.subtitle(f) || 'no details'})`),
      note: isGuess
        ? 'These are spelling-guess candidates for a name that had no exact match, NOT confirmed. Your reply must ask "did you mean X?" (or list the guesses) - never assert facts about them yet.'
        : undefined,
    };
  },

  async find_cofounders(args, ctx) {
    const filters = toFilters(args);
    // Recover a city the model mentioned but misfiled onto set_self_profile
    // instead of passing here (see isLikelyCofounderCityNotSelf above) - same
    // turn, same shared ctx, so if set_self_profile ran first (the observed
    // order) its extracted city is sitting right here waiting to be used
    // instead of silently vanishing.
    if (!filters.city && ctx.suspectCofounderCity) filters.city = ctx.suspectCofounderCity;
    // No hard "need criteria" gate - a broad search returns sensible results
    // regardless of who's explicitly marked themselves as cofounder-seeking
    // (looking_for is never a pool gate - see cofounderCandidates). The engine
    // clarifies at most once at the conversation layer; once the user wants
    // results, we always show some.
    let { results, poolSize, tooFew, noHardMatch } = await findCofounders(filters, ctx.requesterSlug, ctx.self);
    let dropped = [];
    // Deterministic backstop (don't rely on the model alone - it has repeated
    // this exact mistake live, MULTIPLE times now: dropping a filter and then
    // describing the widened result AS IF it still matched the dropped
    // criterion, e.g. "found a fintech cofounder match" for a respiratory-
    // sensor founder once sector was silently dropped. The tool used to pass
    // only a text `note` asking the model to disclose this honestly - it
    // doesn't reliably comply live, so the disclosure is now a directly
    // pushed message, not a suggestion). city AND sector are the #1
    // false-empty causes, because they very often describe the USER's OWN
    // startup (leaked in via set_self_profile) rather than a real requirement
    // on the cofounder - "I run a d2c brand" does not mean the cofounder must
    // also be d2c. Before reporting "no matches" at all, progressively drop
    // city then sector (the skill they actually asked for is NEVER dropped)
    // and use the first level that produces a real pool. Never manufacture a
    // false "nobody exists" from a filter the person likely didn't mean to
    // put on the OTHER person.
    if ((poolSize === 0 || results.length === 0) && (filters.city || filters.sector)) {
      const attempts = [];
      if (filters.city) attempts.push({ city: undefined, label: filters.city });
      if (filters.sector) attempts.push({ sector: undefined, label: filters.sector });
      if (filters.city && filters.sector) attempts.push({ city: undefined, sector: undefined, label: `${filters.city}/${filters.sector}` });
      for (const { label, ...drop } of attempts) {
        const wider = await findCofounders({ ...filters, ...drop }, ctx.requesterSlug, ctx.self);
        if (wider.poolSize > 0 && wider.results.length > 0) {
          ({ results, poolSize, tooFew, noHardMatch } = wider);
          dropped = Object.keys(drop);
          break;
        }
      }
    }
    ctx.state.topic_changed = true;
    if (poolSize === 0 || results.length === 0) {
      return { status: 'too_few', poolSize };
    }
    // Drop people ACTUALLY SHOWN as cards in a previous turn so "find another"
    // doesn't re-paste identical cards. ctx.prevMatchSlugs (see handler.js) is
    // built from draft.shown_match_slugs, an accumulating set of slugs that
    // were genuinely pushed as image cards - NOT draft.match_cache, which also
    // holds everyone merely scored >=floor for a DIFFERENT earlier search's
    // pagination (see the match_cache assignment below). Real observed
    // failure from conflating the two: a person who scored 65 in a broad
    // "sales cofounders" search (held in that search's match_cache for
    // "more:matches" pagination, but never actually shown - only the top 3
    // were) then vanished entirely from a LATER, narrower "sales cofounder in
    // Delhi" search where they were the #1 scorer, because their slug was
    // still sitting in the stale match_cache from the unrelated broad search.
    const prevShown = new Set(ctx.prevMatchSlugs || []);
    const freshAll = results.filter((m) => !prevShown.has(m.slug));
    if (freshAll.length === 0) {
      return {
        status: 'no_new_matches',
        total: results.length,
        note: "Everyone matching these EXACT criteria was already shown. Do NOT dead-end and do NOT re-send their cards. Offer to WIDEN the pool (a nearby city, open-to-remote, or an adjacent sector) while KEEPING the core skill/role they asked for. Never suggest switching to a different core skill.",
      };
    }
    // Never present a genuinely WEAK candidate as a "match" - a card labelled
    // "· 20/100 match" actively destroys trust in the whole matching product
    // (real observed failure: 20/100 and 30/100 cards shipped as "matches").
    // Drop anything below the floor (the "limited overlap"/"mismatch" bands);
    // results are already sorted best-first. If EVERYONE is weak, show only the
    // single best and flag it so the reply is honest ("closest i found, not a
    // strong fit") rather than padding the screen with poor cards.
    const MATCH_FLOOR = 40;
    const strong = freshAll.filter((m) => (m.score ?? 0) >= MATCH_FLOOR);
    const weakOnly = strong.length === 0;
    const fresh = weakOnly ? freshAll.slice(0, 1) : strong;
    if (dropped.length) {
      ctx.outbox.push({ kind: 'text', body: widenedSearchDisclosure(dropped, filters) });
    }
    const top = fresh.slice(0, 3);
    for (const m of top) {
      ctx.outbox.push({ kind: 'image', url: fmt.avatarFor(m), caption: fmt.matchCaption(m) });
    }
    // Record everyone in this fresh set for THIS search's own pagination
    // ("more:matches"/"show them all" page through the rest of `fresh`), even
    // though only the top 3 are on screen now. This is deliberately broader
    // than "shown" - see shown_match_slugs below for the actually-displayed set.
    ctx.state.last_results = fresh.map((m) => m.slug);
    ctx.state.match_cache = fresh;
    // The slugs ACTUALLY pushed as cards this turn - this, not match_cache, is
    // what the NEXT (possibly differently-filtered) find_cofounders call should
    // treat as "already shown, don't repeat" (see prevShown above and
    // handler.js's draft.shown_match_slugs).
    ctx.state.shown_match_slugs = top.map((m) => m.slug);
    if (fresh.length > 3) {
      ctx.outbox.push({
        kind: 'buttons',
        body: `${fresh.length - 3} more match${fresh.length - 3 === 1 ? '' : 'es'} available.`,
        buttons: [{ id: 'more:matches', title: 'More matches' }],
      });
    }
    const weakNote = weakOnly
      ? 'This is NOT a strong match - it is the closest person available and everyone else scored too low to show. Say so honestly in your lead-in ("no strong fit for that exact ask, but the closest is...") instead of overselling it. '
      : '';
    // Never show ZERO candidates just because nobody meets a stated hard
    // requirement (skill/sector) exactly - findCofounders already fell back to
    // the full pool instead of returning empty (see matching.js noHardMatch).
    // The disclaimer is the honest part: say plainly that nobody matched the
    // exact ask, these are the closest available, same doctrine as weakNote.
    const reqParts = [];
    if (filters.skills?.length) reqParts.push(filters.skills.join('/'));
    if (filters.sector) reqParts.push(filters.sector);
    const noHardMatchNote = noHardMatch
      ? `Nobody in the directory exactly matches the requested ${reqParts.join(' + ') || 'requirement'} - these are the closest people available, not exact fits. Say so plainly in your lead-in instead of implying they meet the requirement. `
      : '';
    return {
      status: 'ok',
      widened: dropped.length ? dropped : undefined,
      weakOnly: weakOnly || undefined,
      noHardMatch: noHardMatch || undefined,
      shown: top.length,
      total: fresh.length,
      tooFew: fresh.length < 3,
      // The honest "this is widened / not an exact match" disclosure is now a
      // message the CODE already sent (see widenedSearchDisclosure above) -
      // this note only needs to stop the model from re-describing the result
      // as matching the dropped criterion in its own lead-in line.
      note:
        weakNote +
        noHardMatchNote +
        (dropped.length
          ? `The disclosure above ALREADY told them this widened past ${dropped.join('/')} - do not also claim the results match ${dropped.join(' or ')} in your reply. ${MATCH_SHOWN_NOTE}`
          : MATCH_SHOWN_NOTE),
    };
  },

  async set_self_profile(args, ctx) {
    const self = { ...(ctx.self || {}) };
    if (args.name) self.name = args.name;
    if (Array.isArray(args.skills) && args.skills.length) {
      self.skills = args.skills;
      // Hedge check runs only when skills are actually being (re)set this turn -
      // a later turn with a clear, confident restatement should be able to
      // upgrade confidence back to firm, not stay soft forever from one hedge.
      self.skillConfidence = isHedgedSelfClaim(ctx.rawText) ? 'soft' : 'firm';
    }
    if (args.sector) self.sector = args.sector;
    if (args.city) {
      if (cityIsSelf(ctx.rawText, args.city)) {
        self.city = args.city;
      } else {
        // The city describes the WANTED cofounder, not the user (e.g. "find me
        // a tech cofounder in bangalore"). Don't overwrite the user's own
        // (possibly different, already-known) city - hand it to a
        // find_cofounders call in this SAME turn that forgot to pass its own
        // city filter (the other half of this live failure).
        ctx.suspectCofounderCity = args.city;
      }
    }
    if (args.stage) self.stage = args.stage;
    if (args.role) self.role = args.role;
    ctx.self = self; // a find_cofounders call in this SAME turn picks it up
    ctx.state.self = self; // persisted by the handler for the rest of the session
    return {
      status: 'saved',
      self,
      note: 'Saved their background (silent bookkeeping - NEVER make "got your profile set" the reply). Now answer what they actually ASKED: if they asked for people or a cofounder, call the right search tool in this same turn. If you searched, your reply frames the results, not the profile save. Do not ask for this info again.',
    };
  },

  async list_mentors(args, ctx) {
    // Topic search: "who can help with pricing?" / proactive suggestion path.
    if (args.query && !args.area) {
      const matches = await mentors.searchByExpertise(args.query);
      if (matches.length === 1) {
        pushMentorCard(ctx, matches[0]);
        return { status: 'shown', name: matches[0].name, note: MENTOR_SHOWN_NOTE };
      }
      if (matches.length > 1) {
        pushMentorList(ctx, matches, 'mentors who can help with that. tap one to view and book:');
        return { status: 'ok', shown: matches.length, note: LIST_SHOWN_NOTE };
      }
      // No mentor literally lists that topic - don't show the area picker yet;
      // nudge the model to retry with the closest area so only ONE list renders.
      return {
        status: 'no_topic_match',
        note: 'No mentor explicitly lists that topic. Call list_mentors again with the closest `area` from the enum; do not reply to the user yet.',
        areas: AREA_KEYS,
      };
    }
    // Area chosen.
    if (args.area && AREA_KEYS.includes(args.area)) {
      const list = await mentors.listByArea(args.area);
      if (!list.length) return { status: 'none', area: args.area };
      pushMentorList(ctx, list, `mentors for ${areaLabel(args.area)}. tap one to view and book:`);
      return { status: 'ok', area: args.area, shown: list.length, note: LIST_SHOWN_NOTE };
    }
    // Default: show the area picker.
    return showAreas(ctx);
  },

  async get_mentor(args, ctx) {
    const s = await mentors.getBySlug(args.slug);
    if (!s) return { status: 'none' };
    pushMentorCard(ctx, s);
    return { status: 'shown', name: s.name, booking_url: s.booking_url, note: MENTOR_SHOWN_NOTE };
  },

  async send_prep_doc(args, ctx) {
    ctx.outbox.push({ kind: 'text', body: fmt.prepMessage() });
    return {
      status: 'sent',
      note: 'The prep-doc link and the post-call feedback link have been sent as a message right below yours. Confirm in one warm line; do NOT restate or re-list the links.',
    };
  },

  async list_perks(args, ctx) {
    // Need search: "any cloud credits?" / "we need a CRM" / proactive path.
    if (args.query && !args.category) {
      const matches = await perks.searchByText(args.query);
      if (matches.length === 1) {
        pushPerkCard(ctx, matches[0]);
        return { status: 'shown', name: matches[0].name, note: PERK_SHOWN_NOTE };
      }
      if (matches.length > 1) {
        const capped = matches.slice(0, 10);
        pushPerkList(ctx, capped, 'perks that could help with that. tap one for how to get it:');
        return { status: 'ok', shown: capped.length, note: LIST_SHOWN_NOTE };
      }
      // Nothing matched that need - nudge the model to the category picker
      // rather than dead-ending or inventing a perk we don't have.
      return {
        status: 'no_perk_match',
        note: 'No perk matches that need. Call list_perks again with NO args to show the category picker; do not invent a perk or claim one exists.',
        categories: CATEGORY_KEYS,
      };
    }
    // Category chosen.
    if (args.category && CATEGORY_KEYS.includes(args.category)) {
      const list = await perks.listByCategory(args.category);
      if (!list.length) return { status: 'none', category: args.category };
      pushPerkList(ctx, list, `${categoryLabel(args.category)} perks. tap one for how to get it:`);
      return { status: 'ok', category: args.category, shown: list.length, note: LIST_SHOWN_NOTE };
    }
    // Default: show the category picker.
    return showCategories(ctx);
  },

  async get_perk(args, ctx) {
    const p = await perks.getBySlug(args.slug);
    if (!p) return { status: 'none' };
    pushPerkCard(ctx, p);
    return { status: 'shown', name: p.name, access_url: p.access_url || undefined, note: PERK_SHOWN_NOTE };
  },
};

const MENTOR_SHOWN_NOTE =
  "Your text reply is sent FIRST, then the mentor's card, a 'Book a slot' button that opens their calendar directly, and a Prep doc / More mentors row appear right below it. Open with a warm lead-in (1-2 short lowercase sentences, build3 tone) affirming the pick. Do NOT repeat the mentor's details, do NOT list other mentors, and do NOT offer the prep doc in your text (the Prep doc button is right there).";

/**
 * Resolve a person-name mention to exactly one mentor, or null. Guards the
 * "that Arvind guy doesn't exist" failure: a name that misses the founder
 * directory is checked against the Mentors before anyone says "not found".
 */
async function mentorByName(name) {
  const nameLc = String(name || '').toLowerCase().trim();
  const firstToken = nameLc.split(/\s+/)[0] || '';
  if (!firstToken) return null;
  const hits = (await mentors.searchByExpertise(nameLc)).filter((s) =>
    s.name.toLowerCase().includes(firstToken),
  );
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) return null;
  // Nothing by exact substring: try a typo-tolerant pass, same doctrine as
  // founders.js's fuzzyByName ("umaier" -> "Umair Tariq") - real observed
  // failure: "ayushman" (one letter short) found nothing for the real mentor
  // "Ayushmaan Kapoor". Mentors are a small, fixed roster (a dozen-ish, not
  // hundreds like founders), so unlike founders' fuzzy pass this only
  // auto-resolves when there's exactly ONE candidate within a small edit
  // distance - with so few mentors, one unique near-match is reliably the
  // right person, not a coincidental collision worth a "did you mean?" step.
  if (firstToken.length < 4) return null;
  const maxD = firstToken.length > 6 ? 2 : 1;
  const all = await mentors.listAll();
  const near = all.filter((s) => {
    const words = s.name.toLowerCase().split(/\s+/).filter(Boolean);
    return words.some((w) => Math.abs(w.length - firstToken.length) <= maxD && editDistance(firstToken, w) <= maxD);
  });
  return near.length === 1 ? near[0] : null;
}

function pushProfile(ctx, f) {
  ctx.outbox.push({ kind: 'image', url: fmt.avatarFor(f), caption: fmt.profileCaption(f) });
}

/** Push the expertise-area picker list. */
async function showAreas(ctx) {
  const areas = await mentors.listAreas();
  ctx.outbox.push({
    kind: 'list',
    header: 'Mentor hours',
    body: '1:1 mentor hours: time with folks who have walked the path. pick an area to see who can help:',
    button: 'Choose an area',
    rows: areas.map(fmt.areaRow),
  });
  ctx.state.last_results = []; // not a founder list - disable founder ordinal pick
  return { status: 'areas', count: areas.length, note: LIST_SHOWN_NOTE };
}

/** Push a list of mentors and remember their slugs for a typed ("2") selection. */
function pushMentorList(ctx, list, body) {
  ctx.outbox.push({
    kind: 'list',
    header: 'Mentor hours',
    body,
    button: 'View mentor',
    rows: list.map(fmt.mentorRow),
  });
  ctx.state.last_results = []; // not a founder list
  ctx.state.mentor_results = list.map((s) => s.slug);
}

/**
 * Two messages:
 *  1. A rich card (photo header + name/expertise/LinkedIn) whose built-in
 *     "Book a slot" button opens the mentor's calendar DIRECTLY (one tap, no
 *     intermediate message) - a CTA-URL message with an image header.
 *  2. A Prep doc / More mentors button row. prep:/area: handlers live in
 *     handler.routeReply.
 */
function pushMentorCard(ctx, s) {
  ctx.outbox.push({
    kind: 'cta',
    headerImage: fmt.avatarFor(s),
    body: fmt.mentorCard(s),
    title: 'Book a slot',
    url: s.booking_url,
  });
  ctx.outbox.push({
    kind: 'buttons',
    body: 'grab the prep doc before your call, or see other mentors 👇',
    buttons: [
      { id: `prep:${s.slug}`, title: 'Prep doc' },
      { id: `area:${(s.areas && s.areas[0]) || 'gtm'}`, title: 'More mentors' },
    ],
  });
}

const PERK_SHOWN_NOTE =
  "Your text reply is sent FIRST, then the perk's full details (including exactly how to redeem it - link, email, or steps) appear right below it as a message, followed by a 'More perks' button. Open with a warm 1-2 line lowercase lead-in affirming the pick (build3 tone). Do NOT repeat the perk's details or the redemption steps - they're right there on the card. If a link or email is how they redeem, don't type it yourself; the card carries it.";

/** Push the perk-category picker list. */
async function showCategories(ctx) {
  const categories = await perks.listCategories();
  ctx.outbox.push({
    kind: 'list',
    header: 'Perks & credits',
    body: 'startup perks & credits build3 has lined up to save you money and stretch runway. pick a category:',
    button: 'Choose a category',
    rows: categories.map(fmt.categoryRow),
  });
  ctx.state.last_results = []; // not a founder list - disable founder ordinal pick
  return { status: 'categories', count: categories.length, note: LIST_SHOWN_NOTE };
}

/** Push a list of perks and remember their slugs for a typed ("2") selection. */
function pushPerkList(ctx, list, body) {
  ctx.outbox.push({
    kind: 'list',
    header: 'Perks & credits',
    body,
    button: 'View perk',
    rows: list.map(fmt.perkRow),
  });
  ctx.state.last_results = []; // not a founder list
  ctx.state.perk_results = list.map((p) => p.slug);
}

/**
 * Up to three messages:
 *  1. An overview text (name, objective, trimmed description).
 *  2. The "how to get it" text (link/email/steps) - a SEPARATE message so a long
 *     description can't push the redemption steps past WhatsApp's 1024 cap.
 *  Both are plain text, not a cta_url card, since several perks are email-only
 *  or multi-step (see format.perkCard / perkAccess).
 *  3. A "More perks" button row (back to the category picker). perkcat: handler
 *     lives in handler.routeReply.
 */
function pushPerkCard(ctx, p) {
  ctx.outbox.push({ kind: 'text', body: fmt.perkCard(p) });
  const access = fmt.perkAccess(p);
  if (access) ctx.outbox.push({ kind: 'text', body: access });
  ctx.outbox.push({
    kind: 'buttons',
    body: 'want to browse more perks? 👇',
    buttons: [{ id: `perkcat:${(p.categories && p.categories[0]) || 'cloud'}`, title: 'More perks' }],
  });
}

module.exports = {
  definitions,
  impls,
  pushProfile,
  pushMentorCard,
  pushPerkCard,
  hasAnyFilter,
  toFilters,
  widenedSearchDisclosure,
};
