/**
 * worker.js — AI 圓桌的進入點程式（Workers with Static Assets 架構）
 *
 * 路由規則：
 * - /debate（POST）→ 交給 src/debate.js 跑三回合圓桌
 * - 其他所有網址   → 當一般靜態檔案送出去（index.html 等）
 *
 * 這是新式「Workers with Static Assets」架構必須有的進入點，
 * 跟舊式 Pages Functions（functions 資料夾會被自動偵測）不一樣，
 * 兩者需要的設定完全不同，不能只搬檔案就以為會動。
 */
import { onRequestPost as debateHandler } from "./debate.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/debate" && request.method === "POST") {
      return debateHandler({ request, env, ctx });
    }

    return env.ASSETS.fetch(request);
  },
};
