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

function avatarFor(f) {
  if (f.avatar_url) return hiResAvatar(f.avatar_url);
  const name = encodeURIComponent(f.name || 'build3');
  return `https://ui-avatars.com/api/?name=${name}&background=79c0a6&color=fff&bold=true&size=512`;
}

function subtitle(f) {
  // Describe by what they're building, not their sector tag.
  // Priority: startup idea snippet > startup name > skills > city alone.
  const location = f.city || null;
  if (f.startup_idea) {
    const idea = truncate(f.startup_idea.trim(), 60);
    return location ? `${idea} · ${location}` : idea;
  }
  if (f.startup_name) {
    return location ? `${f.startup_name} · ${location}` : f.startup_name;
  }
  const topSkills = (f.skills || []).slice(0, 2).join(', ');
  if (topSkills) return location ? `${topSkills} · ${location}` : topSkills;
  return location || '';
}

function hasCohort(f) {
  return Number.isInteger(f.cohort) && f.cohort > 0;
}

/** A list row for search/disambiguation results. id encodes the profile action. */
function toRow(f) {
  return {
    id: `profile:${f.source_slug}`,
    title: f.name,
    description: subtitle(f) || (hasCohort(f) ? `Cohort ${f.cohort}` : ''),
  };
}

/** Full profile caption for an image card. Only includes fields that exist. */
function profileCaption(f) {
  const lines = [`*${f.name}*`];

  const meta = [f.sector, f.city].filter(Boolean);
  if (hasCohort(f)) meta.push(`Cohort ${f.cohort}`);
  if (f.program) meta.push(f.program);
  if (meta.length) lines.push(meta.join(' · '));

  const idea = f.startup_idea ? truncate(f.startup_idea.trim(), 300) : '';
  if (f.startup_name || idea) {
    lines.push('');
    if (f.startup_name && idea) lines.push(`*${f.startup_name}* — ${idea}`);
    else lines.push(`*${f.startup_name || ''}*${idea}`.trim());
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
  const lines = [`*${m.name}* — ${m.score}/100`];
  // Lead with what they're building, then location. Sector tag is not a description.
  if (m.startup_idea) {
    const idea = truncate(m.startup_idea.trim(), 80);
    lines.push(m.city ? `${idea} · ${m.city}` : idea);
  } else if (m.startup_name) {
    lines.push(m.city ? `${m.startup_name} · ${m.city}` : m.startup_name);
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
    title: s.name,
    description: truncate(s.expertise || '', 72),
  };
}

/** A list row for an expertise area. id encodes the list-by-area action. */
function areaRow(a) {
  return {
    id: `area:${a.key}`,
    title: a.label,
    description: `${a.count} mentor${a.count === 1 ? '' : 's'}`,
  };
}

/** Booking message: the external link + the two program guardrails. */
function bookingMessage(s) {
  return [
    `📅 Book a 1:1 with *${s.name}*:`,
    s.booking_url,
    '',
    `Before the call: copy & fill the prep doc, then share the link with them — ${PREP_DOC_URL}`,
    `After the call: a 2-min feedback form — ${FEEDBACK_FORM_URL}`,
  ].join('\n');
}

/** Prep-doc reminder, sent on its own (e.g. the "Prep doc" button). */
function prepMessage() {
  return [
    'Make a copy of the Founder Talk prep doc, fill it out, and share the editable link with your mentor before the meeting — it makes the session far more useful:',
    PREP_DOC_URL,
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
