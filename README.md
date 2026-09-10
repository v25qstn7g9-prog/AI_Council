# AI 圓桌 v2.1

兩隻 Cloudflare Workers AI 模型互相審查，最後統整出結論。

## 架構

```text
ai-council/
├─ src/
│  ├─ worker.js          # Worker 入口與路由
│  └─ debate.js          # 三回合 AI 圓桌 + 限流
├─ public/
│  └─ index.html         # 前端靜態頁面
├─ wrangler.jsonc        # Cloudflare 設定
├─ README.md
└─ .gitignore
```

v2.1 已完全移除舊的 Pages Functions `functions/` 結構：
- `main` → `src/worker.js`
- Static Assets → `./public`
- `/debate` → `src/worker.js` 路由到 `src/debate.js`
- 其他網址 → `env.ASSETS.fetch(request)`

## 圓桌規則

每題固定三回合：
1. GPT-OSS 120B：主分析
2. Qwen3 30B：挑錯、補漏
3. GPT-OSS 120B：統整「共識 / 分歧 / 結論」

每題共 3 次 AI 推論，不會無限互聊。

## 模型

| 角色 | 模型 | 呼叫次數 |
|---|---|---:|
| A 主分析 + 主持 | `@cf/openai/gpt-oss-120b` | 2 |
| B 反方審查 | `@cf/qwen/qwen3-30b-a3b-fp8` | 1 |

## 部署

### 1. 建立 KV namespace

```bash
wrangler kv namespace create "council_kv"
```

把 Cloudflare 回傳的 ID 填進 `wrangler.jsonc`：

```jsonc
"kv_namespaces": [
  { "binding": "council_kv", "id": "你的 KV namespace id" }
]
```

### 2. AI Binding

`wrangler.jsonc` 已設定：

```jsonc
"ai": { "binding": "AI" }
```

### 3. 部署

```bash
wrangler deploy
```

也可以把整個專案放到 GitHub，再由 Cloudflare Workers 連接 Git 自動部署。

## 環境變數

| 變數 | 預設 | 說明 |
|---|---|---|
| `COUNCIL_RATE_LIMIT` | `10:1800` | 每 IP 30 分鐘最多 10 題；`0:0` 關閉 |
| `COUNCIL_ENABLED` | `true` | 設成 `false` 可立即休會 |

## 額度保護

1. 固定三回合，不會無限對話。
2. KV 依 IP 限制題數。
3. `COUNCIL_ENABLED=false` 可立即停用 AI。
4. 額度相關錯誤會轉成較易懂的中文訊息。

## 版本

- **v2.1** — 改成乾淨的 `src/ + public/` Workers 架構
- **v2.0** — Workers with Static Assets + KV 限流
- **v1.0** — Pages Functions 初版
