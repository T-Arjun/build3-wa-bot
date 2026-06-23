'use strict';

const express = require('express');
const { env, checkConfig } = require('./config/env');
const { verifySignature } = require('./whatsapp/verifySignature');
const { parseInbound } = require('./whatsapp/parseInbound');
const { alreadyProcessed } = require('./bot/idempotency');
const { handleEvent } = require('./bot/handler');
const { startSyncSchedule } = require('./sync/schedule');
const log = require('./lib/logger');

const app = express();

// Capture the raw body so we can verify Meta's HMAC signature.
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

// Coolify injects SOURCE_COMMIT at build; expose it so we can verify what's live.
const BUILD_COMMIT =
  process.env.SOURCE_COMMIT || process.env.GIT_COMMIT || process.env.COMMIT_SHA || 'unknown';
app.get('/health', (_req, res) =>
  res.json({ ok: true, commit: BUILD_COMMIT, ts: new Date().toISOString() }),
);

// ─── Webhook verification (Meta handshake) ──────────────────────────────────
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === env.whatsapp.verifyToken) {
    log.info('webhook verified');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ─── Inbound messages ───────────────────────────────────────────────────────
app.post('/webhook', (req, res) => {
  if (!verifySignature(req)) {
    log.warn('rejected webhook: bad signature');
    return res.sendStatus(401);
  }
  // Acknowledge fast; process asynchronously (Meta retries on slow 200s).
  res.sendStatus(200);

  let events = [];
  try {
    events = parseInbound(req.body);
  } catch (err) {
    log.error('parseInbound failed:', err.message);
    return;
  }

  for (const ev of events) {
    if (alreadyProcessed(ev.messageId)) continue;
    handleEvent(ev).catch((err) => log.error('handleEvent rejected:', err.message));
  }
});

const server = app.listen(env.port, () => {
  log.info(`build3-wa-bot listening on :${env.port} (${env.nodeEnv})`);
  checkConfig([
    'source.apiBase',
    'source.apiKey',
    'supabase.url',
    'supabase.serviceKey',
    'openai.apiKey',
    'whatsapp.token',
    'whatsapp.phoneNumberId',
  ]);
  if (env.supabase.url && env.source.apiBase) {
    startSyncSchedule();
  } else {
    log.warn('sync schedule not started — Supabase/source not configured');
  }
});

module.exports = { app, server };
