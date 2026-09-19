/**
 * githubEngineering.js — AI 圓桌 GitHub 工程模式
 *
 * 讀取指定 repository 的實際原始碼，交給雙 AI 討論與修改，
 * 最後只建立新 branch + Pull Request，不直接修改 base branch。
 */

import { runEngineeringCouncil, runAuditBatch, runFixDirectionReview, runPostFixReview, synthesizeAuditEvidence } from "./debate.js";

const MAX_BODY_BYTES = 64 * 1024;
const MAX_TASK_CHARS = 4000;
const MAX_FILES = 30;
const MAX_FILE_CHARS = 120000;
const MAX_TOTAL_FILE_CHARS = 360000;
const MAX_BLOB_CONCURRENCY = 5;
const GITHUB_REQUEST_TIMEOUT_MS = 20000;
const MAX_TREE_ENTRIES = 5000;
const MAX_REPO_AUDIT_FILES = 80;
const MAX_REPO_AUDIT_CHARS = 2000000;
const AUDIT_BATCH_TARGET_CHARS = 280000;
const MAX_AUDIT_BATCHES = 12;
const ALLOWED_EXT = new Set([
  "js","mjs","cjs","ts","tsx","jsx","html","htm","css","json","jsonc",
  "md","txt","xml","yaml","yml","toml","csv","py","java","go","rs",
  "sql","sh","bash","vue","svelte"
]);
const DENIED_PREFIXES = [
  ".git/","node_modules/","dist/","build/","coverage/","vendor/",
  ".next/",".nuxt/","__pycache__/","target/"
];
const DENIED_EXACT = new Set([
  ".env",".env.local",".env.production",".dev.vars",
  "wrangler.toml","wrangler.json","wrangler.jsonc","secrets.json"
]);
const DENIED_WRITE_EXACT = new Set([
  ...DENIED_EXACT,
  "package-lock.json","pnpm-lock.yaml","yarn.lock"
]);

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "same-origin",
    },
  });
}

async function readSecret(env, name) {
  let value = env?.[name];
  try {
    if (value && typeof value.get === "function") value = await value.get();
  } catch {
    return "";
  }
  return String(value || "").trim();
}

async function readJsonBody(request) {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > MAX_BODY_BYTES) {
    const error = new Error("REQUEST_TOO_LARGE");
    error.status = 413;
    throw error;
  }
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
    const error = new Error("REQUEST_TOO_LARGE");
    error.status = 413;
    throw error;
  }
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("INVALID_JSON");
    error.status = 400;
    throw error;
  }
}

function safePath(path) {
  const p = String(path || "").replace(/^\/+/, "");
  if (!p || p.length > 220 || p.includes("\0")) return "";
  if (p.startsWith("/") || p.includes("..") || /^[A-Za-z]:[\\/]/.test(p)) return "";
  return p;
}

function isReadableSource(path, size = 0) {
  const p = safePath(path);
  if (!p || size > MAX_FILE_CHARS * 2) return false;
  if (DENIED_EXACT.has(p) || p.endsWith("/.env") || p.includes("/.env.")) return false;
  if (DENIED_PREFIXES.some(prefix => p.startsWith(prefix))) return false;
  const base = p.split("/").pop() || "";
  if (base.startsWith(".env")) return false;
  const dot = base.lastIndexOf(".");
  const ext = dot >= 0 ? base.slice(dot + 1).toLowerCase() : "";
  return ALLOWED_EXT.has(ext);
}

function isWritablePath(path) {
  const p = safePath(path);
  if (!p || DENIED_WRITE_EXACT.has(p)) return false;
  if (DENIED_PREFIXES.some(prefix => p.startsWith(prefix))) return false;
  if (p.startsWith(".github/")) return false;
  if (p.includes("/.env.") || p.endsWith("/.env")) return false;
  return isReadableSource(p, 0);
}

