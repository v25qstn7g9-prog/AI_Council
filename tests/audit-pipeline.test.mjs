import assert from "node:assert/strict";
import {runAuditBatch,runAuditBatchFallback,synthesizeAuditEvidence} from "../src/debate.js";
import {auditGroup,buildDeterministicAuditReport,planAuditBatches,scanDeterministicIntegrityFindings} from "../src/githubEngineering.js";

const report=[
  "# Audit Report",
  "## 執行摘要\n完成證據裁決。",
  "## 檢查範圍\nAudit Coverage 100% (1/1)。",
  "## 架構\n模組化架構。",
  "## 功能邏輯\n依可見程式碼核對。",
  "## 已證實問題\n無足夠證據確認重大問題。",
  "## 推測問題\n無。",
  "## 待驗證\n需執行測試。",
  "## 安全性與錯誤處理\n未執行動態測試。",
  "## 效能與可維護性\n待量測。",
  "## 測試部署風險\n未部署。",
  "## 修正建議\n先補測試。",
  "## AI A / AI B 分歧與 AI C 裁決\nA/B 意見依直接證據裁決。",
  "## 最終結論\n僅依靜態證據。",
].join("\n\n")+"\n\n"+"具體證據內容。".repeat(80);

function envWith(run){return {COUNCIL_A_PROVIDER:"cloudflare",COUNCIL_B_PROVIDER:"cloudflare",COUNCIL_C_PROVIDER:"cloudflare",AI:{run}};}

{
  const calls=[];
  const env=envWith(async(model)=>{calls.push(model);return {response:report};});
  const result=await synthesizeAuditEvidence({env,question:"審核",rawFiles:[{path:"evidence.md",content:"evidence"}],coverage:{pct:100,count:1,total:1}});
  assert.equal(result.complete,true);
  assert.equal(calls[0],"@cf/mistralai/mistral-small-3.1-24b-instruct");
  assert.equal(result.attempts,1);
}

{
  const calls=[];
  const env=envWith(async(model)=>{calls.push(model);if(model.includes("mistral-small"))throw new Error("busy");return {response:report};});
  const result=await synthesizeAuditEvidence({env,question:"審核",rawFiles:[{path:"evidence.md",content:"evidence"}],coverage:{pct:100,count:1,total:1}});
  assert.equal(result.complete,true);
  assert.deepEqual(calls.slice(0,2),["@cf/mistralai/mistral-small-3.1-24b-instruct","@cf/meta/llama-3.3-70b-instruct-fp8-fast"]);
}

{
  const counts=new Map();
  const env=envWith(async(model)=>{const n=(counts.get(model)||0)+1;counts.set(model,n);if(n===1)throw new Error("temporary");return {response:"## 架構與功能\nOK\n## 已證實問題\n無\n## 推測問題\n無\n## 安全性與錯誤處理\nOK\n## 效能與可維護性\nOK\n## 待跨檔驗證\n無"};});
  const result=await runAuditBatch({env,question:"審核",rawFiles:[{path:"a.js",content:"export const a=1;"}]});
  assert.equal(result.retried,true);
  assert.equal(result.aOk,true);
  assert.equal(result.bOk,true);
}

{
  const env=envWith(async(model)=>({response:`## 架構與功能\n${model}\n## 已證實問題\n無\n## 推測問題\n無\n## 安全性與錯誤處理\nOK\n## 效能與可維護性\nOK\n## 待跨檔驗證\n無`}));
  const result=await runAuditBatchFallback({env,question:"審核",rawFiles:[{path:"health.js",content:"export const ok=true;"}]});
  assert.match(result.source,/mistral-small/);
  assert.match(result.text,/已證實問題/);
}

assert.equal(auditGroup("functions/health-check.js"),"01-runtime-routing");
const planned=planAuditBatches(Array.from({length:6},(_,i)=>({path:`g${i}.js`,content:"x".repeat(40000),group:`0${i+1}-group`})));
assert.equal(planned.batches.length,3);
assert.deepEqual(planned.batches.map(x=>x.files.length),[2,2,2]);
const integrity=scanDeterministicIntegrityFindings([{path:"index.html",content:"}\nconst d = new Date(`function () { [native code] }T00:00:00Z`);\n// unfinished"}]);
assert.deepEqual(integrity.map(x=>x.id),["HTML_ROOT_INCOMPLETE","NATIVE_CODE_LITERAL"]);
{
  const env=envWith(async()=>({response:report}));
  const rejected=await synthesizeAuditEvidence({env,question:"審核",rawFiles:[{path:"evidence.md",content:"evidence"}],coverage:{pct:100,count:1,total:1},requiredFindings:integrity});
  assert.equal(rejected.complete,false);
  assert.deepEqual(rejected.missingFindingIds,["HTML_ROOT_INCOMPLETE","NATIVE_CODE_LITERAL"]);
}
const deterministic=buildDeterministicAuditReport({fullName:"o/r",base:"main",question:"審核",findings:[],coverage:{pct:100,count:1,total:1,skipped:[]}});
assert.match(deterministic,/Audit Coverage：100%/);

