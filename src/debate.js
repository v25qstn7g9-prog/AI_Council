/**
 * debate.js — ai-council-v3.3-chat-history
 *
 * POST /debate
 * body:
 * {
 *   question: string,
 *   webSearch?: boolean,
 *   files?: [{ path, content, size }],
 *   images?: [{ name, dataUrl }],
 *   chatMode?: boolean,           // true = 輕量閒聊模式，跳過工程審查流程，回覆更快更短
 *   history?: [{who,text}]        // 閒聊模式用：之前聊過的內容，讓 AI 記得上下文
 * }
 *
 * 工程協作流程（chatMode 為 false 或未帶時）：
 * 0. 可選 Web Search
 * 0.5 圖片交給 Vision 模型分析 UI / 錯誤畫面
 * 1. AI A = 主工程師：理解專案、提出修法與候選修改
 * 2. AI B = Code Reviewer：找錯、找漏、檢查風險
 * 3. AI A = 整合工程師：輸出最終結論 + 可下載的完整檔案替換內容
 *
 * 閒聊流程（chatMode 為 true 時）：
 * 1. AI A 先回應（會參考 history）
 * 2. AI B 自然接話（可補充、可有不同意見，也會參考 history）
 * 不做總結收尾，不處理檔案、不要求 JSON、token 上限低很多，速度快上不少。
 *
 * v3.4 更新：AI A（主 AI）改用 Gemini 2.5（走 Google API，不吃 Cloudflare AI 額度），
 * AI B 繼續留在 Cloudflare。若沒設定 GEMINI_API_KEY 或呼叫失敗，
 * 自動退回 Cloudflare 的 MODEL_A_FALLBACK，不會讓功能壞掉。
 */

const VERSION = "3.4-gemini-main";
const GEMINI_MODEL = "gemini-2.5-flash-lite"; // 想換更強的模型可改這行，例如 "gemini-2.5-flash"
const MODEL_A_FALLBACK = "@cf/openai/gpt-oss-120b"; // Gemini 沒設定或失敗時的備援
const MODEL_B = "@cf/qwen/qwen3-30b-a3b-fp8";
const VISION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";

const MAX_Q = 4000;
const MAX_FILES = 30;
const MAX_FILE_CHARS = 30000;
const MAX_TOTAL_FILE_CHARS = 180000;
const MAX_IMAGES = 4;
const DEFAULT_RATE_LIMIT = "8:1800";

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

/**
 * 讀取 GEMINI_API_KEY，相容一般環境變數跟 Secrets Store 兩種綁定方式
 * （Secrets Store 綁定的變數要用 .get() 非同步取值）。
 */
async function getGeminiKey(env) {
  let apiKey = env.GEMINI_API_KEY;
  try {
    if (apiKey && typeof apiKey.get === "function") apiKey = await apiKey.get();
  } catch {
    return "";
  }
  return String(apiKey || "").trim();
}

/**
 * 呼叫 Gemini API。把 OpenAI 風格的 messages（system/user）轉成 Gemini 格式。
 */
async function askGemini(apiKey, messages, maxTokens = 1200, temperature = 0.35) {
  const systemMsg = messages.find(m => m.role === "system");
  const userParts = messages.filter(m => m.role !== "system").map(m => ({ text: m.content }));

  const body = {
    contents: [{ role: "user", parts: userParts }],
    generationConfig: { maxOutputTokens: maxTokens, temperature },
  };
  if (systemMsg) body.systemInstruction = { parts: [{ text: systemMsg.content }] };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!r.ok) {
    const errText = await r.text().catch(() => "");
    throw new Error(`Gemini HTTP ${r.status}: ${errText.slice(0, 200)}`);
  }

  const data = await r.json().catch(() => null);
  const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("").trim();
  if (!text) throw new Error("Gemini 沒有回傳文字");
  return text;
}

/**
 * AI A（主 AI）的統一入口：優先用 Gemini，沒設定 key 或呼叫失敗就自動退回
 * Cloudflare 的 MODEL_A_FALLBACK，確保功能不會因為 Gemini 出狀況而整個掛掉。
 */
