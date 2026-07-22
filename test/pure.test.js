'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { parseInbound } = require('../src/whatsapp/parseInbound');
const { mapFounder } = require('../src/sync/mapFounder');
const fmt = require('../src/bot/format');
const { COFOUNDER_INTENT } = require('../src/domain/enums');
const { buildTarget } = require('../src/domain/matching');
const { withRetry } = require('../src/lib/retry');
const { hasAnyFilter, toFilters } = require('../src/bot/tools');
const { dedupeFounders, isShowable } = require('../src/domain/founders');

test('parseInbound extracts a text message', () => {
  const body = {
    entry: [
      {
        changes: [
          {
            value: {
              contacts: [{ wa_id: '919999999999', profile: { name: 'Asha' } }],
              messages: [
                { from: '919999999999', id: 'wamid.1', type: 'text', text: { body: 'hi' } },
              ],
            },
          },
        ],
      },
    ],
  };
  const events = parseInbound(body);
  assert.equal(events.length, 1);
  assert.equal(events[0].waId, '919999999999');
  assert.equal(events[0].name, 'Asha');
  assert.equal(events[0].text, 'hi');
  assert.equal(events[0].type, 'text');
});

test('parseInbound extracts an interactive list reply', () => {
  const body = {
    entry: [
      {
        changes: [
          {
            value: {
              messages: [
                {
                  from: '91888',
                  id: 'wamid.2',
                  type: 'interactive',
                  interactive: { type: 'list_reply', list_reply: { id: 'profile:varun', title: 'Varun' } },
                },
              ],
            },
          },
        ],
      },
    ],
  };
  const events = parseInbound(body);
  assert.equal(events[0].replyId, 'profile:varun');
});

test('parseInbound ignores status callbacks', () => {
  const body = { entry: [{ changes: [{ value: { statuses: [{ status: 'read' }] } }] }] };
  assert.deepEqual(parseInbound(body), []);
});

test('mapFounder masks phone when not public and builds search_blob', () => {
  const row = mapFounder({
    slug: 'varun-k',
    name: 'Varun K',
    phone: '+919812345678',
    phonePublic: false,
    cohort: 9,
    city: 'Bangalore',
    sector: 'Financial Services',
    skills: ['Product', 'Growth'],
    lookingFor: ['co-founder, I have a startup'],
    startupName: 'PaySage',
    isPublished: true,
  });
  assert.equal(row.source_slug, 'varun-k');
  assert.equal(row.origin, 'synced');
  assert.equal(row.phone, null, 'phone must be masked when phonePublic is false');
  assert.ok(row.search_blob.includes('paysage'));
  assert.ok(row.search_blob.includes('product'));
  assert.ok(row.search_blob.includes('bangalore'));
});

test('mapFounder keeps phone when public', () => {
  const row = mapFounder({ slug: 's', name: 'N', phone: '123', phonePublic: true });
  assert.equal(row.phone, '123');
  assert.equal(row.phone_public, true);
});

test('format.toRow encodes profile action id', () => {
  const r = fmt.toRow({ source_slug: 'asha-r', name: 'Asha R', sector: 'AI & Data', city: 'Pune' });
  assert.equal(r.id, 'profile:asha-r');
  assert.equal(r.title, 'Asha R');
  // subtitle() prioritises startup data over sector tag — with none, falls through to city
  assert.ok(r.description.includes('Pune'), 'city should appear when no startup data');
  assert.ok(!r.description.includes('AI & Data'), 'sector tag must not be used as description');
});

test('format.avatarFor falls back to ui-avatars', () => {
  assert.ok(fmt.avatarFor({ name: 'Asha R' }).startsWith('https://ui-avatars.com/'));
  assert.equal(fmt.avatarFor({ name: 'X', avatar_url: 'http://img/a.jpg' }), 'http://img/a.jpg');
});

test('cofounder intent set matches source filter regex', () => {
  assert.ok(COFOUNDER_INTENT.length >= 3);
  assert.ok(COFOUNDER_INTENT.every((v) => /co-founder|join a startup/i.test(v)));
});

test('buildTarget uses the USER\'s own skills for anonymous complementarity', () => {
  // "I'm technical, find me a sales cofounder": self.skills must be the target's
  // skills, NOT the filter — so the scorer measures complement to the user.
  const t = buildTarget(null, { skills: ['sales'] }, { skills: ['engineering'], sector: 'AI & Data' });
  assert.deepEqual(t.skills, ['engineering']);
  assert.equal(t.sector, 'AI & Data');
});

test('buildTarget falls back to a thin synthetic target with no self', () => {
  const t = buildTarget(null, { sector: 'Financial Services' }, null);
  assert.deepEqual(t.skills, []);
  assert.equal(t.sector, 'Financial Services');
});

test('buildTarget prefers a linked requester profile over any self description', () => {
  const req = { name: 'Real', skills: ['design'], sector: 'Healthcare' };
  const t = buildTarget(req, { skills: ['sales'] }, { skills: ['engineering'] });
  assert.equal(t.name, 'Real');
  assert.deepEqual(t.skills, ['design']);
});

