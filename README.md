# AI 圓桌 v4.5.3｜Reliable Batch Audit

這版不是單純「兩個 AI 聊天」，而是把圓桌改成軟體工程工作流。

## v4.5.3：Reliable Batch Audit

修正 Full Repo Audit 出現 0% Coverage、所有批次均逾時的問題。批次目標由 280,000 降為 80,000 字元，改為單批依序執行以避免並發壓力；每批先用較快的 Reviewer 模型，30 秒內失敗則切換主模型。批次失敗時，報告會區分逾時、額度／速率限制與模型服務未回應，不再只顯示模糊的「失敗或逾時」。

## v4.5.2：Mandatory Engineering Report

GitHub 工程模式只要進入修改流程，不論任務是否包含「報告」關鍵字，都強制回傳一份依實際結果組裝的工程察核報告。新增「察核／查核／稽核／審核」語意辨識；修改流程不再要求模型同時輸出長篇報告與完整檔案，避免檔案或報告被截斷，最終報告統一由後端依掃描範圍、Gate、變更與 PR 結果建立。

## v4.5.1：Guaranteed Report Delivery

補齊「檢查＋修正＋建立 Draft PR」路徑：AI 最終整合若沒有填入 `artifact.report`，後端會依實際掃描檔案、修正結果、驗證 Gate 與 PR 資訊建立確定性工程報告。前端只有在本題確實要求報告時才顯示缺報告診斷，普通修正任務不再誤報紅色錯誤。

## v4.5.0：Guaranteed Audit Delivery

修正報告下載只有「後端沒有回傳可用的 Audit Report」的問題。Full Repo Audit 的批次審查改為受控雙工並行；Primary Evidence Synthesis 未達門檻時，不再把同一份證據送給同一模型重試，而是由本地確定性程序立即組裝 Coverage、未審查檔案與完整批次證據附錄。前端也不再把空字串偽造成可下載報告。


## v4.4.0：Single-pass Evidence Synthesis

Full Repo Audit 完成逐批完整檔案審查後，最終報告改為直接由 Evidence Synthesizer 整合，不再重跑完整 A/B + Report pipeline。報告完整度改採章節結構門檻，而非單純 1200 字長度門檻，並回傳 synthesis section/length diagnostics。前端仍不得自行拼接 A/B 成正式報告。
## v4.4.0：Deterministic Rescue Audit

修正 v4.2 Rescue 仍遞迴進入同一套 A/B + Report pipeline 的問題。當 Primary Report 未達完整度門檻時，現在直接呼叫專用 Evidence Rescue Synthesizer，只使用 Full Repo manifest 與完整檔案 batch findings 合成報告，不再重新跑 A/B。Rescue 也禁止在沒有 runtime/deploy/test 證據時宣稱「運作良好／已實測／部署成功」。Primary 與 Rescue 都失敗時，明確標記 Audit 未完成，不輸出確定性結論。

## v4.2.0：Evidence Rescue Audit

Audit 模式新增硬性截斷證據規則：Reviewer context 出現 [TRUNCATED] 只代表審查副本受 context budget 限制，不能推論 GitHub 原始檔損壞、Syntax Error、無法編譯或 Must Fix。最終報告生成失敗時，不再把互相矛盾的 A/B 原文包裝成成功 Audit Report；Full Repo 流程會以完整批次證據進行一次 Rescue Synthesis，仍失敗則明確標記 Audit 未完成，不允許據此修改程式。

## v4.1.0：Verified Fix Pipeline

修改模式新增 Fix Direction Gate：先由 AI A 根據完整相關原始碼提出根因、原設計意圖、最多三個方案、scopeFiles 與 successCriteria，再由 AI B 以反方 Reviewer 檢查錯誤假設、副作用與回歸風險。只有高信心且 Reviewer 未否決的方向才能進入實作。實作後再經 Mechanical Fix Gate（限制 scope、保留既有函式、阻擋過大改寫與截斷內容）及 Before/After Regression Review；任一 Gate 不通過即停止，不建立 PR。

## v4.0.0：Batch Full Repo Audit

大型 GitHub repository 的審查不再把整個專案一次塞進單一 context。GitHub 工程模式會先建立完整 readable-file 清單，依 runtime/routing、AI、domain data、frontend、tests、build/docs 等群組自動分批；每個檔案只會以完整內容進入一個 batch，不切半。每批由 AI A / AI B 產生局部證據，再以批次結果與 Coverage Manifest 進行最終整合。

最終 artifact 會附帶 `coverage`、`batchCount`、`reviewedFiles`、`skippedFiles`。Audit Coverage 以「完整審查的 readable files / repository 可讀檔案」計算；任何因 file limit、repo budget、單檔過大、讀取失敗或 batch 上限而未審查的檔案都會明列，不能再被默認為已檢查。v3.14.1 的 Evidence Gate 繼續保留。

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
- 單張圖片前端限制 2.5 MB（目前不自動縮圖；超過請先壓縮）

大專案建議只上傳和問題相關的檔案，或先打包精簡版。

## ZIP 實作

