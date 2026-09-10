/**
 * debate.js — ai-council-v3.0-engineering-collab
 *
 * POST /debate
 * body:
 * {
 *   question: string,
 *   webSearch?: boolean,
 *   files?: [{ path, content, size }],
 *   images?: [{ name, dataUrl }]
 * }
 *
 * 工程協作流程：
 * 0. 可選 Web Search
 * 0.5 圖片交給 Vision 模型分析 UI / 錯誤畫面
 * 1. AI A = 主工程師：理解專案、提出修法與候選修改
 * 2. AI B = Code Reviewer：找錯、找漏、檢查風險
 * 3. AI A = 整合工程師：輸出最終結論 + 可下載的完整檔案替換內容
 */

const VERSION = "3.0.1-tavily-diagnostic";
const MODEL_A = "@cf/openai/gpt-oss-120b";
const MODEL_B = "@cf/qwen/qwen3-30b-a3b-fp8";
const VISION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";

const MAX_Q = 4000;
const MAX_FILES = 30;
const MAX_FILE_CHARS = 30000;
const MAX_TOTAL_FILE_CHARS = 180000;
const MAX_IMAGES = 4;
const DEFAULT_RATE_LIMIT = "8:1800";

function hasTavilySecret(env) {
  try {
    return Boolean(env && env.TAVILY_API_KEY);
  } catch {
    return false;
  }
}

function out(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function txt(r) {
  if (typeof r?.response === "string") return r.response.trim();
  if (Array.isArray(r?.choices)) return String(r.choices[0]?.message?.content || "").trim();
  return "";
}

async function ask(ai, model, messages, maxTokens = 1200, temperature = 0.35) {
  const r = await ai.run(model, { messages, max_tokens: maxTokens, temperature });
  const t = txt(r);
  if (!t) throw new Error(model + " 沒有回傳文字");
  return t;
}

async function searchWeb(env, query) {
  let apiKey = env.TAVILY_API_KEY;
  try {
    if (apiKey && typeof apiKey.get === "function") apiKey = await apiKey.get();
  } catch (e) {
    return { ok:false, used:false, reason:"key_read_failed", message:"讀取 TAVILY_API_KEY 失敗", detail:String(e?.message||e||""), text:"", resultCount:0 };
  }
  apiKey = String(apiKey || "").trim();
  if (!apiKey) return { ok:false, used:false, reason:"no_api_key", message:"尚未設定 TAVILY_API_KEY", text:"", resultCount:0 };

  try {
    const r = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        search_depth: "basic",
        max_results: 5,
        include_answer: false,
      }),
    });
    const data = await r.json().catch(() => null);
    if (!r.ok) {
      return {
        ok:false, used:false,
        reason: r.status===401||r.status===403 ? "auth_failed" : r.status===429 ? "quota_or_rate_limit" : "provider_error",
        message: r.status===401||r.status===403 ? "Tavily API Key 驗證失敗" : r.status===429 ? "Tavily 額度或速率限制已達上限" : `Tavily 搜尋失敗（HTTP ${r.status}）`,
        detail:String(data?.detail||data?.message||data?.error||"").slice(0,300),
        text:"", resultCount:0
      };
    }
    const results = Array.isArray(data?.results) ? data.results.slice(0,5) : [];
    if (!results.length) return { ok:true, used:false, reason:"no_results", message:"Web Search 已執行，但沒有找到可用結果", text:"", resultCount:0 };
    return {
      ok:true, used:true, reason:"success",
      message:`Web Search 成功，找到 ${results.length} 筆資料`,
      resultCount:results.length,
      text:results.map((x,i)=>`${i+1}. ${x.title||"（無標題）"}\n${x.content||""}\n來源：${x.url||""}`).join("\n\n")
    };
  } catch (e) {
    return { ok:false, used:false, reason:"network_error", message:"Tavily 連線失敗", detail:String(e?.message||e||"").slice(0,300), text:"", resultCount:0 };
  }
}

