'use strict';

require('dotenv').config();

function bool(v, fallback = false) {
  if (v === undefined || v === null || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}

const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT, 10) || 3000,

  source: {
    apiBase: (process.env.SOURCE_API_BASE || '').replace(/\/+$/, ''),
    apiKey: process.env.SOURCE_API_KEY || '',
  },

  supabase: {
    url: process.env.SUPABASE_URL || '',
    serviceKey: process.env.SUPABASE_SERVICE_KEY || '',
    avatarBucket: process.env.SUPABASE_AVATAR_BUCKET || 'avatars',
  },

  openai: {
    apiKey: process.env.OPENAI_API_KEY || '',
    model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
  },

  whatsapp: {
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || '',
    appSecret: process.env.WHATSAPP_APP_SECRET || '',
    token: process.env.WHATSAPP_TOKEN || '',
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
    graphVersion: process.env.WHATSAPP_GRAPH_VERSION || 'v21.0',
  },

  sync: {
    cron: process.env.SYNC_CRON || '0 */6 * * *',
    onBoot: bool(process.env.SYNC_ON_BOOT, true),
  },
};

function get(path) {
  return path.split('.').reduce((o, k) => (o ? o[k] : undefined), env);
}

/**
 * Warn (don't crash) about missing config, so the service can still boot for
 * partial work (e.g. running the webhook before the sync source is wired).
 * Returns the list of missing keys.
 */
function checkConfig(required = []) {
  const missing = required.filter((k) => !get(k));
  if (missing.length) {
    console.warn(`[config] missing env: ${missing.join(', ')}`);
  }
  return missing;
}

module.exports = { env, checkConfig };