async function askA(ai, env, messages, maxTokens = 1200, temperature = 0.35) {
  const apiKey = await getGeminiKey(env);
  if (apiKey) {
    try {
      const text = await askGemini(apiKey, messages, maxTokens, temperature);
      return { text, source: "Gemini 2.5" };
    } catch (e) {
      // Gemini 失敗就默默退回 Cloudflare，不中斷使用者的請求
    }
  }
  const text = await ask(ai, MODEL_A_FALLBACK, messages, maxTokens, temperature);
  return { text, source: "GPT-OSS 120B（Gemini 備援）" };
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
    const chatMode = body?.chatMode === true;

    // ============================================
    // 閒聊模式：不需要工程審查的重裝甲流程，
    // 直接讓兩隻 AI 輕量對話，回覆更短、更快。
    // 只有 A 回應、B 接話兩輪，不做總結收尾。
    // 支援多輪對話：history 是之前聊過的內容，讓 AI 記得上下文。
    // ============================================
    if (chatMode) {
      // history 格式：[{who:"you"|"a"|"b", text:"..."}]，只取最近幾輪避免 prompt 太長
      const rawHistory = Array.isArray(body?.history) ? body.history.slice(-12) : [];
      const historyText = rawHistory
        .map(h => {
          const label = h?.who === "you" ? "使用者" : h?.who === "a" ? "AI A" : h?.who === "b" ? "AI B" : "";
          return label ? `${label}：${String(h.text || "").slice(0, 800)}` : "";
        })
        .filter(Boolean)
        .join("\n");
      const historyBlock = historyText ? `\n\n【先前對話】\n${historyText}\n` : "";

      const aResult = await askA(env.AI, env, [
        { role:"system", content:"你是AI圓桌的其中一位成員，正在跟使用者與另一位AI進行連續對話。用繁體中文，自然聊天，記得先前對話內容，不用寫成報告格式，簡潔直接。" },
        { role:"user", content:`${historyBlock}\n使用者現在說：\n${q}` },
      ], 500, 0.6);
      const a = aResult.text;

      const b = await ask(env.AI, MODEL_B, [
        { role:"system", content:"你是AI圓桌的另一位成員，正在跟使用者與另一位AI進行連續對話。用繁體中文，記得先前對話內容，看過前一位的回答後自然接話：可以補充、可以有不同意見，像聊天一樣，不用寫成報告格式。" },
        { role:"user", content:`${historyBlock}\n使用者剛剛說：\n${q}\n\n對方（AI A）剛剛說：\n${a}\n\n換你接話。` },
      ], 500, 0.6);

      return out({
        ok:true,
        version:VERSION,
        chatMode:true,
        labels:{ a:aResult.source, b:"Qwen3 30B" },
        a, b,
      });
    }

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
6. 如果資料不足，明確寫出缺什麼。
7. 若本題使用 Web Search，必須把外部資訊分成：
   【已證實】有明確來源直接支持的事實；
   【推測】根據已知事實做出的合理推論；
   【待驗證】目前沒有足夠來源支持、還需要查證的說法。
8. 不得把「建議再查什麼」寫成「已經發生的原因」。
9. 涉及日期、價格、指數、公司公告、政策、財經事件等可變資訊時，必須優先使用搜尋結果中的具體日期與來源，不得用模型記憶補空白。
10. 若來源彼此衝突，要明確指出衝突，不可自行選一個當真。
11. 引用 Web Search 資料時，盡量保留來源名稱或 URL，讓使用者能核對。`;

    const aResult = await askA(env.AI, env, [
      { role:"system", content:"你是資深全端工程師，擅長 HTML/JS/Cloudflare/Vercel、除錯、版本整合。用繁體中文，精準務實。" },
      { role:"user", content:engineerPrompt },
    ], 1700, 0.25);
    const a = aResult.text;

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
- 若有 Web Search：每一個外部事實是否真的被來源支持
- 是否把「推測 / 待驗證」誤寫成「已證實」
- 是否存在日期不符、來源過舊、數字對不上、把上漲寫成下跌等問題
- 若來源不足，必須要求降級成「待驗證」，不可硬下結論
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
  "verified": ["已被附件或 Web Search 來源直接支持的事實"],
  "inferences": ["合理推測；若沒有就空陣列"],
  "pending": ["仍需驗證的事項；若沒有就空陣列"],
  "sources": ["來源名稱或 URL；若本題未用 Web Search 可空陣列"],
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
- 不要把 API Key / Secret 寫入檔案。
- 若有 Web Search，verified / inferences / pending 必須嚴格分流，不得混寫。
- sources 只列實際出現在搜尋資料裡的來源，不得捏造 URL。
- 外部資訊若沒有來源直接支持，就只能放 inferences 或 pending，不能放 verified。
- 「建議下一步查詢」不能被寫成已發生事實。
- 最終摘要要優先呈現已證實因素；推測與待驗證放後面。`;

    const finalResult = await askA(env.AI, env, [
      { role:"system", content:"你是軟體專案最終整合工程師。嚴格輸出有效 JSON。" },
      { role:"user", content:finalPrompt },
    ], 3000, 0.15);
    const finalRaw = finalResult.text;

    const artifact = extractJson(finalRaw);
    const finalText = artifact
      ? [artifact.summary, artifact.rootCause].filter(Boolean).join("\n\n")
      : finalRaw;

    return out({
      ok:true,
      version:VERSION,
      labels:{ a:`${aResult.source} · 主工程師`, b:"Qwen3 30B · Reviewer" },
      a, b,
      final:finalText,
      artifact,
      filesReceived:files.map(f=>({path:f.path,truncated:f.truncated})),
      imageReports,
      webSearchRequested,
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
      error:/neuron|quota|limit|exceeded|usage/i.test(s)
        ? "Cloudflare AI 額度可能已用完，今天先讓工程師下班 😂"
        : s || "AI 工程圓桌執行失敗"
    }, 500);
  }
}
