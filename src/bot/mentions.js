'use strict';

/**
 * Deterministic person-entity grounding for the engine.
 *
 * Root problem this solves (observed live, 4th failure of this class in a
 * week): when the user types a name, the model resolves it against flattened
 * history notes and picks the wrong person under name collision - e.g. the
 * user wrote "put in touch with ayushmaan" right after booking Sherpa
 * Ayushmaan Kapoor, and the model answered about "Ayush Gupta", an unrelated
 * founder from an earlier list, then invented a LinkedIn claim about him.
 *
 * Fix: person-entity resolution is never the LLM's job. Before each engine
 * turn we scan the raw text against the CANONICAL entities currently in play
 * (all Sherpas + the focus founder + cached matches + last list results) and
 * inject a system note pinning each mentioned name to its real identity and
 * the right contact channel (booking link for a Sherpa, LinkedIn for a
 * founder). Exact token equality means "ayushmaan" matches Ayushmaan Kapoor
 * and NOT Ayush Gupta ("ayush" != "ayushmaan").
 *
 * Guards against over-grounding (pinning the WRONG person is worse than
 * pinning nobody):
 *  - a match on a very common surname alone ("gupta", "singh") never counts;
 *  - if the matched token is immediately followed in the text by a name-like
 *    token that is NOT part of the candidate's name ("amit malakar" vs cached
 *    "Amit Sharma"), that candidate is vetoed - the user means someone else.
 */

// Filler words (english + hinglish) - never name evidence, and a token
// followed by one of these is NOT being used as part of a longer full name.
const COMMON_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'about', 'want', 'need', 'his', 'her',
  'him', 'she', 'get', 'put', 'touch', 'tell', 'what', 'whats', 'who', 'whos',
  'how', 'please', 'now', 'today', 'can', 'could', 'you', 'your', 'yours',
  'contact', 'number', 'phone', 'email', 'profile', 'linkedin', 'calendar',
  'book', 'booking', 'slot', 'call', 'meet', 'meeting', 'intro', 'introduce',
  'connect', 'details', 'info', 'again', 'also', 'more', 'other', 'this',
  'that', 'these', 'those', 'there', 'here', 'thanks', 'thank', 'hai', 'hain',
  'karo', 'kar', 'kya', 'aur', 'mujhe', 'chahiye', 'wala', 'wale', 'bhai',
  'yaar', 'feel', 'think', 'like', 'them', 'they',
  // Ordinary conversational closers/adverbs (real observed failure: the
  // full-name-elsewhere veto below was meant to catch "amit malakar" (a
  // DIFFERENT person's surname right after the matched token), but with only
  // the narrow list above, almost ANY word following a bare first name got
  // treated as evidence of a different person - "call pranav asap"/"pranav
  // soon"/"pranav bro" all silently failed to ground, defeating this file's
  // whole purpose for the majority of realistic single-name messages. These
  // are safe to whitelist: none are plausible directory first/last names.
  'asap', 'soon', 'plz', 'pls', 'tomorrow', 'quickly', 'lately', 'urgently',
  'immediately', 'yet', 'already', 'definitely', 'actually', 'maybe',
  'probably', 'exactly', 'honestly', 'seriously', 'tho', 'though', 'bro',
  'dude', 'man', 'buddy', 'guys', 'yeah', 'yep', 'nah', 'sure', 'cool',
  'nice', 'great', 'good', 'fine', 'alright', 'right', 'well', 'yes', 'okay',
  'ok',
]);

// So common as surnames that a hit on ONE of these alone is noise, not a mention.
const COMMON_SURNAMES = new Set([
  'kumar', 'singh', 'sharma', 'gupta', 'shah', 'patel', 'jain', 'khan',
  'mehta', 'das', 'roy', 'verma', 'reddy', 'nair', 'iyer', 'agarwal', 'yadav',
]);

/** Ordered lowercase word tokens of length >= 3. */
function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
}

function nameTokensOf(c) {
  return tokenize(c.name || String(c.slug || '').replace(/-/g, ' ')).filter(
    (t) => !COMMON_WORDS.has(t),
  );
}

/**
 * Match user text against candidate entities.
 * @param {string} text - raw user message
 * @param {Array<{name:string, slug:string, type:'sherpa'|'founder', bookingUrl?:string, linkedinUrl?:string}>} candidates
 * @returns matched candidates (deduped by slug, sherpas first)
 */
function findMentions(text, candidates) {
  const seq = tokenize(text);
  if (!seq.length) return [];
  const positions = new Map(); // token -> [indexes]
  seq.forEach((t, i) => {
    if (!positions.has(t)) positions.set(t, []);
    positions.get(t).push(i);
  });

  const seen = new Set();
  const hits = [];
  for (const c of candidates || []) {
    if (!c || !c.slug || seen.has(c.slug)) continue;
    const nameTokens = nameTokensOf(c);
    if (!nameTokens.length) continue;
    const nameSet = new Set(nameTokens);
    const matched = nameTokens.filter((t) => positions.has(t));
    if (!matched.length) continue;
    // A lone common-surname hit isn't a mention of this person.
    if (matched.every((t) => COMMON_SURNAMES.has(t))) continue;
    // Full-name-elsewhere veto: matched token directly followed by a
    // name-like token that isn't part of THIS candidate's name.
    const vetoed = matched.every((t) =>
      positions.get(t).every((i) => {
        const next = seq[i + 1];
        return next && !COMMON_WORDS.has(next) && !nameSet.has(next);
      }),
    );
    if (vetoed) continue;
    seen.add(c.slug);
    hits.push(c);
  }
  // Sherpas first so a dual founder+Sherpa name (e.g. Varun Chawla) leads with
  // the bookable person when contact language is around.
  return hits.sort((a, b) => (a.type === b.type ? 0 : a.type === 'sherpa' ? -1 : 1));
}

/**
 * Render matched entities as a system note for the engine, or null.
 * Kept short and factual - it pins identity, it doesn't script the reply.
 */
function buildMentionNote(text, candidates) {
  const hits = findMentions(text, candidates);
  if (!hits.length) return null;
  const lines = hits.slice(0, 4).map((c) => {
    if (c.type === 'sherpa') {
      return `- "${c.name}" is Sherpa ${c.name} (slug: ${c.slug}). Their booking link IS the direct way to reach them${c.bookingUrl ? `: ${c.bookingUrl}` : ' (get_sherpa shows it)'}. A contact/intro request for them means BOOKING, not LinkedIn.`;
    }
    return `- "${c.name}" is community founder ${c.name} (slug: ${c.slug}).${c.linkedinUrl ? ` LinkedIn: ${c.linkedinUrl} - paste this link directly in your reply if they ask for contact.` : ''}`;
  });
  return (
    "ENTITY GROUND TRUTH for names in the user's message - these identifications are exact; never substitute a different, similar-sounding person:\n" +
    lines.join('\n')
  );
}

module.exports = { findMentions, buildMentionNote, tokenize };
