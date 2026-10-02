/**
 * chatroom.js — 「聊天模式」：最多 4 個 AI（跟圓桌討論一樣，cloudflare/openai/anthropic/gemini
 * 自由選放不放）在背景隨意閒聊，直到 Johnny 喊休息為止。
 *
 * Cloudflare Workers 沒辦法跑一個「一直不停」的背景迴圈，所以這裡用 Cron Trigger
 * （wrangler.jsonc 裡設定的「每 2 分鐘一次」排程）取代：每次 tick 檢查聊天室是否
 * 還開著，開著就讓其中一位（跟上一個發言的人不同）根據最近紀錄講一句話，存進 KV；
 * 沒開就什麼都不做（只是一次便宜的 KV 讀取）。這樣「一直聊到喊停」变成「每 2 分鐘輪一次、
 * 直到旗標被關掉」，符合 Workers 的執行模型，也天然限制了燒錢速度。
 *
 * 狀態跟訊息都存在既有的 council_kv KV binding：
 *   chatroom:state → 單一 JSON（是否開啟、參與者、訊息數、連續失敗次數…）
 *   chatroom:log   → 單一 JSON 陣列（最近訊息，超過上限就從舊的開始丟）
 */

import { generateChatMessage, councilModelConfig } from "./debate.js";

const STATE_KEY = "chatroom:state";
const LOG_KEY = "chatroom:log";
const STORE_TTL_SECONDS = 60 * 60 * 24 * 14; // 2 週；每次寫入都會刷新，活躍的聊天室不會過期
const CHAT_LOG_MAX = 200;
const CHAT_SAFETY_MAX_MESSAGES = 300; // 不是「目標則數」，純粹防止忘記喊休息時一直燒下去
const CHAT_MAX_CONSECUTIVE_FAILURES = 5;
const PROVIDER_LABELS = { cloudflare: "Cloudflare", openai: "OpenAI", anthropic: "Claude", gemini: "Gemini" };

function sanitizeInternalError(value) {
  const s = String(value?.message || value || "").replace(/[\r\n]+/g, " ").trim();
  return s || "未知錯誤";
}

async function kvGetJSON(env, key, fallback) {
  if (!env.council_kv) return fallback;
  const raw = await env.council_kv.get(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function kvPutJSON(env, key, value) {
  if (!env.council_kv) return; // 沒綁 KV 就沒辦法做聊天室，但也不該讓整個 Worker 壞掉
  await env.council_kv.put(key, JSON.stringify(value), { expirationTtl: STORE_TTL_SECONDS });
}

export async function getChatState(env) {
  return kvGetJSON(env, STATE_KEY, null);
}

export async function getChatLog(env) {
  return kvGetJSON(env, LOG_KEY, []);
}

async function appendSystemLine(env, text) {
  const log = await getChatLog(env);
  log.push({ ts: Date.now(), id: "system", label: "系統", text });
  await kvPutJSON(env, LOG_KEY, log.slice(-CHAT_LOG_MAX));
}

/**
 * 開始（或重新開啟）聊天室。沿用 councilModelConfig 判斷哪些 provider 真的可用，
 * 邏輯跟 runRoundtableCouncil 的參與者驗證一致：至少要放 2 個。
 */
export async function startChatroom(env, { participants }) {
  const config = await councilModelConfig(env);
  const availableIds = new Set(config.providers.filter((p) => p.available).map((p) => p.id));
  const requested = Array.isArray(participants) && participants.length
    ? [...new Set(participants.map((p) => String(p || "").trim().toLowerCase()))]
    : [...availableIds];
  const chosen = requested.filter((p) => availableIds.has(p));
  if (chosen.length < 2) {
    throw new Error(
      chosen.length === 0
        ? "沒有任何可用的 AI（檢查一下 API Key 有沒有設定），至少要放 2 個才能聊天"
        : `只有 ${chosen.length} 個 AI 可用（${chosen.join("、")}），至少要放 2 個才能聊天`
    );
  }
  const participantRecords = chosen.map((id) => ({ id, label: PROVIDER_LABELS[id] || id }));

  const state = {
    enabled: true,
    participants: participantRecords,
    lastSpeakerId: null,
    messageCount: 0,
    consecutiveFailures: 0,
    stoppedReason: null,
    startedAt: Date.now(),
    updatedAt: Date.now(),
  };
  await kvPutJSON(env, STATE_KEY, state);
  await appendSystemLine(env, `🟢 聊天室開始了，成員：${participantRecords.map((p) => p.label).join("、")}`);
  return state;
}

export async function stopChatroom(env, reason = "user_requested") {
  const state = await getChatState(env);
  if (!state) return null;
  const next = { ...state, enabled: false, stoppedReason: reason, updatedAt: Date.now() };
  await kvPutJSON(env, STATE_KEY, next);
  await appendSystemLine(env, reason === "user_requested" ? "🔴 Johnny 喊休息了，聊天室先關起來。" : `🔴 聊天室自動暫停（${reason}）`);
  return next;
}

function pickNextSpeaker(participants, lastSpeakerId) {
  const pool = participants.length > 1 ? participants.filter((p) => p.id !== lastSpeakerId) : participants;
  return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * runChatTick — 給 worker.js 的 scheduled() 每次 Cron 觸發時呼叫一次。
 * 聊天室沒開就直接回傳 {skipped:true}，是一次很便宜的 no-op。
 */
export async function runChatTick(env) {
  const state = await getChatState(env);
  if (!state || !state.enabled) return { skipped: true };

  if (state.messageCount >= CHAT_SAFETY_MAX_MESSAGES) {
    await stopChatroom(env, `已經聊了 ${CHAT_SAFETY_MAX_MESSAGES} 則訊息（安全上限，不是目標則數），自動休息`);
    return { stopped: "safety_cap" };
  }

  const speaker = pickNextSpeaker(state.participants, state.lastSpeakerId);
  if (!speaker) {
    await stopChatroom(env, "沒有可用的參與者");
    return { stopped: "no_participants" };
  }

  const log = await getChatLog(env);
  const recentLog = log.slice(-12).filter((m) => m.id !== "system");

  try {
    const result = await generateChatMessage({ env, provider: speaker.id, label: speaker.label, recentLog });
    const entry = { ts: Date.now(), id: speaker.id, label: speaker.label, text: String(result.text || "").trim() };
    const nextLog = [...log, entry].slice(-CHAT_LOG_MAX);
    await kvPutJSON(env, LOG_KEY, nextLog);
    await kvPutJSON(env, STATE_KEY, {
      ...state,
      lastSpeakerId: speaker.id,
      messageCount: state.messageCount + 1,
      consecutiveFailures: 0,
      updatedAt: Date.now(),
    });
    return { ok: true, speaker: speaker.id };
  } catch (error) {
    const failures = (state.consecutiveFailures || 0) + 1;
    if (failures >= CHAT_MAX_CONSECUTIVE_FAILURES) {
      await stopChatroom(env, `連續 ${failures} 次發言失敗，自動暫停（最後錯誤：${sanitizeInternalError(error)}）`);
      return { stopped: "consecutive_failures" };
    }
    await kvPutJSON(env, STATE_KEY, { ...state, consecutiveFailures: failures, updatedAt: Date.now() });
    return { ok: false, error: sanitizeInternalError(error) };
  }
}
