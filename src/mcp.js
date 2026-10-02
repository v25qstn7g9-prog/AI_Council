/**
 * mcp.js — Minimal remote MCP server for AI 圓桌 (Model Context Protocol, Streamable HTTP transport)
 *
 * Exposes the existing /debate engine (runEngineeringCouncil) as a single MCP tool,
 * so Claude can call "讓 AI 圓桌開會" directly instead of Johnny opening the web UI.
 *
 * This is a stateless implementation of the Streamable HTTP transport: every request
 * is a self-contained JSON-RPC call and the response is a single JSON body (no SSE
 * session, no server push) — sufficient for one-shot tool calls on Cloudflare Workers.
 *
 * Spec: https://modelcontextprotocol.io/specification/2025-03-26/basic/transports
 */

import { runEngineeringCouncil } from "./debate.js";
import { verifyAccessToken, unauthorizedMcpResponse } from "./oauth.js";

const PROTOCOL_VERSION = "2025-03-26";
const SERVER_INFO = { name: "ai-council-mcp", version: "1.0.0" };

const TOOLS = [
  {
    name: "ai_council_debate",
    description:
      "讓 AI 圓桌開會：AI A 主審先回答，AI B 反方複審，最後由 AI C 整合出結論。" +
      "適合需要交叉驗證的問題（重大決策、程式除錯、有爭議的分析），不適合隨口小問題——" +
      "每次呼叫都會實際呼叫已設定的付費 AI 服務（OpenAI / Claude），有成本。",
    inputSchema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "要交給圓桌討論的問題，可以包含背景脈絡，讓回答更貼合情境。",
        },
        webSearch: {
          type: "boolean",
          description: "是否讓圓桌先做網路搜尋再討論（需要 TAVILY_API_KEY，未設定時會自動略過）。預設 false。",
        },
      },
      required: ["question"],
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

function summarizeCouncilResult(result) {
  const labels = result?.labels || {};
  const lines = [
    `【結論】\n${result?.final || "（圓桌沒有產生結論）"}`,
    `\n---\n主審（${labels.a || "AI A"}）：\n${result?.a || ""}`,
    `\n反方複審（${labels.b || "AI B"}）：\n${result?.b || ""}`,
  ];
  if (result?.c) lines.push(`\n證據裁決（${labels.c || "AI C"}）：\n${result.c}`);
  return lines.join("\n").slice(0, 12000);
}

async function callDebateTool(env, args) {
  const question = String(args?.question || "").trim();
  if (!question) throw new Error("question 不能是空的");
  const webSearch = args?.webSearch === true;

  const result = await runEngineeringCouncil({
    env,
    question,
    rawFiles: [],
    rawImages: [],
    webSearch,
  });

  return {
    content: [{ type: "text", text: summarizeCouncilResult(result) }],
  };
}

export async function handleMcpRequest(request, env) {
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
      if (toolName === "ai_council_debate") {
        const toolResult = await callDebateTool(env, params?.arguments || {});
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
