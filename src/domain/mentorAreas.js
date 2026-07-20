'use strict';

/**
 * Mentor expertise taxonomy and the two program guardrail links.
 * Single source of truth, shared by the domain layer, the bot tools, the system
 * prompt, and the admin dashboard. Area keys are stable ids used inside reply
 * ids (area:<key>); labels are what the founder sees in the picker.
 */

const AREAS = {
  fundraising: 'Fundraising & finance',
  gtm: 'GTM & growth',
  marketing: 'Marketing & brand',
  product: 'Product & UX',
  tech: 'Tech & CTO',
  strategy: 'Strategy & business model',
  impact: 'Sustainability & impact',
};

const AREA_KEYS = Object.keys(AREAS);

function areaLabel(key) {
  return AREAS[key] || key;
}

// "Make a copy" template the founder fills before a meeting (the Founder Talk
// prep doc), and the 2-minute post-meeting feedback form.
const PREP_DOC_URL =
  'https://docs.google.com/document/d/1mrBo-hMiRtpDS78Lb3K-dsn4DlRhv3ccs4gxDXFSmt4/copy';
const FEEDBACK_FORM_URL = 'https://form.typeform.com/to/Bk9erFLz';

module.exports = { AREAS, AREA_KEYS, areaLabel, PREP_DOC_URL, FEEDBACK_FORM_URL };
