/**
 * watch.js — 即時監看頁面：Claude 透過 MCP 觸發 4 人平等圓桌時，回傳一個這個頁面的連結，
 * Johnny 打開就能看到每一輪、每個 AI 的意見陸續跑出來，一路看到大家達成共識結案。
 *
 * GET /watch/:sessionId     → HTML 頁面（每 2 秒 fetch 一次 /progress/:sessionId）
 * GET /progress/:sessionId  → JSON，單純回傳 progress.js 存的狀態
 */

import { getProgress } from "./progress.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export function sessionIdFromPath(pathname, prefix) {
  if (!pathname.startsWith(prefix)) return "";
  const rest = pathname.slice(prefix.length);
  // 只允許 newSessionId() 會產生的字元，避免被拿去當路徑穿越之類的用途
  return /^[A-Za-z0-9_-]{1,64}$/.test(rest) ? rest : "";
}

export async function handleProgressApi(request, env, sessionId) {
  if (!sessionId) return json({ error: "not_found" }, 404);
  const progress = await getProgress(env, sessionId);
  if (!progress) return json({ error: "not_found" }, 404);
  return json(progress);
}

function watchPage(sessionId) {
  return `<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI 圓桌 · 即時監看</title>
<style>
body{font-family:system-ui,-apple-system,"PingFang TC","Microsoft JhengHei",sans-serif;background:#0f1320;color:#eee;margin:0;padding:20px}
.wrap{max-width:760px;margin:0 auto}
h1{font-size:18px;margin:0 0 4px}
.q{color:#9aa;font-size:13px;margin:0 0 16px;white-space:pre-wrap}
.status{font-size:13px;color:#9aa;margin-bottom:20px;position:sticky;top:0;background:#0f1320;padding:8px 0}
.status.done{color:#5fd47a}
.status.error{color:#ff8080}
.round{margin-bottom:22px}
.round-title{font-size:13px;color:#e9b949;font-weight:600;margin:0 0 10px;display:flex;align-items:center;gap:8px}
.round-title .line{flex:1;height:1px;background:#2a2f40}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}
.card{background:#1a1f30;border-radius:12px;padding:14px 16px;box-shadow:0 4px 16px rgba(0,0,0,.25);border:1px solid #242a3d}
.card.agree{border-color:#2f5d3a}
.card.error{border-color:#5d2f2f}
.card h3{font-size:13px;margin:0 0 8px;display:flex;align-items:center;justify-content:space-between;color:#cdd}
.tag{font-size:11px;padding:2px 8px;border-radius:999px;background:#2a2f40;color:#9aa}
.tag.agree{background:#1f3d28;color:#5fd47a}
.tag.error{background:#3d1f1f;color:#ff8080}
.body{font-size:13px;line-height:1.6;white-space:pre-wrap;word-break:break-word;color:#dde}
.final{background:#17231a;border:1px solid #2f5d3a;border-radius:12px;padding:16px 18px;margin-top:4px}
.final h2{font-size:14px;margin:0 0 10px;color:#5fd47a}
.final .body{color:#eee;font-size:14px}
.muted{color:#667}
</style></head>
<body>
<div class="wrap">
<h1>AI 圓桌 · 即時監看</h1>
<p class="q" id="question">載入中…</p>
<p class="status" id="status">連線中…</p>
<div id="rounds"></div>
<div id="final-wrap"></div>
</div>
<script>
const sessionId = ${JSON.stringify(sessionId)};
let stopped = false;
let renderedRounds = 0;

function cardHtml(entry) {
  const isAgree = /^狀態[：:]\\s*同意/.test((entry.text || '').slice(0, 20));
  const cls = entry.status === 'error' ? 'error' : (isAgree ? 'agree' : '');
  const tagCls = entry.status === 'error' ? 'error' : (isAgree ? 'agree' : '');
  const tagText = entry.status === 'error' ? '失敗' : (isAgree ? '同意' : '有意見');
  const div = document.createElement('div');
  div.className = 'card ' + cls;
  const esc = (s) => String(s || '').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
  div.innerHTML = '<h3>' + esc(entry.label) + '<span class="tag ' + tagCls + '">' + tagText + '</span></h3>' +
    '<div class="body">' + esc(entry.text) + '</div>';
  return div;
}

function renderRound(r) {
  const section = document.createElement('div');
  section.className = 'round';
  const title = document.createElement('div');
  title.className = 'round-title';
  title.innerHTML = '<span>第 ' + r.round + ' 輪' + (r.round === 1 ? '（各自獨立提案）' : '（看過彼此後的回應）') + '</span><span class="line"></span>';
  section.appendChild(title);
  const cards = document.createElement('div');
  cards.className = 'cards';
  (r.entries || []).forEach(e => cards.appendChild(cardHtml(e)));
  section.appendChild(cards);
  document.getElementById('rounds').appendChild(section);
}

async function poll() {
  if (stopped) return;
  try {
    const res = await fetch('/progress/' + encodeURIComponent(sessionId), { cache: 'no-store' });
    if (res.status === 404) {
      document.getElementById('status').textContent = '找不到這個討論（可能已過期）';
      document.getElementById('status').className = 'status error';
      return;
    }
    const p = await res.json();
    document.getElementById('question').textContent = p.question || '';
    if (Array.isArray(p.participants) && p.participants.length) {
      document.getElementById('question').textContent += '\\n參與者：' + p.participants.map(x => x.label).join('、');
    }

    const rounds = p.rounds || [];
    for (let i = renderedRounds; i < rounds.length; i++) renderRound(rounds[i]);
    renderedRounds = rounds.length;

    const statusEl = document.getElementById('status');
    if (p.status === 'done') {
      statusEl.textContent = '✅ 全員達成共識，討論結束（共 ' + p.round + ' 輪）';
      statusEl.className = 'status done';
      if (p.final && !document.getElementById('final-box')) {
        const box = document.createElement('div');
        box.className = 'final';
        box.id = 'final-box';
        const esc = (s) => String(s || '').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
        box.innerHTML = '<h2>最終結論</h2><div class="body">' + esc(p.final) + '</div>';
        document.getElementById('final-wrap').appendChild(box);
      }
      stopped = true;
      return;
    } else if (p.status === 'error') {
      statusEl.textContent = '❌ 發生錯誤：' + (p.error || '未知錯誤');
      statusEl.className = 'status error';
      stopped = true;
      return;
    } else {
      statusEl.textContent = '討論進行中…目前第 ' + (p.round || 0) + ' 輪（每 2 秒自動更新）';
      statusEl.className = 'status';
    }
  } catch (e) {
    document.getElementById('status').textContent = '連線異常，重試中…';
  }
  setTimeout(poll, 2000);
}
poll();
</script>
</body></html>`;
}

export async function handleWatchPage(request, env, sessionId) {
  if (!sessionId) {
    return new Response("找不到這個討論連結", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  return new Response(watchPage(sessionId), { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
}
