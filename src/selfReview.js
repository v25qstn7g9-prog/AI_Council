/**
 * selfReview.js — AI 圓桌自我健檢
 *
 * 讓 A（主工程師）/ B（Reviewer）/ 最終整合，定期（或手動）審查「AI 圓桌自己的原始碼」，
 * 把發現的問題跟建議修改，包成一個 GitHub Pull Request 送出去。
 *
 * 設計原則（刻意，不是漏做）：
 * - 永遠不會自動 merge。PR／Issue 開好就停在那裡，等人看過、按下去才會真的生效。
 * - 找不到需要修改的地方時，改開一張 Issue 留下健檢報告，而不是硬找東西改。
 * - 只審查白名單裡列出的固定檔案，不會自己去抓專案以外、或它猜測存在的檔案。
 */

import { runEngineeringCouncil } from "./debate.js";

// 只審查這些固定路徑，不讓 AI 自己決定要看哪些檔案 —— 白名單本身就是一種防護，
// 避免它因為理解錯誤而去動到不該碰的東西（例如不存在的檔案、或它自己編出來的路徑）。
const SELF_REVIEW_FILES = [
  "src/worker.js",
  "src/debate.js",
  "src/usage.js",
  "src/selfReview.js",
  "public/index.html",
  "wrangler.jsonc",
  "README.md",
];

const SELF_REVIEW_QUESTION = `這是 AI 圓桌自己的原始碼，請對整個專案做一次自我健檢：
1. 找出目前程式碼裡潛在的 bug、邏輯不一致，或使用者體驗上的落差。
2. 檢查是否有安全疑慮（例如 API Key／Secret 外洩風險、輸入未過濾、Prompt Injection 防護是否足夠、Rate Limit 是否合理）。
3. 檢查是否有明顯可以優化、但風險很低的地方。
4. 只針對「確定有問題」或「明確能改善」的地方提出最小修改，不要為了改而改，不要做大規模重構，不要更動整體架構或刻意設計的限制（例如 Reviewer 的 context 預算上限、永遠不自動 merge 這件事本身）。
5. 如果目前看起來一切正常、沒有值得改的地方，files 留空即可，不要硬找東西改。`;

async function readSecret(env, name) {
  let value = env?.[name];
  try {
    if (value && typeof value.get === "function") value = await value.get();
  } catch { return ""; }
  return String(value || "").trim();
}

function base64ToUtf8(b64) {
  const clean = String(b64 || "").replace(/\n/g, "");
  const bin = atob(clean);
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  return new TextDecoder("utf-8").decode(bytes);
}