function repoConfig(env, repoFullName) {
  const owner = String(env.GITHUB_OWNER || "").trim();
  const repo = String(repoFullName || "").trim();
  if (!owner || !repo) throw new Error("GitHub 尚未完成設定");
  const parts = repo.split("/");
  if (parts.length !== 2 || parts[0] !== owner || !/^[A-Za-z0-9_.-]{1,100}$/.test(parts[1])) {
    throw new Error("只允許操作 GITHUB_OWNER 底下的 repository");
  }

  const allowRaw = String(env.GITHUB_ALLOWED_REPOS || "").trim();
  if (allowRaw && allowRaw !== "*") {
    const allowed = new Set(allowRaw.split(",").map(x => x.trim()).filter(Boolean));
    if (!allowed.has(repo)) throw new Error("這個 repository 不在 AI 圓桌允許清單內");
  }
  return { owner, repo: parts[1], fullName: repo };
}

function ghHeaders(token, extra = {}) {
  return {
    "accept": "application/vnd.github+json",
    "authorization": `Bearer ${token}`,
    "x-github-api-version": "2022-11-28",
    "user-agent": "ai-council-github-engineering",
    ...extra,
  };
}

async function githubRequest(env, path, options = {}) {
  const token = await readSecret(env, "GITHUB_TOKEN");
  if (!token) throw new Error("GITHUB_TOKEN 尚未設定");

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), GITHUB_REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(`https://api.github.com${path}`, {
      ...options,
      signal: controller.signal,
      headers: ghHeaders(token, {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.headers || {}),
      }),
    });
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("GitHub API 連線逾時");
    throw new Error("GitHub API 連線失敗");
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const status = response.status;
    const error = new Error(
      status === 401 || status === 403 ? "GitHub 權限或 Token 驗證失敗" :
      status === 404 ? "GitHub repository / branch / resource 不存在或無權限存取" :
      status === 409 ? "GitHub 發生版本衝突，請重新讀取後再試" :
      status === 422 ? "GitHub 拒絕這次操作，可能是 branch / PR 已存在" :
      status === 429 ? "GitHub API 暫時達到速率限制" :
      "GitHub API 暫時無法使用"
    );
    error.status = status;
    throw error;
  }

  if (response.status === 204) return null;
  return response.json();
}

function base64ToUtf8(value) {
  const clean = String(value || "").replace(/\s/g, "");
  const binary = atob(clean);
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  return new TextDecoder("utf-8").decode(bytes);
}

