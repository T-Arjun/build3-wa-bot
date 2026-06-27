'use strict';

/**
 * Field enums mirrored verbatim from the source platform's models/Founder.js.
 * Reusing these keeps our data shape and the AI's filter vocabulary aligned
 * with the directory we sync from. Do not invent new values - see rules/00.
 */

const SECTORS = [
  'Agriculture & Food',
  'Commerce & Consumer',
  'Built Environment',
  'Health & Wellness',
  'Education & Skilling',
  'Enterprise & SaaS',
  'Financial Services',
  'Mobility & Infrastructure',
  'Climate & Sustainability',
  'Deep Tech',
  'Media & Community',
  'Social Impact',
  'AI & Data',
  'Hybrid / Cross-Sector',
  'Other',
];

const STARTUP_STAGES = [
  'Idea',
  'Pre-revenue',
  '1-5 lakhs MRR',
  '5-10 lakhs MRR',
  '10 lakh+ MRR',
];

const LOOKING_FOR = [
  'none',
  'co-founder, I have a startup',
  "co-founder, I don't have a startup",
  'join a startup',
  'service providers',
];

const DHARMA = ['leader', 'maker', 'guide', 'creator'];

const PLATFORM_ROLES = ['founder', 'investor', 'sherpa', 'build3ers', 'community'];

const PRIMARY_ROLES = ['founder', 'investor', 'sherpa', 'community'];

// Values in lookingFor that indicate openness to a cofounder relationship.
// Matches the source matchingService candidate filter: /co-founder|join a startup/i
const COFOUNDER_INTENT = LOOKING_FOR.filter((v) => /co-founder|join a startup/i.test(v));

module.exports = {
  SECTORS,
  STARTUP_STAGES,
  LOOKING_FOR,
  DHARMA,
  PLATFORM_ROLES,
  PRIMARY_ROLES,
  COFOUNDER_INTENT,
};
