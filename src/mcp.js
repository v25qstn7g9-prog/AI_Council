/**
 * mcp.js — Minimal remote MCP server for AI 圓桌 (Model Context Protocol, Streamable HTTP transport)
 *
 * Exposes the 4 人平等圓桌 engine (runRoundtableCouncil, debate.js) as MCP tools, so Claude can
 * trigger "讓 AI 圓桌開會" directly instead of Johnny opening the web UI.
 *
 * Debate rounds take tens of seconds, and Johnny wants to watch the discussion live rather
 * than wait for one bundled result. So the tool call doesn't block on the whole debate:
 * ai_council_debate_start kicks the debate off in the background (ctx.waitUntil) and returns
 * almost immediately with a /watch/:sessionId link; ai_council_debate_result polls the
 * progress stored in KV (see progress.js) so Claude can report back once it's done.
 *
 * This is a stateless implementation of the Streamable HTTP transport: every request
 * is a self-contained JSON-RPC call and the response is a single JSON body (no SSE
 * session, no server push) — sufficient for one-shot tool calls on Cloudflare Workers.
 *
 * Spec: https://modelcontextprotocol.io/specification/2025-03-26/basic/transports
 */

import { runRoundtableCouncil, councilModelConfig } from "./debate.js";
import { verifyAccessToken, unauthorizedMcpResponse } from "./oauth.js";
import { createProgressSession, getProgress, makeProgressUpdater, markProgressError } from "./progress.js";

const PROTOCOL_VERSION = "2025-03-26";
const SERVER_INFO = { name: "ai-council-mcp", version: "2.0.0" };
const PROVIDER_LABELS = { cloudflare: "Cloudflare", openai: "OpenAI", anthropic: "Claude", gemini: "Gemini" };

const TOOLS = [
  {
    name: "ai_council_debate_start",
    description:
      "開始一場 AI 圓桌會議：最多 4 個 AI（cloudflare / openai / anthropic / gemini，可自由選放不放）地位完全平等，" +
      "各自對問題提出方案，看過彼此意見後可以提修改、也可以表態同意，一輪一輪討論下去，直到全員明確同意同一個版本才算結案。" +
      "適合需要交叉驗證、有爭議、或重大決策的問題，不適合隨口小問題——" +
      "每次呼叫都會實際呼叫已設定的付費 AI 服務（OpenAI / Claude），有成本，而且可能要討論好幾輪才會停。" +
      "這個工具會立刻回傳，不會等討論完：回傳內容包含一個即時監看網址（watchUrl），可以分享給使用者打開看現場討論一輪一輪跑，" +
      "以及一個 sessionId，之後要用 ai_council_debate_result 這個工具去查目前進度或拿最終結論。",
    inputSchema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "要交給圓桌討論的問題，可以包含背景脈絡，讓回答更貼合情境。",
        },
        providers: {
          type: "array",
          items: { type: "string", enum: ["cloudflare", "openai", "anthropic", "gemini"] },
          description:
            "要放進這場討論的 AI，從 cloudflare/openai/anthropic/gemini 中選，至少要選 2 個（沒有主副之分，純粹是放誰進來討論）。" +
            "不帶這個參數就預設放所有目前有設定金鑰、可以用的 AI。",
        },
        webSearch: {
          type: "boolean",
          description: "是否讓圓桌先做網路搜尋再討論（需要 TAVILY_API_KEY，未設定時會自動略過）。預設 false。",
        },
      },
      required: ["question"],
    },
  },
  {
    name: "ai_council_debate_result",
    description:
      "查詢一場用 ai_council_debate_start 開始的圓桌討論目前進度。還在進行中時，會回傳目前討論到第幾輪、" +
      "每個 AI 最新一輪的意見與是否同意；討論完成時（全員同意），會回傳最終結論。" +
      "討論可能要數十秒到好幾分鐘（取決於要吵幾輪才有共識），可以每隔一段時間呼叫一次這個工具來追蹤進度。",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description: "ai_council_debate_start 回傳的 sessionId。",
        },
      },
      required: ["sessionId"],
    },
  },
];

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function textToolResult(text) {
  return { content: [{ type: "text", text: String(text).slice(0, 12000) }] };
}

function formatEntries(entries) {
  return (entries || [])
    .map((e) => {
      const tag = e.status === "error" ? "⚠️ 失敗" : /^狀態[：:]\s*同意/.test((e.text || "").slice(0, 20)) ? "✅ 同意" : "✏️ 有意見";
      return `【${e.label} ${tag}】\n${e.text}`;
    })
    .join("\n\n");
}

function summarizeDone(progress) {
  const lastRound = progress?.rounds?.[progress.rounds.length - 1];
  const lines = [
    `【全員達成共識，結案】（共 ${progress?.round || 0} 輪）`,
    `\n${progress?.final || "（沒有產生結論）"}`,
  ];
  if (lastRound) lines.push(`\n---\n最後一輪各方表態：\n${formatEntries(lastRound.entries)}`);
  return lines.join("\n");
}

