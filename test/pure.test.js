'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { parseInbound } = require('../src/whatsapp/parseInbound');
const { mapFounder } = require('../src/sync/mapFounder');
const fmt = require('../src/bot/format');
const { COFOUNDER_INTENT } = require('../src/domain/enums');

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