async function analyzeImage(ai, image) {
  const name = String(image?.name || "image").slice(0,120);
  const dataUrl = String(image?.dataUrl || "");
  if (!/^data:image\/(png|jpe?g|webp);base64,/i.test(dataUrl)) {
    return { name, ok:false, text:"不支援的圖片格式" };
  }

  try {
    const r = await ai.run(VISION_MODEL, {
      messages: [
        {
          role: "system",
          content:
            "你是軟體除錯用的視覺分析員。用繁體中文檢查截圖中的 UI、錯誤訊息、版面異常、缺失元件、按鈕狀態、文字與數字。只描述看得到的內容，不要猜身分或不可見程式碼。"
        },
        {
          role: "user",
          content:
            `這張圖片檔名是 ${name}。請針對軟體維修提供：1.畫面重點 2.可疑問題 3.可供工程師對照的文字/數值。`
        }
      ],
      image: dataUrl,
      max_tokens: 700,
    });
    const t = txt(r);
    return { name, ok:Boolean(t), text:t || "Vision 模型沒有回傳文字" };
  } catch (e) {
    return { name, ok:false, text:`圖片分析失敗：${String(e?.message||e||"")}` };
  }
}

function normalizeFiles(raw) {
  const list = Array.isArray(raw) ? raw.slice(0, MAX_FILES) : [];
  let used = 0;
  const out = [];
  for (const f of list) {
    const path = String(f?.path || "").replace(/^\/+/, "").slice(0,220);
    if (!path) continue;
    let content = typeof f?.content === "string" ? f.content : "";
    content = content.slice(0, Math.min(MAX_FILE_CHARS, Math.max(0, MAX_TOTAL_FILE_CHARS-used)));
    used += content.length;
    out.push({ path, content, truncated: Number(f?.size||0) > content.length || content.length >= MAX_FILE_CHARS });
    if (used >= MAX_TOTAL_FILE_CHARS) break;
  }
  return out;
}

function buildProjectContext(files, imageReports) {
  const parts = [];
  if (files.length) {
    parts.push("【專案文字檔】");
    for (const f of files) {
      parts.push(`\n===== FILE: ${f.path}${f.truncated ? " [TRUNCATED]" : ""} =====\n${f.content}`);
    }
  }
  if (imageReports.length) {
    parts.push("\n【圖片 / 截圖分析】");
    for (const r of imageReports) {
      parts.push(`\n===== IMAGE: ${r.name} =====\n${r.text}`);
    }
  }
  return parts.join("\n");
}

function extractJson(text) {
  const s = String(text || "").trim();
  const attempts = [];
  if (s.startsWith("{") && s.endsWith("}")) attempts.push(s);
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) attempts.push(fenced[1].trim());
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a >= 0 && b > a) attempts.push(s.slice(a,b+1));

  for (const candidate of attempts) {
    try {
      const x = JSON.parse(candidate);
      if (x && typeof x === "object") return x;
    } catch {}
  }
  return null;
}

async function checkRateLimit(env, ip) {
  const raw = String(env.COUNCIL_RATE_LIMIT || DEFAULT_RATE_LIMIT);
  const [maxStr, windowStr] = raw.split(":");
  const max = Number(maxStr), windowSec = Number(windowStr);
  if (!max || !windowSec || !env.council_kv || !ip) return { ok:true };

  const key = `rl:${ip}`;
  const current = Number((await env.council_kv.get(key)) || 0);
  if (current >= max) {
    return { ok:false, message:`開會太頻繁了，${Math.round(windowSec/60)} 分鐘內最多 ${max} 次，先讓工程師 AI 喘口氣 😅` };
  }
  await env.council_kv.put(key, String(current+1), { expirationTtl:windowSec });
  return { ok:true };
}

