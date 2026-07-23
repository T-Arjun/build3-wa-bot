'use strict';

/**
 * Deterministic honesty guard for attributes the directory does NOT track
 * (gender, funding/revenue, hiring). The model is told to disclaim these, but it
 * drops the rule under load and can even claim "no results" when the trackable
 * search actually returned people. This is a code-level backstop: if the user is
 * clearly trying to FILTER founders by an untracked attribute, we force the
 * honest disclaimer onto the reply regardless of what the model wrote.
 *
 * Patterns are deliberately narrow so topical mentions don't misfire, e.g.
 * "women's health founders" (a sector) must NOT trigger the gender note, only
 * "women founders" / "founders who are women" (a gender filter) does.
 */
const RULES = [
  {
    key: 'gender',
    re: /\b(women|woman|female|ladies)\s+(founders?|entrepreneurs?|cofounders?|co-founders?|ceos?|folks|people|leaders?)\b|\b(founders?|people|entrepreneurs?)\s+who\s+are\s+(women|woman|female)\b|\b(only|all)\s+(women|female)\b/i,
    note: "quick heads up, we don't track gender in the directory, so we can't filter for women specifically.",
  },
  {
    key: 'funding',
    re: /\b(well[ -]?funded|funded founders?|raised\s+(a\s+)?(round|funding|money|seed|series|capital)|by\s+(funding|revenue|valuation)|high[ -]?revenue|revenue\s+of|valuation)\b/i,
    note: "quick heads up, we don't have funding or revenue data, so we can't filter by that.",
  },
  {
    key: 'hiring',
    re: /\bwho(?:'?s| is| are)?\s+hiring\b|\bfounders?\s+(?:(?:who\s+)?are\s+)?hiring\b|\bcompanies?\s+hiring\b|\bare\s+hiring\b/i,
    note: "quick heads up, we don't track who's hiring, so we can't filter by that.",
  },
];

/**
 * If the message tries to filter by an untracked attribute, return the honest
 * disclaimer to lead the reply with. Otherwise null.
 * @param {string} text
 * @returns {?string}
 */
function untrackedNote(text) {
  const s = String(text || '');
  for (const r of RULES) {
    if (r.re.test(s)) return r.note;
  }
  return null;
}

/**
 * Explicit self-harm language gets a fixed, humane response INSTEAD of an LLM
 * turn - a founder-networking bot must never respond to "I want to kill
 * myself" by searching founders or picking a chirpy register. Deliberately
 * NARROW: philosophical/startup mentions of death ("what do you feel about
 * death", "our near-death funding phase", "this deadline is killing me") must
 * NOT trigger - the prompt's sensitive-topics rules handle tone there. Only
 * first-person harm statements trigger the override.
 * Tele-MANAS is India's national mental-health helpline (free, 24x7).
 */
const SELF_HARM_RE =
  /\b(kill(?:ing)?\s+myself|end(?:ing)?\s+my\s+life|suicidal|suicide|self[\s-]?harm|hurt(?:ing)?\s+myself|want\s+to\s+die|wanna\s+die|khudkushi|atmahatya)\b/i;

const SELF_HARM_RESPONSE =
  "that sounds really heavy, and we're not going to pretend a founder bot is the right support for it. please talk to someone you trust, or reach Tele-MANAS, India's free 24x7 mental health helpline: call 14416 or 1-800-891-4416. we're here whenever you want to talk startups, no pressure.";

/** Fixed compassionate response if the message contains explicit self-harm language, else null. */
function selfHarmResponse(text) {
  return SELF_HARM_RE.test(String(text || '')) ? SELF_HARM_RESPONSE : null;
}

const URL_RE = /https?:\/\/[^\s)>\]"']+/gi;

/** Trailing punctuation a sentence often leaves stuck to a URL, plus casing. */
function normalizeUrl(u) {
  return String(u || '').trim().replace(/[.,;:)>\]]+$/, '').toLowerCase();
}

const UNVERIFIED_URL_FALLBACK =
  "hold on, we don't have their link confirmed yet - ask again and we'll pull up the real one.";

/**
 * Deterministic backstop for the prompt's "URLS ARE NEVER TYPED FROM MEMORY"
 * hard rule (real observed failure, live-reproduced): after a turn that ended
 * on a pending disambiguation (e.g. "which Bhavana did you mean?"), asking
 * about a brand-new, unrelated person in the next message sometimes made the
 * model skip get_profile entirely and invent a plausible-looking LinkedIn URL
 * from scratch - confirmed by running the same request twice and getting two
 * DIFFERENT fabricated URLs for the same person. Prompt text alone doesn't
 * reliably hold here (this project's established pattern for that class of
 * failure - see untrackedNote above), so this scans the model's own reply for
 * any URL and replaces the whole reply if that URL never actually appeared in
 * this turn's tool results or grounding notes. A false-flag here only costs
 * one honest "ask again" instead of a name-and-shame call-out, so the check
 * can afford to be strict.
 * @param {string} text - the model's proposed reply
 * @param {string[]} verifiedUrls - every URL that legitimately surfaced this turn
 * @returns {string} the original text, or a safe fallback if it contained an unverified URL
 */
function scrubUnverifiedUrls(text, verifiedUrls) {
  const s = String(text || '');
  const found = s.match(URL_RE);
  if (!found) return text;
  const verified = new Set((verifiedUrls || []).map(normalizeUrl));
  const hasUnverified = found.some((u) => !verified.has(normalizeUrl(u)));
  return hasUnverified ? UNVERIFIED_URL_FALLBACK : text;
}

/** Pull every URL out of an arbitrary string (tool-result JSON, system notes, ...). */
function extractUrls(s) {
  return String(s || '').match(URL_RE) || [];
}

/**
 * The last question-shaped sentence in a reply, or null. Used to persist
 * "what did we just ask them" (see handler.js draft.pending_question /
 * engine.js's PENDING QUESTION note) so a bare "yes"/"no" next turn can be
 * pinned to the actual question instead of the model re-guessing which of
 * several possible open threads it answers.
 */
function extractLastQuestion(text) {
  const sentences = String(text || '')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const questions = sentences.filter((s) => s.endsWith('?'));
  return questions.length ? questions[questions.length - 1] : null;
}

module.exports = {
  untrackedNote,
  selfHarmResponse,
  scrubUnverifiedUrls,
  extractUrls,
  extractLastQuestion,
};