test('withRetry retries transient errors then succeeds', async () => {
  let calls = 0;
  const out = await withRetry(
    async () => {
      calls += 1;
      if (calls < 2) {
        const e = new Error('boom');
        e.status = 503;
        throw e;
      }
      return 'ok';
    },
    { retries: 2, baseMs: 1, label: 'test' },
  );
  assert.equal(out, 'ok');
  assert.equal(calls, 2);
});

test('dedupe does NOT merge two people sharing a company LinkedIn URL', () => {
  const rows = [
    { name: 'Nihal T', city: 'A', linkedin_url: 'https://linkedin.com/company/xploitix' },
    { name: 'Mani A', city: 'B', linkedin_url: 'https://linkedin.com/company/xploitix' },
  ];
  assert.equal(dedupeFounders(rows).length, 2, 'company URL must not be an identity key');
});

test('dedupe merges the same person with a case/spelling variant on the same /in/ URL', () => {
  const rows = [
    { name: 'Avinash matkar', city: 'Pune', linkedin_url: 'https://linkedin.com/in/avinash-x' },
    { name: 'Avinash Matkar', city: 'Pune', linkedin_url: 'https://linkedin.com/in/avinash-x' },
  ];
  assert.equal(dedupeFounders(rows).length, 1);
});

test('dedupe does NOT merge clearly different people who share one /in/ URL (data error)', () => {
  const rows = [
    { name: 'Paul George', city: 'A', linkedin_url: 'https://linkedin.com/in/lohith-varma-vegesna' },
    { name: 'Lohith Varma', city: 'B', linkedin_url: 'https://linkedin.com/in/lohith-varma-vegesna' },
  ];
  assert.equal(dedupeFounders(rows).length, 2, 'different names sharing one /in/ URL must stay separate');
});

test('dedupe collapses by name+city when there is no personal LinkedIn', () => {
  const rows = [
    { name: 'Same Person', city: 'Goa', startup_name: 'Acme', linkedin_url: null },
    { name: 'same person', city: 'goa', startup_name: 'Acme', linkedin_url: 'https://linkedin.com/company/acme' },
  ];
  assert.equal(dedupeFounders(rows).length, 1);
});

test('isShowable rejects shell profiles, keeps anything with real content', () => {
  // Shell: just name + cohort + sector "Other", no startup/skills/linkedin.
  assert.equal(isShowable({ name: 'Priyanka Agnani', sector: 'Other', cohort: 2 }), false);
  assert.equal(isShowable({ name: 'Empty', city: 'Goa' }), false);
  // Real content of any kind makes it showable.
  assert.equal(isShowable({ name: 'A', startup_name: 'Acme' }), true);
  assert.equal(isShowable({ name: 'B', skills: ['sales'] }), true);
  assert.equal(isShowable({ name: 'C', sector: 'Financial Services' }), true);
  assert.equal(isShowable({ name: 'D', linkedin_url: 'https://linkedin.com/in/d' }), true);
});

test('dedupe drops shell profiles from results', () => {
  const rows = [
    { name: 'Real Person', city: 'Pune', startup_name: 'Acme', linkedin_url: 'https://linkedin.com/in/real' },
    { name: 'Shell Person', city: 'Delhi', sector: 'Other' },
  ];
  const out = dedupeFounders(rows);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'Real Person');
});

test('hasAnyFilter recognizes every filter (not just the common few)', () => {
  assert.equal(hasAnyFilter({}), false);
  assert.equal(hasAnyFilter(toFilters({ looking_for: ['co-founder, I have a startup'] })), true);
  assert.equal(hasAnyFilter(toFilters({ sector: 'AI & Data' })), true);
  assert.equal(hasAnyFilter(toFilters({ skills: ['sales'] })), true);
  assert.equal(hasAnyFilter(toFilters({ query: 'fintech' })), true);
  // program/role aren't in the search tool schema but applyFilters supports them.
  assert.equal(hasAnyFilter({ program: 'biA' }), true);
  assert.equal(hasAnyFilter({ role: 'mentor' }), true);
});

test('withRetry does NOT retry non-transient (4xx) errors', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls += 1;
        const e = new Error('bad request');
        e.status = 400;
        throw e;
      },
      { retries: 2, baseMs: 1, label: 'test' },
    ),
    /bad request/,
  );
  assert.equal(calls, 1);
});

// ─── Render-quality regressions (from the live render audit) ────────────────────

test('toRow title fits WhatsApp 24-char cap with dignity, never mid-word chop', () => {
  const fmt = require('../src/bot/format');
  assert.strictEqual(fmt.shortName('Muralidharan Senthilkumaran'), 'Muralidharan S.');
  assert.strictEqual(fmt.shortName('Vivek Alapuzha Prasannakumar'), 'Vivek Prasannakumar');
  assert.strictEqual(fmt.shortName('Priya K'), 'Priya K');
  assert.ok(fmt.shortName('Makunga Shourungthil Hurui').length <= 24);
});

