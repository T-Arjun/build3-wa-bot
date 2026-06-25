'use strict';

const WORD_ORDINAL = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
  sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
};

/**
 * Parse a typed reference to a position in the most recently shown list:
 * "2", "show 2", "#3", "the first one", "tell me about the second".
 *
 * Returns a 0-based index within [0, listLen), or null if the message isn't an
 * ordinal reference. CONSERVATIVE: only matches when the whole message is an
 * ordinal phrase, so "find 3 founders" or "show me AI founders" do NOT match
 * (those must reach the LLM).
 *
 * @param {string} text
 * @param {number} listLen length of the current list (last_results)
 * @returns {number|null}
 */
function parseOrdinal(text, listLen) {
  if (!listLen || listLen < 1) return null;
  let s = String(text || '').trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/[?.!,]+$/, '').trim();
  // Strip a leading verb phrase ("show me", "tell me about", "open", ...).
  s = s.replace(
    /^(can you |could you |pls |please )?(show me|show|view|open|see|tell me about|tell me more about|more about|details on|details for|profile of|number|num|no\.?)\s+/,
    '',
  );
  s = s.replace(/^the\s+/, '');
  s = s.replace(/\s+(one|please)$/, '').trim();

  const num = s.match(/^#?(\d{1,2})(st|nd|rd|th)?$/);
  if (num) {
    const n = parseInt(num[1], 10);
    return n >= 1 && n <= listLen ? n - 1 : null;
  }
  if (Object.prototype.hasOwnProperty.call(WORD_ORDINAL, s)) {
    const n = WORD_ORDINAL[s];
    return n <= listLen ? n - 1 : null;
  }
  return null;
}

/**
 * Deterministically resolve a typed list selection BEFORE the LLM. I/O is
 * injected (getBySlug, sendCard) so this is fully unit-testable without Supabase
 * or WhatsApp. Critically, `founder` is only returned when the card actually
 * sent — the caller must NOT commit focus/history on a failed send.
 *
 * @returns {Promise<{handled:boolean, sendFailed?:boolean, founder?:object}>}
 */
async function resolveTypedSelection({ text, lastResults, getBySlug, sendCard }) {
  const list = Array.isArray(lastResults) ? lastResults : [];
  const idx = parseOrdinal(text, list.length);
  if (idx == null) return { handled: false };
  const slug = list[idx];
  const founder = slug ? await getBySlug(slug) : null;
  if (!founder) return { handled: false }; // stale/missing slug → let the LLM try
  const ok = await sendCard(founder);
  if (!ok) return { handled: true, sendFailed: true };
  return { handled: true, founder };
}

module.exports = { parseOrdinal, resolveTypedSelection };