async function githubRequest(env, path, options = {}) {
  const token = await readSecret(env, "GITHUB_TOKEN");
  if (!token) throw new Error("尚未設定 GITHUB_TOKEN，無法連線 GitHub");
  const owner = String(env.GITHUB_OWNER || "").trim();
  const repo = String(env.GITHUB_REPO || "").trim();
  if (!owner || !repo) throw new Error("尚未設定 GITHUB_OWNER / GITHUB_REPO");

  const r = await fetch(`https://api.github.com/repos/${owner}/${repo}${path}`, {
    ...options,
    headers: {
      "accept": "application/vnd.github+json",
      "authorization": `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "ai-council-self-review",
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`GitHub API ${path} 失敗（HTTP ${r.status}）：${body.slice(0, 300)}`);
  }
  if (r.status === 204) return null;
  return r.json();
}

async function fetchRepoFile(env, path, ref) {
  try {
    const data = await githubRequest(env, `/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`);
    if (!data?.content) return null;
    return base64ToUtf8(data.content);
  } catch {
    // 檔案在這個 repo 裡不存在，或讀取失敗，略過就好，不當成致命錯誤。
    return null;
  }
}

async function openSelfReviewPR(env, { branch, base, files, title, body }) {
  const baseRef = await githubRequest(env, `/git/ref/heads/${encodeURIComponent(base)}`);
  const baseSha = baseRef.object.sha;
  const baseCommit = await githubRequest(env, `/git/commits/${baseSha}`);
  const baseTreeSha = baseCommit.tree.sha;

  const treeItems = [];
  for (const f of files) {
    const blob = await githubRequest(env, `/git/blobs`, {
      method: "POST",
      body: JSON.stringify({ content: f.content, encoding: "utf-8" }),
    });
    treeItems.push({ path: f.path, mode: "100644", type: "blob", sha: blob.sha });
  }

  const newTree = await githubRequest(env, `/git/trees`, {
    method: "POST",
    body: JSON.stringify({ base_tree: baseTreeSha, tree: treeItems }),
  });

  const newCommit = await githubRequest(env, `/git/commits`, {
    method: "POST",
    body: JSON.stringify({ message: title, tree: newTree.sha, parents: [baseSha] }),
  });

  await githubRequest(env, `/git/refs`, {
    method: "POST",
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: newCommit.sha }),
  });

  // 只開 PR，絕對不呼叫 merge API —— 這是整個功能最重要的一條界線。
  return githubRequest(env, `/pulls`, {
    method: "POST",
    body: JSON.stringify({ title, head: branch, base, body }),
  });
}

async function openSelfReviewIssue(env, { title, body }) {
  return githubRequest(env, `/issues`, {
    method: "POST",
    body: JSON.stringify({ title, body }),
  });
}

function buildReportBody(artifact, finalText) {
  const lines = [
    `**摘要**：${artifact?.summary || finalText || "（無摘要）"}`,
  ];
  if (artifact?.rootCause) lines.push(`\n**根因 / 觀察**：${artifact.rootCause}`);
  if (Array.isArray(artifact?.review) && artifact.review.length) lines.push(`\n**Reviewer 核對重點**：\n- ${artifact.review.join("\n- ")}`);
  if (Array.isArray(artifact?.instructions) && artifact.instructions.length) lines.push(`\n**建議事項**：\n- ${artifact.instructions.join("\n- ")}`);
  lines.push(`\n---\n本報告由排程／手動觸發的 AI 圓桌自我健檢自動產生。PR 與 Issue 都不會自動 merge 或關閉，需要人工確認後才會真的生效。`);
  return lines.filter(Boolean).join("\n");
}

export async function runSelfReview(env) {
  const base = String(env.GITHUB_BASE_BRANCH || "main").trim();

  const files = [];
  for (const path of SELF_REVIEW_FILES) {
    const content = await fetchRepoFile(env, path, base);
    if (content != null) files.push({ path, content, size: content.length });
  }
  if (!files.length) {
    throw new Error("讀不到任何原始碼檔案，請確認 GITHUB_OWNER / GITHUB_REPO / GITHUB_TOKEN / GITHUB_BASE_BRANCH 設定正確，以及 Token 有 repo 讀取權限");
  }

  const result = await runEngineeringCouncil({
    env,
    question: SELF_REVIEW_QUESTION,
    rawFiles: files,
    rawImages: [],
    webSearch: false,
  });

  const artifact = result.artifact;
  const proposedFiles = Array.isArray(artifact?.files)
    ? artifact.files.filter(f => f?.path && typeof f.content === "string")
    : [];

  const dateLabel = new Date().toISOString().slice(0, 10);
  const reportBody = buildReportBody(artifact, result.final);

  if (!proposedFiles.length) {
    const issue = await openSelfReviewIssue(env, {
      title: `AI 圓桌自我健檢（${dateLabel}）：沒有發現需要修改的地方`,
      body: reportBody,
    });
    return { ok: true, action: "issue", url: issue.html_url, artifact };
  }

  const branch = `ai-selfreview/${Date.now()}`;
  const pr = await openSelfReviewPR(env, {
    branch,
    base,
    files: proposedFiles,
    title: `AI 圓桌自我健檢（${dateLabel}）：${artifact?.summary || "自動提交的修正建議"}`,
    body: reportBody,
  });
  return { ok: true, action: "pull_request", url: pr.html_url, artifact };
}
