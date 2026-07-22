'use strict';

/**
 * Startup-perk ("Perks & credits") category taxonomy. Single source of truth,
 * shared by the domain layer, the bot tools, the system prompt, and the admin
 * dashboard. Category keys are stable ids used inside reply ids (perkcat:<key>);
 * labels are what the founder sees in the picker. Mirrors mentorAreas.js.
 *
 * A perk can carry more than one category (perks.data.js `categories` is an
 * array), so the same tool can surface under several pickers.
 */

const PERK_CATEGORIES = {
  cloud: 'Cloud & infra credits',
  ai: 'AI tools',
  design: 'Design & website',
  marketing: 'Marketing & comms',
  sales: 'Sales & payments',
  productivity: 'Productivity & dev',
  workspace: 'Workspace & office',
  hiring: 'Hiring',
};

const CATEGORY_KEYS = Object.keys(PERK_CATEGORIES);

function categoryLabel(key) {
  return PERK_CATEGORIES[key] || key;
}

module.exports = { PERK_CATEGORIES, CATEGORY_KEYS, categoryLabel };
