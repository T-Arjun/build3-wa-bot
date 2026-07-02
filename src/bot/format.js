'use strict';

/**
 * Render founder records into WhatsApp-friendly text/rows.
 */

const { PREP_DOC_URL, FEEDBACK_FORM_URL } = require('../domain/sherpaAreas');

/**
 * Request a higher-resolution variant where the host supports it.
 * Google account photos (lh3.googleusercontent.com) carry a size suffix like
 * "=s96-c"; bumping it to s512 yields a much sharper image at no cost.
 */
function hiResAvatar(url) {
  if (!url) return url;
  if (url.includes('googleusercontent.com')) {
    if (/=s\d+(-c)?$/.test(url)) return url.replace(/=s\d+(-c)?$/, '=s512-c');
    if (/\/s\d+(-c)?\//.test(url)) return url.replace(/\/s\d+(-c)?\//, '/s512-c/');
    return url;
  }
  return url;
}

/** A brand-styled PNG placeholder avatar (WhatsApp-safe). */
function placeholderAvatar(name) {
  return `https://ui-avatars.com/api/?name=${encodeURIComponent(
    name || 'build3',
  )}&background=79c0a6&color=fff&bold=true&size=512&format=png`;
}

/**
 * WhatsApp image messages accept jpeg/png/webp only. Meta ACCEPTS an SVG (200)
 * then silently drops it, so the card never arrives and the tap looks dead. The
 * source data stores SVG links as avatars for photoless founders (ui-avatars
 * defaults to SVG, e.g. "...&size=200"), so we must normalize, not just fall
 * back on null: any ui-avatars or .svg URL is rebuilt as our PNG placeholder.
 */
// Hosts WhatsApp/Meta cannot fetch as an image: SVG generators, and LinkedIn's
// CDN which 403s hotlinks. Any of these -> our PNG placeholder so the card
// always renders (the source rehosts most photos to media-cdn.build3.in; these
// are the stragglers that would otherwise die on tap).
const UNUSABLE_AVATAR = /ui-avatars\.com|media\.licdn\.com|\.svg(\?|#|$)/i;

function avatarFor(f) {
  const url = realText(f.avatar_url);
  if (!url || UNUSABLE_AVATAR.test(url)) return placeholderAvatar(f.name);
  return hiResAvatar(url);
}

/**
 * Treat placeholder junk ("NA", "N/A", "-", "none", "tbd") as absent so cards
 * never render a literal *NA* where a startup name should be.
 */
function realText(s) {
  const t = String(s == null ? '' : s).trim();
  if (!t || /^(na|n\/a|n\.a\.?|none|nil|null|tbd|-{1,3}|\.+)$/i.test(t)) return null;
  return t;
}

function subtitle(f) {
  // COMPANY NAME first, always - founders identify each other by startup, not
  // sector. "build3: a startup ecosystem to ena… · Kudal". Idea alone is the
  // fallback when there's no name; skills/city are last resorts.
  // WhatsApp list rows hard-cap descriptions at 72 chars, so the "what" budget
  // adjusts to the city length (Thiruvananthapuram must not blow the limit).
  const location = f.city || null;
  const budget = Math.max(24, 72 - (location ? location.length + 3 : 0));
  const nameText = realText(f.startup_name);
  let ideaText = realText(f.startup_idea);
  // Ideas often restate the company ("XAGI Labs: XAGI Labs is an AI…") - strip
  // the leading name so the compact row reads "XAGI Labs: an AI research…".
  if (nameText && ideaText) {
    const esc = nameText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    ideaText = realText(ideaText.replace(new RegExp(`^${esc}[\\s:,-]*(is\\s+)?`, 'i'), '')) || ideaText;
  }
  let what = null;
  if (nameText && ideaText) what = truncate(`${nameText}: ${ideaText}`, budget);
  else if (nameText) what = truncate(nameText, budget);
  else if (ideaText) what = truncate(ideaText, budget);
  if (what) return location ? `${what} · ${location}` : what;
  const topSkills = (f.skills || []).slice(0, 2).join(', ');
  if (topSkills) return truncate(location ? `${topSkills} · ${location}` : topSkills, 72);
  return location || '';
}

function hasCohort(f) {
  return Number.isInteger(f.cohort) && f.cohort > 0;
}

/**
 * Shorten a person's name to fit WhatsApp's 24-char row-title cap with dignity:
 * drop middle names, then initial the surname ("Muralidharan Senthilkumaran" ->
 * "Muralidharan S."), instead of letting the API chop it mid-word ("…").
 */
function shortName(name, max = 24) {
  const n = String(name || '').trim();
  if (n.length <= max) return n;
  const parts = n.split(/\s+/);
  if (parts.length >= 2) {
    const firstLast = `${parts[0]} ${parts[parts.length - 1]}`;
    if (firstLast.length <= max) return firstLast;
    const initialed = `${parts[0]} ${parts[parts.length - 1][0]}.`;
    if (initialed.length <= max) return initialed;
  }
  return truncate(n, max);
}

/** A list row for search/disambiguation results. id encodes the profile action. */
function toRow(f) {
  return {
    id: `profile:${f.source_slug}`,
    title: shortName(f.name),
    description: subtitle(f) || (hasCohort(f) ? `Cohort ${f.cohort}` : ''),
  };
}

/** Full profile caption for an image card. Only includes fields that exist. */
function profileCaption(f) {
  const lines = [`*${f.name}*`];

  // Company name LEADS the meta line - it's how founders identify each other.
  const nameText = realText(f.startup_name);
  const meta = [nameText ? `*${nameText}*` : null, f.sector, f.city].filter(Boolean);
  if (hasCohort(f)) meta.push(`Cohort ${f.cohort}`);
  if (f.program) meta.push(f.program);
  if (meta.length) lines.push(meta.join(' · '));

  const ideaText = realText(f.startup_idea);
  // The company name already leads the meta line; the body is just the idea.
  if (ideaText) {
    lines.push('');
    lines.push(truncate(ideaText, 300));
  }

  if (f.startup_stage) lines.push(`Stage: ${f.startup_stage}`);
  if (f.skills?.length) lines.push(`Skills: ${f.skills.slice(0, 8).join(', ')}`);
  if (f.looking_for?.length) lines.push(`Open to: ${f.looking_for.join(', ')}`);
  if (f.dharma) lines.push(`Archetype: ${f.dharma}`);
  if (f.linkedin_url) {
    lines.push('');
    lines.push(f.linkedin_url);
  }
  return lines.join('\n');
}

/** Compact, factual snapshot used to ground follow-up Q&A (prevents hallucination). */
function focusFields(f) {
  return {
    slug: f.source_slug || f.slug || null,
    name: f.name,
    sector: f.sector || null,
    city: f.city || null,
    cohort: hasCohort(f) ? f.cohort : null,
    startup_name: f.startup_name || null,
    startup_idea: f.startup_idea ? f.startup_idea.trim() : null,
    startup_stage: f.startup_stage || null,
    skills: f.skills || [],
    looking_for: f.looking_for || [],
    dharma: f.dharma || null,
    linkedin_url: f.linkedin_url || null,
  };
}

/** A single cofounder match block (used when sent as an image card caption). */
function matchCaption(m) {
  const lines = [`*${m.name}* - ${m.score}/100`];
  // Company name leads, then what they're building, then location.
  const ideaText = realText(m.startup_idea);
  const nameText = realText(m.startup_name);
  if (nameText) {
    lines.push(m.city ? `*${nameText}* · ${m.city}` : `*${nameText}*`);
    if (ideaText) lines.push(truncate(ideaText, 80));
  } else if (ideaText) {
    const idea = truncate(ideaText, 80);
    lines.push(m.city ? `${idea} · ${m.city}` : idea);
  } else if (m.city) {
    lines.push(m.city);
  }
  for (const r of m.reasons || []) lines.push(`• ${r}`);
  return lines.join('\n');
}

function truncate(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// ─── Sherpas (mentor hours) ──────────────────────────────────────────────────

/** A list row for a single mentor. id encodes the get-sherpa action. */
function sherpaRow(s) {
  return {
    id: `sherpa:${s.slug}`,
    title: shortName(s.name),
    description: truncate(s.expertise || '', 72),
  };
}

/** A list row for an expertise area. id encodes the list-by-area action. */
function areaRow(a) {
  return {
    id: `area:${a.key}`,
    title: a.label,
    description: `${a.count} sherpa${a.count === 1 ? '' : 's'}`,
  };
}

/** Booking message: the external link + the two program guardrails. */
function bookingMessage(s) {
  return [
    `📅 book a 1:1 with *${s.name}*:`,
    s.booking_url,
    '',
    `Before the call: copy & fill the prep doc, then share the link with them. ${PREP_DOC_URL}`,
    `After the call: a 2-min feedback form. ${FEEDBACK_FORM_URL}`,
  ].join('\n');
}

/** Prep-doc + feedback reminder, sent on its own (the "Prep doc" button). */
function prepMessage() {
  return [
    'make a copy of the founder talk prep doc, fill it out, and share the editable link with your sherpa before the call - it makes the session far more useful:',
    PREP_DOC_URL,
    '',
    'after the call, take 2 minutes to share feedback 🙏',
    FEEDBACK_FORM_URL,
  ].join('\n');
}

/** Mentor profile card caption for an image card. Omits fields that are absent. */
function sherpaCard(s) {
  const lines = [`*${s.name}*`];
  if (s.expertise) lines.push(s.expertise);
  if (s.bio) {
    lines.push('');
    lines.push(truncate(s.bio.trim(), 300));
  }
  if (s.linkedin_url) {
    lines.push('');
    lines.push(s.linkedin_url);
  }
  return lines.join('\n');
}

module.exports = {
  avatarFor,
  hiResAvatar,
  subtitle,
  shortName,
  toRow,
  profileCaption,
  matchCaption,
  focusFields,
  truncate,
  sherpaRow,
  areaRow,
  sherpaCard,
  bookingMessage,
  prepMessage,
};