async function fetchRepoFiles(env, fullName, base) {
  const { owner, repo } = repoConfig(env, fullName);
  const tree = await githubRequest(
    env,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(base)}?recursive=1`
  );

  if (tree?.truncated) throw new Error("repository 太大，GitHub tree 被截斷；請指定較小的專案或下一版加入路徑篩選");
  const entries = Array.isArray(tree?.tree) ? tree.tree.slice(0, MAX_TREE_ENTRIES) : [];
  const candidates = entries
    .filter(x => x?.type === "blob" && isReadableSource(x.path, Number(x.size || 0)))
    .sort((a, b) => {
      const score = p => {
        if (/^(package\.json|wrangler\.jsonc?|README\.md)$/i.test(p)) return 0;
        if (/^(src|functions|public)\//i.test(p)) return 1;
        return 2;
      };
      return score(a.path) - score(b.path) || a.path.localeCompare(b.path);
    })
    .slice(0, MAX_FILES);

  const files = [];
  let total = 0;

  // 小批次並行讀 blob：避免 18 個檔案完全串行造成手機端長時間等待，
  // 同時把 concurrency 壓低，降低 GitHub secondary rate-limit 風險。
  for (let start = 0; start < candidates.length && total < MAX_TOTAL_FILE_CHARS; start += MAX_BLOB_CONCURRENCY) {
    const batch = candidates.slice(start, start + MAX_BLOB_CONCURRENCY);
    const blobs = await Promise.all(
      batch.map(async (entry) => {
        try {
          const blob = await githubRequest(
            env,
            `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs/${encodeURIComponent(entry.sha)}`
          );
          return { entry, blob };
        } catch {
          return { entry, blob: null };
        }
      })
    );

    for (const { entry, blob } of blobs) {
      if (total >= MAX_TOTAL_FILE_CHARS) break;
      if (blob?.encoding !== "base64" || typeof blob.content !== "string") continue;
      const fullContent = base64ToUtf8(blob.content);
      const remaining = MAX_TOTAL_FILE_CHARS - total;
      // Full Repo Audit 不再把單一 GitHub blob 靜默切半。
      // 只有整份檔案能放進本輪預算才交給 AI；否則跳過並由 metadata 標示，
      // 避免 AI 收到看似完整、實際缺尾端的原始碼。
      if (!fullContent || fullContent.length > MAX_FILE_CHARS || fullContent.length > remaining) continue;
      total += fullContent.length;
      files.push({
        path: entry.path,
        content: fullContent,
        size: Number(entry.size || fullContent.length),
      });
    }
  }

  if (!files.length) throw new Error("找不到可供 AI 審查的文字原始碼");
  return { files, treeEntryCount: entries.length, truncated: false };
}


function auditGroup(path) {
  const p = String(path || "").toLowerCase();
  if (/^(worker|src\/worker)|routes?|middleware/.test(p)) return "01-runtime-routing";
  if (/ai|gemini|openai|anthropic|ask|chat|llm/.test(p)) return "02-ai";
  if (/quote|news|dividend|market|stock|trade/.test(p)) return "03-domain-data";
  if (/^public\/|\.html?$|\.css$|frontend|ui/.test(p)) return "04-frontend";
  if (/test|spec|fixture/.test(p)) return "05-tests";
  if (/package|readme|deploy|version|config|wrangler|vercel/.test(p)) return "06-build-docs";
  return "07-other";
}

async function fetchFullRepoAuditFiles(env, fullName, base) {
  const { owner, repo } = repoConfig(env, fullName);
  const tree = await githubRequest(
    env,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(base)}?recursive=1`
  );
  if (tree?.truncated) throw new Error("repository tree 遭 GitHub 截斷，無法宣稱 Full Repo Audit");

  const entries = Array.isArray(tree?.tree) ? tree.tree.slice(0, MAX_TREE_ENTRIES) : [];
  const allReadable = entries
    .filter(x => x?.type === "blob" && isReadableSource(x.path, Number(x.size || 0)))
    .sort((a,b) => auditGroup(a.path).localeCompare(auditGroup(b.path)) || a.path.localeCompare(b.path));

  const selected = allReadable.slice(0, MAX_REPO_AUDIT_FILES);
  const files = [];
  const skipped = allReadable.slice(MAX_REPO_AUDIT_FILES).map(x => ({ path:x.path, reason:"file_limit" }));
  let totalChars = 0;

  for (let start=0; start<selected.length; start+=MAX_BLOB_CONCURRENCY) {
    const part=selected.slice(start,start+MAX_BLOB_CONCURRENCY);
    const blobs=await Promise.all(part.map(async entry => {
      try {
        const blob=await githubRequest(env,
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs/${encodeURIComponent(entry.sha)}`);
        return {entry,blob};
      } catch { return {entry,blob:null}; }
    }));
    for (const {entry,blob} of blobs) {
      if (blob?.encoding!=="base64" || typeof blob.content!=="string") {
        skipped.push({path:entry.path,reason:"read_failed"});
        continue;
      }
      const content=base64ToUtf8(blob.content);
      if (!content) { skipped.push({path:entry.path,reason:"empty"}); continue; }
      if (content.length>MAX_FILE_CHARS) { skipped.push({path:entry.path,reason:"single_file_too_large"}); continue; }
      if (totalChars+content.length>MAX_REPO_AUDIT_CHARS) { skipped.push({path:entry.path,reason:"repo_budget"}); continue; }
      totalChars+=content.length;
      files.push({path:entry.path,content,size:Number(entry.size||0),truncated:false,group:auditGroup(entry.path)});
    }
  }
  if (!files.length) throw new Error("找不到可供 Full Repo Audit 的完整文字原始碼");
  return {
    files, skipped, treeEntryCount:entries.length,
    readableFileCount:allReadable.length, totalChars,
    coverage: allReadable.length ? files.length/allReadable.length : 1
  };
}

function planAuditBatches(files) {
  const batches=[];
  for (const file of files) {
    let batch=batches[batches.length-1];
    const mustNew=!batch || batch.group!==file.group ||
      (batch.chars>0 && batch.chars+file.content.length>AUDIT_BATCH_TARGET_CHARS);
    if (mustNew) {
      batch={id:batches.length+1,group:file.group,chars:0,files:[]};
      batches.push(batch);
    }
    batch.files.push(file);
    batch.chars+=file.content.length;
  }
  // Hard cap is explicit: overflow remains visible as uncovered instead of being silently truncated.
  return {
    batches:batches.slice(0,MAX_AUDIT_BATCHES),
    overflow:batches.slice(MAX_AUDIT_BATCHES).flatMap(b=>b.files.map(f=>f.path))
  };
}

function coverageLine(snapshot, reviewedPaths, extraSkipped=[]) {
  const reviewed=new Set(reviewedPaths);
  const total=snapshot.readableFileCount;
  const count=reviewed.size;
  const pct=total ? Math.round((count/total)*1000)/10 : 100;
  const skipped=[...snapshot.skipped.map(x=>x.path),...extraSkipped];
  return {total,count,pct,skipped};
}

async function runFullRepoBatchAudit(env, fullName, base, question) {
  const snapshot=await fetchFullRepoAuditFiles(env,fullName,base);
  const plan=planAuditBatches(snapshot.files);
  const findings=[];
  const reviewedPaths=[];

  for (const batch of plan.batches) {
    const paths=batch.files.map(f=>f.path);
    const batchResult=await runAuditBatch({
      env,
      question:
        `【Full Repo Batch Audit ${batch.id}/${plan.batches.length}】 Repository：${fullName} / Base：${base} / 群組：${batch.group}。原始任務：${question}。只審查本批完整檔案；建立證據，不修改程式。`,
      rawFiles:batch.files,
    });
    reviewedPaths.push(...paths);
    findings.push({
      path:`batch-${String(batch.id).padStart(2,"0")}-${batch.group}.md`,
      content:`# Batch ${batch.id}: ${batch.group}\n\nFiles: ${paths.join(", ")}\n\n${batchResult.text||""}`,
      size:0,
      truncated:false
    });
  }

  const coverage=coverageLine(snapshot,reviewedPaths,plan.overflow);
  const manifest={
    path:"00-audit-manifest.md",
    truncated:false,
    size:0,
    content:[
      "# Full Repository Audit Manifest",
      `Repository: ${fullName}`,
      `Base: ${base}`,
      `Readable files discovered: ${coverage.total}`,
      `Files fully reviewed: ${coverage.count}`,
      `Audit Coverage: ${coverage.pct}%`,
      `Batch count: ${plan.batches.length}`,
      "Reviewed files:",
      ...reviewedPaths.map(p=>`- ${p}`),
      "Unreviewed/skipped files:",
      ...(coverage.skipped.length?coverage.skipped.map(p=>`- ${p}`):["- none"])
    ].join("\n")
  };

  // v4.4：Full Repo Audit 已經完成逐批完整檔案審查，最終階段只需要整合證據。
  // 不再先跑一次完整 A/B + Report pipeline；那會重複消耗 context/token，並讓報告更容易超時或不完整。
  const primary=await synthesizeAuditEvidence({
    env,
    question,
    rawFiles:[manifest,...findings],
    coverage,
  });
  const finalResult={
    version:"4.4.0",
    a:"",
    b:"",
    final:primary.report||"",
    reportGenerationFailed:!primary.complete,
    artifact:{
      summary:primary.complete ? "Full Repo Evidence Synthesis 已完成。" : "Primary Evidence Synthesis 未達完整度門檻。",
      report:primary.report||"",
      verified:[],
      inferences:[],
      pending:primary.complete ? [] : ["Primary Evidence Synthesis 未完成，進入 compact rescue。"],
      review:[],
      instructions:[],
      sources:[],
      files:[],
      synthesisSource:primary.source,
      synthesisSections:primary.sectionCount,
      synthesisLength:primary.length,
    }
  };

  if (finalResult.reportGenerationFailed) {
    // v4.3：Rescue 不再遞迴呼叫完整 A/B Audit pipeline。
    // 直接把已完成的完整檔案 batch evidence 交給專用 synthesis，避免第二次又走同一個失敗路徑。
    const rescue=await synthesizeAuditEvidence({
      env,
      question,
      rawFiles:[manifest,...findings],
      coverage,
    });
    if (rescue.complete) {
      finalResult.reportGenerationFailed=false;
      finalResult.final=rescue.report;
      finalResult.artifact={
        ...(finalResult.artifact||{}),
        summary:"Evidence Rescue Synthesis 已完成。",
        report:rescue.report,
        pending:[],
        instructions:["已由完整批次證據重新合成 Audit Report。"],
        rescuedFromReportFailure:true,
        rescueSource:rescue.source,
      };
    } else {
      finalResult.final=[
        "# AI Council Audit 未完成",
        "## 狀態",
        "Primary Report 與 Evidence Rescue 都未達完整度門檻；本次不產生確定性 Audit 結論。",
        "## 安全限制",
        "不得依 A/B 原文、[TRUNCATED] reviewer context 或不完整報告直接修改 repository。",
        "## Coverage",
        "Audit Coverage "+coverage.pct+"% ("+coverage.count+"/"+coverage.total+" readable files)。"
      ].join("\n\n");
      if(finalResult.artifact){
        finalResult.artifact.report=finalResult.final;
        finalResult.artifact.pending=["Primary Report 與 Evidence Rescue 均未完成。"];
        finalResult.artifact.rescueFailed=true;
      }
    }
  }

  if (finalResult.artifact) {
    finalResult.artifact.coverage=coverage;
    finalResult.artifact.batchCount=plan.batches.length;
    finalResult.artifact.reviewedFiles=reviewedPaths;
    finalResult.artifact.skippedFiles=coverage.skipped;
  }
  return {result:finalResult,snapshot,coverage,batchCount:plan.batches.length,reviewedPaths};
}

function extractFunctionNames(source) {
  const names = new Set();
  const s = String(source || "");
  const patterns = [
    /(?:^|\n)\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g,
    /(?:^|\n)\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^\n]*\)\s*=>/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(s)) !== null) names.add(m[1]);
  }
  return names;
}

