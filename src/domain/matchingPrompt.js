'use strict';

/**
 * Cofounder match scoring prompt - reused verbatim from the source platform's
 * services/matchingService.js (buildSystemPrompt / founderToPromptString /
 * buildUserPrompt). Keeping it identical preserves the proven 7-factor scoring
 * and the score-banded reason-tone rules. See rules/00 - do not drift from this.
 */

function founderToPromptString(f, isTarget = false) {
  const parts = [];
  if (f.name) parts.push(f.name);
  if (f.startup_name) parts.push(`Startup: ${f.startup_name}`);
  if (f.startup_idea) {
    const idea =
      f.startup_idea.length > 150 ? f.startup_idea.substring(0, 150) + '...' : f.startup_idea;
    parts.push(`Idea: ${idea}`);
  }
  if (f.sector) parts.push(`Sector: ${f.sector}`);
  if (f.skills && f.skills.length) parts.push(`Skills: ${f.skills.join(', ')}`);
  if (f.traits && f.traits.length) parts.push(`Traits: ${f.traits.join(', ')}`);
  if (f.dharma) parts.push(`Dharma: ${f.dharma}`);
  if (f.city) parts.push(f.city);
  if (f.startup_stage) parts.push(f.startup_stage);
  if (f.looking_for && f.looking_for.length) {
    parts.push(`Seeking: ${f.looking_for.join(', ')}`);
  }
  const about = f.linkedin?.about;
  if (about) {
    parts.push(`Bio: ${about.length > 120 ? about.substring(0, 120) + '...' : about}`);
  }
  if (isTarget) {
    if (f.linkedin?.headline) parts.push(`Headline: ${f.linkedin.headline}`);
    if (f.program) parts.push(`Program: ${f.program}`);
  }
  return parts.join(' | ');
}

function buildSystemPrompt() {
  return `You are an expert co-founder matching engine for a startup accelerator.

Score every candidate from 0-100 as a potential co-founder match for the target founder.

Scoring weights (apply in this order):
1. Complementary skills - the single biggest signal. If the target is technical, a business/sales/marketing candidate scores highest. If target is a generalist, a deep specialist scores well. Heavy skill overlap lowers the score significantly.
2. Sector alignment - same sector is a strong bonus; adjacent sectors are acceptable; unrelated sectors reduce the score.
3. Values & personality fit - dharma type, traits, and working style. Mismatched dharma (e.g. two "leaders") lowers the score.
4. Seeking intent match - if both want a co-founder that's ideal; one wanting to "join a startup" and the other wanting a "co-founder" is also a good fit.
5. Same city - only count as a city match if both founders list the exact same city. Different cities = no geography bonus, do NOT say "similar city" or "close proximity".
6. Similar startup stage - idea-stage with idea-stage, growth with growth.
7. Shared interests or hobbies - minor bonus for human connection.

Return ONLY valid JSON, no markdown, no explanation.

JSON format:
{
  "matches": [
    {
      "candidateIndex": 0,
      "name": "Exact name from input",
      "score": 85,
      "reasons": ["reason1", "reason2"]
    }
  ]
}

CRITICAL - SCORE BAND DEFINITIONS. Apply these criteria to decide the numeric score, then use the matching reason prefixes. Both are non-negotiable.

Score 80-100: skill gap is clearly filled AND sector matches AND at least one other factor (city/stage/dharma/intent) aligns.
  Reason prefixes: "Directly complements...", "Clear fit -", "Exactly the ___ you asked for -", "Aligned on...", "Strong match -"

Score 60-79: skill gap is filled OR sector matches — but not both. One strong alignment factor present.
  Reason prefixes: "Strong complement -", "Good fit:", "Solid alignment -", "Works well -", "Adds value with..."

Score 40-59: skill gap is partially filled (adjacent skills) OR sector is adjacent. Some alignment but notable gaps.
  Reason prefixes: "Could complement...", "Might work -", "Worth exploring:", "Potential fit -", "Some alignment in..."

Score 20-39: required skill is missing AND sector doesn't match. Hard requirements not met.
  Reason prefixes: "Limited overlap -", "May not align:", "Gaps exist -", "Different paths -", "Unlikely synergy -"

Score 0-19: direct skill overlap (both founders same skill set), or fundamental mismatch across all factors.
  Reason prefixes: "Significant mismatch -", "Very different focus -", "No clear overlap -", "Misaligned on..."

Additional rules:
- Sort matches from highest to lowest score.
- Include ALL candidates - do not skip anyone.
- Give exactly 2 short, specific reasons per candidate (max 20 words each).
- Reason 1: focus on skill complementarity - be concrete about what each person brings.
- Reason 2: focus on sector, city, stage, dharma, values, or intent alignment.
- Never use generic praise like "great match" or "good person". Reference actual data from the profiles.
- FACTUAL ACCURACY: Only mention "same city" if both founders literally share the same city name. If cities differ, do not reference geography at all - pick a different alignment factor instead.`;
}

