'use strict';

/**
 * Canonical seed for the build3 mentor directory, transcribed from
 * the "Book Mentor Hours" program page. This is both the input to the seed
 * script (scripts/seed_mentors.js) and the fallback the domain layer uses when
 * the Supabase `mentors` table is absent or empty. Once the table is seeded and
 * editable from /admin, the table is the source of truth.
 *
 * Booking links are external (each mentor owns their own calendar). LinkedIn is
 * null where the program page only had a placeholder - build3 to supply real
 * URLs; the card simply omits the line when null.
 */

const MENTORS = [
  {
    slug: 'varun-chawla',
    name: 'Varun Chawla',
    expertise: 'Building teams, financing, product, GTM, funding & investor relations',
    areas: ['fundraising', 'gtm', 'strategy'],
    booking_url: 'https://calendar.app.google/FdGRY3etwWYRVmwU6',
    booking_platform: 'google',
    linkedin_url: 'https://www.linkedin.com/in/varunchawla1/',
    sort_order: 1,
  },
  {
    slug: 'sanya-kalani',
    name: 'Sanya Kalani',
    expertise: 'GTM, finding the first 100 customers, fundraising',
    areas: ['gtm', 'fundraising'],
    booking_url: 'https://calendar.app.google/RiCwv144973J9Fkh6',
    booking_platform: 'google',
    linkedin_url: null,
    sort_order: 2,
  },
  {
    slug: 'anshu-budhraja',
    name: 'Anshu Budhraja',
    expertise: 'D2C, growth, strategy & scaling of consumer brands',
    areas: ['gtm', 'marketing', 'strategy'],
    booking_url: 'https://calendar.app.google/Mdrhj6QT6A3xfWPF9',
    booking_platform: 'google',
    linkedin_url: null,
    sort_order: 3,
  },
  {
    slug: 'karanvir-gupta',
    name: 'Karanvir Gupta',
    expertise: 'Product marketing, GTM, sales enablement, content strategy, branding, customer marketing',
    areas: ['marketing', 'gtm'],
    booking_url: 'https://zcal.co/karanvir/30min',
    booking_platform: 'zcal',
    linkedin_url: null,
    sort_order: 4,
  },
  {
    slug: 'ashmita-dutta',
    name: 'Ashmita Dutta',
    expertise: 'Marketing strategy, market research, positioning',
    areas: ['marketing'],
    booking_url: 'https://calendly.com/ashmita-fractionalmarketing/introduction-meeting',
    booking_platform: 'calendly',
    linkedin_url: null,
    sort_order: 5,
  },
  {
    slug: 'arvind-gourishankar',
    name: 'Arvind Gourishankar',
    expertise: 'Fundraising-doc reviews, financial models, GTM, operations, business strategy',
    areas: ['fundraising', 'gtm', 'strategy'],
    booking_url: 'https://calendar.app.google/V2AFhTrJk8Qibgum9',
    booking_platform: 'google',
    linkedin_url: null,
    sort_order: 6,
  },
  {
    slug: 'sourav-das',
    name: 'Sourav Das',
    expertise: 'Impact measurement, green & sustainable finance, DFI/MDB funding, climate strategy, investor readiness, blended finance',
    areas: ['impact', 'fundraising'],
    booking_url: 'https://zcal.co/souravdas/30min',
    booking_platform: 'zcal',
    linkedin_url: null,
    sort_order: 7,
  },
  {
    slug: 'prathik-chaudhri',
    name: 'Prathik Chaudhri',
    expertise: 'Product & UX design, building traction',
    areas: ['product', 'tech'],
    booking_url: 'https://cal.com/prathik-chaudhri-htogdg',
    booking_platform: 'calcom',
    linkedin_url: null,
    sort_order: 8,
  },
  {
    slug: 'aseem-gautam',
    name: 'Aseem Gautam',
    expertise: 'CTO, tech, product - building your v1',
    areas: ['tech', 'product'],
    booking_url: 'https://cal.com/stackway/building-your-v1',
    booking_platform: 'calcom',
    linkedin_url: 'https://www.linkedin.com/in/aseemgautam/',
    sort_order: 9,
  },
  {
    slug: 'srix',
    name: 'Srix',
    expertise: 'Fractional CTO, tech, product',
    areas: ['tech', 'product'],
    booking_url: 'https://calendly.com/srix-srk/build3',
    booking_platform: 'calendly',
    linkedin_url: null,
    sort_order: 10,
  },
  {
    slug: 'ajay-gupta',
    name: 'Ajay Gupta',
    expertise: 'Feedback on ideas, brainstorming, resources & networks, personal challenges',
    areas: ['strategy'],
    booking_url: 'https://calendar.app.google/W5g3y8SzbR4gkdgY9',
    booking_platform: 'google',
    linkedin_url: null,
    sort_order: 11,
  },
  {
    slug: 'ayushmaan-kapoor',
    name: 'Ayushmaan Kapoor',
    expertise: 'GTM, product-market fit',
    areas: ['gtm'],
    booking_url: 'https://calendar.app.google/z5GTjcbWun7ArqJM9',
    booking_platform: 'google',
    linkedin_url: null,
    sort_order: 12,
  },
  {
    slug: 'girish-sampath',
    name: 'Girish Sampath',
    expertise: 'Strategy, business-model design, impact measurement, finance for startups',
    areas: ['strategy', 'impact', 'fundraising'],
    booking_url: 'https://calendar.app.google/RfJ1s5yV9QzaAFsC8',
    booking_platform: 'google',
    linkedin_url: 'https://www.linkedin.com/in/girishsampath',
    sort_order: 13,
  },
];

module.exports = { MENTORS };