function taskExplicitlyRequestsDeletion(task, name) {
  const t = String(task || "").toLowerCase();
  const n = String(name || "").toLowerCase();
  if (n && t.includes(n)) return true;
  return /\\b(delete|remove|rename|refactor|rewrite|replace|obsolete|移除|刪除|刪掉|重命名|重新命名|重構|改寫|替換|淘汰)\\b/i.test(t);
}

function validateProposedFiles(proposed, originalMap, task = "") {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(proposed) ? proposed : []) {
    const path = safePath(raw?.path);
    if (!path || seen.has(path) || !isWritablePath(path)) continue;
    if (!originalMap.has(path)) continue;
    if (typeof raw?.content !== "string") continue;
    if (raw.content.length > MAX_FILE_CHARS * 2) continue;

    const original = originalMap.get(path);
    if (raw.content === original) continue;

    // 絕不接受模型自己產生的截斷標記或明顯的整檔重寫。
    if (/\[TRUNCATED\]|\.\.\.\s*(?:END|檔案結尾|省略)/i.test(raw.content)) continue;

    const explicitDelete = taskExplicitlyRequestsDeletion(task, path);

    // 非刪除/重構任務時，修改後檔案不得突然縮到原檔的一半以下。
    // 這是第二道保險：即使函式名稱沒有被正則抓到，也不能把大量無關程式碼砍掉。
    if (!explicitDelete && original.length >= 1200 && raw.content.length < original.length * 0.5) continue;

    // 若原檔的具名函式在新檔消失，除非任務明確要求該函式被刪除/重構，否則拒絕建立 PR。
    const originalFns = extractFunctionNames(original);
    const proposedFns = extractFunctionNames(raw.content);
    const missingFns = [...originalFns].filter(name => !proposedFns.has(name) && !taskExplicitlyRequestsDeletion(task, name));
    if (missingFns.length) continue;

    seen.add(path);
    out.push({ path, content: raw.content });
  }
  return out;
}