function summarizeRunning(progress) {
  const lastRound = progress?.rounds?.[progress.rounds.length - 1];
  const lines = [`【討論進行中】目前第 ${progress?.round || 0} 輪`];
  if (lastRound) {
    lines.push(`\n本輪各方意見：\n${formatEntries(lastRound.entries)}`);
  } else {
    lines.push("\n（第一輪還沒跑完，過一下再查一次）");
  }
  return lines.join("\n");
}

async function callDebateStartTool(env, ctx, origin, args) {
  const question = String(args?.question || "").trim();
  if (!question) throw new Error("question 不能是空的");
  const webSearch = args?.webSearch === true;

  const config = await councilModelConfig(env);
  const availableIds = new Set(config.providers.filter((p) => p.available).map((p) => p.id));
  const requestedRaw = Array.isArray(args?.providers) ? args.providers : null;
  const requested = requestedRaw?.length
    ? [...new Set(requestedRaw.map((p) => String(p || "").trim().toLowerCase()))]
    : [...availableIds];
  const chosen = requested.filter((p) => availableIds.has(p));
  if (chosen.length < 2) {
    throw new Error(
      chosen.length === 0
        ? "沒有任何可用的 AI（檢查一下 API Key 有沒有設定），至少要放 2 個才能討論"
        : `只有 ${chosen.length} 個 AI 可用（${chosen.join("、")}），至少要放 2 個才能討論出共識`
    );
  }
  const participants = chosen.map((id) => ({ id, label: PROVIDER_LABELS[id] || id }));

  const sessionId = await createProgressSession(env, { question, participants });
  const updateProgress = makeProgressUpdater(env, sessionId);

  const run = runRoundtableCouncil({
    env,
    question,
    rawFiles: [],
    rawImages: [],
    webSearch,
    participants: chosen,
    onProgress: updateProgress,
  }).catch((error) => {
    const message = String(error?.message || error || "未知錯誤").slice(0, 500);
    return markProgressError(env, sessionId, message);
  });

  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(run);
  } else {
    // 沒有 ctx（例如測試環境）就直接等它跑完，行為退化成同步呼叫。
    await run;
  }

  const watchUrl = `${origin}/watch/${sessionId}`;
  return textToolResult(
    `圓桌討論已經開始了，這次放了 ${participants.map((p) => p.label).join("、")} 共 ${participants.length} 位。\n` +
      `即時監看網址（可以直接分享給使用者打開看現場討論一輪一輪跑）：${watchUrl}\n` +
      `sessionId：${sessionId}\n` +
      `討論會一直進行到全員明確同意同一版結論才結束，可能要數十秒到好幾分鐘，請稍等一下再呼叫 ai_council_debate_result 查結果。`
  );
}

async function callDebateResultTool(env, args) {
  const sessionId = String(args?.sessionId || "").trim();
  if (!sessionId) throw new Error("sessionId 不能是空的");

  const progress = await getProgress(env, sessionId);
  if (!progress) {
    return textToolResult("找不到這場討論，sessionId 可能錯誤或是已經過期（30 分鐘沒查詢就會清除）。");
  }
  if (progress.status === "error") {
    return textToolResult(`圓桌討論失敗了：${progress.error || "未知錯誤"}`);
  }
  if (progress.status === "done") {
    return textToolResult(summarizeDone(progress));
  }
  return textToolResult(summarizeRunning(progress));
}

export async function handleMcpRequest(request, env, ctx) {
  if (request.method !== "POST") {
    return jsonResponse(rpcError(null, -32600, "只接受 POST"), 405);
  }

  const auth = await verifyAccessToken(request, env);
  if (!auth.ok) {
    const origin = new URL(request.url).origin;
    return unauthorizedMcpResponse(origin);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(rpcError(null, -32700, "Parse error"), 400);
  }

  const { id, method, params } = body || {};

  try {
    if (method === "initialize") {
      return jsonResponse(
        rpcResult(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        })
      );
    }

    if (method === "notifications/initialized") {
      // 通知，不需要回應內容；但 Workers 的 fetch handler 一定要回點東西。
      return new Response(null, { status: 202 });
    }

    if (method === "tools/list") {
      return jsonResponse(rpcResult(id, { tools: TOOLS }));
    }

    if (method === "tools/call") {
      const toolName = params?.name;
      const origin = new URL(request.url).origin;
      if (toolName === "ai_council_debate_start") {
        const toolResult = await callDebateStartTool(env, ctx, origin, params?.arguments || {});
        return jsonResponse(rpcResult(id, toolResult));
      }
      if (toolName === "ai_council_debate_result") {
        const toolResult = await callDebateResultTool(env, params?.arguments || {});
        return jsonResponse(rpcResult(id, toolResult));
      }
      return jsonResponse(rpcError(id, -32602, `未知的工具：${toolName}`), 400);
    }

    return jsonResponse(rpcError(id, -32601, `未知的方法：${method}`), 400);
  } catch (error) {
    const message = String(error?.message || error || "未知錯誤").slice(0, 300);
    return jsonResponse(rpcError(id, -32000, message), 200);
  }
}
