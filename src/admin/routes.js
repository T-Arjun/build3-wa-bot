'use strict';

const express = require('express');
const crypto = require('crypto');
const { supabase } = require('../config/supabase');
const { env } = require('../config/env');
const { MENTORS } = require('../domain/mentors.data');
const { AREA_KEYS } = require('../domain/mentorAreas');
const wa = require('../whatsapp/cloudApi');
const messageLog = require('../domain/messageLog');

const router = express.Router();

/**
 * Constant-time string comparison for the admin token. `!==` short-circuits at
 * the first mismatched character, which is a textbook timing side-channel for
 * a secret comparison (network jitter makes it hard to exploit remotely, but
 * it costs nothing to do this properly). Buffers of different lengths still
 * run a same-length dummy compare so the early-return itself doesn't leak
 * length information.
 */
function tokenMatches(a, b) {
  const bufA = Buffer.from(String(a || ''));
  const bufB = Buffer.from(String(b || ''));
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, Buffer.alloc(bufA.length));
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Minimal in-memory brute-force throttle on the admin token check - there was
 * previously NO limit at all on failed auth attempts. Scoped to this module
 * (no new dependency, mirrors the existing in-memory-bounded-state idiom used
 * by bot/idempotency.js) rather than a general-purpose rate limiter; this
 * endpoint's only job is to slow down token guessing, not shape traffic.
 * Keyed by IP when available, falling back to a single global bucket so it
 * still throttles even if the proxy strips/normalizes source IPs.
 */
const MAX_FAILURES = 8;
const WINDOW_MS = 60_000;
const failures = new Map(); // key -> { count, resetAt }

function isRateLimited(key) {
  const now = Date.now();
  const rec = failures.get(key);
  if (!rec || now > rec.resetAt) return false;
  return rec.count >= MAX_FAILURES;
}

function recordFailure(key) {
  const now = Date.now();
  const rec = failures.get(key);
  if (!rec || now > rec.resetAt) {
    failures.set(key, { count: 1, resetAt: now + WINDOW_MS });
  } else {
    rec.count += 1;
  }
}

// ─── Auth ───────────────────────────────────────────────────────────────────
router.use((req, res, next) => {
  if (!env.adminToken) return res.status(503).send('Admin panel not configured (ADMIN_TOKEN not set).');
  const key = req.ip || 'global';
  if (isRateLimited(key)) {
    return res.status(429).send('Too many attempts. Try again in a minute.');
  }
  const token = req.query.token || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!tokenMatches(token, env.adminToken)) {
    recordFailure(key);
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
    return res.status(401).send(loginHtml());
  }
  next();
});