function changedLineRatio(before, after) {
  const a=String(before||"").split("\n"), b=String(after||"").split("\n");
  const max=Math.max(a.length,b.length,1), min=Math.min(a.length,b.length);
  let same=0; for(let i=0;i<min;i+=1) if(a[i]===b[i]) same+=1;
  return 1-(same/max);
}

function mechanicalFixGate(proposed, originalMap, allowedScope) {
  const allowed=new Set((allowedScope||[]).map(safePath).filter(Boolean));
  const checks=[];
  for(const file of proposed) {
    const before=originalMap.get(file.path)||"";
    if(allowed.size&&!allowed.has(file.path)) return {ok:false,reason:`修改超出核准範圍：${file.path}`,checks};
    if(!before) return {ok:false,reason:`缺少修改前檔案：${file.path}`,checks};
    if(/\[TRUNCATED\]/.test(file.content)) return {ok:false,reason:`修改後含截斷標記：${file.path}`,checks};
    const beforeFns=extractFunctionNames(before), afterFns=extractFunctionNames(file.content);
    const missing=[...beforeFns].filter(x=>!afterFns.has(x));
    if(missing.length) return {ok:false,reason:`既有函式消失：${file.path} -> ${missing.join(", ")}`,checks};
    const ratio=changedLineRatio(before,file.content);
    if(ratio>0.35) return {ok:false,reason:`修改範圍過大：${file.path} (${Math.round(ratio*100)}%)`,checks};
    checks.push({path:file.path,changedRatio:Math.round(ratio*1000)/10,functionsPreserved:true});
  }
  return {ok:true,checks};
}