export async function onRequestPost(context) {
  try {
    const { request, env } = context;

    if (String(env.COUNCIL_ENABLED || "true").toLowerCase() === "false") {
      return out({ error:"AI 圓桌目前休會中 🛑" }, 503);
    }
    if (!env.AI) return out({ error:"尚未設定 Cloudflare AI Binding（Variable name: AI）" }, 500);

    const ip = request.headers.get("cf-connecting-ip") || "";
    const rl = await checkRateLimit(env, ip);
    if (!rl.ok) return out({ error:rl.message }, 429);

    const body = await request.json().catch(() => null);
    const q = String(body?.question || "").trim();
    if (!q) return out({ error:"沒有收到任務說明" }, 400);
    if (q.length > MAX_Q) return out({ error:"任務說明太長" }, 400);

    const files = normalizeFiles(body?.files);
    const images = Array.isArray(body?.images) ? body.images.slice(0,MAX_IMAGES) : [];

    const webSearchRequested = body?.webSearch === true;
    const search = webSearchRequested
      ? await searchWeb(env, q)
      : { ok:true, used:false, reason:"disabled_by_user", message:"Web Search 已關閉", text:"", resultCount:0 };

    const imageReports = [];
    for (const image of images) {
      imageReports.push(await analyzeImage(env.AI, image));
    }

    const projectContext = buildProjectContext(files, imageReports);
    const searchNote = search.used && search.text
      ? `\n\n【Web Search 資料】\n${search.text}`
      : "";

    const engineerPrompt = `使用者任務：
${q}

${projectContext || "（本題沒有上傳文字檔或圖片）"}
${searchNote}

你是主工程師。請：
1. 先確認問題與專案結構，不要亂猜沒看到的檔案。
2. 找出最可能根因。
3. 提出最小必要修改，不要無故重構。
4. 若能從已提供檔案直接修，請明確列出每個要改的檔案與修改內容。
5. 注意相容性、安全性、部署環境與現有功能不要被破壞。
6. 如果資料不足，明確寫出缺什麼。`;

    const a = await ask(env.AI, MODEL_A, [
      { role:"system", content:"你是資深全端工程師，擅長 HTML/JS/Cloudflare/Vercel、除錯、版本整合。用繁體中文，精準務實。" },
      { role:"user", content:engineerPrompt },
    ], 1700, 0.25);

    const reviewPrompt = `【原始任務】
${q}

【專案上下文】
${projectContext || "（無附件）"}
${searchNote}

【主工程師 A 的方案】
${a}

你是 Code Reviewer。請逐項檢查：
- 根因是否有證據
- 是否漏改相依檔案
- 是否可能破壞既有功能
- 是否有部署 / API / 安全 / 大小限制問題
- 修改是否能更小、更穩
最後給出「必修 / 建議 / 不要改」三區。`;

    const b = await ask(env.AI, MODEL_B, [
      { role:"system", content:"你是嚴格但務實的軟體 Code Reviewer。用繁體中文，不為反對而反對。" },
      { role:"user", content:reviewPrompt },
    ], 1500, 0.25);

    const finalPrompt = `你現在是最終整合工程師。

【任務】
${q}

【可用專案檔案】
${projectContext || "（無附件）"}

【A 主工程師】
${a}

【B Reviewer】
${b}

請整合成可執行結果。若你有把握修改上傳的文字檔，請輸出「完整檔案內容」，不要只給 diff。

你的回覆必須是單一 JSON，不能有 markdown code fence，格式：
{
  "summary": "簡短結論",
  "rootCause": "根因；若不確定要寫不確定",
  "review": ["核對重點1","核對重點2"],
  "instructions": ["使用者接下來要做的事"],
  "files": [
    {"path":"必須與上傳檔案 path 相同，或是合理的新檔路徑","content":"完整檔案內容"}
  ]
}

規則：
- 只修改必要檔案。
- 不確定的檔案不要生成。
- files 可為空陣列。
- 不得省略檔案內容或用「其餘不變」。
- 不能把圖片當文字檔輸出。
- 不要把 API Key / Secret 寫入檔案。`;

    const finalRaw = await ask(env.AI, MODEL_A, [
      { role:"system", content:"你是軟體專案最終整合工程師。嚴格輸出有效 JSON。" },
      { role:"user", content:finalPrompt },
    ], 3000, 0.15);

    const artifact = extractJson(finalRaw);
    const finalText = artifact
      ? [artifact.summary, artifact.rootCause].filter(Boolean).join("\n\n")
      : finalRaw;

    return out({
      ok:true,
      version:VERSION,
      labels:{ a:"GPT-OSS 120B · 主工程師", b:"Qwen3 30B · Reviewer" },
      a, b,
      final:finalText,
      artifact,
      filesReceived:files.map(f=>({path:f.path,truncated:f.truncated})),
      imageReports,
      webSearchRequested,
      diagnostics: {
        hasTavilyKey: hasTavilySecret(env),
        environment: "runtime",
      },
      search:{
        ok:Boolean(search.ok), used:Boolean(search.used),
        reason:search.reason, message:search.message,
        resultCount:Number(search.resultCount||0),
        ...(search.detail ? {detail:search.detail} : {})
      }
    });
  } catch (e) {
    const s = String(e?.message || e || "");
    return out({
      diagnostics: {
        hasTavilyKey: hasTavilySecret(context?.env),
        environment: "runtime",
      },
      error:/neuron|quota|limit|exceeded|usage/i.test(s)
        ? "Cloudflare AI 額度可能已用完，今天先讓工程師下班 😂"
        : s || "AI 工程圓桌執行失敗"
    }, 500);
  }
}
