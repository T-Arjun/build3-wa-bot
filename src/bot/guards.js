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

module.exports = { untrackedNote, selfHarmResponse };
