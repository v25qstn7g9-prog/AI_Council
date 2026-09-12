# AI 圓桌 v3.9.0｜Cloudflare 自動切 Gemini 3.5 備援版

這版不是單純「兩個 AI 聊天」，而是把圓桌改成軟體工程工作流。

## 可以做什麼

- 上傳 HTML / JS / CSS / JSON / MD / TXT / XML / YAML / CSV
- 上傳 ZIP 專案：瀏覽器端解壓並讀取可分析的文字檔
- 上傳 PNG / JPG / WEBP 截圖
- 可選 Web Search（Tavily）
- AI A：主工程師
- AI B：Code Reviewer
- AI A：最終整合
- 若最終模型能安全產生完整檔案內容，前端可直接下載「修正版 ZIP」

## 圖片

圖片使用 Cloudflare Workers AI：

`@cf/meta/llama-3.2-11b-vision-instruct`

第一次使用這個 Vision 模型前，Cloudflare 目前要求先接受 Meta License。請依 Cloudflare 官方說明完成一次 `prompt: "agree"`。

圖片會先被 Vision 模型轉成「UI / 錯誤畫面分析」，再交給兩個工程 AI；不會要求文字模型自己假裝看圖。

## AI A / B：Gemini 3.5 Flash-Lite 自動備援

v3.7 在可插拔 Provider 上再加入「Cloudflare → Gemini 3.5 Flash-Lite」自動備援。預設仍使用 Cloudflare；當 AI A 或 AI B 的 Cloudflare 呼叫失敗時，如果已設定 GEMINI_API_KEY，會自動切到 Gemini 3.5 Flash-Lite。若 Gemini 也失敗，才回報雙重錯誤。若手動把 Provider 設成 Gemini，則維持原本 Gemini → Cloudflare 備援。

設定 Gemini Key（只有把 Provider 切到 Gemini 才需要）：

```bash
wrangler secret put GEMINI_API_KEY
```

### 未來切換 ChatGPT / Claude

預設不用改，維持免費的 Cloudflare AI。若日後要使用 OpenAI / Claude API，可設定：

```bash
wrangler secret put OPENAI_API_KEY
wrangler secret put ANTHROPIC_API_KEY
```

並在 `wrangler.jsonc` 的 `vars` 加入：

```jsonc
"COUNCIL_A_PROVIDER": "openai",
"COUNCIL_B_PROVIDER": "anthropic"
```

可選模型：`OPENAI_MODEL`、`ANTHROPIC_MODEL`。沒有設定時使用程式內預設值。ChatGPT / Claude 的 App 訂閱與 API 計費是分開的；本版不會因為升級自動產生 API 費用。

AI B Reviewer 仍使用 Cloudflare `@cf/qwen/qwen3-30b-a3b-fp8`。由於該模型 context window 為 32,768 tokens，v3.5 會只給 Reviewer 一個受控的專用上下文預算，避免大型專案把 Reviewer 的 context 撐爆。

## Web Search

需要最新 API / 官方文件時才打開 Web Search。

設定：

```bash
wrangler secret put TAVILY_API_KEY
```

未設定 Key 時，工程圓桌仍可以正常使用，只是沒有網路搜尋。

## 附件限制（v3.0）

為避免一次把 Workers AI context 塞爆：

- 文字檔最多 30 個
- 單一文字檔最多送 30,000 字元
- 全部文字附件合計最多 180,000 字元
- 圖片最多 4 張
- 單張圖片前端限制 5 MB（上傳前會自動壓縮縮圖到長邊 2048px、JPEG 85% 品質再送出）

大專案建議只上傳和問題相關的檔案，或先打包精簡版。

## ZIP 實作

前端使用 JSZip CDN 解壓 / 重新打包：

`https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js`

如果你的環境禁止外部 CDN，請改成把 JSZip 檔案自架到 `public/`。


## 正式版 Web Search 驗證規則

v3.5 將網路搜尋結果分成三層，避免「查得到」卻把推測講成事實：

- **已證實**：有附件或 Web Search 來源直接支持。
- **推測**：由已知事實推導出的合理解讀。
- **待驗證**：來源不足、資料過舊、彼此衝突，或只是建議下一步查詢的項目。

Reviewer 會特別檢查：

- 日期是否對得上
- 數字是否對得上
- 是否把上漲誤寫成下跌
- 是否把「建議再查」誤當成「已證實」
- 來源彼此是否衝突

最終整合會優先顯示已證實因素，並保留實際搜尋來源名稱或 URL 供核對。

## 部署

原本 Cloudflare Workers with Static Assets 架構維持不變：

```bash
wrangler deploy
```

## 版本

