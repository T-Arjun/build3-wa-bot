'use strict';

/**
 * Render founder records into WhatsApp-friendly text/rows.
 */

function avatarFor(f) {
  if (f.avatar_url) return f.avatar_url;
  const name = encodeURIComponent(f.name || 'build3');
  return `https://ui-avatars.com/api/?name=${name}&background=79c0a6&color=fff&bold=true&size=400`;
}

function subtitle(f) {
  return [f.startup_name, f.sector, f.city].filter(Boolean).join(' · ');
}

/** A list row for search/disambiguation results. id encodes the profile action. */
function toRow(f) {
  return {
    id: `profile:${f.source_slug}`,
    title: f.name,
    description: subtitle(f) || (f.cohort ? `Cohort ${f.cohort}` : ''),
  };
}

/** Full profile caption for an image card. */
function profileCaption(f) {
  const lines = [`*${f.name}*`];
  const sub = subtitle(f);
  if (sub) lines.push(sub);
  if (Number.isInteger(f.cohort)) lines.push(`Cohort ${f.cohort}${f.program ? ` · ${f.program}` : ''}`);
  if (f.startup_idea) lines.push(`\n${truncate(f.startup_idea, 300)}`);
  if (f.skills?.length) lines.push(`\n🛠 ${f.skills.slice(0, 8).join(', ')}`);
  if (f.looking_for?.length) lines.push(`🔎 ${f.looking_for.join(', ')}`);
  if (f.linkedin_url) lines.push(`\n${f.linkedin_url}`);
  return lines.join('\n');
}

/** A single cofounder match block (used when sent as an image card caption). */
function matchCaption(m) {
  const lines = [`*${m.name}* — ${m.score}/100`];
  const sub = [m.startup_name, m.sector, m.city].filter(Boolean).join(' · ');
  if (sub) lines.push(sub);
  for (const r of m.reasons || []) lines.push(`• ${r}`);
  return lines.join('\n');
}

function truncate(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

module.exports = { avatarFor, subtitle, toRow, profileCaption, matchCaption, truncate };
