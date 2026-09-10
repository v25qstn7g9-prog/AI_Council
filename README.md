# AI 圓桌 v3.7｜Cloudflare 自動切 Gemini 3.5 備援版

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

可選模型：`OPENAI_MODEL`、`ANTHROPIC_MODEL`。沒有設定時使用程式內預設值。ChatGPT / Claude 的 App 訂閱與 API 計費是分開的；本版不會因為升級 v3.6 自動產生 API 費用。

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
- 單張圖片前端限制約 2.5 MB

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

- v3.7：Cloudflare 失敗時自動切換 Gemini 3.5 Flash-Lite，A / B 皆支援；保留原本可插拔 Provider 與反向備援
- v3.6：可插拔 AI Provider 正式版
- v3.5：Gemini 主工程師 + Reviewer context budget + 最終完整檔案輸出上限提升 + 不可信附件/搜尋內容隔離 + 文件版本同步
- v3.1：Web Search 已證實／推測／待驗證分流 + Reviewer 來源核實
- v3.0：工程協作、檔案 / ZIP / 圖片、Code Review、修正版 ZIP
- v2.2：Tavily Web Search
- v2.1：Workers with Static Assets 基礎架構