// ─── API: list conversations ─────────────────────────────────────────────────
router.get('/api/conversations', async (_req, res) => {
  try {
    const { data, error } = await supabase()
      .from('conversations')
      .select('wa_id, last_message_at, history, founder_slug, draft')
      .order('last_message_at', { ascending: false })
      .limit(200);
    if (error) return res.status(500).json({ error: error.message });
    const rows = data || [];
    const knownIds = new Set(rows.map((r) => r.wa_id));

    // `history` is capped to 10 for LLM context - the sidebar badge needs the
    // REAL total, and message_log_summary (grouped server-side by Postgres,
    // scaling with the number of conversations rather than total log size)
    // gives both that count and the real last-activity timestamp in one query.
    let summary = [];
    try {
      const { data: summaryRows, error: sumErr } = await supabase()
        .from('message_log_summary')
        .select('wa_id, message_count, last_message_at');
      if (sumErr) throw sumErr;
      summary = summaryRows || [];
      const counts = {};
      for (const r of summary) counts[r.wa_id] = r.message_count;
      for (const c of rows) c.message_count = counts[c.wa_id] || 0;
    } catch (_e) {
      // view unavailable (migration not applied yet) - badge falls back below.
    }

    // A wa_id can have real message_log history with NO conversations row -
    // e.g. that table was ever cleared/reset while message_log (the
    // append-only audit trail) survived untouched, and the founder never
    // messaged again to recreate it. Without this, that founder's entire
    // conversation silently disappears from the sidebar even though it's
    // still on record - found live when two real founders' pre-reset
    // conversations turned out to still be in message_log but invisible here.
    const orphaned = summary.filter((s) => !knownIds.has(s.wa_id));
    if (orphaned.length) {
      try {
        const { data: previews, error: prevErr } = await supabase()
          .from('message_log')
          .select('wa_id, direction, payload')
          .in(
            'wa_id',
            orphaned.map((o) => o.wa_id),
          )
          .eq('direction', 'in')
          .order('id', { ascending: false });
        if (prevErr) throw prevErr;
        const previewByWaId = {};
        for (const m of previews || []) {
          if (!(m.wa_id in previewByWaId)) previewByWaId[m.wa_id] = m.payload || {};
        }
        for (const o of orphaned) {
          const p = previewByWaId[o.wa_id] || {};
          rows.push({
            wa_id: o.wa_id,
            last_message_at: o.last_message_at,
            history: [],
            founder_slug: null,
            draft: null,
            message_count: o.message_count,
            last_preview: p.text || p.body || null,
            orphaned: true,
          });
        }
        rows.sort((a, b) => new Date(b.last_message_at) - new Date(a.last_message_at));
      } catch (_e) {
        // preview lookup failed - orphaned conversations still show, just without a preview line.
        for (const o of orphaned) {
          rows.push({
            wa_id: o.wa_id,
            last_message_at: o.last_message_at,
            history: [],
            founder_slug: null,
            draft: null,
            message_count: o.message_count,
            orphaned: true,
          });
        }
        rows.sort((a, b) => new Date(b.last_message_at) - new Date(a.last_message_at));
      }
    }

    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── API: single conversation ────────────────────────────────────────────────
router.get('/api/conversations/:waId', async (req, res) => {
  try {
    const { data, error } = await supabase()
      .from('conversations')
      .select('*')
      .eq('wa_id', req.params.waId)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    // No conversations row (e.g. that table was reset while message_log
    // survived) shouldn't mean "nothing to show" - the dashboard's thread
    // view reads the actual messages from message_log regardless, so this
    // still needs a shape the client can render against instead of null.
    res.json(data || { wa_id: req.params.waId, history: [], draft: {}, founder_slug: null, last_message_at: null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── API: full-fidelity message log for one conversation ────────────────────
// Unbounded, unlike conversations.history (capped to 10 for LLM context) - this
// is what the dashboard renders so it always matches what actually hit WhatsApp.
router.get('/api/conversations/:waId/messages', async (req, res) => {
  try {
    // Fetch the MOST RECENT rows first (id desc - a strictly monotonic insert
    // order, safer than created_at when several rows land in the same
    // millisecond), then reverse to ascending for display. A cap has to bias
    // toward recency: capping oldest-first would hide exactly the newest
    // messages once a conversation passes the limit - the same "not the full
    // conversation" bug this table was built to fix.
    const { data, error } = await supabase()
      .from('message_log')
      .select('*')
      .eq('wa_id', req.params.waId)
      .order('id', { ascending: false })
      .limit(2000);
    if (error) return res.status(500).json({ error: error.message });
    res.json((data || []).reverse());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── API: clear conversation history ────────────────────────────────────────
router.delete('/api/conversations/:waId', async (req, res) => {
  try {
    // `focus` is NOT a top-level column - it lives inside `draft` (draft.focus,
    // set by handler.persistDraft). Clearing draft to {} already wipes it;
    // including a bare `focus` key here made every clear silently fail (no
    // such column) until this fix.
    const { error } = await supabase()
      .from('conversations')
      .update({ history: [], draft: {}, last_results: [] })
      .eq('wa_id', req.params.waId);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── API: list mentors (table, falling back to the static seed) ──────────────
router.get('/api/mentors', async (_req, res) => {
  try {
    const { data, error } = await supabase()
      .from('mentors')
      .select('*')
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true });
    if (error) throw error;
    if (data && data.length) return res.json({ source: 'table', mentors: data });
  } catch (_e) {
    // table missing / empty → serve the static seed read-only
  }
  res.json({ source: 'seed', mentors: MENTORS.map((s) => ({ ...s, is_active: s.is_active !== false })) });
});

// ─── API: upsert a mentor (by slug) ──────────────────────────────────────────
router.post('/api/mentors', async (req, res) => {
  const b = req.body || {};
  if (!b.slug || !b.name || !b.booking_url) {
    return res.status(400).json({ error: 'slug, name, and booking_url are required' });
  }
  // Every one of these gets rendered later as a raw href/src (dashboardHtml's
  // renderBubble, mentorsHtml's table) - with NO scheme check, a `javascript:`
  // URL saved here becomes a stored XSS that fires in whichever admin session
  // clicks it (proved live: a booking_url of "javascript:alert(document.
  // location)" was accepted and would have rendered as <a href="javascript:
  // ...">). Reject anything that isn't a real http(s) link at the write
  // boundary - the correct single point of truth, rather than only patching
  // the render layer.
  for (const [field, required] of [['booking_url', true], ['linkedin_url', false], ['avatar_url', false]]) {
    const v = b[field];
    if (!v) continue;
    if (!/^https?:\/\//i.test(String(v).trim())) {
      return res.status(400).json({ error: `${field} must be an http(s) URL` });
    }
  }
  const row = {
    slug: String(b.slug).trim(),
    name: String(b.name).trim(),
    expertise: b.expertise || '',
    areas: Array.isArray(b.areas) ? b.areas.filter((a) => AREA_KEYS.includes(a)) : [],
    booking_url: String(b.booking_url).trim(),
    booking_platform: b.booking_platform || null,
    linkedin_url: b.linkedin_url || null,
    avatar_url: b.avatar_url || null,
    bio: b.bio || null,
    is_active: b.is_active !== false,
    sort_order: Number.isInteger(b.sort_order) ? b.sort_order : 100,
  };
  try {
    const { error } = await supabase().from('mentors').upsert(row, { onConflict: 'slug' });
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── API: deactivate a mentor (soft delete) ──────────────────────────────────
router.delete('/api/mentors/:slug', async (req, res) => {
  try {
    const { error } = await supabase()
      .from('mentors')
      .update({ is_active: false })
      .eq('slug', req.params.slug);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── API: list approved WhatsApp templates straight from Meta ─────────────────
// This is the "does the app actually know about Meta" piece: rather than
// requiring an exact template name typed blind (and hoping it matches what's
// really approved on the WABA), the dashboard fetches the real list so the
// send-template control can offer a dropdown of what's actually usable.
router.get('/api/templates', async (_req, res) => {
  if (!env.whatsapp.businessAccountId) {
    return res.status(503).json({ error: 'WHATSAPP_BUSINESS_ACCOUNT_ID not configured' });
  }
  try {
    const url = `https://graph.facebook.com/${env.whatsapp.graphVersion}/${env.whatsapp.businessAccountId}/message_templates?fields=name,status,category,language,components`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${env.whatsapp.token}` } });
    const j = await r.json();
    if (!r.ok) return res.status(502).json({ error: j.error?.message || 'Meta API error' });
    const templates = (j.data || []).map((t) => {
      const body = (t.components || []).find((c) => c.type === 'BODY');
      return { name: t.name, status: t.status, category: t.category, language: t.language, bodyPreview: body?.text || '' };
    });
    res.json({ templates });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ─── API: send a business-initiated template message ─────────────────────────
// The ONLY way to reach a number that hasn't messaged in within the last 24h
// (see cloudApi.sendTemplate). This is the single logged path for that - it
// sends AND writes to message_log AND touches the conversations row in one
// place, so a template send is never invisible in the dashboard the way a
// one-off script calling cloudApi.sendTemplate() directly would be (that gap
// is exactly what happened before this endpoint existed: a real template send
// left the number's thread starting mid-conversation, with no record of the
// message that actually opened it).
router.post('/api/send-template', async (req, res) => {
  const b = req.body || {};
  const waId = String(b.waId || '').replace(/[^0-9]/g, '');
  const name = String(b.name || '').trim();
  if (!waId || !name) return res.status(400).json({ error: 'waId and name are required' });
  const languageCode = b.languageCode || 'en';
  const components = Array.isArray(b.components) ? b.components : undefined;

  let result;
  let ok = true;
  let wamid = null;
  try {
    result = await wa.sendTemplate(waId, name, languageCode, components);
    wamid = result?.messages?.[0]?.id || null;
  } catch (e) {
    ok = false;
    result = { error: e.message };
  }

  // Log the attempt regardless of outcome - a failed template send is exactly
  // the kind of thing that needs to be visible, not silently swallowed.
  await messageLog.logOutbound(
    waId,
    { kind: 'template', name, languageCode, components, bodyPreview: b.bodyPreview || null },
    ok,
    wamid,
  );

  // Make the number appear in the sidebar immediately, even before any reply -
  // otherwise it's invisible in the dashboard until (if ever) they respond.
  // Best-effort: the message_log row above is the real record either way.
  try {
    await supabase().from('conversations').upsert(
      { wa_id: waId, last_message_at: new Date().toISOString() },
      { onConflict: 'wa_id' },
    );
  } catch (_e) {
    // conversations row is a convenience for the sidebar, not the source of truth
  }

  if (!ok) return res.status(502).json({ error: result.error || 'send failed' });
  res.json({ ok: true, result });
});

// ─── Dashboard HTML ──────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  res.send(dashboardHtml(req.query.token));
});

router.get('/mentors', (req, res) => {
  res.send(mentorsHtml(req.query.token));
});

// Test hooks attached to the router function itself (Express routers ARE
// callable middleware functions, so this doesn't disturb `app.use('/admin',
// adminRouter)` at all) - keeps tokenMatches/isValidUrl unit-testable without
// spinning up a real HTTP server, matching this codebase's existing
// pure-function-extraction testing convention.
router._testHooks = {
  tokenMatches,
  isValidUrl: (v) => !v || /^https?:\/\//i.test(String(v).trim()),
  isRateLimited,
  recordFailure,
  resetRateLimiter: () => failures.clear(),
};

module.exports = router;

// ─── HTML ────────────────────────────────────────────────────────────────────

function loginHtml() {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>build3 admin</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,sans-serif;background:#0a0a0a;color:#e0e0e0;height:100vh;display:flex;align-items:center;justify-content:center}
.card{background:#1a1a1a;border:1px solid #2a2a2a;border-radius:12px;padding:36px;width:340px}
h1{font-size:20px;font-weight:700;margin-bottom:4px}p{color:#888;font-size:13px;margin-bottom:24px}
input{width:100%;background:#111;border:1px solid #333;border-radius:8px;color:#e0e0e0;font-size:14px;padding:10px 14px;outline:none;margin-bottom:12px}
button{width:100%;background:#4f46e5;border:none;border-radius:8px;color:#fff;cursor:pointer;font-size:14px;font-weight:600;padding:10px;transition:.15s}
button:hover{background:#4338ca}
</style></head>
<body><div class="card"><h1>build3 admin</h1><p>Enter your admin token to continue.</p>
<form onsubmit="go(event)"><input type="password" id="t" placeholder="Admin token" autofocus><button type="submit">Sign in</button></form>
</div><script>function go(e){e.preventDefault();const t=document.getElementById('t').value;if(t)window.location='/admin?token='+encodeURIComponent(t);}</script></body></html>`;
}

function dashboardHtml(token) {
  const apiBase = `/admin/api`;
  const qs = token ? `?token=${encodeURIComponent(token)}` : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>build3 - bot monitor</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#ededed;color:#111b21;height:100vh;display:flex;flex-direction:column;overflow:hidden}

/* Real WhatsApp Web light theme: off-white app chrome, teal-green accent,
   white sidebar/panels, tan chat wallpaper, white/light-green bubbles. */
.header{background:#f0f2f5;border-bottom:1px solid #d1d7db;padding:10px 20px;display:flex;align-items:center;gap:12px;flex-shrink:0}
.logo{font-size:15px;font-weight:700;color:#111b21;letter-spacing:-.3px}
.logo span{color:#008069}
.badge{background:#e9edef;border:1px solid #d1d7db;border-radius:6px;color:#54656f;font-size:11px;font-weight:600;padding:2px 8px;letter-spacing:.3px}
.header-right{display:flex;align-items:center;gap:10px;margin-left:auto}
.refresh-info{color:#667781;font-size:11px}
.btn{background:#fff;border:1px solid #d1d7db;border-radius:7px;color:#008069;cursor:pointer;font-size:12px;font-weight:600;padding:5px 12px;transition:.15s;white-space:nowrap;text-decoration:none;display:inline-flex;align-items:center}
.btn:hover{background:#f0f2f5;border-color:#008069}
.btn.danger{background:#fff;border-color:#f0d4d4;color:#e03131}
.btn.danger:hover{background:#fdecea;border-color:#e03131}
.live{width:7px;height:7px;border-radius:50%;background:#25d366;animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}

.body{display:flex;flex:1;overflow:hidden}

.sidebar{width:300px;flex-shrink:0;border-right:1px solid #d1d7db;display:flex;flex-direction:column;overflow:hidden;background:#fff}
.search-wrap{padding:10px 12px;border-bottom:1px solid #e9edef}
.search-wrap input{width:100%;background:#f0f2f5;border:1px solid transparent;border-radius:20px;color:#111b21;font-size:12px;padding:7px 14px;outline:none}
.search-wrap input:focus{border-color:#008069}
.sidebar-header{padding:10px 14px;border-bottom:1px solid #e9edef;font-size:11px;font-weight:600;color:#667781;letter-spacing:.6px;text-transform:uppercase;display:flex;justify-content:space-between;align-items:center}
.conv-count{color:#008069;font-size:11px;font-weight:700}
.conv-list{overflow-y:auto;flex:1}
.conv-item{padding:11px 14px 11px 58px;border-bottom:1px solid #f2f2f2;cursor:pointer;transition:.12s;position:relative;min-height:36px}
.conv-item:hover{background:#f5f6f6}
.conv-item.active{background:#f0f2f5}
.conv-avatar{position:absolute;left:14px;top:11px;width:36px;height:36px;border-radius:50%;overflow:hidden;background:#dfe5e7;flex-shrink:0}
.conv-avatar svg{width:100%;height:100%;display:block}
.conv-num{font-size:12.5px;font-weight:600;color:#111b21;letter-spacing:.2px}
.conv-name{font-size:11px;color:#008069;margin-top:1px;font-weight:600}
.conv-time{font-size:10px;color:#667781;margin-top:2px}
.conv-preview{font-size:11px;color:#667781;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:210px}
.msg-count{position:absolute;right:12px;bottom:11px;background:#25d366;color:#fff;font-size:10px;font-weight:700;padding:2px 6px;border-radius:10px;min-width:16px;text-align:center}
.no-results{padding:20px;color:#8696a0;font-size:12px;text-align:center}

.thread{flex:1;display:flex;flex-direction:column;overflow:hidden}
.thread-header{padding:10px 20px;border-bottom:1px solid #d1d7db;display:flex;align-items:center;gap:12px;background:#f0f2f5}
.thread-avatar{width:38px;height:38px;border-radius:50%;overflow:hidden;background:#dfe5e7;flex-shrink:0}
.thread-avatar svg{width:100%;height:100%;display:block}
.thread-info{flex:1}
.thread-num{font-size:14px;font-weight:600;color:#111b21}
.thread-meta{font-size:11.5px;color:#667781;margin-top:2px}

/* WhatsApp-accurate chat surface: light tan wallpaper + subtle doodle texture,
   matching the real WhatsApp Web/desktop LIGHT theme (the one people actually
   use day to day), not a generic dark log viewer. */
.thread-body{flex:1;overflow-y:auto;padding:20px 24px;display:flex;flex-direction:column;gap:2px;
  background-color:#efeae2;
  background-image:radial-gradient(circle at 8px 8px,rgba(0,0,0,.035) 1.4px,transparent 1.5px);
  background-size:32px 32px;}
.empty{color:#8696a0;font-size:13px;text-align:center;margin-top:80px;line-height:2}
.day-sep{align-self:center;background:#e1f2fb;color:#54656f;font-size:11.5px;font-weight:600;padding:5px 12px;border-radius:7px;margin:12px 0 8px;box-shadow:0 1px 1px rgba(0,0,0,.08)}

.msg{max-width:65%;display:flex;flex-direction:column;margin-bottom:3px}
.msg.user{align-self:flex-start}
.msg.bot{align-self:flex-end}
.bubble{position:relative;padding:6px 9px 8px;border-radius:8px;font-size:13.5px;line-height:1.4;word-break:break-word;white-space:pre-wrap;box-shadow:0 1px .5px rgba(0,0,0,.13)}
.msg.user .bubble{background:#fff;color:#111b21;border-top-left-radius:0}
.msg.bot .bubble{background:#d9fdd3;color:#111b21;border-top-right-radius:0}
.bubble .ts{display:block;text-align:right;font-size:10.5px;color:#667781;margin-top:2px;user-select:none}
.bubble .ts .tick{margin-left:3px;color:#667781}
.bubble .ts .tick.read{color:#53bdeb}
.bubble .fail-tag{display:inline-block;margin-top:4px;background:#fdecea;color:#c0392b;font-size:10px;font-weight:600;padding:1px 6px;border-radius:4px}

/* Rich content: image card (avatar/profile), list message (areas/founders/mentors),
   quick-reply buttons, and CTA link - matching how each actually renders on WhatsApp. */
.bubble img.media{display:block;width:100%;max-width:260px;border-radius:6px 6px 2px 2px;margin-bottom:6px;background:#e9edef}
.bubble .caption{white-space:pre-wrap}
.list-head{font-weight:700;margin-bottom:2px}
.list-body{color:#111b21}
.list-btn{display:block;margin-top:8px;padding-top:8px;border-top:1px solid rgba(0,0,0,.08);color:#008069;font-weight:600;font-size:13px;text-align:center;cursor:pointer}
.list-rows{margin-top:6px;font-size:12px;color:#3b4a54}
.list-rows summary{cursor:pointer;color:#008069;font-size:11px;list-style:none}
.list-row{padding:4px 0;border-top:1px solid rgba(0,0,0,.06)}
.list-row .rt{font-weight:600}
.list-row .rd{color:#667781;font-size:11px}
.btn-pill{display:block;margin-top:8px;padding-top:8px;border-top:1px solid rgba(0,0,0,.08);color:#008069;font-weight:600;font-size:13px;text-align:center}
.cta-pill{display:flex;align-items:center;justify-content:center;gap:6px;margin-top:8px;padding-top:8px;border-top:1px solid rgba(0,0,0,.08);color:#008069;font-weight:600;font-size:13px}
.tpl-tag{font-size:10.5px;font-weight:700;letter-spacing:.02em;text-transform:uppercase;color:#008069;margin-bottom:4px}
.tap-note{align-self:center;background:rgba(0,0,0,.05);color:#667781;font-size:11.5px;padding:4px 10px;border-radius:8px;margin:4px 0}

.state-bar{border-top:1px solid #d1d7db;padding:8px 20px;display:flex;gap:10px;flex-wrap:wrap;background:#f7f8f8;font-size:11px;flex-shrink:0}
.state-item{background:#fff;border:1px solid #e9edef;border-radius:6px;padding:3px 10px;color:#54656f}
.state-item strong{color:#008069;margin-right:4px}

.toast{position:fixed;bottom:24px;right:24px;background:#25d366;color:#fff;font-size:13px;font-weight:600;padding:10px 18px;border-radius:8px;opacity:0;transition:.3s;pointer-events:none;box-shadow:0 2px 8px rgba(0,0,0,.2)}
.toast.show{opacity:1}

/* Send-template modal - the one path that can message a number outside the
   24h window; kept as a real UI control (not a raw script) so a send is never
   invisible in this dashboard the way the very first one was. */
.modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;z-index:50}
.modal{background:#fff;border-radius:10px;padding:20px;width:380px;max-width:90vw;box-shadow:0 8px 30px rgba(0,0,0,.25)}
.modal h3{font-size:15px;color:#111b21;margin-bottom:12px}
.modal label{display:block;font-size:11.5px;color:#54656f;font-weight:600;margin:10px 0 4px}
.modal input,.modal select{width:100%;background:#f0f2f5;border:1px solid #d1d7db;border-radius:6px;color:#111b21;font-size:13px;padding:7px 10px;outline:none}
.modal input:focus,.modal select:focus{border-color:#008069}
.modal-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}
.modal-note{font-size:11px;color:#8696a0;margin-top:10px;line-height:1.5}
</style>
</head>
<body>
<div class="header">
  <div class="logo">build3 <span>monitor</span></div>
  <div class="badge">BOT ADMIN</div>
  <div class="header-right">
    <span class="refresh-info" id="lastRefresh"></span>
    <a class="btn" href="/admin/mentors${qs}">Mentors</a>
    <button class="btn" onclick="openTemplateModal()">+ Send template</button>
    <button class="btn" onclick="tick()">↻ Refresh</button>
    <div class="live" title="Auto-refreshes every 5s"></div>
  </div>
</div>
<div class="body">
  <div class="sidebar">
    <div class="search-wrap">
      <input type="text" id="searchInput" placeholder="Search by number or message…" oninput="renderList()">
    </div>
    <div class="sidebar-header">
      Conversations <span class="conv-count" id="convCount">-</span>
    </div>
    <div class="conv-list" id="convList"></div>
  </div>
  <div class="thread">
    <div class="thread-header" id="threadHeader">
      <div class="thread-info"><span style="color:#54656f;font-size:13px">Select a conversation</span></div>
    </div>
    <div class="thread-body" id="threadBody">
      <div class="empty">← Pick a conversation from the sidebar<br><span style="color:#a9b4bb;font-size:11px">Auto-refreshes every 5 seconds</span></div>
    </div>
    <div class="state-bar" id="stateBar" style="display:none"></div>
  </div>
</div>
<div class="toast" id="toast"></div>

<div class="modal-overlay" id="tplModal" style="display:none">
  <div class="modal">
    <h3>Send a template message</h3>
    <label>WhatsApp number (with country code)</label>
    <input type="text" id="tplWaId" placeholder="e.g. 919876543210">
    <label>Template</label>
    <select id="tplName" onchange="onTplPick()"><option value="">Loading templates from Meta…</option></select>
    <div class="modal-note" id="tplPreview" style="display:none"></div>
    <div class="modal-actions">
      <button class="btn" onclick="closeTemplateModal()">Cancel</button>
      <button class="btn" style="color:#fff;background:#008069;border-color:#008069" onclick="sendTemplate()">Send</button>
    </div>
    <div class="modal-note">Only APPROVED templates on this WABA can be sent - the only way to message a number outside the 24h window. No body-variable support yet; use a variable-free template.</div>
  </div>
</div>

<script>
const API = '${apiBase}';
const QS  = '${qs}';
let selected = null;
let convData = [];
let lastLoadedWaId = null;

// Auto-refresh (every 5s) used to blindly force-scroll the thread to the
// bottom on every tick, which yanked you back down mid-read if you'd
// scrolled up to see history. Only snap to bottom on a fresh conversation
// pick, or when you're already within a few px of the bottom (i.e. you were
// following the live tail) - otherwise keep you exactly where you were.
function setThreadBody(html, waId) {
  const body = document.getElementById('threadBody');
  const wasNearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 60;
  const isFreshSelection = waId !== lastLoadedWaId;
  const prevScrollTop = body.scrollTop;
  body.innerHTML = html;
  body.scrollTop = (isFreshSelection || wasNearBottom) ? body.scrollHeight : prevScrollTop;
  lastLoadedWaId = waId;
}

function formatNum(wa) {
  // Show full number formatted: 919876543210 → +91 98765 43210
  const s = String(wa);
  if (s.length === 12 && s.startsWith('91')) {
    const local = s.slice(2); // 10 digits
    return '+91 ' + local.slice(0,5) + ' ' + local.slice(5);
  }
  if (s.length === 11 && s.startsWith('1')) return '+1 ' + s.slice(1,4) + ' ' + s.slice(4,7) + ' ' + s.slice(7);
  return '+' + s;
}

function relTime(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}

// Default WhatsApp-style avatar (gray circle + person silhouette) - every
// contact here is a phone number with no profile photo we have any right to
// fetch, so this is the one honest default, not a placeholder to be replaced.
function avatarSvg() {
  return '<svg viewBox="0 0 24 24"><rect width="24" height="24" fill="#dfe5e7"/><path d="M12 12.5c2.2 0 4-1.8 4-4s-1.8-4-4-4-4 1.8-4 4 1.8 4 4 4Zm0 2c-3.3 0-8 1.6-8 4.5V21h16v-2c0-2.9-4.7-4.5-8-4.5Z" fill="#b0b8bc"/></svg>';
}

function lastUserMsg(hist) {
  if (!hist || !hist.length) return '';
  for (let i = hist.length - 1; i >= 0; i--) {
    if (hist[i].role === 'user') return hist[i].content || '';
  }
  return '';
}

function renderList() {
  const q = (document.getElementById('searchInput').value || '').toLowerCase().trim();
  const filtered = q
    ? convData.filter(c => {
        const num = String(c.wa_id).toLowerCase();
        const preview = (lastUserMsg(c.history) || c.last_preview || '').toLowerCase();
        const slug = (c.founder_slug || '').toLowerCase();
        return num.includes(q) || preview.includes(q) || slug.includes(q);
      })
    : convData;

  document.getElementById('convCount').textContent = filtered.length;
  const el = document.getElementById('convList');
  if (!filtered.length) {
    el.innerHTML = '<div class="no-results">No conversations found</div>';
    return;
  }
  el.innerHTML = filtered.map(c => {
    const hist = c.history || [];
    const preview = lastUserMsg(hist) || c.last_preview || '';
    const active = selected === c.wa_id ? ' active' : '';
    const num = formatNum(c.wa_id);
    // message_count comes from the unbounded message_log; history.length (capped
    // at 10) is only a fallback for when that table isn't reachable.
    const count = c.message_count != null ? c.message_count : hist.length;
    return \`<div class="conv-item\${active}" onclick="selectConv('\${escJs(c.wa_id)}')">
      <div class="conv-avatar">\${avatarSvg()}</div>
      <div class="conv-num">\${esc(num)}</div>
      \${c.founder_slug ? \`<div class="conv-name">\${esc(c.founder_slug)}</div>\` : ''}
      <div class="conv-time">\${relTime(c.last_message_at)}</div>
      \${preview ? \`<div class="conv-preview">\${esc(preview)}</div>\` : ''}
      <div class="msg-count">\${count}</div>
    </div>\`;
  }).join('');
}

async function loadList() {
  const r = await fetch(API + '/conversations' + QS);
  convData = await r.json();
  renderList();
  document.getElementById('lastRefresh').textContent = 'Updated ' + new Date().toLocaleTimeString();
}

async function selectConv(waId) {
  selected = waId;
  renderList(); // re-render active state
  await loadThread(waId);
}

async function clearConv(waId, e) {
  e.stopPropagation();
  if (!confirm('Clear conversation history for ' + formatNum(waId) + '? This resets their bot state.')) return;
  await fetch(API + '/conversations/' + encodeURIComponent(waId) + QS, { method: 'DELETE' });
  showToast('Conversation cleared');
  await tick();
  if (selected === waId) await loadThread(waId);
}

function timeOf(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function dayOf(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Render one message_log row as a WhatsApp-accurate bubble - text/image/list/buttons/cta. */
// Real per-message delivery/read status from Meta's status webhook (m.status),
// not a hardcoded "always shows a tick" placeholder - null/undefined means the
// row predates this feature or Meta hasn't sent a status callback yet.
function tickHtml(m) {
  if (!m.status || m.status === 'failed') return '<span class="tick">✓</span>';
  if (m.status === 'read') return '<span class="tick read">✓✓</span>';
  if (m.status === 'delivered') return '<span class="tick">✓✓</span>';
  return '<span class="tick">✓</span>'; // sent
}

function renderBubble(m) {
  const isOut = m.direction === 'out';
  const cls = isOut ? 'bot' : 'user';
  const p = m.payload || {};
  const ts = \`<span class="ts">\${timeOf(m.created_at)}\${isOut ? tickHtml(m) : ''}</span>\`;
  const failTag = isOut && m.ok === false ? '<span class="fail-tag">⚠ failed to send</span><br>' : '';

  let inner;
  if (m.kind === 'text') {
    inner = esc(p.body != null ? p.body : p.text);
  } else if (m.kind === 'image') {
    inner = \`\${p.url ? \`<img class="media" src="\${esc(p.url)}" onerror="this.style.display='none'">\` : ''}<span class="caption">\${esc(p.caption || '')}</span>\`;
  } else if (m.kind === 'list') {
    const rows = (p.rows || []).map(r => \`<div class="list-row"><div class="rt">\${esc(r.title || '')}</div>\${r.description ? \`<div class="rd">\${esc(r.description)}</div>\` : ''}</div>\`).join('');
    inner = \`\${p.header ? \`<div class="list-head">\${esc(p.header)}</div>\` : ''}<div class="list-body">\${esc(p.body || '')}</div>\`
      + (rows ? \`<details class="list-rows"><summary>\${(p.rows||[]).length} option\${(p.rows||[]).length===1?'':'s'} ▾</summary>\${rows}</details>\` : '')
      + \`<div class="list-btn">▤ \${esc(p.button || 'View')}</div>\`;
  } else if (m.kind === 'buttons') {
    const btns = (p.buttons || []).map(b => \`<div class="btn-pill">\${esc(b.title || '')}</div>\`).join('');
    inner = \`<div class="list-body">\${esc(p.body || '')}</div>\${btns}\`;
  } else if (m.kind === 'cta') {
    inner = \`\${p.headerImage ? \`<img class="media" src="\${esc(p.headerImage)}" onerror="this.style.display='none'">\` : ''}<div class="list-body">\${esc(p.body || '')}</div><div class="cta-pill">🔗 \${esc(p.title || 'Open link')}</div>\`;
  } else if (m.kind === 'image_received') {
    inner = \`<span class="caption">📷 image received\${p.caption ? ': ' + esc(p.caption) : ''}</span>\`;
  } else if (m.kind === 'template') {
    inner = \`<div class="tpl-tag">📋 template: \${esc(p.name || '')}</div><div class="list-body">\${esc(p.bodyPreview || '(no preview saved)')}</div>\`;
  } else {
    inner = esc(JSON.stringify(p));
  }

  return \`<div class="msg \${cls}"><div class="bubble">\${failTag}\${inner}\${ts}</div></div>\`;
}

async function loadThread(waId) {
  if (!waId) return;
  const [convR, msgR] = await Promise.all([
    fetch(API + '/conversations/' + encodeURIComponent(waId) + QS),
    fetch(API + '/conversations/' + encodeURIComponent(waId) + '/messages' + QS),
  ]);
  const conv = await convR.json();
  const messages = await msgR.json();
  if (!conv) return;

  const draft = conv.draft || {};
  const num = formatNum(waId);
  const count = Array.isArray(messages) ? messages.length : 0;
  const legacyCount = Array.isArray(conv.history) ? conv.history.length : 0;
  const countLabel = count ? \`\${count} messages\` : legacyCount ? \`\${legacyCount} messages (legacy)\` : '0 messages';

  document.getElementById('threadHeader').innerHTML = \`
    <div class="thread-avatar">\${avatarSvg()}</div>
    <div class="thread-info">
      <div class="thread-num">\${esc(num)}</div>
      <div class="thread-meta">
        Last active \${relTime(conv.last_message_at)} &nbsp;·&nbsp; \${countLabel}
        \${conv.founder_slug ? \` &nbsp;·&nbsp; <span style="color:#008069">\${esc(conv.founder_slug)}</span>\` : ''}
      </div>
    </div>
    <button class="btn danger" onclick="clearConv('\${escJs(waId)}', event)">✕ Clear state</button>\`;

  const legacyHist = Array.isArray(conv.history) ? conv.history : [];
  if (!count && legacyHist.length) {
    // message_log has nothing for this wa_id - either nothing has happened
    // since this table was added, or (as with the conversation that prompted
    // building this table) all of it predates the fix and was only ever kept
    // in the 10-entry-capped, flattened conversations.history. That data is
    // still real - show it rather than a blank screen, clearly labeled as a
    // partial, pre-fix view so it's not mistaken for the full conversation.
    const parts = [\`<div class="day-sep">legacy - last \${legacyHist.length} exchanges only, richer logging starts from now</div>\`];
    for (const h of legacyHist) {
      const isOut = h.role === 'assistant';
      let text = h.content || '';
      const noteMatch = text.match(/^\\(internal note[^-]*- ([^)]*)\\)\\s*/);
      let note = '';
      if (noteMatch) {
        note = noteMatch[1];
        text = text.slice(noteMatch[0].length);
      }
      const inner = (note ? \`<div class="caption">📌 \${esc(note)}</div>\` : '') + (text ? esc(text) : '');
      parts.push(\`<div class="msg \${isOut ? 'bot' : 'user'}"><div class="bubble">\${inner || esc('(no text)')}</div></div>\`);
    }
    setThreadBody(parts.join(''), waId);
  } else if (!count) {
    setThreadBody('<div class="empty">No messages yet</div>', waId);
  } else {
    let lastDay = null;
    const parts = [];
    for (const m of messages) {
      const day = dayOf(m.created_at);
      if (day !== lastDay) {
        parts.push(\`<div class="day-sep">\${day}</div>\`);
        lastDay = day;
      }
      parts.push(renderBubble(m));
    }
    setThreadBody(parts.join(''), waId);
  }

  const stateBar = document.getElementById('stateBar');
  const chips = [];
  if (draft.focus?.name) chips.push(\`<div class="state-item"><strong>Focus</strong>\${esc(draft.focus.name)}</div>\`);
  if (draft.self) chips.push(\`<div class="state-item"><strong>Self</strong>\${esc(JSON.stringify(draft.self))}</div>\`);
  if (draft.match_cache?.length) chips.push(\`<div class="state-item"><strong>Cache</strong>\${draft.match_cache.length} people</div>\`);
  if (conv.founder_slug) chips.push(\`<div class="state-item"><strong>Slug</strong>\${esc(conv.founder_slug)}</div>\`);
  stateBar.style.display = chips.length ? 'flex' : 'none';
  stateBar.innerHTML = chips.join('');
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2500);
}

function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// For values interpolated into a single-quoted JS-string argument that itself
// sits inside an HTML attribute (e.g. onclick="fn('\${escJs(x)}')") - escape
// backslash/quote for the JS layer first, then esc() for the HTML-attribute
// layer, so neither parser can be broken out of by attacker-influenced data
// (wa_id comes straight from the WhatsApp webhook's "from" field).
function escJs(s) {
  return esc(String(s || '').replace(/\\\\/g, '\\\\\\\\').replace(/'/g, "\\\\'"));
}

async function tick() {
  await loadList();
  if (selected) await loadThread(selected);
}

let tplList = [];

async function openTemplateModal() {
  document.getElementById('tplWaId').value = selected || '';
  document.getElementById('tplModal').style.display = 'flex';
  const sel = document.getElementById('tplName');
  sel.innerHTML = '<option value="">Loading templates from Meta…</option>';
  document.getElementById('tplPreview').style.display = 'none';
  try {
    const r = await fetch(API + '/templates' + QS);
    const body = await r.json();
    if (!r.ok) { sel.innerHTML = '<option value="">' + esc(body.error || 'Failed to load templates') + '</option>'; return; }
    tplList = body.templates || [];
    const usable = tplList.filter(t => t.status === 'APPROVED');
    if (!usable.length) { sel.innerHTML = '<option value="">No APPROVED templates on this WABA</option>'; return; }
    sel.innerHTML = '<option value="">Select a template…</option>' + usable.map(t =>
      \`<option value="\${esc(t.name)}">\${esc(t.name)} (\${esc(t.language)})</option>\`
    ).join('');
  } catch (e) {
    sel.innerHTML = '<option value="">Failed to reach Meta</option>';
  }
}

function onTplPick() {
  const name = document.getElementById('tplName').value;
  const t = tplList.find(x => x.name === name);
  const prev = document.getElementById('tplPreview');
  if (!t) { prev.style.display = 'none'; return; }
  prev.style.display = 'block';
  prev.innerHTML = '<strong style="color:#111b21">' + esc(t.category || '') + '</strong> · ' + esc(t.bodyPreview || '(no body text)');
}

function closeTemplateModal() {
  document.getElementById('tplModal').style.display = 'none';
}

async function sendTemplate() {
  const waId = document.getElementById('tplWaId').value.trim();
  const name = document.getElementById('tplName').value.trim();
  if (!waId || !name) { showToast('Number and template are required'); return; }
  const t = tplList.find(x => x.name === name);
  const languageCode = t?.language || 'en';
  const bodyPreview = t?.bodyPreview || null;
  const r = await fetch(API + '/send-template' + QS, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ waId, name, languageCode, bodyPreview }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) { showToast('Send failed: ' + (body.error || r.status)); return; }
  closeTemplateModal();
  showToast('Template sent');
  await tick();
}

tick();
setInterval(tick, 5000);
</script>
</body>
</html>`;
}

function mentorsHtml(token) {
  const qs = token ? `?token=${encodeURIComponent(token)}` : '';
  const areaKeys = JSON.stringify(AREA_KEYS);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>build3 - mentors</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#ededed;color:#111b21;min-height:100vh}
.header{background:#f0f2f5;border-bottom:1px solid #d1d7db;padding:10px 20px;display:flex;align-items:center;gap:12px}
.logo{font-size:15px;font-weight:700;color:#111b21}.logo span{color:#008069}
.badge{background:#e9edef;border:1px solid #d1d7db;border-radius:6px;color:#54656f;font-size:11px;font-weight:600;padding:2px 8px}
.btn{background:#fff;border:1px solid #d1d7db;border-radius:7px;color:#008069;cursor:pointer;font-size:12px;font-weight:600;padding:6px 12px;text-decoration:none;display:inline-flex;align-items:center;gap:4px}
.btn:hover{background:#f0f2f5;border-color:#008069}
.btn.primary{background:#008069;color:#fff;border-color:#008069}
.btn.primary:hover{background:#017561}
.btn.danger{background:#fff;border-color:#f0d4d4;color:#e03131}
.btn.danger:hover{background:#fdecea;border-color:#e03131}
.right{margin-left:auto;display:flex;gap:10px}
.wrap{padding:18px 20px;max-width:1100px;margin:0 auto}
.banner{background:#fff7e0;border:1px solid #f0d98c;color:#8a6d1a;font-size:12px;padding:8px 12px;border-radius:8px;margin-bottom:14px;display:none}
table{width:100%;border-collapse:collapse;font-size:13px;background:#fff;border-radius:8px;overflow:hidden}
th{text-align:left;color:#667781;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.5px;padding:8px 10px;border-bottom:1px solid #e9edef}
td{padding:10px;border-bottom:1px solid #f2f2f2;vertical-align:top}
tr.inactive{opacity:.5}
.name{font-weight:600;color:#111b21}
.areas span{display:inline-block;background:#e7f6f1;color:#008069;font-size:10px;padding:1px 6px;border-radius:4px;margin:1px 2px 1px 0}
.link{color:#027eb5;font-size:11px;word-break:break-all}
.muted{color:#667781;font-size:12px}
.actions{white-space:nowrap;text-align:right}
.actions .btn{padding:4px 9px;font-size:11px;margin-left:4px}
.modal-bg{position:fixed;inset:0;background:rgba(0,0,0,.4);display:none;align-items:flex-start;justify-content:center;padding:40px 16px;overflow:auto}
.modal{background:#fff;border:1px solid #d1d7db;border-radius:12px;width:520px;max-width:100%;padding:20px;box-shadow:0 8px 30px rgba(0,0,0,.2)}
.modal h2{font-size:16px;margin-bottom:14px;color:#111b21}
.field{margin-bottom:12px}
.field label{display:block;font-size:12px;color:#54656f;margin-bottom:4px}
.field input,.field textarea,.field select{width:100%;background:#f0f2f5;border:1px solid #d1d7db;border-radius:7px;color:#111b21;font-size:13px;padding:8px 10px;outline:none;font-family:inherit}
.field input:focus,.field textarea:focus{border-color:#008069}
.areachecks{display:flex;flex-wrap:wrap;gap:6px}
.areachecks label{display:inline-flex;align-items:center;gap:4px;background:#f0f2f5;border:1px solid #d1d7db;border-radius:6px;padding:4px 8px;font-size:12px;color:#54656f;cursor:pointer}
.modal-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}
</style>
</head>
<body>
<div class="header">
  <div class="logo">build3 <span>mentors</span></div>
  <div class="badge">MENTOR HOURS</div>
  <div class="right">
    <a class="btn" href="/admin${qs}">← Monitor</a>
    <button class="btn primary" onclick="openAdd()">+ Add mentor</button>
  </div>
</div>
<div class="wrap">
  <div class="banner" id="banner"></div>
  <table>
    <thead><tr><th>Name</th><th>Areas</th><th>Expertise</th><th>Booking</th><th></th></tr></thead>
    <tbody id="rows"><tr><td colspan="5" class="muted">Loading…</td></tr></tbody>
  </table>
</div>

<div class="modal-bg" id="modalBg">
  <div class="modal">
    <h2 id="modalTitle">Add mentor</h2>
    <div class="field"><label>Name</label><input id="f_name"></div>
    <div class="field"><label>Slug (stable id, lowercase-with-dashes)</label><input id="f_slug" placeholder="varun-chawla"></div>
    <div class="field"><label>Expertise (shown on the card)</label><textarea id="f_expertise" rows="2"></textarea></div>
    <div class="field"><label>Areas</label><div class="areachecks" id="f_areas"></div></div>
    <div class="field"><label>Booking URL</label><input id="f_booking" placeholder="https://calendar.app.google/…"></div>
    <div class="field"><label>LinkedIn URL (optional)</label><input id="f_linkedin"></div>
    <div class="field"><label>Avatar URL (optional)</label><input id="f_avatar"></div>
    <div class="field"><label>Sort order</label><input id="f_sort" type="number" value="100"></div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn primary" onclick="save()">Save</button>
    </div>
  </div>
</div>

<script>
const QS = '${qs}';
const AREA_KEYS = ${areaKeys};
let editing = null;

function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');}
function banner(msg, ok){const b=document.getElementById('banner');b.textContent=msg;b.style.display='block';b.style.color=ok?'#1e7d4f':'#8a6d1a';b.style.borderColor=ok?'#bfe6d2':'#f0d98c';b.style.background=ok?'#eafaf1':'#fff7e0';}

async function load(){
  const r = await fetch('/admin/api/mentors'+QS);
  const data = await r.json();
  if(data.source==='seed') banner('Showing the built-in seed (the mentors table isn\\'t created yet). Edits won\\'t persist until the 0004 migration is applied.', false);
  const rows = data.mentors||[];
  document.getElementById('rows').innerHTML = rows.map(s=>\`
    <tr class="\${s.is_active===false?'inactive':''}">
      <td><div class="name">\${esc(s.name)}</div><div class="muted">\${esc(s.slug)}</div></td>
      <td class="areas">\${(s.areas||[]).map(a=>'<span>'+esc(a)+'</span>').join('')}</td>
      <td class="muted">\${esc(s.expertise||'')}</td>
      <td><a class="link" href="\${esc(s.booking_url)}" target="_blank" rel="noopener">\${esc(s.booking_url||'')}</a></td>
      <td class="actions">
        <button class="btn" onclick='edit(\${esc(JSON.stringify(JSON.stringify(s)))})'>Edit</button>
        \${s.is_active===false?'':'<button class="btn danger" onclick="deactivate(\\''+esc(s.slug)+'\\')">Off</button>'}
      </td>
    </tr>\`).join('') || '<tr><td colspan="5" class="muted">no mentors.</td></tr>';
}

function renderAreaChecks(selected){
  document.getElementById('f_areas').innerHTML = AREA_KEYS.map(k=>
    '<label><input type="checkbox" value="'+k+'" '+((selected||[]).includes(k)?'checked':'')+'>'+k+'</label>'
  ).join('');
}
function openAdd(){
  editing=null;
  document.getElementById('modalTitle').textContent='Add mentor';
  for(const id of ['name','slug','expertise','booking','linkedin','avatar']) document.getElementById('f_'+id).value='';
  document.getElementById('f_sort').value=100;
  document.getElementById('f_slug').disabled=false;
  renderAreaChecks([]);
  document.getElementById('modalBg').style.display='flex';
}
function edit(json){
  const s=JSON.parse(json);editing=s.slug;
  document.getElementById('modalTitle').textContent='Edit '+s.name;
  document.getElementById('f_name').value=s.name||'';
  document.getElementById('f_slug').value=s.slug||'';
  document.getElementById('f_slug').disabled=true;
  document.getElementById('f_expertise').value=s.expertise||'';
  document.getElementById('f_booking').value=s.booking_url||'';
  document.getElementById('f_linkedin').value=s.linkedin_url||'';
  document.getElementById('f_avatar').value=s.avatar_url||'';
  document.getElementById('f_sort').value=s.sort_order||100;
  renderAreaChecks(s.areas||[]);
  document.getElementById('modalBg').style.display='flex';
}
function closeModal(){document.getElementById('modalBg').style.display='none';}

async function save(){
  const areas=[...document.querySelectorAll('#f_areas input:checked')].map(c=>c.value);
  const body={
    slug:document.getElementById('f_slug').value.trim(),
    name:document.getElementById('f_name').value.trim(),
    expertise:document.getElementById('f_expertise').value.trim(),
    areas,
    booking_url:document.getElementById('f_booking').value.trim(),
    linkedin_url:document.getElementById('f_linkedin').value.trim()||null,
    avatar_url:document.getElementById('f_avatar').value.trim()||null,
    sort_order:parseInt(document.getElementById('f_sort').value,10)||100,
  };
  if(!body.slug||!body.name||!body.booking_url){banner('slug, name and booking URL are required',false);return;}
  const r=await fetch('/admin/api/mentors'+QS,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const j=await r.json();
  if(j.ok){closeModal();banner('Saved '+body.name,true);load();}
  else banner('Save failed: '+(j.error||'unknown'),false);
}
async function deactivate(slug){
  if(!confirm('Deactivate '+slug+'? It will stop appearing in the bot.'))return;
  const r=await fetch('/admin/api/mentors/'+encodeURIComponent(slug)+QS,{method:'DELETE'});
  const j=await r.json();
  if(j.ok){banner('Deactivated '+slug,true);load();}
  else banner('Failed: '+(j.error||'unknown'),false);
}
load();
</script>
</body>
</html>`;
}