function slugify(text) {
  const s = String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return s || "code-change";
}

async function createPullRequest(env, fullName, base, files, task, summary) {
  const { owner, repo } = repoConfig(env, fullName);
  const branch = `ai-council/${slugify(task)}-${Date.now().toString(36)}`;

  const baseRef = await githubRequest(
    env,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/heads/${encodeURIComponent(base)}`
  );
  const baseSha = baseRef?.object?.sha;
  if (!baseSha) throw new Error("讀不到 base branch SHA");

  const commit = await githubRequest(
    env,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/commits/${encodeURIComponent(baseSha)}`
  );
  const treeSha = commit?.tree?.sha;
  if (!treeSha) throw new Error("讀不到 base tree");

  const treeItems = [];
  // GitHub 建議避免短時間大量 mutation；這裡逐個建立 blob。
  for (const file of files) {
    const blob = await githubRequest(
      env,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs`,
      {
        method: "POST",
        body: JSON.stringify({ content: file.content, encoding: "utf-8" }),
      }
    );
    treeItems.push({ path: file.path, mode: "100644", type: "blob", sha: blob.sha });
  }

  const tree = await githubRequest(
    env,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees`,
    {
      method: "POST",
      body: JSON.stringify({ base_tree: treeSha, tree: treeItems }),
    }
  );

  const newCommit = await githubRequest(
    env,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/commits`,
    {
      method: "POST",
      body: JSON.stringify({
        message: `AI Council: ${String(summary || "工程修正").slice(0, 120)}`,
        tree: tree.sha,
        parents: [baseSha],
      }),
    }
  );

  await githubRequest(
    env,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs`,
    {
      method: "POST",
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: newCommit.sha }),
    }
  );

  const pr = await githubRequest(
    env,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`,
    {
      method: "POST",
      body: JSON.stringify({
        title: `AI Council：${String(summary || "工程修正").slice(0, 180)}`,
        head: branch,
        base,
        body: [
          "## AI Council 工程模式",
          "",
          `任務：${task}`,
          "",
          `AI 最終摘要：${summary || "（無摘要）"}`,
          "",
          "### 修改檔案",
          ...files.map(f => `- \`${f.path}\``),
          "",
          "本 PR 由 AI 圓桌建立；不會自動 merge，請人工檢查 diff 與測試結果後再決定是否合併。",
        ].join("\n"),
        draft: true,
        maintainer_can_modify: false,
      }),
    }
  );

  return { branch, commitSha: newCommit.sha, pr };
}

export async function listGitHubRepos(env) {
  const data = await githubRequest(
    env,
    "/user/repos?per_page=100&affiliation=owner,collaborator,organization_member&sort=updated&direction=desc"
  );
  return (Array.isArray(data) ? data : [])
    .filter(x => x?.full_name)
    .map(x => ({
      fullName: x.full_name,
      name: x.name,
      private: Boolean(x.private),
      defaultBranch: x.default_branch || "main",
      permissions: x.permissions || {},
    }));
}

