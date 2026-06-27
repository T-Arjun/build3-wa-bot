'use strict';

const express = require('express');
const { supabase } = require('../config/supabase');
const { env } = require('../config/env');

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
    res.json(data || []);
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

// ─── API: clear conversation history ────────────────────────────────────────
router.delete('/api/conversations/:waId', async (req, res) => {
  try {
    const { error } = await supabase()
      .from('conversations')
      .update({ history: [], draft: {}, last_results: [], focus: null })
      .eq('wa_id', req.params.waId);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Dashboard HTML ──────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  res.send(dashboardHtml(req.query.token));
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
<title>build3 — bot monitor</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,-apple-system,sans-serif;background:#0a0a0a;color:#e0e0e0;height:100vh;display:flex;flex-direction:column;overflow:hidden}

.header{background:#111;border-bottom:1px solid #1e1e1e;padding:10px 20px;display:flex;align-items:center;gap:12px;flex-shrink:0}
.logo{font-size:15px;font-weight:700;color:#fff;letter-spacing:-.3px}
.logo span{color:#6366f1}
.badge{background:#1e1e2e;border:1px solid #2d2d4a;border-radius:6px;color:#a5b4fc;font-size:11px;font-weight:600;padding:2px 8px;letter-spacing:.3px}
.header-right{display:flex;align-items:center;gap:10px;margin-left:auto}
.refresh-info{color:#555;font-size:11px}
.btn{background:#1e1e2e;border:1px solid #2d2d4a;border-radius:7px;color:#a5b4fc;cursor:pointer;font-size:12px;font-weight:600;padding:5px 12px;transition:.15s;white-space:nowrap}
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
.thread-header{padding:12px 20px;border-bottom:1px solid #1e1e1e;display:flex;align-items:center;gap:10px}
.thread-info{flex:1}
.thread-num{font-size:14px;font-weight:600;font-family:monospace;color:#e0e0e0}
.thread-meta{font-size:11px;color:#555;margin-top:2px}
.thread-body{flex:1;overflow-y:auto;padding:20px;display:flex;flex-direction:column;gap:12px}
.empty{color:#333;font-size:13px;text-align:center;margin-top:80px;line-height:2}

.msg{max-width:70%;display:flex;flex-direction:column;gap:3px}
.msg.user{align-self:flex-start}
.msg.bot{align-self:flex-end}
.bubble{padding:10px 14px;border-radius:12px;font-size:13px;line-height:1.5;word-break:break-word;white-space:pre-wrap}
.msg.user .bubble{background:#1e1e1e;border-radius:12px 12px 12px 3px;color:#d0d0d0}
.msg.bot .bubble{background:#1e1a3e;border-radius:12px 12px 3px 12px;color:#c4b5fd}
.msg-label{font-size:10px;font-weight:600;color:#444;text-transform:uppercase;letter-spacing:.5px}
.msg.bot .msg-label{text-align:right;color:#4c3f8a}
.tool{align-self:center;background:#0f1a0f;border:1px solid #1a3a1a;border-radius:8px;padding:5px 12px;font-size:11px;color:#4ade80;font-family:monospace;max-width:92%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

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
      Conversations <span class="conv-count" id="convCount">—</span>
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
    return \`<div class="conv-item\${active}" onclick="selectConv('\${c.wa_id}')">
      <div class="conv-num">\${esc(num)}</div>
      \${c.founder_slug ? \`<div class="conv-name">\${esc(c.founder_slug)}</div>\` : ''}
      <div class="conv-time">\${relTime(c.last_message_at)}</div>
      \${preview ? \`<div class="conv-preview">\${esc(preview)}</div>\` : ''}
      <div class="msg-count">\${hist.length}</div>
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

async function loadThread(waId) {
  if (!waId) return;
  const r = await fetch(API + '/conversations/' + encodeURIComponent(waId) + QS);
  const conv = await r.json();
  if (!conv) return;

  const hist = conv.history || [];
  const draft = conv.draft || {};
  const num = formatNum(waId);

  document.getElementById('threadHeader').innerHTML = \`
    <div class="thread-info">
      <div class="thread-num">\${esc(num)}</div>
      <div class="thread-meta">
        Last active \${relTime(conv.last_message_at)} &nbsp;·&nbsp; \${hist.length} messages
        \${conv.founder_slug ? \` &nbsp;·&nbsp; <span style="color:#6366f1">\${esc(conv.founder_slug)}</span>\` : ''}
      </div>
    </div>
    <button class="btn danger" onclick="clearConv('\${waId}', event)">✕ Clear</button>\`;

  const body = document.getElementById('threadBody');
  if (!hist.length) {
    body.innerHTML = '<div class="empty">No messages yet</div>';
  } else {
    body.innerHTML = hist.map(m => {
      if (m.role === 'user') {
        return \`<div class="msg user">
          <div class="msg-label">Founder</div>
          <div class="bubble">\${esc(m.content)}</div>
        </div>\`;
      }
      const c = m.content || '';
      if (c.startsWith('(internal note')) {
        const note = c.replace(/^\\(internal note[^—]*— /, '').replace(/\\)$/, '');
        return \`<div class="tool">📌 \${esc(note)}</div>\`;
      }
      return \`<div class="msg bot">
        <div class="msg-label">Bot</div>
        <div class="bubble">\${esc(c)}</div>
      </div>\`;
    }).join('');
    body.scrollTop = body.scrollHeight;
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
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
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
