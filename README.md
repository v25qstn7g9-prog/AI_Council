# AI 圓桌 v3.0｜工程協作版

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

## 部署

原本 Cloudflare Workers with Static Assets 架構維持不變：

```bash
wrangler deploy
```

## 版本

- v3.0.1：Tavily Secret runtime 診斷
- v3.0：工程協作、檔案 / ZIP / 圖片、Code Review、修正版 ZIP
- v2.2：Tavily Web Search
- v2.1：Workers with Static Assets 基礎架構

## v3.0.1 Tavily Secret 診斷

本版新增一個安全診斷欄位：

```text
hasTavilyKey: true / false
```

它只判斷 Worker runtime 是否讀得到 `TAVILY_API_KEY`，**不會回傳 Secret 值本身**。

判讀方式：

- `true`：Worker 已讀到 Secret。若 Web Search 仍失敗，就往 Tavily Key 驗證、額度或網路呼叫查。
- `false`：Worker runtime 沒讀到 Secret。優先檢查 Cloudflare production environment / deployment / Secret 綁定。

前端 Web Search 區塊也會直接顯示：

```text
✅ Worker 讀得到 TAVILY_API_KEY
```

或：

```text
❌ Worker 讀不到 TAVILY_API_KEY
```
