'use strict';

const { supabase } = require('../config/supabase');
const log = require('../lib/logger');

/**
 * Full-fidelity, append-only message log (the `message_log` table) - independent
 * of `conversations.history`, which is capped to the last 10 entries for LLM
 * context cost and only ever stores flattened assistant text, never the actual
 * rich content (images/lists/buttons/cta) that was sent. This is the audit trail
 * the admin dashboard reads from, so it never goes stale or loses turns.
 *
 * Logging failures are swallowed (warn + continue) - a broken audit log must
 * never block the actual WhatsApp conversation.
 */

async function append(waId, direction, kind, payload, ok = true) {
  try {
    const { error } = await supabase()
      .from('message_log')
      .insert({ wa_id: waId, direction, kind, payload: payload || {}, ok });
    if (error) throw error;
  } catch (e) {
    log.warn(`messageLog.append failed (wa=${waId}, ${direction}/${kind}): ${e.message}`);
  }
}

/**
 * One inbound event - a typed message or an interactive tap (ev.text carries
 * the tap's title either way). Inbound images get their own kind: ev.text for
 * an image message is only the caption (often empty), and the bot doesn't
 * download the media itself (Meta media IDs need an authenticated fetch), so
 * flattening it to plain text would silently hide that a photo arrived at all.
 */
function logInbound(waId, ev) {
  if (ev.image) {
    return append(waId, 'in', 'image_received', {
      caption: ev.image.caption || ev.text || '',
      mediaId: ev.image.id || null,
      mimeType: ev.image.mimeType || null,
    });
  }
  return append(waId, 'in', 'text', { text: ev.text || '', replyId: ev.replyId || null });
}

/** One outbound send attempt, tagged with whether it actually reached the user. */
function logOutbound(waId, spec, ok) {
  return append(waId, 'out', spec.kind, spec, ok);
}

async function listForWaId(waId, limit = 500) {
  const { data, error } = await supabase()
    .from('message_log')
    .select('*')
    .eq('wa_id', waId)
    .order('created_at', { ascending: true })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

module.exports = { logInbound, logOutbound, listForWaId };
