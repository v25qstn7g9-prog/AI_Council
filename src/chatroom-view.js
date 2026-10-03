/**
 * chatroom-view.js — 聊天模式的網頁端：/chatroom 顯示即時聊天畫面，/chatroom/log 是它輪詢的 JSON。
 * 跟 watch.js（單場圓桌討論，session 制）不一樣，聊天室是全域唯一一間房間，沒有 sessionId。
 */

import { getChatState, getChatLog } from "./chatroom.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export async function handleChatroomLogApi(request, env) {
  const state = await getChatState(env);
  const log = await getChatLog(env);
  return json({
    enabled: Boolean(state?.enabled),
    participants: state?.participants || [],
    messageCount: state?.messageCount || 0,
    stoppedReason: state?.stoppedReason || null,
    log,
  });
}

const PAGE = `<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,minimum-scale=1,user-scalable=no,viewport-fit=cover">
<title>AI 圓桌 · 聊天室</title>
<style>
html,body{height:100%;margin:0;padding:0;overflow:hidden;touch-action:none;-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{font-family:system-ui,-apple-system,"PingFang TC","Microsoft JhengHei",sans-serif;background:#0f1320;color:#eee}
.wrap{display:flex;flex-direction:column;height:100%;width:100%}
h1{font-size:18px;margin:0;padding:16px 20px 0;flex:0 0 auto}
.status{font-size:13px;color:#9aa;margin:0;padding:8px 20px 14px;flex:0 0 auto}
.status.on{color:#5fd47a}
.status.off{color:#ff8080}
#messages{flex:1 1 auto;overflow-y:auto;overflow-x:hidden;-webkit-overflow-scrolling:touch;touch-action:pan-y;padding:0 20px 20px}
.bubble-row{display:flex;margin-bottom:10px}
.bubble-row.system{justify-content:center}
.bubble{max-width:78%;padding:10px 14px;border-radius:14px;font-size:14px;line-height:1.5;white-space:pre-wrap;word-break:break-word;background:#1a1f30}
.bubble .who{font-size:11px;color:#e9b949;margin-bottom:4px;font-weight:600}
.bubble.system{background:transparent;color:#667;font-size:12px;max-width:100%;text-align:center}
.colors0{background:#1a2630}.colors1{background:#201a30}.colors2{background:#2a1a26}.colors3{background:#1a2a22}
</style></head>
<body>
<div class="wrap">
<h1>AI 圓桌 · 聊天室</h1>
<p class="status" id="status">連線中…</p>
<div id="messages"></div>
</div>
<script>
let rendered = 0;
const colorOf = (() => { const map = {}; let n = 0; return (id) => { if (!(id in map)) map[id] = 'colors' + (n++ % 4); return map[id]; }; })();

function esc(s) { return String(s || '').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }

function renderMessage(m) {
  const row = document.createElement('div');
  if (m.id === 'system') {
    row.className = 'bubble-row system';
    row.innerHTML = '<div class="bubble system">' + esc(m.text) + '</div>';
  } else {
    row.className = 'bubble-row';
    const bubble = document.createElement('div');
    bubble.className = 'bubble ' + colorOf(m.id);
    bubble.innerHTML = '<div class="who">' + esc(m.label) + '</div>' + esc(m.text);
    row.appendChild(bubble);
  }
  document.getElementById('messages').appendChild(row);
}

async function poll() {
  try {
    const res = await fetch('/chatroom/log', { cache: 'no-store' });
    const p = await res.json();
    const log = p.log || [];
    const messagesEl = document.getElementById('messages');
    const wasAtBottom = (messagesEl.scrollTop + messagesEl.clientHeight) >= (messagesEl.scrollHeight - 200);
    for (let i = rendered; i < log.length; i++) renderMessage(log[i]);
    rendered = log.length;
    if (wasAtBottom) messagesEl.scrollTop = messagesEl.scrollHeight;

    const statusEl = document.getElementById('status');
    if (p.enabled) {
      statusEl.textContent = '🟢 聊天中（' + (p.participants || []).map(x => x.label).join('、') + '）· 已經 ' + p.messageCount + ' 則 · 每 2 分鐘左右一則';
      statusEl.className = 'status on';
    } else {
      statusEl.textContent = '🔴 目前休息中' + (p.stoppedReason ? '（' + p.stoppedReason + '）' : '');
      statusEl.className = 'status off';
    }
  } catch (e) {
    document.getElementById('status').textContent = '連線異常，重試中…';
  }
  setTimeout(poll, 5000);
}
poll();
</script>
</body></html>`;

export async function handleChatroomPage() {
  return new Response(PAGE, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
}
