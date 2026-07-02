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
    note: "Quick heads up, I don't track gender in the directory, so I can't filter for women specifically.",
  },
  {
    key: 'funding',
    re: /\b(well[ -]?funded|funded founders?|raised\s+(a\s+)?(round|funding|money|seed|series|capital)|by\s+(funding|revenue|valuation)|high[ -]?revenue|revenue\s+of|valuation)\b/i,
    note: "Quick heads up, I don't have funding or revenue data, so I can't filter by that.",
  },
  {
    key: 'hiring',
    re: /\bwho(?:'?s| is| are)?\s+hiring\b|\bfounders?\s+(?:(?:who\s+)?are\s+)?hiring\b|\bcompanies?\s+hiring\b|\bare\s+hiring\b/i,
    note: "Quick heads up, I don't track who's hiring, so I can't filter by that.",
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

module.exports = { untrackedNote };
