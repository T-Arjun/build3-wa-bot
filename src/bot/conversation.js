'use strict';

const { supabase } = require('../config/supabase');
const log = require('../lib/logger');

/**
 * Per-WhatsApp-number conversation state, backed by the `conversations` table.
 * Used for identity, the 24h window, and "view N" / "more" pagination.
 */

const DEFAULT = {
  founder_slug: null,
  flow: null,
  step: null,
  draft: {},
  last_results: [],
  last_message_at: null,
};

async function getConversation(waId) {
  const { data, error } = await supabase()
    .from('conversations')
    .select('*')
    .eq('wa_id', waId)
    .maybeSingle();
  if (error) {
    log.error('getConversation:', error.message);
    return { wa_id: waId, ...DEFAULT };
  }
  return data || { wa_id: waId, ...DEFAULT };
}

async function saveConversation(waId, patch) {
  const row = {
    wa_id: waId,
    last_message_at: new Date().toISOString(),
    ...patch,
  };
  const { error } = await supabase()
    .from('conversations')
    .upsert(row, { onConflict: 'wa_id' });
  if (error) log.error('saveConversation:', error.message);
}

module.exports = { getConversation, saveConversation };