// v4.9.1 regression：unsafeConclusion 只應掃描「最終結論」章節，
// 不得因為非結論章節如實描述「無重大問題」就整份打回重試。
const reportSectionsBase=[
  "# Audit Report",
  "## 執行摘要\n完成證據裁決，發現 Critical 缺陷。",
  "## 檢查範圍\nAudit Coverage 100% (1/1)。",
  "## 架構\n模組化架構，本批次無重大問題。",
  "## 功能邏輯\n依可見程式碼核對。",
  "## 已證實問題\n[HTML_ROOT_INCOMPLETE] 與 [NATIVE_CODE_LITERAL] 均有直接證據支持，判定為 Critical。",
  "## 推測問題\n無。",
  "## 待驗證\n需執行測試。",
  "## 安全性與錯誤處理\n未執行動態測試。",
  "## 效能與可維護性\n待量測。",
  "## 測試部署風險\n未部署。",
  "## 修正建議\n先修復 index.html 結構。",
  "## AI A / AI B 分歧與 AI C 裁決\nA/B 意見依直接證據裁決。",
];
{
  const reportBenignNote=[...reportSectionsBase,"## 最終結論\n存在 Critical 缺陷，前端無法正常運作，不符合部署標準。"]
    .join("\n\n")+"\n\n"+"具體證據內容。".repeat(80);
  const env=envWith(async()=>({response:reportBenignNote}));
  const accepted=await synthesizeAuditEvidence({env,question:"審核",rawFiles:[{path:"evidence.md",content:"evidence"}],coverage:{pct:100,count:1,total:1},requiredFindings:integrity});
  assert.equal(accepted.complete,true,"非結論章節如實描述『無重大問題』不應阻擋 AI C 通過");
}
{
  const reportUnsafeConclusion=[...reportSectionsBase,"## 最終結論\n整體程式碼品質良好，沒有重大問題。"]
    .join("\n\n")+"\n\n"+"具體證據內容。".repeat(80);
  const env=envWith(async()=>({response:reportUnsafeConclusion}));
  const rejected=await synthesizeAuditEvidence({env,question:"審核",rawFiles:[{path:"evidence.md",content:"evidence"}],coverage:{pct:100,count:1,total:1},requiredFindings:integrity});
  assert.equal(rejected.complete,false,"結論本身淡化 critical finding 時仍應被擋下");
}

// v4.9.2 regression：不得假設「最終結論」標題固定編號為 12。實際 prompt 要求
// 的 13 個章節中「最終結論」是第 13 項，AI C 也可能完全不編號；標題比對
// 不到任何一種寫法時，split() 會退化成整份報告掃描（等於沒修）。
{
  const reportNumberedThirteen=[...reportSectionsBase,"## 13. 最終結論\n存在 Critical 缺陷，前端無法正常運作，不符合部署標準。"]
    .join("\n\n")+"\n\n"+"具體證據內容。".repeat(80);
  const env=envWith(async()=>({response:reportNumberedThirteen}));
  const accepted=await synthesizeAuditEvidence({env,question:"審核",rawFiles:[{path:"evidence.md",content:"evidence"}],coverage:{pct:100,count:1,total:1},requiredFindings:integrity});
  assert.equal(accepted.complete,true,"標題編號為 13（而非假設的 12）時，非結論章節的『無重大問題』仍不應阻擋通過");
}
{
  const reportNumberedThirteenUnsafe=[...reportSectionsBase,"## 13. 最終結論\n整體程式碼品質良好，沒有重大問題。"]
    .join("\n\n")+"\n\n"+"具體證據內容。".repeat(80);
  const env=envWith(async()=>({response:reportNumberedThirteenUnsafe}));
  const rejected=await synthesizeAuditEvidence({env,question:"審核",rawFiles:[{path:"evidence.md",content:"evidence"}],coverage:{pct:100,count:1,total:1},requiredFindings:integrity});
  assert.equal(rejected.complete,false,"標題編號為 13 時，結論本身淡化 critical finding 仍應被擋下");
}

console.log("audit-pipeline tests: ok");
