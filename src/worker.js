/**
 * worker.js — AI 圓桌的進入點程式（Workers with Static Assets 架構）
 */
import { onRequestPost as debateHandler } from "./debate.js";
import { onRequestGet as usageHandler } from "./usage.js";
import { runSelfReview } from "./selfReview.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

async function readSecret(env, name) {
  let value = env?.[name];
  try {
    if (value && typeof value.get === "function") value = await value.get();
  } catch { return ""; }
  return String(value || "").trim();
}

/**
 * 防範時序攻擊 (Timing Attacks) 的常數時間比對函數
 */
async function safeCompare(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const encoder = new TextEncoder();
  const aBuf = encoder.encode(a);
  const bBuf = encoder.encode(b);
  if (aBuf.byteLength !== bBuf.byteLength) return false;
  return crypto.subtle.timingSafeEqual(aBuf, bBuf);
}

async function handleSelfReviewRequest(request, env) {
  const configuredToken = await readSecret(env, "SELF_REVIEW_TOKEN");
  if (!configuredToken) {
    return json({ ok: false, error: "尚未設定 SELF_REVIEW_TOKEN，手動觸發已停用（排程仍會照常執行）" }, 403);
  }
  const givenToken = request.headers.get("x-self-review-token") || new URL(request.url).searchParams.get("token") || "";
  const isValid = await safeCompare(givenToken, configuredToken);
  if (!isValid) {
    return json({ ok: false, error: "token 不正確" }, 401);
  }
  try {
    const result = await runSelfReview(env);
    return json(result);
  } catch (e) {
    return json({ ok: false, error: String(e?.message || e || "自我健檢執行失敗") }, 500);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/debate" && request.method === "POST") {
      return debateHandler({ request, env, ctx });
    }

    if (url.pathname === "/usage" && request.method === "GET") {
      return usageHandler({ request, env, ctx });
    }

    if (url.pathname === "/self-review" && (request.method === "POST" || request.method === "GET")) {
      return handleSelfReviewRequest(request, env);
    }

    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runSelfReview(env).catch((e) => {
        console.error("AI 圓桌自我健檢（排程）失敗：", e?.message || e);
      })
    );
  },
};