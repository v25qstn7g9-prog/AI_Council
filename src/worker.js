/**
 * worker.js — AI 圓桌的進入點程式（Workers with Static Assets 架構）
 *
 * 路由規則：
 * - /debate（POST）      → 交給 src/debate.js 跑圓桌
 * - /usage（GET）        → 查詢 Workers AI 今日 Neurons 用量
 * - /self-review（POST） → 手動觸發一次自我健檢（需要 SELF_REVIEW_TOKEN，見下方）
 * - 其他所有網址          → 當一般靜態檔案送出去
 *
 * 自我健檢（scheduled + /self-review）：
 * - 每次執行都是「讀自己的原始碼 → 跑一次工程圓桌審查 → 有修改建議就開 PR，沒有就開 Issue
 *   留一份健檢報告」。永遠不會自動 merge PR，最後按下去部署的人一定是你自己。
 * - 排程頻率設在 wrangler.jsonc 的 triggers.crons。
 * - 手動觸發是為了不想等排程時使用；因為會消耗 AI 額度、還會在你的 GitHub repo 開 PR/Issue，
 *   所以刻意沒有做成公開頁面上的按鈕，必須帶對 SELF_REVIEW_TOKEN 這個 Secret 才能觸發：
 *     curl -X POST "https://你的-worker.workers.dev/self-review" -H "x-self-review-token: 你設定的token"
 *   沒有設定 SELF_REVIEW_TOKEN 的話，這個手動端點會直接拒絕，只有排程還能跑。
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

async function handleSelfReviewRequest(request, env) {
  const configuredToken = await readSecret(env, "SELF_REVIEW_TOKEN");
  if (!configuredToken) {
    return json({ ok: false, error: "尚未設定 SELF_REVIEW_TOKEN，手動觸發已停用（排程仍會照常執行）" }, 403);
  }
  const givenToken = request.headers.get("x-self-review-token") || new URL(request.url).searchParams.get("token") || "";
  if (givenToken !== configuredToken) {
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

    if (url.pathname === "/self-review" && request.method === "POST") {
      return handleSelfReviewRequest(request, env);
    }

    return env.ASSETS.fetch(request);
  },

  // Cron Trigger 進入點：排程時間到了由 Cloudflare 自動呼叫，不是使用者觸發的。
  // 用 ctx.waitUntil 讓 Worker 在背景把整個健檢流程跑完，而不是被提早關閉。
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runSelfReview(env).catch((e) => {
        console.error("AI 圓桌自我健檢（排程）失敗：", e?.message || e);
      })
    );
  },
};