前端使用 JSZip CDN 解壓 / 重新打包：

`https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js`

如果你的環境禁止外部 CDN，請改成把 JSZip 檔案自架到 `public/`。


## 正式版 Web Search 驗證規則

v3.5 將網路搜尋結果分成三層，避免「查得到」卻把推測講成事實：

- **已證實**：有附件或 Web Search 來源直接支持。
- **推測**：由已知事實推導出的合理解讀。
- **待驗證**：來源不足、資料過舊、彼此衝突，或則是建議下一步查詢的項目。

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

- v3.14.1：Evidence-Gated Audit：新增完整檔案證據清單；AI A/B 意見不再視為獨立證據。Syntax Error、檔案中斷、缺少結尾、無法編譯/部署等高嚴重度結論，只有在完整檔案直接支持時才能列為已證實，否則自動要求降級為待驗證；並禁止報告虛構「人工查閱／人工確認／實際部署」。

- v3.14.0：Complete Source Audit：修正 v3.13 仍沿用舊版 120k/24k analysis-only 隱藏 context 限制的問題。GitHub 完整檔案、normalizeFiles 與 AI A 主審查統一為單檔 120,000 / 總計 360,000 字元；不再把 GitHub 已完整取得的核心檔案在進入主審查前二次截斷。AI B 仍保留獨立 Reviewer context budget，作為第二視角而非假裝完整讀取。

- v3.13.0：Full Repo Audit 第一階段：GitHub 審查讀取上限提升至 30 檔、單檔 60,000 字元、總計 240,000 字元；後端分析同步提升單檔與總 context 預算，降低核心原始碼被過早標記 `[TRUNCATED]` 的情況。Reviewer 仍保留獨立 context budget，避免超出模型 context window；報告必須如實標示任何仍未完整讀取的檔案。

- v3.12.0：強化 GitHub 工程 Audit Report：報告完整度驗證、自動重試與 fallback、GitHub 模式顯示使用者送出文字、180 秒工程等待時間、完整 Markdown 報告下載，以及 iOS 單一檔案下載修正。

- v3.11.0：新增 GitHub 工程模式：可直接讀取授權 repository，由 AI A / AI B 討論與產生最小修改，建立獨立 branch 與 Draft Pull Request。


- v3.10.1：
  - Self-Review 強化：GitHub PR 僅允許固定白名單檔案、手動觸發只接受 Header Token，並加入獨立頻率限制。
  - 修正版 ZIP Rescue 設定最多逐檔救援 5 個檔案，避免大型專案在輸出異常時放大 AI 額度消耗。
  - Cloudflare compatibility date 更新至 2026-09-18。
- v3.10.0：
  - Web Search 仍由畫面上的開關控制；需要最新 API / 官方文件時手動打開即可。
  - **閒聊模式現在也能用 Web Search 了**：之前閒聊模式完全不會查網路，現在只要開關有開（或被自動觸發），
    閒聊時也會先查一輪資料再接話，兩隻 AI 聊天時也能聊到最新的事。
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


## 🐙 GitHub 工程模式

v3.11 起，AI 圓桌可以直接讀取你授權的 GitHub repository，讓 AI A 主工程師與 AI B Reviewer 以 **GitHub branch 上的實際原始碼**進行討論與修改。

### 使用方式

1. 設定 GitHub Fine-grained Personal Access Token（建議只授權需要操作的 repositories）。
2. Repository permissions 至少：
   - **Contents：Read and write**
   - **Pull requests：Read and write**
   - **Metadata：Read**
3. 設定：
   ```bash
   wrangler secret put GITHUB_TOKEN
   ```
4. `wrangler.jsonc`：
   - `GITHUB_OWNER`：GitHub 帳號
   - `GITHUB_ALLOWED_REPOS`：可填 `*` 使用 Token 本身可存取的 repository，或以逗號列出白名單。
5. 開啟畫面的「🐙 GitHub 工程模式」，選 repository 與 base branch，直接輸入工程任務。

### 寫入安全設計

GitHub 工程模式**不直接修改 main**：

```
讀取 base branch
    ↓
AI A 主工程師
    ↓
AI B Reviewer
    ↓
Final Integrator
    ↓
安全驗證修改檔案
    ↓
建立 ai-council/* branch
    ↓
commit
    ↓
建立 Draft Pull Request
    ↓
人工審核 / 測試 / Merge
```

目前禁止 AI 寫入：
- `.env` / secrets
- `.github/workflows/`
- `node_modules/`、`dist/`、`build/`
- 其他被列入保護清單的路徑

AI 只會提交與原始 snapshot 不同、且通過路徑驗證的完整檔案內容。GitHub Token 永遠只存在 Worker Secret，不會送進 AI prompt。

GitHub REST API 的 branch、Git tree/blob 與 Pull Request 流程均採官方 API；Pull Request 預設建立為 Draft，不會自動 Merge。

### Rate Limit

GitHub REST API 有主要與 secondary rate limits，因此工程模式讀取檔案採受控數量與串行請求，避免短時間大量 API 呼叫。

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
