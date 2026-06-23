'use strict';

const { createClient } = require('@supabase/supabase-js');
const { env } = require('./env');

let client = null;

/**
 * Lazily create a service-role Supabase client. Service role bypasses RLS and
 * must only ever be used server-side (this process is server-only).
 */
function supabase() {
  if (client) return client;
  if (!env.supabase.url || !env.supabase.serviceKey) {
    throw new Error('Supabase not configured: set SUPABASE_URL and SUPABASE_SERVICE_KEY');
  }
  client = createClient(env.supabase.url, env.supabase.serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}

module.exports = { supabase };