- v3.9.0：
  - **新增自我健檢功能**：排程（每週）自動審查專案自己的原始碼，找到問題就開 GitHub Pull Request，
    沒問題就開一張 Issue 留報告——兩者都**不會自動 merge／關閉**，一定要人工看過才會真的生效。
    也可以用 `POST /self-review`（需帶 `SELF_REVIEW_TOKEN`）手動立刻跑一次，不用等排程。
  - 前端會顯示「哪些附件被截斷」的警示，Reviewer 因專案過大只審查部分內容時也會提示
  - 修正備援標籤文字容易誤讀的問題（原本寫法會讓人誤以為是該 provider 自己的備援，其實是改用 Cloudflare）
  - 修正一處提示文字多出的分號錯字；檔案選擇視窗補上 .jsonc / .env
- v3.8.1：前後端版本號全面對齊，強化 Gemini 3.5 備援與 JSON 容錯
- v3.7：Cloudflare 失敗時自動切換 Gemini 3.5 Flash-Lite，A / B 皆支援；保留原本可插拔 Provider 與反向備援
- v3.6：可插拔 AI Provider 正式版
- v3.5：Gemini 主工程師 + Reviewer context budget + 最終完整檔案輸出上限提升 + 不可信附件/搜尋內容隔離 + 文件版本同步
- v3.1：Web Search 已證實／推測／待驗證分流 + Reviewer 來源核實
- v3.0：工程協作、檔案 / ZIP / 圖片、Code Review、修正版 ZIP
- v2.2：Tavily Web Search
- v2.1：Workers with Static Assets 基礎架構

## Workers AI 用量儀表 API

此版本新增 `GET /usage`，直接透過 Cloudflare GraphQL Analytics 查詢當天（UTC 00:00 起）的 Workers AI Neurons 使用量。

請在 Worker 設定：
- Secret：`CLOUDFLARE_ANALYTICS_TOKEN`（Account Analytics → Read）
- Variable：`CLOUDFLARE_ACCOUNT_ID`（Cloudflare Account ID）

開啟 `https://你的-worker.workers.dev/usage` 可看到 JSON：今日額度、已使用 Neurons、剩餘 Neurons、使用率與下一次重置時間。

## 自我健檢（AI 圓桌審查自己的原始碼）

這個功能讓 AI 圓桌定期（或手動）拿自己的原始碼當「案子」，跑一次跟平常一樣的 A 主工程師 → B Reviewer → 最終整合流程，把結果做成 GitHub Pull Request 或 Issue。

**設計上刻意不做成全自動升級**：

- 找到問題／可以改善的地方 → 開一個新分支、提出修改、開 **Pull Request** 到你設定的 base branch（例如 `main`）。
- 沒有找到值得改的地方 → 開一張 **Issue**，留下健檢報告，不會硬找東西改。
- 兩種情況都**不會自動 merge PR，也不會自動關閉 Issue**。要不要真的採用，永遠是你自己看過、自己按下去決定的。
- 只審查固定白名單裡的檔案（`src/*.js`、`public/index.html`、`wrangler.jsonc`、`README.md`），不會自己亂猜或亂讀白名單以外的東西。

### 設定步驟

1. 到 GitHub 建立一個 Personal Access Token（Fine-grained token 即可），範圍只給這個 repo，權限至少要有：
   - Contents：Read and write
   - Pull requests：Read and write
   - Issues：Read and write
2. 設定 Secrets 與 Variables：

   ```bash
   wrangler secret put GITHUB_TOKEN
   wrangler secret put SELF_REVIEW_TOKEN   # 自己隨便設一組密碼，手動觸發時要用
   ```

   並在 `wrangler.jsonc` 的 `vars` 填上 `GITHUB_OWNER`、`GITHUB_REPO`、`GITHUB_BASE_BRANCH`（通常是 `main`）。

3. 排程預設是每週一 03:00 UTC（台灣時間週一 11:00），要改頻率就改 `wrangler.jsonc` 裡 `triggers.crons` 的 cron 字串。

### 手動立刻跑一次（不用等排程）

因為這個動作會消耗 AI 額度、還會在你的 GitHub repo 開 PR/Issue，所以**沒有**做成公開頁面上一按就跑的按鈕，只能帶著你自己設定的 `SELF_REVIEW_TOKEN` 用指令觸發：

```bash
curl -X POST "https://你的-worker.workers.dev/self-review" \
  -H "x-self-review-token: 你設定的SELF_REVIEW_TOKEN"
```

沒有設定 `SELF_REVIEW_TOKEN` 的話，這個手動端點會直接回報「已停用」，但排程仍會照常執行（`GITHUB_TOKEN` 等設定要有才跑得動）。