export async function runGitHubEngineering(env, { repoFullName, base, task, dryRun = false, reportMode = false }) {
  const { fullName } = repoConfig(env, repoFullName);
  const safeBase = String(base || "main").trim();
  if (!/^[A-Za-z0-9._/-]{1,120}$/.test(safeBase) || safeBase.includes("..") || safeBase.startsWith("/")) {
    throw new Error("base branch 名稱不合法");
  }

  const question = String(task || "").trim();
  if (!question || question.length > MAX_TASK_CHARS) throw new Error("工程任務不可為空，且最多 4000 字元");

  // 「產生完整/詳細審查報告」本質上是分析交付，不應因使用者沒寫「不要修改」就誤開 PR。
  // 只有明確要求修改/修復/重構/commit/PR 時，才進入可提交變更流程。
  const reportRequested = reportMode === true || /完整報告|詳細報告|產生報告|生成報告|審查|檢查|分析|review|audit|full report/i.test(question);
  const modificationRequested = /修改|修正|修復|改程式|重構|刪除|移除|新增|增加|替換|commit|pull request|draft pr|fix|change|refactor|delete|remove|add|replace/i.test(question);
  const analysisOnly = dryRun === true || (reportRequested && !modificationRequested);

  if (analysisOnly && reportRequested) {
    const audit=await runFullRepoBatchAudit(env,fullName,safeBase,question);
    return {
      ok:true,
      action:"analysis_only",
      repository:fullName,
      base:safeBase,
      scannedFiles:audit.reviewedPaths,
      auditCoverage:audit.coverage,
      batchCount:audit.batchCount,
      a:audit.result.a,
      b:audit.result.b,
      final:audit.result.final,
      artifact:audit.result.artifact||null,
      version:audit.result.version||"4.4.0",
      reportGenerationFailed:Boolean(audit.result.reportGenerationFailed),
    };
  }

  const snapshot = await fetchRepoFiles(env, fullName, safeBase);
  const originalMap = new Map(snapshot.files.map(f => [f.path, f.content]));

  let fixDirection=null;
  if (!analysisOnly && modificationRequested) {
    const directionReview=await runFixDirectionReview({env,task:question,rawFiles:snapshot.files,finding:question});
    if (!directionReview.approved) {
      return {ok:true,action:"direction_not_approved",repository:fullName,base:safeBase,
        scannedFiles:snapshot.files.map(f=>f.path),fixDirection:directionReview,
        final:"修正方向尚未通過 Verified Fix Direction Gate，因此沒有修改檔案或建立 PR。",
        artifact:{summary:"修正方向未核准",rootCause:directionReview.direction?.rootCause||"",verified:[],inferences:[],pending:directionReview.direction?.pending||[],review:[directionReview.reviewer],instructions:["補足證據或縮小修正範圍後再執行"],files:[]}};
    }
    fixDirection=directionReview;
  }

  const result = await runEngineeringCouncil({
    env,
    question:
      `【GitHub 工程模式】\nRepository：${fullName}\nBase：${safeBase}\n\n${question}${fixDirection ? `\n\n【已核准 Fix Direction】\n${JSON.stringify(fixDirection.direction)}\n只能依 scopeFiles 與 recommended 方案修改，不得自行換方案或擴大範圍。` : ""}\n\n規則：直接以附件中的 GitHub 原始碼為準。只修改確定有問題或明確能改善的地方。不得修改 secrets、.env、.github/workflows、node_modules、build/dist。輸出的 files 必須是完整檔案內容，不得輸出 diff 片段。先由 AI A 分析與提出修改，再由 AI B 重新檢查，最後整合成可提交的最小變更。**禁止為了修一個局部問題而重寫整個檔案；除非任務明確要求重構/刪除，否則必須保留原檔既有功能、函式與事件處理。若無法完整保留，請不要輸出該檔案。**`,
    rawFiles: snapshot.files,
    rawImages: [],
    webSearch: false,
    analysisOnly,
    reportMode: reportRequested,
  });

  const proposed = validateProposedFiles(result?.artifact?.files, originalMap, question);
  if (!analysisOnly && proposed.length && fixDirection) {
    const mechanical=mechanicalFixGate(proposed,originalMap,fixDirection.direction?.scopeFiles||[]);
    if(!mechanical.ok) return {ok:true,action:"verification_failed",repository:fullName,base:safeBase,scannedFiles:snapshot.files.map(f=>f.path),fixDirection,verification:mechanical,final:"修改未通過 Mechanical Fix Gate，因此沒有建立 PR。",artifact:result.artifact||null};
    const afterFiles=proposed.map(f=>({path:f.path,content:f.content,truncated:false}));
    const beforeFiles=proposed.map(f=>({path:f.path,content:originalMap.get(f.path),truncated:false}));
    const post=await runPostFixReview({env,task:question,beforeFiles,afterFiles,direction:fixDirection.direction});
    if(!post.approved) return {ok:true,action:"verification_failed",repository:fullName,base:safeBase,scannedFiles:snapshot.files.map(f=>f.path),fixDirection,verification:{mechanical,post},final:"修改未通過 Before/After Regression Review，因此沒有建立 PR。",artifact:result.artifact||null};
    result.fixVerification={mechanical,post};
  }
  if (analysisOnly || !proposed.length) {
    return {
      ok: true,
      action: analysisOnly ? "analysis_only" : "no_changes",
      repository: fullName,
      base: safeBase,
      scannedFiles: snapshot.files.map(f => f.path),
      a: result.a,
      b: result.b,
      final: result.final,
      artifact: result.artifact || null,
    };
  }

  const prResult = await createPullRequest(
    env,
    fullName,
    safeBase,
    proposed,
    question,
    result?.artifact?.summary || "AI 圓桌工程修正"
  );

  return {
    ok: true,
    action: "pull_request",
    repository: fullName,
    base: safeBase,
    branch: prResult.branch,
    commitSha: prResult.commitSha,
    pr: {
      number: prResult.pr?.number || null,
      url: prResult.pr?.html_url || null,
      title: prResult.pr?.title || null,
      draft: Boolean(prResult.pr?.draft),
    },
    scannedFiles: snapshot.files.map(f => f.path),
    changedFiles: proposed.map(f => f.path),
    fixDirection: fixDirection || null,
    fixVerification: result.fixVerification || null,
    a: result.a,
    b: result.b,
    final: result.final,
    artifact: result.artifact || null,
  };
}

