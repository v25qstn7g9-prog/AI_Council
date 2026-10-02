/**
 * roundtable-watchdog.js — 圓桌討論卡住時的自動接手機制。
 *
 * 背景：runPreparedRoundtable 原本是「一次呼叫、整場討論跑到底」，整段包在一個
 * ctx.waitUntil 裡。實測發現有時候會卡在某一輪不動（疑似 Workers 背景執行被中斷），
 * 而且沒有任何錯誤訊息寫進 KV，使用者只會看到「進行中」卡住不動。
 *
 * 這裡用跟聊天室一樣的 Cron tick 模式當安全網：每次 tick（see worker.js 的
 * scheduled()，沿用聊天室同一個「每 2 分鐘一次」排程）檢查所有還在 KV
 * （roundtable:active）裡登記的 sessionId，如果有哪場討論超過 STALL_MS 沒更新，
 * 就用 continueRoundtableRound 幫它接著跑下一輪——不是整場重來，只跑一輪，
 * 刻意讓每次 watchdog 介入的執行時間維持很短。
 *
 * 正常（沒卡住）的討論完全不會被這裡碰到：它自己跑完、自己從 active 清單移除。
 */

import { continueRoundtableRound } from "./debate.js";
import { listActiveRoundtables, removeActiveRoundtable, getProgress, makeProgressUpdater, markProgressError } from "./progress.js";

// 一輪正常最久大概是單一 provider 的 timeout（30 秒）左右，給一些餘裕；
// 超過這個時間還沒動靜，就認定是卡住了，不是「剛好在跑」。
const STALL_MS = 100 * 1000;

export async function runRoundtableWatchdog(env) {
  const sessionIds = await listActiveRoundtables(env);
  if (!sessionIds.length) return { checked: 0, resumed: 0, cleaned: 0 };

  let resumed = 0;
  let cleaned = 0;

  for (const sessionId of sessionIds) {
    const progress = await getProgress(env, sessionId);

    if (!progress || progress.status !== "running" || !progress.meta) {
      await removeActiveRoundtable(env, sessionId);
      cleaned++;
      continue;
    }

    const lastUpdate = progress.updatedAt || progress.startedAt || 0;
    if (Date.now() - lastUpdate < STALL_MS) continue; // 還在正常範圍內，不用管

    try {
      const step = await continueRoundtableRound({ env, progress });
      const done = step.consensus || step.round >= step.effectiveMaxRounds;
      const updateProgress = makeProgressUpdater(env, sessionId);
      await updateProgress({ stage: done ? "done" : "round", round: step.round, entries: step.entries, consensus: step.consensus });
      if (done) await removeActiveRoundtable(env, sessionId);
      resumed++;
    } catch (error) {
      await markProgressError(env, sessionId, `圓桌討論卡住後自動接手失敗：${String(error?.message || error || "未知錯誤").slice(0, 400)}`);
      await removeActiveRoundtable(env, sessionId);
      cleaned++;
    }
  }

  return { checked: sessionIds.length, resumed, cleaned };
}
