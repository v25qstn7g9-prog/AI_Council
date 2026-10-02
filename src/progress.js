/**
 * progress.js — KV 存放圓桌討論的即時進度，給 /watch 頁面輪詢用。
 *
 * 跟 oauth.js 一樣沿用現有的 council_kv KV binding，另開一個 "progress:" 前綴，
 * 不用另外建新的 Cloudflare 資源。
 *
 * 這裡存的是 runRoundtableCouncil（4 人平等圓桌、多輪討論到有共識為止）的進度：
 * 每輪每個參與者的回覆都存起來，/watch 頁面可以把整個討論過程攤開來看，
 * 不只是看最後結果。
 */

const PROGRESS_TTL_SECONDS = 60 * 30; // 30 分鐘沒人看就自動過期
const SESSION_ID_BYTES = 12;
const MAX_STORED_ROUNDS = 20; // 比安全上限（15 輪）多留一點緩衝
const ACTIVE_KEY = "roundtable:active"; // 還在跑、watchdog 需要盯著的 sessionId 清單

function base64url(bytes) {
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function newSessionId() {
  const arr = new Uint8Array(SESSION_ID_BYTES);
  crypto.getRandomValues(arr);
  return base64url(arr);
}

function key(sessionId) {
  return `progress:${sessionId}`;
}

export async function createProgressSession(env, { question, participants, meta }) {
  const sessionId = newSessionId();
  const record = {
    sessionId,
    question: String(question || "").slice(0, 2000),
    participants: Array.isArray(participants) ? participants : [],
    status: "running", // running | done | error
    round: 0,
    rounds: [], // [{round, entries:[{id,label,status,text}]}]
    consensus: false,
    final: null,
    error: null,
    // meta（chosen/labels/baseBrief/effectiveMaxRounds）讓 watchdog 卡住時能接手跑下一輪，
    // 不用重新搜尋網路或重讀附件。只有 roundtable 會填這個，舊的 engineering council 用不到。
    meta: meta || null,
    startedAt: Date.now(),
    updatedAt: Date.now(),
  };
  await putProgress(env, sessionId, record);
  return sessionId;
}

/**
 * 「還在跑」的圓桌 sessionId 清單，給 roundtable-watchdog.js 用：每次 cron tick 掃一輪，
 * 看看有沒有哪場討論卡住很久沒動靜，有的話接手跑下一輪。
 */
export async function addActiveRoundtable(env, sessionId) {
  if (!env.council_kv || !sessionId) return;
  const current = await kvGetActiveList(env);
  if (!current.includes(sessionId)) {
    current.push(sessionId);
    await env.council_kv.put(ACTIVE_KEY, JSON.stringify(current), { expirationTtl: PROGRESS_TTL_SECONDS });
  }
}

export async function removeActiveRoundtable(env, sessionId) {
  if (!env.council_kv || !sessionId) return;
  const current = await kvGetActiveList(env);
  const next = current.filter((id) => id !== sessionId);
  if (next.length !== current.length) {
    await env.council_kv.put(ACTIVE_KEY, JSON.stringify(next), { expirationTtl: PROGRESS_TTL_SECONDS });
  }
}

export async function listActiveRoundtables(env) {
  return kvGetActiveList(env);
}

async function kvGetActiveList(env) {
  if (!env.council_kv) return [];
  const raw = await env.council_kv.get(ACTIVE_KEY);
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

async function putProgress(env, sessionId, record) {
  if (!env.council_kv) return; // 沒綁 KV 就沒辦法即時監看，但不影響圓桌本身運作
  await env.council_kv.put(key(sessionId), JSON.stringify(record), { expirationTtl: PROGRESS_TTL_SECONDS });
}

export async function getProgress(env, sessionId) {
  if (!env.council_kv) return null;
  const raw = await env.council_kv.get(key(sessionId));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * 根據 runRoundtableCouncil 的 onProgress callback payload（{stage, round, entries, consensus}）
 * 更新某個 session 的進度。stage "done" 代表這輪全員同意，整場討論結束。
 */
export function makeProgressUpdater(env, sessionId) {
  return async (payload) => {
    const current = (await getProgress(env, sessionId)) || {
      sessionId,
      status: "running",
      round: 0,
      rounds: [],
      consensus: false,
      final: null,
      error: null,
      startedAt: Date.now(),
    };
    const rounds = [...current.rounds, { round: payload.round, entries: payload.entries }].slice(-MAX_STORED_ROUNDS);
    const next = {
      ...current,
      round: payload.round,
      rounds,
      consensus: Boolean(payload.consensus),
      updatedAt: Date.now(),
    };
    if (payload.stage === "done") {
      next.status = "done";
      const ok = (payload.entries || []).filter((e) => e.status === "ok");
      const best = ok.reduce((b, c) => (!b || c.text.length > b.text.length ? c : b), null);
      next.final = best ? best.text.replace(/^狀態[：:]\s*同意\s*/i, "").trim() : null;
    }
    await putProgress(env, sessionId, next);
  };
}

export async function markProgressError(env, sessionId, message) {
  const current = (await getProgress(env, sessionId)) || { sessionId, rounds: [], round: 0 };
  await putProgress(env, sessionId, {
    ...current,
    status: "error",
    error: String(message || "未知錯誤").slice(0, 500),
    updatedAt: Date.now(),
  });
}
