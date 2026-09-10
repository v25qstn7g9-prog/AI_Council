/**
 * debate.js — ai-council-v2.2-web-search
 *
 * POST /debate
 * body: { question: string }
 *
 * 流程固定三回合，不會無限互聊：
 *   0. （新增）用 Tavily 搜尋跟問題相關的網路資訊
 *   1. MODEL_A 初答（拿得到搜尋結果就會參考）
 *   2. MODEL_B 審查、挑錯、補充
 *   3. MODEL_A 統整出「共識 / 分歧 / 結論」
 *
 * 相較 v2.1 的差異：
 * - 新增 Tavily 網路搜尋，讓 AI 能參考即時資訊，不再只靠訓練時的舊知識
 * - 沒有設定 TAVILY_API_KEY 時會自動跳過搜尋，照舊只憑自身知識回答，不會壞掉
 */

const VERSION = "2.2-web-search";

const MODEL_A = "@cf/openai/gpt-oss-120b";
const MODEL_B = "@cf/qwen/qwen3-30b-a3b-fp8";

const MAX_Q = 1800;

// 速率限制預設值：每個 IP 在 30 分鐘內最多開會 10 次。
// 想改就在 Cloudflare 設環境變數 COUNCIL_RATE_LIMIT，格式 "次數:秒數"，
// 例如 "5:3600" = 每小時 5 次。設成 "0:0" 等於關閉限制。
const DEFAULT_RATE_LIMIT = "10:1800";

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

async function ask(ai, model, messages, maxTokens = 650) {
  const r = await ai.run(model, { messages, max_tokens: maxTokens, temperature: 0.55 });
  const t = txt(r);
  if (!t) throw new Error(model + " 沒有回傳文字");
  return t;
}

/**
 * 用 Tavily 搜尋跟問題相關的網路資訊。
 * 沒有設定 TAVILY_API_KEY 就直接回傳空字串，讓 AI 照舊只憑自身知識回答，
 * 這樣就算沒申請 key，這個功能也不會讓整個服務壞掉。
 */
async function searchWeb(env, query) {
  // Secrets Store 綁定的變數是一個物件，要用 .get() 非同步取值；
  // 一般環境變數則直接是字串。兩種情況都相容。
  let apiKey = env.TAVILY_API_KEY;
  if (apiKey && typeof apiKey.get === "function") {
    apiKey = await apiKey.get();
  }
  if (!apiKey) return "";

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

    if (!r.ok) return "";

    const data = await r.json().catch(() => null);
    const results = Array.isArray(data?.results) ? data.results : [];
    if (results.length === 0) return "";

    // 整理成簡短的條列格式，附上來源網址，方便 AI 引用、也方便使用者查證
    return results
      .slice(0, 5)
      .map((item, i) => `${i + 1}. ${item.title || "（無標題）"}\n${item.content || ""}\n來源：${item.url || ""}`)
      .join("\n\n");
  } catch {
    // 搜尋失敗（額度用完、網路問題等）就靜默放棄，讓圓桌照常進行
    return "";
  }
}

/**
 * 速率限制。用 council_kv 記每個 IP 的呼叫次數，時間窗過了就自動過期。
 * 沒有綁 KV 的話會安全退化成「不限制」，不會讓整個 API 掛掉。
 */
async function checkRateLimit(env, ip) {
  const raw = String(env.COUNCIL_RATE_LIMIT || DEFAULT_RATE_LIMIT);
  const [maxStr, windowStr] = raw.split(":");
  const max = Number(maxStr);
  const windowSec = Number(windowStr);

  if (!max || !windowSec) return { ok: true };      // 設定為 0 表示不限制
  if (!env.council_kv) return { ok: true };          // 沒綁 KV 就不限制
  if (!ip) return { ok: true };

  const key = `rl:${ip}`;
  const current = Number((await env.council_kv.get(key)) || 0);

  if (current >= max) {
    return {
      ok: false,
      message: `開會太頻繁了，${Math.round(windowSec / 60)} 分鐘內最多 ${max} 次，先讓 AI 喘口氣 😅`,
    };
  }

  // expirationTtl 讓這筆記錄在時間窗結束後自己消失，不用另外清理。
  await env.council_kv.put(key, String(current + 1), { expirationTtl: windowSec });
  return { ok: true };
}

export async function onRequestPost(context) {
  try {
    const { request, env } = context;

    // 總開關：環境變數 COUNCIL_ENABLED 設成 "false" 就整個停用（例如額度快用完時）
    if (String(env.COUNCIL_ENABLED || "true").toLowerCase() === "false") {
      return out({ error: "AI 圓桌目前休會中 🛑" }, 503);
    }

    const ai = env.AI;
    if (!ai) return out({ error: "尚未設定 Cloudflare AI Binding（Variable name: AI）" }, 500);

    const ip = request.headers.get("cf-connecting-ip") || "";
    const rl = await checkRateLimit(env, ip);
    if (!rl.ok) return out({ error: rl.message }, 429);

    const body = await request.json().catch(() => null);
    const q = String(body?.question || "").trim();
    if (!q) return out({ error: "沒有收到問題" }, 400);
    if (q.length > MAX_Q) return out({ error: "問題太長" }, 400);

    // 第 0 回合：搜尋網路資訊（沒設 key 就跳過，searchResults 會是空字串）
    const searchResults = await searchWeb(env, q);
    const searchNote = searchResults
      ? `\n\n以下是搜尋到的網路資訊，可以參考但要自己判斷可信度，並在回答中註明是參考網路資料：\n${searchResults}`
      : "";

    // 第一回合：A 先給出主分析
    const a = await ask(ai, MODEL_A, [
      {
        role: "system",
        content:
          "你是AI圓桌主分析師。用繁體中文直接回答，區分事實、推論與不確定性，不知道就說不知道。",
      },
      { role: "user", content: q + searchNote },
    ]);

    // 第二回合：B 挑錯、補漏
    const b = await ask(ai, MODEL_B, [
      {
        role: "system",
        content:
          "你是AI圓桌反方審查員。用繁體中文。找出另一位分析師的盲點、錯誤假設與遺漏，但不要為反對而反對。",
      },
      {
        role: "user",
        content: `原始問題：\n${q}${searchNote}\n\nAI A：\n${a}\n\n請審查並提出你的版本。`,
      },
    ]);

    // 第三回合：A 當主持人統整
    const final = await ask(
      ai,
      MODEL_A,
      [
        {
          role: "system",
          content:
            "你是AI圓桌主持人。用繁體中文，依序輸出：共識、分歧、最後結論。資訊不足要明說。",
        },
        { role: "user", content: `原始問題：\n${q}\n\nAI A：\n${a}\n\nAI B：\n${b}` },
      ],
      750
    );

    return out({
      ok: true,
      version: VERSION,
      a,
      b,
      final,
      searched: Boolean(searchResults),
      labels: { a: "GPT-OSS 120B", b: "Qwen3 30B" },
    });
  } catch (e) {
    const s = String(e?.message || e || "");
    return out(
      {
        error: /neuron|quota|limit|exceeded|usage/i.test(s)
          ? "Cloudflare AI 額度可能已用完，今天先散會 😂"
          : s || "AI 圓桌執行失敗",
      },
      500
    );
  }
}
