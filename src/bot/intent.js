'use strict';

/**
 * Deterministic turn-intent resolution.
 *
 * The single highest-cost recurring bug in this bot is confusing an attribute
 * of the USER with an attribute of the person they are LOOKING FOR: "a
 * cofounder in Delhi" - is Delhi the user's own city, or the wanted cofounder's?
 * The model decides this from prose, unreliably, so earlier fixes scattered
 * ad-hoc regexes through tools.js (each patched one preposition at a time). This
 * module is the audit's recommendation made concrete: resolve subject-vs-object
 * ONCE, in code, in a single tested place - not in the prompt.
 *
 * Design contract for cityIsSelf: it is CONSERVATIVE and asymmetric on purpose.
 * The costs of the two error directions are wildly different:
 *   - Wrongly saving a WANTED city as the user's own overwrites their real
 *     profile city -> corruption, the exact severe bug we're killing.
 *   - Wrongly NOT saving a genuine self-city -> we just miss a same-city
 *     personalization bonus. Minor.
 * So we only return "self" when there is a POSITIVE first-person location
 * signal; when unsure, we return "wanted" (don't pollute self). Ownership is
 * decided by POSITION (what governs the city mention), which is what lets
 * "i'm in mumbai, find a cofounder in delhi" resolve both cities correctly.
 */

// "I want a cofounder" / "match me with someone".
const COFOUNDER_RE = /\bco-?founders?\b|\bmatch me\b/i;

// A self-described skill stated WITHOUT confidence ("a little tech").
const HEDGE_RE =
  /\b(a\s+little|little\s+bit|somewhat|some(what)?|not\s+(fully|totally|really|that)|kind\s+of|sort\s+of|part[\s-]?time|mixed|bit\s+of)\b/i;

// A request to FIND someone (vs a self-intro). Gates the wanted-person reading.
const FIND_REQUEST_RE =
  /\b(find|show|get\s+me|looking\s+for|look\s+for|need|want|match|search|connect\s+me|introduce\s+me|pull\s+up|chahiye|dhundh|dhoond)\b/i;

// Immediately before a city, marks it as the WANTED person's ("cofounder in X",
// "someone from X"). Requires a person-noun adjacent to the preposition.
const WANTED_GOVERNOR_RE =
  /\b(co-?founders?|founders?|someone|somebody|people|person|dev|developer|engineer|marketer|designer|cto|coder|hustler|guy|girl)\s+(in|from|based\s+in|near|located\s+in)\s*$/i;

// Immediately before a city, marks it as the USER's own. MUST carry a first-
// person subject (i'm / i am / i live / Hinglish main-mai) - a bare "based in"
// is deliberately NOT enough (it's often the cofounder's requirement, e.g.
// "cofounder should be based in Delhi"). An optional short run allows an
// intervening role noun ("i'm a founder from <city>").
const SELF_GOVERNOR_RE = /\b(i'?m|i\s+am|iam|i\s+live|i\s+stay|i\s+reside)\b[a-z\s]{0,22}?\b(in|from|at)\s*$/i;
// "i'm a <city> founder/cofounder" - city right after the first-person subject,
// no preposition.
const SELF_NOPREP_RE = /\b(i'?m|i\s+am|iam)\s+(a\s+|an\s+|the\s+)?$/i;
const SELF_POSSESSIVE_RE = /\bmy\s+(city|hometown|base|town)\s+(is\s+|=\s*)?$/i;
// Hinglish first-person subject sitting just before the city ("main <city> ...").
const HINGLISH_SELF_GOVERNOR_RE = /\b(main|mai|mein\s+rehta|mein\s+rehti)\s*$/i;

// Whole-message self-location signals, used only as a fallback when the city
// can't be located positionally (e.g. the model normalized "Bombay"->"Mumbai").
const SELF_LOC_ANYWHERE_RE = /\b(i'?m|i\s+am|iam|i\s+live|i\s+stay)\b[a-z\s]{0,22}?\b(in|from|at)\b/i;
const HINGLISH_SELF_ANYWHERE_RE = /\b(main|mai)\b[a-z\s]{0,20}?\b(hu|hoon|rehta|rehti|se\s+hu|me\s+hu|mein\s+hu)\b/i;

// A message that is ENTIRELY a short yes/no/affirmation-style reply, nothing
// else. Deliberately whole-message-anchored (^...$) so a longer message that
// happens to start with "yes, and also..." does NOT match - that message
// carries its own new content and doesn't need pending-question grounding.
const BARE_YESNO_RE =
  /^(yes|yeah|yep|yup|sure|ok(ay)?|please|go\s*ahead|do\s*it|ya+|haan?|sounds?\s*good|correct|right|why\s*not|no+|nah|nope|not\s*(really|now)|nahi)[.!?]?$/i;

/**
 * True when the ENTIRE message is a bare yes/no/short-affirmation, with no
 * other content. Used to decide when a reply is ambiguous enough that it
 * needs to be pinned to a specific PENDING question (see engine.js) rather
 * than re-derived from scratch each turn - the model reliably loses track of
 * which of several possible open questions a bare "yes" answers, especially
 * across a compressed/summarized history (real observed failure: a user's
 * "Yes"/"No"/"Yes" sequence took 4 extra turns to resolve because each short
 * reply got attached to the wrong earlier question).
 */
function isBareYesNo(text) {
  return BARE_YESNO_RE.test(String(text || '').trim());
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when the turn is asking to be matched with / find a cofounder. */
function wantsCofounder(text) {
  return COFOUNDER_RE.test(String(text || ''));
}

/** True when a self-skill claim in this turn was hedged (uncertain). */
function isHedgedSelfClaim(text) {
  return HEDGE_RE.test(String(text || ''));
}

/**
 * Does a city named in `text` describe the USER themselves (true = safe to save
 * to self) or the person they are looking for (false = don't save)? Conservative:
 * returns true ONLY on a positive first-person signal; defaults to false when
 * unsure. See the module contract above for why the asymmetry is deliberate.
 */
function cityIsSelf(text, cityValue) {
  const t = String(text || '');
  if (!t) return false;
  const cityEsc = escapeRegex(String(cityValue || '').trim());
  // Whole-word match so "Goa" doesn't match inside "goal".
  const m = cityEsc ? new RegExp(`\\b${cityEsc}\\b`, 'i').exec(t) : null;
  if (m) {
    const before = t.slice(Math.max(0, m.index - 30), m.index).toLowerCase();
    // Positive self signal wins.
    if (
      SELF_GOVERNOR_RE.test(before) ||
      SELF_NOPREP_RE.test(before) ||
      SELF_POSSESSIVE_RE.test(before) ||
      HINGLISH_SELF_GOVERNOR_RE.test(before)
    ) {
      return true;
    }
    // Wanted-person governor (only in an actual find/cofounder request, so a
    // self-intro like "founder from goa here" isn't misread as a search).
    if (WANTED_GOVERNOR_RE.test(before) && (wantsCofounder(t) || FIND_REQUEST_RE.test(t))) {
      return false;
    }
  }
  // Fallback (city not locatable, or no local governor): save as self ONLY with
  // a clear self-location phrase AND not a find/cofounder request. Bias to false.
  const hasSelfLoc = SELF_LOC_ANYWHERE_RE.test(t) || HINGLISH_SELF_ANYWHERE_RE.test(t);
  const isRequest = wantsCofounder(t) || FIND_REQUEST_RE.test(t);
  return hasSelfLoc && !isRequest;
}

module.exports = { wantsCofounder, isHedgedSelfClaim, cityIsSelf, isBareYesNo };