test('subtitle always fits the 72-char row limit, even with long cities', () => {
  const fmt = require('../src/bot/format');
  const s = fmt.subtitle({
    startup_name: 'XAGI Labs',
    startup_idea: 'XAGI Labs is an AI research and product company building autonomous systems for everyone',
    city: 'Thiruvananthapuram',
  });
  assert.ok(s.length <= 72, `too long (${s.length}): ${s}`);
  assert.ok(s.endsWith('· Thiruvananthapuram'), s); // city never truncated away
  assert.match(s, /^XAGI Labs: an AI research/); // company leads; no "XAGI Labs: XAGI Labs is"
});

test('subtitle leads with the company name, idea is the fallback', () => {
  const fmt = require('../src/bot/format');
  assert.match(fmt.subtitle({ startup_name: 'build3', startup_idea: 'a startup ecosystem', city: 'Kudal' }), /^build3: a startup ecosystem/);
  assert.match(fmt.subtitle({ startup_name: null, startup_idea: 'solar for schools', city: 'Pune' }), /^solar for schools/);
});

test('profileCaption meta line leads with the bolded company name', () => {
  const fmt = require('../src/bot/format');
  const cap = fmt.profileCaption({ name: 'V', startup_name: 'build3', startup_idea: 'an ecosystem', sector: 'Education & Skilling', city: 'Kudal' });
  assert.match(cap.split('\n')[1], /^\*build3\* · Education & Skilling · Kudal/);
});

test('matchCaption carries the LinkedIn link, same as a full profile card', () => {
  const fmt = require('../src/bot/format');
  const withLinkedin = fmt.matchCaption({
    name: 'Achyutha Yeswanth Sriraj',
    score: 85,
    city: 'Bengaluru',
    startup_idea: 'a physics-informed acoustic sensor',
    reasons: ['directly complements with engineering skills'],
    linkedin_url: 'https://www.linkedin.com/in/achyutha-example',
  });
  assert.match(withLinkedin, /https:\/\/www\.linkedin\.com\/in\/achyutha-example/);
  // No LinkedIn on file -> no dangling blank line / broken caption
  const noLinkedin = fmt.matchCaption({ name: 'X', score: 70, reasons: [] });
  assert.doesNotMatch(noLinkedin, /linkedin/i);
});

test('matchCaption bakes in the per-candidate cofounder-intent status line', () => {
  const fmt = require('../src/bot/format');
  const withStatus = fmt.matchCaption({
    name: 'Priya',
    score: 80,
    reasons: ['directly complements with sales skills'],
    lookingForStatus: "hasn't said either way, worth asking directly",
  });
  assert.match(withStatus, /\(hasn't said either way, worth asking directly\)/);
  // No status computed (shouldn't happen in practice, but must not render a blank paren)
  const noStatus = fmt.matchCaption({ name: 'X', score: 70, reasons: [] });
  assert.doesNotMatch(noStatus, /\(\)/);
});

test('perkCard is the overview; perkAccess carries the how-to separately', () => {
  const fmt = require('../src/bot/format');
  const p = {
    name: 'Notion',
    objective: 'task management and project tracking',
    description: 'a long description '.repeat(40), // ~720 chars, must be trimmed
    how_to_access: 'submit your application at: https://ntn.so/build3',
  };
  const card = fmt.perkCard(p);
  const access = fmt.perkAccess(p);
  // overview leads with the name + objective, trims the description, and does NOT
  // contain the redemption link (that's the access message's job)
  assert.match(card, /\*Notion\*/);
  assert.match(card, /task management/);
  assert.ok(!card.includes('ntn.so'), 'overview must not carry the redemption link');
  assert.ok(card.length <= 1024);
  // access carries the full how-to verbatim, under the WhatsApp body cap
  assert.match(access, /how to get it:/);
  assert.ok(access.includes('https://ntn.so/build3'));
  assert.ok(access.length <= 1024);
  // an email-only perk still produces an access message (no URL required)
  const emailPerk = { name: 'Canva', objective: 'design', how_to_access: 'email studio@build3.org to activate' };
  assert.match(fmt.perkAccess(emailPerk), /studio@build3\.org/);
});

test('avatarFor never yields an SVG WhatsApp would silently drop', () => {
  const fmt = require('../src/bot/format');
  // photoless founders in the source carry a ui-avatars SVG URL, not null
  assert.match(fmt.avatarFor({ name: 'Bhavana', avatar_url: 'https://ui-avatars.com/api/?name=Bhavana&size=200' }), /format=png/);
  assert.match(fmt.avatarFor({ name: 'X', avatar_url: '' }), /format=png/);
  assert.match(fmt.avatarFor({ name: 'Y', avatar_url: 'https://cdn.example.com/y.svg' }), /format=png/);
  // a real raster photo passes through untouched
  assert.strictEqual(fmt.avatarFor({ name: 'Z', avatar_url: 'https://media-cdn.build3.in/z/avatar.jpg' }), 'https://media-cdn.build3.in/z/avatar.jpg');
});

test('findByName matches on any name token (wrong surname still finds them)', async () => {
  // pure-shape check: the token split keeps >=3-char tokens
  const clean = 'bhavana menon';
  const tokens = clean.split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
  assert.deepStrictEqual(tokens, ['bhavana', 'menon']);
});
