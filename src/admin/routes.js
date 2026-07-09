'use strict';

const express = require('express');
const { supabase } = require('../config/supabase');
const { env } = require('../config/env');
const { SHERPAS } = require('../domain/sherpas.data');
const { AREA_KEYS } = require('../domain/sherpaAreas');

const router = express.Router();

// ─── Auth ───────────────────────────────────────────────────────────────────
router.use((req, res, next) => {
  if (!env.adminToken) return res.status(503).send('Admin panel not configured (ADMIN_TOKEN not set).');
  const token = req.query.token || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (token !== env.adminToken) {
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

    // `history` is capped to 10 for LLM context - the sidebar badge needs the
    // REAL total. Read it from the message_log_counts VIEW (grouped server-side
    // by Postgres) rather than pulling raw rows and tallying in JS - that
    // scales with the number of conversations, not the size of the whole log,
    // and never silently under-counts a conversation past some row cap.
    try {
      const { data: countRows, error: countErr } = await supabase()
        .from('message_log_counts')
        .select('wa_id, message_count');
      if (countErr) throw countErr;
      const counts = {};
      for (const r of countRows || []) counts[r.wa_id] = r.message_count;
      for (const c of rows) c.message_count = counts[c.wa_id] || 0;
    } catch (_e) {
      // view unavailable (migration not applied yet) - badge falls back below.
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
    res.json(data || null);
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

// ─── API: list sherpas (table, falling back to the static seed) ──────────────
router.get('/api/sherpas', async (_req, res) => {
  try {
    const { data, error } = await supabase()
      .from('sherpas')
      .select('*')
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true });
    if (error) throw error;
    if (data && data.length) return res.json({ source: 'table', sherpas: data });
  } catch (_e) {
    // table missing / empty → serve the static seed read-only
  }
  res.json({ source: 'seed', sherpas: SHERPAS.map((s) => ({ ...s, is_active: s.is_active !== false })) });
});

// ─── API: upsert a sherpa (by slug) ──────────────────────────────────────────
router.post('/api/sherpas', async (req, res) => {
  const b = req.body || {};
  if (!b.slug || !b.name || !b.booking_url) {
    return res.status(400).json({ error: 'slug, name, and booking_url are required' });
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
    const { error } = await supabase().from('sherpas').upsert(row, { onConflict: 'slug' });
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── API: deactivate a sherpa (soft delete) ──────────────────────────────────
router.delete('/api/sherpas/:slug', async (req, res) => {
  try {
    const { error } = await supabase()
      .from('sherpas')
      .update({ is_active: false })
      .eq('slug', req.params.slug);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Dashboard HTML ──────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  res.send(dashboardHtml(req.query.token));
});

router.get('/sherpas', (req, res) => {
  res.send(sherpasHtml(req.query.token));
});

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
body{font-family:system-ui,-apple-system,sans-serif;background:#0a0a0a;color:#e0e0e0;height:100vh;display:flex;flex-direction:column;overflow:hidden}

.header{background:#111;border-bottom:1px solid #1e1e1e;padding:10px 20px;display:flex;align-items:center;gap:12px;flex-shrink:0}
.logo{font-size:15px;font-weight:700;color:#fff;letter-spacing:-.3px}
.logo span{color:#6366f1}
.badge{background:#1e1e2e;border:1px solid #2d2d4a;border-radius:6px;color:#a5b4fc;font-size:11px;font-weight:600;padding:2px 8px;letter-spacing:.3px}
.header-right{display:flex;align-items:center;gap:10px;margin-left:auto}
.refresh-info{color:#555;font-size:11px}
.btn{background:#1e1e2e;border:1px solid #2d2d4a;border-radius:7px;color:#a5b4fc;cursor:pointer;font-size:12px;font-weight:600;padding:5px 12px;transition:.15s;white-space:nowrap;text-decoration:none;display:inline-flex;align-items:center}
.btn:hover{background:#252540;border-color:#4f46e5}
.btn.danger{background:#1e1010;border-color:#4a1a1a;color:#f87171}
.btn.danger:hover{background:#2a1010;border-color:#ef4444}
.live{width:7px;height:7px;border-radius:50%;background:#22c55e;animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}

.body{display:flex;flex:1;overflow:hidden}

.sidebar{width:300px;flex-shrink:0;border-right:1px solid #1e1e1e;display:flex;flex-direction:column;overflow:hidden}
.search-wrap{padding:10px 12px;border-bottom:1px solid #1e1e1e}
.search-wrap input{width:100%;background:#141414;border:1px solid #252525;border-radius:7px;color:#e0e0e0;font-size:12px;padding:7px 10px;outline:none}
.search-wrap input:focus{border-color:#4f46e5}
.sidebar-header{padding:10px 14px;border-bottom:1px solid #1e1e1e;font-size:11px;font-weight:600;color:#555;letter-spacing:.6px;text-transform:uppercase;display:flex;justify-content:space-between;align-items:center}
.conv-count{color:#6366f1;font-size:11px;font-weight:700}
.conv-list{overflow-y:auto;flex:1}
.conv-item{padding:11px 14px;border-bottom:1px solid #141414;cursor:pointer;transition:.12s;position:relative}
.conv-item:hover{background:#141414}
.conv-item.active{background:#1a1a2e;border-left:3px solid #6366f1}
.conv-num{font-size:12px;font-weight:600;color:#e0e0e0;font-family:monospace;letter-spacing:.3px}
.conv-name{font-size:11px;color:#6366f1;margin-top:1px;font-weight:600}
.conv-time{font-size:10px;color:#555;margin-top:2px}
.conv-preview{font-size:11px;color:#555;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:240px}
.msg-count{position:absolute;right:12px;top:12px;background:#1e1e2e;color:#a5b4fc;font-size:10px;font-weight:600;padding:2px 6px;border-radius:10px}
.no-results{padding:20px;color:#333;font-size:12px;text-align:center}

.thread{flex:1;display:flex;flex-direction:column;overflow:hidden}
.thread-header{padding:12px 20px;border-bottom:1px solid #1e1e1e;display:flex;align-items:center;gap:10px;background:#111}
.thread-info{flex:1}
.thread-num{font-size:14px;font-weight:600;font-family:monospace;color:#e0e0e0}
.thread-meta{font-size:11px;color:#555;margin-top:2px}

/* WhatsApp-accurate chat surface: dark wallpaper + doodle texture, like the
   real WhatsApp Business app dark theme, so this reads as "the actual chat"
   rather than a generic log viewer. */
.thread-body{flex:1;overflow-y:auto;padding:20px 24px;display:flex;flex-direction:column;gap:2px;
  background-color:#0b141a;
  background-image:radial-gradient(circle at 8px 8px,rgba(255,255,255,.025) 1.4px,transparent 1.5px);
  background-size:32px 32px;}
.empty{color:#3b4a54;font-size:13px;text-align:center;margin-top:80px;line-height:2}
.day-sep{align-self:center;background:#182229;color:#8696a0;font-size:11px;font-weight:600;padding:4px 10px;border-radius:6px;margin:12px 0 8px;text-transform:uppercase;letter-spacing:.3px}

.msg{max-width:65%;display:flex;flex-direction:column;margin-bottom:3px}
.msg.user{align-self:flex-start}
.msg.bot{align-self:flex-end}
.bubble{position:relative;padding:6px 9px 8px;border-radius:8px;font-size:13.5px;line-height:1.4;word-break:break-word;white-space:pre-wrap;box-shadow:0 1px 1px rgba(0,0,0,.3)}
.msg.user .bubble{background:#202c33;color:#e9edef;border-top-left-radius:0}
.msg.bot .bubble{background:#005c4b;color:#e9edef;border-top-right-radius:0}
.bubble .ts{display:block;text-align:right;font-size:10.5px;color:#8696a0;margin-top:2px;user-select:none}
.msg.bot .bubble .ts{color:#8fd6c4}
.bubble .ts .tick{margin-left:3px}
.bubble .fail-tag{display:inline-block;margin-top:4px;background:#3a1414;color:#f87171;font-size:10px;font-weight:600;padding:1px 6px;border-radius:4px}

/* Rich content: image card (avatar/profile), list message (areas/founders/sherpas),
   quick-reply buttons, and CTA link - matching how each actually renders on WhatsApp. */
.bubble img.media{display:block;width:100%;max-width:260px;border-radius:6px 6px 2px 2px;margin-bottom:6px;background:#0e0e0e}
.bubble .caption{white-space:pre-wrap}
.list-head{font-weight:700;margin-bottom:2px}
.list-body{color:#e9edef}
.list-btn{display:block;margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,.14);color:#53bdeb;font-weight:600;font-size:13px;text-align:center;cursor:pointer}
.list-rows{margin-top:6px;font-size:12px;color:#cfe8e0}
.list-rows summary{cursor:pointer;color:#8fd6c4;font-size:11px;list-style:none}
.list-row{padding:4px 0;border-top:1px solid rgba(255,255,255,.08)}
.list-row .rt{font-weight:600}
.list-row .rd{color:#a9c9c1;font-size:11px}
.btn-pill{display:block;margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,.14);color:#53bdeb;font-weight:600;font-size:13px;text-align:center}
.cta-pill{display:flex;align-items:center;justify-content:center;gap:6px;margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,.14);color:#53bdeb;font-weight:600;font-size:13px}
.tap-note{align-self:center;background:rgba(255,255,255,.06);color:#8696a0;font-size:11.5px;padding:4px 10px;border-radius:8px;margin:4px 0}

.state-bar{border-top:1px solid #1e1e1e;padding:8px 20px;display:flex;gap:10px;flex-wrap:wrap;background:#0d0d0d;font-size:11px;flex-shrink:0}
.state-item{background:#141414;border:1px solid #2a2a2a;border-radius:6px;padding:3px 10px;color:#888}
.state-item strong{color:#a5b4fc;margin-right:4px}

.toast{position:fixed;bottom:24px;right:24px;background:#22c55e;color:#fff;font-size:13px;font-weight:600;padding:10px 18px;border-radius:8px;opacity:0;transition:.3s;pointer-events:none}
.toast.show{opacity:1}
</style>
</head>
<body>
<div class="header">
  <div class="logo">build3 <span>monitor</span></div>
  <div class="badge">BOT ADMIN</div>
  <div class="header-right">
    <span class="refresh-info" id="lastRefresh"></span>
    <a class="btn" href="/admin/sherpas${qs}">Sherpas</a>
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
      <div class="thread-info"><span style="color:#333;font-size:13px">Select a conversation</span></div>
    </div>
    <div class="thread-body" id="threadBody">
      <div class="empty">← Pick a conversation from the sidebar<br><span style="color:#2a2a2a;font-size:11px">Auto-refreshes every 5 seconds</span></div>
    </div>
    <div class="state-bar" id="stateBar" style="display:none"></div>
  </div>
</div>
<div class="toast" id="toast"></div>

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
        const preview = lastUserMsg(c.history).toLowerCase();
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
    const preview = lastUserMsg(hist);
    const active = selected === c.wa_id ? ' active' : '';
    const num = formatNum(c.wa_id);
    // message_count comes from the unbounded message_log; history.length (capped
    // at 10) is only a fallback for when that table isn't reachable.
    const count = c.message_count != null ? c.message_count : hist.length;
    return \`<div class="conv-item\${active}" onclick="selectConv('\${escJs(c.wa_id)}')">
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
function renderBubble(m) {
  const isOut = m.direction === 'out';
  const cls = isOut ? 'bot' : 'user';
  const p = m.payload || {};
  const ts = \`<span class="ts">\${timeOf(m.created_at)}\${isOut ? '<span class="tick">✓</span>' : ''}</span>\`;
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
    <div class="thread-info">
      <div class="thread-num">\${esc(num)}</div>
      <div class="thread-meta">
        Last active \${relTime(conv.last_message_at)} &nbsp;·&nbsp; \${countLabel}
        \${conv.founder_slug ? \` &nbsp;·&nbsp; <span style="color:#6366f1">\${esc(conv.founder_slug)}</span>\` : ''}
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

tick();
setInterval(tick, 5000);
</script>
</body>
</html>`;
}

function sherpasHtml(token) {
  const qs = token ? `?token=${encodeURIComponent(token)}` : '';
  const areaKeys = JSON.stringify(AREA_KEYS);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>build3 - sherpas</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,-apple-system,sans-serif;background:#0a0a0a;color:#e0e0e0;min-height:100vh}
.header{background:#111;border-bottom:1px solid #1e1e1e;padding:10px 20px;display:flex;align-items:center;gap:12px}
.logo{font-size:15px;font-weight:700;color:#fff}.logo span{color:#6366f1}
.badge{background:#1e1e2e;border:1px solid #2d2d4a;border-radius:6px;color:#a5b4fc;font-size:11px;font-weight:600;padding:2px 8px}
.btn{background:#1e1e2e;border:1px solid #2d2d4a;border-radius:7px;color:#a5b4fc;cursor:pointer;font-size:12px;font-weight:600;padding:6px 12px;text-decoration:none;display:inline-flex;align-items:center;gap:4px}
.btn:hover{background:#252540;border-color:#4f46e5}
.btn.primary{background:#4f46e5;color:#fff;border-color:#4f46e5}
.btn.danger{background:#1e1010;border-color:#4a1a1a;color:#f87171}
.right{margin-left:auto;display:flex;gap:10px}
.wrap{padding:18px 20px;max-width:1100px;margin:0 auto}
.banner{background:#1a160a;border:1px solid #4a3a1a;color:#e8c97a;font-size:12px;padding:8px 12px;border-radius:8px;margin-bottom:14px;display:none}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;color:#666;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.5px;padding:8px 10px;border-bottom:1px solid #1e1e1e}
td{padding:10px;border-bottom:1px solid #161616;vertical-align:top}
tr.inactive{opacity:.45}
.name{font-weight:600;color:#e0e0e0}
.areas span{display:inline-block;background:#1e1e2e;color:#a5b4fc;font-size:10px;padding:1px 6px;border-radius:4px;margin:1px 2px 1px 0}
.link{color:#027EB5;font-size:11px;word-break:break-all}
.muted{color:#667781;font-size:12px}
.actions{white-space:nowrap;text-align:right}
.actions .btn{padding:4px 9px;font-size:11px;margin-left:4px}
.modal-bg{position:fixed;inset:0;background:rgba(0,0,0,.6);display:none;align-items:flex-start;justify-content:center;padding:40px 16px;overflow:auto}
.modal{background:#141414;border:1px solid #2a2a2a;border-radius:12px;width:520px;max-width:100%;padding:20px}
.modal h2{font-size:16px;margin-bottom:14px}
.field{margin-bottom:12px}
.field label{display:block;font-size:12px;color:#888;margin-bottom:4px}
.field input,.field textarea,.field select{width:100%;background:#0e0e0e;border:1px solid #2a2a2a;border-radius:7px;color:#e0e0e0;font-size:13px;padding:8px 10px;outline:none;font-family:inherit}
.field input:focus,.field textarea:focus{border-color:#4f46e5}
.areachecks{display:flex;flex-wrap:wrap;gap:6px}
.areachecks label{display:inline-flex;align-items:center;gap:4px;background:#0e0e0e;border:1px solid #2a2a2a;border-radius:6px;padding:4px 8px;font-size:12px;color:#bbb;cursor:pointer}
.modal-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}
</style>
</head>
<body>
<div class="header">
  <div class="logo">build3 <span>sherpas</span></div>
  <div class="badge">SHERPA HOURS</div>
  <div class="right">
    <a class="btn" href="/admin${qs}">← Monitor</a>
    <button class="btn primary" onclick="openAdd()">+ Add sherpa</button>
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
    <h2 id="modalTitle">Add sherpa</h2>
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
function banner(msg, ok){const b=document.getElementById('banner');b.textContent=msg;b.style.display='block';b.style.color=ok?'#7ee0a0':'#e8c97a';b.style.borderColor=ok?'#1a4a2a':'#4a3a1a';b.style.background=ok?'#0a1a10':'#1a160a';}

async function load(){
  const r = await fetch('/admin/api/sherpas'+QS);
  const data = await r.json();
  if(data.source==='seed') banner('Showing the built-in seed (the sherpas table isn\\'t created yet). Edits won\\'t persist until the 0004 migration is applied.', false);
  const rows = data.sherpas||[];
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
    </tr>\`).join('') || '<tr><td colspan="5" class="muted">no sherpas.</td></tr>';
}

function renderAreaChecks(selected){
  document.getElementById('f_areas').innerHTML = AREA_KEYS.map(k=>
    '<label><input type="checkbox" value="'+k+'" '+((selected||[]).includes(k)?'checked':'')+'>'+k+'</label>'
  ).join('');
}
function openAdd(){
  editing=null;
  document.getElementById('modalTitle').textContent='Add sherpa';
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
  const r=await fetch('/admin/api/sherpas'+QS,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const j=await r.json();
  if(j.ok){closeModal();banner('Saved '+body.name,true);load();}
  else banner('Save failed: '+(j.error||'unknown'),false);
}
async function deactivate(slug){
  if(!confirm('Deactivate '+slug+'? It will stop appearing in the bot.'))return;
  const r=await fetch('/admin/api/sherpas/'+encodeURIComponent(slug)+QS,{method:'DELETE'});
  const j=await r.json();
  if(j.ok){banner('Deactivated '+slug,true);load();}
  else banner('Failed: '+(j.error||'unknown'),false);
}
load();
</script>
</body>
</html>`;
}
