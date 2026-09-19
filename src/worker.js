/**
 * worker.js — AI 圓桌的進入點程式（Workers with Static Assets 架構）
 */
import { onRequestPost as debateHandler } from "./debate.js";
import { onRequestGet as usageHandler } from "./usage.js";
import { runSelfReview } from "./selfReview.js";
import { handleGitHubEngineering, handleGitHubRepos } from "./githubEngineering.js";

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
 * 防範時序攻擊 (Timing Attacks) 的常數時間比對函數。
 * 使用固定長度 SHA-256 摘要，避免依賴 Node.js 專用 timingSafeEqual。
 */
async function safeCompare(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const encoder = new TextEncoder();
  const [aHash, bHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  const left = new Uint8Array(aHash);
  const right = new Uint8Array(bHash);
  let difference = 0;
  for (let i = 0; i < left.length; i += 1) difference |= left[i] ^ right[i];
  return difference === 0;
}

async function checkSelfReviewRateLimit(env) {
  const raw = String(env.SELF_REVIEW_RATE_LIMIT || "1:21600");
  const [maxStr, windowStr] = raw.split(":");
  const max = Number(maxStr), windowSec = Number(windowStr);
  if (!max || !windowSec || !env.council_kv) return { ok: true };

  const key = "self-review:global";
  const current = Number((await env.council_kv.get(key)) || 0);
  if (current >= max) {
    return {
      ok: false,
      message: `自我健檢太頻繁了，${Math.round(windowSec / 3600)} 小時內最多 ${max} 次，先讓圓桌休息一下 😅`,
    };
  }
  await env.council_kv.put(key, String(current + 1), { expirationTtl: windowSec });
  return { ok: true };
}

async function handleSelfReviewRequest(request, env) {
  const configuredToken = await readSecret(env, "SELF_REVIEW_TOKEN");
  if (!configuredToken) {
    return json({ ok: false, error: "尚未設定 SELF_REVIEW_TOKEN，手動觸發已停用（排程仍會照常執行）" }, 403);
  }
  const givenToken = request.headers.get("x-self-review-token") || "";
  const isValid = await safeCompare(givenToken, configuredToken);
  if (!isValid) {
    return json({ ok: false, error: "token 不正確" }, 401);
  }
  const rl = await checkSelfReviewRateLimit(env);
  if (!rl.ok) return json({ ok: false, error: rl.message }, 429);

  try {
    const result = await runSelfReview(env);
    return json(result);
  } catch (e) {
    console.error("AI 圓桌自我健檢（手動）失敗：", e?.message || e);
    return json({ ok: false, error: "自我健檢執行失敗，請稍後再試" }, 500);
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

    if (url.pathname === "/self-review" && request.method === "POST") {
      return handleSelfReviewRequest(request, env);
    }

    if (url.pathname === "/github/repos" && request.method === "GET") {
      return handleGitHubRepos(request, env);
    }

    if (url.pathname === "/github/engineering" && request.method === "POST") {
      return handleGitHubEngineering(request, env);
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
