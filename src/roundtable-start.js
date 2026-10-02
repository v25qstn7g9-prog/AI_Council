/**
 * roundtable-start.js — 網站自己的前端用的公開（不用 OAuth）圓桌討論啟動端點。
 *
 * MCP 那邊（mcp.js 的 ai_council_debate_start）是給 Claude 用的，需要 OAuth bearer token；
 * 但網站的使用者就是 Johnny 自己在瀏覽器上點，沒有 OAuth 流程，所以這裡開一個不用認證、
 * 但一樣會做 rate limit 的端點，直接共用 debate.js 的 resolveParticipants / runRoundtableCouncil
 * 跟 mcp.js 同一套邏輯，回傳 { sessionId, watchUrl } 讓前端導去已經做好的 /watch/:sessionId 頁面。
 */

import { runRoundtableCouncil, resolveParticipants, checkRateLimit } from "./debate.js";
import { createProgressSession, makeProgressUpdater, markProgressError } from "./progress.js";

const MAX_QUESTION_LENGTH = 4000;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export async function handleRoundtableStart(request, env, ctx) {
  if (String(env.COUNCIL_ENABLED || "true").toLowerCase() === "false") {
    return json({ error: "AI 圓桌目前休會中 🛑" }, 503);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "請求內容不是合法的 JSON" }, 400);
  }

  const question = String(body?.question || "").trim();
  if (!question) return json({ error: "請輸入要討論的問題" }, 400);
  if (question.length > MAX_QUESTION_LENGTH) return json({ error: "問題太長了，請精簡一下" }, 400);

  const ip = request.headers.get("cf-connecting-ip") || "";
  const rl = await checkRateLimit(env, ip);
  if (!rl.ok) return json({ error: rl.message }, 429);

  let participants;
  try {
    participants = await resolveParticipants(env, body?.providers);
  } catch (error) {
    return json({ error: String(error?.message || error || "未知錯誤") }, 400);
  }

  const webSearch = body?.webSearch === true;
  const maxRounds = body?.maxRounds;

  const sessionId = await createProgressSession(env, { question, participants });
  const updateProgress = makeProgressUpdater(env, sessionId);

  const run = runRoundtableCouncil({
    env,
    question,
    rawFiles: [],
    rawImages: [],
    webSearch,
    participants: participants.map((p) => p.id),
    maxRounds,
    onProgress: updateProgress,
  }).catch((error) => {
    const message = String(error?.message || error || "未知錯誤").slice(0, 500);
    return markProgressError(env, sessionId, message);
  });

  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(run);
  } else {
    await run;
  }

  const origin = new URL(request.url).origin;
  return json({
    ok: true,
    sessionId,
    watchUrl: `${origin}/watch/${sessionId}`,
    participants,
  });
}