export async function handleGitHubEngineering(request, env) {
  try {
    const body = await readJsonBody(request);
    const result = await runGitHubEngineering(env, {
      repoFullName: body?.repoFullName,
      base: body?.base,
      task: body?.task,
      dryRun: body?.dryRun === true,
      reportMode: body?.reportMode === true,
    });
    return json(result);
  } catch (e) {
    console.error("GitHub 工程模式失敗：", e?.message || e);
    return json({
      ok: false,
      error: e?.status === 413 ? "請求內容太大" : e?.status === 400 ? "請求格式錯誤" : String(e?.message || "").includes("GITHUB_TOKEN") ? "GitHub 尚未完成設定" : "GitHub 工程模式執行失敗，請稍後再試",
    }, e?.status === 413 ? 413 : e?.status === 400 ? 400 : 500);
  }
}

export async function handleGitHubRepos(request, env) {
  if (request.method !== "GET") return json({ ok: false, error: "Method Not Allowed" }, 405);
  try {
    const repos = await listGitHubRepos(env);
    return json({ ok: true, repos });
  } catch (e) {
    console.error("GitHub repository 清單讀取失敗：", e?.message || e);
    const message = String(e?.message || "");
    const error = message.includes("GITHUB_TOKEN")
      ? "GitHub 尚未完成設定"
      : message.includes("權限或 Token")
        ? "GitHub Token 無效或權限不足"
        : message.includes("連線逾時")
          ? "GitHub API 連線逾時"
          : message.includes("連線失敗")
            ? "GitHub API 連線失敗"
            : "GitHub repository 清單暫時無法取得";
    return json({ ok: false, error }, 500);
  }
}
