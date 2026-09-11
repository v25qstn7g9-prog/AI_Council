/**
 * worker.js — AI 圓桌的進入點程式（Workers with Static Assets 架構）
 *
 * 路由規則：
 * - /debate（POST）→ 交給 src/debate.js 跑圓桌
 * - /usage（GET）→ 查詢 Workers AI 今日 Neurons 用量
 * - 其他所有網址   → 當一般靜態檔案送出去
 */
import { onRequestPost as debateHandler } from "./debate.js";
import { onRequestGet as usageHandler } from "./usage.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/debate" && request.method === "POST") {
      return debateHandler({ request, env, ctx });
    }

    if (url.pathname === "/usage" && request.method === "GET") {
      return usageHandler({ request, env, ctx });
    }

    return env.ASSETS.fetch(request);
  },
};