function buildUserPrompt(target, candidates, requiredSkills = null) {
  const targetStr = founderToPromptString(target, true);
  const candidateLines = candidates.map((c, i) => `[${i}] ${founderToPromptString(c, false)}`);

  const lf = Array.isArray(target.looking_for) ? target.looking_for : [];
  const hasCofounder = lf.some((v) => v.indexOf('co-founder') !== -1);
  const hasJoin = lf.includes('join a startup');
  const seekingNote = hasCofounder
    ? 'The target founder is actively looking for a co-founder to build with.'
    : hasJoin
      ? 'The target founder wants to join a promising startup as a key early member.'
      : '';

  // The requester's EXPLICIT ask ("a technical cofounder", "someone who can
  // sell") overrides generic complementarity: a candidate who doesn't bring the
  // asked-for skill must not outrank one who does. Without this, "I want a tech
  // cofounder" can return 90/100 GTM people because they "complement" the
  // requester - the exact inverse of the request.
  const req = Array.isArray(requiredSkills) && requiredSkills.length ? requiredSkills : null;
  const reqNote = req
    ? `\nHARD REQUIREMENT: the target founder explicitly asked for a co-founder who brings: ${req.join(', ')}. A candidate who does not plausibly bring these skills must score BELOW 40 no matter how complementary they are otherwise, and their reasons must name that gap plainly instead of praising unrelated skills.`
    : '';
  // The target's own "Skills:" line can come from a HEDGED self-description
  // ("little bit tech" -> skills:["engineering"]), not a confirmed fact - see
  // matching.js buildTarget / tools.js set_self_profile. Without this, the
  // reason-tone rules below treat that guess as certain and produce "Directly
  // complements your engineering" off an assumption nobody confirmed.
  const skillHedgeNote =
    target.skillConfidence === 'soft'
      ? "\nNOTE ON THE TARGET'S OWN SKILLS: their self-described skills come from a HEDGED statement (something like \"a little bit technical\"), not a confirmed fact. Do NOT use top-tier confident language (\"Directly complements...\", \"Clear fit -\") for the skill-complementarity reason even at a high score - cap that one reason at the 60-79 tier phrasing (\"Strong complement -\", \"Works well -\") or soften it further, regardless of the numeric score. The sector/city/stage/dharma reason is unaffected."
      : '';

  return `TARGET FOUNDER:
${targetStr}
${seekingNote ? `\nContext: ${seekingNote}` : ''}${reqNote}${skillHedgeNote}

CANDIDATES (${candidates.length} total):
${candidateLines.join('\n')}

Score every candidate. Apply the reason language rules strictly based on each score. Write every reason TO the target founder in second person ("brings the sales muscle you need"), never "the target" or phrases like "non-technical target". Reasons are lowercase (except names/places/acronyms), factual, and free of grading adjectives like "perfectly", "exceptional", "amazing": lead with the concrete fact and let the score do the judging. Return JSON only.`;
}

module.exports = { buildSystemPrompt, buildUserPrompt, founderToPromptString };
